// ── functions/src/services/anthropic.ts ───────────────────────
// Anthropic-powered personalization. One job: generate webinar
// outreach copy (connect note ≤300 chars, DM body, InMail body,
// and optional email subject/body) tuned to each prospect.
//
// Uses direct fetch to the Anthropic Messages API instead of the
// @anthropic-ai/sdk package — removes the _shims resolution bug
// that surfaces on some Node + Windows + Cloud Functions combos.

import * as admin from "firebase-admin";
import type { EventConfig, ProspectDoc } from "../types";

const db = () => admin.firestore();
const DEFAULT_MODEL = "claude-sonnet-4-6";
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

async function getAuth(): Promise<{ apiKey: string; model: string }> {
  const snap = await db().collection("settings").doc("config").get();
  const data = snap.data() || {};
  const apiKey = data.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Anthropic API key not configured");
  return { apiKey, model: data.anthropicModel || DEFAULT_MODEL };
}

async function callMessages(params: {
  model: string;
  apiKey: string;
  maxTokens: number;
  system: string;
  userMessage: string;
}): Promise<string> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": params.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: [{ role: "user", content: params.userMessage }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 500)}`);
  }
  const data = (await res.json()) as AnthropicMessageResponse;
  return (data.content || [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

function eventBlurb(event: EventConfig): string {
  const date = new Date(event.startsAt);
  const dateStr = date.toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York",
  });
  return [
    `Event: ${event.title}`,
    `Host: ${event.host}${event.channel ? ` (via ${event.channel})` : ""}`,
    `When: ${dateStr}`,
    event.online ? "Format: Online webinar" : "Format: In-person",
    event.speakers?.length ? `Speakers: ${event.speakers.join(", ")}` : "",
    event.description ? `Description: ${event.description}` : "",
    `LinkedIn event: ${event.linkedinEventUrl}`,
    `Registration: ${event.registrationUrl}`,
  ].filter(Boolean).join("\n");
}

function prospectBlurb(p: ProspectDoc): string {
  return [
    p.fullName ? `Name: ${p.fullName}` : "",
    p.headline ? `Headline: ${p.headline}` : (p.jobTitle ? `Title: ${p.jobTitle}` : ""),
    p.company ? `Company: ${p.company}` : "",
    p.industry ? `Industry: ${p.industry}` : "",
    p.location ? `Location: ${p.location}` : "",
    p.followerOfCompanyId ? `Signal: follows ${p.followerOfCompanyId} (security/AppSec interest)` : "",
    p.connectionDegree ? `Connection: ${p.connectionDegree} degree` : "",
  ].filter(Boolean).join("\n");
}

interface GeneratedCopy {
  connectNote: string;
  dmBody: string;
  inmailBody: string;
  emailSubject: string;
  emailBody: string;
  qualityScore: number;
  qualityReasoning: string;
}

const SYSTEM = `You are an expert SDR writing personalized webinar invitations for cybersecurity / application security audiences. Your tone: peer-to-peer, specific, no marketing fluff, no superlatives, no emojis. You write like a senior security engineer who genuinely thinks the recipient will find this event useful.

You will produce four pieces of copy plus a quality score:

1. connectNote   — LinkedIn connection request note. HARD CAP 280 characters (LinkedIn limit is 300; we keep cushion). Reference one specific signal (their role, company, follower-of, or industry) and end with a soft CTA pointing at the LinkedIn event.

2. dmBody        — LinkedIn DM (1st-degree). 600 chars max. Friendly, references their work / recent move / company context. One clear ask: register at the carahevents link.

3. inmailBody    — LinkedIn InMail (premium / non-connection). 1200 chars max, opens with a specific hook, gives 2 reasons it's worth their hour, ends with both the LinkedIn event URL and the carahevents registration URL.

4. emailSubject  — ≤55 chars, no clickbait, hints at the topic.
   emailBody    — 800-1200 chars, clean plain text, one CTA, includes the registration URL.

5. qualityScore  — integer 0-10. 10 = clearly ICP, signals strong, copy lands. ≤6 = marginal fit or generic copy. Only generate strong copy for high scores; if you can't write a confident, specific message because the prospect data is too thin, score honestly.

Output STRICT JSON only, no markdown fence:
{"connectNote":"...","dmBody":"...","inmailBody":"...","emailSubject":"...","emailBody":"...","qualityScore":N,"qualityReasoning":"..."}`;

export async function generateOutreach(prospect: ProspectDoc, event: EventConfig): Promise<GeneratedCopy> {
  const { apiKey, model } = await getAuth();

  const userMsg = [
    "PROSPECT:",
    prospectBlurb(prospect),
    "",
    "EVENT:",
    eventBlurb(event),
    "",
    "Generate outreach. Remember: connectNote ≤280 chars. Output JSON only.",
  ].join("\n");

  const text = await callMessages({
    apiKey, model, maxTokens: 1500, system: SYSTEM, userMessage: userMsg,
  });

  // Tolerate fenced JSON just in case the model slips.
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: GeneratedCopy;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Anthropic returned non-JSON: ${cleaned.slice(0, 300)}`);
  }

  // Hard guardrails (defense in depth — model sometimes overruns).
  parsed.connectNote = (parsed.connectNote || "").slice(0, 280);
  parsed.dmBody = (parsed.dmBody || "").slice(0, 600);
  parsed.inmailBody = (parsed.inmailBody || "").slice(0, 1200);
  parsed.emailSubject = (parsed.emailSubject || "").slice(0, 60);
  parsed.qualityScore = Math.max(0, Math.min(10, Math.round(parsed.qualityScore || 0)));

  return parsed;
}

/**
 * Lightweight ICP scoring before we spend tokens on full copy generation.
 * Returns 0-10 + reason. Use this to filter low-fit prospects out of the
 * sourcing pool before generateOutreach.
 */
export async function scoreIcpFit(
  prospect: ProspectDoc,
  event: EventConfig,
  icpDescription: string,
): Promise<{ score: number; reason: string }> {
  const { apiKey, model } = await getAuth();
  const sys = `You are a cold-outbound qualifier. Given an ICP description, an event, and a prospect, score their fit 0-10. Output strict JSON: {"score":N,"reason":"..."}. Be honest — score 4 or below if the prospect is clearly not in ICP.`;
  const userMsg = [
    "ICP:", icpDescription, "",
    "EVENT TOPIC:", `${event.title} — host ${event.host}`, "",
    "PROSPECT:", prospectBlurb(prospect),
  ].join("\n");

  const text = (await callMessages({
    apiKey, model, maxTokens: 200, system: sys, userMessage: userMsg,
  })).trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    return {
      score: Math.max(0, Math.min(10, Math.round(obj.score || 0))),
      reason: obj.reason || "",
    };
  } catch {
    return { score: 0, reason: `Parse failure: ${cleaned.slice(0, 200)}` };
  }
}
