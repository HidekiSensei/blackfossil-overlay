// Support-Panel: Ticket-Liste, Verlauf, Antworten — plus die Staff-Aktionen
// Annehmen und Schliessen.
//
// Anders als im Overlay steht hier die Staff-Sicht im Vordergrund: die
// Companion ist Team-only, wer sie oeffnet will Tickets bearbeiten, nicht
// eigene aufmachen. Das Anlegen eines Tickets fehlt deshalb bewusst.
import { el, armConfirm } from '../../shared/core.js';
import * as U from '../ui.js';

let C = null;
let tickets = [];
let sel = null;      // channelId des offenen Tickets
let poll = null;

export function initSupport(ctx) { C = ctx; }
export function stopSupport() { if (poll) { clearInterval(poll); poll = null; } }

export function renderSupport(root) {
  root.innerHTML = `<div class="cp-pad">
    ${U.header('Support', 'Tickets ansehen, beantworten und bearbeiten.')}
    <div class="cp-split">
      <div id="supList" class="cp-split-side"><div class="cp-colhead">Tickets</div>${U.muted('Lade Tickets…')}</div>
      <div id="supDetail" class="cp-split-main"><div class="cp-colhead">Verlauf</div>${U.empty('Links ein Ticket wählen.')}</div>
    </div>
  </div>`;
  loadTickets();
  stopSupport();
  // Nur solange das Panel offen ist — sonst laeuft der Poll ewig weiter.
  poll = setInterval(() => { if (C.isActive('support')) { loadTickets(); if (sel) loadMessages(true); } }, 15000);
}

async function loadTickets() {
  const box = el('supList'); if (!box) return;
  try {
    const d = await C.api('GET', '/me/tickets');
    tickets = d.tickets || [];
    box.innerHTML = `<div class="cp-colhead">Tickets${tickets.length ? ` <span class="cp-muted">· ${tickets.length}</span>` : ''}</div>`
      + (tickets.length
      ? `<div class="cp-list cp-scroll">` + tickets.map((t) => {
          // lastFromOther = letzte Nachricht kam vom Spieler, nicht vom Team.
          // Bewusst NICHT als "neu/ungelesen" beschriftet: das Overlay vergleicht
          // dafuer zusaetzlich gegen einen lokalen Gelesen-Stand, den es hier nicht
          // gibt — sonst waere jedes Ticket dauerhaft "neu". "Antwort offen" ist
          // ausserdem die fuer Staff nuetzlichere Auskunft.
          const unread = t.lastFromOther ? U.badge('Antwort offen', 'ok') : '';
          return `<div class="cp-item cp-item-click${t.channelId === sel ? ' active' : ''}" data-ch="${U.esc(t.channelId)}">`
            + `<div class="cp-item-main"><div class="cp-item-title">#${U.esc(String(t.ticketId || '—'))} · ${U.esc(t.category || '')}</div>`
            + `<div class="cp-item-sub">${t.handler ? 'bearbeitet von ' + U.esc(t.handler) : 'nicht angenommen'}</div></div>${unread}</div>`;
        }).join('') + `</div>`
      : U.empty('Keine Tickets.'));
    box.querySelectorAll('[data-ch]').forEach((n) => {
      n.onclick = () => { sel = n.dataset.ch; loadTickets(); loadMessages(); };
    });
  } catch (e) { box.innerHTML = `<div class="cp-colhead">Tickets</div>` + U.muted('Nicht abrufbar: ' + e.message); }
}

async function loadMessages(quiet) {
  const box = el('supDetail'); if (!box || !sel) return;
  const t = tickets.find((x) => x.channelId === sel);
  if (!quiet) box.innerHTML = `<div class="cp-colhead">Verlauf</div>` + U.muted('Lade Verlauf…');
  try {
    const d = await C.api('GET', `/me/ticket-messages?channelId=${encodeURIComponent(sel)}`);
    const msgs = d.messages || [];
    box.innerHTML = `
      <div class="cp-colhead">Ticket #${U.esc(String(t ? t.ticketId : ''))} <span class="cp-muted">· ${U.esc(t ? (t.category || '') : '')}</span></div>
      <div id="supMsgs" class="cp-chat cp-scroll">` + (msgs.length
        ? msgs.map((m) => `<div class="cp-msg${m.fromMe ? ' cp-msg-mine' : ''}">`
            + `<div class="cp-msg-who">${U.esc(m.fromMe ? 'Du' : (m.author || '—'))}`
            + `${m.at ? ' · ' + new Date(m.at).toLocaleString('de-DE') : ''}</div>`
            + `<div class="cp-msg-body">${U.esc(m.content || '') || (m.hasAttachment ? '[Anhang]' : '[leer]')}</div></div>`).join('')
        : U.empty('Noch keine Nachrichten.')) + `</div>
      <div class="cp-sup-reply">`
        + U.textarea('supReply', 'Antwort', 'Nachricht an den Spieler…')
        + U.btnRow(
            U.btn('supSend', 'Senden', { variant: 'primary' }),
            // claim/close sind Staff-Aktionen; Spieler sehen nur ihren Verlauf.
            ...(C.can('support.handle') ? [
              U.btn('supClaim', 'Annehmen'),
              U.btn('supClose', 'Schließen', { variant: 'danger' }),
            ] : []))
      + `</div>`;
    const m = el('supMsgs'); if (m) m.scrollTop = m.scrollHeight;
    el('supSend').onclick = send;
    { const b = el('supClaim'); if (b) b.onclick = () => act('/me/ticket-claim', { channelId: sel }, 'Ticket angenommen'); }
    { const cb = el('supClose'); if (cb) cb.onclick = () => armConfirm(cb, 'Wirklich schließen?', () => act('/me/ticket-close', { channelId: sel, reason: '' }, 'Ticket geschlossen')); }
  } catch (e) { box.innerHTML = `<div class="cp-colhead">Verlauf</div>` + U.muted('Nicht abrufbar: ' + e.message); }
}

async function send() {
  const ta = el('supReply');
  const msg = (ta.value || '').trim();
  if (!msg) { C.toast('Bitte eine Nachricht eingeben.', 'error'); return; }
  try {
    await C.api('POST', '/me/ticket-send', { channelId: sel, message: msg });
    ta.value = '';
    loadMessages(true);
  } catch (e) { C.toast(e.message, 'error'); }
}

async function act(path, body, okMsg) {
  try { await C.api('POST', path, body); C.toast(okMsg, 'success'); loadTickets(); loadMessages(true); }
  catch (e) { C.toast(e.message, 'error'); }
}
