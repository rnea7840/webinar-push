// ── functions/src/services/safety.ts ──────────────────────────
// Anti-detection helpers: warm-up ramp, weekend reduction, jitter,
// account rotation. Single-event push doesn't need full anti-detection
// theater, but the multi-account distribution + per-account capacity
// budget is important when we have lots of seats.

import * as admin from "firebase-admin";
import type { LinkedInAccount, SettingsDoc } from "../types";

const db = () => admin.firestore();

const HARD_DAILY_CAP_DM = 25;            // safety ceiling per account
const HARD_DAILY_CAP_CONNECT = 18;       // ~90/wk → ~13/day with cushion
const HARD_DAILY_CAP_INMAIL = 5;         // matches inmail-quota default

export interface AccountCapacity {
  accountId: string;
  label: string;
  dmRemaining: number;
  connectRemaining: number;
  inmailRemaining: number;
}

export async function getSettings(): Promise<SettingsDoc> {
  const snap = await db().collection("settings").doc("config").get();
  return (snap.data() as SettingsDoc) || {};
}

export function isPaused(settings: SettingsDoc): {
  paused: boolean; reason?: string;
} {
  if (settings.paused) return { paused: true, reason: "Manually paused" };
  if (settings.linkedinPaused) {
    return { paused: true, reason: settings.linkedinPauseReason || "LinkedIn auto-paused" };
  }
  return { paused: false };
}

export function isWeekend(d: Date = new Date()): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export function getWarmupPercent(settings: SettingsDoc, now: Date = new Date()): number {
  if (!settings.linkedinWarmupStartDate) return 100;
  const start: Date =
    typeof settings.linkedinWarmupStartDate?.toDate === "function"
      ? settings.linkedinWarmupStartDate.toDate()
      : new Date(settings.linkedinWarmupStartDate);
  const days = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (days <= 7) return 40;
  if (days <= 14) return 60;
  if (days <= 21) return 80;
  return 100;
}

function effectiveCap(baseCap: number, settings: SettingsDoc, now: Date = new Date()): number {
  let cap = baseCap;
  const pct = getWarmupPercent(settings, now);
  cap = Math.round(cap * (pct / 100));
  if (isWeekend(now)) cap = Math.round(cap * 0.5);
  return Math.max(1, Math.min(cap, baseCap));
}

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function countSendsToday(accountId: string, channel: string): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const snap = await db().collection("sends")
    .where("linkedinAccountId", "==", accountId)
    .where("channel", "==", channel)
    .where("sentAt", ">=", start)
    .count().get();
  return snap.data().count || 0;
}

async function getInmailUsedToday(accountId: string): Promise<number> {
  const id = `${utcDayKey()}_${accountId}`;
  const doc = await db().collection("linkedin_quota_usage").doc(id).get();
  return (doc.data()?.inmailCount as number) || 0;
}

export async function getAccountCapacities(): Promise<AccountCapacity[]> {
  const settings = await getSettings();
  const accounts: LinkedInAccount[] = (settings.linkedinAccounts || []).filter((a) => a.enabled !== false);
  if (accounts.length === 0) return [];

  const baseDm = settings.linkedinDailyLimit || HARD_DAILY_CAP_DM;
  const dmCap = effectiveCap(baseDm, settings);
  const connectCap = effectiveCap(HARD_DAILY_CAP_CONNECT, settings);
  const inmailCap = settings.linkedinInmailDailyLimitPerAccount || HARD_DAILY_CAP_INMAIL;

  const out: AccountCapacity[] = [];
  for (const a of accounts) {
    const id = a.connectSafelyAccountId || a.id;
    if (!id) continue;
    const [dmUsed, connectUsed, inmailUsed] = await Promise.all([
      countSendsToday(id, "linkedin_dm"),
      countSendsToday(id, "linkedin_connect"),
      getInmailUsedToday(id),
    ]);
    out.push({
      accountId: id,
      label: a.label || id,
      dmRemaining: Math.max(0, dmCap - dmUsed),
      connectRemaining: Math.max(0, connectCap - connectUsed),
      inmailRemaining: Math.max(0, inmailCap - inmailUsed),
    });
  }
  return out;
}

export type ChannelKind = "dm" | "connect" | "inmail";

/**
 * Pick the account with the most remaining capacity for a given channel.
 * Returns undefined if all accounts are exhausted for that channel today.
 */
export async function pickAccountForChannel(channel: ChannelKind): Promise<AccountCapacity | undefined> {
  const caps = await getAccountCapacities();
  const key: keyof AccountCapacity =
    channel === "dm" ? "dmRemaining"
    : channel === "connect" ? "connectRemaining"
    : "inmailRemaining";
  const eligible = caps.filter((c) => (c[key] as number) > 0);
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => (b[key] as number) - (a[key] as number));
  return eligible[0];
}

/**
 * Total remaining capacity across all accounts, by channel. Useful for the
 * sourcing step to know how many prospects to draft today.
 */
export async function getTotalRemainingCapacity(): Promise<{
  dm: number; connect: number; inmail: number; total: number;
}> {
  const caps = await getAccountCapacities();
  const dm = caps.reduce((s, c) => s + c.dmRemaining, 0);
  const connect = caps.reduce((s, c) => s + c.connectRemaining, 0);
  const inmail = caps.reduce((s, c) => s + c.inmailRemaining, 0);
  return { dm, connect, inmail, total: dm + connect + inmail };
}

/** Random jitter helper for spacing sends within a tick. */
export function jitterMs(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}
