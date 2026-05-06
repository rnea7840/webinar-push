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
// Idempotent for top-level settings (API keys, mode, accounts —
// never clobbered). Always rewrites `event` + `icp` with the latest
// Labrador-derived defaults so re-seeding picks up new ICP changes.
// If you've hand-edited event/ICP in the dashboard and want to keep
// them, edit again after seeding — or skip /seed entirely.
export const seed = onRequest(async (req, res) => {
  if (!(await requireAdmin(req, res))) return;

  const ref = db().collection("settings").doc("config");
  const existing = (await ref.get()).data() || {};

  const event = {
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
      "Deep-dive on SBOM analysis and protocol fuzzing across the full attack surface, " +
      "hosted by Apona Security (formerly Labrador Labs / We-Fuzz). Practical workflows " +
      "for AppSec, DevSecOps, and product security teams. Covers EU regulatory drivers " +
      "(DORA, NIS2, CRA), source-level OSS detection that manifest scanners miss, and " +
      "protocol fuzzing for full-attack-surface coverage.",
    speakers: [],
  };

  const icp = {
    jobTitles: [
      // Buyer titles (Labrador's existing ICP)
      "CISO", "Chief Information Security Officer",
      "CTO", "Chief Technology Officer",
      "VP Security", "VP Engineering", "VP Product Security",
      "Director Security", "Director IT Security", "Director DevSecOps", "Director AppSec",
      "Head of Security", "Head of IT Security", "Head of AppSec",
      "Head of Product Security", "Head of Compliance",
      "IT-Sicherheitsbeauftragter",            // German CISO equivalent
      // Technical attendees relevant to SBOM/fuzzing
      "Application Security", "AppSec", "AppSec Engineer", "AppSec Manager",
      "Product Security", "Product Security Engineer", "Product Security Lead",
      "DevSecOps", "DevSecOps Engineer", "DevSecOps Manager",
      "Security Architect", "Security Engineer",
      "Vulnerability Management", "Vulnerability Researcher",
      "SBOM", "Software Supply Chain",
      "Compliance Lead", "Compliance Manager",
      "Software Engineering Manager",
    ],
    industries: [
      // Software / IT
      "Computer Software", "Information Technology and Services", "Internet",
      // DORA — Financial services (EU, enforced)
      "Financial Services", "Banking", "Insurance", "Capital Markets", "Investment Banking",
      // NIS2 — Critical infrastructure / energy / health / transport (EU, active)
      "Energy", "Utilities", "Oil & Energy", "Renewables & Environment",
      "Telecommunications", "Wireless",
      "Transportation/Trucking/Railroad", "Automotive", "Aviation & Aerospace",
      "Hospital & Health Care", "Medical Devices", "Pharmaceuticals", "Biotechnology",
      // CRA — Anyone shipping product into EU (already covered by software)
      // ITAR — Defense
      "Defense & Space", "Government Administration", "Military",
      // FDA — Medical devices already in NIS2 row
    ],
    locations: [
      // EU 90% of Labrador's ICP — DORA / NIS2 / CRA enforced
      "Germany", "United Kingdom", "France", "Netherlands", "Sweden",
      "Denmark", "Finland", "Norway", "Belgium", "Switzerland",
      "Austria", "Ireland", "Spain", "Italy", "Poland",
      "Czech Republic", "Portugal", "Luxembourg",
      // US federal/defense — Carahsoft channel
      "United States",
    ],
    followerOf: [
      // Direct SCA/SBOM competitors — their followers ARE our ICP.
      // (We pull followers; the excludeCompanies list ensures we never
      // message anyone EMPLOYED by these competitors.)
      "snyk", "blackducksoftware", "synopsys", "sonatype",
      "veracode", "anchore", "mend-io", "checkmarx",
      "endorlabs", "chainguard", "phylum-inc", "socket-dev",
      "fossa", "jfrog", "aqua-security",
      // Adjacent / industry follower pools
      "owasp", "the-linux-foundation", "cisecurity",
    ],
    excludeCompanies: [
      // Parent + sister brands — Apona = Labrador Labs = We-Fuzz
      "Apona Security", "Apona.ai", "Apona", "Labrador Labs", "Labrador",
      "We-Fuzz", "WeFuzz", "We Fuzz",
      // Channel partner — don't pitch to Carahsoft staff
      "Carahsoft",
      // Direct SCA / SBOM / SAST competitors (per Labrador qualification rules)
      "Synopsys", "Snyk", "Veracode", "Anchore",
      "Black Duck", "Blackduck", "Black Duck Software",
      "Sonatype", "Mend", "Mend.io", "WhiteSource",
      "Checkmarx", "FOSSA", "GitHub Advanced Security",
      "Endor Labs", "Chainguard", "Phylum", "Socket", "Socket.dev",
      "ActiveState", "JFrog", "Aqua Security",
      // Reference customers — never disrupt existing relationships
      "Samsung", "POSCO", "LG Energy Solution",
      "Intuitive Surgical", "KDB", "Korea Development Bank",
      "Industrial Bank of Korea", "IBK",
    ],
    linkedinGroups: [
      // Paste full LinkedIn group URLs in the dashboard. Suggestions
      // (verify and paste in dashboard, IDs not hardcoded):
      //   Application Security Practitioners
      //   DevSecOps
      //   OWASP local chapters (US, EU)
      //   ISC2 Information Security Professionals
      //   CRA / NIS2 / DORA discussion groups
      //   SBOM / Supply Chain Security
      //   Federal Cybersecurity (for Carahsoft channel)
    ],
    targetPosts: [
      // Paste post URLs in the dashboard. Highest-converting:
      //   Apona / Labrador event-announcement post for THIS event
      //   Carahsoft event-promo posts
      //   Recent CISA SBOM mandate posts
      //   Viral CRA / NIS2 / DORA threads from analysts
      //   Competitor product announcements (Snyk/BlackDuck/Sonatype)
      //     where AppSec people pile into the comments
    ],
    connectionDegree: ["1st", "2nd", "3rd+"],
    premiumOnly: false,
    minQualityScore: 7,
  };

  // Top-level settings: merge defaults under existing values so we
  // never clobber API keys, mode, accounts, etc.
  const topLevel = {
    senderName: existing.senderName || "Roger",
    mode: existing.mode || "sandbox",
    anthropicModel: existing.anthropicModel || "claude-sonnet-4-6",
    autoSendQualityFloor: existing.autoSendQualityFloor ?? 7,
    linkedinDailyLimit: existing.linkedinDailyLimit ?? 25,
    linkedinInmailDailyLimitPerAccount: existing.linkedinInmailDailyLimitPerAccount ?? 5,
    linkedinConnectWeeklyLimit: existing.linkedinConnectWeeklyLimit ?? 90,
    paused: existing.paused ?? false,
  };

  await ref.set({
    ...topLevel,
    event,
    icp,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  res.json({
    ok: true,
    seeded: {
      event: event.title,
      icpJobTitles: icp.jobTitles.length,
      icpIndustries: icp.industries.length,
      icpLocations: icp.locations.length,
      icpFollowerOf: icp.followerOf.length,
      icpExcludeCompanies: icp.excludeCompanies.length,
    },
    note: "event + icp always overwritten by /seed. API keys, accounts, and mode preserved.",
  });
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
