// Events-Panel: schaltbare Server-Events + die geplanten Discord-Termine.
//
// Im Overlay tauchen zwei voellig verschiedene Sorten "Events" an zwei Stellen
// auf; hier liegen sie als zwei Reiter beisammen:
//
//  - "Funktional" = Server-Flags, die das Spiel beeinflussen. Free Gender Swap
//    kommt aus der Events-Registry (settings-Store, kennt eine LAUFZEIT und
//    erscheint im HUD-Event-Panel). Grow-Stop ist ein Welt-Overwrite der Mod und
//    kennt nur an/aus — es hat bewusst KEINE Laufzeit und steht deshalb auch
//    nicht im HUD. Beides sind aber aus Sicht des Teams dieselbe Handlung
//    ("ein Server-Event schalten"), darum derselbe Reiter.
//
//  - "Termine" = Discord Guild Scheduled Events (GET /me/events), dieselbe
//    Liste, die der Spieler im Overlay unter Profil sieht. NUR LESEN: das
//    Backend hat keinen Schreibpfad, Interesse bekundet man im Discord.
import { el } from '../../shared/core.js';
import * as U from '../ui.js';

let C = null;
let tab = 'funktional';

const TABS = [
  { id: 'funktional', label: 'Funktional' },
  { id: 'termine', label: 'Termine' },
];

export function initEvents(ctx) { C = ctx; }

export function renderEvents(root) {
  if (!TABS.some((t) => t.id === tab)) tab = 'funktional';
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">`
    + U.header('Events', 'Schaltbare Server-Events und geplante Termine.')
    + U.tabs(TABS, tab)
    + `<div id="cpEvBody" class="cp-stack"></div></div>`;

  root.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; renderEvents(root); };
  });

  if (tab === 'funktional') renderFunktional();
  else renderTermine();
}

// Restzeit in EINER Einheit (Tage → Stunden → Minuten), wie im Overlay-HUD:
// gemischte Angaben ("1 Tag 3 Std 12 Min") liest im Vorbeigehen niemand.
function restzeit(ms) {
  const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (min >= 1440) return `${Math.round(min / 1440)} Tage`;
  if (min >= 60) return `${Math.round(min / 60)} Std`;
  return `${min} Min`;
}

// ── Funktional ─────────────────────────────────────────────────────────────
async function renderFunktional() {
  const box = el('cpEvBody');
  box.innerHTML = U.muted('Lade Event-Zustand…');

  // Getrennt laden und Fehler je Abschnitt behandeln: die beiden Schalter haengen
  // an verschiedenen Diensten (settings-Store vs. Mod). Faellt die Mod aus, soll
  // der Gender-Swap trotzdem schaltbar bleiben.
  const [fgs, grow] = await Promise.all([
    C.api('GET', '/free-gender-swap').catch(() => null),
    C.api('GET', '/admin/world/growth-stop').catch(() => null),
  ]);
  if (!el('cpEvBody')) return;   // waehrenddessen weggeklickt

  const fgsOn = !!(fgs && fgs.enabled);
  box.innerHTML =
    U.sec('Free Gender Swap')
    + (fgs
      ? U.check('evFgs', 'Aktiv — alle Spieler wechseln kostenlos das Geschlecht', fgsOn)
        + (fgsOn && fgs.expiresAtMs ? U.hint(`Läuft noch ${restzeit(fgs.expiresAtMs)}.`) : '')
        + U.row(U.field('evFgsH', 'Laufzeit in Stunden (0 = unbegrenzt)', { type: 'number', value: '24', min: 0 }))
        + U.hint('Die Laufzeit greift beim Einschalten; danach schaltet sich das Event von selbst ab. Erscheint im Overlay-HUD unter „Aktive Events".')
      : U.muted('Nicht abrufbar.'))
    + U.sec('Grow-Stop')
    + (grow
      ? U.check('evGrow', 'Wachstum aller Dinos einfrieren', !!grow.enabled)
        + U.hint('Betrifft alle Spieler sofort. Ohne Laufzeit — bleibt aktiv, bis es wieder ausgeschaltet wird, und steht deshalb nicht im HUD.')
      : U.muted('Nicht abrufbar (Mod offline?).'));

  const fgsBox = el('evFgs');
  if (fgsBox) fgsBox.onchange = async (e) => {
    const an = e.target.checked;
    const std = Number((el('evFgsH') || {}).value || 0);
    // Beim Ausschalten keine Laufzeit mitschicken — der Server setzt expiresAtMs
    // ohnehin nur, wenn eingeschaltet UND durationHours > 0.
    await schalte('POST', '/free-gender-swap', { enabled: an, durationHours: an ? std : 0 },
      an ? 'Free Gender Swap aktiv' : 'Free Gender Swap aus');
    renderFunktional();   // neu zeichnen: Restzeit-Hinweis haengt am Ergebnis
  };

  const growBox = el('evGrow');
  if (growBox) growBox.onchange = (e) => schalte('POST', '/admin/world/growth-stop', { enabled: e.target.checked },
    e.target.checked ? 'Wachstum gestoppt' : 'Wachstum läuft wieder');
}

async function schalte(method, path, body, okMsg) {
  try { await C.api(method, path, body); C.toast(okMsg, 'success'); }
  catch (e) { C.toast(e.message, 'error'); }
}

// ── Termine ────────────────────────────────────────────────────────────────
async function renderTermine() {
  const box = el('cpEvBody');
  box.innerHTML = U.muted('Lade Termine…');
  let list = [];
  try { list = (await C.api('GET', '/me/events')).events || []; }
  catch (e) { box.innerHTML = U.muted('Termine nicht abrufbar: ' + e.message); return; }
  if (!el('cpEvBody')) return;

  box.innerHTML = U.hint('Geplante Discord-Termine — dieselbe Liste, die Spieler im Overlay unter Profil sehen. Nur zur Ansicht: angelegt und beantwortet werden sie im Discord.')
    + (list.length
      ? `<div class="cp-list">` + list.map(termin).join('') + `</div>`
      : U.empty('Keine geplanten Termine.'));
}

function termin(e) {
  const wann = e.start
    ? new Date(e.start).toLocaleString('de-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
  const teile = [wann];
  if (e.location) teile.push(e.location);
  if (e.userCount != null) teile.push(`${e.userCount} interessiert`);
  // U.item escaped Titel und Untertitel selbst.
  return U.item((e.interested ? '⭐ ' : '') + (e.name || '?'), teile.join(' · '));
}
