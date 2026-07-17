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
]);

console.log('Produktiv-Werte gesetzt (appId, productName, artifactName, Scheme, main.js Strings, API-URL).');
