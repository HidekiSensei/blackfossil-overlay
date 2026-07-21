// Reine Formatierungs-Helfer — kein DOM, kein State, keine Globals.
// Von overlay.js und (künftig) companion.js gemeinsam genutzt.

// baseClass macht aus einer Dino-Klasse den lesbaren Spezies-Namen.
// Spiegelt bewusst gameapi.BaseClass() aus dem Backend
// (blackfossil-backend/internal/gameapi/guards.go): erst das BP_-Präfix weg,
// dann alles ab dem ersten "_". Damit werden BEIDE Formen korrekt behandelt:
//   BP_Allosaurus_C     → Allosaurus
//   Carnotaurus_Adult   → Carnotaurus
// Der alte Overlay-Helfer (aiSpeciesShort) strippte nur ^BP_ und _C$ und ließ
// deshalb "Carnotaurus_Adult" stehen.
export function baseClass(sp) {
  let c = String(sp || '');
  if (c.startsWith('BP_')) c = c.slice(3);
  const i = c.indexOf('_');
  return i >= 0 ? c.slice(0, i) : c;
}

// fmtGrow: Wachstum (0..1) als Prozent. Nicht "growPct" genannt, weil dieser
// Bezeichner in overlay.js bereits als lokale Variable vorkommt.
// null/undefined → '' (nicht "0%"), damit fehlende Werte nicht wie 0 aussehen.
export function fmtGrow(g) {
  return g == null ? '' : `${Math.round(g * 100)}%`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Tageszeit (Float-Stunden) → "HH:MM"
export function fmtTod(t) {
  const h = Math.floor(t), m = Math.round((t - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
