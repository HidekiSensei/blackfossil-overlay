// Settings der Companion — drei Reiter.
//
// Bis hierher war Settings das einzige Panel als statisches HTML in
// companion.html. Mit dem UI-Reiter kommt Zustand dazu (gewaehltes Theme,
// eigene Farbe), also wird es wie jedes andere Panel gerendert.
//
// Aufteilung bewusst so: "Software" ist alles, was die Anwendung selbst
// betrifft (Version, Update, Was ist neu) — "Konto" ist die Person dahinter.
// Beides in einen Reiter zu werfen, waere die Sorte Sammelkiste, die spaeter
// niemand mehr findet.
import * as U from '../ui.js';
import { escapeHtml } from '../../shared/format.js';
import { THEMES } from '../../shared/theme.js';
import { getUpdate, onUpdateChange, updateText, checkUpdate, downloadUpdate, installUpdate } from '../updates.js';

let C = null;
let tab = 'software';

const TABS = [
  { id: 'software', label: 'Software' },
  { id: 'ui', label: 'Darstellung' },
  { id: 'konto', label: 'Konto' },
];

// ctx: { api, tokenBase(), theme, perms, version(), updates, onLogout, toast }
export function initSettings(ctx) { C = ctx; }

// Von aussen den Software-Reiter vorwaehlen. Genutzt, wenn der rote Punkt in
// der Navigation steht: wer wegen eines Updates auf Settings klickt, will
// nicht erst noch den richtigen Reiter suchen.
export function openSoftwareTab() { tab = 'software'; }

export function renderSettings(root) {
  if (!TABS.some((t) => t.id === tab)) tab = 'software';
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">`
    + U.header('Settings', 'Anwendung und Konto.')
    + U.tabs(TABS, tab)
    + `<div id="cpSetBody"></div></div>`;

  root.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; renderSettings(root); };
  });

  const body = root.querySelector('#cpSetBody');
  if (tab === 'software') renderSoftware(body);
  else if (tab === 'ui') renderUi(body);
  else renderKonto(body);
}

// ── Software ───────────────────────────────────────────────────────────────
function renderSoftware(box) {
  box.innerHTML = U.sec('Version')
    + U.card(`<div class="cp-item"><div class="cp-item-main">`
      + `<div class="cp-item-title">Version <span id="cpVersion">—</span></div>`
      + `<div class="cp-item-sub" id="cpUpdStatus">Bereit</div></div>`
      + U.btn('cpUpdBtn', 'Nach Updates suchen', { size: 'sm' }) + `</div>`)
    + U.sec('Was ist neu')
    + U.card(`<div id="cpNotes" class="cp-scroll">Lade…</div>`);

  C.version().then((v) => {
    const n = box.querySelector('#cpVersion');
    if (n) n.textContent = v;
    loadReleaseNotes(box, v);
  });
  wireUpdates(box);
}

// Der Feed liegt im eigenen Backend (/overlay, Kanal "companion"). Die
// Versionsnummer stammt aus derselben package.json wie das Overlay — beide
// Apps tragen damit zwangslaeufig dieselbe Version.
// Zeigt nur noch an, was companion/updates.js weiss. Frueher registrierte
// diese Funktion die IPC-Zuhoerer selbst — bei jedem Oeffnen des Reiters neu,
// ohne sie je zu entfernen, und vor dem ersten Oeffnen ueberhaupt nicht.
// Meldungen des stuendlichen Timers gingen deshalb verloren.
function wireUpdates(box) {
  const st = box.querySelector('#cpUpdStatus');
  const btn = box.querySelector('#cpUpdBtn');
  if (!st || !btn) return;

  const zeichnen = (u) => {
    if (!st.isConnected) { ab(); return; }   // Reiter gewechselt → abmelden
    st.textContent = updateText(u);
    if (u.state === 'bereit') {
      btn.textContent = 'Neu starten & installieren';
      btn.onclick = () => installUpdate(C.bf);
    } else if (u.state === 'verfuegbar') {
      btn.textContent = 'Herunterladen';
      btn.onclick = () => downloadUpdate(C.bf);
    } else {
      btn.textContent = 'Nach Updates suchen';
      btn.onclick = () => checkUpdate(C.bf);
    }
    btn.disabled = u.state === 'pruefe' || u.state === 'laedt';
  };

  // Abmelden, sobald die Elemente aus dem Dokument fliegen — sonst waechst die
  // Zuhoererliste mit jedem Reiterwechsel.
  const ab = onUpdateChange(zeichnen);
  zeichnen(getUpdate());
}

// Release-Notes kommen aus derselben Datei wie beim Overlay — die Apps laufen
// zusammen und teilen sich eine Version, also auch die Notizen.
async function loadReleaseNotes(box, installed) {
  const el = box.querySelector('#cpNotes');
  if (!el) return;
  try {
    const r = await fetch(`${C.tokenBase()}/overlay/releases.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    const rel = (Array.isArray(list) ? list : list.releases || []).slice(0, 8);
    if (!el.isConnected) return;
    el.innerHTML = rel.length
      ? rel.map((v) => {
          // Version UND Titel zeigen — der Titel allein sagt nicht, welcher
          // Stand gemeint ist, und genau danach sucht man hier.
          const ist = v.version && v.version === String(installed || '').trim();
          return `<div class="cp-rel">`
            + `<div class="cp-rel-head"><span><span class="cp-rel-ver">${escapeHtml(v.version || '')}</span>`
            + `${v.title ? ' ' + escapeHtml(v.title) : ''}</span>`
            + `<span class="cp-rel-date">${ist ? 'installiert' : escapeHtml(v.date || '')}</span></div>`
            + `<div class="cp-rel-body">${notesToHtml(v.notes || '')}</div></div>`;
        }).join('')
      : '<div class="cp-muted">Keine Einträge.</div>';
  } catch (e) {
    if (el.isConnected) el.innerHTML = `<div class="cp-muted">Release-Notes nicht abrufbar (${escapeHtml(e.message)}).</div>`;
  }
}

// Minimaler Markdown-Ersatz: Listenpunkte und Absaetze. Bewusst KEIN
// HTML-Durchreichen — die Notizen kommen zwar aus dem eigenen Backend, aber
// escapen kostet nichts und schliesst die Luecke ganz.
export function notesToHtml(md) {
  // Erst escapen, DANN das bisschen Markup erzeugen — nie andersherum.
  const inline = (t) => escapeHtml(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return String(md).replace(/\r/g, '').split('\n').map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (/^#{1,6}\s+/.test(t)) return `<div class="cp-rel-h">${inline(t.replace(/^#{1,6}\s+/, ''))}</div>`;
    if (/^[-*]\s+/.test(t)) return `<div class="cp-rel-li">${inline(t.replace(/^[-*]\s+/, ''))}</div>`;
    return `<div>${inline(t)}</div>`;
  }).join('');
}

// ── Darstellung ────────────────────────────────────────────────────────────
function renderUi(box) {
  const th = C.theme;
  const cur = th.current();

  const swatches = Object.entries(THEMES).map(([k, t]) => {
    const locked = !th.unlocked(k);
    const tip = locked ? `${t.name} — ab Rang ${th.minTierFor(k)}` : t.name;
    return `<button type="button" class="cp-sw${k === cur ? ' on' : ''}${locked ? ' locked' : ''}"`
      + ` data-theme="${k}" title="${escapeHtml(tip)}"`
      + ` style="--sw-a:${t.accent};--sw-b:${t.accentD}">`
      + `<span class="cp-sw-dot"></span><span class="cp-sw-name">${escapeHtml(t.name)}</span>`
      + `${locked ? '<span class="cp-sw-lock">🔒</span>' : ''}</button>`;
  }).join('');

  const customLocked = !th.unlocked('custom');
  const custom = customLocked
    ? `<div class="cp-hint">Eigene Farbe gibt es ab Rang ${escapeHtml(th.minTierFor('custom'))}.</div>`
    : `<div class="cp-row cp-sw-custom">`
      + `<input type="color" id="cpThemeHex" class="cp-color" value="${escapeHtml(th.customHex())}">`
      + `<div class="cp-item-main"><div class="cp-item-title">Eigene Akzentfarbe</div>`
      + `<div class="cp-item-sub">Heller und dunkler Ton sowie die Flächen werden daraus abgeleitet.</div></div>`
      + `<button type="button" class="cp-btn cp-btn-sm${cur === 'custom' ? ' cp-btn-on' : ''}" id="cpThemeUse">`
      + `${cur === 'custom' ? 'Aktiv' : 'Verwenden'}</button></div>`;

  box.innerHTML = U.sec('Farbschema')
    + U.card(`<div class="cp-sw-grid">${swatches}</div>`)
    + U.sec('Eigene Farbe')
    + U.card(custom)
    + U.hint('Die Einstellung gilt nur für die Companion — das Overlay hat ein eigenes Farbschema.');

  box.querySelectorAll('.cp-sw').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.theme;
      if (!th.unlocked(k)) {
        C.toast(`„${THEMES[k].name}" gibt es ab Rang ${th.minTierFor(k)}.`, 'error');
        return;
      }
      th.apply(k, true);
      renderUi(box);
    };
  });

  const hex = box.querySelector('#cpThemeHex');
  if (hex) {
    // input feuert waehrend des Ziehens → Vorschau live, aber erst der
    // Abschluss (change) schreibt in den Speicher.
    hex.oninput = () => th.setCustomHex(hex.value);
    hex.onchange = () => renderUi(box);
  }
  const use = box.querySelector('#cpThemeUse');
  if (use) use.onclick = () => { th.apply('custom', true); renderUi(box); };
}

// ── Konto ──────────────────────────────────────────────────────────────────
function renderKonto(box) {
  const p = C.perms();
  box.innerHTML = U.sec('Angemeldet als')
    + U.card(U.item(p.name || '—', p.rank || '', U.btn('cpLogout', 'Abmelden', { size: 'sm' })));
  const b = box.querySelector('#cpLogout');
  if (b) b.onclick = () => C.onLogout();
}
