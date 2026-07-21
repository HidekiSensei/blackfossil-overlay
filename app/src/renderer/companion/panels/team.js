// Team-Panel: Spieler suchen, Spieler-Info, Verwarnungen.
// Entspricht dem "Team"-Dock-Punkt des Overlays (openAdminPanel).
// Die Namensauflösung teilt sich den Code mit dem Overlay (shared/users.js) —
// dort steckt die kniffelige Logik (RP/Steam/Discord, Dedup-Suffix).
import { el } from '../../shared/core.js';
import { userLabel, matchUser, usersFrom } from '../../shared/users.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';
import { initAudit, renderPlayerAudit, renderTeamAudit } from './audit.js';

let C = null;
let tab = 'spieler';
let users = [];

// Frueher Reiter innerhalb eines Team-Panels, jetzt eigene Menuepunkte. Welcher
// Punkt welchen Rang braucht, steht in companion/nav.js; hier bleibt nur die
// Beschriftung.
//
// Die Feinheiten der Backend-Rechte, die dabei leicht untergehen:
//   /admin/users       = staff, aber /admin/user-info = INGAME+ — ein Supporter
//                        darf also suchen, aber kein Profil oeffnen (deshalb
//                        pruefen wir 'team.userInfo' unten nochmal separat).
//   /admin/staff-audit = ADMIN (requireAdminHuman, strenger als Player-Audit:
//                        es zeigt, was jedes Staff-Mitglied getan hat) — darum
//                        liegt Team-Audit in der Gruppe Administration.
const TITLES = {
  spieler: ['Spieler', 'Spieler nachschlagen und Profile öffnen.'],
  warnings: ['Verwarnungen', 'Ausgesprochene Verwarnungen einsehen.'],
  paudit: ['Player-Audit', 'Protokoll dessen, was Spieler getan haben.'],
  taudit: ['Team-Audit', 'Protokoll dessen, was das Team getan hat.'],
};

export function initTeam(ctx) { C = ctx; initAudit(ctx); }

export function renderTeam(root, view) {
  tab = TITLES[view] ? view : 'spieler';
  // Die Audits sind Vollflaechen-Tabellen (eigenes Layout in audit.js): volle
  // Breite/Hoehe, nur die Tabelle scrollt — der cp-pad-narrow-Wrapper hier
  // wuerde beides kaputt machen (max-width 780px + eigener Scroll).
  if (tab === 'paudit') { renderPlayerAudit(root); return; }
  if (tab === 'taudit') { renderTeamAudit(root); return; }
  const [h, s] = TITLES[tab];
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header(h, s)}
    <div id="tmBody"></div>
  </div>`;
  if (tab === 'spieler') renderSearch();
  else renderWarnings();
}

async function ensureUsers() {
  if (users.length) return users;
  try { users = usersFrom(await C.api('GET', '/admin/users')); } catch { users = []; }
  return users;
}

async function renderSearch() {
  const box = el('tmBody');
  box.innerHTML = `
    ${(U.row(
      `<div class="cp-field"><label class="cp-label" for="tmQ">Spieler</label>`
      + `<input id="tmQ" class="cp-input" list="tmList" placeholder="RP-, Steam- oder Discord-Name, SteamID64…" autocomplete="off">`
      + `<datalist id="tmList"></datalist></div>`,
      C.can('team.userInfo')
        ? U.btn('tmGo', 'Lade Spielerliste…', { variant: 'primary', disabled: true })
        : ''))}
    ${C.can('team.userInfo') ? '' : U.hint('Profile öffnen ist Moderatoren und Admins vorbehalten.')}
    <div id="tmResult"></div>`;

  const inp = el('tmQ');
  // Die Spielerliste hat ~1100 Eintraege und braucht einen Moment. Bis sie da ist,
  // bleibt der Button deaktiviert UND beschriftet — sonst klickt man ins Leere und
  // haelt es fuer "nicht gefunden".
  const list = await ensureUsers();
  const go = el('tmGo');
  if (!go) return;   // Tab gewechselt — oder kein Recht, Profile zu oeffnen
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
  if (!u) { out.innerHTML = U.empty('Keinen passenden Spieler gefunden.'); return; }
  out.innerHTML = U.muted('Lade…');
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
    out.innerHTML = (`
      ${U.sec('Spieler')}
      ${U.item(userLabel(u), `SteamID ${d.steamId || u.steamId}${u.discordId ? ` · Discord ${u.discordId}` : ''}`,
        d.rank ? U.badge(d.rank) : '')}
      ${U.item('Live-Dino', dino, online ? U.badge('online', 'ok') : U.badge('offline', 'off'))}
      ${d.points != null ? U.item('Punkte', String(d.points)) : ''}
      ${U.item('Token', toks || '—')}
    `);
  } catch (e) { out.innerHTML = U.muted('Nicht abrufbar: ' + e.message); }
}

// Vollwertige Verwarnungen — Formular + Suche, aus dem Overlay uebernommen
// (renderWarnPane/warnSearch) und ins Companion-Design gebracht: Abschnitte mit
// cp-colhead-Trennlinie, keine Cards. Namensaufloesung ueber die schon geladene
// /admin/users-Liste (ensureUsers + matchUser), nicht per Keystroke-Suche.
async function renderWarnings() {
  const box = el('tmBody');
  box.innerHTML = `
    <div class="cp-colhead">⚠️ User verwarnen</div>
    ${U.hint('Discord-ID, Steam-ID ODER Name reicht — die anderen werden automatisch verknüpft. Die laufende Nummer zählt das System.')}
    ${U.row(U.field('wnDiscord', 'Discord-ID', { placeholder: 'z. B. 4785…' }),
            U.field('wnSteam', 'Steam-ID', { placeholder: '7656…' }))}
    <div class="cp-field"><label class="cp-label" for="wnName">oder Name (RP-, Ingame- oder Discord-Name)</label>
      <input id="wnName" class="cp-input" list="wnNameList" autocomplete="off" placeholder="z. B. Complex-Slayer">
      <datalist id="wnNameList"></datalist></div>
    ${U.field('wnPara', 'Regel-Paragraph *', { placeholder: 'z. B. §3.2 Combat-Logging' })}
    ${U.textarea('wnReason', 'Grund *', 'Was ist passiert?')}
    ${U.btn('wnSubmit', '⚠️ Verwarnen', { variant: 'primary', block: true })}
    <div class="cp-colhead" style="margin-top:var(--cp-s5)">🔎 Verwarnungen durchsuchen</div>
    ${U.row(`<div class="cp-field" style="flex:1"><input id="wnSearch" class="cp-input" placeholder="Name / Steam / Grund / Paragraph…"></div>`,
            U.btn('wnSearchBtn', 'Suchen', { size: 'sm' }))}
    <div id="wnResults"></div>`;

  // Namens-Autocomplete aus der geladenen Nutzerliste (wie im Spieler-Tab).
  const list = await ensureUsers();
  const nm = el('wnName');
  if (nm) nm.oninput = () => {
    const q = nm.value.trim().toLowerCase();
    const dl = el('wnNameList'); if (!dl) return;
    dl.innerHTML = q.length < 2 ? '' : list
      .filter((u) => userLabel(u).toLowerCase().includes(q) || (u.steamId || '').includes(q))
      .slice(0, 30).map((u) => `<option value="${U.esc(userLabel(u))}">`).join('');
  };

  el('wnSubmit').onclick = submitWarn;
  el('wnSearchBtn').onclick = () => warnSearch(el('wnSearch').value.trim());
  el('wnSearch').onkeydown = (e) => { if (e.key === 'Enter') warnSearch(el('wnSearch').value.trim()); };
  warnSearch('');
}

async function submitWarn() {
  const discordId = el('wnDiscord').value.trim();
  let steamId = el('wnSteam').value.trim();
  const name = el('wnName').value.trim();
  const ruleParagraph = el('wnPara').value.trim();
  const reason = el('wnReason').value.trim();
  if (!ruleParagraph || !reason) { C.toast('Paragraph und Grund sind Pflicht.', 'error'); return; }
  // Name → Steam nur, wenn keine ID direkt angegeben.
  if (!discordId && !steamId && name) {
    const u = matchUser(name, users);
    if (!u) { C.toast('Name nicht gefunden — genauer tippen oder SteamID nutzen.', 'error'); return; }
    steamId = u.steamId;
  }
  if (!discordId && !steamId) { C.toast('Discord-/Steam-ID oder Name nötig.', 'error'); return; }
  try {
    await C.api('POST', '/admin/warnings', { discordId, steamId, reason, ruleParagraph });
    C.toast('⚠️ Verwarnung erfasst.', 'success');
    ['wnDiscord', 'wnSteam', 'wnName', 'wnPara', 'wnReason'].forEach((id) => { const e = el(id); if (e) e.value = ''; });
    warnSearch('');
  } catch (e) { C.toast(e.message, 'error'); }
}

async function warnSearch(q) {
  const box = el('wnResults'); if (!box) return;
  box.innerHTML = U.muted('Lade…');
  try {
    const d = await C.api('GET', '/admin/warnings' + (q ? `?q=${encodeURIComponent(q)}` : ''));
    const items = d.items || d.warnings || (Array.isArray(d) ? d : []);
    if (!items.length) { box.innerHTML = U.empty(q ? 'Keine Treffer.' : 'Noch keine Verwarnungen erfasst.'); return; }
    box.innerHTML = `<div class="cp-list">` + items.slice(0, 50).map((w) => {
      const who = w.discordId ? `Discord ${w.discordId}` : (w.steamId ? `Steam ${w.steamId}` : '—');
      const n = w.warnNumber || 0;
      const kind = n >= 3 ? 'warn3' : (n === 2 ? 'warn2' : 'warn1');
      const dt = w.createdAtMs ? new Date(w.createdAtMs).toLocaleDateString('de-DE') : '';
      return `<div class="cp-warn-row">`
        + `<div class="cp-warn-head"><span class="cp-warn-who">${U.esc(who)}</span>`
        + `<span class="cp-warn-num cp-${kind}">${U.esc(String(n))}. Verwarnung</span></div>`
        + `<div class="cp-warn-line">📖 ${U.esc(w.ruleParagraph || '—')}</div>`
        + `<div class="cp-warn-line cp-muted">📝 ${U.esc(w.reason || '—')}</div>`
        + `<div class="cp-warn-meta">${U.esc(w.issuedByName || 'Staff')}${dt ? ' · ' + dt : ''}</div></div>`;
    }).join('') + `</div>`;
  } catch (e) { box.innerHTML = U.muted('Nicht abrufbar: ' + e.message); }
}

