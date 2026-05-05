// Sources — event metadata + ICP filter + the four sourcing feeds.
import { useEffect, useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import { db } from "../firebase";
import { useSettings } from "../hooks/useFirestore";
import { Save, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

function lines(s: string): string[] {
  return (s || "").split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
}
function joined(a: string[] | undefined): string { return (a || []).join("\n"); }
function eventIdFromUrl(u: string): string {
  const m = (u || "").match(/events\/(\d+)/);
  return m ? m[1] : "";
}

export default function Sources() {
  const { data: settings } = useSettings();
  const [saved, setSaved] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const [error, setError] = useState("");

  // Event
  const [title, setTitle] = useState("");
  const [host, setHost] = useState("");
  const [channel, setChannel] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [registrationUrl, setRegistrationUrl] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [duration, setDuration] = useState(60);
  const [description, setDescription] = useState("");

  // ICP
  const [jobTitles, setJobTitles] = useState("");
  const [industries, setIndustries] = useState("");
  const [locations, setLocations] = useState("");
  const [excludeCompanies, setExcludeCompanies] = useState("");
  const [followerOf, setFollowerOf] = useState("");
  const [linkedinGroups, setLinkedinGroups] = useState("");
  const [targetPosts, setTargetPosts] = useState("");
  const [degrees, setDegrees] = useState<string[]>(["1st", "2nd", "3rd+"]);
  const [premiumOnly, setPremiumOnly] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const ev = settings.event || {};
    setTitle(ev.title || "");
    setHost(ev.host || "");
    setChannel(ev.channel || "");
    setLinkedinUrl(ev.linkedinEventUrl || "");
    setRegistrationUrl(ev.registrationUrl || "");
    setStartsAt(ev.startsAt || "");
    setDuration(ev.durationMinutes || 60);
    setDescription(ev.description || "");

    const icp = settings.icp || {};
    setJobTitles(joined(icp.jobTitles));
    setIndustries(joined(icp.industries));
    setLocations(joined(icp.locations));
    setExcludeCompanies(joined(icp.excludeCompanies));
    setFollowerOf(joined(icp.followerOf));
    setLinkedinGroups(joined(icp.linkedinGroups));
    setTargetPosts(joined(icp.targetPosts));
    setDegrees(icp.connectionDegree?.length ? icp.connectionDegree : ["1st", "2nd", "3rd+"]);
    setPremiumOnly(!!icp.premiumOnly);
  }, [settings]);

  async function save() {
    setSaved("saving"); setError("");
    try {
      const event = {
        title, host, channel,
        linkedinEventUrl: linkedinUrl,
        linkedinEventId: eventIdFromUrl(linkedinUrl),
        registrationUrl,
        startsAt,
        durationMinutes: Number(duration) || 60,
        online: true,
        description,
      };
      const icp = {
        jobTitles: lines(jobTitles),
        industries: lines(industries),
        locations: lines(locations),
        excludeCompanies: lines(excludeCompanies),
        followerOf: lines(followerOf),
        linkedinGroups: lines(linkedinGroups),
        targetPosts: lines(targetPosts),
        connectionDegree: degrees,
        premiumOnly,
        minQualityScore: settings?.icp?.minQualityScore ?? 7,
      };
      await setDoc(doc(db, "settings", "config"),
        { event, icp, updatedAt: new Date().toISOString() }, { merge: true });
      setSaved("ok");
      setTimeout(() => setSaved("idle"), 2500);
    } catch (e: any) {
      setSaved("err"); setError(e.message);
    }
  }

  function toggleDegree(d: string) {
    setDegrees((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sources & ICP</h1>
          <p className="text-sm text-surface-500 mt-1">Event metadata, ICP filters, and the four sourcing feeds.</p>
        </div>
        <button onClick={save} disabled={saved === "saving"} className="btn-primary flex items-center gap-2">
          {saved === "saving" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
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

      {/* Event */}
      <div className="glass rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Event</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><label className="label">Title</label><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><label className="label">Host</label><input className="input" value={host} onChange={(e) => setHost(e.target.value)} /></div>
          <div><label className="label">Channel partner</label><input className="input" value={channel} onChange={(e) => setChannel(e.target.value)} /></div>
          <div className="col-span-2"><label className="label">LinkedIn event URL</label><input className="input font-mono text-xs" value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} placeholder="https://www.linkedin.com/events/..." /></div>
          <div className="col-span-2"><label className="label">Registration URL</label><input className="input font-mono text-xs" value={registrationUrl} onChange={(e) => setRegistrationUrl(e.target.value)} /></div>
          <div><label className="label">Starts at (ISO 8601 UTC)</label><input className="input font-mono text-xs" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} placeholder="2026-05-12T14:00:00Z" /></div>
          <div><label className="label">Duration (minutes)</label><input type="number" className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))} /></div>
          <div className="col-span-2"><label className="label">Description blurb</label><textarea className="textarea !min-h-[64px]" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
      </div>

      {/* ICP */}
      <div className="glass rounded-xl p-5 space-y-4">
        <div>
          <h2 className="font-semibold">ICP filter</h2>
          <p className="text-xs text-surface-500 mt-1">All four feeds use these. One item per line.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2"><label className="label">Job titles</label><textarea className="textarea" value={jobTitles} onChange={(e) => setJobTitles(e.target.value)} placeholder={"AppSec Engineer\nDevSecOps\nSecurity Architect\nCISO"} /></div>
          <div><label className="label">Industries</label><textarea className="textarea" value={industries} onChange={(e) => setIndustries(e.target.value)} /></div>
          <div><label className="label">Locations</label><textarea className="textarea" value={locations} onChange={(e) => setLocations(e.target.value)} /></div>
          <div className="col-span-2">
            <label className="label flex items-center gap-2">Exclude companies <span className="text-red-400 text-xs font-normal">(competitors — never message employees)</span></label>
            <textarea className="textarea" value={excludeCompanies} onChange={(e) => setExcludeCompanies(e.target.value)} />
          </div>
          <div>
            <label className="label">Connection degrees</label>
            <div className="flex gap-2 mt-1">
              {["1st", "2nd", "3rd+"].map((d) => (
                <button type="button" key={d} onClick={() => toggleDegree(d)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                    degrees.includes(d)
                      ? "bg-brand-600/15 border-brand-600/40 text-brand-300"
                      : "bg-surface-900 border-surface-800 text-surface-400"
                  }`}>{d}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Premium only</label>
            <select className="input" value={String(premiumOnly)} onChange={(e) => setPremiumOnly(e.target.value === "true")}>
              <option value="false">No</option>
              <option value="true">Yes (Sales Nav users only)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Feeds */}
      <div className="glass rounded-xl p-5 space-y-4">
        <div>
          <h2 className="font-semibold">Sourcing feeds</h2>
          <p className="text-xs text-surface-500 mt-1">Three handles in addition to the keyword search above.</p>
        </div>
        <div>
          <label className="label">Company pages — pull their followers</label>
          <textarea className="textarea" value={followerOf} onChange={(e) => setFollowerOf(e.target.value)}
            placeholder={"snyk\nveracode\nanchore\nblackducksoftware"} />
        </div>
        <div>
          <label className="label">LinkedIn groups — pull members (full URL preferred)</label>
          <textarea className="textarea" value={linkedinGroups} onChange={(e) => setLinkedinGroups(e.target.value)}
            placeholder={"https://www.linkedin.com/groups/3961304/\nhttps://www.linkedin.com/groups/8284953/"} />
        </div>
        <div>
          <label className="label">Target posts — pull commenters + reactors (post URLs)</label>
          <textarea className="textarea" value={targetPosts} onChange={(e) => setTargetPosts(e.target.value)}
            placeholder={"https://www.linkedin.com/posts/<author>_<slug>-activity-..."} />
        </div>
      </div>
    </div>
  );
}
