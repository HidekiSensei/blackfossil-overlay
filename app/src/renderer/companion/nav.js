// Navigation der Companion — nach Aufgabe gruppiert.
//
// Warum Gruppen statt einer flachen Liste: die Punkte teilen sich in Dinge, die
// man BEI der Arbeit benutzt (Karte, Tickets), Dinge zum NACHSCHLAGEN, und zwei
// Stufen von Eingriff (Moderation an Spielern, Administration am Server). Diese
// Trennung ist auch die Rechte-Trennung — wer nur moderiert, sieht die untere
// Gruppe gar nicht.
//
// Der eigentliche Gewinn steckt daneben: die frueheren Reiter in Team und Admin
// sind hier eigene Punkte. Vier plus drei Reiter verschwinden damit, und
// dieselbe Struktur traegt spaeter auch die Reiterflut des Overlay-Teampanels.
//
// `cap` ist die Faehigkeit aus shared/perms.js; fehlt sie, verschwindet der
// Punkt (und mit dem letzten Punkt die ganze Gruppe). `needsOnline` markiert
// Ansichten, die ohne eigenen Dino auf dem Server leer waeren — Staff-Werkzeuge
// haengen bewusst NICHT daran.
export const NAV_GROUPS = [
  {
    id: 'arbeit',
    label: 'Arbeitsmittel',
    // Support steht hier und nicht unter Moderation: Tickets sind auch die
    // Spielersicht, sobald die App fuer alle aufgeht.
    items: [
      { view: 'map', icon: '🗺️', label: 'Karte', cap: null },
      { view: 'support', icon: '🎫', label: 'Support', cap: 'support.read' },
    ],
  },
  {
    id: 'wissen',
    label: 'Wissen',
    items: [
      { view: 'lexikon', icon: '📖', label: 'Lexikon', cap: null },
    ],
  },
  {
    id: 'moderation',
    label: 'Moderation',
    // Alles hier faengt bei staff/ingame an. Server gehoert dazu, weil sein
    // Einstieg (Status, Ansage) staff ist — die harten Eingriffe darin
    // (Neustart, Steuerung) sind admin und blenden sich im Panel selbst aus.
    items: [
      { view: 'spieler', icon: '👥', label: 'Spieler', cap: 'team.users' },
      { view: 'warnings', icon: '⚠️', label: 'Verwarnungen', cap: 'team.warnings' },
      { view: 'paudit', icon: '🔍', label: 'Player-Audit', cap: 'team.playerAudit' },
      { view: 'server', icon: '📢', label: 'Server', cap: 'server.status' },
      // Handbuch: Nachschlagewerk aller Staff-Funktionen. Fuer jeden im Team
      // sichtbar (Inhalt filtert sich je Rang selbst) → cap: null.
      { view: 'handbuch', icon: '📖', label: 'Handbuch', cap: null },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    // Ausschliesslich admin — diese Gruppe ist fuer alle anderen unsichtbar.
    //
    // Dino-Verwaltung haengt bewusst an `limits.write` (admin), nicht an
    // `limits.read` (any): der Punkt ist ein Werkzeug zum Aendern, kein
    // Nachschlagewerk. Dass jeder die Limits LESEN darf, macht ihn nicht zur
    // Spielerinformation.
    items: [
      { view: 'welt', icon: '🌍', label: 'Welt', cap: 'world.read' },
      { view: 'dinos', icon: '🦖', label: 'Dino-Verwaltung', cap: 'limits.write' },
      { view: 'ops', icon: '📊', label: 'Betrieb', cap: 'ops.read' },
      { view: 'taudit', icon: '📜', label: 'Team-Audit', cap: 'team.staffAudit' },
    ],
  },
];

// Settings steht ausserhalb der Gruppen und unten fest — es gehoert zu keiner
// Aufgabe und soll immer an derselben Stelle liegen.
export const NAV_SETTINGS = { view: 'settings', icon: '⚙️', label: 'Settings', cap: null };

export const ALL_ITEMS = [...NAV_GROUPS.flatMap((g) => g.items), NAV_SETTINGS];

export function itemFor(view) {
  return ALL_ITEMS.find((i) => i.view === view) || null;
}

// Gruppen sind aufgeklappt, solange nichts anderes gespeichert ist. Eine
// zugeklappte Gruppe versteckt Punkte — das darf nie der Startzustand sein,
// den man nicht selbst gewaehlt hat.
const KEY = 'bf-cp-nav-zu';

export function collapsedGroups(storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return new Set();
  try { return new Set(JSON.parse(s.getItem(KEY) || '[]')); } catch { return new Set(); }
}

export function saveCollapsed(set, storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return;
  s.setItem(KEY, JSON.stringify([...set]));
}
