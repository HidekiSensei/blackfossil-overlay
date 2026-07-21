// Server-Steuerung (Gruppe "Server", nur Developer/Owner): Live-Status des
// Spielservers plus Start/Neustart/Stopp. Aus dem alten Companion-"Server"-Panel
// uebernommen — die Ansage ist jetzt "Ankuendigung", das Kadaver-Wipe bleibt in
// der Dino-Verwaltung. Hier zaehlt nur der harte Server-Eingriff.
//
// Rechte: das Nav-Gate (server.tech) haelt Nicht-Techniker fern; das Backend
// gated /admin/server/control zusaetzlich auf admin.
import { el, armConfirm } from '../../shared/core.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let statusTimer = null;

export function initControl(ctx) { C = ctx; }

export function renderControl(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Steuerung', 'Live-Status und Steuerung des Spielservers.')}

    ${U.sec('Status')}
    ${U.card(`<div id="svStatus" class="cp-muted">Lade…</div>
      <div id="svPlayers" class="cp-list cp-scroll"></div>`)}

    ${U.sec('Server-Steuerung')}
    ${U.card(
      U.btnRow(
        U.btn('svStart', 'Start', { variant: 'primary' }),
        U.btn('svRestart', 'Neustart'),
        U.btn('svStop', 'Stopp', { variant: 'danger' }))
      + U.hint('Neustart und Stopp trennen ALLE Spieler. Jeweils zweimal klicken zum Bestätigen.'),
      'cp-card-danger')}
  </div>`;

  // Alle destruktiven Aktionen laufen ueber dieselbe Zwei-Klick-Bestaetigung.
  bindArmed('svStart', 'Server starten?', () => post('/admin/server/control', { action: 'start' }, 'Start ausgelöst'));
  bindArmed('svRestart', 'Wirklich neu starten?', () => post('/admin/server/control', { action: 'restart' }, 'Neustart ausgelöst'));
  bindArmed('svStop', 'Wirklich stoppen?', () => post('/admin/server/control', { action: 'stop' }, 'Stopp ausgelöst'));

  loadStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => { if (C.isActive('control')) loadStatus(); }, 5000);
}

export function stopControl() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

function bindArmed(id, confirmLabel, fn) {
  const b = el(id);
  if (b) b.onclick = () => armConfirm(b, confirmLabel, fn);
}

async function post(path, body, okMsg) {
  try { await C.api('POST', path, body); C.toast(okMsg, 'success'); loadStatus(); }
  catch (e) { C.toast(e.message, 'error'); }
}

async function loadStatus() {
  const box = el('svStatus'); if (!box) return;
  try {
    const d = await C.api('GET', '/admin/server/status');
    const on = !!(d.online ?? d.running);
    box.innerHTML = U.badge(on ? 'Online' : 'Offline', on ? 'ok' : 'off')
      + (d.version ? ' ' + U.badge(String(d.version)) : '')
      + (d.players != null ? ' ' + U.badge(`${d.players} Spieler`) : '');
  } catch (e) { box.innerHTML = U.muted('Status nicht abrufbar: ' + e.message); }
  renderPlayers();
}

function renderPlayers() {
  const box = el('svPlayers'); if (!box) return;
  const list = (C.players() || []).filter((p) => p.steamId);
  box.innerHTML = list.length
    ? list.map((p) => U.item(
        p.name || p.steamId,
        [baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · '),
        p.isDead ? U.badge('tot', 'off') : ''))
      .join('')
    : U.empty('Aktuell niemand online.');
}
