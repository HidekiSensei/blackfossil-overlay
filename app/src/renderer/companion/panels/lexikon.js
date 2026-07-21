// Lexikon: Arten-Nachschlagewerk mit Server-Limits.
// Inhalt kommt aus shared/lexikon.js — dieselbe Quelle, die auch das Overlay
// nutzt. Hier steckt nur die Darstellung; Optik bewusst nah am Overlay-Lexikon
// (Bild-Banner, Diaet-Punkt, gruene Staerken / rote Schwaechen, Tipp-Box).
import { el } from '../../shared/core.js';
import { DINO_LEXIKON, LEX_ORDER, lexOrderedNames } from '../../shared/lexikon.js';
import * as U from '../ui.js';

let C = null;
let sel = null;
let filter = 'all';   // 'all' | 'carni' | 'herbi' | 'both'
let limits = {};

// Labels/Farben identisch zum Overlay (overlay.js DIET_LABEL/DIET_DOT), damit
// beide Oberflaechen dieselbe Sprache sprechen. Farbe steckt in cp-diet-*.
const DIET = { carni: 'Fleischfresser', herbi: 'Pflanzenfresser', both: 'Allesfresser' };
const DIET_ICON = { carni: '🥩', herbi: '🌿', both: '🍽️' };

const imgSrc = (name) => 'assets/dinos/' + encodeURIComponent(name) + '.png';

export function initLexikon(ctx) { C = ctx; }

export function renderLexikon(root) {
  root.innerHTML = `<div class="cp-pad">
    ${U.header('Lexikon', 'Arten, Stärken und Schwächen — mit den aktuellen Server-Limits.')}
    <div class="cp-split">
      <div id="lexList" class="cp-split-side"></div>
      <div id="lexDetail" class="cp-split-main"></div>
    </div>
  </div>`;
  renderList();
  renderDetail();
  // Limits nachladen und danach nur neu zeichnen, wenn das Panel noch offen ist.
  C.api('GET', '/dino-limits').then((d) => {
    limits = d.limits || d || {};
    if (C.isActive('lexikon')) renderDetail();
  }).catch(() => { /* Lexikon bleibt ohne Limits nutzbar */ });
}

function filteredNames() {
  const all = lexOrderedNames();
  return filter === 'all' ? all : all.filter((n) => DINO_LEXIKON[n].diet === filter);
}

function renderList() {
  const names = filteredNames();
  // Auswahl folgt dem Filter: faellt die gewaehlte Art aus der Liste, springt
  // die Auswahl auf den ersten Treffer — Liste und Detail bleiben konsistent.
  if (!sel || !names.includes(sel)) sel = names[0] || null;

  const count = (d) => Object.keys(DINO_LEXIKON).filter((n) => DINO_LEXIKON[n].diet === d).length;
  const tabs = U.tabs([
    { id: 'all',  label: `Alle (${lexOrderedNames().length})` },
    { id: 'carni', label: `${DIET_ICON.carni} ${count('carni')}` },
    { id: 'herbi', label: `${DIET_ICON.herbi} ${count('herbi')}` },
    { id: 'both',  label: `${DIET_ICON.both} ${count('both')}` },
  ], filter);

  const items = names.map((n) => {
    const d = DINO_LEXIKON[n];
    return `<div class="cp-item cp-item-click${n === sel ? ' active' : ''}" data-sp="${U.esc(n)}">`
      + `<img class="cp-lex-thumb" src="${imgSrc(n)}" alt="" onerror="this.style.visibility='hidden'">`
      + `<div class="cp-item-main"><div class="cp-item-title">${U.esc(n)}</div>`
      + `<div class="cp-item-sub"><span class="cp-diet-${d.diet}">●</span> ${U.esc(DIET[d.diet] || '')}</div></div></div>`;
  }).join('') || U.empty('Keine Arten in dieser Gruppe.');

  el('lexList').innerHTML = tabs + U.card(`<div class="cp-list cp-lex-list">${items}</div>`);

  el('lexList').querySelectorAll('[data-tab]').forEach((t) => {
    t.onclick = () => { filter = t.dataset.tab; renderList(); renderDetail(); };
  });
  el('lexList').querySelectorAll('[data-sp]').forEach((n) => {
    n.onclick = () => { sel = n.dataset.sp; renderList(); renderDetail(); };
  });
}

function renderDetail() {
  const box = el('lexDetail'); if (!box) return;
  const d = DINO_LEXIKON[sel];
  if (!d) { box.innerHTML = U.card(U.empty('Keine Art gewählt.')); return; }
  const lim = limits[sel];

  // Blaettern in der aktuellen Filter-Reihenfolge (wie im Overlay).
  const ord = filteredNames();
  const idx = ord.indexOf(sel);
  const prev = ord[(idx - 1 + ord.length) % ord.length];
  const next = ord[(idx + 1) % ord.length];

  const li = (arr) => (arr || []).map((s) => `<li>${U.esc(s)}</li>`).join('');
  box.innerHTML = U.card(
    `<img class="cp-lex-img" src="${imgSrc(sel)}" alt="" onerror="this.style.display='none'">`
    + `<div class="cp-lex-head">${U.esc(sel)} <span class="cp-muted">· ${idx + 1}/${ord.length}</span></div>`
    + `<div class="cp-lex-meta"><span class="cp-diet-${d.diet}">●</span> `
      + `${U.esc(DIET[d.diet] || d.diet)} · <b>${U.esc(d.role || '')}</b> · Wachstum: ${U.esc(d.growth || '—')}`
    + `</div>`
    + `<div class="cp-badge-row">${U.badge(lim ? `Limit ${lim}` : 'kein Limit', lim ? '' : 'ok')}</div>`
    + `<div class="cp-lex-cols">`
      + `<div class="cp-lex-col cp-lex-good"><div class="cp-lex-col-head">Stärken</div><ul>${li(d.strengths)}</ul></div>`
      + `<div class="cp-lex-col cp-lex-bad"><div class="cp-lex-col-head">Schwächen</div><ul>${li(d.weaknesses)}</ul></div>`
    + `</div>`
    + (d.tip ? `<div class="cp-lex-tip">💡 ${U.esc(d.tip)}</div>` : '')
    + (d.fact ? `<div class="cp-lex-fact"><b>📚 Wissenswert</b><br>${U.esc(d.fact)}</div>` : '')
    + `<div class="cp-lex-nav">`
      + `<button id="lexPrev" class="cp-btn">← ${U.esc(prev)}</button>`
      + `<button id="lexNext" class="cp-btn">${U.esc(next)} →</button>`
    + `</div>`);

  const nav = (name) => { sel = name; renderList(); renderDetail(); };
  box.querySelector('#lexPrev').onclick = () => nav(prev);
  box.querySelector('#lexNext').onclick = () => nav(next);
}
