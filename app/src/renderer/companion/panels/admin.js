// Admin-Panel: Welt-Steuerung (Zeit, Wetter, Wachstum) + Class-Limits.
// Entspricht dem "Admin"-Dock-Punkt des Overlays (openServerPanel, Tab Welt).
// Die spielgebundenen Tabs des Overlays (Karte-Kalibrierung, Gottstimme) fehlen
// hier bewusst — beide setzen einen eigenen Dino im Spiel voraus.
import { el } from '../../shared/core.js';
import { fmtTod } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let tab = 'welt';

const TABS = [
  { id: 'welt', label: 'Welt' },
  { id: 'limits', label: 'Class-Limits' },
];
const WEATHER = ['clear', 'clouds', 'rain', 'storm', 'fog', 'snow', 'auto'];

export function initAdmin(ctx) { C = ctx; }

export function renderAdmin(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Admin', 'Welt-Einstellungen des laufenden Servers.')}
    ${U.tabs(TABS, tab)}
    <div id="adBody"></div>
  </div>`;
  root.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; renderAdmin(root); };
  });
  if (tab === 'welt') renderWelt(); else renderLimits();
}

async function renderWelt() {
  const box = el('adBody');
  box.innerHTML = U.card(U.muted('Lade Welt-Zustand…'));
  let d = {};
  try { d = await C.api('GET', '/admin/world/time'); }
  catch (e) { box.innerHTML = U.card(U.muted('Welt-Zustand nicht abrufbar: ' + e.message)); return; }

  const tod = Number(d.time ?? d.timeOfDay ?? 12);
  box.innerHTML = `
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

    ${U.sec('Wachstum')}
    ${U.card(U.check('adGrowStop', 'Grow-Stop — Wachstum aller Dinos einfrieren', !!d.growthStopped)
      + U.hint('Betrifft alle Spieler sofort.'))}
  `;

  const slider = el('adTod');
  slider.oninput = () => { el('adTodVal').textContent = fmtTod(Number(slider.value)); };
  el('adTodSet').onclick = () => send('/admin/world/time', { time: Number(slider.value) }, 'Tageszeit gesetzt');
  el('adFreeze').onchange = (e) => send('/admin/world/time', { frozen: e.target.checked }, e.target.checked ? 'Zeit eingefroren' : 'Zeit läuft wieder');
  el('adGrowStop').onchange = (e) => send('/admin/world/growth-stop', { enabled: e.target.checked }, e.target.checked ? 'Wachstum gestoppt' : 'Wachstum läuft wieder');
  for (const w of WEATHER) el(`adW_${w}`).onclick = () => send('/admin/world/weather', { weather: w }, `Wetter: ${w}`);
}

async function renderLimits() {
  const box = el('adBody');
  box.innerHTML = U.card(U.muted('Lade Limits…'));
  try {
    const d = await C.api('GET', '/admin/dino-limits');
    const limits = d.limits || d || {};
    const names = Object.keys(limits).sort();
    box.innerHTML = names.length
      ? U.card(`<div class="cp-list cp-scroll">` + names.map((sp) =>
          U.item(sp, null, U.badge(String(limits[sp])))).join('') + `</div>`)
        + U.hint('Bearbeiten kommt mit der Übernahme des vollen Editors.')
      : U.card(U.empty('Keine Limits gesetzt.'));
  } catch (e) { box.innerHTML = U.card(U.muted('Limits nicht abrufbar: ' + e.message)); }
}

async function send(path, body, okMsg) {
  try { await C.api('POST', path, body); C.toast(okMsg, 'success'); }
  catch (e) { C.toast(e.message, 'error'); }
}
