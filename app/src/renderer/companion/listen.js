// Mithören (nur Admin): der Voice-Umkreis eines ausgewählten Spielers.
//
// Wie es funktioniert
// -------------------
// Der Admin verbindet sich ZUSÄTZLICH zu seinem normalen Voice als reiner
// Zuhörer mit demselben LiveKit-Raum. Wer zu hören ist, entscheidet die
// Lautstärke: jeder Teilnehmer im Radius um den ausgewählten Spieler bekommt
// volle Lautstärke, alle anderen null.
//
// Bewusst KEIN 3D
// ---------------
// Das Overlay hängt an jede Spur zusätzlich Panner und Lowpass
// (attachSpatialPlugins). Hier wird das schlicht weggelassen — mono ist der
// Normalzustand, Raumklang die Zutat. Beim Mithören will man verstehen, was
// gesagt wird, und nicht raten, aus welcher Richtung es kam.
//
// Genau ein Ziel
// --------------
// Mehrere Umkreise gleichzeitig würde bedeuten, dass ein Spieler in zwei
// Radien liegt und man nicht mehr sagen kann, wem man gerade zuhört. Deshalb
// ist die Funktion an genau eine Auswahl gebunden.
//
// Das Token holt POST /voice/listen — dort sitzt die Admin-Prüfung UND der
// Protokolleintrag. Ohne Protokoll gibt es kein Token; ein rein clientseitiges
// Mithören ist damit nicht möglich, und das ist Absicht.
import { UNITS_PER_M } from '../shared/format.js';

let C = null;
let room = null;
let LK = null;              // nachgeladenes livekit-client
let target = null;          // steamId des abgehörten Spielers
let radiusM = 50;
let connecting = false;
const attached = new Map(); // identity -> <audio>

export function initListen(ctx) { C = ctx; }

export function isListening() { return !!room; }
export function listenTarget() { return target; }
export function listenRadius() { return radiusM; }

export function setRadius(m) {
  radiusM = Math.max(5, Math.min(500, Number(m) || 50));
  applyVolumes();
  // Den Radius auch serverseitig nachziehen: bei aktivem VOICE_BACKEND_ENABLED
  // entscheidet er dort ueber die Subscriptions, sonst nur ueber das Protokoll.
  if (room && target) report(target, radiusM).catch(() => {});
}

async function report(steamId, r) {
  return C.api('POST', '/voice/listen', { steamId, radius: r });
}

// livekit-client wird erst beim ersten Mithoeren AUSGEWERTET.
//
// Was das dynamische import() NICHT tut: die Bytes einsparen. esbuild baut ein
// IIFE-Bundle und kann darin nicht aufteilen — das Paket liegt immer bei und
// laesst companion.js von 147 KB auf 1,3 MB wachsen. Das ginge nur mit
// ESM-Ausgabe samt Code-Splitting, also einem Umbau des Build-Ziels.
//
// Was es sehr wohl tut: esbuild verpackt den Zweig in eine Fabrik, die erst
// beim Aufruf laeuft. Wer nie mithoert, fuehrt livekits Modulinitialisierung
// samt WebRTC-Adapter also nie aus.
async function lk() {
  if (!LK) LK = await import('livekit-client');
  return LK;
}

export async function startListening(steamId) {
  if (connecting) return;
  if (!C.can('voice.listen')) { C.toast('Mithören ist Admins vorbehalten.', 'error'); return; }
  if (!steamId) { C.toast('Erst einen Spieler auswählen.', 'error'); return; }
  connecting = true;
  try {
    const d = await report(steamId, radiusM);
    if (!d || !d.token || !d.url) throw new Error('Kein Voice-Zugang erhalten.');
    const { Room, RoomEvent, Track } = await lk();
    target = steamId;
    room = new Room({ adaptiveStream: false, dynacast: false });
    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        // attach() ohne Spatial-Plugins — siehe Kopf: bewusst mono.
        const a = track.attach();
        a.autoplay = true;
        document.body.appendChild(a);
        if (participant) attached.set(participant.identity, a);
        applyVolumes();
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        track.detach().forEach((n) => n.remove());
        if (participant) attached.delete(participant.identity);
      })
      .on(RoomEvent.Disconnected, () => { cleanup(); C.onChange(); });

    // autoSubscribe:true — wir wollen alles hereinbekommen und selbst ueber die
    // Lautstaerke entscheiden. Steuert das Backend die Subscriptions (Flag an),
    // bekommt der Lauscher ohnehin nur seinen Umkreis; dann ist das hier
    // schlicht wirkungslos statt falsch.
    await room.connect(d.url, d.token, { autoSubscribe: true });
    // Mikrofon NIE einschalten: das Token verbietet Publizieren ohnehin, aber
    // gar nicht erst danach zu fragen erspart die Berechtigungsabfrage.
    try { await room.startAudio(); } catch { /* Autoplay-Sperre — Klick folgt */ }
    applyVolumes();
  } catch (err) {
    cleanup();
    C.toast('Mithören fehlgeschlagen: ' + err.message, 'error');
  } finally {
    connecting = false;
    C.onChange();
  }
}

export async function stopListening() {
  const war = !!room;
  try { if (room) await room.disconnect(); } catch { /* egal, wir raeumen eh auf */ }
  cleanup();
  // Das Ende gehoert genauso ins Protokoll wie der Anfang.
  if (war) { try { await C.api('POST', '/voice/listen', { stop: true }); } catch { /* Protokoll best effort */ } }
  C.onChange();
}

function cleanup() {
  for (const a of attached.values()) a.remove();
  attached.clear();
  room = null;
  target = null;
}

// Ziel wechseln, ohne die Verbindung neu aufzubauen. Der Server bekommt es
// gemeldet (Protokoll + ggf. Subscriptions), die Lautstaerken folgen sofort.
export async function retarget(steamId) {
  if (!room || !steamId || steamId === target) return;
  target = steamId;
  applyVolumes();
  try { await report(steamId, radiusM); }
  catch (err) { C.toast('Zielwechsel nicht protokolliert: ' + err.message, 'error'); }
}

// Lautstaerke je Teilnehmer: im Radius um das ZIEL = voll, sonst stumm.
//
// Harte Kante statt weichem Uebergang — anders als beim Proximity-Voice des
// Overlays, wo die Entfernung die Lautstaerke moduliert. Hier soll klar sein,
// wen man hoert und wen nicht; ein halblauter Spieler am Rand waere weder
// verstaendlich noch als "drin" erkennbar.
export function applyVolumes() {
  if (!room) return;
  const players = C.players() || [];
  const t = players.find((p) => p.steamId === target);
  const r = radiusM * UNITS_PER_M;
  for (const p of room.remoteParticipants.values()) {
    let vol = 0;
    if (t) {
      const q = players.find((x) => x.steamId === p.identity);
      // 2D reicht: die Karte ist die Bezugsflaeche, und Hoehenunterschiede
      // sagen beim Mithoeren nichts Nuetzliches aus.
      if (q && Math.hypot(q.x - t.x, q.y - t.y) <= r) vol = 1;
    }
    try { p.setVolume(vol); } catch { /* Teilnehmer gerade weg */ }
  }
}

// Wer gerade tatsaechlich zu hoeren ist — fuer die Anzeige.
export function audibleCount() {
  if (!room) return 0;
  const players = C.players() || [];
  const t = players.find((p) => p.steamId === target);
  if (!t) return 0;
  const r = radiusM * UNITS_PER_M;
  return players.filter((q) => !q.isDead && q.steamId !== target
    && Math.hypot(q.x - t.x, q.y - t.y) <= r).length;
}
