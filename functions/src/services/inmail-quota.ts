// ── functions/src/services/inmail-quota.ts ───────────────────
// InMail daily-cap enforcement. 5/day per LinkedIn account by default.
// Atomic reserve-then-release pattern keeps concurrent orchestrator
// ticks from double-spending the quota.

import * as admin from "firebase-admin";
import { sendLinkedInMessage, sendLinkedInMessageWithTyping } from "./connectsafely";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const DEFAULT_INMAIL_DAILY_LIMIT_PER_ACCOUNT = 5;

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function usageDocId(accountId: string, day: string = utcDayKey()): string {
  return `${day}_${accountId}`;
}

async function getSettings(): Promise<any> {
  const snap = await db().collection("settings").doc("config").get();
  return snap.data() || {};
}

export async function getAccountIdForCampaign(): Promise<string | undefined> {
  const settings = await getSettings();
  const accounts: Array<{ id?: string; enabled?: boolean; connectSafelyAccountId?: string }> =
    settings.linkedinAccounts || [];
  const first = accounts.find((a) => a.enabled !== false);
  return first?.connectSafelyAccountId || first?.id;
}

export async function getDailyInmailUsage(accountId: string): Promise<number> {
  const doc = await db().collection("linkedin_quota_usage").doc(usageDocId(accountId)).get();
  return (doc.data()?.inmailCount as number) || 0;
}

async function reserveInmailSlot(accountId: string, limit: number): Promise<{
  ok: boolean; used: number; limit: number;
}> {
  const ref = db().collection("linkedin_quota_usage").doc(usageDocId(accountId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = (snap.data()?.inmailCount as number) || 0;
    if (used >= limit) return { ok: false, used, limit };
    if (snap.exists) {
      tx.update(ref, {
        inmailCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.set(ref, {
        accountId, day: utcDayKey(), inmailCount: 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { ok: true, used: used + 1, limit };
  });
}

async function releaseInmailSlot(accountId: string): Promise<void> {
  const ref = db().collection("linkedin_quota_usage").doc(usageDocId(accountId));
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = (snap.data()?.inmailCount as number) || 0;
      if (used <= 0) return;
      tx.update(ref, {
        inmailCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.warn(`Could not release InMail slot for ${accountId}: ${(e as Error).message}`);
  }
}

export interface SendInmailResult {
  success: boolean;
  message: string;
  cappedForToday?: boolean;
  usedToday?: number;
  limit?: number;
}

export async function sendInmail(params: {
  profileUrl: string;
  message: string;
  accountId?: string;
  reason?: string;
  typingDelay?: boolean;
}): Promise<SendInmailResult> {
  const settings = await getSettings();
  const limit: number =
    settings.linkedinInmailDailyLimitPerAccount || DEFAULT_INMAIL_DAILY_LIMIT_PER_ACCOUNT;

  const accountId = params.accountId || "default";
  const reserve = await reserveInmailSlot(accountId, limit);
  if (!reserve.ok) {
    await db().collection("activity_log").add({
      type: "linkedin_inmail_capped",
      message: `InMail cap hit for account ${accountId} (${reserve.used}/${reserve.limit})`,
      timestamp: FieldValue.serverTimestamp(),
      metadata: { accountId, reason: params.reason || "unspecified" },
    });
    return {
      success: false,
      message: `Daily InMail cap reached for account ${accountId} (${reserve.limit}/day).`,
      cappedForToday: true,
      usedToday: reserve.used,
      limit: reserve.limit,
    };
  }

  const send = params.typingDelay
    ? await sendLinkedInMessageWithTyping({
        profileUrl: params.profileUrl, message: params.message, accountId: params.accountId,
      })
    : await sendLinkedInMessage({
        profileUrl: params.profileUrl, message: params.message, accountId: params.accountId,
      });

  if (!send.success) {
    await releaseInmailSlot(accountId);
    return { success: false, message: send.message, usedToday: reserve.used - 1, limit: reserve.limit };
  }

  await db().collection("activity_log").add({
    type: "linkedin_inmail_sent",
    message: `InMail sent via ${accountId} (${reserve.used}/${reserve.limit} today)`,
    timestamp: FieldValue.serverTimestamp(),
    metadata: {
      accountId, reason: params.reason || "unspecified",
      profileUrl: params.profileUrl, usedToday: reserve.used, limit: reserve.limit,
    },
  });

  return { success: true, message: send.message, usedToday: reserve.used, limit: reserve.limit };
}
