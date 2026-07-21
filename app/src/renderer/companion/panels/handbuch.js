// Handbuch-Panel: Katalog aller Staff-Funktionen — aus dem Overlay übernommen.
// Inhalt kommt aus shared/handbuch.js (dieselbe Quelle wie das Overlay-Handbuch);
// hier steckt nur die Darstellung im Companion-Stil (Split: Suche+Liste links,
// Detail rechts — wie Lexikon/Support).
//
// Angezeigt werden nur Funktionen, die der Rang des Betrachters ausführen darf
// (need vs. C.perms()), genau wie das Overlay-Handbuch (hbCanDo).
import { el } from '../../shared/core.js';
import { HANDBUCH, HB_BADGE } from '../../shared/handbuch.js';
import * as U from '../ui.js';

let C = null;
let sel = null;       // id der gewählten Funktion
let term = '';

export function initHandbuch(ctx) { C = ctx; }

// Rang-Gate je Eintrag — Companion-Pendant zu overlay.js hbCanDo.
function canDo(need) {
  const p = C.perms();
  if (need === 'admin') return !!p.admin;
  if (need === 'ingame') return !!p.ingame;
  return !!p.staff;   // 'staff' und Fallback → jeder mit Staff-Rang
}
function visible() {
  const q = term.trim().toLowerCase();
  return HANDBUCH.filter((f) => canDo(f.need)
    && (!q || f.title.toLowerCase().includes(q) || f.short.toLowerCase().includes(q) || f.cat.toLowerCase().includes(q)));
}
// need → CSS-Klasse für die farbige Rang-Plakette (Farben aus HB_BADGE).
const badgeClass = (need) => `cp-hb-badge cp-hb-${need in HB_BADGE ? need : 'any'}`;
const badgeLabel = (need) => (HB_BADGE[need] || HB_BADGE.any)[0];

export function renderHandbuch(root) {
  root.innerHTML = `<div class="cp-pad">
    ${U.header('Handbuch', 'Alle Funktionen, die du mit deinem Rang ausführen darfst.')}
    <div class="cp-split">
      <div id="hbList" class="cp-split-side"></div>
      <div id="hbDetail" class="cp-split-main"></div>
    </div>
  </div>`;
  renderList();
  renderDetail();
}

function renderList() {
  const box = el('hbList'); if (!box) return;
  const items = visible();
  if (sel && !items.some((f) => f.id === sel)) sel = null;

  const cats = [...new Set(items.map((f) => f.cat))];
  const listHtml = items.length
    ? cats.map((c) => `<div class="cp-hb-cat">${U.esc(c)}</div>`
        + items.filter((f) => f.cat === c).map((f) =>
          `<div class="cp-item cp-item-click${f.id === sel ? ' active' : ''}" data-hb="${U.esc(f.id)}">`
          + `<div class="cp-item-main"><div class="cp-item-title">${U.esc(f.title)}</div>`
          + `<div class="cp-item-sub">${U.esc(f.short)}</div></div>`
          + `<span class="${badgeClass(f.need)}">${U.esc(badgeLabel(f.need))}</span></div>`).join('')).join('')
    : U.empty(term ? 'Keine passende Funktion.' : 'Für deinen Rang sind keine Funktionen hinterlegt.');

  // Analog zum Lexikon links: Suche oben, darunter eine Trennlinie (cp-hb-search),
  // dann die scrollende Liste. Beim Neuaufbau (Filter/Suche) die Scrollposition der
  // Liste erhalten — sonst springt sie hoch.
  const prevScroll = (() => { const l = box.querySelector('.cp-hb-list'); return l ? l.scrollTop : 0; })();
  box.innerHTML = `<div class="cp-hb-search"><input id="hbSearch" class="cp-input" placeholder="🔎 Funktion suchen…" value="${U.esc(term)}"></div>`
    + `<div class="cp-list cp-hb-list">${listHtml}</div>`;
  const listEl = box.querySelector('.cp-hb-list'); if (listEl) listEl.scrollTop = prevScroll;

  const s = el('hbSearch');
  // Cursor-Position halten, damit das Tippen nicht springt (Re-Render bei jedem Zeichen).
  s.oninput = () => { const pos = s.selectionStart; term = s.value; renderList(); const s2 = el('hbSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
  box.querySelectorAll('[data-hb]').forEach((n) => {
    // NUR die Auswahl-Markierung umsetzen (kein Neuaufbau der Liste) — so bleibt
    // die Scrollposition erhalten und der geklickte Eintrag im Blick.
    n.onclick = () => {
      sel = n.dataset.hb;
      box.querySelectorAll('[data-hb].active').forEach((x) => x.classList.remove('active'));
      n.classList.add('active');
      renderDetail();
    };
  });
}

function renderDetail() {
  const box = el('hbDetail'); if (!box) return;
  const f = HANDBUCH.find((x) => x.id === sel);
  if (!f) { box.innerHTML = U.empty('Links eine Funktion wählen.'); return; }

  const li = (arr) => (arr || []).map((x) => `<li>${U.esc(x)}</li>`).join('') || `<li>—</li>`;
  // Analog zum Lexikon rechts: Titel links, Rang-Label rechts, darunter die
  // Trennlinie (cp-hb-topbar spiegelt cp-lex-topbar) — dann der Inhalt.
  box.innerHTML =
    `<div class="cp-hb-topbar">`
      + `<div class="cp-hb-title">${U.esc(f.title)}</div>`
      + `<span class="${badgeClass(f.need)}">${U.esc(badgeLabel(f.need))}</span>`
    + `</div>`
    + `<div class="cp-hb-cat-line">${U.esc(f.cat)}</div>`
    + `<div class="cp-hb-body">${U.esc(f.details || f.short)}</div>`
    + `<div class="cp-sec">📍 Wo</div><ul class="cp-hb-ul">${li(f.where)}</ul>`
    + (f.steps && f.steps.length ? `<div class="cp-sec">🪜 Schritte</div><ol class="cp-hb-ul">${li(f.steps)}</ol>` : '')
    + (f.caveat ? `<div class="cp-hb-caveat"><b>⚠️ Hinweis:</b> ${U.esc(f.caveat)}</div>` : '');
}
