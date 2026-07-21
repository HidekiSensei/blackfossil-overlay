// Patcht die Test-Defaults, die im Repo eingecheckt sind, auf Produktiv-Werte —
// wird von .github/workflows/release.yml (main-Branch) vor dem Build aufgerufen,
// je einmal im Windows- und im Linux-Job. dev-build.yml ruft das NICHT auf, damit
// Test-Installer (andere appId/productName/API-URL) parallel zum Produktiv-Build
// installierbar bleiben.
'use strict';
const fs = require('fs');

function patch(path, replacements) {
  let s = fs.readFileSync(path, 'utf8');
  for (const [from, to] of replacements) {
    if (!s.includes(from)) throw new Error(`${path}: Pattern nicht gefunden: ${from}`);
    s = s.split(from).join(to);
  }
  fs.writeFileSync(path, s);
}

patch('app/src/main.js', [
  ['https://api-test.blackfossil.de', 'https://api.blackfossil.de'],
  ["'BlackFossil Overlay Test'", "'BlackFossil Overlay'"],
  ["'BlackFossil Login Test'", "'BlackFossil Login'"],
  // Deep-Link-Scheme: Test-Build registriert blackfossil-test, Prod blackfossil (nur die
  // Konstante — der quotierte Vergleich trifft NICHT den Kommentar-Text "blackfossil-test://").
  ["const SCHEME = 'blackfossil-test'", "const SCHEME = 'blackfossil'"],
]);

patch('app/package.json', [
  ['"de.blackfossil.overlay.test"', '"de.blackfossil.overlay"'],
  ['"BlackFossil Overlay Test"', '"BlackFossil Overlay"'],
  ['"BlackFossil-Overlay-Test-Setup.${ext}"', '"BlackFossil-Overlay-Setup.${ext}"'],
  // protocols.schemes — quotiert, trifft nur die Scheme-Zeile, nicht die appId
  // (de.blackfossil.overlay.test enthält "blackfossil-test" nicht als Teilstring).
  ['"blackfossil-test"', '"blackfossil"'],
  // Linux-Binary + .desktop-Eintrag. Ohne eigenen Namen leitet electron-builder ihn
  // aus package.json.name ab — Test und Prod hießen dann beide "blackfossil-overlay"
  // und überschrieben sich unter Linux gegenseitig den Desktop-Eintrag (unter Windows
  // trennt NSIS sie über appId/productName, deshalb fiel es dort nie auf).
  // Der Prod-Wert bleibt "blackfossil-overlay" — bestehende Installationen ändern sich
  // nicht. Steht bewusst NACH dem "blackfossil-test"-Replace: das greift hier nicht,
  // weil vor "test" ein Bindestrich statt eines Quotes steht.
  ['"executableName": "blackfossil-overlay-test"', '"executableName": "blackfossil-overlay"'],
]);

// ── Companion-App ───────────────────────────────────────────────────────────
// Zweite App, gleiche Logik: im Repo stehen Test-Defaults, hier werden sie auf
// Produktiv gedreht. Overlay und Companion bleiben dabei in BEIDEN Varianten
// parallel installierbar (vier verschiedene appIds insgesamt).
patch('app/src/companion-main.js', [
  ['https://api-test.blackfossil.de', 'https://api.blackfossil.de'],
  ["'BlackFossil Companion Test'", "'BlackFossil Companion'"],
  // Nur die Konstante treffen, nicht die Kommentare, die den Scheme erwähnen.
  ["const SCHEME = 'blackfossil-companion-test'", "const SCHEME = 'blackfossil-companion'"],
]);

patch('app/electron-builder.companion.yml', [
  ['de.blackfossil.companion.test', 'de.blackfossil.companion'],
  ['BlackFossil Companion Test', 'BlackFossil Companion'],
  ['BlackFossil-Companion-Test-Setup.${ext}', 'BlackFossil-Companion-Setup.${ext}'],
  // Reihenfolge zählt: der Scheme-Eintrag steht in einer eigenen Zeile und würde
  // sonst schon vom appId-Replace oben mit erwischt werden — deshalb ist das
  // Pattern hier der volle Scheme-String inkl. Listen-Präfix.
  ['- blackfossil-companion-test', '- blackfossil-companion'],
  ['executableName: blackfossil-companion-test', 'executableName: blackfossil-companion'],
]);

console.log('Produktiv-Werte gesetzt für Overlay UND Companion (appId, productName, artifactName, Scheme, API-URL).');
