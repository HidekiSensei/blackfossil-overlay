// Admin-Panel: Welt-Steuerung (Zeit, Wetter, Wachstum) + Class-Limits.
// Entspricht dem "Admin"-Dock-Punkt des Overlays (openServerPanel, Tab Welt).
// Die spielgebundenen Tabs des Overlays (Karte-Kalibrierung, Gottstimme) fehlen
// hier bewusst — beide setzen einen eigenen Dino im Spiel voraus.
import { el } from '../../shared/core.js';
import { fmtTod } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let tab = 'welt';

// Rechte wie im Backend: Welt = admin (WorldRoutes), Limits lesen = jeder
// Angemeldete (/dino-limits), Betrieb = admin (internal/ops h.require).
// Frueher Reiter, jetzt eigene Menuepunkte (companion/nav.js) — die
// Rechte-Zuordnung steht dort, hier nur die Beschriftung.
const TITLES = {
  welt: ['Welt', 'Welt-Einstellungen des laufenden Servers.'],
  ops: ['Betrieb', 'Zustand der Dienste hinter dem Server.'],
};

// Beschriftungen der Health-Checks. Das Backend liefert nur die ids.
const OPS_LABEL = {
  db: 'Datenbank',
  mod_api: 'Mod-API (Poller)',
  game_process: 'Game-Server',
  control_server: 'Game-Box (control)',
  livekit: 'Voice (LiveKit)',
  peer_backend: 'Peer-Backend',
};
const WEATHER = ['clear', 'clouds', 'rain', 'storm', 'fog', 'snow', 'auto'];

export function initAdmin(ctx) { C = ctx; }

export function renderAdmin(root, view) {
  tab = TITLES[view] ? view : 'welt';
  const [h, s] = TITLES[tab];
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header(h, s)}
    <div id="adBody"></div>
  </div>`;
  if (tab === 'welt') renderWelt();
  else renderOps();
}

async function renderWelt() {
  const box = el('adBody');
  box.innerHTML = U.card(U.muted('Lade Welt-Zustand…'));
  let d = {};
  try { d = await C.api('GET', '/admin/world/time'); }
  catch (e) { box.innerHTML = U.card(U.muted('Welt-Zustand nicht abrufbar: ' + e.message)); return; }

  const tod = Number(d.time ?? d.timeOfDay ?? 12);
  const darfWipen = C.can('server.wipe');

  // Alles auf einer Seite statt in Reitern: es sind drei kurze Bloecke, und
  // beim Einstellen einer Welt will man Uhrzeit, Wetter und Wachstum
  // nebeneinander sehen, nicht nacheinander aufrufen. Uebertitel und
  // Trennlinien gliedern, ohne etwas zu verstecken.
  box.innerHTML = `
    ${U.gruppe('Umwelt', 'Tageszeit und Wetter des laufenden Servers.')}
    ${U.sec('Tageszeit')}
    ${U.card(`
      <div class="cp-row">
        <div class="cp-field">
          <label class="cp-label" for="adTod">Uhrzeit — <span id="adTodVal">${fmtTod(tod)}</span></label>
          <input type="range" id="adTod" min="0" max="23.99" step="0.25" value="${tod}">
        </div>
        ${U.btn('adTodSet', 'Setzen', { variant: 'primary' })}
      </div>
      <div style="height:var(--cp-s3)"></div>
      ${U.check('adFreeze', 'Zeit einfrieren (Tag-/Nacht-Zyklus anhalten)', !!d.frozen)}
    `)}

    ${U.sec('Wetter')}
    ${U.card(U.chips(...WEATHER.map((w) => U.btn(`adW_${w}`, w))))}

    ${U.gruppe('Wachstum', 'Betrifft alle Spieler sofort.')}
    ${U.card(U.check('adGrowStop', 'Grow-Stop — Wachstum aller Dinos einfrieren', !!d.growthStopped))}

    ${U.gruppe('Kadaver', 'Herumliegende Leichen und KI-Dinos abräumen.')}
    ${darfWipen
      ? U.card(U.item('Alle Kadaver entfernen',
          'Wirkt serverweit und lässt sich nicht rückgängig machen. Zum Bestätigen zweimal klicken.',
          U.btn('adWipe', 'Kadaver entfernen', { variant: 'danger' })), 'cp-card-danger')
        // Ehrlich bleiben statt eine Zahl erfinden: die Mod liefert in ihrer
        // Statusantwort ein fest verdrahtetes "corpseCount": 0 — es gibt keinen
        // Weg, die tatsaechliche Anzahl zu erfahren. Eine Uebersicht wuerde
        // dauerhaft null anzeigen und waere schlimmer als keine.
        + U.hint('Wie viele Kadaver gerade liegen, meldet der Server nicht — die Mod gibt '
          + 'dort immer 0 zurück. Deshalb steht hier keine Anzahl.')
      : U.hint('Kadaver entfernen ist Moderatoren und Admins vorbehalten.')}
  `;

  const slider = el('adTod');
  slider.oninput = () => { el('adTodVal').textContent = fmtTod(Number(slider.value)); };
  el('adTodSet').onclick = () => send('/admin/world/time', { time: Number(slider.value) }, 'Tageszeit gesetzt');
  el('adFreeze').onchange = (e) => send('/admin/world/time', { frozen: e.target.checked }, e.target.checked ? 'Zeit eingefroren' : 'Zeit läuft wieder');
  el('adGrowStop').onchange = (e) => send('/admin/world/growth-stop', { enabled: e.target.checked }, e.target.checked ? 'Wachstum gestoppt' : 'Wachstum läuft wieder');
  for (const w of WEATHER) el(`adW_${w}`).onclick = () => send('/admin/world/weather', { weather: w }, `Wetter: ${w}`);

  const wipe = el('adWipe');
  if (wipe) wipe.onclick = () => {
    // Zwei Klicks: serverweit und nicht umkehrbar.
    if (wipe.dataset.armed) {
      delete wipe.dataset.armed;
      wipe.disabled = true;
      wipe.textContent = 'Räume auf…';
      C.api('POST', '/admin/server/wipecorpses', {})
        .then(() => C.toast('Kadaver geleert.', 'success'))
        .catch((e) => C.toast('Fehlgeschlagen: ' + e.message, 'error'))
        .finally(() => { wipe.disabled = false; wipe.textContent = 'Kadaver entfernen'; });
      return;
    }
    wipe.dataset.armed = '1';
    wipe.textContent = 'Sicher? Kadaver leeren';
    setTimeout(() => {
      if (!wipe.dataset.armed) return;
      delete wipe.dataset.armed;
      wipe.textContent = 'Kadaver entfernen';
    }, 2500);
  };
}


async function send(path, body, okMsg) {
  try { await C.api('POST', path, body); C.toast(okMsg, 'success'); }
  catch (e) { C.toast(e.message, 'error'); }
}


// ── Betrieb: Health-Matrix + Versionen. Read-only-Diagnose ohne SSH. ───────
async function renderOps() {
  const box = el('adBody');
  box.innerHTML = U.card(U.muted('Lade Betriebszustand…'));
  let health, versions;
  try {
    // Parallel, aber einzeln fehlertolerant: faellt eine Quelle aus, soll die
    // andere trotzdem etwas zeigen — im Zweifel ist genau die kaputte
    // interessant.
    [health, versions] = await Promise.all([
      C.api('GET', '/admin/ops/health').catch((e) => ({ error: e.message, status: e.status })),
      C.api('GET', '/admin/ops/version').catch((e) => ({ error: e.message, status: e.status })),
    ]);
  } catch (e) { box.innerHTML = U.card(U.muted('Nicht abrufbar: ' + e.message)); return; }

  // 404 = Ops-Interface auf dieser Umgebung nicht deployed (Stand jetzt: nur
  // test/dev, nicht Prod). Das ist kein Ausfall und soll nicht wie einer aussehen.
  if (health && health.status === 404 && versions && versions.status === 404) {
    box.innerHTML = U.sec('Betrieb') + U.card(U.empty(
      'Das Betrieb-Interface ist auf dieser Umgebung nicht verfügbar (/admin/ops nicht deployed).'));
    return;
  }

  const checks = (health && health.checks) || [];
  const healthHtml = health && health.error
    ? U.muted('Health nicht abrufbar: ' + health.error)
    : (checks.length
        ? `<div class="cp-list">` + checks.map((c) => U.item(
            OPS_LABEL[c.id] || c.id,
            [c.latencyMs != null ? `${c.latencyMs} ms` : '', c.detail || ''].filter(Boolean).join(' · '),
            U.badge(c.ok ? (c.warn ? 'Warnung' : 'OK') : 'Ausfall', c.ok ? (c.warn ? '' : 'ok') : 'off'))).join('')
          + `</div>`
        : U.empty('Keine Checks gemeldet.'));

  const v = versions && !versions.error ? versions : null;
  const short = (x) => (x ? String(x).slice(0, 7) : '—');
  const vRows = [];
  if (v) {
    const be = v.backend || {};
    if (be.sha) vRows.push(U.item('Backend', `${short(be.sha)} · ${be.branch || ''}`.trim(), be.builtAt ? U.badge(be.builtAt) : ''));
    if (v.mod) vRows.push(U.item('Mod (.asi)', `${short(v.mod.sha)} · ${v.mod.branch || ''}`.trim(), v.mod.builtAt ? U.badge(v.mod.builtAt) : ''));
    if (v.control && v.control.controlServer) vRows.push(U.item('control-server', `seit ${v.control.controlServer.startedAt || '?'}`));
  }
  const versHtml = versions && versions.error
    ? U.muted('Versionen nicht abrufbar: ' + versions.error)
    : (vRows.length ? `<div class="cp-list">${vRows.join('')}</div>` : U.empty('Keine Versionsinfos.'));

  box.innerHTML = U.sec('Status') + U.card(healthHtml)
    + U.sec('Versionen') + U.card(versHtml)
    + U.hint(`Umgebung: ${(health && health.env) || '?'} · Stand ${new Date().toLocaleTimeString('de-DE')}`);
}
