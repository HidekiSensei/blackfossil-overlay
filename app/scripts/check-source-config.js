#!/usr/bin/env node
// Riegel gegen versehentlich committete Test-Umleitungen.
//
// Warum es das gibt: Beim Vorfuehren und Testen wird die API-Basis in
// companion-main.js/main.js temporaer auf PRODUKTION umgebogen und der
// Loopback-Port verschoben. Genau diese Zeilen sind schon einmal per
// `git add -A` in dev gelandet (Commit 4be2b9d) und wurden als dev-Build
// ausgeliefert: die Companion sprach danach gegen die Produktions-API, und
// der Login-Callback lief auf einen Port, auf den das Backend nicht
// redirectet — Anmeldung stumm kaputt, ohne Fehlermeldung.
//
// Der Quelltext im Repo traegt IMMER die Test-Werte. Auf main dreht
// scripts/patch-prod.js sie beim Bauen auf Produktion. Deshalb pruefen wir
// hier die QUELLE, nicht das Ergebnis — und diese Pruefung muss vor
// patch-prod laufen.
//
// Aufruf: node scripts/check-source-config.js   (Exit 1 bei Fund)

const fs = require('fs');
const path = require('path');

const wurzel = path.join(__dirname, '..');
let fehler = 0;

function meckern(datei, text) {
  console.error(`  ✖ ${datei}: ${text}`);
  fehler++;
}

// 1) Die Pflichtwerte muessen exakt so dastehen.
const PFLICHT = [
  { datei: 'src/companion-main.js', muss: [
    "const TOKEN_BASE = 'https://api-test.blackfossil.de';",
    'const LOGIN_PORT = 53118;',
  ] },
  { datei: 'src/main.js', muss: [
    "const TOKEN_BASE = 'https://api-test.blackfossil.de';",
    'const LOGIN_PORT = 53117;',
  ] },
];

for (const { datei, muss } of PFLICHT) {
  const p = path.join(wurzel, datei);
  if (!fs.existsSync(p)) { meckern(datei, 'Datei fehlt'); continue; }
  const inhalt = fs.readFileSync(p, 'utf8');
  for (const zeile of muss) {
    if (!inhalt.includes(zeile)) {
      meckern(datei, `erwartete Zeile fehlt oder wurde veraendert:\n      ${zeile}`);
    }
  }
}

// 2) Kein Quelltext darf die Produktions-API nennen.
//
// Die Negativ-Lookahead-Konstruktion ist noetig, weil "api-test.blackfossil.de"
// die Zeichenkette "api.blackfossil.de" NICHT enthaelt, aber z. B.
// "https://api.blackfossil.de" schon — und genau die soll auffallen.
const PROD = /https:\/\/api\.blackfossil\.de/;

// 3) Meine Marker beim Umbiegen. Fangen den Fall ab, dass jemand die URL
//    anders schreibt, den Kommentar aber stehen laesst.
const MARKER = /TEMPOR[ÄA]R/;

function dateienUnter(dir, treffer = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) dateienUnter(p, treffer);
    else if (/\.(js|mjs|html|css|yml)$/.test(e.name)) treffer.push(p);
  }
  return treffer;
}

for (const p of dateienUnter(path.join(wurzel, 'src'))) {
  const rel = path.relative(wurzel, p);
  const inhalt = fs.readFileSync(p, 'utf8');
  inhalt.split('\n').forEach((zeile, i) => {
    if (PROD.test(zeile)) meckern(rel, `Zeile ${i + 1} nennt die Produktions-API:\n      ${zeile.trim()}`);
    if (MARKER.test(zeile)) meckern(rel, `Zeile ${i + 1} traegt einen TEMPORÄR-Marker:\n      ${zeile.trim()}`);
  });
}

// patch-prod.js selbst DARF beide Formen nennen — es ist die Stelle, die
// umschreibt. Ebenso die Build-Konfigurationen, die auf den Feed zeigen.
// Beide liegen ausserhalb von src/ und werden hier gar nicht erst gelesen.

if (fehler) {
  console.error(`\n${fehler} Fund(e). Der Quelltext muss die TEST-Werte tragen —`);
  console.error('auf main dreht scripts/patch-prod.js sie beim Bauen auf Produktion.');
  process.exit(1);
}
console.log('Quell-Konfiguration in Ordnung (Test-API, Standard-Ports, keine Marker).');
