// Activity Log — full feed of activity_log entries with type filter.
import { useState } from "react";
import { useActivityLog } from "../hooks/useFirestore";

export default function ActivityLog() {
  const data = useActivityLog(200);
  const [filter, setFilter] = useState("");

  const filtered = filter
    ? data.filter((d) => (d.type || "").toLowerCase().includes(filter.toLowerCase()))
    : data;

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity log</h1>
        <p className="text-sm text-surface-500 mt-1">{filtered.length} of {data.length} entries</p>
      </div>

      <input className="input max-w-xs" placeholder="Filter by type (e.g. linkedin_dm_sent)" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="glass rounded-xl divide-y divide-surface-800/60 text-xs font-mono max-h-[70vh] overflow-auto">
        {filtered.length === 0 && <div className="p-6 text-center text-surface-500">No matching entries.</div>}
        {filtered.map((a) => {
          const ts = a.timestamp?.toDate ? a.timestamp.toDate().toLocaleString() : "—";
          return (
            <div key={a.id} className="px-4 py-2 flex items-start gap-3">
              <span className="text-surface-600 w-40 flex-shrink-0">{ts}</span>
              <span className="text-brand-400 w-48 flex-shrink-0 truncate">{a.type}</span>
              <span className="text-surface-300 flex-1">{a.message}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
