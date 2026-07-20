// Erstellen und Bearbeiten von Karten-Objekten (Admin-only).
//
// Teleports, Zonen und KI-Encounter. Alles laeuft ueber verschiebbare Flaechen
// ueber der Karte (companion/floating.js) — kein echtes Fenster, damit die
// Karte waehrend des Setzens sichtbar und bedienbar bleibt.
//
// Das Setzen laeuft ueber einen "Platzierungs-Modus": der Editor sagt der Karte,
// dass der naechste Klick (oder bei Zonen: die naechsten Klicks) Koordinaten
// liefern soll, statt Spieler auszuwaehlen.
import { el, armConfirm } from '../shared/core.js';
import { escapeHtml } from '../shared/format.js';
import { floatingPanel, close, isOpen } from './floating.js';
import * as U from './ui.js';

let C = null;
// { kind: 'teleport'|'zone'|'encounter', points: [{x,y}] } waehrend des Setzens
let placing = null;
// Die gerade bearbeitete Zone (Kopie!). Die Karte zeichnet sie hervorgehoben und
// meldet Verschiebungen ueber setZonePoints zurueck.
let editZone = null;

export function editingZone() { return editZone; }
export function setZonePoints(points) { if (editZone) editZone.points = points; }

export function initEditor(ctx) { C = ctx; }

export function isPlacing() { return !!placing; }
export function placingKind() { return placing ? placing.kind : null; }
export function placingPoints() { return placing ? placing.points : []; }

// Von der Karte aufgerufen, wenn im Platzierungs-Modus geklickt wurde.
export function addPlacementPoint(x, y) {
  if (!placing) return;
  placing.points.push({ x, y });
  if (placing.kind === 'zone') {
    renderZoneForm();          // Punktzahl im Formular nachziehen
  } else {
    openForm(placing.kind, null, placing.points[0]);
    placing = null;            // Teleport/Encounter brauchen genau einen Punkt
  }
  C.redraw();
}

// Ein einziger Aufraeumer fuer alle Wege aus dem Bearbeiten heraus: Abbrechen,
// das X der Flaeche und Escape. Frueher raeumte nur Abbrechen auf — nach einem
// Klick aufs X blieb die Zone hervorgehoben und die Karte im Bearbeiten-Modus.
function leaveEditing() {
  placing = null;
  editZone = null;
  if (C) C.redraw();
}

export function cancelPlacing() { leaveEditing(); close('editor'); }

// ── Menue "Erstellen" ──────────────────────────────────────────────────────
export function openCreateMenu() {
  if (isOpen('create')) { close('create'); return; }
  const body = document.createElement('div');
  body.innerHTML = U.btn('crTp', 'Teleport', { block: true })
    + `<div style="height:var(--cp-s2)"></div>` + U.btn('crZone', 'Zone', { block: true })
    + `<div style="height:var(--cp-s2)"></div>` + U.btn('crEnc', 'KI-Encounter', { block: true })
    + U.hint('Danach auf die Karte klicken. Bei Zonen mehrfach für die Eckpunkte.');
  floatingPanel('create', { title: 'Erstellen', body, width: 240, x: 24, y: 24 });
  body.querySelector('#crTp').onclick = () => startPlacing('teleport');
  body.querySelector('#crZone').onclick = () => startPlacing('zone');
  body.querySelector('#crEnc').onclick = () => startPlacing('encounter');
}

function startPlacing(kind) {
  close('create');
  placing = { kind, points: [] };
  if (kind === 'zone') renderZoneForm();
  else C.toast('Klick auf die Karte setzt den Punkt.', '');
  C.redraw();
}

// ── Zonen-Formular (waehrend des Setzens sichtbar) ─────────────────────────
function renderZoneForm() {
  const n = placing ? placing.points.length : 0;
  const body = document.createElement('div');
  body.innerHTML = U.select('zType', 'Typ',
      [{ value: 'pvp', label: 'PvP' }, { value: 'pve', label: 'PvE' },
       { value: 'sanctuary', label: 'Sanctuary' }, { value: 'patrol', label: 'Patrol' },
       { value: 'migration', label: 'Migration' }], 'pvp')
    + `<div style="height:var(--cp-s2)"></div>`
    + U.field('zName', 'Name', { placeholder: 'z. B. Nordbucht' })
    + `<div style="height:var(--cp-s3)"></div>`
    + `<div class="cp-muted">${n} Eckpunkte gesetzt</div>`
    + U.hint('Mindestens 3. Auf die Karte klicken zum Setzen.')
    + `<div style="height:var(--cp-s3)"></div>`
    + U.btnRow(U.btn('zUndo', 'Letzten zurück', { size: 'sm', disabled: n === 0 }),
               U.btn('zSave', 'Speichern', { variant: 'primary', size: 'sm', disabled: n < 3 }))
    + `<div style="height:var(--cp-s2)"></div>` + U.btn('zCancel', 'Abbrechen', { size: 'sm', block: true });

  const prev = document.querySelector('#floatPos-editor');
  floatingPanel('editor', { title: 'Zone erstellen', body, width: 260, x: 24, y: 24, onClose: leaveEditing });
  el('zUndo').onclick = () => { if (placing && placing.points.length) { placing.points.pop(); renderZoneForm(); C.redraw(); } };
  el('zCancel').onclick = cancelPlacing;
  el('zSave').onclick = saveNewZone;
  void prev;
}

async function saveNewZone() {
  if (!placing || placing.points.length < 3) return;
  const type = el('zType').value;
  const name = (el('zName').value || '').trim();
  const points = placing.points.slice();
  try {
    // Lesen, ergaenzen, schreiben. POST /zones ersetzt den GESAMTEN Satz —
    // wer blind schreibt, loescht alles, was seit dem Laden dazugekommen ist.
    // Das verkleinert das Zeitfenster auf den Moment des Speicherns.
    const cur = await C.api('GET', '/zones');
    const zones = (cur && cur.zones) || [];
    zones.push({ id: 'z-' + Math.random().toString(36).slice(2, 10), type, name, points });
    await C.api('POST', '/zones', { zones });
    C.toast('Zone gespeichert', 'success');
    placing = null;
    close('editor');
    await C.reloadZones();
  } catch (e) { C.toast(e.message, 'error'); }
}

// ── Formulare fuer Teleport und Encounter ──────────────────────────────────
function openForm(kind, existing, point) {
  const body = document.createElement('div');
  if (kind === 'teleport') {
    body.innerHTML = U.field('tpName', 'Name', { value: existing?.name || '', placeholder: 'z. B. Nordbucht' })
      + `<div style="height:var(--cp-s2)"></div>`
      + U.row(U.field('tpPrice', 'Preis', { type: 'number', value: existing?.price ?? 0, min: 0 }),
              U.field('tpCd', 'Cooldown (Min)', { type: 'number', value: existing?.cooldownMin ?? 0, min: 0 }))
      + `<div style="height:var(--cp-s3)"></div>`
      + U.check('tpWater', 'Wasser-Teleport', !!existing?.water)
      + `<div style="height:var(--cp-s3)"></div>`
      + U.btnRow(U.btn('fmSave', existing ? 'Ersetzen' : 'Anlegen', { variant: 'primary', size: 'sm' }),
                 ...(existing ? [U.btn('fmDel', 'Löschen', { variant: 'danger', size: 'sm' })] : []))
      + `<div style="height:var(--cp-s2)"></div>` + U.btn('fmCancel', 'Abbrechen', { size: 'sm', block: true });
  } else {
    body.innerHTML = U.field('enName', 'Name', { value: existing?.name || '', placeholder: 'z. B. Raptor Patrol' })
      + `<div style="height:var(--cp-s2)"></div>`
      + U.row(U.field('enSpecies', 'Spezies', { value: existing?.species || '', placeholder: 'BP_Utahraptor_C' }),
              U.field('enCount', 'Anzahl', { type: 'number', value: existing?.count ?? 1, min: 1 }))
      + `<div style="height:var(--cp-s3)"></div>`
      + U.btnRow(U.btn('fmSave', existing ? 'Speichern' : 'Anlegen', { variant: 'primary', size: 'sm' }),
                 ...(existing ? [U.btn('fmDel', 'Löschen', { variant: 'danger', size: 'sm' })] : []))
      + `<div style="height:var(--cp-s2)"></div>` + U.btn('fmCancel', 'Abbrechen', { size: 'sm', block: true });
  }

  const title = kind === 'teleport'
    ? (existing ? 'Teleport bearbeiten' : 'Teleport anlegen')
    : (existing ? 'Encounter bearbeiten' : 'Encounter anlegen');
  floatingPanel('editor', { title, body, width: 280, x: 24, y: 24, onClose: leaveEditing });

  el('fmCancel').onclick = () => { leaveEditing(); close('editor'); };
  el('fmSave').onclick = () => (kind === 'teleport' ? saveTeleport(existing, point) : saveEncounter(existing, point));
  const del = el('fmDel');
  if (del) del.onclick = () => armConfirm(del, 'Wirklich löschen?', () => remove(kind, existing));
}

async function saveTeleport(existing, point) {
  const body = {
    name: (el('tpName').value || '').trim(),
    price: Number(el('tpPrice').value) || 0,
    cooldownMin: Number(el('tpCd').value) || 0,
    water: el('tpWater').checked,
  };
  if (!body.name) { C.toast('Name fehlt.', 'error'); return; }
  const pt = point || existing;
  if (pt) { body.x = pt.x; body.y = pt.y; }
  try {
    // Teleports kennen kein Aendern — Ersetzen heisst neu anlegen und alt weg.
    // Reihenfolge bewusst so: erst anlegen, dann loeschen. Andersherum waere der
    // Punkt bei einem Fehler dazwischen ersatzlos verschwunden.
    await C.api('POST', '/teleports', body);
    if (existing) await C.api('DELETE', `/teleports/${encodeURIComponent(existing.id)}`);
    C.toast(existing ? 'Teleport ersetzt' : 'Teleport angelegt', 'success');
    close('editor');
    await C.reloadTeleports();
  } catch (e) { C.toast(e.message, 'error'); }
}

async function saveEncounter(existing, point) {
  const body = {
    ...(existing || {}),
    name: (el('enName').value || '').trim(),
    species: (el('enSpecies').value || '').trim(),
    count: Number(el('enCount').value) || 1,
  };
  const pt = point || (existing && existing.spawn);
  if (pt) body.spawn = { x: pt.x, y: pt.y, z: pt.z || 0 };
  if (!body.species) { C.toast('Spezies fehlt.', 'error'); return; }
  try {
    await C.api('POST', '/admin/mod-ai/encounters', body);
    C.toast(existing ? 'Encounter gespeichert' : 'Encounter angelegt', 'success');
    close('editor');
    await C.reloadEncounters();
  } catch (e) { C.toast(e.message, 'error'); }
}

async function remove(kind, obj) {
  try {
    if (kind === 'teleport') {
      await C.api('DELETE', `/teleports/${encodeURIComponent(obj.id)}`);
      await C.reloadTeleports();
    } else if (kind === 'encounter') {
      await C.api('DELETE', `/admin/mod-ai/encounters/${encodeURIComponent(obj.id)}`);
      await C.reloadEncounters();
    } else {
      // Ohne id wuerde der Filter unten JEDE Zone ohne id mitloeschen.
      if (!obj.id) { C.toast('Diese Zone hat keine id — Löschen abgebrochen.', 'error'); return; }
      const cur = await C.api('GET', '/zones');
      const zones = ((cur && cur.zones) || []).filter((z) => z.id !== obj.id);
      await C.api('POST', '/zones', { zones });
      await C.reloadZones();
    }
    C.toast('Gelöscht', 'success');
    close('editor');
  } catch (e) { C.toast(e.message, 'error'); }
}

// ── Bearbeiten per Rechtsklick ─────────────────────────────────────────────
export function openEdit(kind, obj) {
  if (kind === 'zone') {
    // Auf einer KOPIE arbeiten: solange nicht gespeichert ist, darf die Karte
    // ihren Originalzustand behalten (Abbrechen muss folgenlos sein).
    editZone = { id: obj.id, type: obj.type, name: obj.name, points: (obj.points || []).map((p) => ({ ...p })) };
    C.redraw();
    const body = document.createElement('div');
    body.innerHTML = U.select('zeType', 'Typ',
        [{ value: 'pvp', label: 'PvP' }, { value: 'pve', label: 'PvE' },
         { value: 'sanctuary', label: 'Sanctuary' }, { value: 'patrol', label: 'Patrol' },
         { value: 'migration', label: 'Migration' }], obj.type)
      + `<div style="height:var(--cp-s2)"></div>`
      + U.field('zeName', 'Name', { value: obj.name || '' })
      + `<div style="height:var(--cp-s2)"></div>`
      + `<div class="cp-muted">${(obj.points || []).length} Eckpunkte</div>`
      + U.hint('Eckpunkte lassen sich auf der Karte ziehen; Ziehen innerhalb der Fläche verschiebt die ganze Zone.')
      + `<div style="height:var(--cp-s3)"></div>`
      + U.btnRow(U.btn('fmSave', 'Speichern', { variant: 'primary', size: 'sm' }),
                 U.btn('fmDel', 'Löschen', { variant: 'danger', size: 'sm' }))
      + `<div style="height:var(--cp-s2)"></div>` + U.btn('fmCancel', 'Abbrechen', { size: 'sm', block: true });
    floatingPanel('editor', { title: 'Zone bearbeiten', body, width: 280, x: 24, y: 24, onClose: leaveEditing });
    el('fmCancel').onclick = () => { leaveEditing(); close('editor'); };
    el('fmSave').onclick = async () => {
      if (!obj.id) { C.toast('Diese Zone hat keine id — Speichern abgebrochen.', 'error'); return; }
      try {
        const cur = await C.api('GET', '/zones');
        const zones = ((cur && cur.zones) || []).map((z) =>
          z.id === obj.id
            ? { ...z, type: el('zeType').value, name: (el('zeName').value || '').trim(), points: editZone.points }
            : z);
        await C.api('POST', '/zones', { zones });
        C.toast('Zone gespeichert', 'success');
        leaveEditing();
        close('editor');
        await C.reloadZones();
      } catch (e) { C.toast(e.message, 'error'); }
    };
    const d = el('fmDel');
    d.onclick = () => armConfirm(d, 'Wirklich löschen?', () => remove('zone', obj));
    return;
  }
  openForm(kind, obj, null);
}

export function closeEditor() { close('editor'); close('create'); leaveEditing(); }
export { escapeHtml };
