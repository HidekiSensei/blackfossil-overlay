import { baseClass, fmtGrow, escapeHtml, fmtTod } from './format.js';
import { userLabel, matchUser, warnItemUser } from './users.js';
import { apiErr, armConfirm } from './core.js';
import { makePerms, can, CAPS } from './perms.js';
import { NAV_GROUPS, NAV_SETTINGS, itemFor } from '../companion/nav.js';
import { clean, canon } from '../companion/panels/dinos.js';
import { initUpdates, getUpdate, hasUpdate, onUpdateChange, updateText } from '../companion/updates.js';
import { makeTheme, themeFromHex, hexToRgb, effectiveTier, surfacesFromAccent, THEMES, ABO_ORDER } from './theme.js';
let fail = 0;
const eq = (a, b, n) => { const ok = a === b; if (!ok) fail++; console.log(`${ok?'ok  ':'FAIL'} ${n}: ${JSON.stringify(a)} ${ok?'==':'!='} ${JSON.stringify(b)}`); };

eq(baseClass('BP_Allosaurus_C'), 'Allosaurus', 'baseClass BP_+_C');
eq(baseClass('Carnotaurus_Adult'), 'Carnotaurus', 'baseClass _Adult (alter Helfer scheiterte hier)');
eq(baseClass('BP_Carnotaurus_Adult_C'), 'Carnotaurus', 'baseClass beides');
eq(baseClass('Tyrannosaurus'), 'Tyrannosaurus', 'baseClass blank');
eq(baseClass(null), '', 'baseClass null');

eq(fmtGrow(0.756), '76%', 'fmtGrow rundet');
eq(fmtGrow(0), '0%', 'fmtGrow 0 (nicht leer!)');
eq(fmtGrow(null), '', 'fmtGrow null');
eq(fmtGrow(-3.337e37), '', 'fmtGrow Muellwert (AdminPawn) wird verschwiegen');
eq(fmtGrow(NaN), '', 'fmtGrow NaN');
eq(fmtGrow(Infinity), '', 'fmtGrow Infinity');
eq(fmtGrow(1.2), '120%', 'fmtGrow ueber 100% bleibt erlaubt');
eq(fmtGrow(undefined), '', 'fmtGrow undefined');

eq(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;', 'escapeHtml');
eq(fmtTod(13.5), '13:30', 'fmtTod');

const u = { rpName: 'Grok', ingameName: 'SteamGuy', discordName: 'DiscoDude', steamId: '765611' };
eq(userLabel(u), 'Grok (SteamGuy, DiscoDude)', 'userLabel voll');
eq(userLabel({ ingameName: 'SteamGuy', discordName: 'DiscoDude' }), 'SteamGuy (DiscoDude)', 'userLabel ohne RP');
eq(userLabel({ rpName: 'Grok' }), 'Grok', 'userLabel nur RP');
eq(userLabel({ steamId: '765611' }), '765611', 'userLabel fallback SteamID');
eq(userLabel({ ingameName: 'Same', discordName: 'Same' }), 'Same', 'userLabel dedupe Steam==Discord');

const pool = [u, { rpName: 'Other', ingameName: 'Zzz', steamId: '999' }];
eq(matchUser('765611', pool), u, 'matchUser SteamID exakt');
eq(matchUser('grok (steamguy, discodude)', pool), u, 'matchUser Label case-insensitive');
eq(matchUser('discodude', pool), u, 'matchUser Teilstring Discord');
eq(matchUser('', pool), null, 'matchUser leer');
eq(warnItemUser({ steamId: '1', playerName: 'Ingame', discordName: 'D' }).ingameName, 'Ingame', 'warnItemUser mappt playerName');

eq(apiErr({ error: { message: 'Kaputt' } }), 'Kaputt', 'apiErr Objektform');
eq(apiErr({ error: 'Legacy' }), 'Legacy', 'apiErr Stringform');
eq(apiErr({}, 'fb'), 'fb', 'apiErr Fallback');

let fired = 0;
const btn = { dataset: {}, textContent: 'Stop' };
armConfirm(btn, 'Sicher?', () => fired++);
eq(fired, 0, 'armConfirm 1. Klick feuert nicht');
eq(btn.textContent, 'Sicher?', 'armConfirm beschriftet um');
armConfirm(btn, 'Sicher?', () => fired++);
eq(fired, 1, 'armConfirm 2. Klick feuert');

// ── Rechte ────────────────────────────────────────────────────────────────
// Die Ränge stammen aus GET /token; die erwarteten Stufen aus den Backend-
// Handlern (requireRank / requireAdminHuman / h.require).
const P = {
  fossil:    makePerms({}),                                  // normaler Spieler
  supporter: makePerms({ team: true }),                      // TEAM_RANKS, nicht ingame
  moderator: makePerms({ team: true, ingame: true }),        // INGAME_RANKS
  admin:     makePerms({ admin: true }),                     // ADMIN_RANKS
};

eq(P.fossil.staff, false, 'Spieler ist kein Staff');
eq(P.supporter.staff, true, 'Supporter ist Staff');
eq(P.supporter.ingame, false, 'Supporter ist NICHT ingame');
eq(P.moderator.ingame, true, 'Moderator ist ingame');
eq(P.admin.ingame, true, 'Admin impliziert ingame');
eq(P.admin.team, true, 'Admin impliziert team');

// Supporter: darf suchen, aber KEIN Profil oeffnen (/admin/user-info = ingame+)
eq(can(P.supporter, 'team.users'), true, 'Supporter darf Nutzerliste');
eq(can(P.supporter, 'team.userInfo'), false, 'Supporter darf KEIN Profil oeffnen');
eq(can(P.moderator, 'team.userInfo'), true, 'Moderator darf Profil oeffnen');

// Team-Audit ist strenger als Player-Audit
eq(can(P.moderator, 'team.playerAudit'), true, 'Moderator darf Player-Audit');
eq(can(P.moderator, 'team.staffAudit'), false, 'Moderator darf KEIN Team-Audit');
eq(can(P.admin, 'team.staffAudit'), true, 'Admin darf Team-Audit');

// Server-Steuerung: gestaffelt
eq(can(P.supporter, 'server.announce'), true, 'Supporter darf Ansage');
eq(can(P.supporter, 'server.wipe'), false, 'Supporter darf NICHT wipen');
eq(can(P.moderator, 'server.wipe'), true, 'Moderator darf wipen');
eq(can(P.moderator, 'server.control'), false, 'Moderator darf Server NICHT steuern');
eq(can(P.admin, 'server.control'), true, 'Admin darf Server steuern');

// Welt und Betrieb sind admin-only
eq(can(P.moderator, 'world.write'), false, 'Moderator darf Welt NICHT aendern');
eq(can(P.moderator, 'ops.read'), false, 'Moderator sieht Betrieb NICHT');
eq(can(P.admin, 'world.write'), true, 'Admin darf Welt aendern');

// Spieler: nichts von alledem, aber Lesbares
eq(can(P.fossil, 'map.showAll'), false, 'Spieler sieht NICHT alle Positionen');
eq(can(P.fossil, 'support.handle'), false, 'Spieler darf Tickets nicht bearbeiten');
eq(can(P.fossil, 'support.read'), true, 'Spieler sieht eigene Tickets');
eq(can(P.fossil, 'limits.read'), true, 'Spieler sieht Class-Limits');

// Tippfehler duerfen NIE still freigeben
eq(can(P.admin, 'gibtsNicht'), false, 'unbekannte Faehigkeit = verboten');
eq(Object.values(CAPS).every((l) => ['any','staff','ingame','admin'].includes(l)), true,
   'alle CAPS nutzen bekannte Stufen');


// ── Themes ─────────────────────────────────────────────────────────────────
// Ein Theme haengt an EINEM Hex — die uebrigen sechs Werte werden abgeleitet.
const t1 = themeFromHex('#8b5cf6');
eq(t1.accent, '#8b5cf6', 'themeFromHex behaelt den Akzent');
eq(t1.rgb, '139,92,246', 'themeFromHex liefert rohe RGB fuer rgba(var(--accent-rgb),a)');
eq(t1.accent2 !== t1.accent && t1.accentD !== t1.accent, true, 'hell und dunkel weichen ab');
eq(themeFromHex('#8b5cf6').accent2, themeFromHex('8b5cf6').accent2, 'Rautezeichen optional');
eq(themeFromHex('#f0f').accent, '#ff00ff', 'Kurzform wird ausgeschrieben');
// Muell aus localStorage darf die Oberflaeche nicht schwarz faerben.
eq(themeFromHex('kaputt').accent, '#8b5cf6', 'ungueltiger Hex faellt auf Standard zurueck');
eq(themeFromHex(null).accent, '#8b5cf6', 'null faellt auf Standard zurueck');
eq(hexToRgb('#ffffff').join(','), '255,255,255', 'hexToRgb Weiss');

// Staff bekommt alles frei, unabhaengig vom Abo — Kosmetik ist kein Werkzeug-Gate.
eq(effectiveTier({ team: true, aboTier: 'Fossil' }), 'Obsidian', 'Team => Obsidian');
eq(effectiveTier({ admin: true }), 'Obsidian', 'Admin => Obsidian');
eq(effectiveTier({ aboTier: 'Bernstein' }), 'Bernstein', 'Spieler behaelt sein Abo');
eq(effectiveTier({ aboTier: null }), 'Fossil', 'kein Abo => Fossil');
eq(effectiveTier({ aboTier: 'Erfunden' }), 'Fossil', 'unbekannter Rang => Fossil');

// Gating und Speicherung
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const store = mem();
const th = makeTheme({ storage: store, setVars: () => {} });
eq(th.unlocked('violett'), true, 'Violett ist immer frei');
eq(th.unlocked('gold'), false, 'Gold gesperrt fuer Fossil');
eq(th.unlocked('custom'), false, 'eigene Farbe gesperrt fuer Fossil');
th.apply('gold', true);
eq(th.current(), 'violett', 'gesperrtes Theme faellt auf Violett zurueck');
th.setFromToken({ admin: true });
eq(th.unlocked('gold'), true, 'nach Rang-Update ist Gold frei');
eq(th.unlocked('custom'), true, 'nach Rang-Update ist die eigene Farbe frei');
th.apply('gold', true);
eq(th.current(), 'gold', 'Gold laesst sich nun waehlen');
eq(store.getItem('bf-theme'), 'gold', 'Wahl wurde gespeichert');

// Der Rueckfall darf die gespeicherte Praeferenz NICHT ueberschreiben: sonst
// ist sie weg, sobald /token beim Start einmal langsam ist.
const store2 = mem();
store2.setItem('bf-theme', 'gold');
const th2 = makeTheme({ storage: store2, setVars: () => {} });
eq(th2.current(), 'violett', 'ohne Rang zunaechst Violett');
eq(store2.getItem('bf-theme'), 'gold', 'gespeicherte Wahl bleibt erhalten');
th2.setFromToken({ team: true });
eq(th2.current(), 'gold', 'nach Rang-Update greift die gespeicherte Wahl');

// Getrennte Schluessel pro App
const store3 = mem();
const th3 = makeTheme({ storage: store3, storageKey: 'bf-cp-theme', customKey: 'bf-cp-custom', setVars: () => {} });
th3.setFromToken({ admin: true });
th3.setCustomHex('#22c55e');
eq(store3.getItem('bf-cp-custom'), '#22c55e', 'eigene Farbe unter App-eigenem Schluessel');
eq(store3.getItem('bf-theme'), null, 'Overlay-Schluessel bleibt unberuehrt');
eq(th3.theme().accent, '#22c55e', 'aktives Theme nutzt die eigene Farbe');

// Flaechen: Violett muss exakt so aussehen wie vor der Umstellung, sonst
// aendert sich fuer alle Bestandsnutzer ungefragt die Optik.
const sv = surfacesFromAccent('#8b5cf6');
eq(sv.bg, '#0d0918', 'Violett-Seitenhintergrund unveraendert');
eq(sv.bg0, '#08050f', 'Violett-Kartenrahmen unveraendert');
// Reihenfolge der Helligkeit muss ueber ALLE Themes stimmen — sonst waere eine
// abgesetzte Flaeche dunkler als der Grund und der Aufbau kippt.
const heller = (a, b) => parseInt(a.slice(1), 16) < parseInt(b.slice(1), 16);
eq(Object.values(THEMES).every((t) => {
  const s2 = surfacesFromAccent(t.accent);
  return heller(s2.bg0, s2.bg) && heller(s2.bg, s2.bg2);
}), true, 'Flaechen werden bei jedem Theme nach oben heller');

// Alle Themes muessen vollstaendig sein — ein fehlendes Feld laesst eine
// CSS-Variable auf dem alten Wert stehen, was nur sporadisch auffaellt.
const FELDER = ['name', 'min', 'accent', 'accent2', 'accentD', 'border', 'rgb', 'panel', 'inputBg'];
eq(Object.values(THEMES).every((t) => FELDER.every((f) => t[f] !== undefined)), true, 'jedes Theme hat alle Felder');
eq(Object.values(THEMES).every((t) => ABO_ORDER[t.min] !== undefined), true, 'jedes min zeigt auf einen echten Rang');


// ── Navigation ─────────────────────────────────────────────────────────────
// Eine Gruppe, aus der jemand keinen einzigen Punkt sehen darf, muss GANZ
// verschwinden — sonst behauptet eine leere Ueberschrift etwas, das es fuer
// diesen Nutzer nicht gibt.
const sichtbar = (p) => NAV_GROUPS
  .map((g) => ({ id: g.id, items: g.items.filter((i) => !i.cap || can(p, i.cap)) }))
  .filter((g) => g.items.length);

const grpIds = (p) => sichtbar(p).map((g) => g.id).join(',');

eq(grpIds(P.admin), 'arbeit,wissen,moderation,administration', 'Admin sieht alle Gruppen');
eq(grpIds(P.fossil), 'arbeit,wissen', 'Spieler sieht nur Arbeitsmittel und Wissen');
// Supporter (Team, aber weder ingame noch admin): darf suchen, aber nichts am Server.
eq(grpIds(P.supporter), 'arbeit,wissen,moderation', 'Supporter sieht keine Administration');
eq(sichtbar(P.supporter).find((g) => g.id === 'administration'), undefined, 'Administration ist fuer Supporter komplett weg');
// Auch der Moderator nicht: Welt, Betrieb und Team-Audit sind samt und sonders admin.
eq(grpIds(P.moderator), 'arbeit,wissen,moderation', 'Moderator sieht keine Administration');
// Gegenprobe: die Gruppe ist nicht etwa generell leer.
eq(sichtbar(P.admin).find((g) => g.id === 'administration').items.length, 4, 'Admin sieht vier Administrations-Punkte');
// Die Dino-Verwaltung ist ein Werkzeug zum Aendern, kein Nachschlagewerk —
// auch wenn /dino-limits LESEND fuer jeden offen ist.
eq(sichtbar(P.fossil).find((g) => g.id === 'wissen').items.map((i) => i.view).join(','), 'lexikon',
   'Spieler sieht nur das Lexikon');
eq(sichtbar(P.moderator).some((g) => g.items.some((i) => i.view === 'dinos')), false,
   'Moderator sieht keine Dino-Verwaltung');
eq(sichtbar(P.admin).find((g) => g.id === 'administration').items.some((i) => i.view === 'dinos'), true,
   'Admin sieht die Dino-Verwaltung');

// Jeder Punkt muss auffindbar sein und eine bekannte Faehigkeit nutzen.
eq(NAV_GROUPS.flatMap((g) => g.items).every((i) => itemFor(i.view) === i), true, 'itemFor findet jeden Punkt');
eq(itemFor(NAV_SETTINGS.view) === NAV_SETTINGS, true, 'itemFor findet Settings');
eq(NAV_GROUPS.flatMap((g) => g.items).every((i) => !i.cap || CAPS[i.cap] !== undefined), true,
   'jeder Menuepunkt nutzt eine bekannte Faehigkeit');
// Doppelte view-Ids wuerden dazu fuehren, dass ein Klick die falsche Ansicht oeffnet.
const views = [...NAV_GROUPS.flatMap((g) => g.items), NAV_SETTINGS].map((i) => i.view);
eq(views.length, new Set(views).size, 'keine doppelten Menuepunkt-Ids');

// ── Class-Limits ───────────────────────────────────────────────────────────
// Der Vergleich "geaendert?" darf NICHT an der Schluesselreihenfolge haengen:
// der Server liefert die Limits anders sortiert als die Eingabefelder stehen,
// wodurch das Formular sonst direkt nach dem Laden als geaendert galt.
eq(canon({ Rex: 4, Allo: 8 }), canon({ Allo: 8, Rex: 4 }), 'Reihenfolge aendert den Vergleich nicht');
eq(canon({ Rex: 4 }) === canon({ Rex: 5 }), false, 'ein anderer Wert wird erkannt');
eq(canon({ Rex: 4 }) === canon({ Rex: 4, Allo: 8 }), false, 'eine zusaetzliche Art wird erkannt');

// 0 ist eine Falle: die Datenbank nimmt es an, der Abgleich zum Spielserver
// ueberspringt es aber — es darf gar nicht erst gesendet werden.
eq(canon(clean({ Rex: 0, Allo: 8 })), 'Allo=8', 'Nullwerte fallen raus');
eq(canon(clean({})), '', 'leere Karte bleibt leer');
eq(canon(clean({ Rex: -1 })), '', 'negative Werte fallen raus');


// ── Updates ────────────────────────────────────────────────────────────────
// Kern des Umbaus: die IPC-Zuhoerer werden EINMAL registriert. Vorher tat das
// der Software-Reiter bei jedem Oeffnen neu (und vor dem ersten Oeffnen gar
// nicht) — der stuendliche Timer meldete sich also ins Leere, und die
// Zuhoerer stapelten sich.
const gefeuert = {};
const bfStub = {
  onUpdateAvailable: (f) => { gefeuert.avail = f; zaehl('avail'); },
  onUpdateNone: (f) => { gefeuert.none = f; zaehl('none'); },
  onUpdateProgress: (f) => { gefeuert.prog = f; zaehl('prog'); },
  onUpdateReady: (f) => { gefeuert.ready = f; zaehl('ready'); },
  onUpdateError: (f) => { gefeuert.err = f; zaehl('err'); },
};
const zaehler = {};
function zaehl(k) { zaehler[k] = (zaehler[k] || 0) + 1; }

initUpdates(bfStub);
initUpdates(bfStub);   // zweiter Aufruf darf NICHTS zusaetzlich registrieren
initUpdates(bfStub);
eq(zaehler.avail, 1, 'IPC-Zuhoerer nur einmal registriert, auch bei Mehrfach-Init');

eq(getUpdate().state, 'idle', 'Startzustand ist idle');
eq(hasUpdate(), false, 'ohne Update kein roter Punkt');

gefeuert.avail('1.9.9');
eq(getUpdate().state, 'verfuegbar', 'Meldung setzt den Zustand');
eq(getUpdate().version, '1.9.9', 'Version uebernommen');
eq(hasUpdate(), true, 'verfuegbar => roter Punkt');
eq(updateText(getUpdate()), 'Version 1.9.9 verfügbar.', 'Statustext passt');

gefeuert.prog(42);
eq(hasUpdate(), false, 'waehrend des Ladens KEIN Punkt — es laeuft ja schon');
eq(updateText(getUpdate()), 'Lädt… 42%', 'Fortschritt im Text');

gefeuert.ready('1.9.9');
eq(hasUpdate(), true, 'bereit => Punkt wieder da (Neustart noetig)');

gefeuert.none();
eq(hasUpdate(), false, 'aktuell => kein Punkt');
eq(getUpdate().state, 'aktuell', 'Zustand aktuell');

gefeuert.err('Netzwerk weg');
eq(updateText(getUpdate()), 'Update fehlgeschlagen: Netzwerk weg', 'Fehlertext');
eq(hasUpdate(), false, 'Fehler ist kein Grund fuer einen Punkt');

// Abmelden muss wirken, sonst waechst die Liste mit jedem Reiterwechsel.
let n = 0;
const ab = onUpdateChange(() => { n++; });
gefeuert.none();
eq(n, 1, 'angemeldeter Horcher wird benachrichtigt');
ab();
gefeuert.none();
eq(n, 1, 'nach dem Abmelden nicht mehr');

// Ein kaputter Horcher darf die anderen nicht mitreissen.
const ab2 = onUpdateChange(() => { throw new Error('kaputt'); });
let m = 0;
const ab3 = onUpdateChange(() => { m++; });
gefeuert.none();
eq(m, 1, 'ein werfender Horcher blockiert die uebrigen nicht');
ab2(); ab3();

console.log(fail ? `\n${fail} FEHLGESCHLAGEN` : '\nalle bestanden');
process.exit(fail ? 1 : 0);
