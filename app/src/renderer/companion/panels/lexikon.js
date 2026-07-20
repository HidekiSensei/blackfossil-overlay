// Lexikon: Arten-Nachschlagewerk mit Server-Limits.
// Inhalt kommt aus shared/lexikon.js — dieselbe Quelle, die auch das Overlay
// nutzt. Hier steckt nur die Darstellung.
import { el } from '../../shared/core.js';
import { DINO_LEXIKON, lexOrderedNames } from '../../shared/lexikon.js';
import * as U from '../ui.js';

let C = null;
let sel = null;
let limits = {};

const DIET = { carni: 'Fleischfresser', herbi: 'Pflanzenfresser', both: 'Allesfresser' };

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

function renderList() {
  const names = lexOrderedNames();
  if (!sel) sel = names[0];
  el('lexList').innerHTML = U.card(`<div class="cp-list cp-scroll">` + names.map((n) =>
    `<div class="cp-item cp-item-click${n === sel ? ' active' : ''}" data-sp="${U.esc(n)}">`
    + `<div class="cp-item-main"><div class="cp-item-title">${U.esc(n)}</div>`
    + `<div class="cp-item-sub">${U.esc(DIET[DINO_LEXIKON[n].diet] || '')}</div></div></div>`).join('') + `</div>`);
  el('lexList').querySelectorAll('[data-sp]').forEach((n) => {
    n.onclick = () => { sel = n.dataset.sp; renderList(); renderDetail(); };
  });
}

function renderDetail() {
  const box = el('lexDetail'); if (!box) return;
  const d = DINO_LEXIKON[sel];
  if (!d) { box.innerHTML = U.card(U.empty('Keine Art gewählt.')); return; }
  const lim = limits[sel];
  const list = (arr) => (arr || []).map((s) => `<div class="cp-item"><div class="cp-item-main">${U.esc(s)}</div></div>`).join('');
  box.innerHTML = `
    ${U.sec(sel)}
    ${U.card(`<div class="cp-badge-row">`
      + U.badge(DIET[d.diet] || d.diet) + U.badge(d.role || '') + U.badge('Wachstum: ' + (d.growth || '—'))
      + U.badge(lim ? `Limit ${lim}` : 'kein Limit', lim ? '' : 'ok')
      + `</div>`)}
    ${U.sec('Stärken')}${U.card(`<div class="cp-list">${list(d.strengths)}</div>`)}
    ${U.sec('Schwächen')}${U.card(`<div class="cp-list">${list(d.weaknesses)}</div>`)}
    ${d.tip ? U.sec('Tipp') + U.card(U.esc(d.tip)) : ''}
    ${d.fact ? U.sec('Wissenswertes') + U.card(`<span class="cp-muted">${U.esc(d.fact)}</span>`) : ''}`;
}
