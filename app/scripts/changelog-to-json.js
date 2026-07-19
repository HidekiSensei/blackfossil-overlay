// Erzeugt releases.json aus CHANGELOG.md (kuratiert). Wird von der CI vor dem Upload aufgerufen.
// Format-tolerant: akzeptiert sowohl "## vX.Y.Z — Titel" (bestehender Stil) als auch
// "## [X.Y.Z] - Datum" (Keep-a-Changelog). "## [Unreleased]" / "## vNext" werden übersprungen.
// "### Intern"-Unterabschnitte fliegen aus den öffentlichen Notes.
//
// Aufruf:
//   node app/scripts/changelog-to-json.js               → releases.json auf stdout
//   node app/scripts/changelog-to-json.js --out x.json  → schreibt nach x.json
//   node app/scripts/changelog-to-json.js --require 1.9.3  → Fehler(exit 1), wenn Abschnitt fehlt/leer
'use strict';
const fs = require('fs');
const path = require('path');

function findChangelog() {
  const cand = [
    process.env.CHANGELOG,
    path.join(process.cwd(), 'CHANGELOG.md'),
    path.resolve(__dirname, '../../CHANGELOG.md'), // Repo-Root (Script liegt in app/scripts/)
    path.resolve(__dirname, '../CHANGELOG.md'),
  ].filter(Boolean);
  for (const c of cand) if (fs.existsSync(c)) return c;
  throw new Error('CHANGELOG.md nicht gefunden (in cwd oder Repo-Root)');
}

// Header: "## [Unreleased]" | "## [1.9.2] - 2026-07-19" | "## v1.9.2 — Titel"
const HEADER = /^##\s+(?:\[([^\]]+)\](?:\s*[-–]\s*(.+?))?|v?(\d+\.\d+\.\d+)(?:\s*[—–-]\s*(.+?))?)\s*$/;

function stripIntern(body) {
  const out = [];
  let skip = false;
  for (const l of body.split('\n')) {
    if (/^###\s+/.test(l)) skip = /^###\s+Intern\b/i.test(l);
    if (!skip) out.push(l);
  }
  return out.join('\n');
}

function parse(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const secs = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEADER);
    if (m) {
      if (cur) secs.push(cur);
      const bracket = m[1];
      const isUnreleased = bracket ? /unreleased/i.test(bracket) : false;
      const version = m[3] || (bracket && /^\d+\.\d+\.\d+$/.test(bracket.trim()) ? bracket.trim() : null);
      cur = { version, date: (m[2] || '').trim(), title: (m[4] || '').trim(), isUnreleased, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) secs.push(cur);

  const out = [];
  for (const s of secs) {
    if (s.isUnreleased || !s.version) continue; // Unreleased + Nicht-Versions-Header überspringen
    const notes = stripIntern(s.lines.join('\n')).trim();
    const entry = { version: s.version, date: s.date, notes, channel: 'latest' };
    if (s.title) entry.title = s.title;
    out.push(entry);
  }
  return out; // Reihenfolge wie im File = neueste zuerst
}

function main() {
  const args = process.argv.slice(2);
  const requireVer = args.includes('--require') ? args[args.indexOf('--require') + 1] : null;
  const notesVer = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : null;
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

  const releases = parse(fs.readFileSync(findChangelog(), 'utf8'));

  // --notes <version>: nur den Notes-Body dieser Version ausgeben (für die GitHub-Release-Notes).
  if (notesVer) {
    const r = releases.find((x) => x.version === notesVer);
    process.stdout.write((r && r.notes ? r.notes : '') + '\n');
    return;
  }

  if (requireVer) {
    const r = releases.find((x) => x.version === requireVer);
    if (!r || !r.notes) {
      console.error(`FEHLER: Kein CHANGELOG-Abschnitt für Version ${requireVer} mit Inhalt gefunden.`);
      process.exit(1);
    }
    console.error(`OK: Release-Note für ${requireVer} vorhanden.`);
  }

  const json = JSON.stringify(releases, null, 2);
  if (out) {
    fs.writeFileSync(out, json + '\n');
    console.error(`releases.json → ${out} (${releases.length} Versionen)`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
