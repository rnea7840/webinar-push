// Hooks: live Firestore subscriptions for settings, prospects, activity log.
import { useEffect, useState } from "react";
import { auth, db } from "../firebase";
import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";
import {
  doc, onSnapshot, collection, query, orderBy, limit, where,
} from "firebase/firestore";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);
  return { user, loading };
}

export interface SettingsDoc {
  adminKey?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  connectSafelyApiKey?: string;
  mode?: "sandbox" | "live";
  paused?: boolean;
  linkedinPaused?: boolean;
  linkedinPauseReason?: string;
  autoSendQualityFloor?: number;
  linkedinDailyLimit?: number;
  linkedinInmailDailyLimitPerAccount?: number;
  linkedinAccounts?: Array<{ id: string; label?: string; connectSafelyAccountId?: string; enabled?: boolean }>;
  event?: any;
  icp?: any;
  [k: string]: any;
}

export function useSettings() {
  const [data, setData] = useState<SettingsDoc | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    return onSnapshot(doc(db, "settings", "config"), (snap) => {
      setData(snap.exists() ? (snap.data() as SettingsDoc) : {});
      setLoading(false);
    });
  }, []);
  return { data, loading };
}

export function useProspectsByStatus(status?: string, max = 100) {
  const [data, setData] = useState<any[]>([]);
  useEffect(() => {
    const ref = collection(db, "prospects");
    const q = status
      ? query(ref, where("status", "==", status), orderBy("updatedAt", "desc"), limit(max))
      : query(ref, orderBy("updatedAt", "desc"), limit(max));
    return onSnapshot(q, (snap) => {
      setData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [status, max]);
  return data;
}

export function useStatusCounts() {
  // Lightweight: pulls a wide page, groups locally. For tens of thousands
  // the /stats endpoint is the better source — but for this single-event
  // bot we never approach those volumes.
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const ref = collection(db, "prospects");
    const q = query(ref, limit(2000));
    return onSnapshot(q, (snap) => {
      const c: Record<string, number> = {};
      snap.forEach((d) => {
        const s = (d.data() as any).status || "unknown";
        c[s] = (c[s] || 0) + 1;
      });
      setCounts(c);
    });
  }, []);
  return counts;
}

export function useActivityLog(max = 80) {
  const [data, setData] = useState<any[]>([]);
  useEffect(() => {
    const ref = collection(db, "activity_log");
    const q = query(ref, orderBy("timestamp", "desc"), limit(max));
    return onSnapshot(q, (snap) => {
      setData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  }, [max]);
  return data;
}
