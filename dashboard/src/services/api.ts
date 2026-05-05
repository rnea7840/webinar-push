// Tiny client wrapper around our Cloud Functions.
// All endpoints are reachable as /api/<name> via Firebase Hosting rewrites.

import { db } from "../firebase";
import { doc, getDoc } from "firebase/firestore";

async function getAdminKey(): Promise<string> {
  const snap = await getDoc(doc(db, "settings", "config"));
  const k = (snap.data()?.adminKey as string) || "";
  if (!k) throw new Error("Admin key not set. Open Settings → save with a generated admin key first.");
  return k;
}

async function call<T = any>(path: string, body?: any): Promise<T> {
  const adminKey = await getAdminKey();
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(text || "").slice(0, 300)}`);
  return data as T;
}

export const api = {
  seed:        () => call("seed"),
  testKeys:    () => call("testKeys"),
  source:      (perFeedCap?: number) => call("source", perFeedCap ? { perFeedCap } : undefined),
  personalize: (batchSize?: number) => call("personalize", batchSize ? { batchSize } : undefined),
  queue:       () => call("queue"),
  sendNow:     (batchSize?: number) => call("sendNow", batchSize ? { batchSize } : undefined),
  pause:       () => call("pause"),
  resume:      () => call("resume"),
  stats:       () => call("stats"),
};
