// Verschiebbare Flaeche ueber der Karte.
//
// Bewusst KEIN echtes Fenster und kein <dialog>: die Karte soll sichtbar und
// bedienbar bleiben, waehrend das Panel offen ist. Es ist ein div im
// Karten-Wrapper, das per Titelleiste gezogen wird.
//
// Gemeinsam genutzt von der Spielerliste und dem Erstellen/Bearbeiten-Editor —
// deshalb liegt es hier und nicht im jeweiligen Panel.
import { escapeHtml } from '../shared/format.js';

const open = new Map();   // id -> Element

export function floatingPanel(id, { title, body, host, x = 60, y = 60, width = 280, onClose }) {
  close(id);
  const wrap = host || document.getElementById('cpMapWrap');
  if (!wrap) return null;

  const el = document.createElement('div');
  el.className = 'cp-float';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.width = width + 'px';
  el.innerHTML = `<div class="cp-float-bar"><span class="cp-float-title">${escapeHtml(title)}</span>`
    + `<button class="cp-float-x" aria-label="Schließen">✕</button></div>`
    + `<div class="cp-float-body"></div>`;
  el.querySelector('.cp-float-body').append(body);
  wrap.appendChild(el);
  open.set(id, el);

  el.querySelector('.cp-float-x').onclick = () => { close(id); if (onClose) onClose(); };

  // Ziehen an der Titelleiste. Bewegung wird auf window gehoert, damit das
  // Ziehen nicht abreisst, wenn der Zeiger die Leiste kurz verlaesst.
  const bar = el.querySelector('.cp-float-bar');
  let dx = 0, dy = 0, dragging = false;
  bar.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('cp-float-x')) return;
    dragging = true;
    // clientX/Y sind Viewport-Koordinaten, left/top dagegen relativ zum Wrapper.
    // Ohne dessen Offset (Sidebar + Leiste) springt das Panel beim Anfassen.
    const r = wrap.getBoundingClientRect();
    dx = e.clientX - r.left - el.offsetLeft;
    dy = e.clientY - r.top - el.offsetTop;
    e.preventDefault();          // sonst startet die Textauswahl
  });
  const move = (e) => {
    if (!dragging) return;
    const r = wrap.getBoundingClientRect();
    // Im Wrapper halten, aber die Titelleiste immer greifbar lassen.
    el.style.left = Math.min(r.width - 60, Math.max(0, e.clientX - r.left - dx)) + 'px';
    el.style.top = Math.min(r.height - 30, Math.max(0, e.clientY - r.top - dy)) + 'px';
  };
  const up = () => { dragging = false; };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  el._cleanup = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  return el;
}

export function close(id) {
  const el = open.get(id);
  if (!el) return;
  if (el._cleanup) el._cleanup();
  el.remove();
  open.delete(id);
}

export function isOpen(id) { return open.has(id); }
export function toggle(id, make) { return isOpen(id) ? (close(id), null) : make(); }
