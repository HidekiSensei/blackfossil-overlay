// Spawnbare Arten für KI-Encounter.
//
// BEWUSST eine eigene Liste und NICHT aus DINO_LEXIKON abgeleitet: das Lexikon
// ist Spieler-Dokumentation. Wäre die Auswahl daran gekoppelt, müsste man einen
// Dino aus der Doku entfernen, nur damit er nicht mehr spawnbar ist — oder
// umgekehrt einen nicht dokumentierten Dino nie spawnen können.
//
// Zum Sperren einer Art: hier auskommentieren, nicht im Lexikon.
export const SPAWN_SPECIES = [
  // Fleischfresser
  'Allosaurus',
  'Austroraptor',
  'Baryonyx',
  'Carnotaurus',
  'Ceratosaurus',
  'Deinosuchus',
  'Dilophosaurus',
  'Herrerasaurus',
  'Omniraptor',
  'Pteranodon',
  'Troodon',
  'Tyrannosaurus',
  // Pflanzenfresser
  'Diabloceratops',
  'Dryosaurus',
  'Hypsilophodon',
  'Kentrosaurus',
  'Maiasaura',
  'Pachycephalosaurus',
  'Stegosaurus',
  'Tenontosaurus',
  'Triceratops',
  // Allesfresser
  'Beipiaosaurus',
  'Gallimimus',
  'Oviraptor',
];

// Anzeige-Name → Klassenname, wie ihn die Mod erwartet.
export function toClass(name) {
  return name ? `BP_${name}_C` : '';
}

// Klassenname → Anzeige-Name. Verträgt beide Formen (BP_X_C und X_Adult),
// damit auch Altbestand sauber angezeigt wird.
export function fromClass(cls) {
  let c = String(cls || '');
  if (c.startsWith('BP_')) c = c.slice(3);
  const i = c.indexOf('_');
  return i >= 0 ? c.slice(0, i) : c;
}
