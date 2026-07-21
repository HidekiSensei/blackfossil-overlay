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
import { SPAWN_SPECIES, toClass, fromClass } from '../shared/species.js';
import { floatingPanel, close, isOpen } from './floating.js';
import * as U from './ui.js';

// Verhaltens-Archetypen wie im Overlay (svArchOpts) — dieselbe Liste, damit
// beide Apps dieselben Werte schreiben.
const ARCHETYPES = ['territorial_guard', 'pack_hunter', 'herd', 'ambush',
  'skittish_prey', 'scavenger', 'nomad', 'apex_solo'];

// Radien werden in METERN eingegeben und in Welt-Einheiten gespeichert —
// dieselbe Umrechnung wie im Overlay (UNITS_PER_M).
const UNITS_PER_M = 200;
const toM = (v) => (v == null ? '' : Math.round(v / UNITS_PER_M));
const toUnits = (v) => (v === '' || v == null || isNaN(v) ? undefined : Math.round(Number(v) * UNITS_PER_M));

let C = null;
// { kind: 'teleport'|'zone'|'encounter', points: [{x,y}] } waehrend des Setzens
let placing = null;
// Die gerade bearbeitete Zone (Kopie!). Die Karte zeichnet sie hervorgehoben und
// meldet Verschiebungen ueber setZonePoints zurueck.
let editZone = null;

// Der gerade bearbeitete Encounter bzw. Teleport (ebenfalls Kopien).
let editEnc = null;
let editTp = null;

export function editingZone() { return editZone; }
export function setZonePoints(points) { if (editZone) editZone.points = points; }

// Die Eckpunktzahl im offenen Formular nachziehen. Ohne das behauptet das
// Panel weiter den Stand von vor dem Einfuegen — man sieht die Aenderung auf
// der Karte, aber die Zahl daneben luegt.
function refreshZoneCount() {
  const box = document.getElementById('zeCount');
  if (box && editZone) box.textContent = `${editZone.points.length} Eckpunkte`;
}

// Neuen Eckpunkt an Position `index` einfuegen (aus einem Geister-Punkt) und
// seinen Index zurueckgeben, damit der Aufrufer sofort weiterziehen kann.
export function insertZonePoint(index, x, y) {
  if (!editZone) return -1;
  const pts = editZone.points.slice();
  pts.splice(index + 1, 0, { x, y });
  editZone.points = pts;
  refreshZoneCount();
  return index + 1;
}

// Eckpunkt entfernen. Unter 3 Punkten waere es kein Polygon mehr.
export function removeZonePoint(index) {
  if (!editZone || editZone.points.length <= 3) return false;
  editZone.points = editZone.points.filter((_, i) => i !== index);
  refreshZoneCount();
  return true;
}
export function editingTeleport() { return editTp; }
export function setTeleportPos(x, y) { if (editTp) { editTp.x = x; editTp.y = y; } }
export function editingEncounter() { return editEnc; }

// Patrouillenpunkt an Streckenmitte `index` einfuegen. index bezieht sich auf
// encounterMidpoints: Mitte i liegt zwischen Anfasser i und i+1. Anfasser 0 ist
// der Spawn, ab 1 die Patrouille — der neue Punkt landet also an patrol[index].
export function insertPatrolPoint(index, x, y) {
  if (!editEnc) return -1;
  const pts = (editEnc.patrol || []).slice();
  pts.splice(index, 0, { x, y, z: 0 });
  editEnc.patrol = pts;
  refreshEncCount();
  return index + 1;   // Anfasser-Index des neuen Punktes
}

// Patrouillenpunkt entfernen. handleIndex 0 ist der Spawn und bleibt — ein
// Encounter braucht mindestens seinen Startpunkt.
export function removePatrolPoint(handleIndex) {
  if (!editEnc || handleIndex < 1) return false;
  const i = handleIndex - 1;
  if (!editEnc.patrol || i >= editEnc.patrol.length) return false;
  editEnc.patrol = editEnc.patrol.filter((_, k) => k !== i);
  refreshEncCount();
  return true;
}

// Neuen Punkt ans Ende der Route haengen (fuer "Pfad zeichnen", wenn es noch
// keinen gibt).
export function appendPatrolPoint(x, y) {
  if (!editEnc) return;
  editEnc.patrol = [...(editEnc.patrol || []), { x, y, z: 0 }];
  refreshEncCount();
}

function refreshEncCount() {
  const box = document.getElementById('enCount2');
  if (box && editEnc) {
    const n = (editEnc.patrol || []).length;
    box.textContent = n ? `${n} Patrouillenpunkte` : 'Kein Patrouillenpfad';
  }
}
export function setEncounterGeom(spawn, patrol) {
  if (!editEnc) return;
  editEnc.spawn = spawn;
  editEnc.patrol = patrol;
}

export function initEditor(ctx) { C = ctx; }

// Zeichnen einer Patrouille an einem BESTEHENDEN Encounter — getrennt vom
// Anlegen (placing), weil dabei an eine vorhandene Route angehaengt wird.
let drawingPatrol = false;
export function isDrawingPatrol() { return drawingPatrol; }
export function stopDrawingPatrol() { drawingPatrol = false; }

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
  drawingPatrol = false;
  editZone = null;
  editEnc = null;
  editTp = null;
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
      + (existing ? U.hint('Der Punkt lässt sich auf der Karte ziehen.') : '')
      + `<div style="height:var(--cp-s3)"></div>`
      + U.btnRow(U.btn('fmSave', existing ? 'Ersetzen' : 'Anlegen', { variant: 'primary', size: 'sm' }),
                 ...(existing ? [U.btn('fmDel', 'Löschen', { variant: 'danger', size: 'sm' })] : []))
      + `<div style="height:var(--cp-s2)"></div>` + U.btn('fmCancel', 'Abbrechen', { size: 'sm', block: true });
  } else {
    const e0 = existing || {};
    const nPat = (e0.patrol || []).length;
    // Auswahlliste mit Klarnamen (ohne BP_/_C) — gespeichert wird die Klasse.
    // Steht die Art eines bestehenden Encounters NICHT in der Liste (Altbestand
    // oder inzwischen gesperrt), wird sie trotzdem angeboten und markiert. Sonst
    // wuerde ein Speichern die Art stillschweigend auf den ersten Eintrag
    // aendern — ein Datenverlust, den niemand bemerkt.
    const cur = fromClass(e0.species);
    const known = SPAWN_SPECIES.includes(cur);
    const speciesOpts = [
      ...(cur && !known ? [{ value: cur, label: `${cur} (nicht in der Liste)` }] : []),
      ...SPAWN_SPECIES.map((n) => ({ value: n, label: n })),
    ];
    body.innerHTML = U.field('enName', 'Name', { value: e0.name || '', placeholder: 'z. B. Raptor Patrol' })
      + `<div style="height:var(--cp-s2)"></div>`
      + U.select('enSpecies', 'Dino-Klasse', speciesOpts, cur || SPAWN_SPECIES[0])
      + `<div style="height:var(--cp-s2)"></div>`
      + U.row(U.select('enArch', 'Verhalten', ARCHETYPES, e0.archetype || 'herd'),
              U.field('enCount', 'Anzahl', { type: 'number', value: e0.count ?? 1, min: 1, max: 20 }))
      + `<div style="height:var(--cp-s2)"></div>`
      + U.check('enEnabled', 'Aktiv', e0.enabled !== false)

      + U.sec('Patrouille')
      + `<div class="cp-muted" id="enCount2">${nPat ? `${nPat} Patrouillenpunkte` : 'Kein Patrouillenpfad'}</div>`
      + (existing
          ? U.hint('Roter Punkt = Spawn. Weiße Punkte ziehen verschiebt sie, grüne + auf '
                 + 'den Strecken fügen ein, Rechtsklick auf einen weißen Punkt entfernt ihn. '
                 + 'Der Spawn bleibt immer.')
          : U.hint('Nach dem Anlegen lässt sich die Route auf der Karte zeichnen.'))
      + (existing ? `<div style="height:var(--cp-s2)"></div>` + U.btn('enDraw', nPat ? 'Weitere Punkte anhängen' : 'Pfad zeichnen', { size: 'sm', block: true }) : '')

      // Beschriftungen woertlich wie im Overlay-Editor — dieselben Felder sollen
      // in beiden Apps gleich heissen, sonst raet man, ob dasselbe gemeint ist.
      // Als Expander statt zweitem Dialog: ein Speichern, ein Kontext.
      + U.expander('🧠 Verhalten (Brain)',
          U.field('enRespawn', 'Respawn-Delay (s)', { type: 'number', value: e0.respawnDelaySec ?? '', min: 0 })
          + `<div style="height:var(--cp-s2)"></div>`
          + U.row(U.field('enHome', 'Heimat-Radius (m)', { type: 'number', value: toM(e0.homeRadius), min: 0 }),
                  U.field('enLeash', 'Leine (m)', { type: 'number', value: toM(e0.leashRadius), min: 0 }))
          + `<div style="height:var(--cp-s2)"></div>`
          + U.row(U.field('enChase', 'Jagd-Timeout (s)', { type: 'number', value: e0.chaseTimeoutSec ?? '', min: 0 }),
                  U.field('enPause', 'Patrouillen-Pause (s)', { type: 'number', value: e0.patrolPauseSec ?? '', min: 0 }))
          + `<div style="height:var(--cp-s2)"></div>`
          + U.row(U.field('enPackC', 'Rudel-Zusammenhalt (m)', { type: 'number', value: toM(e0.packCohesionRadius), min: 0 }),
                  U.field('enPackA', 'Rudel-Beistand (m)', { type: 'number', value: toM(e0.packAssistRadius), min: 0 }))
          + `<div style="height:var(--cp-s3)"></div>`
          + U.check('enDayActive', '☀️ Tagaktiv (ruht nachts)', e0.schedule ? e0.schedule.dayActive !== false : true)
          + `<div style="height:var(--cp-s2)"></div>`
          + U.hourRange('enSleep', 'enWake', 'Ruhezeit',
                        e0.schedule?.sleepFromHour ?? 21, e0.schedule?.wakeHour ?? 6)
          + U.hint('Leere Felder bleiben auf den Vorgaben der Mod. Radien in Metern — '
                 + 'gespeichert wird in Welt-Einheiten, wie im Overlay.'))

      + `<div style="height:var(--cp-s4)"></div>`
      + U.btnRow(U.btn('fmSave', existing ? 'Speichern' : 'Anlegen', { variant: 'primary', size: 'sm' }),
                 ...(existing ? [U.btn('fmDel', 'Löschen', { variant: 'danger', size: 'sm' })] : []))
      + `<div style="height:var(--cp-s2)"></div>` + U.btn('fmCancel', 'Abbrechen', { size: 'sm', block: true });
  }

  // Beim Bearbeiten eines vorhandenen Encounters ist die Geometrie ziehbar —
  // auf einer Kopie, damit Abbrechen folgenlos bleibt.
  if (kind === 'teleport' && existing) {
    editTp = { ...existing };
    C.redraw();
  }
  if (kind === 'encounter' && existing) {
    editEnc = {
      ...existing,
      spawn: existing.spawn ? { ...existing.spawn } : null,
      patrol: (existing.patrol || []).map((p) => ({ ...p })),
    };
    C.redraw();
  }

  const title = kind === 'teleport'
    ? (existing ? 'Teleport bearbeiten' : 'Teleport anlegen')
    : (existing ? 'Encounter bearbeiten' : 'Encounter anlegen');
  floatingPanel('editor', { title, body, width: kind === 'encounter' ? 320 : 280, x: 24, y: 24, onClose: leaveEditing });
  { const d = el('enDraw'); if (d) d.onclick = () => { drawingPatrol = true; C.toast('Klick auf die Karte hängt Punkte an. Escape beendet.', ''); }; }
  if (kind === 'encounter') {
    U.bindHourRange(body, 'enSleep', 'enWake',
      (a, b) => `schläft ${String(a).padStart(2, '0')}:00 – ${String(b).padStart(2, '0')}:00`);
  }

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
  // Gezogene Position hat Vorrang vor dem gespeicherten Stand.
  const pt = editTp || point || existing;
  if (pt) { body.x = pt.x; body.y = pt.y; }
  try {
    // Teleports kennen kein Aendern — Ersetzen heisst neu anlegen und alt weg.
    // Reihenfolge bewusst so: erst anlegen, dann loeschen. Andersherum waere der
    // Punkt bei einem Fehler dazwischen ersatzlos verschwunden.
    await C.api('POST', '/teleports', body);
    if (existing) await C.api('DELETE', `/teleports/${encodeURIComponent(existing.id)}`);
    C.toast(existing ? 'Teleport ersetzt' : 'Teleport angelegt', 'success');
    leaveEditing();
    close('editor');
    await C.reloadTeleports();
  } catch (e) { C.toast(e.message, 'error'); }
}

async function saveEncounter(existing, point) {
  const num = (id) => { const v = el(id)?.value; return v === '' || v == null ? undefined : Number(v); };
  const body = {
    ...(existing || {}),
    name: (el('enName').value || '').trim(),
    species: toClass(el('enSpecies').value),
    archetype: el('enArch')?.value,
    count: Math.max(1, Math.min(20, Number(el('enCount').value) || 1)),
    enabled: el('enEnabled') ? el('enEnabled').checked : true,
    respawnDelaySec: num('enRespawn'),
    chaseTimeoutSec: num('enChase'),
    patrolPauseSec: num('enPause'),
    homeRadius: toUnits(el('enHome')?.value),
    leashRadius: toUnits(el('enLeash')?.value),
    packCohesionRadius: toUnits(el('enPackC')?.value),
    packAssistRadius: toUnits(el('enPackA')?.value),
  };
  if (el('enDayActive')) {
    body.schedule = {
      dayActive: el('enDayActive').checked,
      sleepFromHour: Math.max(0, Math.min(23, Number(el('enSleep').value) || 21)),
      wakeHour: Math.max(0, Math.min(23, Number(el('enWake').value) || 6)),
    };
  }
  // Gezogene Geometrie hat Vorrang vor dem gespeicherten Stand.
  if (editEnc) {
    if (editEnc.spawn) body.spawn = { ...editEnc.spawn };
    if (editEnc.patrol) body.patrol = editEnc.patrol.map((p) => ({ ...p }));
  }
  const pt = point || (!editEnc && existing && existing.spawn);
  if (pt) body.spawn = { x: pt.x, y: pt.y, z: pt.z || 0 };
  if (!body.species) { C.toast('Spezies fehlt.', 'error'); return; }
  try {
    // ACHTUNG: POST /admin/mod-ai/encounters LEGT IMMER NEU AN. Die mitgeschickte
    // id wird ignoriert; das Backend haengt bei Namenskollision einen Zaehler an
    // (maia_herd_wandernd, _2, _3 …). Ein Update gibt es nicht — es existiert nur
    // GET, POST und DELETE /{id}.
    //
    // Bearbeiten heisst deshalb: neu anlegen, dann das alte loeschen. Reihenfolge
    // bewusst so, damit bei einem Fehler dazwischen der Encounter nicht ersatzlos
    // verschwindet. Ohne das Loeschen entstehen Duplikate — genau das ist
    // passiert, bevor dieser Zweig existierte.
    await C.api('POST', '/admin/mod-ai/encounters', body);
    if (existing && existing.id) {
      await C.api('DELETE', `/admin/mod-ai/encounters/${encodeURIComponent(existing.id)}`);
    }
    C.toast(existing ? 'Encounter gespeichert' : 'Encounter angelegt', 'success');
    leaveEditing();
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
      + `<div class="cp-muted" id="zeCount">${(obj.points || []).length} Eckpunkte</div>`
      + U.hint('Weiße Punkte ziehen verschiebt sie. Grüne + auf den Kanten werden beim '
             + 'Ziehen zu neuen Eckpunkten. Rechtsklick auf einen weißen Punkt entfernt ihn. '
             + 'Ziehen innerhalb der Fläche verschiebt die ganze Zone.')
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
