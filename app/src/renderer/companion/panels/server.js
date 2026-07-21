// Server-Panel: Status, Ansage, Wartung, Server-Steuerung.
// Entspricht dem "Server"-Dock-Punkt des Overlays (openSrvPanel), aber auf dem
// Companion-Baukasten statt auf Inline-Styles.
import { el, armConfirm } from '../../shared/core.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let statusTimer = null;

export function initServer(ctx) { C = ctx; }

export function renderServer(root) {
  // Rechte 1:1 wie im Backend (internal/admin/admin_server.go):
  //   announce/status = staff · wipecorpses = ingame+ · control = admin
  const mayWipe = C.can('server.wipe');
  const mayControl = C.can('server.control');
  const mayAnnounce = C.can('server.announce');

  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Server', 'Status, Ansagen und Steuerung des Spielservers.')}

    ${U.sec('Status')}
    ${U.card(`<div id="svStatus" class="cp-muted">Lade…</div>
      <div id="svPlayers" class="cp-list cp-scroll"></div>`)}

    ${mayAnnounce ? U.sec('Ansage') + U.card(U.textarea('svMsg', 'Nachricht an alle Spieler', 'Text der Durchsage…')
      + `<div style="height:var(--cp-s3)"></div>`
      + U.btn('svSend', 'Ansage senden', { variant: 'primary', block: true })) : ''}

    ${mayWipe ? U.sec('Wartung') + U.card(
      U.btn('svWipe', 'Kadaver leeren', { block: true })
      + U.hint('Entfernt alle Leichen auf der Karte. Zweimal klicken zum Bestätigen.')) : ''}

    ${mayControl ? U.sec('Server-Steuerung') + U.card(
      U.btnRow(
        U.btn('svStart', 'Start', { variant: 'primary' }),
        U.btn('svRestart', 'Neustart'),
        U.btn('svStop', 'Stopp', { variant: 'danger' }))
      + U.hint('Neustart und Stopp trennen ALLE Spieler. Jeweils zweimal klicken zum Bestätigen.'),
      'cp-card-danger') : ''}
  </div>`;

  // Nur binden, was auch gerendert wurde.
  { const b = el('svSend'); if (b) b.onclick = sendAnnounce; }
  // Alle destruktiven Aktionen laufen ueber dieselbe Zwei-Klick-Bestaetigung —
  // kein Sonderweg pro Button.
  bindArmed('svWipe', 'Kadaver wirklich leeren?', () => post('/admin/server/wipecorpses', {}, 'Kadaver geleert'));
  bindArmed('svStart', 'Server starten?', () => post('/admin/server/control', { action: 'start' }, 'Start ausgelöst'));
  bindArmed('svRestart', 'Wirklich neu starten?', () => post('/admin/server/control', { action: 'restart' }, 'Neustart ausgelöst'));
  bindArmed('svStop', 'Wirklich stoppen?', () => post('/admin/server/control', { action: 'stop' }, 'Stopp ausgelöst'));

  loadStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(() => { if (C.isActive('server')) loadStatus(); }, 5000);
}

export function stopServer() { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }

function bindArmed(id, confirmLabel, fn) {
  const b = el(id);
  if (b) b.onclick = () => armConfirm(b, confirmLabel, fn);
}

async function post(path, body, okMsg) {
  try { await C.api('POST', path, body); C.toast(okMsg, 'success'); loadStatus(); }
  catch (e) { C.toast(e.message, 'error'); }
}

async function sendAnnounce() {
  const ta = el('svMsg');
  const msg = (ta.value || '').trim();
  if (!msg) { C.toast('Bitte eine Nachricht eingeben.', 'error'); return; }
  try { await C.api('POST', '/admin/server/announce', { message: msg }); ta.value = ''; C.toast('Ansage gesendet', 'success'); }
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
