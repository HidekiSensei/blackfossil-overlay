// Team-Panel: Spieler suchen, Spieler-Info, Verwarnungen.
// Entspricht dem "Team"-Dock-Punkt des Overlays (openAdminPanel).
// Die Namensauflösung teilt sich den Code mit dem Overlay (shared/users.js) —
// dort steckt die kniffelige Logik (RP/Steam/Discord, Dedup-Suffix).
import { el } from '../../shared/core.js';
import { userLabel, matchUser, usersFrom } from '../../shared/users.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let tab = 'suche';
let users = [];

const TABS = [
  { id: 'suche', label: 'Spieler' },
  { id: 'warnings', label: 'Verwarnungen' },
];

export function initTeam(ctx) { C = ctx; }

export function renderTeam(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Team', 'Spieler nachschlagen und Verwarnungen einsehen.')}
    ${U.tabs(TABS, tab)}
    <div id="tmBody"></div>
  </div>`;
  root.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; renderTeam(root); };
  });
  if (tab === 'suche') renderSearch(); else renderWarnings();
}

async function ensureUsers() {
  if (users.length) return users;
  try { users = usersFrom(await C.api('GET', '/admin/users')); } catch { users = []; }
  return users;
}

async function renderSearch() {
  const box = el('tmBody');
  box.innerHTML = `
    ${U.card(U.row(
      `<div class="cp-field"><label class="cp-label" for="tmQ">Spieler</label>`
      + `<input id="tmQ" class="cp-input" list="tmList" placeholder="RP-, Steam- oder Discord-Name, SteamID64…" autocomplete="off">`
      + `<datalist id="tmList"></datalist></div>`,
      U.btn('tmGo', 'Lade Spielerliste…', { variant: 'primary', disabled: true })))}
    <div id="tmResult"></div>`;

  const inp = el('tmQ');
  // Die Spielerliste hat ~1100 Eintraege und braucht einen Moment. Bis sie da ist,
  // bleibt der Button deaktiviert UND beschriftet — sonst klickt man ins Leere und
  // haelt es fuer "nicht gefunden".
  const list = await ensureUsers();
  const go = el('tmGo');
  if (!go) return;                       // Tab wurde waehrenddessen gewechselt
  go.disabled = false;
  go.textContent = 'Nachschlagen';
  // Datalist wird beim Tippen dynamisch mit Top-Treffern befuellt: Chromium zeigt
  // bei ~1000 Optionen nicht zuverlaessig alle Vorschlaege an.
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    const dl = el('tmList');
    if (q.length < 2) { dl.innerHTML = ''; return; }
    dl.innerHTML = list
      .filter((u) => userLabel(u).toLowerCase().includes(q) || (u.steamId || '').includes(q))
      .slice(0, 40)
      .map((u) => `<option value="${U.esc(userLabel(u))}"></option>`).join('');
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) lookup(); };
  go.onclick = lookup;
}

async function lookup() {
  const out = el('tmResult');
  const v = el('tmQ').value.trim();
  if (!v) return;
  const u = matchUser(v, users);
  if (!u) { out.innerHTML = U.card(U.empty('Keinen passenden Spieler gefunden.')); return; }
  out.innerHTML = U.card(U.muted('Lade…'));
  try {
    // POST mit JSON-Body, NICHT GET mit Query — so erwartet es das Backend.
    const d = await C.api('POST', '/admin/user-info', { steamId: u.steamId });
    // d.dino ist nur bei online gefuellt; d.dino.online unterscheidet "kein Dino"
    // von "gerade nicht im Spiel".
    const online = d.dino && d.dino.online;
    const dino = online
      ? [baseClass(d.dino.dinoClass), fmtGrow(d.dino.grow)].filter(Boolean).join(' · ')
        + (d.dino.elderReplicationStacks ? ` · Elder ×${d.dino.elderReplicationStacks}` : '')
      : 'Aktuell nicht im Spiel';
    const toks = Object.entries(d.tokens || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ×${n}`).join(', ');
    out.innerHTML = U.card(`
      ${U.sec('Spieler')}
      ${U.item(userLabel(u), `SteamID ${d.steamId || u.steamId}${u.discordId ? ` · Discord ${u.discordId}` : ''}`,
        d.rank ? U.badge(d.rank) : '')}
      ${U.item('Live-Dino', dino, online ? U.badge('online', 'ok') : U.badge('offline', 'off'))}
      ${d.points != null ? U.item('Punkte', String(d.points)) : ''}
      ${U.item('Token', toks || '—')}
    `);
  } catch (e) { out.innerHTML = U.card(U.muted('Nicht abrufbar: ' + e.message)); }
}

async function renderWarnings() {
  const box = el('tmBody');
  box.innerHTML = U.card(U.muted('Lade Verwarnungen…'));
  try {
    const d = await C.api('GET', '/admin/warnings');
    const rows = d.warnings || d.items || (Array.isArray(d) ? d : []);
    box.innerHTML = rows.length
      ? U.card(`<div class="cp-list cp-scroll">` + rows.slice(0, 100).map((wn) => U.item(
          wn.playerName || wn.steamId || '—',
          [wn.reason, wn.createdAt && new Date(wn.createdAt).toLocaleString('de-DE')].filter(Boolean).join(' · '),
          wn.by ? U.badge(wn.by) : '')).join('') + `</div>`)
      : U.card(U.empty('Keine Verwarnungen.'));
  } catch (e) { box.innerHTML = U.card(U.muted('Nicht abrufbar: ' + e.message)); }
}
