/* OPD Roster — data from Supabase (storage only), all logic client-side.
   Offline: the app shell is cached by sw.js; freshest data is saved locally
   and rendered first, then refreshed from the network when reachable. */
"use strict";

const SUPABASE_URL = "https://iuddpeelzfpbuvyxrrec.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1ZGRwZWVsemZwYnV2eXhycmVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NjAyOTcsImV4cCI6MjEwOTEzNjI5N30.2U0yep_OOiXs5BZ0f5N7dn17fS6nibBJYeAUFzvOZb4";
const PASS_SALT = "opdroster::";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const NIGHT_OFF_COL = "Night Off";
const LEAVE_COL = "Leave";
/* stored slot key -> shown label. Anything not listed shows its stored key. */
const LABELS = {
  "Leave": "Leave",
  "8to12": "8-12",
  "12to4": "12-4",
  "4to6I": "2-5.30(I)",
  "4to6II": "4-6(II)",
  "8to2": "8-2",
  "2to8": "2-8",
  "Night": "Night",
  "Night Off": "Night Off"
};
/* columns whose values live in their own database field rather than the slots list */
const FIELD_COLS = { "Leave": "leave", "Night Off": "night_off" };
/* order columns should prefer, while keeping any extra uploaded columns */
const COL_ORDER = ["Leave", "8to12", "12to4", "4to6I", "4to6II", "8to2", "2to8", "Night", "Night Off"];
function labelOf(key, day) {
  /* Saturday 2-8 shift runs 4-8 instead */
  if (key === "2to8" && day && String(day.day_name || "").trim().toLowerCase() === "saturday") return "4-8";
  return LABELS[key] || key;
}
function keyOfLabel(label) {
  const found = Object.keys(LABELS).find(k => LABELS[k].toLowerCase() === String(label).trim().toLowerCase());
  return found || label;
}
/* header cells that are structure, not shifts — matched loosely */
const STRUCT_HEADERS = [
  { re: /^date$/i, key: "Date" },
  { re: /^day(\s*name)?$/i, key: "Day" },
  { re: /^ph\s*off$/i, key: "PH OFF" },
  { re: /^is\s*ph$/i, key: "isPH" }
];
function normalizeHeader(h) {
  const raw = String(h).trim();
  for (const s of STRUCT_HEADERS) if (s.re.test(raw)) return s.key;
  return keyOfLabel(raw);
}
const MONTHS_LOOKUP = { "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun", "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec" };

/* ---------------- data layer ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...opts,
    headers: {
      "apikey": ANON_KEY,
      "Authorization": "Bearer " + ANON_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body;
    try { msg = JSON.parse(body).message || body; } catch (_) {}
    throw new Error(msg || ("Request failed (" + res.status + ")"));
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

const db = {
  rosters: () => api("rosters?select=*&order=month_anchor.desc"),
  days: (rosterId) => api("roster_days?roster_id=eq." + rosterId + "&select=*&order=roster_date.asc"),
  dayOn: (rosterId, date) => api("roster_days?roster_id=eq." + rosterId + "&roster_date=eq." + date),
  settings: () => api("settings?select=*"),
  patchDay: (id, fields) => api("roster_days?id=eq." + id, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() })
  }),
  deleteDay: (id) => api("roster_days?id=eq." + id, { method: "DELETE", headers: { Prefer: "return=minimal" } }),
  addRoster: (roster) => api("rosters", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(roster) }),
  deleteRoster: (id) => api("rosters?id=eq." + id, { method: "DELETE", headers: { Prefer: "return=minimal" } }),
  patchSetting: (key, value) => api("settings?key=eq." + encodeURIComponent(key), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ value, updated_at: new Date().toISOString() })
  })
};

/* ---------------- tiny helpers ---------------- */
const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => (el || document).querySelectorAll(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function parseISO(d) { const [y, m, day] = d.split("-").map(Number); return new Date(y, m - 1, day); }
function fmtISO(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function todayISO() { return fmtISO(new Date()); }
function longDate(iso) {
  const d = parseISO(iso);
  return MON[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
}
function monthTitle(anchor) {
  const d = parseISO(anchor);
  return MONTHS[d.getMonth()] + " " + d.getFullYear();
}
function displayValue(v) {
  const s = (v ?? "").trim();
  if (s === "") return { text: "", cls: "is-empty" };
  if (s === "-" || s === "–" || s === "—") return { text: s, cls: "is-dash" };
  return { text: s, cls: "" };
}

async function sha256hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function cssId(s) { return s.replace(/[^a-zA-Z0-9_-]/g, "_"); }

/* ---------------- theme ---------------- */
const THEME_KEY = "opd_theme";
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function applyThemeLabel() {
  const dark = currentTheme() === "dark";
  const btn = $("#btn-theme");
  /* button shows the theme you'd switch TO */
  btn.querySelector(".ico-sun").style.display = dark ? "block" : "none";
  btn.querySelector(".ico-moon").style.display = dark ? "none" : "block";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
}
$("#btn-theme").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
  applyThemeLabel();
});
applyThemeLabel();

/* ---------------- saved-data cache & status strip ---------------- */
const DATA_PREFIX = "opd_data:";
function cacheRead(key) {
  try {
    const raw = localStorage.getItem(DATA_PREFIX + key);
    if (!raw) return null;
    const w = JSON.parse(raw);
    if (!w || typeof w.t !== "number") return null;
    return { data: w.v, savedAt: w.t };
  } catch (_) { return null; }
}
function cacheWrite(key, data) {
  try { localStorage.setItem(DATA_PREFIX + key, JSON.stringify({ t: Date.now(), v: data })); } catch (_) {}
}
function dataSavedAt() {
  let newest = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DATA_PREFIX)) {
        const t = (JSON.parse(localStorage.getItem(k)) || {}).t || 0;
        if (t > newest) newest = t;
      }
    }
  } catch (_) {}
  return newest;
}
function savedStamp() {
  const ms = dataSavedAt();
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  return d.getDate() + " " + MONTHS_LOOKUP[String(d.getMonth() + 1).padStart(2, "0")];
}

const syncStrip = $("#sync-strip"), syncText = $("#sync-text");
let syncTimer = null, connState = navigator.onLine ? "online" : "offline";
window.addEventListener("online", () => { connState = "online"; reletter(); });
window.addEventListener("offline", () => { connState = "offline"; reletter(); });

function stripShow(cls, text) {
  clearInterval(syncTimer);
  syncText.textContent = text;
  syncStrip.className = "sync-strip show" + (cls ? " " + cls : "");
}
function stripHide() {
  clearInterval(syncTimer);
  syncStrip.className = "sync-strip";
}
function reletter() {
  if (syncStrip.classList.contains("stale")) syncText.textContent = staleText();
  /* other states are momentary and settle on their own */
}
function staleText() {
  return (connState === "offline" ? "Offline — showing saved copy" : "Slow connection — showing saved copy")
    + (dataSavedAt() ? " (saved " + savedStamp() + ")" : "");
}

/* session controller: shows statuses only when a saved copy is on screen.
   "Up to date" only appears when the network update actually replaced the copy
   that was on screen — a routine successful fetch stays silent. */
function syncSession(cachedShown) {
  const shown = !!cachedShown;
  let timer = null;
  let slowShown = false;
  let staleShown = false;
  const obj = {
    shown: () => shown,
    stale() {
      staleShown = true;
      clearInterval(timer); timer = null;
      slowShown = false;
      stripShow("stale", staleText());
    },
    trying() {
      if (!shown) return;
      clearInterval(timer);
      timer = setTimeout(() => {
        slowShown = true;
        syncStrip.classList.add("show");
        syncStrip.classList.remove("stale", "updated");
        syncText.textContent = "Reaching for the latest…";
      }, 900);
    },
    /* changed = the fresh data differs from what was displayed */
    fresh(changed) {
      clearInterval(timer); timer = null;
      const wasVisible = staleShown || slowShown;
      staleShown = false;
      slowShown = false;
      if (wasVisible) {
        stripShow("updated", "Up to date");
        syncTimer = setTimeout(() => { if (syncStrip.classList.contains("updated")) stripHide(); }, 2000);
      } else {
        stripHide();
      }
    },
    fail() {
      clearInterval(timer); timer = null;
      slowShown = false;
      if (shown) this.stale();
    }
  };
  return obj;
}

/* ---------------- analytics ---------------- */
const ANALYTICS_KEY = "opd_analytics";
const ANALYTICS_CLIENT_KEY = "opd_client_id";
const ANALYTICS_SESSION_KEY = "opd_session_id";
const ANALYTICS_FLUSH_INTERVAL = 30000; // flush queued events every 30s
let analyticsQueue = [];
let analyticsFlushTimer = null;

function getOrCreateClientId() {
  let id = localStorage.getItem(ANALYTICS_CLIENT_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ANALYTICS_CLIENT_KEY, id);
  }
  return id;
}

function getOrCreateSessionId() {
  let id = sessionStorage.getItem(ANALYTICS_SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(ANALYTICS_SESSION_KEY, id);
  }
  return id;
}

function trackEvent(eventType, data = {}) {
  const event = {
    client_id: getOrCreateClientId(),
    session_id: getOrCreateSessionId(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    url: location.hash || "#/today",
    user_agent: navigator.userAgent,
    screen_width: screen.width,
    screen_height: screen.height,
    ...data
  };
  analyticsQueue.push(event);
  if (analyticsQueue.length >= 10) flushAnalytics();
}

function flushAnalytics() {
  if (analyticsQueue.length === 0) return;
  const events = analyticsQueue.splice(0, analyticsQueue.length);
  // Store locally first for offline support (store array directly)
  const cached = cacheRead(ANALYTICS_KEY);
  const existing = Array.isArray(cached?.data) ? cached.data : [];
  const merged = [...existing, ...events].slice(-500);
  cacheWrite(ANALYTICS_KEY, merged);
  // Try to send to server if online
  if (navigator.onLine) {
    sendAnalyticsToServer(events).catch(() => {});
  }
}

async function sendAnalyticsToServer(events) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/analytics_events", {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: "Bearer " + ANON_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(events)
    });
  } catch (_) {
    // Silently fail - events are cached locally
  }
}

// Track page views on route change
const originalRoute = route;
route = async function(...args) {
  trackEvent("page_view", { path: location.hash || "#/today" });
  return originalRoute.apply(this, args);
};

// Track clicks on interactive elements
document.addEventListener("click", (e) => {
  const target = e.target.closest("button, a, [data-edit-slot], [data-edit-field], .tab");
  if (target) {
    trackEvent("click", {
      element: target.tagName.toLowerCase(),
      id: target.id || null,
      class: target.className || null,
      text: target.textContent?.trim().slice(0, 50) || null
    });
  }
}, true);

// Track form submissions
document.addEventListener("submit", (e) => {
  trackEvent("form_submit", {
    form_id: e.target.id || null,
    action: e.target.action || null
  });
}, true);

// Periodic flush
analyticsFlushTimer = setInterval(flushAnalytics, ANALYTICS_FLUSH_INTERVAL);
// Flush on page hide
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushAnalytics();
});
// Flush on before unload
window.addEventListener("beforeunload", flushAnalytics);

// Initial page view
trackEvent("session_start", { referrer: document.referrer || "direct" });

/* ---------------- admin session ---------------- */
const ADMIN_KEY = "opd_admin";
const DEV_KEY = "opd_dev";
function isAdmin() { return !!localStorage.getItem(ADMIN_KEY); }
function isDeveloper() { return !!localStorage.getItem(DEV_KEY); }
function anyAdmin() { return isAdmin() || isDeveloper(); }

/* ---------------- CSV utils ---------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows.filter(r => r.some(f => f.trim() !== ""));
}
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toUploadISO(mdy) {
  const p = String(mdy).trim().split("/");
  if (p.length === 3) return p[2].padStart(4, "20").slice(0, 4) + "-" + p[0].padStart(2, "0") + "-" + p[1].padStart(2, "0");
  return String(mdy).trim();
}
function parseRosterCSV(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error("The file has no data rows.");
  const rawHead = grid[0].map(h => h.trim());
  const head = rawHead.map(normalizeHeader);
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  const slotCols = head.filter(h => !["Date", "Day", "Leave", "Night Off", "PH OFF", "isPH"].includes(h));
  const get = (row, name) => {
    const i = idx[name];
    return i === undefined ? "" : (row[i] ?? "").trim();
  };
  const days = [];
  for (const row of grid.slice(1)) {
    const dRaw = get(row, "Date");
    if (!dRaw) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dRaw) ? dRaw : toUploadISO(dRaw);
    const day = parseISO(date).getDay();
    days.push({
      roster_date: date,
      day_name: get(row, "Day") || MON[day],
      leave: get(row, "Leave"),
      slots: slotCols.map(c => [c, get(row, c)]),
      night_off: get(row, "Night Off"),
      ph_off: get(row, "PH OFF"),
      is_ph: get(row, "isPH") === "1" || get(row, "isPH").toLowerCase() === "true"
    });
  }
  if (!days.length) throw new Error("No dated rows found — the file needs a Date column.");
  return days;
}

/* ---------------- slot columns ---------------- */
function sortColumns(cols) {
  return cols.slice().sort((a, b) => {
    const ia = COL_ORDER.indexOf(a), ib = COL_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}
function slotColumns(days) {
  const cols = new Set(), seen = new Set();
  for (const d of days) for (const [name] of (d.slots || [])) {
    if (!seen.has(name)) { seen.add(name); cols.add(name); }
  }
  return Array.from(cols);
}
function gridColumns(days) {
  return sortColumns([LEAVE_COL].concat(slotColumns(days), [NIGHT_OFF_COL]));
}
function slotValue(day, name) {
  const field = FIELD_COLS[name];
  if (field) return day[field] ?? "";
  const pair = (day.slots || []).find(p => p[0] === name);
  return pair ? pair[1] : "";
}
async function saveSlotValue(day, name, v) {
  const field = FIELD_COLS[name];
  if (field) {
    await db.patchDay(day.id, { [field]: v });
    day[field] = v;
  } else {
    const slots = (day.slots || []).some(p => p[0] === name)
      ? (day.slots || []).map(p => p[0] === name ? [name, v] : p)
      : (day.slots || []).concat([[name, v]]);
    await db.patchDay(day.id, { slots });
    day.slots = slots;
  }
}
async function saveDayField(day, field, v) {
  await db.patchDay(day.id, { [field]: v });
  day[field] = v;
}

/* ---------------- modals ---------------- */
const modalRoot = $("#modal-root");
function openModal(html, onMount) {
  modalRoot.innerHTML = '<div class="modal-scrim"><div class="modal" role="dialog" aria-modal="true">' + html + "</div></div>";
  const scrim = $(".modal-scrim", modalRoot);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeModal(); });
  const modal = $(".modal", modalRoot);
  if (onMount) onMount(modal);
  const first = modal.querySelector("input, select") || $(".btn", modal);
  if (first) first.focus();
  return modal;
}
function closeModal() { modalRoot.innerHTML = ""; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
function errInto(modal, e) {
  const msg = $(".modal-msg", modal);
  if (msg) msg.textContent = (e && e.message) || "Something went wrong.";
}

/* ---------------- header / settings (cached offline) ---------------- */
let settingsCache = null;
async function refreshSettings() {
  try {
    const rows = await db.settings();
    settingsCache = {};
    rows.forEach(r => settingsCache[r.key] = r.value);
    cacheWrite("settings", settingsCache);
  } catch (e) {
    const cached = cacheRead("settings");
    if (cached) settingsCache = cached.data;
    else throw e;
  }
}
async function loadHeader() {
  try {
    if (!settingsCache) await refreshSettings();
    $("#brand-name").textContent = settingsCache.unit_name || "OPD Unit";
    $("#brand-hospital").textContent = settingsCache.hospital_name || "";
  } catch (_) { /* keep the defaults if completely offline with no cache */ }
  $("#btn-login").hidden = anyAdmin();
  $("#btn-admin-menu").hidden = !anyAdmin();
}

$("#btn-login").addEventListener("click", async () => {
  let adminHash = "", devHash = "";
  try {
    if (!settingsCache) await refreshSettings();
    adminHash = settingsCache.admin_pass_hash || "";
    devHash = settingsCache.developer_pass_hash || "";
  } catch (_) {}
  if (!adminHash && !devHash) return alert("Can't log in right now — no internet and no saved copy. Try again once you're back online.");
  openModal(`
    <h3>Login</h3>
    <p class="sub">Enter the admin or developer password.</p>
    <form id="login-form">
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn quiet" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Log in</button>
      </div>
      <div class="modal-msg"></div>
    </form>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
    $("#pw", modal).focus();
    $("#login-form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      const pw = $("#pw", modal).value;
      const hash = await sha256hex(PASS_SALT + pw);
      let role = null;
      if (hash === adminHash) role = "admin";
      else if (hash === devHash) role = "developer";
      if (role) {
        // Clear the other role key to ensure mutual exclusivity
        localStorage.removeItem(role === "admin" ? DEV_KEY : ADMIN_KEY);
        localStorage.setItem(role === "admin" ? ADMIN_KEY : DEV_KEY, JSON.stringify({ at: Date.now(), role }));
        closeModal();
        await loadHeader();
        route();
      } else {
        $(".modal-msg", modal).textContent = "Wrong password.";
        $("#pw", modal).select();
      }
    });
  });
});

$("#btn-admin-menu").addEventListener("click", () => {
  const role = isDeveloper() ? "developer" : isAdmin() ? "admin" : "";
  openModal(`
    <h3>${role.charAt(0).toUpperCase() + role.slice(1)}</h3>
    <p class="sub">Tap a cell to change it — changes save as you leave the box.</p>
    <div class="menu-list">
      <button class="btn quiet menu-item" data-x="settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>
        </svg>
        <span>Unit name &amp; password</span>
      </button>
      ${isDeveloper() ? `<button class="btn quiet menu-item" data-x="analytics">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>
        </svg>
        <span>Analytics</span>
      </button>` : ''}
      <button class="btn quiet menu-item" data-x="logout">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/>
          <path d="M16 17l5-5-5-5M21 12H9"/>
        </svg>
        <span>Log out</span>
      </button>
    </div>
    <div class="modal-actions"><button class="btn quiet" data-cancel>Close</button></div>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
    $("[data-x=logout]", modal).addEventListener("click", () => {
      localStorage.removeItem(ADMIN_KEY);
      localStorage.removeItem(DEV_KEY);
      closeModal(); loadHeader(); route();
    });
    $("[data-x=settings]", modal).addEventListener("click", openSettingsModal);
    const analyticsBtn = $("[data-x=analytics]", modal);
    if (analyticsBtn) analyticsBtn.addEventListener("click", () => {
      closeModal();
      location.hash = "#/analytics";
    });
  });
});

/* ---------------- doctor legend ---------------- */
function legendEntries() {
  const map = doctorMap();
  return Object.keys(map)
    .filter(k => /^[A-Za-z]$/.test(k) && map[k])
    .map(k => ({ code: k.toUpperCase(), name: String(map[k]) }))
    /* sorted by letter, the order you meet them in the grid */
    .sort((a, b) => a.code.localeCompare(b.code));
}
async function openLegendModal() {
  if (!settingsCache) { try { await refreshSettings(); } catch (_) {} }
  const entries = legendEntries();
  const body = entries.length
    ? `<div class="legend-grid">${entries.map(e =>
        `<div class="legend-item"><span class="legend-code">${esc(e.code)}</span><span class="legend-name">${esc(e.name)}</span></div>`
      ).join("")}</div>`
    : `<p class="sub">No names have been added yet.</p>`;
  openModal(`
    <h3>Doctor letters</h3>
    <p class="sub">Each letter on the roster stands for one doctor.</p>
    ${body}
    <div class="modal-actions"><button class="btn quiet" data-cancel>Close</button></div>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
  });
}
$("#btn-legend").addEventListener("click", openLegendModal);

async function openSettingsModal() {
  if (!settingsCache) await refreshSettings();
  openModal(`
    <h3>Settings</h3>
    <p class="sub">Shown in the header on every device.</p>
    <form id="set-form">
      <div class="field"><label for="s-unit">Unit name</label>
        <input id="s-unit" type="text" value="${esc(settingsCache.unit_name || "")}"></div>
      <div class="field"><label for="s-hosp">Hospital name</label>
        <input id="s-hosp" type="text" value="${esc(settingsCache.hospital_name || "")}"></div>
      <hr>
      <div class="field"><label for="s-pw">New admin password (leave blank to keep current)</label>
        <input id="s-pw" type="password" autocomplete="new-password"></div>
      <div class="field"><label for="s-devpw">New developer password (leave blank to keep current)</label>
        <input id="s-devpw" type="password" autocomplete="new-password"></div>
      <div class="modal-actions">
        <button type="button" class="btn quiet" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
      <div class="modal-msg"></div>
    </form>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
    $("#set-form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await db.patchSetting("unit_name", $("#s-unit", modal).value.trim() || "OPD Unit");
        await db.patchSetting("hospital_name", $("#s-hosp", modal).value.trim());
        const pw = $("#s-pw", modal).value;
        if (pw) await db.patchSetting("admin_pass_hash", await sha256hex(PASS_SALT + pw));
        const dpw = $("#s-devpw", modal).value;
        if (dpw) await db.patchSetting("developer_pass_hash", await sha256hex(PASS_SALT + dpw));
        settingsCache = null;
        closeModal();
        await loadHeader();
        route();
      } catch (err) { errInto(modal, err); }
    });
  });
}

/* ---------------- inline editing ---------------- */
function setCellText(el, v, baseClass) {
  const dv = displayValue(v);
  el.textContent = dv.text;
  el.className = baseClass + (dv.cls ? " " + dv.cls : "");
  return dv;
}
function makeEditable(el, getValue, save, opts) {
  opts = opts || {};
  el.classList.add("editable");
  el.addEventListener("click", () => {
    if (el.querySelector("input")) return;
    const original = getValue();
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", opts.label || "");
    input.value = original;
    input.className = "inline-input";
    const cellClass = el.className;
    el.textContent = "";
    el.appendChild(input);
    input.focus();
    input.select();
    let cancelled = false, finished = false;
    const commit = async () => {
      if (finished) return;
      finished = true;
      const v = input.value;
      if (cancelled || v === original) {
        setCellText(el, original, cellClass);
        return;
      }
      el.classList.add("saving");
      try {
        await save(v);
        el.classList.remove("saving");
        if (opts.fullRefresh) opts.fullRefresh();
        else setCellText(el, v, cellClass);
      } catch (err) {
        el.classList.remove("saving");
        alert("Couldn't save" + (connState === "offline" ? " — you are offline" : "") + ": " + (err.message || err));
        if (opts.fullRefresh) opts.fullRefresh();
        else setCellText(el, original, cellClass);
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      else if (e.key === "Escape") {
        cancelled = true;
        input.blur();
      }
    });
  });
}

/* ---------------- doctor names (letter -> name) ---------------- */
/* Codes are concatenated (e.g. "AVFCKN") and "/" separates groups ("J/F"),
   so resolution walks every character instead of splitting on tokens. */
function doctorMap() {
  try {
    const raw = settingsCache && settingsCache.doctors;
    if (!raw) return {};
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) { return {}; }
}
function namesFor(value) {
  const map = doctorMap(), out = [], seen = new Set();
  for (const ch of String(value ?? "")) {
    if (!/[A-Za-z]/.test(ch)) continue;
    const name = map[ch.toUpperCase()];
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/* ---------------- shared markup ---------------- */
function daySheet(day, opts) {
  const editable = opts && opts.editable && anyAdmin();
  const cols = gridColumns([day]);
  const rows = cols.map((name) => {
    const val = slotValue(day, name);
    return `<div class="day-row">
      <div class="slot">${esc(labelOf(name, day))}</div>
      <div class="val${editable ? " live-edit" : ""}"${editable ? ' data-edit-slot="' + esc(name) + '" title="Tap to change"' : ""}>${esc(displayValue(val).text)}</div>
    </div>`;
  }).join("");
  const notes = [];
  if (day.ph_off) notes.push(["Off (public holiday)", day.ph_off, "ph_off"]);
  const foot = notes.length ? `<div class="day-footnotes">${notes.map(([l, v, f]) =>
    `<div class="day-footnote"><span class="fn-label">${esc(l)}</span><span class="fn-val${editable ? " live-edit" : ""}"${editable ? ' data-edit-field="' + f + '" title="Tap to change"' : ""}>${esc(v)}</span></div>`).join("")}</div>` : "";
  return `<div class="day-sheet${day.is_ph ? " is-ph" : ""}">
    <div class="day-rows">${rows}</div>${foot}
  </div>`;
}

function stampCell(day) {
  const d = parseISO(day.roster_date);
  const wd = (day.day_name || MON[d.getDay()]).slice(0, 3);
  return `<span class="stamp-num">${d.getDate()}</span><span class="stamp-wd">${esc(wd)}${day.is_ph ? '<span class="stamp-ph">PH</span>' : ""}</span>`;
}

/* ---------------- router ---------------- */
const view = $("#view");
async function route() {
  const parts = (location.hash || "#/today").slice(2).split("/");
  if (parts[0] === "m" && parts[1]) { location.replace("#/grid/" + parts[1]); return; }
  syncTabs(parts[0]);
  try {
    if (parts[0] === "grid") await gridView(parts[1] || null);
    else if (parts[0] === "d" && parts[1]) await dayView(parts[1]);
    else if (parts[0] === "analytics") await analyticsView();
    else await todayView();
  } catch (e) {
    view.innerHTML = `<div class="error-banner">Couldn't load data — ${esc((e && e.message) || "server unreachable")}. <a href="#/today">Retry</a></div>`;
    stripHide();
  }
}
window.addEventListener("hashchange", route);

function syncTabs(section) {
  const active = section === "grid" || section === "d" ? "grid" : "today";
  $$("#tabs .tab").forEach(t => {
    if (t.dataset.tab === active) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
}

/* ---------------- today's duty ---------------- */
function renderToday(day, rosterId) {
  const d = parseISO(todayISO());
  view.innerHTML = `
    <div class="today-topline">
      <div class="today-date">
        <span class="today-num">${d.getDate()}</span>
        <span><strong style="font-size:16px">${MONTHS[d.getMonth()]} ${d.getFullYear()}</strong>
        <div class="today-meta">${MON[d.getDay()]}${day.is_ph ? ' · <span class="ph-stamp">PH</span> public holiday' : ""}</div></span>
      </div>
    </div>
    ${daySheet(day, { editable: true })}
    ${anyAdmin() ? '<p class="hint">Tap any line to change it.</p>' : ""}
  `;
  if (anyAdmin()) bindSheetEditing(view, day, () => route());
}

async function todayView() {
  const t = todayISO();
  const cachedDay = cacheRead("day:" + t);
  const sync = syncSession(!!cachedDay);
  if (cachedDay) {
    renderToday(cachedDay.data);
    if (connState === "offline") sync.stale();
    else sync.trying();
  } else {
    view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  }

  try {
    const rosters = await db.rosters();
    cacheWrite("rosters", rosters);
    const match = rosters.find(r => r.month_anchor.slice(0, 7) === t.slice(0, 7));
    let day = null, roster = null;
    if (match) {
      const found = await db.dayOn(match.id, t);
      if (found.length) { day = found[0]; roster = match; }
    }
    if (day) {
      const changed = !cachedDay || JSON.stringify(cachedDay.data) !== JSON.stringify(day);
      cacheWrite("day:" + t, day);
      renderToday(day);
      sync.fresh(changed);
    } else {
      stripHide();
      const latest = rosters[0];
      view.innerHTML = `
        <div class="no-today">
          <strong>No roster for today.</strong>
          ${latest ? `<div>The latest roster is <a href="#/grid/${latest.id}">${esc(monthTitle(latest.month_anchor))}</a>.</div>` : "<div>Upload one as admin to get started.</div>"}
        </div>`;
    }
  } catch (e) {
    if (cacheRead("day:" + t)) sync.fail();
    else { stripHide(); view.innerHTML = `<div class="error-banner">Couldn't load data — ${esc((e && e.message) || "server unreachable")}. <a href="#/today">Retry</a></div>`; }
  }
}

/* ---------------- full grid ---------------- */
let gridCurrent = null; /* id of the roster currently rendered, used by month select */

async function gridView(rosterId) {
  const t = todayISO();

  const cachedRosters = cacheRead("rosters");
  let cachedShown = false, cachedRoster = null, cachedDaysData = null;
  if (cachedRosters && cachedRosters.data.length) {
    cachedRoster = pickRoster(cachedRosters.data, rosterId, t);
    const cachedDays = cachedRoster && cacheRead("days:" + cachedRoster.id);
    if (cachedDays && cachedDays.data.length) {
      cachedDaysData = cachedDays.data;
      cachedShown = true;
    }
  }
  const sync = syncSession(cachedShown);
  if (cachedShown) {
    renderGrid(cachedRoster, cachedDaysData);
    if (connState === "offline") sync.stale();
    else sync.trying();
  } else {
    view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  }

  try {
    const rosters = await db.rosters();
    cacheWrite("rosters", rosters);
    const roster = pickRoster(rosters, rosterId, t);
    const days = await db.days(roster.id);
    const changed = !cachedShown || JSON.stringify(cachedDaysData) !== JSON.stringify(days);
    cacheWrite("days:" + roster.id, days);
    renderGrid(roster, days);
    sync.fresh(changed);
  } catch (e) {
    if (cachedShown) sync.fail();
    else { stripHide(); view.innerHTML = `<div class="error-banner">Couldn't load data — ${esc((e && e.message) || "server unreachable")}. <a href="#/grid">Retry</a></div>`; }
  }
}

function pickRoster(list, rosterId, t) {
  if (rosterId) {
    const r = list.find(x => x.id === rosterId);
    if (r) return r;
  }
  return list.find(r => r.month_anchor.slice(0, 7) === t.slice(0, 7)) || list[0] || null;
}

function renderGrid(roster, days) {
  gridCurrent = roster.id;
  const cols = gridColumns(days);
  const admin = anyAdmin();
  const byId = {};
  days.forEach(d => byId[d.id] = d);
  const rostersNow = (cacheRead("rosters") || {}).data || [];

  const selector = rostersNow.length > 1
    ? `<select id="month-select" aria-label="Month">${rostersNow.map(r =>
        `<option value="${r.id}" ${r.id === roster.id ? "selected" : ""}>${esc(monthTitle(r.month_anchor))}</option>`).join("")}</select>`
    : `<span class="month-note">${esc(monthTitle(roster.month_anchor))}</span>`;

  view.innerHTML = `
    <div class="grid-head">
      <h1 class="grid-title">Full grid</h1>
      ${selector}
      ${isDeveloper() ? `<div class="month-tools">
        <button class="btn primary" id="t-upload">Upload CSV</button>
        <button class="btn quiet" id="t-download">Download CSV</button>
      </div>` : ""}
    </div>
    <div class="gridwrap">
      <table class="grid">
        <thead><tr><th class="stamp-col" aria-label="Date"><span class="th-day">Day</span></th>${cols.map(c => `<th>${esc(labelOf(c))}</th>`).join("")}</tr></thead>
        <tbody>${days.map(day => gridRow(day, cols, admin, todayISO())).join("") || '<tr><td class="empty-note" colspan="1">No days in this roster yet.</td></tr>'}</tbody>
      </table>
    </div>
    ${admin ? `<input type="file" id="file-csv" accept=".csv,text/csv" style="display:none">` : ""}
  `;

  bindRowLinks(view);
  scrollGridToToday();

  $$("td[data-edit-slot]", view).forEach((cell) => {
    const day = byId[cell.dataset.day];
    makeEditable(cell,
      () => slotValue(day, cell.dataset.editSlot),
      (v) => saveSlotValue(day, cell.dataset.editSlot, v),
      { label: longDate(day.roster_date) + ", " + cell.dataset.editSlot });
  });

  const sel = $("#month-select");
  if (sel) sel.addEventListener("change", () => { location.hash = "#/grid/" + sel.value; });

  if (!isDeveloper()) return;

  $("#t-upload").addEventListener("click", () => $("#file-csv").click());
  $("#file-csv").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = parseRosterCSV(await file.text());
      openConfirmUpload(parsed);
    } catch (err) {
      alert("Couldn't read that file: " + (err.message || err));
    }
  });
  function openConfirmUpload(parsed) {
    const d0 = parseISO(parsed[0].roster_date);
    const title = MONTHS[d0.getMonth()] + " " + d0.getFullYear();
    const anchor = fmtISO(new Date(d0.getFullYear(), d0.getMonth(), 1));
    openModal(`
      <h3>Upload roster</h3>
      <p class="sub">${parsed.length} days ready.</p>
      <form id="up-form">
        <div class="field"><label for="up-title">Roster title</label>
          <input id="up-title" type="text" value="${esc(title)}"></div>
        <div class="field-check"><input id="up-replace" type="checkbox" checked><label for="up-replace" style="margin:0">Replace existing ${esc(monthTitle(anchor))} if present</label></div>
        <div class="modal-actions">
          <button type="button" class="btn quiet" data-cancel>Cancel</button>
          <button type="submit" class="btn primary">Upload</button>
        </div>
        <div class="modal-msg"></div>
      </form>
    `, (modal) => {
      $("[data-cancel]", modal).addEventListener("click", closeModal);
      $("#up-form", modal).addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const newTitle = $("#up-title", modal).value.trim();
        const replace = $("#up-replace", modal).checked;
        try {
          if (replace) {
            const all = await db.rosters();
            const old = all.find(r => r.month_anchor === anchor);
            if (old) await db.deleteRoster(old.id);
          }
          const created = (await db.addRoster({ title: newTitle, month_anchor: anchor }))[0];
          await api("roster_days", { method: "POST", body: JSON.stringify(parsed.map(d => ({ ...d, roster_id: created.id }))) });
          closeModal();
          location.hash = "#/grid/" + created.id;
          if (location.hash === "#/grid/" + created.id) route();
        } catch (err) { errInto(modal, err); }
      });
    });
  }

  $("#t-download").addEventListener("click", () => {
    const dlCols = slotColumns(days);
    const head = ["Date", "Day", "Leave", ...dlCols, "Night Off", "PH OFF", "isPH"];
    const lines = [head.join(",")];
    for (const day of days) {
      const d = parseISO(day.roster_date);
      const row = [
        `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
        day.day_name, day.leave,
        ...dlCols.map(c => slotValue(day, c)),
        day.night_off, day.ph_off, day.is_ph ? "1" : ""
      ];
      lines.push(row.map(csvField).join(","));
    }    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = roster.title.replace(/[^\w -]/g, "").trim() + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
}

function gridRow(day, cols, admin, today) {
  const cells = cols.map(c => {
    const dv = displayValue(slotValue(day, c));
    const edit = admin ? ` data-edit-slot="${esc(c)}" data-day="${day.id}" title="Tap to change"` : "";
    return `<td${edit}${dv.cls ? ' class="' + dv.cls + '"' : ""}>${esc(dv.text)}</td>`;
  }).join("");
  return `<tr class="rowlink${day.is_ph ? " ph" : ""}${day.roster_date === today ? " today" : ""}" data-href="#/d/${day.roster_date}">
    <td class="stamp-col"><a href="#/d/${day.roster_date}" style="color:inherit">${stampCell(day)}</a></td>
    ${cells}
  </tr>`;
}

/* keeps today's row visible inside the scrolling grid: centres it when the
   row sits outside the visible band, otherwise leaves the scroll alone */
function scrollGridToToday(force) {
  const wrap = $(".gridwrap", view) || $(".gridwrap");
  if (!wrap) return;
  const row = wrap.querySelector("tr.today");
  if (!row) return;
  const rowTop = row.offsetTop;
  const rowH = row.offsetHeight;
  const viewH = wrap.clientHeight;
  const visibleTop = wrap.scrollTop;
  const visibleBottom = visibleTop + viewH;
  const headH = wrap.querySelector("thead")?.offsetHeight || 0;

  /* already comfortably in view — don't move it */
  const inComfortableView = rowTop >= visibleTop + headH && rowTop + rowH <= visibleBottom - 8;
  if (inComfortableView && !force) return;

  const target = rowTop - headH - (viewH - headH - rowH) / 2;
  wrap.scrollTop = Math.max(0, target);
}

/* tapping anywhere on a row opens that day; admin duty cells handle their own taps */
function bindRowLinks(scope) {
  scope.querySelectorAll("tr.rowlink").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a, input, select, [data-edit-slot]")) return;
      if (window.getSelection && String(window.getSelection()).length) return;
      location.hash = tr.dataset.href;
    });
  });
}

/* ---------------- day view ---------------- */
async function dayView(date) {
  let cachedShown = false;
  const cachedDay = cacheRead("day:" + date);
  if (cachedDay) {
    try { renderDayDetail(date, cachedDay.data); cachedShown = true; } catch (_) {}
  }
  const sync = syncSession(cachedShown);
  if (cachedShown) {
    if (connState === "offline") sync.stale();
    else sync.trying();
  } else {
    view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  }

  try {
    const rosters = await db.rosters();
    cacheWrite("rosters", rosters);
    const match = rosters.find(r => r.month_anchor.slice(0, 7) === date.slice(0, 7));
    if (!match) {
      stripHide();
      view.innerHTML = `<div class="error-banner">No roster covers ${esc(longDate(date))}. <a href="#/grid">Back to full grid</a></div>`;
      return;
    }
    const found = await db.dayOn(match.id, date);
    if (!found.length) {
      stripHide();
      view.innerHTML = `<div class="error-banner">${esc(monthTitle(match.month_anchor))} has no entry for ${esc(longDate(date))}. <a href="#/grid/${match.id}">Open the month</a></div>`;
      return;
    }
    cacheWrite("day:" + date, found[0]);
    renderDayDetail(date, found[0]);
    sync.fresh(!!cachedDay && JSON.stringify(cachedDay.data) !== JSON.stringify(found[0]));
  } catch (e) {
    if (cachedShown) sync.fail();
    else { stripHide(); view.innerHTML = `<div class="error-banner">Couldn't load data — ${esc((e && e.message) || "server unreachable")}. <a href="#/d/${date}">Retry</a></div>`; }
  }
}

function renderDayDetail(date, day) {
  const d = parseISO(date);
  view.innerHTML = `
    <a class="backlink" href="#/grid">← Full grid</a>
    <div class="dayview-head">
      <span class="dayview-num">${d.getDate()}</span>
      <span>
        <strong style="font-size:17px">${MONTHS[d.getMonth()]} ${d.getFullYear()}</strong>
        <div class="dayview-meta">${esc(day.day_name || MON[d.getDay()])}${day.is_ph ? ' · <span class="ph-stamp">PH</span> public holiday' : ""}</div>
      </span>
    </div>
    ${daySheet(day, { editable: true })}
    ${isDeveloper() ? `<div class="dayview-tools">
      <button class="btn quiet" id="t-ph">${day.is_ph ? "Remove PH flag" : "Mark as PH"}</button>
      <button class="btn danger" id="t-destroy">Delete day</button>
    </div>` : ""}
    ${anyAdmin() ? '<p class="hint">Tap a line to change it.</p>' : ""}
  `;
  /* cell editing is for both roles; the PH / delete tools above are developer-only */
  if (!anyAdmin()) return;
  const rebuild = () => dayView(date);
  bindSheetEditing(view, day, rebuild);
  if (!isDeveloper()) return;
  $("#t-ph").addEventListener("click", async () => {
    try { await saveDayField(day, "is_ph", !day.is_ph); await rebuild(); }
    catch (err) { alert("Couldn't save" + (connState === "offline" ? " — you are offline" : "") + ": " + (err.message || err)); }
  });
  $("#t-destroy").addEventListener("click", () => {
    openModal(`
      <h3>Delete day</h3>
      <p class="sub">Remove ${esc(longDate(day.roster_date))} from the roster? There is no undo.</p>
      <div class="modal-actions">
        <button class="btn quiet" data-cancel>Cancel</button>
        <button class="btn danger" id="dd-go">Delete</button>
      </div>
      <div class="modal-msg"></div>
    `, (m) => {
      $("[data-cancel]", m).addEventListener("click", closeModal);
      $("#dd-go", m).addEventListener("click", async () => {
        try { await db.deleteDay(day.id); closeModal(); location.hash = "#/grid"; }
        catch (err) { errInto(m, err); }
      });
    });
  });
}

/* ---------------- analytics view (developer only) ---------------- */
async function analyticsView() {
  if (!isDeveloper()) {
    view.innerHTML = `<div class="error-banner">Access denied. Developer account required.</div>`;
    return;
  }

  view.innerHTML = `
    <div class="grid-head">
      <h1 class="grid-title">Analytics Dashboard</h1>
    </div>
    <div class="gridwrap">
      <div style="padding: 20px;">
        <div class="section-label">Overview</div>
        <div id="analytics-overview" class="analytics-cards"></div>
        
        <div class="section-label" style="margin-top: 24px;">Events (Last 100)</div>
        <div id="analytics-events" class="analytics-table"></div>
        
        <div class="section-label" style="margin-top: 24px;">Local Cache</div>
        <div id="analytics-cache" class="analytics-table"></div>
      </div>
    </div>
  `;

  await renderAnalytics();
}

async function renderAnalytics() {
  // Fetch from server
  let serverEvents = [];
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/analytics_events?select=*&order=timestamp.desc&limit=200", {
      headers: { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY }
    });
    if (res.ok) serverEvents = await res.json();
  } catch (_) {}

  // Get local cache (stored as array directly)
  const cached = cacheRead(ANALYTICS_KEY);
  const localEvents = Array.isArray(cached?.data) ? cached.data : [];

  // Combine and deduplicate by timestamp+client_id+event_type
  const allEvents = [...serverEvents, ...localEvents];
  const seen = new Set();
  const uniqueEvents = allEvents.filter(e => {
    const key = `${e.timestamp}|${e.client_id}|${e.event_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Compute stats
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const uniqueClients = new Set(uniqueEvents.map(e => e.client_id)).size;
  const totalSessions = new Set(uniqueEvents.map(e => e.session_id)).size;
  const pageViews = uniqueEvents.filter(e => e.event_type === "page_view").length;
  const clicks = uniqueEvents.filter(e => e.event_type === "click").length;
  const formSubmits = uniqueEvents.filter(e => e.event_type === "form_submit").length;
  const last24h = uniqueEvents.filter(e => new Date(e.timestamp) > dayAgo).length;
  const last7d = uniqueEvents.filter(e => new Date(e.timestamp) > weekAgo).length;

  // Overview cards
  $("#analytics-overview").innerHTML = `
    <div class="analytics-card-row">
      <div class="analytics-card"><div class="analytics-card-value">${uniqueClients}</div><div class="analytics-card-label">Unique Users</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${totalSessions}</div><div class="analytics-card-label">Total Sessions</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${pageViews}</div><div class="analytics-card-label">Page Views</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${clicks}</div><div class="analytics-card-label">Clicks</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${formSubmits}</div><div class="analytics-card-label">Form Submits</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${last24h}</div><div class="analytics-card-label">Events (24h)</div></div>
      <div class="analytics-card"><div class="analytics-card-value">${last7d}</div><div class="analytics-card-label">Events (7d)</div></div>
    </div>
  `;

  // Events table
  const eventRows = uniqueEvents.slice(0, 100).map(e => `
    <tr>
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td><span class="event-type-${e.event_type}">${esc(e.event_type)}</span></td>
      <td>${esc(e.client_id.slice(0, 8))}…</td>
      <td>${esc(e.session_id.slice(0, 8))}…</td>
      <td>${esc(e.url)}</td>
      <td>${esc(JSON.stringify(e).slice(0, 100))}</td>
    </tr>
  `).join("");
  
  $("#analytics-events").innerHTML = `
    <table class="grid" style="font-size: 12px;">
      <thead><tr>
        <th>Time</th><th>Event</th><th>Client ID</th><th>Session ID</th><th>URL</th><th>Data</th>
      </tr></thead>
      <tbody>${eventRows || '<tr><td colspan="6" class="empty-note">No events recorded yet</td></tr>'}</tbody>
    </table>
  `;

  // Local cache table
  const cacheRows = (localEvents.slice(-50).reverse()).map(e => `
    <tr>
      <td>${new Date(e.timestamp).toLocaleString()}</td>
      <td>${esc(e.event_type)}</td>
      <td>${esc(e.client_id.slice(0, 8))}…</td>
      <td>${esc(e.url)}</td>
    </tr>
  `).join("");
  
  $("#analytics-cache").innerHTML = `
    <table class="grid" style="font-size: 12px;">
      <thead><tr>
        <th>Time</th><th>Event</th><th>Client ID</th><th>URL</th>
      </tr></thead>
      <tbody>${cacheRows || '<tr><td colspan="4" class="empty-note">No local cache</td></tr>'}</tbody>
    </table>
  `;
}

/* cell editing inside a day sheet (today + day view) */
function bindSheetEditing(scope, day, onDone) {
  scope.querySelectorAll("[data-edit-slot]").forEach(el => {
    makeEditable(el,
      () => slotValue(day, el.dataset.editSlot),
      (v) => saveSlotValue(day, el.dataset.editSlot, v),
      { label: longDate(day.roster_date) + ", " + el.dataset.editSlot });
  });
  scope.querySelectorAll("[data-edit-field]").forEach(el => {
    makeEditable(el,
      () => day[el.dataset.editField],
      (v) => saveDayField(day, el.dataset.editField, v),
      { label: longDate(day.roster_date) + " — " + el.dataset.editField });
  });
}

/* ---------------- service worker ---------------- */
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (sessionStorage.getItem("sw_updated")) {
      sessionStorage.removeItem("sw_updated");
      location.reload();
    }
  });
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          sessionStorage.setItem("sw_updated", "1");
        }
      });
    });
  });
}

/* ---------------- boot ---------------- */
loadHeader().then(route).catch(() => route());

