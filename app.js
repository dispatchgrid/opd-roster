/* OPD Roster — data from Supabase (storage only), all logic client-side */
"use strict";

const SUPABASE_URL = "https://iuddpeelzfpbuvyxrrec.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1ZGRwZWVsemZwYnV2eXhycmVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NjAyOTcsImV4cCI6MjEwOTEzNjI5N30.2U0yep_OOiXs5BZ0f5N7dn17fS6nibBJYeAUFzvOZb4";
const PASS_SALT = "opdroster::";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const NIGHT_OFF_COL = "Night Off";
const DAY = 86400000;

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

/* ---------------- admin session ---------------- */
const ADMIN_KEY = "opd_admin";
function isAdmin() { return !!localStorage.getItem(ADMIN_KEY); }

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
  const head = grid[0].map(h => h.trim());
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
function slotColumns(days) {
  const cols = [], seen = new Set();
  for (const d of days) for (const [name] of (d.slots || [])) {
    if (!seen.has(name)) { seen.add(name); cols.push(name); }
  }
  return cols;
}
function gridColumns(days) {
  return slotColumns(days).concat([NIGHT_OFF_COL]);
}
function slotValue(day, name) {
  if (name === NIGHT_OFF_COL) return day.night_off ?? "";
  const pair = (day.slots || []).find(p => p[0] === name);
  return pair ? pair[1] : "";
}
async function saveSlotValue(day, name, v) {
  if (name === NIGHT_OFF_COL) {
    await db.patchDay(day.id, { night_off: v });
    day.night_off = v;
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

/* ---------------- header / auth ---------------- */
let settingsCache = null;
async function loadHeader() {
  try {
    if (!settingsCache) {
      const rows = await db.settings();
      settingsCache = {};
      rows.forEach(r => settingsCache[r.key] = r.value);
    }
    $("#brand-name").textContent = settingsCache.unit_name || "OPD Unit";
    $("#brand-hospital").textContent = settingsCache.hospital_name || "";
  } catch (_) { /* fall back to defaults */ }
  $("#btn-login").hidden = isAdmin();
  $("#btn-admin-menu").hidden = !isAdmin();
}

$("#btn-login").addEventListener("click", async () => {
  let hash = "";
  try {
    const rows = await db.settings();
    hash = (rows.find(r => r.key === "admin_pass_hash") || {}).value || "";
  } catch (_) {}
  if (!hash) return alert("Can't log in right now — server unreachable. Try again in a moment.");
  openModal(`
    <h3>Admin login</h3>
    <p class="sub">Enter the unit password to edit rosters.</p>
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
      if ((await sha256hex(PASS_SALT + pw)) === hash) {
        localStorage.setItem(ADMIN_KEY, JSON.stringify({ at: Date.now() }));
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
  openModal(`
    <h3>Admin</h3>
    <p class="sub">Tap a cell to change it — changes save as you leave the box.</p>
    <div class="menu-list">
      <button class="btn quiet" data-x="settings" style="text-align:left">Unit name &amp; password</button>
      <button class="btn quiet" data-x="logout" style="text-align:left">Log out</button>
    </div>
    <div class="modal-actions"><button class="btn quiet" data-cancel>Close</button></div>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
    $("[data-x=logout]", modal).addEventListener("click", () => {
      localStorage.removeItem(ADMIN_KEY);
      closeModal(); loadHeader(); route();
    });
    $("[data-x=settings]", modal).addEventListener("click", openSettingsModal);
  });
});

async function openSettingsModal() {
  if (!settingsCache) await loadHeader();
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
    if (el.querySelector("input") || view._dirty) return;
    const original = getValue();
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", opts.label || getValue());
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
        view._dirty = false;
        if (opts.fullRefresh) opts.fullRefresh();
        else setCellText(el, v, cellClass);
      } catch (err) {
        view._dirty = false;
        alert("Couldn't save: " + (err.message || err));
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

/* ---------------- shared markup ---------------- */
function daySheet(day, opts) {
  const editable = opts && opts.editable && isAdmin();
  const rows = (day.slots || []).map(([name]) => {
    const val = slotValue(day, name);
    return `<div class="day-row">
      <div class="slot">${esc(name)}</div>
      <div class="val${editable ? " live-edit" : ""}"${editable ? ' data-edit-slot="' + esc(name) + '" title="Tap to change"' : ""}>${esc(displayValue(val).text)}</div>
    </div>`;
  }).join("");
  const nightRow = `<div class="day-row">
      <div class="slot">${esc(NIGHT_OFF_COL)}</div>
      <div class="val${editable ? " live-edit" : ""}"${editable ? ' data-edit-slot="' + esc(NIGHT_OFF_COL) + '" title="Tap to change"' : ""}>${esc(displayValue(day.night_off).text)}</div>
    </div>`;
  const notes = [];
  if (day.leave) notes.push(["Leave", day.leave, "leave"]);
  if (day.ph_off) notes.push(["Off (public holiday)", day.ph_off, "ph_off"]);
  const foot = notes.length ? `<div class="day-footnotes">${notes.map(([l, v, f]) =>
    `<div class="day-footnote"><span class="fn-label">${esc(l)}</span><span class="fn-val${editable ? " live-edit" : ""}"${editable ? ' data-edit-field="' + f + '" title="Tap to change"' : ""}>${esc(v)}</span></div>`).join("")}</div>` : "";
  return `<div class="day-sheet${day.is_ph ? " is-ph" : ""}">
    <div class="day-rows">${rows}${nightRow}</div>${foot}
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
  syncTabs(parts[0]);
  try {
    if (parts[0] === "grid") await gridView(parts[1] || null);
    else if (parts[0] === "d" && parts[1]) await dayView(parts[1]);
    else await todayView();
  } catch (e) {
    view.innerHTML = `<div class="error-banner">Couldn't load data — ${esc((e && e.message) || "server unreachable")}. <a href="#/today">Retry</a></div>`;
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
async function todayView() {
  view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  const rosters = await db.rosters();
  const t = todayISO();
  let day = null, roster = null;
  const match = rosters.find(r => r.month_anchor.slice(0, 7) === t.slice(0, 7));
  if (match) {
    const found = await db.dayOn(match.id, t);
    if (found.length) { day = found[0]; roster = match; }
  }
  if (!day) {
    const latest = rosters[0];
    view.innerHTML = `
      <div class="no-today">
        <strong>No roster for today.</strong>
        ${latest ? `<div>The latest roster is <a href="#/grid/${latest.id}">${esc(monthTitle(latest.month_anchor))}</a>.</div>` : "<div>Upload one as admin to get started.</div>"}
      </div>`;
    return;
  }
  const d = parseISO(t);
  view.innerHTML = `
    <div class="today-topline">
      <div class="today-date">
        <span class="today-num">${d.getDate()}</span>
        <span><strong style="font-size:16px">${MONTHS[d.getMonth()]} ${d.getFullYear()}</strong>
        <div class="today-meta">${MON[d.getDay()]}${day.is_ph ? ' · <span class="ph-stamp">PH</span> public holiday' : ""}</div></span>
      </div>
    </div>
    ${daySheet(day, { editable: true })}
    ${isAdmin() ? '<p class="hint">Tap any line to change it.</p>' : ""}
  `;
  if (isAdmin()) bindSheetEditing(view, day, () => route());
}

/* ---------------- full grid ---------------- */
async function gridView(rosterId) {
  view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  const rosters = await db.rosters();
  if (!rosters.length) {
    view.innerHTML = '<div class="no-today"><strong>Nothing here yet.</strong><div>An admin can upload a roster CSV.</div></div>';
    return;
  }
  const t = todayISO();
  let roster = rosterId ? rosters.find(r => r.id === rosterId) : null;
  if (!roster) roster = rosters.find(r => r.month_anchor.slice(0, 7) === t.slice(0, 7)) || rosters[0];
  const days = await db.days(roster.id);
  const cols = gridColumns(days);
  const admin = isAdmin();
  const byId = {};
  days.forEach(d => byId[d.id] = d);

  const selector = rosters.length > 1
    ? `<select id="month-select" aria-label="Month">${rosters.map(r =>
        `<option value="${r.id}" ${r.id === roster.id ? "selected" : ""}>${esc(monthTitle(r.month_anchor))}</option>`).join("")}</select>`
    : `<span class="month-note">${esc(monthTitle(roster.month_anchor))}</span>`;

  view.innerHTML = `
    <div class="grid-head">
      <h1 class="grid-title">Full grid</h1>
      ${selector}
      ${admin ? `<div class="month-tools">
        <button class="btn primary" id="t-upload">Upload CSV</button>
        <button class="btn quiet" id="t-download">Download CSV</button>
      </div>` : ""}
    </div>
    <div class="gridwrap">
      <table class="grid">
        <thead><tr><th class="stamp-col" aria-label="Date"><span class="th-day">Day</span></th>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${days.map(day => gridRow(day, cols, admin, t)).join("") || '<tr><td class="empty-note" colspan="1">No days in this roster yet.</td></tr>'}</tbody>
      </table>
    </div>
    ${admin ? `<input type="file" id="file-csv" accept=".csv,text/csv" style="display:none">` : ""}
  `;

  const sel = $("#month-select");
  if (sel) sel.addEventListener("change", () => { location.hash = "#/grid/" + sel.value; });

  if (!admin) return;

  $("#t-upload").addEventListener("click", () => $("#file-csv").click());
  $("#file-csv").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const parsed = parseRosterCSV(await file.text());
      openConfirmUpload(parsed, roster);
    } catch (err) {
      alert("Couldn't read that file: " + (err.message || err));
    }
  });
  function openConfirmUpload(parsed, current) {
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
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = roster.title.replace(/[^\w -]/g, "").trim() + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  view.querySelectorAll("td[data-edit-slot]").forEach((cell) => {
    const day = byId[cell.dataset.day];
    makeEditable(cell,
      () => slotValue(day, cell.dataset.editSlot),
      (v) => saveSlotValue(day, cell.dataset.editSlot, v),
      {
        label: longDate(day.roster_date) + ", " + cell.dataset.editSlot
      });
  });

  async function refresh() { await gridView(roster.id); }
}

function gridRow(day, cols, admin, today) {
  const cells = cols.map(c => {
    const dv = displayValue(slotValue(day, c));
    const edit = admin ? ` data-edit-slot="${esc(c)}" data-day="${day.id}" title="Tap to change"` : "";
    return `<td${edit}${dv.cls ? ' class="' + dv.cls + '"' : ""}>${esc(dv.text)}</td>`;
  }).join("");
  const cls = (day.is_ph ? "ph" : "") + (day.roster_date === today ? " today" : "");
  return `<tr class="${cls}">
    <td class="stamp-col"><a href="#/d/${day.roster_date}" style="color:inherit">${stampCell(day)}</a></td>
    ${cells}
  </tr>`;
}

/* ---------------- day view ---------------- */
async function dayView(date) {
  view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  const rosters = await db.rosters();
  const match = rosters.find(r => r.month_anchor.slice(0, 7) === date.slice(0, 7));
  if (!match) {
    view.innerHTML = `<div class="error-banner">No roster covers ${esc(longDate(date))}. <a href="#/grid">Back to full grid</a></div>`;
    return;
  }
  const found = await db.dayOn(match.id, date);
  if (!found.length) {
    view.innerHTML = `<div class="error-banner">${esc(monthTitle(match.month_anchor))} has no entry for ${esc(longDate(date))}. <a href="#/grid/${match.id}">Open the month</a></div>`;
    return;
  }
  const day = found[0];
  const editable = isAdmin();
  const d = parseISO(date);
  view.innerHTML = `
    <a class="backlink" href="#/grid/${match.id}">← Full grid</a>
    <div class="dayview-head">
      <span class="dayview-num">${d.getDate()}</span>
      <span>
        <strong style="font-size:17px">${MONTHS[d.getMonth()]} ${d.getFullYear()}</strong>
        <div class="dayview-meta">${esc(day.day_name || MON[d.getDay()])}${day.is_ph ? ' · <span class="ph-stamp">PH</span> public holiday' : " · " + esc(monthTitle(match.month_anchor))}</div>
      </span>
    </div>
    ${daySheet(day, { editable: true })}
    ${editable ? `<div class="dayview-tools">
      <button class="btn quiet" id="t-ph">${day.is_ph ? "Remove PH flag" : "Mark as PH"}</button>
      <button class="btn danger" id="t-destroy">Delete day</button>
    </div>
    <p class="hint">Tap a line to change it.</p>` : ""}
  `;
  if (!editable) return;
  const rebuild = () => dayView(date);
  $("#t-ph").addEventListener("click", () => {
    try { saveDayField(day, "is_ph", !day.is_ph).then(rebuild); }
    catch (err) { alert("Couldn't save: " + err.message); }
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
        try { await db.deleteDay(day.id); closeModal(); location.hash = "#/grid/" + match.id; }
        catch (err) { errInto(m, err); }
      });
    });
  });
  bindSheetEditing(view, day, rebuild);
}

/* cell editing inside a day sheet (today + day view) */
function bindSheetEditing(scope, day, onDone) {
  const cols = gridColumns([day]);
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

/* ---------------- boot ---------------- */
loadHeader().then(route).catch(() => route());
