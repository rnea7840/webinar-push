// Settings — API keys, LinkedIn accounts, mode, limits.
import { useEffect, useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useSettings } from "../hooks/useFirestore";
import { api } from "../services/api";
import {
  Save, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff,
  Trash2, Plus, FlaskConical, Radio, KeyRound,
} from "lucide-react";

export default function SettingsPage() {
  const { data: settings } = useSettings();
  const [adminKey, setAdminKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [anthropicModel, setAnthropicModel] = useState("claude-sonnet-4-6");
  const [connectSafelyApiKey, setConnectSafelyApiKey] = useState("");
  const [mode, setMode] = useState<"sandbox" | "live">("sandbox");
  const [autoSendQualityFloor, setAutoSendQualityFloor] = useState(7);
  const [linkedinDailyLimit, setLinkedinDailyLimit] = useState(25);
  const [linkedinInmailDailyLimitPerAccount, setLinkedinInmailDailyLimitPerAccount] = useState(5);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [show, setShow] = useState({ admin: false, anthropic: false, cs: false });
  const [saved, setSaved] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [error, setError] = useState("");
  const [keyTest, setKeyTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setAdminKey(settings.adminKey || "");
    setAnthropicApiKey(settings.anthropicApiKey || "");
    setAnthropicModel(settings.anthropicModel || "claude-sonnet-4-6");
    setConnectSafelyApiKey(settings.connectSafelyApiKey || "");
    setMode((settings.mode as any) || "sandbox");
    setAutoSendQualityFloor(settings.autoSendQualityFloor ?? 7);
    setLinkedinDailyLimit(settings.linkedinDailyLimit ?? 25);
    setLinkedinInmailDailyLimitPerAccount(settings.linkedinInmailDailyLimitPerAccount ?? 5);
    setAccounts(settings.linkedinAccounts?.length
      ? settings.linkedinAccounts
      : [{ id: "personal", label: "Personal", enabled: true }]);
  }, [settings]);

  function genKey() {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    setAdminKey(Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join(""));
  }

  async function save() {
    setSaved("saving"); setError("");
    try {
      const cleanAccounts = accounts
        .map((a) => ({
          id: (a.id || "").trim(),
          label: (a.label || a.id || "").trim(),
          connectSafelyAccountId: (a.connectSafelyAccountId || "").trim() || undefined,
          enabled: a.enabled !== false,
        }))
        .filter((a) => a.id);

      await setDoc(doc(db, "settings", "config"), {
        adminKey: adminKey || undefined,
        anthropicApiKey, anthropicModel, connectSafelyApiKey,
        mode, autoSendQualityFloor: Number(autoSendQualityFloor),
        linkedinDailyLimit: Number(linkedinDailyLimit),
        linkedinInmailDailyLimitPerAccount: Number(linkedinInmailDailyLimitPerAccount),
        linkedinAccounts: cleanAccounts,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      setSaved("ok");
      setTimeout(() => setSaved("idle"), 2500);
    } catch (e: any) { setSaved("err"); setError(e.message); }
  }

  async function testKeys() {
    setTesting(true); setKeyTest(null);
    try { setKeyTest(await api.testKeys()); }
    catch (e: any) { setKeyTest({ error: e.message }); }
    setTesting(false);
  }

  async function runSeed() {
    if (!confirm("Seed the default event + ICP into settings/config? Existing fields are preserved.")) return;
    setSeeding(true);
    try { await api.seed(); }
    catch (e: any) { setError(e.message); }
    setSeeding(false);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-surface-500 mt-1">API keys, LinkedIn accounts, send mode, and daily limits.</p>
        </div>
        <button onClick={save} disabled={saved === "saving"} className="btn-primary flex items-center gap-2">
          {saved === "saving" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save settings
        </button>
      </div>

      {saved === "ok" && (
        <div className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-sm text-emerald-400">
          <CheckCircle2 size={14} /> Saved.
        </div>
      )}
      {saved === "err" && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* API keys */}
      <div className="glass rounded-xl p-5 space-y-4">
        <h2 className="font-semibold flex items-center gap-2"><KeyRound size={14} /> API keys</h2>
        <div className="grid gap-4">
          <div>
            <label className="label">Admin key <span className="text-surface-500 text-xs font-normal">(authenticates calls to /api/*)</span></label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input type={show.admin ? "text" : "password"} className="input pr-10 font-mono" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
                <button type="button" onClick={() => setShow({ ...show, admin: !show.admin })} className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 p-1">
                  {show.admin ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button type="button" className="btn-secondary" onClick={genKey}>Generate</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Anthropic API key</label>
              <div className="relative">
                <input type={show.anthropic ? "text" : "password"} className="input pr-10 font-mono" value={anthropicApiKey} onChange={(e) => setAnthropicApiKey(e.target.value)} placeholder="sk-ant-..." />
                <button type="button" onClick={() => setShow({ ...show, anthropic: !show.anthropic })} className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 p-1">
                  {show.anthropic ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <label className="label">Anthropic model</label>
              <input className="input font-mono" value={anthropicModel} onChange={(e) => setAnthropicModel(e.target.value)} placeholder="claude-sonnet-4-6" />
            </div>
          </div>
          <div>
            <label className="label">ConnectSafely API key</label>
            <div className="relative">
              <input type={show.cs ? "text" : "password"} className="input pr-10 font-mono" value={connectSafelyApiKey} onChange={(e) => setConnectSafelyApiKey(e.target.value)} />
              <button type="button" onClick={() => setShow({ ...show, cs: !show.cs })} className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 p-1">
                {show.cs ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={testKeys} disabled={testing} className="btn-secondary flex items-center gap-2">
            {testing ? <Loader2 size={14} className="animate-spin" /> : null} Test keys
          </button>
          <button onClick={runSeed} disabled={seeding} className="btn-secondary flex items-center gap-2">
            {seeding ? <Loader2 size={14} className="animate-spin" /> : null} Run /seed (first-time only)
          </button>
        </div>
        {keyTest && (
          <pre className="bg-surface-950/60 border border-surface-800 rounded-lg p-3 text-xs font-mono overflow-auto max-h-40">
            {JSON.stringify(keyTest, null, 2)}
          </pre>
        )}
      </div>

      {/* LinkedIn accounts */}
      <div className="glass rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">LinkedIn accounts</h2>
          <button className="btn-secondary flex items-center gap-2 text-xs"
            onClick={() => setAccounts([...accounts, { id: "", label: "", enabled: true }])}>
            <Plus size={12} /> Add
          </button>
        </div>
        <div className="space-y-2">
          {accounts.map((a, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto_auto] gap-2 items-center bg-surface-950/40 border border-surface-800 rounded-lg p-2">
              <input className="input !py-1.5 text-xs" placeholder="id (e.g. personal)" value={a.id || ""}
                onChange={(e) => { const c = [...accounts]; c[i] = { ...c[i], id: e.target.value }; setAccounts(c); }} />
              <input className="input !py-1.5 text-xs" placeholder="label" value={a.label || ""}
                onChange={(e) => { const c = [...accounts]; c[i] = { ...c[i], label: e.target.value }; setAccounts(c); }} />
              <input className="input !py-1.5 text-xs" placeholder="connectSafelyAccountId (optional)" value={a.connectSafelyAccountId || ""}
                onChange={(e) => { const c = [...accounts]; c[i] = { ...c[i], connectSafelyAccountId: e.target.value }; setAccounts(c); }} />
              <label className="flex items-center gap-1 text-xs text-surface-400">
                <input type="checkbox" checked={a.enabled !== false}
                  onChange={(e) => { const c = [...accounts]; c[i] = { ...c[i], enabled: e.target.checked }; setAccounts(c); }} />
                enabled
              </label>
              <button onClick={() => setAccounts(accounts.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-300 p-1">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Mode + limits */}
      <div className="glass rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Mode &amp; daily limits</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Mode</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setMode("sandbox")}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm border transition ${
                  mode === "sandbox" ? "bg-amber-500/10 border-amber-500/30 text-amber-400" : "bg-surface-800 border-surface-700 text-surface-400"
                }`}>
                <FlaskConical size={14} /> Sandbox
              </button>
              <button type="button" onClick={() => setMode("live")}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm border transition ${
                  mode === "live" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-surface-800 border-surface-700 text-surface-400"
                }`}>
                <Radio size={14} /> Live
              </button>
            </div>
          </div>
          <div>
            <label className="label">Quality floor (0–10)</label>
            <input type="number" min={0} max={10} className="input" value={autoSendQualityFloor} onChange={(e) => setAutoSendQualityFloor(Number(e.target.value))} />
          </div>
          <div>
            <label className="label">DM daily limit / account</label>
            <input type="number" className="input" value={linkedinDailyLimit} onChange={(e) => setLinkedinDailyLimit(Number(e.target.value))} />
          </div>
          <div>
            <label className="label">InMail daily limit / account</label>
            <input type="number" className="input" value={linkedinInmailDailyLimitPerAccount} onChange={(e) => setLinkedinInmailDailyLimitPerAccount(Number(e.target.value))} />
          </div>
        </div>
      </div>
    </div>
  );
}
