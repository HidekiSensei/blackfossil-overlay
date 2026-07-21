// Ankündigung-Panel: Broadcast an alle Spieler ingame.
// Aus dem Overlay-Server-Panel nur die Ansage übernommen
// (POST /admin/server/announce). Companion-Design: Header, keine Card.
import { el } from '../../shared/core.js';
import * as U from '../ui.js';

let C = null;
export function initAnnounce(ctx) { C = ctx; }

export function renderAnnounce(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Ankündigung', 'Eine Nachricht an alle Spieler ingame senden.')}
    ${U.hint('Erscheint als Server-Broadcast für alle, die gerade online sind.')}
    ${U.textarea('anMsg', 'Nachricht', 'Text der Durchsage…')}
    ${U.btn('anSend', '📢 Ankündigung senden', { variant: 'primary', block: true })}
  </div>`;
  el('anSend').onclick = send;
  el('anMsg').focus();
}

async function send() {
  const ta = el('anMsg');
  const msg = (ta.value || '').trim();
  if (!msg) { C.toast('Bitte eine Nachricht eingeben.', 'error'); return; }
  const btn = el('anSend'); btn.disabled = true;
  try {
    await C.api('POST', '/admin/server/announce', { message: msg });
    ta.value = '';
    C.toast('📢 Ankündigung gesendet.', 'success');
  } catch (e) { C.toast(e.message, 'error'); }
  finally { const b = el('anSend'); if (b) b.disabled = false; }
}
