// Update-Zustand der Companion — eine Quelle, einmal registriert.
//
// Warum eigenes Modul und nicht im Settings-Panel:
//
// Der Hauptprozess prueft beim Start und danach stuendlich (companion-main.js
// setupAutoUpdate). Die Ereignisse wurden bisher aber ERST registriert, wenn
// man Settings › Software oeffnete — wer das nie tat, bei dem verpuffte jede
// Meldung, und electron-updater schickt sie nicht erneut. Der Timer lief also,
// ohne dass je etwas davon ankam.
//
// Zweitens registrierte jedes Oeffnen des Reiters die Zuhoerer NEU
// (ipcRenderer.on ohne Gegenstueck), sodass sie sich stapelten.
//
// Beides loest dieselbe Massnahme: einmal beim Start registrieren, Zustand
// hier halten, und alle Anzeigen lesen ihn.

const S = {
  state: 'idle',   // idle | pruefe | aktuell | verfuegbar | laedt | bereit | fehler
  version: '',     // Version des gefundenen Updates
  progress: 0,     // 0..100 waehrend des Ladens
  message: '',     // Fehlertext
};

const horcher = new Set();

function setzen(next) {
  Object.assign(S, next);
  for (const f of horcher) {
    try { f(getUpdate()); } catch { /* eine kaputte Anzeige darf die anderen nicht mitreissen */ }
  }
}

export function getUpdate() { return { ...S }; }

// Gibt es etwas, das den Nutzer interessiert? Genau daran haengt der rote Punkt.
// Bewusst NICHT bei "laedt": das laeuft bereits, da ist nichts mehr zu tun.
export function hasUpdate() { return S.state === 'verfuegbar' || S.state === 'bereit'; }

export function onUpdateChange(f) {
  horcher.add(f);
  return () => horcher.delete(f);
}

// Einmal beim Start aufrufen. Ein zweiter Aufruf wuerde die Zuhoerer verdoppeln,
// deshalb der Riegel.
let bereit = false;
export function initUpdates(bf) {
  if (bereit) return;
  bereit = true;
  bf.onUpdateAvailable((v) => setzen({ state: 'verfuegbar', version: v || '', message: '' }));
  bf.onUpdateNone(() => setzen({ state: 'aktuell', version: '', message: '' }));
  bf.onUpdateProgress((p) => setzen({ state: 'laedt', progress: Number(p) || 0 }));
  bf.onUpdateReady((v) => setzen({ state: 'bereit', version: v || '', progress: 100 }));
  bf.onUpdateError((m) => setzen({ state: 'fehler', message: String(m || '') }));
}

export function checkUpdate(bf) { setzen({ state: 'pruefe', message: '' }); bf.updateCheck(); }
export function downloadUpdate(bf) { setzen({ state: 'laedt', progress: 0 }); bf.updateDownload(); }
export function installUpdate(bf) { bf.updateInstall(); }

// Text fuer die Statuszeile. Hier statt im Panel, damit Anzeige und Zustand
// nicht auseinanderlaufen, wenn eine zweite Stelle dazukommt.
export function updateText(u) {
  switch (u.state) {
    case 'pruefe': return 'Suche nach Updates…';
    case 'aktuell': return 'Aktuell — kein Update verfügbar.';
    case 'verfuegbar': return `Version ${u.version} verfügbar.`;
    case 'laedt': return `Lädt… ${u.progress}%`;
    case 'bereit': return `Version ${u.version} bereit.`;
    case 'fehler': return 'Update fehlgeschlagen: ' + kurzFehler(u.message);
    default: return 'Bereit';
  }
}

// electron-updater haengt an seine Fehlermeldung den kompletten Stacktrace samt
// Dateipfaden aus dem entpackten Paket — vierzig Zeilen, die in einer
// Statuszeile landen und dort nichts erklaeren.
//
// Der haeufigste Fall hat ausserdem eine praezise Ursache, die die Rohmeldung
// nicht nennt: 404 heisst, dass es fuer DIESE Umgebung und DIESEN Kanal keinen
// Feed gibt — etwa weil die App gegen Produktion zeigt, wo nie ein Companion-
// Release hochgeladen wurde.
export function kurzFehler(m) {
  const roh = String(m == null ? '' : m);
  if (/\b404\b/.test(roh)) {
    return 'kein Update-Feed auf dieser Umgebung (404) — dort wurde vermutlich nie ein Build veröffentlicht.';
  }
  // Vor dem ersten Zeilenumbruch abschneiden. Der Text traegt beide Formen:
  // echte Umbrueche und als "\n" ausgeschriebene.
  let s = roh.split('\n')[0].split('\\n')[0];
  // Stack-Rahmen beginnen mit " at " — alles ab da ist fuer den Nutzer wertlos.
  const at = s.indexOf(' at ');
  if (at > 20) s = s.slice(0, at);
  s = s.trim().replace(/[\s:]+$/, '');
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}
