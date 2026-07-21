// UI-Bausteine der Companion.
//
// Zweck: Panels bauen ihr Markup ueber diese Helfer statt ueber handgeschriebene
// Strings mit style="". Dadurch sieht jeder Button, jedes Eingabefeld und jede
// Karte automatisch gleich aus — die Konsistenz steckt in EINER Stelle, nicht in
// hundert Aufrufen. Wer hier eine Variante braucht, erweitert den Baustein.
import { escapeHtml } from '../shared/format.js';

export const esc = escapeHtml;

export function card(inner, mod = '') { return `<div class="cp-card ${mod}">${inner}</div>`; }
export function sec(title) { return `<div class="cp-sec">${esc(title)}</div>`; }
export function hint(t) { return `<div class="cp-hint">${esc(t)}</div>`; }
export function muted(t) { return `<div class="cp-muted">${esc(t)}</div>`; }
export function empty(t) { return `<div class="cp-empty">${esc(t)}</div>`; }

export function btn(id, label, { variant = '', size = '', block = false, disabled = false, title = '' } = {}) {
  const cls = ['cp-btn', variant && `cp-btn-${variant}`, size && `cp-btn-${size}`, block && 'cp-btn-block']
    .filter(Boolean).join(' ');
  return `<button id="${id}" class="${cls}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`;
}

export function field(id, label, { type = 'text', value = '', placeholder = '', min, max } = {}) {
  const attrs = [
    `id="${id}"`, 'class="cp-input"', `type="${type}"`,
    value !== '' && value != null ? `value="${esc(String(value))}"` : '',
    placeholder ? `placeholder="${esc(placeholder)}"` : '',
    min != null ? `min="${min}"` : '', max != null ? `max="${max}"` : '',
  ].filter(Boolean).join(' ');
  return `<div class="cp-field">${label ? `<label class="cp-label" for="${id}">${esc(label)}</label>` : ''}<input ${attrs}></div>`;
}

export function textarea(id, label, placeholder = '') {
  return `<div class="cp-field">${label ? `<label class="cp-label" for="${id}">${esc(label)}</label>` : ''}`
    + `<textarea id="${id}" class="cp-textarea" placeholder="${esc(placeholder)}"></textarea></div>`;
}

export function select(id, label, options, selected) {
  const opts = options.map((o) => {
    const v = typeof o === 'string' ? o : o.value;
    const l = typeof o === 'string' ? o : o.label;
    return `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');
  return `<div class="cp-field">${label ? `<label class="cp-label" for="${id}">${esc(label)}</label>` : ''}`
    + `<select id="${id}" class="cp-select">${opts}</select></div>`;
}

export function check(id, label, checked = false) {
  return `<label class="cp-check"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}> ${esc(label)}</label>`;
}

// Zwei-Punkt-Schieber fuer einen Stundenbereich. Zwei uebereinanderliegende
// range-Elemente — HTML kennt keinen Regler mit zwei Griffen. step=1 sorgt fuers
// Einrasten auf volle Stunden.
//
// Der Bereich darf ueber Mitternacht laufen (z. B. 21 bis 6). Deshalb wird die
// Fuellung in solchen Faellen in ZWEI Stuecke geteilt, statt sie kaputt
// rueckwaerts zu zeichnen.
export function hourRange(idFrom, idTo, label, from, to) {
  return `<div class="cp-field"><label class="cp-label">${esc(label)}</label>`
    + `<div class="cp-hours" data-hours="${idFrom}|${idTo}">`
    + `<div class="cp-hours-track"><div class="cp-hours-fill" data-fill="a"></div>`
    + `<div class="cp-hours-fill" data-fill="b"></div></div>`
    + `<input type="range" id="${idFrom}" min="0" max="23" step="1" value="${from}">`
    + `<input type="range" id="${idTo}" min="0" max="23" step="1" value="${to}">`
    + `</div><div class="cp-hours-val"><span data-hours-label="${idFrom}"></span></div></div>`;
}

// Fuellung und Beschriftung nachziehen. Muss nach dem Einfuegen ins DOM einmal
// aufgerufen werden und haengt sich selbst an die Regler.
export function bindHourRange(root, idFrom, idTo, text) {
  const box = root.querySelector(`[data-hours="${idFrom}|${idTo}"]`);
  if (!box) return;
  const a = box.querySelector('[data-fill="a"]');
  const b = box.querySelector('[data-fill="b"]');
  const f = root.querySelector('#' + idFrom);
  const t = root.querySelector('#' + idTo);
  const lbl = root.querySelector(`[data-hours-label="${idFrom}"]`);
  const pct = (h) => (h / 23) * 100;
  const upd = () => {
    const hf = Number(f.value), ht = Number(t.value);
    if (hf <= ht) {
      a.style.left = pct(hf) + '%'; a.style.width = (pct(ht) - pct(hf)) + '%';
      b.style.width = '0%';
    } else {
      // ueber Mitternacht: zwei Stuecke
      a.style.left = pct(hf) + '%'; a.style.width = (100 - pct(hf)) + '%';
      b.style.left = '0%'; b.style.width = pct(ht) + '%';
    }
    if (lbl) lbl.textContent = text(hf, ht);
  };
  f.oninput = upd; t.oninput = upd;
  upd();
}

export function row(...cells) { return `<div class="cp-row">${cells.join('')}</div>`; }
export function btnRow(...buttons) { return `<div class="cp-btn-row">${buttons.join('')}</div>`; }
// chips = Gruppe gleichrangiger Optionen, alle exakt gleich breit (Grid).
export function chips(...buttons) { return `<div class="cp-chips">${buttons.join('')}</div>`; }

export function badge(text, kind = '') {
  return `<span class="cp-badge ${kind ? `cp-badge-${kind}` : ''}">${esc(text)}</span>`;
}

export function item(title, sub, right = '') {
  return `<div class="cp-item"><div class="cp-item-main">`
    + `<div class="cp-item-title">${esc(title)}</div>`
    + (sub ? `<div class="cp-item-sub">${esc(sub)}</div>` : '')
    + `</div>${right}</div>`;
}

export function tabs(items, active) {
  return `<div class="cp-tabs">` + items.map((t) =>
    `<button class="cp-tab${t.id === active ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('') + `</div>`;
}

// Aufklappbarer Abschnitt. <details> statt eigener Logik: das Auf- und Zuklappen
// kann der Browser selbst, inklusive Tastaturbedienung.
export function expander(title, inner, open = false) {
  return `<details class="cp-exp"${open ? ' open' : ''}>`
    + `<summary class="cp-exp-head">${esc(title)}</summary>`
    + `<div class="cp-exp-body">${inner}</div></details>`;
}

export function header(title, sub) {
  return `<div class="cp-h1">${esc(title)}</div>` + (sub ? `<p class="cp-sub">${esc(sub)}</p>` : '');
}
