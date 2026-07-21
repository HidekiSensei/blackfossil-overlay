import { baseClass, fmtGrow, escapeHtml, fmtTod } from './format.js';
import { userLabel, matchUser, warnItemUser } from './users.js';
import { apiErr, armConfirm } from './core.js';
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

console.log(fail ? `\n${fail} FEHLGESCHLAGEN` : '\nalle bestanden');
process.exit(fail ? 1 : 0);
