// ── functions/src/services/prospects.ts ───────────────────────
// Prospect sourcing. Four feeds:
//   1. searchPeopleV2     — Sales-Nav-style ICP filter
//   2. getCompanyFollowers — followers of competitor / adjacent
//                            vendor pages
//   3. getGroupMembers    — members of LinkedIn groups (high-intent,
//                            self-selected interest)
//   4. post engagers      — commenters + reactors on relevant posts
//
// Dedupe by profileUrl. Persists to Firestore `prospects` with
// status="sourced". A separate step (personalize) qualifies via
// Anthropic and drafts copy.

import * as admin from "firebase-admin";
import {
  searchPeopleV2, getCompanyFollowers, getGroupMembers,
  getPostReactions, getPostComments,
} from "./connectsafely";
import type { IcpFilter, ProspectDoc } from "../types";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function log(type: string, message: string, metadata?: Record<string, unknown>) {
  await db().collection("activity_log").add({
    type, message, metadata: metadata || {}, timestamp: FieldValue.serverTimestamp(),
  });
}

// Tolerant raw-profile shape — different ConnectSafely endpoints
// return slightly different keys (especially post engagers, where
// the engager is nested under `commenter` / `reactor` / `actor`).
interface RawProfile {
  profileUrl?: string;
  url?: string;
  publicProfileUrl?: string;
  link?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  headline?: string;
  occupation?: string;
  jobTitle?: string;
  title?: string;
  company?: string;
  companyName?: string;
  currentCompany?: string;
  companyId?: string;
  industry?: string;
  location?: string;
  geoLocation?: string;
  connectionDegree?: string | number;
  isPremium?: boolean;
  premium?: boolean;
  // Wrapper shapes from posts/comments + posts/reactions
  commenter?: RawProfile;
  reactor?: RawProfile;
  actor?: RawProfile;
  member?: RawProfile;
  profile?: RawProfile;
}

function pickProfileUrl(r: RawProfile): string | null {
  return r.profileUrl || r.url || r.publicProfileUrl || r.link || null;
}

function unwrap(r: RawProfile): RawProfile {
  // Some endpoints wrap the profile under a sub-key. Surface the
  // first one we find.
  return r.profile || r.commenter || r.reactor || r.actor || r.member || r;
}

function normalizeDegree(d: unknown): "1st" | "2nd" | "3rd+" | undefined {
  if (d === 1 || d === "1st") return "1st";
  if (d === 2 || d === "2nd") return "2nd";
  if (d === 3 || d === "3rd" || d === "3rd+") return "3rd+";
  return undefined;
}

interface ToProspectArgs {
  source: ProspectDoc["source"];
  followerOfCompanyId?: string;
  sourceGroupRef?: string;
  sourcePostUrl?: string;
  engagementType?: "reaction" | "comment";
}

function rawToProspect(raw: RawProfile, args: ToProspectArgs): Omit<ProspectDoc, "id"> | null {
  const r = unwrap(raw);
  const profileUrl = pickProfileUrl(r);
  if (!profileUrl) return null;

  const fullName = r.fullName || r.name
    || [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || undefined;

  return {
    fullName,
    firstName: r.firstName,
    lastName: r.lastName,
    headline: r.headline,
    jobTitle: r.jobTitle || r.title || r.occupation,
    company: r.company || r.companyName || r.currentCompany,
    companyId: r.companyId,
    industry: r.industry,
    location: r.location || r.geoLocation,
    profileUrl,
    source: args.source,
    followerOfCompanyId: args.followerOfCompanyId,
    sourceGroupRef: args.sourceGroupRef,
    sourcePostUrl: args.sourcePostUrl,
    engagementType: args.engagementType,
    connectionDegree: normalizeDegree(r.connectionDegree),
    isPremium: !!(r.isPremium || r.premium),
    status: "sourced",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function upsertProspect(p: Omit<ProspectDoc, "id">): Promise<{ inserted: boolean }> {
  const existing = await db().collection("prospects")
    .where("profileUrl", "==", p.profileUrl).limit(1).get();
  if (!existing.empty) return { inserted: false };
  await db().collection("prospects").add(p);
  return { inserted: true };
}

/**
 * Light heuristic title pre-filter. Used on feeds where everyone
 * isn't already filtered by ICP (groups, post engagers, company
 * followers). If the raw profile has a headline/title that contains
 * any ICP keyword, keep it; otherwise drop. If we have no title at
 * all, KEEP the prospect — Anthropic will qualify them later from
 * a profile fetch in the personalize step.
 */
function passesTitlePreFilter(raw: RawProfile, jobTitles: string[]): boolean {
  const r = unwrap(raw);
  const t = (r.headline || r.jobTitle || r.title || r.occupation || "").toLowerCase();
  if (!t) return true; // unknown — let Anthropic qualify later
  if (jobTitles.length === 0) return true;
  return jobTitles.some((q) => t.includes(q.toLowerCase()));
}

export interface SourceResult {
  totalFetched: number;
  inserted: number;
  duplicates: number;
  errors: string[];
  byFeed: Record<"search" | "company_followers" | "group_members" | "post_engagers", number>;
}

/**
 * Run all sourcing feeds for the configured ICP. Caps each feed to
 * keep ConnectSafely's 300-search/month budget under control.
 */
export async function runSourcing(params: {
  icp: IcpFilter;
  perFeedCap?: number;        // hard cap per feed (default 200)
  pageSize?: number;          // results per API call (default 50/100 depending on feed)
}): Promise<SourceResult> {
  const result: SourceResult = {
    totalFetched: 0, inserted: 0, duplicates: 0, errors: [],
    byFeed: { search: 0, company_followers: 0, group_members: 0, post_engagers: 0 },
  };
  const cap = params.perFeedCap ?? 200;
  const searchPageSize = params.pageSize ?? 50;
  const followerPageSize = 100;

  // ── Feed 1: searchPeopleV2 across ICP filter ──
  let start = 0;
  while (start < cap) {
    const r = await searchPeopleV2({
      jobTitles: params.icp.jobTitles,
      industries: params.icp.industries,
      companies: params.icp.companies,
      excludeCompanies: params.icp.excludeCompanies,
      locations: params.icp.locations,
      connectionDegree: params.icp.connectionDegree,
      premiumOnly: params.icp.premiumOnly,
      count: searchPageSize,
      start,
    });
    if (!r.success) { result.errors.push(`search: ${r.error}`); break; }
    const batch = r.data || [];
    if (batch.length === 0) break;
    result.totalFetched += batch.length;

    for (const raw of batch as RawProfile[]) {
      const p = rawToProspect(raw, { source: "search" });
      if (!p) continue;
      const ins = await upsertProspect(p);
      if (ins.inserted) { result.inserted++; result.byFeed.search++; }
      else result.duplicates++;
    }

    if (batch.length < searchPageSize) break;
    start += searchPageSize;
  }

  // ── Feed 2: getCompanyFollowers for each followerOf company ──
  for (const companyId of params.icp.followerOf || []) {
    let cursor = 0;
    while (cursor < cap) {
      const r = await getCompanyFollowers({
        companyId, start: cursor, count: followerPageSize,
      });
      if (!r.success) { result.errors.push(`followers(${companyId}): ${r.error}`); break; }
      const batch = r.data || [];
      if (batch.length === 0) break;
      result.totalFetched += batch.length;

      for (const raw of batch as RawProfile[]) {
        if (!passesTitlePreFilter(raw, params.icp.jobTitles)) continue;
        const p = rawToProspect(raw, {
          source: "company_followers", followerOfCompanyId: companyId,
        });
        if (!p) continue;
        const ins = await upsertProspect(p);
        if (ins.inserted) { result.inserted++; result.byFeed.company_followers++; }
        else result.duplicates++;
      }
      if (batch.length < followerPageSize) break;
      cursor += followerPageSize;
    }
  }

  // ── Feed 3: getGroupMembers for each group ──
  for (const groupRef of params.icp.linkedinGroups || []) {
    let cursor = 0;
    const isUrl = /^https?:\/\//i.test(groupRef);
    while (cursor < cap) {
      const r = await getGroupMembers({
        groupUrl: isUrl ? groupRef : undefined,
        groupId: isUrl ? undefined : groupRef,
        start: cursor, count: followerPageSize,
      });
      if (!r.success) { result.errors.push(`group(${groupRef}): ${r.error}`); break; }
      const batch = r.data || [];
      if (batch.length === 0) break;
      result.totalFetched += batch.length;

      for (const raw of batch as RawProfile[]) {
        if (!passesTitlePreFilter(raw, params.icp.jobTitles)) continue;
        const p = rawToProspect(raw, {
          source: "group_members", sourceGroupRef: groupRef,
        });
        if (!p) continue;
        const ins = await upsertProspect(p);
        if (ins.inserted) { result.inserted++; result.byFeed.group_members++; }
        else result.duplicates++;
      }
      if (batch.length < followerPageSize) break;
      cursor += followerPageSize;
    }
  }

  // ── Feed 4: post engagers (reactors + commenters) ──
  for (const postUrl of params.icp.targetPosts || []) {
    // 4a. reactions
    let cursor = 0;
    while (cursor < cap) {
      const r = await getPostReactions({ postUrl, start: cursor, count: followerPageSize });
      if (!r.success) { result.errors.push(`post_reactions(${postUrl}): ${r.error}`); break; }
      const batch = r.data || [];
      if (batch.length === 0) break;
      result.totalFetched += batch.length;

      for (const raw of batch as RawProfile[]) {
        if (!passesTitlePreFilter(raw, params.icp.jobTitles)) continue;
        const p = rawToProspect(raw, {
          source: "post_engagers", sourcePostUrl: postUrl, engagementType: "reaction",
        });
        if (!p) continue;
        const ins = await upsertProspect(p);
        if (ins.inserted) { result.inserted++; result.byFeed.post_engagers++; }
        else result.duplicates++;
      }
      if (batch.length < followerPageSize) break;
      cursor += followerPageSize;
    }

    // 4b. comments (one call returns all comments for the post)
    const c = await getPostComments({ postUrl });
    if (!c.success) {
      result.errors.push(`post_comments(${postUrl}): ${c.error}`);
    } else {
      const batch = c.data || [];
      result.totalFetched += batch.length;
      for (const raw of batch as RawProfile[]) {
        if (!passesTitlePreFilter(raw, params.icp.jobTitles)) continue;
        const p = rawToProspect(raw, {
          source: "post_engagers", sourcePostUrl: postUrl, engagementType: "comment",
        });
        if (!p) continue;
        const ins = await upsertProspect(p);
        if (ins.inserted) { result.inserted++; result.byFeed.post_engagers++; }
        else result.duplicates++;
      }
    }
  }

  await log("sourcing_complete",
    `Sourced ${result.totalFetched} profiles → inserted ${result.inserted} new (${result.duplicates} duplicates, ${result.errors.length} errors)`,
    { result });

  return result;
}
