import { baseClass, fmtGrow, escapeHtml, fmtTod } from './format.js';
import { userLabel, matchUser, warnItemUser } from './users.js';
import { apiErr, armConfirm } from './core.js';
import { makePerms, can, CAPS } from './perms.js';
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

console.log(fail ? `\n${fail} FEHLGESCHLAGEN` : '\nalle bestanden');
process.exit(fail ? 1 : 0);
