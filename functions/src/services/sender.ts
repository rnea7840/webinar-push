// ── functions/src/services/sender.ts ──────────────────────────
// Channel router. Pulls "queued" prospects, sends via the right
// channel using an account that has capacity, records to `sends`,
// updates prospect status.
//
// Designed for "lots of accounts + Sales Nav + InMail in scope":
// every queued prospect gets distributed across whichever account
// has remaining quota for that prospect's channel.

import * as admin from "firebase-admin";
import {
  sendConnectionRequest, sendLinkedInMessage, sendLinkedInMessageWithTyping,
  visitLinkedInProfile,
} from "./connectsafely";
import { sendInmail } from "./inmail-quota";
import { sendWebinarEmail } from "./gmail";
import { pickAccountForChannel, isPaused, getSettings, jitterMs } from "./safety";
import type { ProspectDoc, SendDoc, SettingsDoc, EventConfig, Channel } from "../types";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function log(type: string, message: string, metadata?: Record<string, unknown>) {
  await db().collection("activity_log").add({
    type, message, metadata: metadata || {}, timestamp: FieldValue.serverTimestamp(),
  });
}

async function recordSend(send: Omit<SendDoc, "id" | "sentAt"> & { sentAt?: any }): Promise<void> {
  await db().collection("sends").add({
    ...send,
    sentAt: send.sentAt || FieldValue.serverTimestamp(),
  });
}

async function sendOne(
  prospect: ProspectDoc & { id: string },
  event: EventConfig,
  settings: SettingsDoc,
): Promise<{ success: boolean; error?: string; channelUsed?: Channel; accountUsed?: string }> {
  const channel = prospect.channel;
  if (!channel) return { success: false, error: "No channel set on prospect" };

  // Re-pick account at send-time so we route around accounts that
  // hit their cap between draft and send.
  const channelKind =
    channel === "linkedin_dm" ? "dm"
    : channel === "linkedin_connect" ? "connect"
    : channel === "linkedin_inmail" ? "inmail"
    : null;

  let accountId: string | undefined = prospect.linkedinAccountId;
  if (channelKind) {
    const fresh = await pickAccountForChannel(channelKind);
    if (!fresh) {
      return { success: false, error: `No account capacity for channel ${channel}` };
    }
    accountId = fresh.accountId;
  }

  // Sandbox short-circuit: don't actually send, just record.
  if (settings.mode === "sandbox") {
    await recordSend({
      prospectId: prospect.id,
      channel,
      linkedinAccountId: accountId,
      body: bodyFor(prospect, channel),
      subject: channel === "email" ? prospect.emailSubject : undefined,
      step: "initial",
      success: true,
      responseMeta: { sandbox: true },
    });
    return { success: true, channelUsed: channel, accountUsed: accountId };
  }

  const body = bodyFor(prospect, channel);
  if (!body) return { success: false, error: `No body for channel ${channel}` };

  let result: { success: boolean; message?: string; error?: string };

  switch (channel) {
    case "linkedin_dm": {
      // Light warm-up: brief profile view first (rate-limit friendly,
      // no quota cost).
      try { await visitLinkedInProfile({ profileUrl: prospect.profileUrl, accountId }); } catch {}
      // Add jitter (no fixed cadence) before send.
      await new Promise((r) => setTimeout(r, jitterMs(2000, 8000)));
      const r = await sendLinkedInMessageWithTyping({
        profileUrl: prospect.profileUrl, message: body, accountId, typingDelayMs: jitterMs(15000, 45000),
      });
      result = { success: r.success, message: r.message };
      break;
    }
    case "linkedin_connect": {
      try { await visitLinkedInProfile({ profileUrl: prospect.profileUrl, accountId }); } catch {}
      await new Promise((r) => setTimeout(r, jitterMs(2000, 8000)));
      const note = (prospect.connectNote || body).slice(0, 280);
      const r = await sendConnectionRequest({
        profileUrl: prospect.profileUrl, message: note, accountId,
      });
      result = { success: r.success, message: r.message };
      break;
    }
    case "linkedin_inmail": {
      const r = await sendInmail({
        profileUrl: prospect.profileUrl, message: body, accountId,
        reason: "webinar_push", typingDelay: true,
      });
      if (!r.success && r.cappedForToday) {
        // Don't mark errored — leave queued for tomorrow.
        return { success: false, error: "InMail capped for today" };
      }
      result = { success: r.success, message: r.message };
      break;
    }
    case "email": {
      if (!prospect.email) {
        return { success: false, error: "Prospect has no email" };
      }
      const r = await sendWebinarEmail({
        to: prospect.email,
        toName: prospect.fullName,
        subject: prospect.emailSubject || `${event.title}`,
        body,
        event,
        prospectId: prospect.id,
        trackingToken: prospect.trackingToken,
      });
      result = { success: r.success, error: r.error };
      break;
    }
    default:
      return { success: false, error: `Unknown channel: ${channel}` };
  }

  await recordSend({
    prospectId: prospect.id,
    channel,
    linkedinAccountId: accountId,
    body,
    subject: channel === "email" ? prospect.emailSubject : undefined,
    step: "initial",
    success: result.success,
    error: result.success ? undefined : (result.error || result.message),
  });

  return {
    success: result.success,
    error: result.success ? undefined : (result.error || result.message),
    channelUsed: channel,
    accountUsed: accountId,
  };
}

function bodyFor(p: ProspectDoc, channel: Channel): string {
  switch (channel) {
    case "linkedin_dm":      return p.dmBody || "";
    case "linkedin_inmail":  return p.dmBody || "";  // generated as inmailBody, stored as dmBody for inmail channel
    case "linkedin_connect": return p.connectNote || "";
    case "email":            return p.emailBody || "";
  }
}

export interface SendBatchResult {
  attempted: number;
  succeeded: number;
  failed: number;
  capped: number;
  byChannel: Record<Channel, { sent: number; failed: number }>;
}

/**
 * Drain N queued prospects, distributing across accounts.
 * Caller (cron) decides batchSize based on total remaining capacity.
 */
export async function sendBatch(params: {
  event: EventConfig;
  batchSize?: number;
}): Promise<SendBatchResult> {
  const out: SendBatchResult = {
    attempted: 0, succeeded: 0, failed: 0, capped: 0,
    byChannel: {
      linkedin_dm: { sent: 0, failed: 0 },
      linkedin_connect: { sent: 0, failed: 0 },
      linkedin_inmail: { sent: 0, failed: 0 },
      email: { sent: 0, failed: 0 },
    },
  };

  const settings = await getSettings();
  const paused = isPaused(settings);
  if (paused.paused) {
    await log("send_skipped_paused", `Send skipped — ${paused.reason}`);
    return out;
  }

  const batchSize = params.batchSize ?? 30;
  const queued = await db().collection("prospects")
    .where("status", "==", "queued")
    .orderBy("qualityScore", "desc")
    .limit(batchSize)
    .get();

  if (queued.empty) return out;

  for (const doc of queued.docs) {
    const prospect = { id: doc.id, ...(doc.data() as Omit<ProspectDoc, "id">) };
    out.attempted++;

    const r = await sendOne(prospect, params.event, settings);
    const ch = (r.channelUsed || prospect.channel) as Channel;

    if (r.success) {
      await doc.ref.update({
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        linkedinAccountId: r.accountUsed,
        updatedAt: FieldValue.serverTimestamp(),
      });
      out.succeeded++;
      if (ch) out.byChannel[ch].sent++;
    } else if (r.error?.includes("capped")) {
      // Leave queued for next tick.
      out.capped++;
    } else {
      await doc.ref.update({
        status: "errored",
        qualityReasoning: r.error,
        updatedAt: FieldValue.serverTimestamp(),
      });
      out.failed++;
      if (ch) out.byChannel[ch].failed++;
    }

    // Per-send jitter so a tick doesn't fire 30 calls in 30ms.
    await new Promise((r) => setTimeout(r, jitterMs(500, 2500)));
  }

  await log("send_batch_complete",
    `Sent ${out.succeeded}/${out.attempted} (${out.failed} failed, ${out.capped} capped)`,
    { result: out });

  return out;
}
