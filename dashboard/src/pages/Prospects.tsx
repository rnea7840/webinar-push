// Prospects — filterable table.
import { useState } from "react";
import { useProspectsByStatus } from "../hooks/useFirestore";
import { Linkedin, Mail, MessageSquare, UserPlus, ExternalLink } from "lucide-react";

const STATUSES = [
  "all", "sourced", "drafted", "queued", "sent",
  "follow_up_1", "follow_up_2", "follow_up_3",
  "replied", "registered", "rejected", "errored",
];

function channelBadge(c?: string) {
  const map: Record<string, { cls: string; icon: any; label: string }> = {
    linkedin_dm:      { cls: "badge-blue",   icon: MessageSquare, label: "DM" },
    linkedin_connect: { cls: "badge-purple", icon: UserPlus,      label: "Connect" },
    linkedin_inmail:  { cls: "badge-yellow", icon: Linkedin,      label: "InMail" },
    email:            { cls: "badge-green",  icon: Mail,          label: "Email" },
  };
  if (!c || !map[c]) return <span className="badge badge-gray">—</span>;
  const m = map[c];
  return <span className={m.cls}><m.icon size={10} />{m.label}</span>;
}

function statusBadge(s?: string) {
  if (!s) return <span className="badge badge-gray">—</span>;
  const cls = s === "registered" || s === "replied"  ? "badge-green"
            : s === "sent" || s.startsWith("follow") ? "badge-blue"
            : s === "rejected" || s === "errored"    ? "badge-red"
            : s === "queued" || s === "drafted"      ? "badge-yellow"
            : "badge-gray";
  return <span className={cls}>{s}</span>;
}

export default function Prospects() {
  const [status, setStatus] = useState<string>("all");
  const data = useProspectsByStatus(status === "all" ? undefined : status, 200);

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Prospects</h1>
        <p className="text-sm text-surface-500 mt-1">{data.length} shown · filter by status</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border transition ${
              status === s
                ? "bg-brand-600/15 border-brand-600/40 text-brand-300"
                : "bg-surface-900 border-surface-800 text-surface-400 hover:text-surface-200 hover:border-surface-700"
            }`}>
            {s}
          </button>
        ))}
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-900/80 text-xs text-surface-400 uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Title · Company</th>
              <th className="text-left px-4 py-3 font-medium">Source</th>
              <th className="text-left px-4 py-3 font-medium">Channel</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Score</th>
              <th className="text-left px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-surface-500 text-sm">No prospects yet.</td></tr>
            )}
            {data.map((p) => (
              <tr key={p.id} className="border-t border-surface-800/60 hover:bg-surface-900/40">
                <td className="px-4 py-3">
                  <div className="font-medium text-surface-100">{p.fullName || "—"}</div>
                  <div className="text-xs text-surface-500">{p.location || ""}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-surface-200">{p.jobTitle || p.headline || "—"}</div>
                  <div className="text-xs text-surface-500">{p.company || ""}</div>
                </td>
                <td className="px-4 py-3 text-xs text-surface-400">
                  {p.source}
                  {p.followerOfCompanyId && <div className="text-surface-600">via {p.followerOfCompanyId}</div>}
                  {p.sourceGroupRef && <div className="text-surface-600 truncate max-w-[12rem]" title={p.sourceGroupRef}>group</div>}
                  {p.sourcePostUrl && <div className="text-surface-600">post {p.engagementType}</div>}
                </td>
                <td className="px-4 py-3">{channelBadge(p.channel)}</td>
                <td className="px-4 py-3">{statusBadge(p.status)}</td>
                <td className="px-4 py-3 tabular-nums text-surface-200">{p.qualityScore ?? "—"}</td>
                <td className="px-4 py-3">
                  {p.profileUrl && (
                    <a href={p.profileUrl} target="_blank" rel="noreferrer" className="text-surface-500 hover:text-brand-400 inline-flex items-center gap-1 text-xs">
                      <ExternalLink size={12} /> profile
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
