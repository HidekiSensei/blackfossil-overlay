// BlackFossil Companion — Renderer.
//
// Laeuft OHNE Spiel und ohne eigenen Dino: es gibt kein `isYou` in /positions,
// keine Vitals, keine Voice. Alles hier ist rein backend-getrieben.
import { el, makeApi } from './shared/core.js';
import { decoratePositions, buildUserDir } from './shared/players.js';
import { usersFrom } from './shared/users.js';
import { loadMapImage, drawFullMap, setZones, loadZoneLayer, setCalAffine } from './map.js';
import { initServer, renderServer, stopServer } from './companion/panels/server.js';
import { initAdmin, renderAdmin } from './companion/panels/admin.js';
import { initTeam, renderTeam } from './companion/panels/team.js';

let config = { tokenBase: '' };
let sessionToken = null;
let roles = { admin: false, ingame: false, team: false, staff: false, name: '', rank: '' };

const api = makeApi({ tokenBase: () => config.tokenBase, token: () => sessionToken });

// ── Toasts ─────────────────────────────────────────────────────────────────
function toast(msg, kind = '') {
  const box = el('cpToasts'); if (!box) return;
  const d = document.createElement('div');
  d.className = 'cp-toast' + (kind ? ' cp-toast-' + kind : '');
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

// ── Karte ──────────────────────────────────────────────────────────────────
let players = [];
let userDir = new Map();
let zoom = 1, panX = 0, panY = 0;
let dirty = true;             // Dirty-Flag: neu zeichnen nur bei Poll oder Pan/Zoom
let showAll = localStorage.getItem('bf-cp-showall') === '1';
let labelMinZoom = Number(localStorage.getItem('bf-cp-labelzoom') || 1.6);
let lastStat = { total: 0, drawn: 0 };

function render() {
  const cv = el('cpMapCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(zoom, 0, 0, zoom, panX, panY);
  drawFullMap({ ctx, w, h }, players, [], [], null, 1 / zoom, {
    showAll,
    zoom,
    labelMinZoom,
    maxLabels: 60,
    centerX: (w / 2 - panX) / zoom,
    centerY: (h / 2 - panY) / zoom,
    onLabelStats: (s) => { lastStat = s; },
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  updateMapStat();
}

function updateMapStat() {
  const s = el('cpMapStat');
  if (!s) return;
  const alive = players.filter((p) => !p.isDead).length;
  s.textContent = showAll
    ? `${alive} online · ${lastStat.drawn}/${lastStat.total} Tags${zoom < labelMinZoom ? ' (Tags ab höherem Zoom)' : ''}`
    : `${alive} online`;
}

function frame() {
  if (dirty) { dirty = false; render(); }
  requestAnimationFrame(frame);
}

// 1 s statt der 100 ms des Overlays: dort haengt Proximity-Voice und die
// Minimap-Interpolation daran, hier nicht. Fuer eine Staff-Karte ist
// Sub-Sekunden-Frische wertlos — das spart 10x Netz und CPU.
async function pollPositions() {
  try {
    const d = await api('GET', '/positions');
    players = decoratePositions(d.players || [], userDir);
    dirty = true;
  } catch (err) {
    const s = el('cpMapStat');
    if (s) s.textContent = 'Positionen nicht abrufbar: ' + err.message;
  }
}

async function loadUserDir() {
  try { userDir = buildUserDir(usersFrom(await api('GET', '/admin/users'))); }
  catch { /* Karte bleibt nutzbar, nur ohne Discord-Namen im Tag */ }
}

async function loadCalibration() {
  // Die Affine liegt sonst nur in der localStorage des Overlays — eine frische
  // Companion-Installation wuerde ohne das auf Default-Werten stehen.
  try {
    const c = await api('GET', '/calibration');
    if (c && typeof c.a === 'number') setCalAffine(c);
  } catch { /* Default-Kalibrierung */ }
}

async function loadZones() {
  try { setZones(await api('GET', '/zones')); } catch {}
  for (const k of ['sanctuary', 'patrol', 'migration']) { try { await loadZoneLayer(k); } catch {} }
  dirty = true;
}

// ── Karten-Interaktion ─────────────────────────────────────────────────────
function initMapInteraction() {
  const cv = el('cpMapCanvas');
  let dragging = false, lastX = 0, lastY = 0;

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Um den Cursor zoomen, nicht um die Ecke — sonst verliert man beim
    // Reinzoomen sofort die Stelle, die man ansehen wollte.
    const r = cv.getBoundingClientRect();
    const cx = (e.clientX - r.left) * (cv.width / r.width);
    const cy = (e.clientY - r.top) * (cv.height / r.height);
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nz = Math.min(8, Math.max(1, zoom * f));
    panX = cx - (cx - panX) * (nz / zoom);
    panY = cy - (cy - panY) * (nz / zoom);
    zoom = nz;
    clampPan();
    dirty = true;
  }, { passive: false });

  cv.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const r = cv.getBoundingClientRect();
    const sc = cv.width / r.width;
    panX += (e.clientX - lastX) * sc;
    panY += (e.clientY - lastY) * sc;
    lastX = e.clientX; lastY = e.clientY;
    clampPan();
    dirty = true;
  });
}

function clampPan() {
  const cv = el('cpMapCanvas');
  const min = cv.width - cv.width * zoom;
  panX = Math.min(0, Math.max(min, panX));
  panY = Math.min(0, Math.max(min, panY));
}

function resetView() { zoom = 1; panX = 0; panY = 0; dirty = true; }

// ── Panels ─────────────────────────────────────────────────────────────────
// Ein ctx statt globaler Zugriffe: die Panels kennen weder window.bf noch den
// Session-Token. Was sie brauchen, steht hier — und nur das.
let currentView = 'map';
const panelCtx = {
  api,
  toast,
  roles: () => roles,
  players: () => players,
  isActive: (v) => currentView === v,
};
const PANELS = {
  team: renderTeam,
  admin: renderAdmin,
  server: renderServer,
};

// ── Navigation ─────────────────────────────────────────────────────────────
function navTo(view) {
  if (view !== 'server') stopServer();   // Status-Poll haengt am offenen Panel
  currentView = view;
  document.querySelectorAll('.cp-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.cp-view').forEach((s) => { s.hidden = s.dataset.view !== view; });
  if (view === 'map') dirty = true;
  const render = PANELS[view];
  if (render) {
    try { render(document.querySelector(`.cp-view[data-view="${view}"]`)); }
    catch (err) { toast('Panel-Fehler: ' + err.message, 'error'); }
  }
  localStorage.setItem('bf-cp-view', view);
}

// ── Start ──────────────────────────────────────────────────────────────────
function showGate(msg, withLogin) {
  el('cpApp').hidden = true;
  el('cpGate').hidden = false;
  el('cpGateMsg').textContent = msg;
  el('cpGateBtn').hidden = !withLogin;
}

async function boot() {
  config = await window.bf.getConfig();
  sessionToken = await window.bf.getSession();
  el('cpGateBtn').onclick = () => window.bf.openLogin();
  window.bf.onSessionChanged(() => location.reload());
  window.bf.onLoginError((m) => showGate(m, true));

  if (!sessionToken) { showGate('Bitte mit Discord anmelden.', true); return; }

  let t;
  try { t = await api('GET', '/token'); }
  catch (err) { showGate('Anmeldung abgelaufen oder Backend nicht erreichbar: ' + err.message, true); return; }

  roles = {
    admin: !!t.admin, ingame: !!t.ingame, team: !!t.team,
    staff: !!(t.ingame || t.team || t.admin),
    name: t.name || '', rank: t.rank || '',
  };
  // Vorerst bewusst Staff-only — die App zeigt ausschliesslich Moderations-Werkzeuge.
  if (!roles.staff) { showGate('Die Companion-App ist derzeit nur für das Team.', false); return; }

  el('cpGate').hidden = true;
  el('cpApp').hidden = false;
  el('cpWhoName').textContent = roles.name;
  el('cpWhoRank').textContent = roles.rank;
  el('cpSetWho').textContent = roles.name;
  el('cpSetRank').textContent = roles.rank;
  initTeam(panelCtx); initAdmin(panelCtx); initServer(panelCtx);
  window.bf.getVersion().then((v) => { el('cpVersion').textContent = v; });
  el('cpLogout').onclick = () => window.bf.logout();

  document.querySelectorAll('.cp-nav-btn').forEach((b) => { b.onclick = () => navTo(b.dataset.view); });
  // Admin-only-Punkte ausblenden statt deaktivieren — tote Buttons verrotten.
  if (!roles.admin) document.querySelectorAll('.cp-nav-btn[data-view="admin"], .cp-nav-btn[data-view="server"]').forEach((b) => { b.hidden = true; });

  const showAllChk = el('cpShowAll');
  showAllChk.checked = showAll;
  showAllChk.onchange = () => { showAll = showAllChk.checked; localStorage.setItem('bf-cp-showall', showAll ? '1' : '0'); dirty = true; };
  const lz = el('cpLabelZoom');
  lz.value = String(labelMinZoom);
  el('cpLabelZoomVal').textContent = labelMinZoom.toFixed(1) + '×';
  lz.oninput = () => {
    labelMinZoom = Number(lz.value);
    el('cpLabelZoomVal').textContent = labelMinZoom.toFixed(1) + '×';
    localStorage.setItem('bf-cp-labelzoom', String(labelMinZoom));
    dirty = true;
  };
  el('cpMapReset').onclick = resetView;

  navTo(localStorage.getItem('bf-cp-view') || 'map');
  initMapInteraction();
  await loadMapImage('assets/map.jpg');
  dirty = true;
  await loadCalibration();
  loadZones();
  if (roles.staff) await loadUserDir();
  await pollPositions();
  setInterval(pollPositions, 1000);
  setInterval(loadUserDir, 5 * 60 * 1000);
  requestAnimationFrame(frame);
}

boot().catch((e) => showGate('Startfehler: ' + e.message, false));
