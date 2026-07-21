// Tokens (Staff): Dino-Token und PvP-Builds.
//
// Was ein Dino-Token ist: kein Gegenstand im Inventar, sondern ein fertiger
// Dino, der direkt in die Garage des Spielers geschrieben wird. Er parkt ihn
// einfach aus. Das Garagenlimit des Abos wird dabei umgangen.
//
// Was PvP NICHT ist: ein Token. Der Reiter heisst hier trotzdem so, weil er im
// Sprachgebrauch so genannt wird — technisch vergibt er fest kuratierte
// Turnier-Dinos. Alles daran ist vorgegeben: Wachstum 100 %, maennlich, drei
// Elder-Stacks, alle zehn Primes, feste Mutationen. Waehlbar ist nur, WELCHER
// Build. Ein Konfigurationsformular waere hier schlicht gelogen.
import { el } from '../../shared/core.js';
import { userLabel, usersFrom, matchUser } from '../../shared/users.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let tab = 'dino';
let users = [];
let cfg = null;      // /admin/dino-token/config
let pvp = null;      // /admin/pvp/config

// Mutationsauswahl je Generation. Modul-Zustand, damit ein Neuzeichnen der
// Liste die Auswahl nicht verwirft.
const gewaehlt = { base: new Set(), parent: new Set(), elder: new Set() };
let primes = new Set();
// Klappzustand der Mutationen. Ohne das ginge die Klappe bei JEDEM Chip-Klick
// zu, weil das Neuzeichnen das <details> mitsamt seinem Zustand ersetzt —
// man muesste sie nach jeder Auswahl neu oeffnen.
let mutsOffen = false;

// Serverseitige Obergrenzen (staffcfg.Dedup). Das Overlay ist strenger und
// koppelt sie an Primes und Elder-Stacks; das Backend erzwingt das NICHT.
// Hier gilt bewusst die Server-Regel — sonst sperrt die Oberflaeche etwas,
// das erlaubt ist, und behauptet eine Regel, die es nicht gibt.
const CAP = { base: 4, parent: 4, elder: 8 };

const TABS = [
  { id: 'dino', label: 'Dino-Token', cap: 'token.dino' },
  { id: 'pvp', label: 'PvP-Builds', cap: 'token.pvp' },
];

export function initTokens(ctx) { C = ctx; }

export function renderTokens(root) {
  const tabs = TABS.filter((t) => C.can(t.cap));
  if (!tabs.some((t) => t.id === tab)) tab = tabs.length ? tabs[0].id : null;
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">`
    + U.header('Tokens', 'Fertige Dinos in die Garage eines Spielers legen.')
    + (tabs.length ? U.tabs(tabs, tab) : '')
    + `<div id="tkBody" class="cp-stack"></div></div>`;
  root.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; renderTokens(root); };
  });
  if (tab === 'dino') renderDino();
  else if (tab === 'pvp') renderPvp();
}

async function ensureUsers() {
  if (!users.length) {
    try { users = usersFrom(await C.api('GET', '/admin/users')); } catch { users = []; }
  }
  return users;
}

// Spielerfeld mit Vorschlagsliste. Die Datalist wird beim Tippen befuellt:
// Chromium zeigt bei ~1100 Optionen nicht zuverlaessig alle an.
function spielerFeld(id) {
  return `<div class="cp-field"><label class="cp-label" for="${id}">Spieler</label>`
    + `<input id="${id}" class="cp-input" list="${id}L" placeholder="RP-, Steam- oder Discord-Name…" autocomplete="off">`
    + `<datalist id="${id}L"></datalist></div>`;
}

function wireSpielerFeld(id) {
  const inp = el(id);
  if (!inp) return;
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    const dl = el(id + 'L');
    if (q.length < 2) { dl.innerHTML = ''; return; }
    dl.innerHTML = users
      .filter((u) => userLabel(u).toLowerCase().includes(q) || (u.steamId || '').includes(q))
      .slice(0, 40).map((u) => `<option value="${U.esc(userLabel(u))}"></option>`).join('');
  };
}

// ── Dino-Token ─────────────────────────────────────────────────────────────
async function renderDino() {
  const box = el('tkBody');
  box.innerHTML = U.muted('Lade…');
  await ensureUsers();
  if (!cfg) {
    try { cfg = await C.api('GET', '/admin/dino-token/config'); }
    catch (e) { box.innerHTML = U.muted('Konfiguration nicht abrufbar: ' + e.message); return; }
  }
  if (!box.isConnected) return;

  const arten = (cfg.species || []).map((s) => ({ value: s, label: s }));
  box.innerHTML = spielerFeld('tkUser')
    + `<div class="cp-row">`
      + U.select('tkArt', 'Art', arten, arten[0] && arten[0].value)
      + U.select('tkSex', 'Geschlecht', [{ value: 'Male', label: 'Männlich' }, { value: 'Female', label: 'Weiblich' }], 'Male')
    + `</div><div class="cp-row">`
      + U.field('tkGrow', 'Wachstum %', { type: 'number', value: '25', min: 1, max: 100 })
      + U.field('tkElder', 'Elder-Stacks', { type: 'number', value: '0', min: 0, max: 3 })
    + `</div>`
    + `<div id="tkPrimes"></div>`
    + `<div id="tkMuts"></div>`
    + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('tkGive', 'Token geben', { variant: 'primary' })
      + U.btn('tkGarage', 'Garage anzeigen', { size: 'sm' })
    + `</div>`
    + `<div id="tkGarageBox"></div>`
    + U.hint('Der Dino landet direkt in der Garage — das Garagenlimit des Abos wird dabei umgangen.');

  wireSpielerFeld('tkUser');
  zeichnePrimes();
  zeichneMuts();

  el('tkArt').onchange = zeichneMuts;   // Mutationen haengen an der Ernaehrung
  el('tkGive').onclick = tokenGeben;
  el('tkGarage').onclick = garageLaden;
}

function zeichnePrimes() {
  const box = el('tkPrimes');
  if (!box) return;
  const labels = cfg.primeLabels || [];
  box.innerHTML = U.sec(`Prime-Bedingungen (${primes.size}/${labels.length})`)
    + `<div class="cp-chip-wrap">` + labels.map((l, i) => {
      const n = i + 1;
      return `<button type="button" class="cp-chip${primes.has(n) ? ' on' : ''}" data-prime="${n}">${U.esc(l)}</button>`;
    }).join('') + `</div>`;
  box.querySelectorAll('[data-prime]').forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.prime);
      if (primes.has(n)) primes.delete(n); else primes.add(n);
      zeichnePrimes();
    };
  });
}

function zeichneMuts() {
  const box = el('tkMuts');
  if (!box) return;
  const art = el('tkArt') ? el('tkArt').value : '';
  const diet = (cfg.dietBySpecies || {})[art] || 'both';
  const sex = el('tkSex') ? el('tkSex').value : 'Male';
  // Nach Ernaehrung filtern, und weiblich-exklusive nur bei weiblich zeigen —
  // sonst waehlt man etwas, das der Server hinterher verwirft.
  const liste = (cfg.mutations || []).filter((m) => {
    if (m.diet && m.diet !== 'both' && diet !== 'both' && m.diet !== diet) return false;
    if (m.femaleOnly && sex !== 'Female') return false;
    return true;
  });

  const gruppe = (key, titel) => {
    const s = gewaehlt[key];
    return U.sec(`${titel} (${s.size}/${CAP[key]})`)
      + `<div class="cp-chip-wrap">` + liste.map((m) =>
        `<button type="button" class="cp-chip${s.has(m.value) ? ' on' : ''}" data-mut="${key}|${U.esc(m.value)}"`
        + `${m.description ? ` title="${U.esc(m.description)}"` : ''}>${U.esc(m.label || m.value)}</button>`).join('')
      + `</div>`;
  };

  // Zustand VOR dem Ueberschreiben ablesen und danach wiederherstellen.
  const vorher = box.querySelector('details');
  if (vorher) mutsOffen = vorher.open;
  box.innerHTML = U.expander('Mutationen',
    gruppe('base', 'Basis') + gruppe('parent', 'Eltern') + gruppe('elder', 'Elder'), mutsOffen);
  // Manuelles Auf- und Zuklappen merken.
  const det = box.querySelector('details');
  if (det) det.ontoggle = () => { mutsOffen = det.open; };

  box.querySelectorAll('[data-mut]').forEach((b) => {
    b.onclick = () => {
      const [key, val] = b.dataset.mut.split('|');
      const s = gewaehlt[key];
      if (s.has(val)) s.delete(val);
      else if (s.size >= CAP[key]) { C.toast(`Höchstens ${CAP[key]} in dieser Generation.`, 'error'); return; }
      else s.add(val);
      zeichneMuts();
    };
  });
  // Auswahl auch bei Geschlechtswechsel neu bewerten.
  if (el('tkSex')) el('tkSex').onchange = zeichneMuts;
}

function zielSpieler(id) {
  const u = matchUser((el(id).value || '').trim(), users);
  if (!u) { C.toast('Spieler aus der Liste wählen.', 'error'); return null; }
  return u;
}

async function tokenGeben() {
  const u = zielSpieler('tkUser');
  if (!u) return;
  const growPct = Number(el('tkGrow').value);
  if (!Number.isFinite(growPct) || growPct < 1 || growPct > 100) {
    C.toast('Wachstum muss zwischen 1 und 100 liegen.', 'error'); return;
  }
  const btn = el('tkGive');
  btn.disabled = true;
  try {
    const d = await C.api('POST', '/admin/dino-token/create', {
      targetKind: 'user',
      targetSteamId: u.steamId,
      dino: el('tkArt').value,
      gender: el('tkSex').value,
      // Das Backend erwartet 0..1, die Eingabe ist in Prozent.
      grow: growPct / 100,
      elderStacks: Math.max(0, Math.min(3, Number(el('tkElder').value) || 0)),
      primes: [...primes],
      mutations: { base: [...gewaehlt.base], parent: [...gewaehlt.parent], elder: [...gewaehlt.elder] },
    });
    C.toast(`Token an ${userLabel(u)} vergeben${d && d.count ? ` (${d.count})` : ''}.`, 'success');
  } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function garageLaden() {
  const u = zielSpieler('tkUser');
  if (!u) return;
  const box = el('tkGarageBox');
  box.innerHTML = U.muted('Lade Garage…');
  try {
    const d = await C.api('GET', `/admin/dino-token/garage?steamId=${encodeURIComponent(u.steamId)}`);
    const slots = d.slots || [];
    box.innerHTML = U.sec(`Garage von ${userLabel(u)}`) + (slots.length
      ? `<div class="cp-pl-list">` + slots.map((s) => {
          const teile = [baseClass(s.dinoClass), fmtGrow(s.grow), s.gender === 'Female' ? 'weiblich' : 'männlich'];
          if (s.elderStacks) teile.push(`Elder ×${s.elderStacks}`);
          if ((s.primes || []).length) teile.push(`${s.primes.length} Primes`);
          return `<div class="cp-gar-slot">`
            + U.item(s.label || baseClass(s.dinoClass), teile.filter(Boolean).join(' · '),
              U.btn('tkEdit-' + s.id, 'Bearbeiten', { size: 'sm' })
              + U.btn('tkDel-' + s.id, 'Löschen', { size: 'sm', variant: 'danger' }))
            + `<div id="tkForm-${U.esc(s.id)}"></div></div>`;
        }).join('') + `</div>`
      : U.empty('Garage ist leer.'));

    for (const s of slots) {
      const e = el('tkEdit-' + s.id);
      if (e) e.onclick = () => slotBearbeiten(u, s);
      const b = el('tkDel-' + s.id);
      if (!b) continue;
      b.onclick = () => {
        // Zwei Klicks — ein Garage-Slot ist danach weg.
        if (b.dataset.armed) {
          delete b.dataset.armed;
          C.api('POST', '/admin/dino-token/delete', { targetSteamId: u.steamId, slotId: s.id })
            .then(() => { C.toast('Slot gelöscht.', 'success'); garageLaden(); })
            .catch((e) => C.toast('Fehlgeschlagen: ' + e.message, 'error'));
          return;
        }
        b.dataset.armed = '1';
        b.textContent = 'Sicher?';
        setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = 'Löschen'; } }, 2500);
      };
    }
  } catch (e) { box.innerHTML = U.muted('Garage nicht abrufbar: ' + e.message); }
}

// ── PvP-Builds ─────────────────────────────────────────────────────────────
async function renderPvp() {
  const box = el('tkBody');
  box.innerHTML = U.muted('Lade…');
  await ensureUsers();
  if (!pvp) {
    try { pvp = await C.api('GET', '/admin/pvp/config'); }
    catch (e) { box.innerHTML = U.muted('Konfiguration nicht abrufbar: ' + e.message); return; }
  }
  if (!box.isConnected) return;

  const builds = (pvp.builds || []).map((b) => ({ value: b.key, label: b.label || b.key }));
  box.innerHTML = spielerFeld('tkPUser')
    + U.select('tkBuild', 'Turnier-Build', builds, builds[0] && builds[0].value)
    + `<div id="tkBuildInfo" class="cp-hint"></div>`
    + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('tkGrant', 'Build vergeben', { variant: 'primary' })
      + U.btn('tkRemove', 'Alle PvP-Builds einsammeln', { size: 'sm', variant: 'danger' })
    + `</div>`
    + (C.can('token.prime')
      ? U.sec('Prime auf den laufenden Dino')
        + `<div id="tkPPrimes"></div>`
        + `<div class="cp-btn-row cp-btn-row-left">` + U.btn('tkPrimeGo', 'Primes setzen', { size: 'sm' }) + `</div>`
        + U.hint('Wirkt auf den Dino, der gerade im Spiel ist — der Spieler muss online sein.')
      : '')
    + U.hint('Ein Build ist fest vorgegeben: Wachstum 100 %, männlich, drei Elder-Stacks, alle Primes '
      + 'und feste Mutationen. Wählbar ist nur, welcher.');

  wireSpielerFeld('tkPUser');
  zeigeBuild();
  el('tkBuild').onchange = zeigeBuild;
  el('tkGrant').onclick = buildGeben;
  el('tkRemove').onclick = buildEntfernen;
  if (el('tkPPrimes')) { zeichnePPrimes(); el('tkPrimeGo').onclick = primesSetzen; }
}

function zeigeBuild() {
  const b = (pvp.builds || []).find((x) => x.key === el('tkBuild').value);
  const box = el('tkBuildInfo');
  if (!box) return;
  // Die Mutationen der Builds liefert das Backend bewusst NICHT aus — mehr als
  // Art und Kurzbeschreibung laesst sich hier ehrlicherweise nicht zeigen.
  box.textContent = b ? [b.dinoClass ? baseClass(b.dinoClass) : '', b.blurb].filter(Boolean).join(' — ') : '';
}

const pprimes = new Set();
function zeichnePPrimes() {
  const box = el('tkPPrimes');
  if (!box) return;
  const labels = pvp.primeLabels || [];
  box.innerHTML = `<div class="cp-chip-wrap">` + labels.map((l, i) => {
    const n = i + 1;
    return `<button type="button" class="cp-chip${pprimes.has(n) ? ' on' : ''}" data-pp="${n}">${U.esc(l)}</button>`;
  }).join('') + `</div>`;
  box.querySelectorAll('[data-pp]').forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.pp);
      if (pprimes.has(n)) pprimes.delete(n); else pprimes.add(n);
      zeichnePPrimes();
    };
  });
}

async function buildGeben() {
  const u = zielSpieler('tkPUser');
  if (!u) return;
  const btn = el('tkGrant');
  btn.disabled = true;
  try {
    await C.api('POST', '/admin/pvp/grant', { targetKind: 'user', targetSteamId: u.steamId, buildKey: el('tkBuild').value });
    C.toast(`Build an ${userLabel(u)} vergeben.`, 'success');
  } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

function buildEntfernen() {
  const u = zielSpieler('tkPUser');
  if (!u) return;
  const btn = el('tkRemove');
  // Entfernt ALLE PvP-Builds des Spielers auf einmal — es gibt keinen
  // Einzel-Entfernen-Endpunkt. Deshalb zwei Klicks.
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.disabled = true;
    C.api('POST', '/admin/pvp/remove', { targetKind: 'user', targetSteamId: u.steamId })
      .then((d) => C.toast(`${d && d.removed != null ? d.removed : 'Alle'} Build(s) eingesammelt.`, 'success'))
      .catch((e) => C.toast('Fehlgeschlagen: ' + e.message, 'error'))
      .finally(() => { btn.disabled = false; btn.textContent = 'Alle PvP-Builds einsammeln'; });
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = 'Sicher? Alle einsammeln';
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = 'Alle PvP-Builds einsammeln'; } }, 2500);
}

async function primesSetzen() {
  const u = zielSpieler('tkPUser');
  if (!u) return;
  const btn = el('tkPrimeGo');
  btn.disabled = true;
  try {
    await C.api('POST', '/admin/prime', { targetSteamId: u.steamId, primes: [...pprimes] });
    C.toast(`Primes für ${userLabel(u)} gesetzt.`, 'success');
  } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
  finally { btn.disabled = false; }
}

// ── Garage-Slot bearbeiten ─────────────────────────────────────────────────
//
// Die ART fehlt hier bewusst: /admin/dino-token/edit nimmt kein `dino`-Feld.
// Wer die Art aendern will, loescht den Slot und vergibt neu. Ein Feld
// anzubieten, das der Server verwirft, waere schlimmer als keines.
//
// Nicht gesetzte Felder laesst das Backend unveraendert. Wir senden trotzdem
// alle, weil das Formular ohnehin den vollstaendigen Stand zeigt — sonst
// muesste man raten, was gerade gilt.
const editMut = { base: new Set(), parent: new Set(), elder: new Set() };
let editPrimes = new Set();
let editMutsOffen = false;

function slotBearbeiten(u, slot) {
  const box = el('tkForm-' + slot.id);
  if (!box) return;
  if (box.dataset.offen) { box.dataset.offen = ''; box.innerHTML = ''; return; }
  box.dataset.offen = '1';

  editPrimes = new Set(slot.primes || []);
  const m = slot.mutations || {};
  editMut.base = new Set(m.base || []);
  editMut.parent = new Set(m.parent || []);
  editMut.elder = new Set(m.elder || []);
  editMutsOffen = false;

  box.innerHTML = `<div class="cp-gar-form">`
    + `<div class="cp-row">`
      + U.select('tkESex-' + slot.id, 'Geschlecht',
        [{ value: 'Male', label: 'Männlich' }, { value: 'Female', label: 'Weiblich' }],
        slot.gender === 'Female' ? 'Female' : 'Male')
      + U.field('tkEGrow-' + slot.id, 'Wachstum %',
        { type: 'number', value: String(Math.round((slot.grow || 0) * 100) || 1), min: 1, max: 100 })
      + U.field('tkEElder-' + slot.id, 'Elder-Stacks',
        { type: 'number', value: String(slot.elderStacks || 0), min: 0, max: 3 })
    + `</div>`
    + `<div id="tkEPrimes-${U.esc(slot.id)}"></div>`
    + `<div id="tkEMuts-${U.esc(slot.id)}"></div>`
    + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('tkESave-' + slot.id, 'Speichern', { size: 'sm', variant: 'primary' })
      + U.btn('tkECancel-' + slot.id, 'Abbrechen', { size: 'sm' })
    + `</div>`
    + U.hint('Die Art lässt sich nicht ändern — dafür Slot löschen und neu vergeben.')
    + `</div>`;

  zeichneEditPrimes(slot);
  zeichneEditMuts(slot);

  el('tkECancel-' + slot.id).onclick = () => { box.dataset.offen = ''; box.innerHTML = ''; };
  el('tkESave-' + slot.id).onclick = async () => {
    const b = el('tkESave-' + slot.id);
    const growPct = Number(el('tkEGrow-' + slot.id).value);
    if (!Number.isFinite(growPct) || growPct < 1 || growPct > 100) {
      C.toast('Wachstum muss zwischen 1 und 100 liegen.', 'error'); return;
    }
    b.disabled = true;
    try {
      await C.api('POST', '/admin/dino-token/edit', {
        targetSteamId: u.steamId,
        slotId: slot.id,
        gender: el('tkESex-' + slot.id).value,
        grow: growPct / 100,
        elderStacks: Math.max(0, Math.min(3, Number(el('tkEElder-' + slot.id).value) || 0)),
        primes: [...editPrimes],
        mutations: { base: [...editMut.base], parent: [...editMut.parent], elder: [...editMut.elder] },
      });
      C.toast('Slot gespeichert.', 'success');
      garageLaden();
    } catch (err) { C.toast('Fehlgeschlagen: ' + err.message, 'error'); b.disabled = false; }
  };
}

function zeichneEditPrimes(slot) {
  const box = el('tkEPrimes-' + slot.id);
  if (!box) return;
  const labels = (cfg && cfg.primeLabels) || [];
  box.innerHTML = U.sec(`Prime-Bedingungen (${editPrimes.size}/${labels.length})`)
    + `<div class="cp-chip-wrap">` + labels.map((l, i) => {
      const n = i + 1;
      return `<button type="button" class="cp-chip${editPrimes.has(n) ? ' on' : ''}" data-ep="${n}">${U.esc(l)}</button>`;
    }).join('') + `</div>`;
  box.querySelectorAll('[data-ep]').forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.ep);
      if (editPrimes.has(n)) editPrimes.delete(n); else editPrimes.add(n);
      zeichneEditPrimes(slot);
    };
  });
}

function zeichneEditMuts(slot) {
  const box = el('tkEMuts-' + slot.id);
  if (!box) return;
  const diet = (cfg && cfg.dietBySpecies || {})[baseClass(slot.dinoClass)] || 'both';
  const sexEl = el('tkESex-' + slot.id);
  const sex = sexEl ? sexEl.value : (slot.gender || 'Male');
  const liste = ((cfg && cfg.mutations) || []).filter((m) => {
    if (m.diet && m.diet !== 'both' && diet !== 'both' && m.diet !== diet) return false;
    if (m.femaleOnly && sex !== 'Female') return false;
    return true;
  });

  const gruppe = (key, titel) => {
    const sset = editMut[key];
    return U.sec(`${titel} (${sset.size}/${CAP[key]})`)
      + `<div class="cp-chip-wrap">` + liste.map((m) =>
        `<button type="button" class="cp-chip${sset.has(m.value) ? ' on' : ''}" data-em="${key}|${U.esc(m.value)}"`
        + `${m.description ? ` title="${U.esc(m.description)}"` : ''}>${U.esc(m.label || m.value)}</button>`).join('')
      + `</div>`;
  };

  const vorher = box.querySelector('details');
  if (vorher) editMutsOffen = vorher.open;
  box.innerHTML = U.expander('Mutationen',
    gruppe('base', 'Basis') + gruppe('parent', 'Eltern') + gruppe('elder', 'Elder'), editMutsOffen);
  const det = box.querySelector('details');
  if (det) det.ontoggle = () => { editMutsOffen = det.open; };

  box.querySelectorAll('[data-em]').forEach((b) => {
    b.onclick = () => {
      const [key, val] = b.dataset.em.split('|');
      const sset = editMut[key];
      if (sset.has(val)) sset.delete(val);
      else if (sset.size >= CAP[key]) { C.toast(`Höchstens ${CAP[key]} in dieser Generation.`, 'error'); return; }
      else sset.add(val);
      zeichneEditMuts(slot);
    };
  });
  if (sexEl) sexEl.onchange = () => zeichneEditMuts(slot);
}
