// Dino-Verwaltung (Admin): Class-Limits, Kadaver entfernen, Polymorph.
//
// Drei Reiter statt drei Menuepunkte: das sind Teilfunktionen EINER Aufgabe
// ("was laeuft auf dem Server herum"), keine eigenstaendigen Bereiche. Die
// Navigation trennt Bereiche, Reiter trennen Handgriffe darin.
import { el } from '../../shared/core.js';
import { userLabel, matchUser, usersFrom } from '../../shared/users.js';
import * as U from '../ui.js';

let C = null;
let tab = 'limits';
let users = [];

// Bekannte Arten und aktuelle Limits, wie sie zuletzt vom Server kamen.
// `saved` ist die Vergleichsbasis fuers Zuruecksetzen und dafuer, ob es
// ueberhaupt etwas zu speichern gibt.
let species = [];
let saved = {};

const TABS = [
  { id: 'limits', label: 'Class-Limits', cap: 'limits.write' },
  { id: 'corpses', label: 'Kadaver entfernen', cap: 'server.wipe' },
  { id: 'poly', label: 'Polymorph', cap: 'dino.polymorph' },
];

export function initDinos(ctx) { C = ctx; }

export function renderDinos(root) {
  const tabs = TABS.filter((t) => C.can(t.cap));
  if (!tabs.some((t) => t.id === tab)) tab = tabs.length ? tabs[0].id : null;
  // Die Class-Limits sind ein Raster und nutzen die volle Breite; die beiden
  // anderen Reiter sind Formulare und bleiben lesbar gedeckelt.
  const weit = tab === 'limits' ? ' cp-pad-full' : '';
  root.innerHTML = `<div class="cp-pad cp-pad-narrow${weit}">`
    + U.header('Dino-Verwaltung', 'Obergrenzen, Aufräumen und Verwandlungen.')
    + (tabs.length ? U.tabs(tabs, tab) : '')
    + `<div id="dnBody" class="cp-stack"></div></div>`;
  root.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; renderDinos(root); };
  });
  if (tab === 'limits') renderLimits();
  else if (tab === 'corpses') renderCorpses();
  else if (tab === 'poly') renderPoly();
}

// ── Class-Limits ───────────────────────────────────────────────────────────
//
// Die Artenliste kommt vom Backend (Feld `species`), NICHT aus einer lokalen
// Konstante: dort sind es 20 hartkodierte Arten, waehrend species.js 24 fuer
// KI-Encounter kennt und das Lexikon nochmal andere. Wer hier die falsche
// Liste nimmt, bietet Limits fuer Arten an, die der Server gar nicht kennt.
async function renderLimits() {
  const box = el('dnBody');
  box.innerHTML = U.muted('Lade Limits…');
  try {
    const d = await C.api('GET', '/dino-limits');
    species = Array.isArray(d.species) ? d.species : Object.keys(d.limits || {}).sort();
    saved = { ...(d.limits || {}) };
    paintLimits();
  } catch (e) {
    box.innerHTML = U.muted('Limits nicht abrufbar: ' + e.message);
  }
}

function paintLimits() {
  const box = el('dnBody');
  if (!box) return;
  const rows = species.map((sp) => {
    const v = saved[sp];
    return `<div class="cp-dl-row">`
      + `<span class="cp-dl-name">${U.esc(sp)}</span>`
      + `<input type="number" min="1" step="1" class="cp-input cp-dl-in" data-sp="${U.esc(sp)}"`
      + ` value="${v > 0 ? v : ''}" placeholder="∞">`
      + `</div>`;
  }).join('');

  // Kein Karten-Rahmen: die Liste IST der Inhalt dieses Reiters. Eine Umrandung
  // um das einzige Element grenzt nichts von etwas ab.
  box.innerHTML = `<div class="cp-dl-grid">${rows}</div>`
    + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('dnLimSave', 'Speichern', { variant: 'primary', disabled: true })
      + U.btn('dnLimReset', 'Zurücksetzen', { disabled: true })
      + `<span id="dnLimInfo" class="cp-muted"></span></div>`
    // Der Hinweis ist keine Floskel: "einparken" klingt harmlos, ist in der Mod
    // aber ein Kill mit Rueckkehr zur Charakterauswahl (ClassLimits-Enforcement,
    // 90 s Karenz, trifft den JUENGSTEN Dino der Art).
    + U.hint('Leeres Feld = unbegrenzt. Über dem Limit wird nach 90 Sekunden der '
      + 'jüngste Dino dieser Art zwangsweise eingeparkt — das ist ein Kill mit '
      + 'Rückkehr zur Charakterauswahl, kein blosses Wegsetzen.');

  const inputs = [...box.querySelectorAll('.cp-dl-in')];
  const current = () => {
    const out = {};
    for (const i of inputs) {
      const n = parseInt(i.value, 10);
      // Nur echte Obergrenzen senden. 0 waere eine Falle: die Datenbank nimmt es
      // an, der Abgleich zum Spielserver ueberspringt es aber (nur > 0 wird
      // gespiegelt) — das Limit stuende dann in der DB, wirkte im Spiel aber nicht.
      if (Number.isFinite(n) && n > 0) out[i.dataset.sp] = n;
    }
    return out;
  };
  // Kanonisch vergleichen, NICHT per JSON.stringify auf den rohen Objekten:
  // dessen Ausgabe haengt an der Schluesselreihenfolge. Der Server liefert die
  // Limits in seiner Reihenfolge, meine Felder stehen in Artenreihenfolge —
  // damit galt das Formular direkt nach dem Laden als geaendert.
  const dirty = () => canon(current()) !== canon(clean(saved));

  const refresh = () => {
    const d = dirty();
    el('dnLimSave').disabled = !d;
    el('dnLimReset').disabled = !d;
    const n = Object.keys(current()).length;
    el('dnLimInfo').textContent = `${n} von ${species.length} begrenzt` + (d ? ' · ungespeichert' : '');
  };
  inputs.forEach((i) => { i.oninput = refresh; });
  refresh();

  el('dnLimReset').onclick = () => { paintLimits(); };
  el('dnLimSave').onclick = async () => {
    const btn = el('dnLimSave');
    btn.disabled = true;
    try {
      // Voll-Ersatz: das Backend loescht alles und schreibt genau das Gesendete.
      // Deshalb IMMER die komplette Karte schicken — wer hier nur Aenderungen
      // sendet, loescht stillschweigend alle uebrigen Limits.
      const d = await C.api('POST', '/admin/dino-limits', { limits: current() });
      saved = { ...(d.limits || {}) };
      paintLimits();
      C.toast('Class-Limits gespeichert.', 'success');
    } catch (e) {
      btn.disabled = false;
      C.toast('Speichern fehlgeschlagen: ' + e.message, 'error');
    }
  };
}

// Nur Eintraege > 0 — dieselbe Normalisierung wie beim Senden, damit der
// Vergleich "geaendert?" nicht an einer 0 aus der Datenbank haengenbleibt.
export function clean(m) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) if (v > 0) out[k] = v;
  return out;
}

// Reihenfolgeunabhaengige Darstellung fuer den Vergleich.
export function canon(m) {
  return Object.entries(m || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('|');
}

// ── Kadaver entfernen ──────────────────────────────────────────────────────
function renderCorpses() {
  const box = el('dnBody');
  box.innerHTML = U.item('Alle Kadaver entfernen',
      'Räumt herumliegende Leichen und KI-Dinos ab. Wirkt serverweit und lässt sich '
      + 'nicht rückgängig machen. Zum Bestätigen zweimal klicken.',
      U.btn('dnWipe', 'Kadaver entfernen', { variant: 'danger' }));

  const btn = el('dnWipe');
  btn.onclick = () => {
    // Zwei-Klick-Bestaetigung wie im Overlay (armConfirm): der erste Klick
    // beschriftet um, der zweite loest aus. Fuer eine serverweite, nicht
    // umkehrbare Aktion ist ein Fehlklick sonst zu billig.
    if (btn.dataset.armed) {
      delete btn.dataset.armed;
      wipe(btn);
      return;
    }
    btn.dataset.armed = '1';
    const t = btn.textContent;
    btn.textContent = 'Sicher? Kadaver leeren';
    setTimeout(() => {
      if (!btn.dataset.armed) return;
      delete btn.dataset.armed;
      btn.textContent = t;
    }, 2500);
  };
}

async function wipe(btn) {
  btn.disabled = true;
  btn.textContent = 'Räume auf…';
  try {
    await C.api('POST', '/admin/server/wipecorpses', {});
    C.toast('Kadaver geleert.', 'success');
  } catch (e) {
    C.toast('Fehlgeschlagen: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Kadaver entfernen';
  }
}

// ── Polymorph ──────────────────────────────────────────────────────────────
//
// Freitextfeld statt Dropdown, und das ist kein Versaeumnis: die Ziele sind
// NPC-TIERE (Chicken, Boar, Deer, Rabbit …), keine spielbaren Dinos. Sie
// stehen deshalb in keiner der Artenlisten, und die Mod loest den Namen erst
// zur Laufzeit gegen die Blueprint-Liste auf. Ein Dropdown waere eine
// erfundene Auswahl.
const PRESETS = [
  { label: '🐔 Kampf-Huhn', cls: 'Chicken', scale: 1, hp: 10000 },
  { label: '🐗 Panzer-Boar', cls: 'Boar', scale: 1, hp: 2000 },
  { label: '🐇 Mini-Hase', cls: 'Rabbit', scale: 0.3, hp: 0 },
];

async function renderPoly() {
  const box = el('dnBody');
  box.innerHTML = U.muted('Lade Spielerliste…');
  if (!users.length) {
    try { users = usersFrom(await C.api('GET', '/admin/users')); } catch { users = []; }
  }
  box.innerHTML = `<div class="cp-field"><label class="cp-label" for="dnPolyUser">Spieler</label>`
    + `<input id="dnPolyUser" class="cp-input" list="dnPolyList" placeholder="RP-, Steam- oder Discord-Name…" autocomplete="off">`
    + `<datalist id="dnPolyList"></datalist></div>`
    + U.field('dnPolyClass', 'Ziel-Tier', { placeholder: 'Chicken, Boar, Deer, Rabbit …' })
    + U.row(
      U.field('dnPolyScale', 'Größe', { type: 'number', value: '1' }),
      U.field('dnPolyHp', 'Max. Leben (optional)', { type: 'number', placeholder: '—' }))
    + U.sec('Vorlagen')
    + U.chips(...PRESETS.map((p, i) => U.btn('dnPre' + i, p.label, { size: 'sm' })))
    + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('dnPolyGo', 'Polymorph anwenden', { variant: 'primary' }) + `</div>`
    + U.hint('Ziele sind NPC-Tiere, keine spielbaren Dinos — der Name wird vom '
      + 'Spielserver aufgelöst. Größer als 1 ist laut Overlay noch nicht funktional. '
      + 'Der Spieler wird dabei neu gesetzt und startet mit vollem Leben.');

  const inp = el('dnPolyUser');
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    const dl = el('dnPolyList');
    if (q.length < 2) { dl.innerHTML = ''; return; }
    dl.innerHTML = users
      .filter((u) => userLabel(u).toLowerCase().includes(q) || (u.steamId || '').includes(q))
      .slice(0, 40)
      .map((u) => `<option value="${U.esc(userLabel(u))}"></option>`).join('');
  };

  PRESETS.forEach((p, i) => {
    el('dnPre' + i).onclick = () => {
      el('dnPolyClass').value = p.cls;
      el('dnPolyScale').value = String(p.scale);
      el('dnPolyHp').value = p.hp ? String(p.hp) : '';
    };
  });

  el('dnPolyGo').onclick = async () => {
    const u = matchUser(el('dnPolyUser').value.trim(), users);
    if (!u) { C.toast('Spieler aus der Liste wählen.', 'error'); return; }
    const cls = el('dnPolyClass').value.trim();
    if (!cls) { C.toast('Ziel-Tier angeben.', 'error'); return; }
    const body = { dinoClass: cls };
    const sc = Number(el('dnPolyScale').value);
    const hp = Number(el('dnPolyHp').value);
    if (Number.isFinite(sc) && sc > 0) body.scale = sc;
    if (Number.isFinite(hp) && hp > 0) body.maxHealth = hp;
    const btn = el('dnPolyGo');
    btn.disabled = true;
    try {
      await C.api('POST', `/admin/players/${encodeURIComponent(u.steamId)}/polymorph`, body);
      C.toast(`${userLabel(u)} → ${cls}`, 'success');
    } catch (e) {
      C.toast('Polymorph fehlgeschlagen: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };
}
