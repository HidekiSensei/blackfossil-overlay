// Farbschemata — eine Quelle fuer Overlay und Companion.
//
// Ein Theme ist KEIN einzelner Farbwert: sieben CSS-Variablen haengen daran
// (Akzent hell/normal/dunkel, Rahmen, Panel- und Eingabe-Hintergrund, plus die
// rohen RGB-Anteile fuer rgba(var(--accent-rgb),a)). Fuer eigene Farben leitet
// themeFromHex() das ganze Set aus EINEM Hex ab — deshalb genuegt in der
// Oberflaeche ein einzelner Farbwaehler, und es braucht keine Reset-Knoepfe.
//
// Das Modul kennt bewusst weder DOM noch localStorage direkt: beides kommt
// ueber Optionen herein (setVars/storage). Nur so ist die Ableitungslogik
// testbar, ohne einen Browser hochzufahren.

// min = Mindest-Abo-Rang (0 Fossil · 1 Knochen · 2 Bernstein · 3 Obsidian).
export const THEMES = {
  violett: { name: 'Violett', min: 0, accent: '#8b5cf6', accent2: '#a78bfa', accentD: '#7c3aed', border: 'rgba(139,92,246,0.32)', rgb: '139,92,246', panel: 'rgba(20,13,38,0.82)', inputBg: '#160d28' },
  blau:    { name: 'Blau',    min: 1, accent: '#3b82f6', accent2: '#60a5fa', accentD: '#2563eb', border: 'rgba(59,130,246,0.32)', rgb: '59,130,246', panel: 'rgba(12,18,38,0.82)', inputBg: '#0c1426' },
  cyan:    { name: 'Cyan',    min: 1, accent: '#06b6d4', accent2: '#22d3ee', accentD: '#0891b2', border: 'rgba(6,182,212,0.32)', rgb: '6,182,212', panel: 'rgba(8,24,30,0.82)', inputBg: '#07181d' },
  gruen:   { name: 'Grün',    min: 1, accent: '#22c55e', accent2: '#4ade80', accentD: '#16a34a', border: 'rgba(34,197,94,0.32)', rgb: '34,197,94', panel: 'rgba(10,28,18,0.82)', inputBg: '#0a1c12' },
  gold:    { name: 'Gold',    min: 2, accent: '#f59e0b', accent2: '#fbbf24', accentD: '#d97706', border: 'rgba(245,158,11,0.32)', rgb: '245,158,11', panel: 'rgba(32,24,8,0.84)', inputBg: '#1c1506' },
  rot:     { name: 'Rot',     min: 2, accent: '#ef4444', accent2: '#f87171', accentD: '#dc2626', border: 'rgba(239,68,68,0.32)', rgb: '239,68,68', panel: 'rgba(34,12,12,0.84)', inputBg: '#1e0c0c' },
  pink:    { name: 'Pink',    min: 2, accent: '#ec4899', accent2: '#f472b6', accentD: '#db2777', border: 'rgba(236,72,153,0.32)', rgb: '236,72,153', panel: 'rgba(34,12,26,0.84)', inputBg: '#1e0c18' },
};

export const ABO_ORDER = ['Fossil', 'Knochen', 'Bernstein', 'Obsidian'];
export const DEFAULT_THEME = 'violett';
export const CUSTOM_HEX_FALLBACK = '#8b5cf6';

export function aboIndex(tier) {
  const i = ABO_ORDER.indexOf(tier);
  return i < 0 ? 0 : i;
}

// Staff bekommt alle Themes, unabhaengig vom Abo: die Stufen sind ein
// Spieler-Perk, kein Werkzeug-Gate. Spiegelt die Regel, die das Overlay
// schon anwendet (setAboTier bei team||admin → Obsidian).
export function effectiveTier(token = {}) {
  if (token.team || token.admin) return 'Obsidian';
  return ABO_ORDER.includes(token.aboTier) ? token.aboTier : 'Fossil';
}

// Defensiv: aus localStorage kann Unsinn kommen (oder ein alter 3-stelliger
// Wert). Ein NaN wuerde sich sonst durch alle sieben Variablen ziehen und die
// Oberflaeche schwarz faerben — lieber auf den Standard zurueckfallen.
export function hexToRgb(hex) {
  const s = String(hex == null ? '' : hex).trim().replace(/^#/, '');
  const full = /^[0-9a-f]{3}$/i.test(s) ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(/^[0-9a-f]{6}$/i.test(full) ? full : CUSTOM_HEX_FALLBACK.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  const h = (v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);
  return '#' + h(r) + h(g) + h(b);
}

// Flaechenfarben aus dem Akzent ableiten.
//
// Nachgerechnet, nicht geschaetzt: der bisherige Companion-Hintergrund #0d0918
// ist exakt der Violett-Akzent (139,92,246) bei 9,7 % Helligkeit. Die
// Hintergruende waren also von Anfang an abgeleitet — nur fest verdrahtet,
// sodass sie beim Themewechsel violett stehenblieben.
//
// Drei Stufen von tief nach hoch, die Faktoren aus den bisherigen festen Werten
// des Violett-Themes zurueckgerechnet (#08050f / #0d0918 / #1c1630). Violett
// sieht damit aus wie vorher, alle anderen Schemata ziehen endlich mit.
const BG_LEVEL_0 = 0.059;    // tiefste Flaeche (Rahmen um die Karte)
const BG_LEVEL = 0.097;      // Seitenhintergrund
const BG_LEVEL_2 = 0.200;    // abgesetzte Flaeche (Toasts, Auswahllisten)

export function surfacesFromAccent(hex) {
  const [r, g, b] = hexToRgb(hex);
  const at = (f) => rgbToHex(r * f, g * f, b * f);
  return { bg0: at(BG_LEVEL_0), bg: at(BG_LEVEL), bg2: at(BG_LEVEL_2) };
}

// Vollstaendiges Theme aus EINER Akzentfarbe: hell = 25 % Richtung Weiss,
// dunkel = 82 %, Flaechen aus demselben Ton stark abgedunkelt.
export function themeFromHex(hex) {
  const [r, g, b] = hexToRgb(hex);
  const li = (v) => v + (255 - v) * 0.25;
  const dk = (v) => v * 0.82;
  return {
    name: 'Custom', min: 3,
    accent: rgbToHex(r, g, b),
    accent2: rgbToHex(li(r), li(g), li(b)),
    accentD: rgbToHex(dk(r), dk(g), dk(b)),
    border: `rgba(${r},${g},${b},0.32)`,
    rgb: `${r},${g},${b}`,
    panel: `rgba(${Math.round(r * 0.14)},${Math.round(g * 0.14)},${Math.round(b * 0.14)},0.84)`,
    inputBg: rgbToHex(r * 0.16, g * 0.16, b * 0.16),
  };
}

// Die Variablen auf :root schreiben.
//
// --cp-bg/--cp-bg-2 sind bewusst eigene Namen und NICHT --solid-base: letzteres
// traegt im Overlay den Panel-Hintergrund (app.css). Es hier mitzudrehen waere
// eine Optik-Aenderung am Overlay, die niemand bestellt hat.
function domSetVars(t) {
  if (typeof document === 'undefined') return;
  const r = document.documentElement.style;
  r.setProperty('--accent', t.accent);
  r.setProperty('--accent-2', t.accent2);
  r.setProperty('--accent-d', t.accentD);
  r.setProperty('--border', t.border);
  r.setProperty('--accent-rgb', t.rgb);
  r.setProperty('--panel', t.panel);
  r.setProperty('--input-bg', t.inputBg);
  r.setProperty('--cp-bg-0', t.bg0);
  r.setProperty('--cp-bg', t.bg);
  r.setProperty('--cp-bg-2', t.bg2);
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// storageKey/customKey unterscheiden sich pro App: Overlay und Companion haben
// getrennte userData-Verzeichnisse und damit ohnehin getrennten localStorage —
// eigene Namen machen sichtbar, dass sich hier nichts abgleicht.
export function makeTheme(opts = {}) {
  const storageKey = opts.storageKey || 'bf-theme';
  const customKey = opts.customKey || 'bf-custom';
  const store = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memStorage());
  const setVars = opts.setVars || domSetVars;
  const onApply = opts.onApply || (() => {});

  let tier = 'Fossil';
  let current = store.getItem(storageKey) || DEFAULT_THEME;

  const unlocked = (key) => (key === 'custom'
    ? aboIndex(tier) >= 3
    : !!THEMES[key] && aboIndex(tier) >= (THEMES[key].min || 0));

  const customHex = () => {
    const v = store.getItem(customKey);
    return v || CUSTOM_HEX_FALLBACK;
  };

  // Flaechen immer nachrechnen statt in THEMES zu pflegen: ein neues Theme
  // braucht so nur seine Akzentfarben, und die Hintergruende koennen gar nicht
  // erst zum Akzent aus der Reihe fallen.
  const build = (key) => {
    const t = key === 'custom' ? themeFromHex(customHex()) : THEMES[key] || THEMES[DEFAULT_THEME];
    return { ...t, ...surfacesFromAccent(t.accent) };
  };

  // persist nur bei ausdruecklicher Nutzer-Wahl: faellt der Rang beim Start
  // noch auf Fossil zurueck, darf das die gespeicherte Praeferenz nicht
  // ueberschreiben — sonst ist sie weg, sobald /token einmal langsam ist.
  function apply(key, persist) {
    if (!unlocked(key)) key = DEFAULT_THEME;
    const t = build(key);
    current = key;
    setVars(t);
    if (persist) store.setItem(storageKey, key);
    onApply(t, key);
    return t;
  }

  return {
    apply,
    // Rang nachreichen, sobald /token da ist, und die gespeicherte Wahl
    // erneut anwenden — beim ersten Aufruf war der Rang noch unbekannt.
    setTier(next) {
      tier = ABO_ORDER.includes(next) ? next : 'Fossil';
      return apply(store.getItem(storageKey) || DEFAULT_THEME);
    },
    setFromToken(token) { return this.setTier(effectiveTier(token)); },
    setCustomHex(hex) {
      store.setItem(customKey, hex);
      return apply('custom', true);
    },
    unlocked,
    customHex,
    tier: () => tier,
    // Beim Lesen gegen den Rang pruefen, nicht nur beim Anwenden: zwischen
    // Konstruktion und erstem apply() stuende sonst der gespeicherte Wert da,
    // und der kann gesperrt sein (Rang kommt erst mit /token). Die Speicherung
    // selbst bleibt unberuehrt — die Praeferenz kehrt zurueck, sobald der Rang da ist.
    current: () => (unlocked(current) ? current : DEFAULT_THEME),
    theme: () => build(unlocked(current) ? current : DEFAULT_THEME),
    minTierFor: (key) => ABO_ORDER[(key === 'custom' ? 3 : (THEMES[key] || {}).min) || 0],
  };
}
