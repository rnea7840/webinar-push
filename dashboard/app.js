// Webinar Push — Admin Dashboard
//
// Single-page admin: signs in with Google, reads/writes settings/config
// via Firestore client SDK, calls Cloud Functions through Hosting
// rewrites at /api/*. No build step — all imports come from the
// Firebase v10 modular SDK on gstatic.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, query, where, orderBy,
  limit, getDocs, getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// ── Firebase config (matches the user's webinarpush project) ─────
const firebaseConfig = {
  apiKey: "AIzaSyA8-ysxPXqsyAdiH6wx2H9TDDwLfqpGtCg",
  authDomain: "webinarpush.firebaseapp.com",
  projectId: "webinarpush",
  storageBucket: "webinarpush.firebasestorage.app",
  messagingSenderId: "658740769677",
  appId: "1:658740769677:web:6c43f25d7789c042f283c4",
  measurementId: "G-M7C9L002XP",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ── DOM helpers ───────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }

function flash(target, ok, msg) {
  const el = $(target);
  el.textContent = (ok ? "OK · " : "ERR · ") + msg;
  el.classList.toggle("text-emerald-400", ok);
  el.classList.toggle("text-red-400", !ok);
}

function linesToArray(s) {
  return (s || "").split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
}
function arrayToLines(a) { return (a || []).join("\n"); }

// ── Auth flow ─────────────────────────────────────────────────────
$("#signin-btn").addEventListener("click", async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    const err = $("#auth-error");
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
});

$("#signout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    show("#auth-screen"); hide("#app"); return;
  }
  hide("#auth-screen"); show("#app");
  $("#user-email").textContent = user.email || "";
  await loadSettings();
  setActiveTab("settings");
});

// ── Tabs ──────────────────────────────────────────────────────────
function setActiveTab(name) {
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
  if (name === "stats") refreshStats();
}
$$(".tab-btn").forEach((b) => b.addEventListener("click", () => setActiveTab(b.dataset.tab)));

// ── Settings load/save ────────────────────────────────────────────
const SETTINGS_REF = doc(db, "settings", "config");

async function loadSettings() {
  const snap = await getDoc(SETTINGS_REF);
  const data = snap.exists() ? snap.data() : {};

  // Keys
  $("#adminKey").value = data.adminKey || "";
  $("#anthropicApiKey").value = data.anthropicApiKey || "";
  $("#anthropicModel").value = data.anthropicModel || "claude-sonnet-4-6";
  $("#connectSafelyApiKey").value = data.connectSafelyApiKey || "";

  // Mode + limits
  $("#mode").value = data.mode || "sandbox";
  $("#autoSendQualityFloor").value = data.autoSendQualityFloor ?? 7;
  $("#linkedinDailyLimit").value = data.linkedinDailyLimit ?? 25;
  $("#linkedinInmailDailyLimitPerAccount").value = data.linkedinInmailDailyLimitPerAccount ?? 5;

  // Mode + paused badges
  const mb = $("#mode-badge");
  mb.textContent = (data.mode || "sandbox").toUpperCase();
  mb.classList.remove("sandbox", "live");
  mb.classList.add(data.mode === "live" ? "live" : "sandbox");
  $("#paused-badge").classList.toggle("hidden", !(data.paused || data.linkedinPaused));

  // LinkedIn accounts
  renderAccounts(data.linkedinAccounts || []);

  // Event
  const ev = data.event || {};
  $("#event-title").textContent = ev.title ? `· ${ev.title}` : "";
  $("#event-title-input").value = ev.title || "";
  $("#event-host").value = ev.host || "";
  $("#event-channel").value = ev.channel || "";
  $("#event-linkedinUrl").value = ev.linkedinEventUrl || "";
  $("#event-registrationUrl").value = ev.registrationUrl || "";
  $("#event-startsAt").value = ev.startsAt || "";
  $("#event-duration").value = ev.durationMinutes || 60;
  $("#event-description").value = ev.description || "";

  // ICP
  const icp = data.icp || {};
  $("#icp-jobTitles").value = arrayToLines(icp.jobTitles);
  $("#icp-industries").value = arrayToLines(icp.industries);
  $("#icp-locations").value = arrayToLines(icp.locations);
  $("#icp-excludeCompanies").value = arrayToLines(icp.excludeCompanies);
  $("#icp-followerOf").value = arrayToLines(icp.followerOf);
  $("#icp-linkedinGroups").value = arrayToLines(icp.linkedinGroups);
  $("#icp-targetPosts").value = arrayToLines(icp.targetPosts);
  $("#icp-premiumOnly").value = String(icp.premiumOnly === true);
  const degs = icp.connectionDegree || ["1st", "2nd", "3rd+"];
  $$("#icp-degrees input[type=checkbox]").forEach((cb) => { cb.checked = degs.includes(cb.value); });
}

// ── Account row rendering ─────────────────────────────────────────
function renderAccounts(accounts) {
  const list = $("#accounts-list");
  list.innerHTML = "";
  accounts.forEach((a, i) => list.appendChild(accountRow(a, i)));
  if (accounts.length === 0) {
    list.appendChild(accountRow({ id: "personal", enabled: true, label: "Personal" }, 0));
  }
}

function accountRow(a, i) {
  const row = document.createElement("div");
  row.className = "account-row";
  row.dataset.idx = i;
  row.innerHTML = `
    <input type="text" data-field="id" placeholder="id (e.g. personal)" value="${a.id ?? ""}" />
    <input type="text" data-field="label" placeholder="label" value="${a.label ?? ""}" />
    <input type="text" data-field="connectSafelyAccountId" placeholder="connectSafelyAccountId (optional)" value="${a.connectSafelyAccountId ?? ""}" />
    <label class="text-xs flex items-center gap-1">
      <input type="checkbox" data-field="enabled" ${a.enabled !== false ? "checked" : ""} /> enabled
    </label>
    <button type="button" class="text-xs text-red-400 hover:text-red-300 px-2">×</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  return row;
}

$("#add-account").addEventListener("click", () => {
  $("#accounts-list").appendChild(accountRow({ id: "", enabled: true, label: "" }, Date.now()));
});

function readAccounts() {
  return [...$$("#accounts-list .account-row")].map((row) => {
    const f = (k) => row.querySelector(`[data-field="${k}"]`);
    const id = f("id").value.trim();
    if (!id) return null;
    return {
      id,
      label: f("label").value.trim() || id,
      connectSafelyAccountId: f("connectSafelyAccountId").value.trim() || undefined,
      enabled: f("enabled").checked,
    };
  }).filter(Boolean);
}

// ── Save handlers ─────────────────────────────────────────────────
$("#adminKey-show").addEventListener("click", () => {
  const i = $("#adminKey");
  i.type = i.type === "password" ? "text" : "password";
});
$("#adminKey-gen").addEventListener("click", () => {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  $("#adminKey").value = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
});

$("#save-settings").addEventListener("click", async () => {
  try {
    const accounts = readAccounts();
    const update = {
      adminKey: $("#adminKey").value || cryptoRand(32),
      anthropicApiKey: $("#anthropicApiKey").value,
      anthropicModel: $("#anthropicModel").value || "claude-sonnet-4-6",
      connectSafelyApiKey: $("#connectSafelyApiKey").value,
      mode: $("#mode").value,
      autoSendQualityFloor: Number($("#autoSendQualityFloor").value),
      linkedinDailyLimit: Number($("#linkedinDailyLimit").value),
      linkedinInmailDailyLimitPerAccount: Number($("#linkedinInmailDailyLimitPerAccount").value),
      linkedinAccounts: accounts,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(SETTINGS_REF, update, { merge: true });
    flash("#settings-output", true, "Settings saved.");
    await loadSettings();
  } catch (e) { flash("#settings-output", false, e.message); }
});

$("#save-icp").addEventListener("click", async () => {
  try {
    const event = {
      title: $("#event-title-input").value,
      host: $("#event-host").value,
      channel: $("#event-channel").value,
      linkedinEventUrl: $("#event-linkedinUrl").value,
      registrationUrl: $("#event-registrationUrl").value,
      linkedinEventId: extractEventId($("#event-linkedinUrl").value),
      startsAt: $("#event-startsAt").value,
      durationMinutes: Number($("#event-duration").value) || 60,
      online: true,
      description: $("#event-description").value,
    };
    const degs = [...$$("#icp-degrees input[type=checkbox]")]
      .filter((cb) => cb.checked).map((cb) => cb.value);
    const icp = {
      jobTitles: linesToArray($("#icp-jobTitles").value),
      industries: linesToArray($("#icp-industries").value),
      locations: linesToArray($("#icp-locations").value),
      excludeCompanies: linesToArray($("#icp-excludeCompanies").value),
      followerOf: linesToArray($("#icp-followerOf").value),
      linkedinGroups: linesToArray($("#icp-linkedinGroups").value),
      targetPosts: linesToArray($("#icp-targetPosts").value),
      connectionDegree: degs.length ? degs : ["1st", "2nd", "3rd+"],
      premiumOnly: $("#icp-premiumOnly").value === "true",
      minQualityScore: 7,
    };
    await setDoc(SETTINGS_REF, { event, icp, updatedAt: new Date().toISOString() }, { merge: true });
    flash("#icp-output", true, "Event + ICP saved.");
  } catch (e) { flash("#icp-output", false, e.message); }
});

function extractEventId(url) {
  const m = (url || "").match(/events\/(\d+)/);
  return m ? m[1] : "";
}

function cryptoRand(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Calling the Cloud Functions through Hosting rewrites ──────────
async function callApi(path, body) {
  const adminKey = $("#adminKey").value;
  if (!adminKey) throw new Error("Admin key not set. Save settings first.");
  const opts = {
    method: "POST",
    headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// Pause / Resume / Test / Seed
$("#test-keys").addEventListener("click", async () => {
  flash("#settings-output", true, "Testing keys...");
  try { const d = await callApi("testKeys"); $("#settings-output").textContent = JSON.stringify(d, null, 2); }
  catch (e) { flash("#settings-output", false, e.message); }
});
$("#seed-btn").addEventListener("click", async () => {
  if (!confirm("Seed default event + ICP into settings/config? Existing values are preserved (idempotent).")) return;
  try {
    const d = await callApi("seed");
    $("#settings-output").textContent = JSON.stringify(d, null, 2);
    await loadSettings();
  } catch (e) { flash("#settings-output", false, e.message); }
});
$("#pause-btn").addEventListener("click", async () => {
  try { const d = await callApi("pause"); flash("#settings-output", true, "Paused. " + JSON.stringify(d)); await loadSettings(); }
  catch (e) { flash("#settings-output", false, e.message); }
});
$("#resume-btn").addEventListener("click", async () => {
  try { const d = await callApi("resume"); flash("#settings-output", true, "Resumed. " + JSON.stringify(d)); await loadSettings(); }
  catch (e) { flash("#settings-output", false, e.message); }
});

// ── Run tab actions ───────────────────────────────────────────────
$$(".action-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    let body;
    if (action === "source") body = { perFeedCap: Number($("#source-cap").value) || 200 };
    if (action === "personalize") body = { batchSize: Number($("#personalize-size").value) || 50 };
    if (action === "sendNow") body = { batchSize: Number($("#sendnow-size").value) || 30 };

    const out = $("#run-output");
    out.textContent = `Running /${action}...`;
    btn.disabled = true;
    try {
      const d = await callApi(action, body);
      out.textContent = `[${new Date().toLocaleTimeString()}] /${action}\n` + JSON.stringify(d, null, 2);
    } catch (e) { out.textContent = `[${new Date().toLocaleTimeString()}] /${action} FAILED\n${e.message}`; }
    finally { btn.disabled = false; }
  });
});

// ── Stats ─────────────────────────────────────────────────────────
const STATUSES = [
  "sourced", "qualified", "drafted", "queued", "sent",
  "follow_up_1", "follow_up_2", "follow_up_3",
  "replied", "registered", "rejected", "errored",
];

async function refreshStats() {
  // Pull /stats for capacity + counts
  try {
    const d = await callApi("stats");
    $("#cap-dm").textContent = d.capacityRemainingToday?.dm ?? "—";
    $("#cap-connect").textContent = d.capacityRemainingToday?.connect ?? "—";
    $("#cap-inmail").textContent = d.capacityRemainingToday?.inmail ?? "—";
    $("#cap-total").textContent = d.capacityRemainingToday?.total ?? "—";

    const grid = $("#status-grid");
    grid.innerHTML = "";
    for (const s of STATUSES) {
      const n = d.counts?.[s] ?? 0;
      const cell = document.createElement("div");
      cell.className = "bg-slate-950 border border-slate-800 rounded p-3 flex items-center justify-between";
      cell.innerHTML = `<span class="text-xs text-slate-400">${s}</span><span class="font-semibold">${n}</span>`;
      grid.appendChild(cell);
    }
  } catch (e) {
    $("#status-grid").innerHTML = `<div class="col-span-4 text-red-400 text-xs">${e.message}</div>`;
  }

  // Recent activity_log entries
  try {
    const q = query(collection(db, "activity_log"), orderBy("timestamp", "desc"), limit(40));
    const snap = await getDocs(q);
    const log = $("#activity-log");
    log.innerHTML = "";
    snap.forEach((doc) => {
      const d = doc.data();
      const ts = d.timestamp?.toDate ? d.timestamp.toDate().toLocaleString() : "—";
      const row = document.createElement("div");
      row.className = "activity-row";
      row.innerHTML = `<span class="ts">${ts}</span><span class="type">${d.type}</span><span>${escapeHtml(d.message || "")}</span>`;
      log.appendChild(row);
    });
    if (snap.empty) log.innerHTML = '<div class="text-slate-500">No activity yet.</div>';
  } catch (e) {
    $("#activity-log").innerHTML = `<div class="text-red-400">${e.message}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

$("#refresh-stats").addEventListener("click", refreshStats);
