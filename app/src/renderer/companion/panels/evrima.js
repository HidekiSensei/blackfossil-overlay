// Evrima-Versionen (Gruppe "Server", nur Developer/Owner): die aktuellen
// Steam-Builds von Server und Game. Aus dem Overlay-Reiter "Admin → Evrima"
// (renderEvrima) uebernommen und ins Companion-Design gebracht: cp-table statt
// Inline-Styles, keine Cards.
//
// Der oeffentliche evrima-Branch traegt keinen Semver → wir zeigen die
// Steam-Build-ID (wie SteamDB) plus Last-Updated. Quelle: /evrima-versions
// (Backend cached ~5 min; fuer jeden Authentifizierten lesbar, hier per Nav auf
// server.tech eingeblendet).
import { el } from '../../shared/core.js';
import * as U from '../ui.js';

let C = null;

export function initEvrima(ctx) { C = ctx; }

// Sekunden-Delta → grobe deutsche Relativangabe (wie im Overlay).
function ago(unixSec) {
  if (!unixSec) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `vor ${d} Tag${d === 1 ? '' : 'en'}`;
  if (h > 0) return `vor ${h} Std`;
  if (m > 0) return `vor ${m} Min`;
  return 'gerade eben';
}

export function renderEvrima(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Evrima', 'Aktuelle Steam-Builds von Server und Game.')}
    <div id="evBody">${U.muted('Lade…')}</div>
  </div>`;
  load();
}

async function load() {
  const box = el('evBody'); if (!box) return;
  box.innerHTML = U.muted('Lade…');
  let d;
  try {
    d = await C.api('GET', '/evrima-versions');
  } catch (e) {
    box.innerHTML = U.muted('Konnte Versionen nicht laden: ' + e.message);
    return;
  }

  // Server hat i. d. R. eine lesbare ProjectVersion (0.21.738); Game nur die
  // Steam-Build-ID (der evrima-Branch hat keinen Versionsnamen).
  const verCell = (b) => {
    const build = b && b.buildId ? U.esc(b.buildId) : '—';
    return b && b.version
      ? `<b>${U.esc(b.version)}</b> <span class="cp-td-mono">Build ${build}</span>`
      : `<span class="cp-td-mono">${build}</span>`;
  };
  const updCell = (b) => {
    const upd = b && b.updated ? new Date(b.updated * 1000) : null;
    const tip = upd ? U.esc(upd.toLocaleString('de-DE')) : 'unbekannt';
    return `<span title="${tip}">${ago(b && b.updated)}</span>`;
  };
  const rowFor = (label, icon, b) => {
    const desc = b && b.desc ? `<div class="cp-muted">${U.esc(b.desc)}</div>` : '';
    return `<tr><td class="cp-td-name">${icon} ${label}${desc}</td>`
      + `<td>${verCell(b)}</td><td>${updCell(b)}</td></tr>`;
  };

  const stand = d && d.fetchedAt ? `zuletzt geprüft ${ago(d.fetchedAt)}` : 'noch nicht abgerufen';
  box.innerHTML = `
    <div class="cp-table-wrap">
      <table class="cp-table">
        <thead><tr><th></th><th>Version / Build</th><th>Zuletzt aktualisiert</th></tr></thead>
        <tbody>
          ${rowFor('Server', '🖥️', d && d.server)}
          ${rowFor('Game', '🎮', d && d.game)}
        </tbody>
      </table>
    </div>
    ${U.hint('Server-Version = laufende ProjectVersion; Steam liefert nur die Build-ID (der evrima-Branch hat keinen Versionsnamen). Quelle: steamcmd.net (Steam PICS) + Server-Status · ' + stand)}
    <div style="height:var(--cp-s3)"></div>
    ${U.btn('evRefresh', '🔄 Aktualisieren', { size: 'sm' })}`;

  const rb = el('evRefresh'); if (rb) rb.onclick = load;
}
