// ── dashboard/src/pages/SettingsPage.tsx ──────────────────────
// Lifted from AISDRLabradorLabs/dashboard/src/pages/SettingsPage.tsx
// (Section / Field / Toggle / KeyField / ModeButton patterns) and
// adapted for the webinar-push schema (Anthropic + ConnectSafely
// only, multi-account LinkedIn rows, simpler limits).

import { useState, useEffect } from "react";
import {
  Settings, Key, CheckCircle, XCircle, AlertTriangle, Loader2, RefreshCw,
  Shield, Brain, Linkedin, Save, Eye, EyeOff, Plus, Trash2, KeyRound, FlaskConical, Radio,
  Sparkles,
} from "lucide-react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { api } from "../services/api";

interface KeyTestResult {
  status: "ok" | "missing" | "invalid" | "error";
  message: string;
}

interface AccountRow {
  id: string;
  label?: string;
  connectSafelyAccountId?: string;
  enabled?: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [keyTests, setKeyTests] = useState<Record<string, KeyTestResult>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<any>(null);

  useEffect(() => {
    return onSnapshot(doc(db, "settings", "config"), (snap) => {
      if (snap.exists()) setSettings(snap.data());
    });
  }, []);

  function update(field: string, value: any) {
    setSettings((prev) => ({ ...prev, [field]: value }));
    setDirty(true);
  }

  function updateAccount(i: number, patch: Partial<AccountRow>) {
    const list: AccountRow[] = settings.linkedinAccounts?.length
      ? [...settings.linkedinAccounts] : [{ id: "personal", label: "Personal", enabled: true }];
    list[i] = { ...list[i], ...patch };
    update("linkedinAccounts", list);
  }
  function addAccount() {
    const list: AccountRow[] = settings.linkedinAccounts || [];
    update("linkedinAccounts", [...list, { id: "", label: "", enabled: true }]);
  }
  function removeAccount(i: number) {
    const list: AccountRow[] = settings.linkedinAccounts || [];
    update("linkedinAccounts", list.filter((_, j) => j !== i));
  }

  async function save() {
    setSaving(true);
    try {
      const cleanedAccounts = (settings.linkedinAccounts || [])
        .map((a: AccountRow) => ({
          id: (a.id || "").trim(),
          label: (a.label || a.id || "").trim(),
          connectSafelyAccountId: (a.connectSafelyAccountId || "").trim() || undefined,
          enabled: a.enabled !== false,
        }))
        .filter((a: AccountRow) => a.id);
      const payload = {
        ...settings,
        linkedinAccounts: cleanedAccounts,
        autoSendQualityFloor: Number(settings.autoSendQualityFloor ?? 7),
        linkedinDailyLimit: Number(settings.linkedinDailyLimit ?? 25),
        linkedinInmailDailyLimitPerAccount: Number(settings.linkedinInmailDailyLimitPerAccount ?? 5),
        updatedAt: new Date().toISOString(),
      };
      await setDoc(doc(db, "settings", "config"), payload, { merge: true });
      setDirty(false);
    } catch (e: any) {
      alert("Save failed: " + e.message);
    }
    setSaving(false);
  }

  async function testKey(which: "anthropic" | "connectsafely") {
    setTesting((p) => ({ ...p, [which]: true }));
    setKeyTests((p) => { const n = { ...p }; delete n[which]; return n; });
    try {
      const res: any = await api.testKeys();
      const map: Record<string, KeyTestResult> = {};
      if (res.anthropic) {
        map.anthropic = res.anthropic.configured
          ? { status: "ok", message: "API key configured (key not validated against Anthropic until first call)." }
          : { status: "missing", message: "Anthropic API key not set." };
      }
      if (res.connectSafely) {
        const r = res.connectSafely;
        map.connectsafely = r.valid
          ? { status: "ok", message: r.message || "API key valid" }
          : r.message?.toLowerCase().includes("not configured")
            ? { status: "missing", message: "ConnectSafely API key not set." }
            : { status: "invalid", message: r.message || "API key rejected" };
      }
      setKeyTests((p) => ({ ...p, ...map }));
    } catch (e: any) {
      setKeyTests((p) => ({ ...p, [which]: { status: "error", message: e.message } }));
    }
    setTesting((p) => ({ ...p, [which]: false }));
  }

  async function testAllKeys() {
    setTesting({ anthropic: true, connectsafely: true });
    setKeyTests({});
    await testKey("anthropic"); // single call returns both
    setTesting({});
  }

  async function runSeed() {
    if (!confirm("Seed default event metadata + ICP defaults (Labrador-derived). Existing keys, accounts, and mode are preserved.")) return;
    setSeeding(true); setSeedResult(null);
    try { setSeedResult(await api.seed()); }
    catch (e: any) { setSeedResult({ ok: false, error: e.message }); }
    setSeeding(false);
  }

  function toggleShow(field: string) { setShowKeys((p) => ({ ...p, [field]: !p[field] })); }
  function maskKey(key?: string) {
    if (!key) return "";
    if (key.length <= 8) return "••••••••";
    return key.slice(0, 4) + "•".repeat(Math.min(key.length - 8, 20)) + key.slice(-4);
  }
  function genAdminKey() {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    update("adminKey", Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join(""));
  }

  const accounts: AccountRow[] = settings.linkedinAccounts?.length
    ? settings.linkedinAccounts
    : [{ id: "personal", label: "Personal", enabled: true }];
  const isPaused = !!(settings.paused || settings.linkedinPaused);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <div className="flex items-center gap-3">
          <button onClick={testAllKeys}
            disabled={Object.values(testing).some(Boolean)}
            className="btn-ghost text-xs flex items-center gap-1.5">
            {Object.values(testing).some(Boolean)
              ? <Loader2 size={12} className="animate-spin" />
              : <RefreshCw size={12} />}
            Test All Keys
          </button>
          <button onClick={save} disabled={!dirty || saving}
            className={`btn-primary text-sm flex items-center gap-1.5 ${!dirty ? "opacity-50" : ""}`}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </div>

      {/* ─── System Mode ─── */}
      <Section title="System Mode" icon={<Shield size={16} />}>
        <div className="flex gap-3">
          <ModeButton label="Sandbox" desc="No sends — drafts only, no LinkedIn calls"
            active={settings.mode === "sandbox" || !settings.mode}
            onClick={() => update("mode", "sandbox")} color="amber" />
          <ModeButton label="Live" desc="Full processing — DMs / connects / InMails fire"
            active={settings.mode === "live"}
            onClick={() => update("mode", "live")} color="emerald" />
        </div>
        <div className="mt-3 p-3 rounded-lg bg-surface-900/50 border border-surface-800">
          <Toggle label="Global Pause (stop all activity)" value={!!settings.paused}
            onChange={(v) => update("paused", v)} />
          <p className="text-[10px] text-surface-600 mt-1 ml-11">
            When enabled, the cron skips every step (sourcing, personalize, send, follow-ups, reply poll). Auto-pause also flips this if ConnectSafely returns 429 or restriction errors.
          </p>
          {isPaused && settings.linkedinPauseReason && (
            <div className="ml-11 mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-[10px] text-red-400">Auto-paused reason: {settings.linkedinPauseReason}</p>
            </div>
          )}
        </div>
      </Section>

      {/* ─── API Keys ─── */}
      <Section title="API Keys" icon={<Key size={16} />}>
        <p className="text-xs text-surface-500 mb-4">
          Configure and test the keys the bot uses. The admin key authenticates calls to <code>/api/*</code> from this dashboard.
        </p>

        {/* Admin Key */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-1">
            <div>
              <label className="label text-[11px] mb-0">Admin Key</label>
              <p className="text-[10px] text-surface-600">Authenticates this dashboard's calls to the Cloud Functions. Generate once, then keep saved.</p>
            </div>
            <button onClick={genAdminKey} className="text-[11px] px-2.5 py-1 rounded-md bg-surface-800 hover:bg-surface-700 text-surface-300 flex items-center gap-1">
              <KeyRound size={10} /> Generate
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input className="input max-w-md text-sm font-mono"
              type={showKeys.adminKey ? "text" : "password"}
              value={settings.adminKey || ""}
              onChange={(e) => update("adminKey", e.target.value)}
              placeholder="Click Generate or paste a 32-char hex string" />
            <button onClick={() => toggleShow("adminKey")} className="text-surface-500 hover:text-surface-300 p-1">
              {showKeys.adminKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* Anthropic */}
        <KeyField
          label="Anthropic API Key"
          sublabel="Powers ICP qualification + personalized note / DM / InMail / email generation."
          value={settings.anthropicApiKey}
          onChange={(v) => update("anthropicApiKey", v)}
          show={!!showKeys.anthropicApiKey}
          onToggleShow={() => toggleShow("anthropicApiKey")}
          mask={maskKey}
          testResult={keyTests.anthropic}
          testing={!!testing.anthropic}
          onTest={() => testKey("anthropic")}
        />
        <div className="ml-4 mb-5">
          <label className="label text-[11px]">Model</label>
          <select className="input max-w-xs text-sm"
            value={settings.anthropicModel || "claude-sonnet-4-6"}
            onChange={(e) => update("anthropicModel", e.target.value)}>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (recommended)</option>
            <option value="claude-sonnet-4-5-20250929">Claude Sonnet 4.5 (Labrador's current)</option>
            <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (faster/cheaper)</option>
            <option value="claude-opus-4-5-20250929">Claude Opus 4.5 (premium)</option>
          </select>
        </div>

        {/* ConnectSafely */}
        <KeyField
          label="ConnectSafely API Key"
          sublabel="LinkedIn API — connect, DM, InMail, search, follower / group / post sourcing. Get from connectsafely.ai dashboard."
          value={settings.connectSafelyApiKey}
          onChange={(v) => update("connectSafelyApiKey", v)}
          show={!!showKeys.connectSafelyApiKey}
          onToggleShow={() => toggleShow("connectSafelyApiKey")}
          mask={maskKey}
          testResult={keyTests.connectsafely}
          testing={!!testing.connectsafely}
          onTest={() => testKey("connectsafely")}
        />

        {/* Seed defaults */}
        <div className="border-t border-surface-800 mt-4 pt-4">
          <p className="text-[10px] text-surface-500 font-semibold uppercase tracking-wider mb-2">First-Time Setup</p>
          <button onClick={runSeed} disabled={seeding}
            className="btn-secondary text-xs flex items-center gap-2">
            {seeding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Run /seed (load Labrador-derived event + ICP defaults)
          </button>
          <p className="text-[10px] text-surface-600 mt-2 max-w-md">
            Loads 38 job titles, 24 industries, 19 locations, 17 followerOf companies, and 30 excludeCompanies (parents + competitors + reference customers) from Labrador's existing AISDR config. Always overwrites event + icp; never touches API keys, accounts, or mode.
          </p>
          {seedResult && (
            <pre className="mt-3 max-w-md bg-surface-950/60 border border-surface-800 rounded-lg p-3 text-[11px] font-mono overflow-auto max-h-48">
              {JSON.stringify(seedResult, null, 2)}
            </pre>
          )}
        </div>
      </Section>

      {/* ─── LinkedIn Accounts ─── */}
      <Section title="LinkedIn Accounts" icon={<Linkedin size={16} />}>
        <p className="text-xs text-surface-500 mb-3">
          Each row = one ConnectSafely-linked LinkedIn seat. Multiple accounts → load distributes across them. <code>connectSafelyAccountId</code> is optional for single-seat use.
        </p>
        <div className="space-y-2">
          {accounts.map((a, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1.3fr_auto_auto] gap-2 items-center bg-surface-950/40 border border-surface-800 rounded-lg p-2">
              <input className="input !py-1.5 text-xs" placeholder="id (e.g. personal)"
                value={a.id || ""} onChange={(e) => updateAccount(i, { id: e.target.value })} />
              <input className="input !py-1.5 text-xs" placeholder="label"
                value={a.label || ""} onChange={(e) => updateAccount(i, { label: e.target.value })} />
              <input className="input !py-1.5 text-xs font-mono" placeholder="connectSafelyAccountId (optional)"
                value={a.connectSafelyAccountId || ""} onChange={(e) => updateAccount(i, { connectSafelyAccountId: e.target.value })} />
              <Toggle label="" value={a.enabled !== false} onChange={(v) => updateAccount(i, { enabled: v })} />
              <button onClick={() => removeAccount(i)} className="text-red-400 hover:text-red-300 p-1">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <button onClick={addAccount} className="btn-secondary text-xs flex items-center gap-1.5 mt-3">
          <Plus size={12} /> Add account
        </button>
      </Section>

      {/* ─── Send Limits & Quality ─── */}
      <Section title="Send Limits & Quality" icon={<Brain size={16} />}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Field label="DM daily limit / account" type="number"
              value={settings.linkedinDailyLimit ?? 25}
              onChange={(v) => update("linkedinDailyLimit", parseInt(v) || 25)} />
            <p className="text-[10px] text-surface-600 -mt-1 mb-3">Per-account DM ceiling. Warm-up ramp + weekend reduction apply on top.</p>
          </div>
          <div>
            <Field label="InMail daily limit / account" type="number"
              value={settings.linkedinInmailDailyLimitPerAccount ?? 5}
              onChange={(v) => update("linkedinInmailDailyLimitPerAccount", parseInt(v) || 5)} />
            <p className="text-[10px] text-surface-600 -mt-1 mb-3">Atomic Firestore reservation. Default 5 matches LinkedIn Sales Nav credit refresh.</p>
          </div>
          <div>
            <Field label="Connect weekly limit" type="number"
              value={settings.linkedinConnectWeeklyLimit ?? 90}
              onChange={(v) => update("linkedinConnectWeeklyLimit", parseInt(v) || 90)} />
            <p className="text-[10px] text-surface-600 -mt-1 mb-3">LinkedIn-enforced weekly cap. ~13/day with cushion.</p>
          </div>
          <div>
            <Field label="Quality floor (0–10)" type="number"
              value={settings.autoSendQualityFloor ?? 7}
              onChange={(v) => update("autoSendQualityFloor", Math.max(0, Math.min(10, parseInt(v) || 7)))} />
            <p className="text-[10px] text-surface-600 -mt-1 mb-3">Anthropic scores each draft. Below this = rejected, never sent.</p>
          </div>
        </div>
      </Section>

      {/* ─── Sender Identity ─── */}
      <Section title="Sender Identity" icon={<Settings size={16} />}>
        <Field label="Sender first name" value={settings.senderName || ""}
          onChange={(v) => update("senderName", v)} placeholder="Roger" />
        <p className="text-[10px] text-surface-600 -mt-2 mb-3">
          Used in personalized DM signatures. Matches Labrador's existing config by default.
        </p>
      </Section>

      {/* Bottom save bar */}
      {dirty && (
        <div className="fixed bottom-0 left-0 right-0 bg-surface-900/95 border-t border-surface-700 p-3 flex justify-end z-50">
          <button onClick={save} disabled={saving}
            className="btn-primary flex items-center gap-2">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save Changes
          </button>
        </div>
      )}
    </div>
  );
}


// ── Sub-components (lifted from AISDR SettingsPage) ─────────

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass rounded-xl p-5 mb-4">
      <h2 className="text-sm font-medium flex items-center gap-2 mb-4 text-surface-300">
        {icon} {title}
      </h2>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type }: {
  label: string; value: any; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="mb-3">
      <label className="label text-[11px]">{label}</label>
      <input className="input max-w-md text-sm"
        type={type || "text"}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} />
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm">
      <div className={`w-9 h-5 rounded-full p-0.5 transition ${value ? "bg-brand-500" : "bg-surface-700"}`}
        onClick={() => onChange(!value)}>
        <div className={`w-4 h-4 rounded-full bg-white transition-transform ${value ? "translate-x-4" : ""}`} />
      </div>
      {label && <span className="text-surface-400">{label}</span>}
    </label>
  );
}

function ModeButton({ label, desc, active, onClick, color }: {
  label: string; desc: string; active: boolean; onClick: () => void; color: string;
}) {
  const colors: Record<string, string> = {
    amber: active ? "border-amber-500/50 bg-amber-500/10 text-amber-400" : "border-surface-700 text-surface-500",
    emerald: active ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-400" : "border-surface-700 text-surface-500",
  };
  const Icon = color === "amber" ? FlaskConical : Radio;
  return (
    <button onClick={onClick}
      className={`flex-1 p-4 rounded-lg border transition text-left ${colors[color]}`}>
      <div className="flex items-center gap-2 font-medium text-sm"><Icon size={14} /> {label}</div>
      <div className="text-[11px] opacity-70 mt-1">{desc}</div>
    </button>
  );
}

function KeyField({ label, sublabel, value, onChange, show, onToggleShow, testResult, testing, onTest }: {
  label: string;
  sublabel: string;
  value: string | undefined;
  onChange: (v: string) => void;
  show: boolean;
  onToggleShow: () => void;
  mask: (k: string | undefined) => string;
  testResult?: KeyTestResult;
  testing: boolean;
  onTest: () => void;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-1">
        <div>
          <label className="label text-[11px] mb-0">{label}</label>
          <p className="text-[10px] text-surface-600">{sublabel}</p>
        </div>
        <button onClick={onTest} disabled={testing || !value}
          className={`text-[11px] px-2.5 py-1 rounded-md transition flex items-center gap-1 ${
            !value ? "opacity-30 cursor-not-allowed bg-surface-800 text-surface-600"
            : testing ? "bg-surface-800 text-surface-400"
            : "bg-surface-800 hover:bg-surface-700 text-surface-300"
          }`}>
          {testing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          Test
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input className="input max-w-md text-sm font-mono"
          type={show ? "text" : "password"}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter API key..." />
        <button onClick={onToggleShow} className="text-surface-500 hover:text-surface-300 p-1">
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {testResult && (
        <div className={`mt-2 flex items-start gap-2 text-xs p-2.5 rounded-lg ${
          testResult.status === "ok"      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
          testResult.status === "missing" ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" :
                                            "bg-red-500/10 text-red-400 border border-red-500/20"
        }`}>
          {testResult.status === "ok"      ? <CheckCircle size={14} className="shrink-0 mt-0.5" /> :
           testResult.status === "missing" ? <AlertTriangle size={14} className="shrink-0 mt-0.5" /> :
                                             <XCircle size={14} className="shrink-0 mt-0.5" />}
          <span>{testResult.message}</span>
        </div>
      )}
    </div>
  );
}
