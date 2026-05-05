// ── functions/src/services/prospects.ts ───────────────────────
// Prospect sourcing. Two feeds:
//   1. searchPeopleV2 — Sales Nav-style filter on jobTitles +
//      industries + companies + locations + connectionDegree
//   2. getCompanyFollowers — pulls followers of competitor /
//      adjacent-vendor pages (BlackDuck, Snyk, Veracode, Anchore,
//      Synopsys, Apona Security, etc.)
//
// Dedupe by profileUrl. Persists to Firestore `prospects` collection
// with status="sourced". A separate step (personalize) qualifies and
// drafts copy.

import * as admin from "firebase-admin";
import { searchPeopleV2, getCompanyFollowers } from "./connectsafely";
import type { IcpFilter, ProspectDoc } from "../types";

const db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

async function log(type: string, message: string, metadata?: Record<string, unknown>) {
  await db().collection("activity_log").add({
    type, message, metadata: metadata || {}, timestamp: FieldValue.serverTimestamp(),
  });
}

interface RawProfile {
  profileUrl?: string;
  url?: string;
  publicProfileUrl?: string;
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
}

function pickProfileUrl(r: RawProfile): string | null {
  return r.profileUrl || r.url || r.publicProfileUrl || null;
}

function normalizeDegree(d: unknown): "1st" | "2nd" | "3rd+" | undefined {
  if (d === 1 || d === "1st") return "1st";
  if (d === 2 || d === "2nd") return "2nd";
  if (d === 3 || d === "3rd" || d === "3rd+") return "3rd+";
  return undefined;
}

function rawToProspect(r: RawProfile, source: "search" | "company_followers", followerOfCompanyId?: string): Omit<ProspectDoc, "id"> | null {
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
    source,
    followerOfCompanyId,
    connectionDegree: normalizeDegree(r.connectionDegree),
    isPremium: !!(r.isPremium || r.premium),
    status: "sourced",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/**
 * Idempotent upsert: dedupe by profileUrl. If the prospect already
 * exists we leave their status alone (don't reset progress).
 */
async function upsertProspect(p: Omit<ProspectDoc, "id">): Promise<{ inserted: boolean }> {
  const existing = await db().collection("prospects")
    .where("profileUrl", "==", p.profileUrl).limit(1).get();
  if (!existing.empty) return { inserted: false };
  await db().collection("prospects").add(p);
  return { inserted: true };
}

export interface SourceResult {
  totalFetched: number;
  inserted: number;
  duplicates: number;
  errors: string[];
}

/**
 * Run all sourcing feeds for the configured ICP. Caps each feed to
 * avoid blowing through ConnectSafely's 300-search/month budget.
 */
export async function runSourcing(params: {
  icp: IcpFilter;
  perFeedCap?: number;        // hard cap per feed call (default 200)
  pageSize?: number;          // results per API call (default 50)
}): Promise<SourceResult> {
  const result: SourceResult = { totalFetched: 0, inserted: 0, duplicates: 0, errors: [] };
  const cap = params.perFeedCap ?? 200;
  const pageSize = params.pageSize ?? 50;

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
      count: pageSize,
      start,
    });
    if (!r.success) { result.errors.push(`search: ${r.error}`); break; }
    const batch = r.data || [];
    if (batch.length === 0) break;
    result.totalFetched += batch.length;

    for (const raw of batch as RawProfile[]) {
      const p = rawToProspect(raw, "search");
      if (!p) continue;
      const ins = await upsertProspect(p);
      if (ins.inserted) result.inserted++; else result.duplicates++;
    }

    if (batch.length < pageSize) break;
    start += pageSize;
  }

  // ── Feed 2: getCompanyFollowers for each followerOf company ──
  for (const companyId of params.icp.followerOf || []) {
    let cursor = 0;
    while (cursor < cap) {
      const r = await getCompanyFollowers({
        companyId, start: cursor, count: pageSize,
      });
      if (!r.success) { result.errors.push(`followers(${companyId}): ${r.error}`); break; }
      const batch = r.data || [];
      if (batch.length === 0) break;
      result.totalFetched += batch.length;

      for (const raw of batch as RawProfile[]) {
        const p = rawToProspect(raw, "company_followers", companyId);
        if (!p) continue;
        // Light filter: only keep followers whose title hints at ICP.
        // This is heuristic — Anthropic does the real qualification later.
        const t = (p.jobTitle || p.headline || "").toLowerCase();
        const titleMatch = (params.icp.jobTitles || []).some((q) => t.includes(q.toLowerCase()));
        if (!titleMatch && (params.icp.jobTitles || []).length > 0) {
          continue;
        }
        const ins = await upsertProspect(p);
        if (ins.inserted) result.inserted++; else result.duplicates++;
      }

      if (batch.length < pageSize) break;
      cursor += pageSize;
    }
  }

  await log("sourcing_complete",
    `Sourced ${result.totalFetched} profiles → inserted ${result.inserted} new (${result.duplicates} duplicates, ${result.errors.length} errors)`,
    { result });

  return result;
}
