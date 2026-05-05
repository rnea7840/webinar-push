// ── functions/src/services/personalize.ts ─────────────────────
// For every "sourced" prospect: check relationship, generate copy,
// score, route to channel, persist drafts.
//
// Channel routing rules (designed for "we have lots of accounts +
// Sales Navigator" — InMail is first-class, not a fallback):
//
//   1st-degree                     → linkedin_dm
//   2nd-degree                     → linkedin_connect (note has CTA)
//   3rd+ AND prospect.isPremium    → linkedin_inmail   (Sales Nav InMail)
//   3rd+ AND has email             → email
//   3rd+ no premium / no email     → linkedin_connect (lower-priority)
//
// Quality floor: prospects below settings.autoSendQualityFloor (default 7)
// land in status="rejected" with the reason logged. They can still be
// manually promoted later from the Firestore console.

import * as admin from "firebase-admin";
import { generateOutreach } from "./anthropic";
import { checkRelationship } from "./connectsafely";
import { pickAccountForChannel } from "./safety";
import type { Channel, EventConfig, ProspectDoc, SettingsDoc } from "../types";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function log(type: string, message: string, metadata?: Record<string, unknown>) {
  await db().collection("activity_log").add({
    type, message, metadata: metadata || {}, timestamp: FieldValue.serverTimestamp(),
  });
}

function makeTrackingToken(prospectId: string): string {
  // 10-char base36 slug derived from id + random. Used by /track/:token redirect.
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prospectId.slice(0, 4)}${rand}`;
}

function decideChannel(p: ProspectDoc, hasEmail: boolean): Channel {
  if (p.connectionDegree === "1st") return "linkedin_dm";
  if (p.connectionDegree === "2nd") return "linkedin_connect";
  // 3rd+ or unknown
  if (p.isPremium) return "linkedin_inmail";
  if (hasEmail) return "email";
  return "linkedin_connect";
}

export interface PersonalizeResult {
  processed: number;
  drafted: number;
  rejected: number;
  errors: number;
  byChannel: Record<Channel, number>;
}

export async function personalizeBatch(params: {
  event: EventConfig;
  batchSize?: number;        // how many sourced prospects to process this tick (default 25)
  qualityFloorOverride?: number;
}): Promise<PersonalizeResult> {
  const out: PersonalizeResult = {
    processed: 0, drafted: 0, rejected: 0, errors: 0,
    byChannel: { linkedin_dm: 0, linkedin_connect: 0, linkedin_inmail: 0, email: 0 },
  };

  const settingsSnap = await db().collection("settings").doc("config").get();
  const settings = (settingsSnap.data() as SettingsDoc) || {};
  const floor = params.qualityFloorOverride ?? settings.autoSendQualityFloor ?? 7;
  const batchSize = params.batchSize ?? 25;

  const sourced = await db().collection("prospects")
    .where("status", "==", "sourced")
    .limit(batchSize)
    .get();

  if (sourced.empty) return out;

  for (const doc of sourced.docs) {
    const prospect = { id: doc.id, ...(doc.data() as Omit<ProspectDoc, "id">) };
    out.processed++;
    try {
      // 1. Refresh connection degree if missing.
      let degree = prospect.connectionDegree;
      if (!degree) {
        const rel = await checkRelationship({ profileUrl: prospect.profileUrl });
        degree = rel.degree && rel.degree !== "unknown" ? rel.degree : prospect.connectionDegree;
      }

      // 2. Generate copy.
      const generated = await generateOutreach({ ...prospect, connectionDegree: degree }, params.event);

      // 3. Quality gate.
      if (generated.qualityScore < floor) {
        await doc.ref.update({
          status: "rejected",
          qualityScore: generated.qualityScore,
          qualityReasoning: generated.qualityReasoning,
          updatedAt: FieldValue.serverTimestamp(),
        });
        out.rejected++;
        continue;
      }

      // 4. Decide channel.
      const channel = decideChannel({ ...prospect, connectionDegree: degree }, !!prospect.email);

      // 5. Pick a sender account that has capacity for this channel.
      //    (We snapshot the choice into the draft; sender can re-pick at send-time
      //     if capacity has shifted by then.)
      const channelKind =
        channel === "linkedin_dm" ? "dm"
        : channel === "linkedin_connect" ? "connect"
        : channel === "linkedin_inmail" ? "inmail"
        : null;
      const sender = channelKind ? await pickAccountForChannel(channelKind) : undefined;

      const trackingToken = makeTrackingToken(doc.id);

      await doc.ref.update({
        status: "drafted",
        connectionDegree: degree || prospect.connectionDegree,
        qualityScore: generated.qualityScore,
        qualityReasoning: generated.qualityReasoning,
        connectNote: generated.connectNote,
        dmBody: channel === "linkedin_dm" ? generated.dmBody
              : channel === "linkedin_inmail" ? generated.inmailBody
              : generated.dmBody,
        emailSubject: generated.emailSubject,
        emailBody: generated.emailBody,
        channel,
        linkedinAccountId: sender?.accountId,
        trackingToken,
        updatedAt: FieldValue.serverTimestamp(),
      });

      out.drafted++;
      out.byChannel[channel]++;
    } catch (e) {
      const err = (e as Error).message;
      await doc.ref.update({
        status: "errored",
        qualityReasoning: `Personalize failed: ${err}`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      out.errors++;
      await log("personalize_error", `Personalize failed for ${prospect.profileUrl}: ${err}`,
        { prospectId: doc.id, error: err });
    }
  }

  await log("personalize_batch_complete",
    `Personalized ${out.processed}: ${out.drafted} drafted, ${out.rejected} below quality floor, ${out.errors} errors`,
    { result: out });

  return out;
}

/**
 * Auto-promote drafted prospects to "queued" so the sender picks them up.
 * If autoSend is disabled in settings, we leave them as "drafted" for
 * manual review.
 */
export async function autoQueueDrafts(): Promise<{ queued: number }> {
  const snap = await db().collection("settings").doc("config").get();
  const settings = (snap.data() as SettingsDoc) || {};
  if (settings.mode === "sandbox") return { queued: 0 };

  const drafts = await db().collection("prospects")
    .where("status", "==", "drafted")
    .limit(200)
    .get();
  let queued = 0;
  for (const d of drafts.docs) {
    await d.ref.update({ status: "queued", updatedAt: FieldValue.serverTimestamp() });
    queued++;
  }
  return { queued };
}
