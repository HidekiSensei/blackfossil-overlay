// Player-Audit & Team-Audit als echte Tabellen — analog zum Overlay
// (renderAudit/renderTeamAudit in overlay.js), aber im Companion-Idiom:
// cp-*-Klassen statt Inline-Styles, C.api statt fetch+sessionToken.
//
// Layout: volle Breite und Hoehe; Kopf + Filterleiste stehen fest, NUR die
// Tabelle scrollt (sticky thead im Scroll-Container), Fusszeile fest.
//
// Berechtigungen (Nav blendet via caps aus, das Backend prueft nochmal selbst):
//   Player-Audit  /admin/player-audit  = ganzes Staff (requireStaffHuman)
//   Team-Audit    /admin/staff-audit   = NUR Admins   (requireAdminHuman)
// Zusaetzlich clientseitig wie im Overlay: Nicht-Admins bekommen die sensiblen
// duty_on/duty_off-Aktionen nicht im Filter angeboten (PA_ADMIN_ACTIONS).
import { el } from '../../shared/core.js';
import * as U from '../ui.js';

let C = null;
export function initAudit(ctx) { C = ctx; }

const PAGE = 100;
const PA_ADMIN_ACTIONS = new Set(['duty_on', 'duty_off']);

function fmtWhen(ms) {
  return ms ? new Date(Number(ms)).toLocaleString('de-DE') : '—';
}
function fmtDetails(d) {
  if (!d || typeof d !== 'object') return String(d || '');
  return Object.entries(d)
    .map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
}
// SteamID in die Zwischenablage. Klick = User-Geste, daher greift die
// Clipboard-API im Electron-Renderer; Fallback ueber ein verstecktes Textarea.
function copyId(id) {
  if (!id) return;
  const done = () => C.toast('SteamID kopiert: ' + id, 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(id).then(done).catch(() => fallbackCopy(id, done));
  } else { fallbackCopy(id, done); }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  ta.remove();
}
// Klickbare, kopierbare SteamID-Zelle.
function copyIdHtml(id) {
  return id ? `<span class="cp-copyid" data-id="${U.esc(id)}" title="Klicken zum Kopieren">${U.esc(id)}</span>` : '';
}
// Klick-Handler fuer alle .cp-copyid im Container binden.
function bindCopyIds(wrap) {
  wrap.querySelectorAll('.cp-copyid').forEach((s) => {
    s.onclick = (e) => { e.stopPropagation(); copyId(s.dataset.id); };
  });
}

// datetime-local → Unix-Millis ('' → null). Der Input liefert lokale Zeit ohne
// Zone — new Date(value) interpretiert sie lokal, genau richtig fuers Backend (ms).
function msOf(inputId) {
  const v = el(inputId) ? el(inputId).value : '';
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// ── Panel-Zustand (ueberlebt View-Wechsel; die DOM-Filterleiste wird beim
//    Wieder-Betreten daraus neu befuellt) ─────────────────────────────────────
const pa = {
  offset: 0, sort: 'time', order: 'desc',
  name: '', actor: '', steamId: '', dino: '', via: '', actions: new Set(),
  fromMs: null, toMs: null,
  meta: null,          // { actions:[], via:[] } von /admin/player-audit/actions
};
const ta = {
  offset: 0,
  actor: '', action: '', source: '',
  fromMs: null, toMs: null,
};

// ── Gemeinsame Bausteine ────────────────────────────────────────────────────
function thead(cols, state, onSort) {
  return `<thead><tr>` + cols.map((c) => {
    const sortable = !!c.key;
    const active = sortable && state && state.sort === c.key;
    const arrow = active ? (state.order === 'asc' ? ' ▲' : ' ▼') : '';
    const tip = c.title || (sortable ? 'Sortieren' : '');
    return `<th${c.w ? ` style="width:${c.w}"` : ''}`
      + (sortable ? ` class="cp-th-sort" data-sort="${c.key}"` : '')
      + (tip ? ` title="${U.esc(tip)}"` : '')
      + `>${U.esc(c.label)}${arrow}</th>`;
  }).join('') + `</tr></thead>`;
}

function bindSort(wrap, state, reload) {
  wrap.querySelectorAll('[data-sort]').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (state.sort === k) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = k; state.order = 'desc'; }
      state.offset = 0;
      reload();
    };
  });
}

function foot(prefix, state, d, reload) {
  const total = d.total || 0;
  const from = total ? (d.offset || 0) + 1 : 0;
  const to = Math.min((d.offset || 0) + PAGE, total);
  el(prefix + 'Foot').innerHTML =
    U.btn(prefix + 'Prev', '← Zurück', { size: 'sm', disabled: (d.offset || 0) <= 0 })
    + `<span class="cp-muted">${from}–${to} von ${total}</span>`
    + U.btn(prefix + 'Next', 'Weiter →', { size: 'sm', disabled: (d.offset || 0) + PAGE >= total });
  const p = el(prefix + 'Prev'), n = el(prefix + 'Next');
  if (p) p.onclick = () => { state.offset = Math.max(0, state.offset - PAGE); reload(); };
  if (n) n.onclick = () => { state.offset = state.offset + PAGE; reload(); };
}

function tableMsg(wrapId, cols, text) {
  const w = el(wrapId);
  if (w) w.innerHTML = `<table class="cp-table">${thead(cols)}<tbody>`
    + `<tr><td colspan="${cols.length}" class="cp-td-empty">${U.esc(text)}</td></tr></tbody></table>`;
}

// Schnellbereich-Buttons: setzen "von" auf jetzt−X und leeren "bis" (= jetzt).
function bindRanges(root, fromId, toId, apply) {
  root.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      const ms = Number(b.dataset.range);
      const d = new Date(Date.now() - ms);
      // datetime-local erwartet "YYYY-MM-DDTHH:mm" in LOKALER Zeit.
      const pad = (x) => String(x).padStart(2, '0');
      el(fromId).value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      el(toId).value = '';
      apply();
    };
  });
}

// ── Player-Audit ────────────────────────────────────────────────────────────
const PA_COLS = [
  { label: 'Zeit', key: 'time', w: '150px' },
  { label: 'Akteur', w: '190px', title: 'Wer die Aktion ausgelöst hat — bei Kämpfen der Angreifer/Killer (Täter)' },
  { label: 'Aktion', key: 'action', w: '130px' },
  { label: 'Ziel', key: 'name', w: '190px', title: 'Wen die Aktion betrifft — bei Kämpfen das Opfer' },
  { label: 'Dino', key: 'dino', w: '130px' },
  { label: 'Via', w: '90px' },
  { label: 'Details' },
];

function paQuery() {
  const q = new URLSearchParams();
  q.set('limit', String(PAGE)); q.set('offset', String(pa.offset));
  q.set('sort', pa.sort); q.set('order', pa.order);
  if (pa.name) q.set('name', pa.name);
  if (pa.actor) q.set('actor', pa.actor);
  if (pa.steamId) q.set('steamId', pa.steamId);
  if (pa.dino) q.set('dinoClass', pa.dino);
  if (pa.via) q.set('via', pa.via);
  if (pa.actions.size) q.set('action', [...pa.actions].join(','));
  if (pa.fromMs != null) q.set('from', String(pa.fromMs));
  if (pa.toMs != null) q.set('to', String(pa.toMs));
  return q.toString();
}

async function paLoad() {
  tableMsg('paWrap', PA_COLS, 'Lade…');
  let d;
  try { d = await C.api('GET', '/admin/player-audit?' + paQuery()); }
  catch (e) {
    tableMsg('paWrap', PA_COLS, e.status === 403
      ? 'Nicht berechtigt — Player-Audit ist dem Team vorbehalten.'
      : 'Nicht abrufbar: ' + e.message);
    return;
  }
  const items = d.items || [];
  const w = el('paWrap'); if (!w) return;
  // Akteur (Taeter): actorName + kopierbare actor_steam. Leer bei Selbstaktionen
  // (dann tat der Spieler es sich selbst) → dezenter Strich.
  const actorCell = (it) => it.actorSteam
    ? `<div class="cp-td-name">${U.esc(it.actorName || it.actorDiscordName || '—')}</div>${copyIdHtml(it.actorSteam)}`
    : `<span class="cp-muted">—</span>`;
  // Ziel (Opfer/Subjekt): playerName + kopierbare steam_id.
  const targetCell = (it) =>
    `<div class="cp-td-name">${U.esc(it.playerName || it.discordName || '—')}</div>${copyIdHtml(it.steamId)}`;
  w.innerHTML = `<table class="cp-table">${thead(PA_COLS, pa)}<tbody>`
    + (items.length ? items.map((it) => `<tr>`
        + `<td>${fmtWhen(it.createdAtMs)}</td>`
        + `<td>${actorCell(it)}</td>`
        + `<td>${U.esc(it.action || '')}</td>`
        + `<td>${targetCell(it)}</td>`
        + `<td>${U.esc(it.dinoClass || '')}</td>`
        + `<td>${U.badge(it.via || '—')}</td>`
        + `<td class="cp-td-details">${U.esc(fmtDetails(it.details))}</td>`
      + `</tr>`).join('')
      : `<tr><td colspan="${PA_COLS.length}" class="cp-td-empty">Keine Einträge im gewählten Zeitraum/Filter.</td></tr>`)
    + `</tbody></table>`;
  bindSort(w, pa, paLoad);
  bindCopyIds(w);
  foot('pa', pa, d, paLoad);
}

// Aktions-Multi-Select: Knopf + Popup mit Suchfeld und Checkboxen (wie das
// pa-msel-Popup des Overlays). Nicht-Admins sehen duty_on/duty_off nicht.
function paMselHtml() {
  const n = pa.actions.size;
  return `<div class="cp-field"><label class="cp-label">Aktionen</label>`
    + `<div class="cp-msel"><button id="paMselBtn" class="cp-btn cp-btn-sm">${n ? `${n} gewählt` : 'alle'} ▾</button>`
    + `<div id="paMselPop" class="cp-msel-pop" hidden></div></div></div>`;
}

function paMselBind(apply) {
  const btn = el('paMselBtn'), pop = el('paMselPop');
  if (!btn || !pop) return;
  const acts = ((pa.meta && pa.meta.actions) || [])
    .filter((a) => C.perms().admin || !PA_ADMIN_ACTIONS.has(a));
  const draw = (q) => {
    const list = acts.filter((a) => !q || a.toLowerCase().includes(q));
    pop.innerHTML = `<input id="paMselQ" class="cp-input cp-msel-q" placeholder="suchen…" value="${U.esc(q || '')}">`
      + `<div class="cp-msel-list">` + (list.map((a) =>
        `<label class="cp-check cp-msel-item"><input type="checkbox" data-act="${U.esc(a)}"${pa.actions.has(a) ? ' checked' : ''}> ${U.esc(a)}</label>`).join('')
        || `<div class="cp-muted cp-msel-item">keine Treffer</div>`)
      + `</div><button id="paMselClear" class="cp-btn cp-btn-sm cp-btn-block">Auswahl leeren</button>`;
    const qEl = el('paMselQ');
    qEl.oninput = () => { const pos = qEl.selectionStart; draw(qEl.value.trim().toLowerCase()); const q2 = el('paMselQ'); q2.focus(); q2.setSelectionRange(pos, pos); };
    qEl.focus();
    pop.querySelectorAll('[data-act]').forEach((cb) => {
      cb.onchange = () => {
        if (cb.checked) pa.actions.add(cb.dataset.act); else pa.actions.delete(cb.dataset.act);
        btn.textContent = (pa.actions.size ? `${pa.actions.size} gewählt` : 'alle') + ' ▾';
        pa.offset = 0; apply();
      };
    });
    el('paMselClear').onclick = () => { pa.actions.clear(); draw(''); btn.textContent = 'alle ▾'; pa.offset = 0; apply(); };
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (pop.hidden) { draw(''); pop.hidden = false; } else pop.hidden = true;
  };
  // Klick ausserhalb schliesst das Popup (einmalig pro Panel-Aufbau registriert).
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true; });
}

export async function renderPlayerAudit(root) {
  root.innerHTML = `<div class="cp-audit">
    ${U.header('Player-Audit', 'Protokoll dessen, was Spieler getan haben.')}
    <div class="cp-audit-bar" id="paBar"></div>
    <div class="cp-table-wrap" id="paWrap"></div>
    <div class="cp-audit-foot" id="paFoot"></div>
  </div>`;

  // Filter-Metadaten einmal laden (Aktionsliste + via-Werte).
  if (!pa.meta) {
    try { pa.meta = await C.api('GET', '/admin/player-audit/actions'); }
    catch { pa.meta = { actions: [], via: ['overlay', 'service', 'staff', 'system'] }; }
  }
  if (!C.isActive('paudit')) return;   // waehrenddessen weggeklickt

  const vias = (pa.meta.via || []).map((v) => ({ value: v, label: v }));
  const bar = el('paBar');
  bar.innerHTML =
    U.field('paName', 'Ziel / Opfer', { value: pa.name, placeholder: 'Name…' })
    + U.field('paActor', 'Akteur / Täter', { value: pa.actor, placeholder: 'Name oder SteamID…' })
    + U.field('paSteam', 'SteamID (Ziel)', { value: pa.steamId, placeholder: '7656…' })
    + U.field('paDino', 'Dino', { value: pa.dino, placeholder: 'z. B. Rex' })
    + U.select('paVia', 'Via', [{ value: '', label: 'alle' }, ...vias], pa.via)
    + paMselHtml()
    + U.field('paFrom', 'Von', { type: 'datetime-local' })
    + U.field('paTo', 'Bis', { type: 'datetime-local' })
    + `<div class="cp-audit-actions">`
      + `<div class="cp-audit-ranges">`
        + `<button data-range="${3600e3}" class="cp-btn cp-btn-sm">1 h</button>`
        + `<button data-range="${86400e3}" class="cp-btn cp-btn-sm">24 h</button>`
        + `<button data-range="${7 * 86400e3}" class="cp-btn cp-btn-sm">7 T</button>`
      + `</div>`
      + U.btn('paApply', 'Anwenden', { variant: 'primary', size: 'sm' })
      + U.btn('paReset', 'Zurücksetzen', { size: 'sm' })
    + `</div>`;

  const apply = () => {
    pa.name = el('paName').value.trim();
    pa.actor = el('paActor').value.trim();
    pa.steamId = el('paSteam').value.trim();
    pa.dino = el('paDino').value.trim();
    pa.via = el('paVia').value;
    pa.fromMs = msOf('paFrom'); pa.toMs = msOf('paTo');
    pa.offset = 0;
    paLoad();
  };
  el('paApply').onclick = apply;
  el('paReset').onclick = () => {
    pa.name = pa.actor = pa.steamId = pa.dino = pa.via = '';
    pa.actions.clear(); pa.fromMs = pa.toMs = null; pa.offset = 0;
    pa.sort = 'time'; pa.order = 'desc';
    renderPlayerAudit(root);
    // paLoad laeuft am Ende von renderPlayerAudit ohnehin
  };
  bar.querySelectorAll('.cp-input').forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') apply(); }; });
  bindRanges(bar, 'paFrom', 'paTo', apply);
  paMselBind(() => paLoad());

  paLoad();
}

// ── Team-Audit ──────────────────────────────────────────────────────────────
// Backend sortiert fix nach Zeit absteigend — /admin/staff-audit kennt keine
// sort/order-Parameter, deshalb sind die Spaltenkoepfe hier nicht klickbar.
const TA_COLS = [
  { label: 'Zeit', w: '150px' },
  { label: 'Wer', w: '170px' },
  { label: 'Aktion', w: '220px' },
  { label: 'Quelle', w: '90px' },
  { label: 'Details' },
];

function taQuery() {
  const q = new URLSearchParams();
  q.set('limit', String(PAGE)); q.set('offset', String(ta.offset));
  if (ta.actor) q.set('actor', ta.actor);
  if (ta.action) q.set('action', ta.action);
  if (ta.source) q.set('source', ta.source);
  if (ta.fromMs != null) q.set('from', String(ta.fromMs));
  if (ta.toMs != null) q.set('to', String(ta.toMs));
  return q.toString();
}

async function taLoad() {
  tableMsg('taWrap', TA_COLS, 'Lade…');
  let d;
  try { d = await C.api('GET', '/admin/staff-audit?' + taQuery()); }
  catch (e) {
    tableMsg('taWrap', TA_COLS, e.status === 403
      ? 'Nicht berechtigt — Team-Audit ist Admins vorbehalten.'
      : 'Nicht abrufbar: ' + e.message);
    return;
  }
  const items = d.items || [];
  const w = el('taWrap'); if (!w) return;
  w.innerHTML = `<table class="cp-table">${thead(TA_COLS)}<tbody>`
    + (items.length ? items.map((it) => `<tr>`
        + `<td>${fmtWhen(it.createdAtMs)}</td>`
        + `<td>${U.esc(it.actorName || it.actorDiscord || it.actorSteam || 'unbekannt')}</td>`
        + `<td class="cp-td-mono">${U.esc([it.method, it.action].filter(Boolean).join(' '))}</td>`
        + `<td>${U.badge(it.source || '—')}</td>`
        + `<td class="cp-td-details">${U.esc(fmtDetails(it.details))}</td>`
      + `</tr>`).join('')
      : `<tr><td colspan="${TA_COLS.length}" class="cp-td-empty">Keine Einträge im gewählten Zeitraum/Filter.</td></tr>`)
    + `</tbody></table>`;
  foot('ta', ta, d, taLoad);
}

export function renderTeamAudit(root) {
  root.innerHTML = `<div class="cp-audit">
    ${U.header('Team-Audit', 'Protokoll dessen, was das Team getan hat.')}
    <div class="cp-audit-bar" id="taBar"></div>
    <div class="cp-table-wrap" id="taWrap"></div>
    <div class="cp-audit-foot" id="taFoot"></div>
  </div>`;

  const bar = el('taBar');
  bar.innerHTML =
    U.field('taActor', 'Wer', { value: ta.actor, placeholder: 'Staff-Name…' })
    + U.field('taAction', 'Aktion', { value: ta.action, placeholder: 'z. B. gift' })
    + U.select('taSource', 'Quelle', [{ value: '', label: 'alle' },
      { value: 'overlay', label: 'overlay' }, { value: 'discord', label: 'discord' }], ta.source)
    + U.field('taFrom', 'Von', { type: 'datetime-local' })
    + U.field('taTo', 'Bis', { type: 'datetime-local' })
    + `<div class="cp-audit-actions">`
      + `<div class="cp-audit-ranges">`
        + `<button data-range="${86400e3}" class="cp-btn cp-btn-sm">24 h</button>`
        + `<button data-range="${7 * 86400e3}" class="cp-btn cp-btn-sm">7 T</button>`
        + `<button data-range="${30 * 86400e3}" class="cp-btn cp-btn-sm">30 T</button>`
      + `</div>`
      + U.btn('taApply', 'Anwenden', { variant: 'primary', size: 'sm' })
      + U.btn('taReset', 'Zurücksetzen', { size: 'sm' })
    + `</div>`;

  const apply = () => {
    ta.actor = el('taActor').value.trim();
    ta.action = el('taAction').value.trim();
    ta.source = el('taSource').value;
    ta.fromMs = msOf('taFrom'); ta.toMs = msOf('taTo');
    ta.offset = 0;
    taLoad();
  };
  el('taApply').onclick = apply;
  el('taReset').onclick = () => {
    ta.actor = ta.action = ta.source = '';
    ta.fromMs = ta.toMs = null; ta.offset = 0;
    renderTeamAudit(root);
  };
  bar.querySelectorAll('.cp-input').forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') apply(); }; });
  bindRanges(bar, 'taFrom', 'taTo', apply);

  taLoad();
}
