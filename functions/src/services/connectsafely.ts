// ── functions/src/services/connectsafely.ts ──────────────────
// ConnectSafely.ai LinkedIn API client — vendored & slimmed for the
// webinar push bot. Single event, single purpose.
//
// Endpoints used:
//   POST /connect                       Connection request (300-char note)
//   POST /messaging/send                DM (1st-degree)
//   GET  /relationship/{profileId}      Connection degree check
//   POST /profile                       Profile fetch
//   POST /profile/visit                 Profile view (warm-up)
//   POST /search/people-v2              People search (paginated)
//   GET  /organizations/{id}/followers  Company followers
//   POST /follow                        Follow profile (light warm-up)
//   POST /connect/withdraw              Withdraw stale invitation
//   GET  /messaging/recent-messages     Inbox (reply detection)
//   GET  /account/status                Account status / API key test
//
// Auth: Bearer token in Authorization header.
// Auto-pause: 401/403 trip a circuit breaker; 429 / "rate limit" /
// "restricted" set settings.linkedinPaused = true.

import * as admin from "firebase-admin";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const API_BASE = "https://api.connectsafely.ai/linkedin";

const AUTO_PAUSE_PHRASES = [
  "rate limit", "weekly limit", "daily limit", "connection limit",
  "temporarily blocked", "restricted", "too many requests",
];
const AUTH_FAILURE_CODES = [401, 403];
const CIRCUIT_BREAKER_THRESHOLD = 2;

// Circuit breaker is per-process; resets when the function instance recycles.
let consecutiveAuthFailures = 0;

async function log(type: string, message: string, metadata?: Record<string, unknown>) {
  await db().collection("activity_log").add({
    type, message, metadata: metadata || {}, timestamp: FieldValue.serverTimestamp(),
  });
}

async function getApiKey(): Promise<string | null> {
  const snap = await db().collection("settings").doc("config").get();
  return (snap.data()?.connectSafelyApiKey as string) || null;
}

async function triggerLinkedInAutoPause(reason: string) {
  try {
    await db().collection("settings").doc("config").set({
      linkedinPaused: true,
      linkedinPauseReason: reason,
      linkedinPausedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await log("linkedin_auto_paused", `LinkedIn auto-paused: ${reason}`, { reason });
  } catch (e) {
    console.error("Failed to auto-pause LinkedIn:", (e as Error).message);
  }
}

interface CallResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
  rateLimitRemaining?: number;
}

async function csCall<T = any>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  accountId?: string,
): Promise<CallResult<T>> {
  const apiKey = await getApiKey();
  if (!apiKey) return { success: false, error: "ConnectSafely API key not configured" };

  if (consecutiveAuthFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    const msg = `Circuit breaker OPEN — ${consecutiveAuthFailures} consecutive auth failures.`;
    await triggerLinkedInAutoPause(msg);
    return { success: false, error: msg };
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (accountId) headers["X-Account-Id"] = accountId;

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const rateLimitRemaining = parseInt(res.headers.get("X-RateLimit-Remaining") || "-1", 10);

    if (!res.ok) {
      const errText = await res.text();
      const errLower = errText.toLowerCase();

      if (AUTH_FAILURE_CODES.includes(res.status)) {
        consecutiveAuthFailures++;
        if (consecutiveAuthFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          await triggerLinkedInAutoPause(
            `Auth failure (${res.status}) — circuit breaker tripped after ${consecutiveAuthFailures} failures`,
          );
        }
      }

      if (res.status === 429 || AUTO_PAUSE_PHRASES.some((p) => errLower.includes(p))) {
        await triggerLinkedInAutoPause(`Rate limit / block: HTTP ${res.status} — ${errText.slice(0, 200)}`);
      }

      return {
        success: false,
        error: `ConnectSafely ${res.status}: ${errText.slice(0, 500)}`,
        status: res.status,
        rateLimitRemaining,
      };
    }

    consecutiveAuthFailures = 0;
    const data = (await res.json()) as T;
    return { success: true, data, rateLimitRemaining };
  } catch (e) {
    return { success: false, error: `Network error: ${(e as Error).message}` };
  }
}

// ── 1. Connection request ──────────────────────────────────────
export async function sendConnectionRequest(params: {
  profileUrl: string;
  message?: string;
  accountId?: string;
}): Promise<{ success: boolean; message: string }> {
  const note = params.message ? params.message.slice(0, 300) : undefined;
  const r = await csCall("POST", "/connect", { profileUrl: params.profileUrl, message: note }, params.accountId);
  if (r.success) {
    await log("linkedin_connection_sent", `Connection request sent: ${params.profileUrl}`,
      { profileUrl: params.profileUrl, accountId: params.accountId });
    return { success: true, message: "Connection request sent" };
  }
  await log("error", `Connection request failed: ${r.error}`, { profileUrl: params.profileUrl });
  return { success: false, message: r.error || "Connection request failed" };
}

// ── 2. Direct message (1st-degree only) ───────────────────────
export async function sendLinkedInMessage(params: {
  profileUrl: string;
  message: string;
  accountId?: string;
}): Promise<{ success: boolean; message: string }> {
  const r = await csCall("POST", "/messaging/send",
    { profileUrl: params.profileUrl, message: params.message }, params.accountId);
  if (r.success) {
    await log("linkedin_dm_sent", `DM sent: ${params.profileUrl}`,
      { profileUrl: params.profileUrl, accountId: params.accountId });
    return { success: true, message: "DM sent" };
  }
  await log("error", `DM failed: ${r.error}`, { profileUrl: params.profileUrl });
  return { success: false, message: r.error || "DM failed" };
}

export async function sendLinkedInMessageWithTyping(params: {
  profileUrl: string;
  message: string;
  typingDelayMs?: number;
  accountId?: string;
}): Promise<{ success: boolean; message: string }> {
  const delay = params.typingDelayMs ?? 60000 + Math.random() * 60000;
  await new Promise((r) => setTimeout(r, delay));
  return sendLinkedInMessage({
    profileUrl: params.profileUrl, message: params.message, accountId: params.accountId,
  });
}

// ── 3. Relationship check ─────────────────────────────────────
export async function checkRelationship(params: {
  profileUrl: string;
  accountId?: string;
}): Promise<{ connected: boolean; degree?: "1st" | "2nd" | "3rd+" | "unknown"; error?: string }> {
  const encoded = encodeURIComponent(params.profileUrl);
  const r = await csCall<any>("GET", `/relationship/${encoded}`, undefined, params.accountId);
  if (r.success && r.data) {
    const raw = r.data.degree || r.data.connectionDegree || "unknown";
    const degree = (raw === 1 || raw === "1st") ? "1st"
      : (raw === 2 || raw === "2nd") ? "2nd"
      : (raw === 3 || raw === "3rd" || raw === "3rd+") ? "3rd+"
      : "unknown";
    return { connected: degree === "1st", degree };
  }
  return { connected: false, error: r.error };
}

// ── 4. Profile fetch ──────────────────────────────────────────
export async function fetchProfile(params: {
  profileUrl: string;
  accountId?: string;
}): Promise<{ success: boolean; data?: any; error?: string }> {
  const match = params.profileUrl.match(/linkedin\.com\/in\/([^\/\?]+)/i);
  const profileId = match?.[1] || params.profileUrl;
  const r = await csCall("POST", "/profile", {
    profileId,
    includeGeoLocation: true,
    includeExperience: true,
    includeSkills: false,
    includeEducation: false,
    includeContact: false,
  }, params.accountId);
  return r.success
    ? { success: true, data: r.data }
    : { success: false, error: r.error };
}

export async function visitLinkedInProfile(params: {
  profileUrl: string;
  accountId?: string;
}): Promise<{ success: boolean; error?: string }> {
  return csCall("POST", "/profile/visit", { profileUrl: params.profileUrl }, params.accountId);
}

// ── 5. People search (V2) ─────────────────────────────────────
export async function searchPeopleV2(params: {
  keywords?: string;
  jobTitles?: string[];
  companies?: string[];
  excludeCompanies?: string[];
  locations?: string[];
  industries?: string[];
  connectionDegree?: ("1st" | "2nd" | "3rd+")[];
  followerOf?: string[];
  premiumOnly?: boolean;
  count?: number;
  start?: number;
  accountId?: string;
}): Promise<{ success: boolean; data?: any[]; total?: number; error?: string }> {
  const body: Record<string, unknown> = {
    keywords: params.keywords || "",
    count: params.count || 50,
    start: params.start || 0,
  };
  if (params.jobTitles) body.jobTitles = params.jobTitles;
  if (params.companies) body.companies = params.companies;
  if (params.excludeCompanies) body.excludeCompanies = params.excludeCompanies;
  if (params.locations) body.geoLocation = params.locations;
  if (params.industries) body.industries = params.industries;
  if (params.connectionDegree) body.connectionDegree = params.connectionDegree;
  if (params.followerOf) body.followerOf = params.followerOf;
  if (params.premiumOnly) body.premiumOnly = true;

  const r = await csCall<any>("POST", "/search/people-v2", body, params.accountId);
  if (!r.success) return { success: false, error: r.error };
  const results = r.data?.results || r.data?.elements || r.data || [];
  const total = r.data?.paging?.total || r.data?.total || results.length;
  return { success: true, data: results, total };
}

// ── 6. Company followers ──────────────────────────────────────
export async function getCompanyFollowers(params: {
  companyId: string;
  start?: number;
  count?: number;
  accountId?: string;
}): Promise<{ success: boolean; data?: any[]; total?: number; error?: string }> {
  const path = `/organizations/${encodeURIComponent(params.companyId)}/followers?start=${params.start || 0}&count=${params.count || 100}`;
  const r = await csCall<any>("GET", path, undefined, params.accountId);
  if (!r.success) return { success: false, error: r.error };
  return {
    success: true,
    data: r.data?.followers || r.data?.results || r.data || [],
    total: r.data?.total || r.data?.paging?.total,
  };
}

// ── 6b. Group members ─────────────────────────────────────────
// Pulls members of a LinkedIn group by ID or URL. Group members
// self-selected interest in a topic, so they convert better than
// cold search hits.
export async function getGroupMembers(params: {
  groupId?: string;
  groupUrl?: string;
  start?: number;
  count?: number;
  accountId?: string;
}): Promise<{ success: boolean; data?: any[]; total?: number; error?: string }> {
  if (!params.groupId && !params.groupUrl) {
    return { success: false, error: "groupId or groupUrl required" };
  }
  const path = params.groupUrl ? "/groups/members-by-url" : "/groups/members";
  const body: Record<string, unknown> = params.groupUrl
    ? { url: params.groupUrl }
    : { groupId: params.groupId };
  body.start = params.start || 0;
  body.count = params.count || 100;
  const r = await csCall<any>("POST", path, body, params.accountId);
  if (!r.success) return { success: false, error: r.error };
  const data = r.data?.members || r.data?.results || r.data?.elements || r.data || [];
  const total = r.data?.total || r.data?.paging?.total || data.length;
  return { success: true, data, total };
}

// ── 6c. Post engagers (reactors + commenters) ────────────────
// People who already engaged with a relevant post — high-intent
// signal. Use for sourcing prospects from an Apona/Carahsoft
// announcement or any AppSec/SBOM post that draws ICP audiences.
export async function getPostReactions(params: {
  postUrl: string;
  start?: number;
  count?: number;
  accountId?: string;
}): Promise<{ success: boolean; data?: any[]; error?: string }> {
  const r = await csCall<any>("POST", "/posts/reactions", {
    url: params.postUrl,
    start: params.start || 0,
    count: params.count || 100,
  }, params.accountId);
  if (!r.success) return { success: false, error: r.error };
  return { success: true, data: r.data?.reactions || r.data?.results || r.data || [] };
}

export async function getPostComments(params: {
  postUrl: string;
  accountId?: string;
}): Promise<{ success: boolean; data?: any[]; error?: string }> {
  const r = await csCall<any>("POST", "/posts/comments", {
    url: params.postUrl,
    allComments: true,
  }, params.accountId);
  if (!r.success) return { success: false, error: r.error };
  return { success: true, data: r.data?.comments || r.data?.results || r.data || [] };
}

// ── 7. Follow (light warm-up) ─────────────────────────────────
export async function followProfile(params: {
  profileUrl: string;
  accountId?: string;
}): Promise<{ success: boolean; error?: string }> {
  return csCall("POST", "/follow", { profileUrl: params.profileUrl }, params.accountId);
}

// ── 8. Withdraw invitation ────────────────────────────────────
export async function withdrawInvitation(params: {
  profileUrl: string;
  accountId?: string;
}): Promise<{ success: boolean; error?: string }> {
  return csCall("POST", "/connect/withdraw", { profileUrl: params.profileUrl }, params.accountId);
}

// ── 9. Recent inbox (reply detection) ─────────────────────────
export async function getRecentMessages(params: {
  keyword?: string;
  limit?: number;
  accountId?: string;
}): Promise<{ success: boolean; data?: any[]; error?: string }> {
  let path = `/messaging/recent-messages?limit=${params.limit || 50}`;
  if (params.keyword) path += `&keyword=${encodeURIComponent(params.keyword)}`;
  const r = await csCall<any>("GET", path, undefined, params.accountId);
  if (!r.success) return { success: false, error: r.error };
  return { success: true, data: r.data?.messages || r.data || [] };
}

// ── 10. Account status / API key test ────────────────────────
export async function getAccountStatus(accountId?: string): Promise<{
  success: boolean; data?: any; error?: string;
}> {
  const path = accountId ? `/account/${accountId}/status` : "/account/status";
  return csCall("GET", path);
}

export async function testConnectSafelyKey(apiKey: string): Promise<{ valid: boolean; message: string }> {
  try {
    const res = await fetch(`${API_BASE}/account/status`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (res.ok) return { valid: true, message: "API key valid" };
    if (AUTH_FAILURE_CODES.includes(res.status)) {
      return { valid: false, message: "API key rejected" };
    }
    if (res.status === 429) return { valid: true, message: "Key valid but rate limited" };
    const text = await res.text().catch(() => "");
    return { valid: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { valid: false, message: `Connection failed: ${(e as Error).message}` };
  }
}
