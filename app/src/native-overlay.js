// ── Natives Fenster-Tracking (Windows) via electron-overlay-window ───────────
// Ersetzt auf Windows die beiden PowerShell-Dauerprozesse (Foreground-Watch +
// Geometrie-Probe) UND den ALT-Tap/AttachThreadInput-Foreground-Steal durch das
// Modell von Awakened PoE Trade: SetWinEventHook (WINEVENT_OUTOFCONTEXT, keine
// Injection) liefert Attach/Focus/Blur/MoveResize als Events, die Bibliothek
// führt das Overlay-Fenster selbst nach (inkl. DIP-Umrechnung, Multi-Monitor,
// MSAA-Gegenprüfung gegen falsche Foreground-Events, 83-ms-Timer-Fallback).
//
// Warum: die PowerShell-Probes (Add-Type = Laufzeit-C#-Kompilierung aus %TEMP%)
// sind ein Virenscanner-Magnet und liefen bei einem Teil der Nutzer still nicht
// (Symptome in 1.10.0: Overlay falsch positioniert, "run as admin hilft").
// Zusätzlich meldet die Bibliothek beim Attach hasAccess=false, wenn das Spiel
// erhöht läuft und wir nicht (UIPI) — DER "run as admin"-Fall, endlich sichtbar.
//
// Einschränkungen der Bibliothek (bewusst akzeptiert):
//  - Initialisierung nur EINMAL je Prozesslauf, Zieltitel danach fix.
//  - Genau ein Overlay-Fenster.
// Fallback: schlägt hier irgendetwas fehl (Modul lädt nicht, kein Attach), läuft
// in main.js der bisherige PowerShell-Pfad weiter — Kill-Switch: BF_LEGACY_TRACKING=1.
const { screen } = require('electron');

// UE5 setzt den Fenstertitel auf den Projektnamen — auf Linux/X11 ist er als
// exakt "TheIsle" verifiziert (syncOverlayToGameWindow prüft denselben String).
// Auf Windows per BF_GAME_TITLE übersteuerbar, falls der Client dort abweicht.
const TARGET_TITLE = process.env.BF_GAME_TITLE || 'TheIsle';

const state = {
  enabled: false,       // Modul geladen + attachByTitle aufgerufen
  everAttached: false,  // Spielfenster mindestens einmal gefunden
  attached: false,      // aktuell attached (Fenster existiert)
  targetHasFocus: false,
  hasAccess: undefined, // false = UIPI: Spiel läuft erhöht, wir nicht
};

let OverlayController = null;

// Startet das native Tracking. overlayWindow = das (bereits erzeugte) Overlay-
// BrowserWindow. notify(type, payload) → Meldung Richtung Renderer (Toast).
// Rückgabe false = nicht verfügbar, Aufrufer bleibt beim Legacy-Pfad.
function init(overlayWindow, notify) {
  if (process.platform !== 'win32') return false;
  if (process.env.BF_LEGACY_TRACKING === '1') {
    console.warn('[native-overlay] BF_LEGACY_TRACKING=1 → PowerShell-Pfad erzwungen');
    return false;
  }
  if (state.enabled) return true; // Bibliothek erlaubt nur EINE Initialisierung
  try {
    ({ OverlayController } = require('electron-overlay-window'));
  } catch (err) {
    console.error('[native-overlay] Modul nicht ladbar → Legacy-Pfad:', err?.message || err);
    return false;
  }
  try {
    OverlayController.events.on('attach', (e) => {
      state.everAttached = true;
      state.attached = true;
      state.hasAccess = e.hasAccess;
      console.log(`[native-overlay] attach: ${e.width}x${e.height}@${e.x},${e.y}`
        + ` hasAccess=${e.hasAccess} fullscreen=${e.isFullscreen}`);
      // UIPI: Spiel läuft als Administrator, das Overlay nicht → wir dürfen dem
      // Fenster weder folgen noch den Fokus übernehmen. Bisher scheiterte das
      // STILL; jetzt bekommt der Spieler die eine Zeile, die das Ticket erspart.
      if (e.hasAccess === false) {
        notify?.('uipi', 'The Isle läuft als Administrator — bitte das Overlay ebenfalls '
          + '„Als Administrator ausführen", sonst kann es dem Spielfenster nicht folgen.');
      }
    });
    OverlayController.events.on('detach', () => { state.attached = false; state.targetHasFocus = false; });
    OverlayController.events.on('focus', () => { state.targetHasFocus = true; });
    OverlayController.events.on('blur', () => { state.targetHasFocus = false; });
    // Die Bibliothek setzt bei attach/focus setIgnoreMouseEvents(true) OHNE die
    // forward-Option — damit bekaeme der Renderer keine mousemove-Events mehr
    // (Hover im HUD tot). Unsere Listener laufen NACH ihren (Registrierungs-
    // reihenfolge des EventEmitters) und re-assertieren forward:true.
    for (const ev of ['attach', 'focus']) {
      OverlayController.events.on(ev, () => {
        try { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch {}
      });
    }
    // moveresize/Bounds übernimmt die Bibliothek selbst (inkl. screenToDipRect).
    OverlayController.attachByTitle(overlayWindow, TARGET_TITLE);
    state.enabled = true;
    console.log(`[native-overlay] aktiv — warte auf Fenster "${TARGET_TITLE}"`);
    return true;
  } catch (err) {
    console.error('[native-overlay] attachByTitle fehlgeschlagen → Legacy-Pfad:', err?.message || err);
    return false;
  }
}

// Interaktiv-Modus: Overlay bekommt Maus + Fokus (Panels/Karte bedienbar).
function activate() {
  if (!state.enabled) return false;
  try { OverlayController.activateOverlay(); return true; } catch { return false; }
}

// Interaktiv-Modus beenden: Fokus explizit ans SPIEL zurückgeben (natives
// SetForegroundWindow auf das Zielfenster — zuverlässiger als blur()).
function release() {
  if (!state.enabled) return false;
  try { OverlayController.focusTarget(); return true; } catch { return false; }
}

// Aktuelle Spiel-Client-Fläche in DIP (für den Idle-Window-Shrink). null, wenn
// (noch) kein Attach oder die Fläche unbrauchbar ist.
function gameDipBounds(overlayWindow) {
  if (!state.enabled || !state.everAttached) return null;
  const b = OverlayController.targetBounds; // physische Pixel (Windows)
  if (!b || b.width <= 0 || b.height <= 0) return null;
  try { return screen.screenToDipRect(overlayWindow ?? null, b); } catch { return null; }
}

module.exports = { state, init, activate, release, gameDipBounds };
