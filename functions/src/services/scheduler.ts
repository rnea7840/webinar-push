// ── functions/src/services/scheduler.ts ───────────────────────
// Follow-up scheduler. For an event happening in N days, fires three
// nudges relative to the event start time:
//
//   T-3 days   ("a few days out") — only to non-responders, status="sent"
//   T-1 day    ("tomorrow")        — only to non-responders, status in [sent, follow_up_1]
//   T-0 morning (3 hours before)   — final nudge, status in [sent, follow_up_1, follow_up_2]
//
// Each follow-up tries to use the SAME channel + account that did the
// initial touch (continuity). If that channel is exhausted today, the
// follow-up is skipped (will retry next tick — cron runs hourly).
//
// Reply detection: if a prospect's status was flipped to "replied" or
// "registered" by the inbox poller / tracker, we never nudge them.

import * as admin from "firebase-admin";
import {
  sendLinkedInMessage, sendLinkedInMessageWithTyping, getRecentMessages,
} from "./connectsafely";
import { sendInmail } from "./inmail-quota";
import { sendWebinarEmail } from "./gmail";
import { isPaused, getSettings, jitterMs } from "./safety";
import { generateOutreach } from "./anthropic";
import type { EventConfig, ProspectDoc, Channel, ProspectStatus } from "../types";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function log(type: string, message: string, metadata?: Record<string, unknown>) {
  await db().collection("activity_log").add({
    type, message, metadata: metadata || {}, timestamp: FieldValue.serverTimestamp(),
  });
}

type FollowupStep = "followup_t3" | "followup_t1" | "followup_t0";

function whichStepDue(now: Date, eventStart: Date): FollowupStep | null {
  const msUntil = eventStart.getTime() - now.getTime();
  const hoursUntil = msUntil / (1000 * 60 * 60);
  if (hoursUntil <= 0) return null;            // event has started
  if (hoursUntil <= 4) return "followup_t0";   // ~3-4 hr before
  if (hoursUntil <= 30) return "followup_t1";  // day-of / day-before
  if (hoursUntil <= 78) return "followup_t3";  // ~3 days out
  return null;
}

function eligibleStatuses(step: FollowupStep): ProspectStatus[] {
  switch (step) {
    case "followup_t3": return ["sent"];
    case "followup_t1": return ["sent", "follow_up_1"];
    case "followup_t0": return ["sent", "follow_up_1", "follow_up_2"];
  }
}

function nextStatus(step: FollowupStep): ProspectStatus {
  return step === "followup_t3" ? "follow_up_1"
       : step === "followup_t1" ? "follow_up_2"
       : "follow_up_3";
}

interface FollowupCopy { dm: string; inmail: string; emailSubject: string; emailBody: string; }

/**
 * Lightweight follow-up copy generator. We don't re-call Anthropic per
 * prospect for every nudge — too expensive. Instead we generate one
 * copy variant per step at the start of the run and template-fill the
 * prospect's first name. Prospects without first name fall back to a
 * neutral opener.
 */
async function buildFollowupCopy(step: FollowupStep, event: EventConfig): Promise<FollowupCopy> {
  // Reuse generateOutreach with a synthetic "follow-up persona" prospect
  // so the same prompt can be re-used. We then strip the personalization
  // hooks to leave a near-template that can be name-filled.
  const synthetic: ProspectDoc = {
    id: "__followup_template__",
    profileUrl: "https://example.com",
    source: "search",
    status: "drafted",
    fullName: "{{firstName}}",
    firstName: "{{firstName}}",
    headline: step === "followup_t3" ? "follow-up t-3 template — emphasize event is in 3 days, restate value, light social proof"
            : step === "followup_t1" ? "follow-up t-1 template — emphasize event is tomorrow, registration link is one click"
            : "follow-up t-0 template — emphasize starts in a few hours, add direct join link",
    company: "(template)",
  };
  const c = await generateOutreach(synthetic, event);
  return {
    dm: c.dmBody,
    inmail: c.inmailBody,
    emailSubject: c.emailSubject,
    emailBody: c.emailBody,
  };
}

function fillTemplate(s: string, p: ProspectDoc): string {
  const first = p.firstName || (p.fullName ? p.fullName.split(" ")[0] : "") || "there";
  return s.replace(/\{\{firstName\}\}/g, first);
}

async function sendFollowupOne(
  prospect: ProspectDoc & { id: string },
  step: FollowupStep,
  event: EventConfig,
  copy: FollowupCopy,
  sandbox: boolean,
): Promise<{ success: boolean; error?: string; channel?: Channel }> {
  const channel = prospect.channel;
  if (!channel) return { success: false, error: "No channel set" };
  const accountId = prospect.linkedinAccountId;

  if (sandbox) {
    return { success: true, channel };
  }

  switch (channel) {
    case "linkedin_dm": {
      await new Promise((r) => setTimeout(r, jitterMs(2000, 6000)));
      const r = await sendLinkedInMessageWithTyping({
        profileUrl: prospect.profileUrl,
        message: fillTemplate(copy.dm, prospect),
        accountId,
        typingDelayMs: jitterMs(15000, 40000),
      });
      return { success: r.success, error: r.success ? undefined : r.message, channel };
    }
    case "linkedin_connect": {
      // If they accepted the connection between initial and follow-up,
      // they're 1st-degree now and we can DM. If not, /messaging/send
      // will fail; we accept that and skip.
      const r = await sendLinkedInMessage({
        profileUrl: prospect.profileUrl,
        message: fillTemplate(copy.dm, prospect),
        accountId,
      });
      return { success: r.success, error: r.success ? undefined : r.message, channel };
    }
    case "linkedin_inmail": {
      const r = await sendInmail({
        profileUrl: prospect.profileUrl,
        message: fillTemplate(copy.inmail, prospect),
        accountId,
        reason: `webinar_${step}`,
        typingDelay: true,
      });
      if (!r.success && r.cappedForToday) {
        return { success: false, error: "InMail capped", channel };
      }
      return { success: r.success, error: r.success ? undefined : r.message, channel };
    }
    case "email": {
      if (!prospect.email) return { success: false, error: "No email", channel };
      const r = await sendWebinarEmail({
        to: prospect.email,
        toName: prospect.fullName,
        subject: copy.emailSubject,
        body: fillTemplate(copy.emailBody, prospect),
        event,
        prospectId: prospect.id,
        trackingToken: prospect.trackingToken,
      });
      return { success: r.success, error: r.error, channel };
    }
  }
}

export interface FollowupRunResult {
  step: FollowupStep | "none";
  attempted: number;
  succeeded: number;
  failed: number;
  capped: number;
}

export async function runFollowups(params: { event: EventConfig }): Promise<FollowupRunResult> {
  const settings = await getSettings();
  const paused = isPaused(settings);
  if (paused.paused) {
    await log("followup_skipped_paused", `Followups skipped — ${paused.reason}`);
    return { step: "none", attempted: 0, succeeded: 0, failed: 0, capped: 0 };
  }

  const now = new Date();
  const eventStart = new Date(params.event.startsAt);
  const step = whichStepDue(now, eventStart);
  if (!step) return { step: "none", attempted: 0, succeeded: 0, failed: 0, capped: 0 };

  const sandbox = settings.mode === "sandbox";
  const copy = await buildFollowupCopy(step, params.event);
  const allowedStatuses = eligibleStatuses(step);

  // Pull eligible prospects (limit per tick to avoid runaway).
  const snap = await db().collection("prospects")
    .where("status", "in", allowedStatuses)
    .limit(50)
    .get();

  const out: FollowupRunResult = { step, attempted: 0, succeeded: 0, failed: 0, capped: 0 };

  for (const doc of snap.docs) {
    const prospect = { id: doc.id, ...(doc.data() as Omit<ProspectDoc, "id">) };
    out.attempted++;

    const r = await sendFollowupOne(prospect, step, params.event, copy, sandbox);
    if (r.success) {
      await db().collection("sends").add({
        prospectId: doc.id,
        channel: prospect.channel,
        linkedinAccountId: prospect.linkedinAccountId,
        body: prospect.channel === "linkedin_inmail"
          ? fillTemplate(copy.inmail, prospect)
          : prospect.channel === "email"
            ? fillTemplate(copy.emailBody, prospect)
            : fillTemplate(copy.dm, prospect),
        subject: prospect.channel === "email" ? copy.emailSubject : undefined,
        step,
        success: true,
        sentAt: FieldValue.serverTimestamp(),
      });
      await doc.ref.update({
        status: nextStatus(step),
        lastFollowUpAt: FieldValue.serverTimestamp(),
        followUpCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      out.succeeded++;
    } else if (r.error?.includes("capped")) {
      out.capped++;
    } else {
      out.failed++;
      await log("followup_error",
        `Followup ${step} failed for ${prospect.profileUrl}: ${r.error}`,
        { prospectId: doc.id, error: r.error });
    }

    await new Promise((r) => setTimeout(r, jitterMs(500, 2500)));
  }

  await log("followup_run_complete",
    `Followup ${step}: ${out.succeeded}/${out.attempted} (${out.failed} failed, ${out.capped} capped)`,
    { result: out });

  return out;
}

/**
 * Poll LinkedIn inbox for replies to outbound prospects. Marks them
 * as "replied" so follow-ups skip them.
 */
export async function pollRepliesFromInbox(): Promise<{ checked: number; flagged: number }> {
  const settings = await getSettings();
  const accounts = (settings.linkedinAccounts || []).filter((a) => a.enabled !== false);
  let checked = 0;
  let flagged = 0;

  for (const a of accounts) {
    const accountId = a.connectSafelyAccountId || a.id;
    if (!accountId) continue;

    const r = await getRecentMessages({ limit: 50, accountId });
    if (!r.success || !r.data) continue;

    for (const msg of r.data as any[]) {
      checked++;
      const fromUrl: string | undefined = msg.fromProfileUrl || msg.profileUrl || msg.from?.profileUrl;
      if (!fromUrl) continue;

      const q = await db().collection("prospects")
        .where("profileUrl", "==", fromUrl)
        .limit(1).get();
      if (q.empty) continue;

      const doc = q.docs[0];
      const data = doc.data() as ProspectDoc;
      if (data.status === "replied" || data.status === "registered") continue;

      await doc.ref.update({
        status: "replied",
        repliedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      flagged++;
    }
  }

  if (flagged > 0) {
    await log("replies_polled", `Flagged ${flagged} replied prospects (${checked} messages checked)`);
  }
  return { checked, flagged };
}
