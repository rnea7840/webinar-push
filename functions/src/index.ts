// ── functions/src/index.ts ────────────────────────────────────
// Single-event webinar push bot.
//
// HTTP endpoints (callable via curl with X-Admin-Key header):
//   POST /seed              Initialize settings/config with defaults for the SBOM event
//   POST /testKeys          Validate ConnectSafely + Anthropic keys
//   POST /source            Run prospect sourcing (search + company followers)
//   POST /personalize       Generate copy + score + route channel for sourced prospects
//   POST /queue             Promote drafts to queued (auto-send pool)
//   POST /sendNow           Drain the queue (one batch)
//   POST /pause             Set settings.paused = true
//   POST /resume            Set settings.paused = false (and clears linkedinPaused)
//   GET  /track/:token      Redirect to registration URL + flag prospect as registered
//   GET  /stats             Snapshot counts by status / channel
//
// Scheduled (every 30 min during the push):
//   tick                    Personalize → queue → send → followups → poll replies

import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";

import { runSourcing } from "./services/prospects";
import { personalizeBatch, autoQueueDrafts } from "./services/personalize";
import { sendBatch } from "./services/sender";
import { runFollowups, pollRepliesFromInbox } from "./services/scheduler";
import { isPaused, getSettings, getTotalRemainingCapacity } from "./services/safety";
import { testConnectSafelyKey } from "./services/connectsafely";
import type { EventConfig, SettingsDoc } from "./types";

admin.initializeApp();

setGlobalOptions({
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 540,
  maxInstances: 5,
});

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ── Auth helper ─────────────────────────────────────────────────
// Simple admin key check for HTTP endpoints. Set ADMIN_KEY in
// settings/config or as a function env var.
async function requireAdmin(req: any, res: any): Promise<boolean> {
  const supplied = req.get("X-Admin-Key") || req.query.adminKey;
  const settings = await getSettings();
  const expected = (settings as any).adminKey || process.env.ADMIN_KEY;
  if (!expected) {
    res.status(500).json({ error: "ADMIN_KEY not configured. Set settings/config.adminKey first." });
    return false;
  }
  if (supplied !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function getEvent(): Promise<EventConfig | null> {
  const s = await getSettings();
  return s.event || null;
}

// ── /seed ───────────────────────────────────────────────────────
// Idempotent: only writes default fields if missing. Run once after
// `firebase deploy` to populate the event metadata + ICP defaults.
export const seed = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const ref = db().collection("settings").doc("config");
  const existing = (await ref.get()).data() || {};

  const defaults: Partial<SettingsDoc> = {
    event: {
      linkedinEventId: "7455003189491183616",
      linkedinEventUrl: "https://www.linkedin.com/events/7455003189491183616/",
      registrationUrl: "https://carahevents.carahsoft.com/Event/Details/746150-CS1?auth=4b26c6748dad45fca647aaa042775f25",
      title: "SBOM Analysis and Protocol Fuzzing Covering the Full Attack Surface",
      host: "Apona Security",
      channel: "Carahsoft",
      startsAt: "2026-05-12T14:00:00Z", // 10:00 AM ET = 14:00 UTC
      durationMinutes: 60,
      online: true,
      description:
        "Deep-dive on SBOM analysis and protocol fuzzing across the full attack surface. " +
        "Covers practical workflows for AppSec, DevSecOps, and product security teams.",
    },
    icp: {
      jobTitles: [
        "Application Security", "AppSec", "Product Security",
        "DevSecOps", "Security Engineer", "Security Architect",
        "CISO", "Head of Security", "Director of Security",
        "Vulnerability", "SBOM",
      ],
      industries: ["Computer Software", "Information Technology", "Defense", "Government Administration", "Financial Services"],
      followerOf: [
        // Company URN/slug — adjust after deploy. Common SBOM/AppSec adjacents:
        "synopsys", "snyk", "veracode", "anchore", "blackducksoftware", "apona-security",
      ],
      excludeCompanies: [
        // Hard exclusion — prospects who WORK at any of these are dropped
        // from sourcing AND from personalize. Case-insensitive substring
        // match against company name, headline, and current title.
        // Mirrors followerOf because we pull followers OF competitors but
        // never message competitors' employees. Apona is the event host
        // (their employees already know about it).
        "Apona Security",
        "Synopsys", "Snyk", "Veracode", "Anchore", "Black Duck", "Blackduck",
        "Sonatype", "Mend", "WhiteSource", "Checkmarx", "GitHub Advanced Security",
        "Endor Labs", "Chainguard", "Phylum", "Socket", "ActiveState",
      ],
      linkedinGroups: [
        // Paste full group URLs (preferred) or numeric IDs after deploy.
        // Example: "https://www.linkedin.com/groups/3961304" (Application Security Practitioners)
        // Add OWASP, DevSecOps, SBOM, federal-cyber groups here.
      ],
      targetPosts: [
        // Paste full LinkedIn post URLs of relevant content after deploy.
        // E.g. Apona / Carahsoft event-announcement posts, viral SBOM-related
        // posts from analysts, vendor announcements about CISA SBOM mandates.
      ],
      connectionDegree: ["1st", "2nd", "3rd+"],
      premiumOnly: false,
      minQualityScore: 7,
    },
    mode: "sandbox", // flip to "live" only after key validation + dry-run review
    autoSendQualityFloor: 7,
    linkedinDailyLimit: 25,
    linkedinInmailDailyLimitPerAccount: 5,
    linkedinConnectWeeklyLimit: 90,
    paused: false,
  };

  // Only fill missing keys; never clobber values you've already set.
  const merged: any = { ...defaults, ...existing };
  if (existing.event) merged.event = existing.event;
  if (existing.icp) merged.icp = existing.icp;

  await ref.set({ ...merged, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  res.json({ ok: true, mergedKeys: Object.keys(merged) });
});

// ── /testKeys ───────────────────────────────────────────────────
export const testKeys = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const settings = await getSettings();
  const cs = settings.connectSafelyApiKey
    ? await testConnectSafelyKey(settings.connectSafelyApiKey)
    : { valid: false, message: "ConnectSafely key not set" };
  const anthropicSet = !!(settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  res.json({
    connectSafely: cs,
    anthropic: { configured: anthropicSet },
    mode: settings.mode || "sandbox",
  });
});

// ── /source ─────────────────────────────────────────────────────
export const source = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const settings = await getSettings();
  if (!settings.icp) { res.status(400).json({ error: "ICP not configured. Run /seed first." }); return; }
  const result = await runSourcing({
    icp: settings.icp,
    perFeedCap: Number(req.body?.perFeedCap) || 200,
    pageSize: Number(req.body?.pageSize) || 50,
  });
  res.json(result);
});

// ── /personalize ────────────────────────────────────────────────
export const personalize = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const event = await getEvent();
  if (!event) { res.status(400).json({ error: "Event not configured. Run /seed first." }); return; }
  const result = await personalizeBatch({
    event,
    batchSize: Number(req.body?.batchSize) || 25,
    qualityFloorOverride: req.body?.qualityFloor,
  });
  res.json(result);
});

// ── /queue ──────────────────────────────────────────────────────
export const queue = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const result = await autoQueueDrafts();
  res.json(result);
});

// ── /sendNow ────────────────────────────────────────────────────
export const sendNow = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const event = await getEvent();
  if (!event) { res.status(400).json({ error: "Event not configured. Run /seed first." }); return; }
  const result = await sendBatch({
    event,
    batchSize: Number(req.body?.batchSize) || 30,
  });
  res.json(result);
});

// ── /pause + /resume ────────────────────────────────────────────
export const pause = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  await db().collection("settings").doc("config").set({
    paused: true, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  res.json({ ok: true, paused: true });
});

export const resume = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  await db().collection("settings").doc("config").set({
    paused: false,
    linkedinPaused: false,
    linkedinPauseReason: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  res.json({ ok: true, paused: false });
});

// ── /track/:token (no auth — public redirect) ───────────────────
export const track = onRequest(async (req, res) => {
  // URL pattern: /track?token=xxx  or  /track/xxx
  const token = (req.query.token as string) || req.path.replace(/^\/+track\/?/, "").split("/")[0];
  if (!token) { res.status(400).send("Missing token"); return; }

  const event = await getEvent();
  const dest = event?.registrationUrl || "https://www.linkedin.com/events/7455003189491183616/";

  const q = await db().collection("prospects").where("trackingToken", "==", token).limit(1).get();
  if (!q.empty) {
    await q.docs[0].ref.update({
      status: "registered", // generous — treat any click as intent-to-register
      registeredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db().collection("activity_log").add({
      type: "registration_click",
      message: `Tracking click → flagged ${q.docs[0].id} as registered`,
      metadata: { token, prospectId: q.docs[0].id },
      timestamp: FieldValue.serverTimestamp(),
    });
  }

  res.redirect(302, dest);
});

// ── /stats ──────────────────────────────────────────────────────
export const stats = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const statuses = [
    "sourced", "qualified", "drafted", "queued", "sent",
    "follow_up_1", "follow_up_2", "follow_up_3",
    "replied", "registered", "rejected", "errored",
  ];
  const counts: Record<string, number> = {};
  await Promise.all(statuses.map(async (s) => {
    const c = await db().collection("prospects").where("status", "==", s).count().get();
    counts[s] = c.data().count || 0;
  }));

  const cap = await getTotalRemainingCapacity();
  const settings = await getSettings();
  const paused = isPaused(settings);

  res.json({
    counts,
    capacityRemainingToday: cap,
    paused,
    mode: settings.mode || "sandbox",
    eventConfigured: !!settings.event,
  });
});

// ── Scheduled tick (every 30 min) ───────────────────────────────
// Conservative pacing: a single tick does one slice of each step.
// You can call /sendNow manually for bursty pushes.
export const tick = onSchedule({
  schedule: "every 30 minutes",
  timeoutSeconds: 540,
  memory: "512MiB",
}, async () => {
  const event = await getEvent();
  if (!event) {
    console.warn("[tick] No event configured. Skipping.");
    return;
  }

  const settings = await getSettings();
  const paused = isPaused(settings);
  if (paused.paused) {
    console.warn(`[tick] Paused — ${paused.reason}`);
    return;
  }

  // 1. Personalize a slice of sourced prospects.
  await personalizeBatch({ event, batchSize: 20 }).catch((e) => {
    console.error("[tick] personalize failed:", e.message);
  });

  // 2. Auto-queue drafts (no-op in sandbox).
  await autoQueueDrafts().catch((e) => {
    console.error("[tick] auto-queue failed:", e.message);
  });

  // 3. Send a slice from the queue, sized to remaining capacity.
  const cap = await getTotalRemainingCapacity();
  const sendSize = Math.min(30, Math.max(0, cap.total));
  if (sendSize > 0) {
    await sendBatch({ event, batchSize: sendSize }).catch((e) => {
      console.error("[tick] sendBatch failed:", e.message);
    });
  }

  // 4. Run any due follow-up step.
  await runFollowups({ event }).catch((e) => {
    console.error("[tick] followups failed:", e.message);
  });

  // 5. Poll inbox for replies.
  await pollRepliesFromInbox().catch((e) => {
    console.error("[tick] reply poll failed:", e.message);
  });
});
