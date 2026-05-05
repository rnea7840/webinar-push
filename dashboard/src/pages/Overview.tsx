// Overview — stat cards, capacity, recent activity, run-buttons.
import { useState } from "react";
import {
  Users, Inbox, Mail, Linkedin, Send, CheckCircle2, AlertTriangle,
  PauseCircle, PlayCircle, Loader2, Sparkles, Search, Zap,
} from "lucide-react";
import { useSettings, useStatusCounts, useActivityLog } from "../hooks/useFirestore";
import { api } from "../services/api";

function StatCard({ label, value, icon: Icon, accent = "brand" }: any) {
  const accents: Record<string, string> = {
    brand: "text-brand-400",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
    purple: "text-purple-400",
  };
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-surface-400 uppercase tracking-wide">{label}</span>
        <Icon size={14} className={accents[accent] || accents.brand} />
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? "—"}</div>
    </div>
  );
}

function RunButton({ label, icon: Icon, onClick, accent = "primary", busy }: any) {
  const cls = accent === "primary" ? "btn-primary" : accent === "success" ? "btn-success" : "btn-secondary";
  return (
    <button onClick={onClick} disabled={busy} className={`${cls} flex items-center justify-center gap-2`}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
      {label}
    </button>
  );
}

export default function Overview() {
  const { data: settings } = useSettings();
  const counts = useStatusCounts();
  const activity = useActivityLog(20);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string>("");
  const [capacity, setCapacity] = useState<{ dm: number; connect: number; inmail: number; total: number } | null>(null);

  async function run(action: keyof typeof api, label: string) {
    setBusy(label); setLastResult(`Running /${action}...`);
    try {
      const r: any = await (api[action] as any)();
      setLastResult(JSON.stringify(r, null, 2));
      if (action === "stats" && r.capacityRemainingToday) setCapacity(r.capacityRemainingToday);
    } catch (e: any) {
      setLastResult(`ERR: ${e.message}`);
    }
    setBusy(null);
  }

  // Refresh capacity once when the page mounts
  useState(() => { run("stats", "stats").catch(() => {}); return null; });

  const isLive = settings?.mode === "live";
  const isPaused = !!(settings?.paused || settings?.linkedinPaused);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-surface-500 mt-1">
            {settings?.event?.title || "SBOM event"} · {settings?.event?.startsAt
              ? new Date(settings.event.startsAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isPaused ? (
            <button className="btn-success flex items-center gap-2" onClick={() => run("resume", "resume")}>
              <PlayCircle size={14} /> Resume
            </button>
          ) : (
            <button className="btn-danger flex items-center gap-2" onClick={() => run("pause", "pause")}>
              <PauseCircle size={14} /> Pause everything
            </button>
          )}
        </div>
      </div>

      {/* Capacity row */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="DM remaining today"     value={capacity?.dm ?? "—"}     icon={Linkedin} accent="brand" />
        <StatCard label="Connect remaining"      value={capacity?.connect ?? "—"} icon={Users}    accent="emerald" />
        <StatCard label="InMail remaining"       value={capacity?.inmail ?? "—"}  icon={Mail}     accent="amber" />
        <StatCard label="Total touches/day left" value={capacity?.total ?? "—"}   icon={Send}     accent="purple" />
      </div>

      {/* Pipeline counters */}
      <div className="grid grid-cols-6 gap-3">
        <StatCard label="Sourced"     value={counts.sourced ?? 0}     icon={Search}      />
        <StatCard label="Drafted"     value={counts.drafted ?? 0}     icon={Sparkles}    />
        <StatCard label="Queued"      value={counts.queued ?? 0}      icon={Inbox}       />
        <StatCard label="Sent"        value={counts.sent ?? 0}        icon={Send}        accent="brand" />
        <StatCard label="Replied"     value={counts.replied ?? 0}     icon={CheckCircle2} accent="emerald" />
        <StatCard label="Registered"  value={counts.registered ?? 0}  icon={Zap}         accent="emerald" />
      </div>

      {/* Run buttons */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Run pipeline</h2>
          <span className="text-xs text-surface-500">cron auto-runs every 30 min · these are manual bursts</span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <RunButton label="Source"      icon={Search}   busy={busy === "source"}      onClick={() => run("source", "source")} />
          <RunButton label="Personalize" icon={Sparkles} busy={busy === "personalize"} onClick={() => run("personalize", "personalize")} />
          <RunButton label="Queue"       icon={Inbox}    busy={busy === "queue"}       onClick={() => run("queue", "queue")} />
          <RunButton label="Send Now"    icon={Send}     busy={busy === "sendNow"}     accent={isLive ? "success" : "primary"} onClick={() => run("sendNow", "sendNow")} />
        </div>
        {lastResult && (
          <pre className="mt-4 bg-surface-950/60 border border-surface-800 rounded-lg p-3 text-xs font-mono text-surface-300 overflow-auto max-h-64 whitespace-pre-wrap">
            {lastResult}
          </pre>
        )}
      </div>

      {/* Recent activity */}
      <div className="glass rounded-xl p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-400" /> Recent activity
        </h2>
        <div className="space-y-1 text-xs font-mono max-h-80 overflow-auto">
          {activity.length === 0 && <div className="text-surface-500">No activity yet.</div>}
          {activity.map((a) => {
            const ts = a.timestamp?.toDate ? a.timestamp.toDate().toLocaleTimeString() : "—";
            return (
              <div key={a.id} className="flex gap-3 py-1 border-b border-surface-800/50">
                <span className="text-surface-600 w-20 flex-shrink-0">{ts}</span>
                <span className="text-brand-400 w-44 flex-shrink-0 truncate">{a.type}</span>
                <span className="text-surface-300 truncate">{a.message}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
