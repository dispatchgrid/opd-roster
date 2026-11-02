/* OPD Roster — data from Supabase (storage only), all logic client-side */
"use strict";

const SUPABASE_URL = "https://iuddpeelzfpbuvyxrrec.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1ZGRwZWVsemZwYnV2eXhycmVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NjAyOTcsImV4cCI6MjEwOTEzNjI5N30.2U0yep_OOiXs5BZ0f5N7dn17fS6nibBJYeAUFzvOZb4";
const PASS_SALT = "opdroster::";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

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
  addDay: (fields) => api("roster_days", { method: "POST", body: JSON.stringify(fields) }),
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
function isAdmin() {
  return !!localStorage.getItem(ADMIN_KEY);
}

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
function toUploadISO(mdy) {
  const p = String(mdy).trim().split("/");
  if (p.length === 3) return p[2].padStart(4, "20").slice(0, 4) + "-" + p[0].padStart(2, "0") + "-" + p[1].padStart(2, "0");
  return String(mdy).trim();
}

/* ---------------- slot columns ---------------- */
function slotColumns(days) {
  const cols = [], seen = new Set();
  for (const d of days) for (const [name] of (d.slots || [])) {
    if (!seen.has(name)) { seen.add(name); cols.push(name); }
  }
  return cols;
}
function slotValue(day, name) {
  const pair = (day.slots || []).find(p => p[0] === name);
  return pair ? pair[1] : "";
}

/* ---------------- modals ---------------- */
const modalRoot = $("#modal-root");
function openModal(html, onMount) {
  modalRoot.innerHTML = '<div class="modal-scrim"><div class="modal" role="dialog" aria-modal="true">' + html + "</div></div>";
  const scrim = $(".modal-scrim", modalRoot);
  scrim.addEventListener("click", (e) => { if (e.target === scrim) closeModal(); });
  const modal = $(".modal", modalRoot);
  if (onMount) onMount(modal);
  const first = $("#modal-root input, #modal-root select", null) || $(".btn", modal);
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
    <p class="sub">Changes show for every viewer immediately.</p>
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

/* ---------------- shared markup ---------------- */
function daySheet(day, opts) {
  const editable = opts && opts.editable && isAdmin();
  const rows = (day.slots || []).map(([name, val]) => {
    const dv = displayValue(val);
    const edit = editable ? ` data-edit-slot="${esc(name)}" title="Tap to change"` : "";
    return `<div class="day-row"${edit}>
      <div class="slot"${edit}>${esc(name)}</div>
      <div class="val ${dv.cls}"${edit}>${esc(dv.text)}</div>
    </div>`;
  }).join("");
  const notes = [];
  if (day.leave) notes.push(["Leave", day.leave]);
  if (day.night_off) notes.push(["Night off", day.night_off]);
  if (day.ph_off) notes.push(["Off (public holiday)", day.ph_off]);
  const foot = notes.length ? `<div class="day-footnotes">${notes.map(([l, v]) =>
    `<div class="day-footnote"><span class="fn-label">${esc(l)}</span><span class="fn-val">${esc(v)}</span></div>`).join("")}</div>` : "";
  return `<div class="day-sheet${day.is_ph ? " is-ph" : ""}">
    <div class="day-rows">${rows}</div>${foot}
  </div>`;
}

function stampCell(day) {
  const d = parseISO(day.roster_date);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}<span class="stamp-day">${esc(day.day_name || MON[d.getDay()])}</span>${day.is_ph ? ' <span class="ph-stamp">PH</span>' : ""}`;
}

/* ---------------- router ---------------- */
const view = $("#view");
async function route() {
  const parts = (location.hash || "#/").slice(2).split("/");
  try {
    if (parts[0] === "m" && parts[1]) await monthView(parts[1]);
    else if (parts[0] === "d" && parts[1]) await dayView(parts[1]);
    else await homeView();
  } catch (e) {
    view.innerHTML = `<div class="error-banner">Couldn't load data — ${esc((e && e.message) || "server unreachable")}. <a href="#/">Retry</a></div>`;
  }
}
window.addEventListener("hashchange", route);

/* ---------------- home ---------------- */
async function homeView() {
  view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  const rosters = await db.rosters();
  const t = todayISO();
  let todayDay = null, todayRoster = null;
  const match = rosters.find(r => r.month_anchor.slice(0, 7) === t.slice(0, 7));
  if (match) {
    const found = await db.dayOn(match.id, t);
    if (found.length) { todayDay = found[0]; todayRoster = match; }
  }

  let todayBlock;
  if (todayDay) {
    const d = parseISO(t);
    todayBlock = `
      <section class="today-block">
        <div class="today-topline">
          <div class="today-date">
            <span class="today-num">${d.getDate()}</span>
            <span><strong style="font-size:16px">${MONTHS[d.getMonth()]} ${d.getFullYear()}</strong>
            <div class="today-meta">${MON[d.getDay()]}${todayDay.is_ph ? ' · <span class="ph-stamp">PH</span> public holiday' : ""}</div></span>
          </div>
          <a class="btn ghost" href="#/d/${t}">Open</a>
        </div>
        ${daySheet(todayDay, { editable: true })}
        ${isAdmin() ? `<div class="today-tools"><a class="btn quiet" href="#/m/${todayRoster.id}">Month grid</a></div>
        <p class="hint">Tap any line above to change it.</p>` : ""}
      </section>`;
  } else {
    const latest = rosters[0];
    todayBlock = `
      <section class="today-block">
        <div class="no-today">
          <strong>No roster for today.</strong>
          ${latest ? `<div>The latest roster is <a href="#/m/${latest.id}">${esc(monthTitle(latest.month_anchor))}</a>.</div>` : "<div>Upload one as admin to get started.</div>"}
        </div>
      </section>`;
  }

  const list = rosters.map(r => {
    const d = parseISO(r.month_anchor);
    return `<a class="roster-row" href="#/m/${r.id}">
      <span class="r-title">${esc(monthTitle(r.month_anchor))}</span>
      <span class="r-sub">${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}</span>
    </a>`;
  }).join("");

  view.innerHTML = `
    ${todayBlock}
    <h2 class="section-label">Rosters</h2>
    <div class="roster-list">${list || '<p class="empty-note">Nothing uploaded yet.</p>'}</div>`;
  if (isAdmin() && todayDay) bindSheetEditing(view, todayDay, () => route());
}

/* ---------------- month view ---------------- */
async function monthView(rosterId) {
  view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  const roster = (await api("rosters?id=eq." + rosterId))[0];
  if (!roster) { view.innerHTML = '<div class="error-banner">That roster no longer exists. <a href="#/">Back home</a></div>'; return; }
  const days = await db.days(rosterId);
  const cols = slotColumns(days);
  const t = todayISO();
  const admin = isAdmin();
  const byId = {};
  days.forEach(d => byId[d.id] = d);

  const rowsHtml = days.map(day => {
    const cells = cols.map(c => {
      const dv = displayValue(slotValue(day, c));
      const edit = admin ? ` data-edit-slot="${esc(c)}" data-day="${day.id}" title="Tap to change"` : "";
      return `<td${edit}>${esc(dv.text)}</td>`;
    }).join("");
    return `<tr class="${day.is_ph ? "ph" : ""}${day.roster_date === t ? " today" : ""}">
      <td class="stamp-col"><a href="#/d/${day.roster_date}" style="color:inherit">${stampCell(day)}</a></td>
      ${cells}
    </tr>`;
  }).join("");

  view.innerHTML = `
    <a class="backlink" href="#/">← All rosters</a>
    <div class="month-head">
      <h1 class="month-title">${esc(monthTitle(roster.month_anchor))}</h1>
      ${admin ? `<div class="month-tools">
        <button class="btn primary" id="t-upload">Upload CSV</button>
        <button class="btn quiet" id="t-download">Download CSV</button>
        <button class="btn quiet" id="t-addday">Add day</button>
        <button class="btn quiet" id="t-cols">Shift columns</button>
        <button class="btn danger" id="t-delete">Delete</button>
      </div>` : ""}
    </div>
    <div class="gridwrap">
      <table class="grid">
        <thead><tr><th class="stamp-col">Date</th>${cols.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${rowsHtml || '<tr><td class="empty-note" colspan="1">No days in this roster yet.</td></tr>'}</tbody>
      </table>
    </div>
    ${admin ? `<input type="file" id="file-csv" accept=".csv,text/csv" style="display:none">` : ""}
  `;

  if (!admin) return;

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
          location.hash = "#/m/" + created.id;
        } catch (err) { errInto(modal, err); }
      });
    });
  }

  $("#t-download").addEventListener("click", () => {
    const head = ["Date", "Day", "Leave", ...cols, "Night Off", "PH OFF", "isPH"];
    const lines = [head.join(",")];
    for (const day of days) {
      const d = parseISO(day.roster_date);
      const row = [
        `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
        day.day_name, day.leave,
        ...cols.map(c => slotValue(day, c)),
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

  $("#t-addday").addEventListener("click", () => openDayEditor(null, rosterId, cols, days, refresh));

  $("#t-cols").addEventListener("click", () => openColsEditor(cols, byId, refresh));

  $("#t-delete").addEventListener("click", () => {
    openModal(`
      <h3>Delete roster</h3>
      <p class="sub">This removes "${esc(roster.title)}" and all its days. There is no undo.</p>
      <div class="modal-actions">
        <button class="btn quiet" data-cancel>Cancel</button>
        <button class="btn danger" id="confirm-del">Delete</button>
      </div>
      <div class="modal-msg"></div>
    `, (modal) => {
      $("[data-cancel]", modal).addEventListener("click", closeModal);
      $("#confirm-del", modal).addEventListener("click", async () => {
        try { await db.deleteRoster(roster.id); closeModal(); location.hash = "#/"; }
        catch (err) { errInto(modal, err); }
      });
    });
  });

  view.querySelectorAll("td[data-edit-slot]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const day = byId[cell.dataset.day];
      cellEditor(day, cell.dataset.editSlot, cols, refresh);
    });
  });

  async function refresh() { await monthView(rosterId); }
}

/* ---------------- day view ---------------- */
async function dayView(date) {
  view.innerHTML = '<p style="color:var(--dim)">Loading…</p>';
  const rosters = await db.rosters();
  const match = rosters.find(r => r.month_anchor.slice(0, 7) === date.slice(0, 7));
  if (!match) {
    view.innerHTML = `<div class="error-banner">No roster covers ${esc(longDate(date))}. <a href="#/">Back home</a></div>`;
    return;
  }
  const found = await db.dayOn(match.id, date);
  if (!found.length) {
    view.innerHTML = `<div class="error-banner">${esc(monthTitle(match.month_anchor))} has no entry for ${esc(longDate(date))}. <a href="#/m/${match.id}">Open the month</a></div>`;
    return;
  }
  const day = found[0];
  const editable = isAdmin();
  const d = parseISO(date);
  view.innerHTML = `
    <a class="backlink" href="#/">← All rosters</a>
    <div class="dayview-head">
      <span class="dayview-num">${d.getDate()}</span>
      <span>
        <strong style="font-size:17px">${MONTHS[d.getMonth()]} ${d.getFullYear()}</strong>
        <div class="dayview-meta">${esc(day.day_name || MON[d.getDay()])}${day.is_ph ? ' · <span class="ph-stamp">PH</span> public holiday' : " · " + esc(monthTitle(match.month_anchor))}</div>
      </span>
    </div>
    ${daySheet(day, { editable: true })}
    <div class="dayview-tools">
      <a class="btn quiet" href="#/m/${match.id}">${esc(monthTitle(match.month_anchor))} grid</a>
      ${editable ? `<button class="btn quiet" id="t-editday">Edit day</button>` : ""}
    </div>
  `;
  if (editable) {
    $("#t-editday").addEventListener("click", () => openDayEditor(day, match.id, slotColumns([day]), null, () => route()));
    bindSheetEditing(view, day, () => route());
  }
}

/* ---------------- editors ---------------- */
function cellEditor(day, slotName, cols, onDone) {
  openModal(`
    <h3>Change duty</h3>
    <p class="sub">${esc(longDate(day.roster_date))}${day.is_ph ? " · PH" : ""}</p>
    <form id="cell-form">
      <div class="field"><label for="c-slot">Shift</label>
        <select id="c-slot">${cols.map(c => `<option ${c === slotName ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
      <div class="field"><label for="c-val">Value</label>
        <input id="c-val" type="text" value="${esc(slotValue(day, slotName))}" placeholder="Any text, "-" or blank"></div>
      <div class="modal-actions">
        <button type="button" class="btn quiet" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
      <div class="modal-msg"></div>
    </form>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
    const inp = $("#c-val", modal);
    inp.focus();
    setTimeout(() => inp.select(), 50);
    $("#cell-form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const slot = $("#c-slot", modal).value;
        const val = $("#c-val", modal).value;
        const slots = (day.slots || []).map(p => p[0] === slotName ? [slot, val] : p);
        if (!slots.some(p => p[0] === slot)) slots.push([slot, val]);
        await db.patchDay(day.id, { slots });
        closeModal();
        onDone();
      } catch (err) { errInto(modal, err); }
    });
  });
}

function openDayEditor(day, rosterId, cols, days, onDone) {
  const isNew = !day;
  const sels = cols.length ? cols : ["8to12", "12to4", "Night"];
  const dateVal = isNew && days && days.length
    ? fmtISO(new Date(parseISO(days[days.length - 1].roster_date).getTime() + 86400000))
    : (day ? day.roster_date : todayISO());
  const slotFields = sels.map(c => `
    <div class="field"><label for="dv-${esc(cssId(c))}">${esc(c)}</label>
      <input id="dv-${esc(cssId(c))}" type="text" value="${esc(isNew ? "" : slotValue(day, c))}"></div>`).join("");
  openModal(`
    <h3>${isNew ? "Add day" : "Edit day"}</h3>
    <p class="sub">Text is saved exactly as typed. Use "-" when there is no duty.</p>
    <form id="day-form">
      <div class="field"><label for="d-date">Date</label>
        <input id="d-date" type="date" value="${esc(dateVal)}"></div>
      <div class="field"><label for="d-day">Day name</label>
        <input id="d-day" type="text" value="${esc(isNew ? "" : day.day_name)}" placeholder="auto from date"></div>
      <div class="field"><label for="d-leave">Leave</label>
        <input id="d-leave" type="text" value="${esc(isNew ? "" : day.leave)}"></div>
      ${slotFields}
      <div class="field"><label for="d-nightoff">Night off</label>
        <input id="d-nightoff" type="text" value="${esc(isNew ? "" : day.night_off)}"></div>
      <div class="field-check"><input id="d-ph" type="checkbox" ${!isNew && day.is_ph ? "checked" : ""}><label for="d-ph" style="margin:0">Public holiday (highlighted)</label></div>
      <div class="field"><label for="d-phoff">Off (public holiday)</label>
        <input id="d-phoff" type="text" value="${esc(isNew ? "" : day.ph_off)}"></div>
      <div class="modal-actions">
        ${!isNew ? '<button type="button" class="btn danger" id="d-del" style="margin-right:auto">Delete day</button>' : ""}
        <button type="button" class="btn quiet" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
      <div class="modal-msg"></div>
    </form>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);
    if (!isNew) {
      $("#d-del", modal).addEventListener("click", () => {
        openModal(`
          <h3>Delete day</h3>
          <p class="sub">Remove ${esc(longDate(day.roster_date))} from the roster?</p>
          <div class="modal-actions">
            <button class="btn quiet" data-cancel2>Cancel</button>
            <button class="btn danger" id="dd-go">Delete</button>
          </div>
        `, (m) => {
          $("[data-cancel2]", m).addEventListener("click", () => m.closest(".modal-scrim").remove());
          $("#dd-go", m).addEventListener("click", async () => {
            try { await db.deleteDay(day.id); closeModal(); onDone(); }
            catch (err) { errInto(m, err); }
          });
        });
      });
    }
    $("#d-date", modal).addEventListener("change", () => {
      const v = $("#d-date", modal).value;
      if (v) $("#d-day", modal).placeholder = MON[parseISO(v).getDay()];
    });
    $("#day-form", modal).addEventListener("submit", async (e) => {
      e.preventDefault();
      const date = $("#d-date", modal).value;
      if (!date) { $(".modal-msg", modal).textContent = "Pick a date."; return; }
      const fields = {
        roster_date: date,
        day_name: $("#d-day", modal).value.trim() || MON[parseISO(date).getDay()],
        leave: $("#d-leave", modal).value.trim(),
        slots: sels.map(c => [c, $("#dv-" + cssId(c), modal).value]),
        night_off: $("#d-nightoff", modal).value.trim(),
        ph_off: $("#d-phoff", modal).value.trim(),
        is_ph: $("#d-ph", modal).checked,
        roster_id: rosterId
      };
      try {
        if (isNew) await db.addDay(fields);
        else await db.patchDay(day.id, fields);
        closeModal(); onDone();
      } catch (err) { errInto(modal, err); }
    });
  });
}

function openColsEditor(cols, byId, onDone) {
  openModal(`
    <h3>Shift columns</h3>
    <p class="sub">Applies to all ${Object.keys(byId).length} days in this roster.</p>
    <div class="col-list">
      ${cols.map((c, i) => `
        <div class="col-item">
          <span class="c-name">${esc(c)}</span>
          <span>
            <button class="btn quiet" data-rename="${i}" style="padding:4px 9px;font-size:12.5px">Rename</button>
            <button class="btn quiet" data-remove="${i}" style="padding:4px 9px;font-size:12.5px;${cols.length < 1 ? "visibility:hidden" : ""}">Remove</button>
          </span>
        </div>`).join("")}
    </div>
    <div class="modal-actions">
      <button class="btn primary" id="col-add">Add column</button>
      <button class="btn quiet" data-cancel>Done</button>
    </div>
    <div class="modal-msg"></div>
  `, (modal) => {
    $("[data-cancel]", modal).addEventListener("click", closeModal);

    async function patchAllDAYS(fn) {
      const updates = [];
      for (const id in byId) {
        const d = byId[id];
        updates.push(db.patchDay(id, { slots: fn(d) }));
      }
      await Promise.all(updates);
    }

    $("#col-add", modal).addEventListener("click", async () => {
      const n = window.prompt("New column name (e.g. 4to6III):");
      if (n === null) return;
      const name = n.trim();
      if (!name || cols.includes(name)) { $(".modal-msg", modal).textContent = "Name is empty or already used."; return; }
      try { await patchAllDAYS(d => (d.slots || []).concat([[name, ""]])); closeModal(); onDone(); }
      catch (err) { errInto(modal, err); }
    });

    $("[data-rename]", modal).forEach(btn => btn.addEventListener("click", async () => {
      const old = cols[Number(btn.dataset.rename)];
      const r = window.prompt("Rename " + old + " to:", old);
      if (r === null) return;
      const name = r.trim();
      if (!name || (name !== old && cols.includes(name))) { $(".modal-msg", modal).textContent = "Name is empty or already used."; return; }
      try { await patchAllDAYS(d => (d.slots || []).map(p => p[0] === old ? [name, p[1]] : p)); closeModal(); onDone(); }
      catch (err) { errInto(modal, err); }
    }));

    $("[data-remove]", modal).forEach(btn => btn.addEventListener("click", () => {
      const name = cols[Number(btn.dataset.remove)];
      openModal(`
        <h3>Remove column</h3>
        <p class="sub">"${esc(name)}" will be removed from every day. Values in it are lost.</p>
        <div class="modal-actions">
          <button class="btn quiet" data-cancel2>Cancel</button>
          <button class="btn danger" id="col-rm-go">Remove</button>
        </div>
        <div class="modal-msg"></div>
      `, (m) => {
        $("[data-cancel2]", m).addEventListener("click", () => m.closest(".modal-scrim").remove());
        $("#col-rm-go", m).addEventListener("click", async () => {
          try { await patchAllDAYS(d => (d.slots || []).filter(p => p[0] !== name)); m.closest(".modal-scrim").remove(); closeModal(); onDone(); }
          catch (err) { errInto(m, err); }
        });
      });
    }));
  });
}

/* cell editing inside a day sheet (home/day view) */
function bindSheetEditing(scope, day, onDone) {
  const cols = slotColumns([day]);
  scope.querySelectorAll("[data-edit-slot]").forEach(el => {
    el.addEventListener("click", () => cellEditor(day, el.dataset.editSlot, cols, onDone));
  });
}

/* ---------------- boot ---------------- */
loadHeader().then(route).catch(() => route());
