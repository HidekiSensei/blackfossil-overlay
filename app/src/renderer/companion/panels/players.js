// Spieler (Moderation): Liste links, Detail rechts — wie im Lexikon.
//
// Zwei Quellen, bewusst zusammengefuehrt:
//   /admin/users  — ALLE bekannten Konten (~1250), mit RP-, Steam- und
//                   Discord-Namen. Weiss nichts darueber, wer gerade spielt.
//   /positions    — nur die gerade Anwesenden, dafuer mit Dino und Wachstum.
//
// Anwesende stehen oben. Bei einer Moderationsaufgabe ist "ist der ueberhaupt
// erreichbar" die erste Frage, und ohne die Zusammenfuehrung muesste man sie
// raten.
//
// Die Aktionen liegen in Reitern statt untereinander: es sind vier sehr
// verschiedene Eingriffe, und die gefaehrlichste davon (Slay) soll nicht
// beilaeufig neben einem Textfeld stehen.
import { el } from '../../shared/core.js';
import { userLabel, userNames, usersFrom } from '../../shared/users.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let alle = [];
let geladen = false;
let suche = '';
let sel = null;         // steamId des gewaehlten Spielers
let info = null;        // Antwort von /admin/user-info
let tab = 'info';
let sichtbar = 0;       // wie viele Zeilen aktuell gezeichnet sind (Nachladen)

const SEITE = 60;       // Nachladeschritt

export function initPlayers(ctx) { C = ctx; }

function onlineMap() {
  const m = new Map();
  for (const p of C.players() || []) if (p.steamId) m.set(p.steamId, p);
  return m;
}

function passt(u, q) {
  if (!q) return true;
  if ((u.steamId || '').includes(q)) return true;
  if ((u.discordId || '').includes(q)) return true;
  return userNames(u).some((n) => n.includes(q));
}

// Anwesende zuerst, darin alphabetisch.
function treffer() {
  const on = onlineMap();
  const q = suche.trim().toLowerCase();
  return alle.filter((u) => passt(u, q)).sort((a, b) => {
    const oa = on.has(a.steamId) ? 0 : 1;
    const ob = on.has(b.steamId) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return userLabel(a).localeCompare(userLabel(b), 'de');
  });
}

export async function renderPlayers(root) {
  root.innerHTML = `<div class="cp-pad">`
    + U.header('Spieler', 'Alle bekannten Konten — Anwesende zuerst.')
    + `<div class="cp-split">`
      + `<div class="cp-split-side">`
        + `<input id="plQ" class="cp-input" placeholder="Name, SteamID, Discord…" autocomplete="off" value="${U.esc(suche)}">`
        + `<div id="plCount" class="cp-muted cp-pl-count"></div>`
        + `<div id="plList" class="cp-pl-list">${U.muted('Lade…')}</div>`
      + `</div>`
      + `<div id="plDetail" class="cp-split-main"></div>`
    + `</div></div>`;

  if (!geladen) {
    try {
      alle = usersFrom(await C.api('GET', '/admin/users'));
      geladen = true;
    } catch (e) {
      el('plList').innerHTML = U.muted('Liste nicht abrufbar: ' + e.message);
      return;
    }
  }
  if (!el('plQ')) return;   // inzwischen weggeblättert

  const inp = el('plQ');
  inp.oninput = () => { suche = inp.value; sichtbar = SEITE; zeichneListe(); };

  // Nachladen beim Scrollen statt alles auf einmal: 1250 Zeilen kosten
  // spuerbar und niemand liest sie. Schwelle grosszuegig, damit man beim
  // schnellen Scrollen nicht ins Leere laeuft.
  el('plList').onscroll = (e) => {
    const n = e.target;
    if (n.scrollTop + n.clientHeight >= n.scrollHeight - 240) mehr();
  };

  sichtbar = SEITE;
  zeichneListe();
  zeichneDetail();
  inp.focus();
}

function mehr() {
  const ges = treffer().length;
  if (sichtbar >= ges) return;
  sichtbar = Math.min(ges, sichtbar + SEITE);
  zeichneListe();
}

function zeichneListe() {
  const box = el('plList');
  if (!box) return;
  const on = onlineMap();
  const liste = treffer();
  const zeigen = liste.slice(0, Math.max(SEITE, sichtbar));

  el('plCount').textContent = `${liste.length} von ${alle.length} · ${on.size} im Spiel`;

  // Scrollposition halten: die Liste wird beim Nachladen komplett neu
  // geschrieben, ohne das springt sie bei jedem Schritt nach oben.
  const y = box.scrollTop;
  box.innerHTML = zeigen.length
    ? zeigen.map((u) => zeile(u, on.get(u.steamId))).join('')
      + (liste.length > zeigen.length
        ? `<div class="cp-pl-more">${liste.length - zeigen.length} weitere…</div>` : '')
    : U.empty('Niemanden gefunden.');
  box.scrollTop = y;

  box.querySelectorAll('[data-sid]').forEach((n) => {
    n.onclick = () => {
      sel = n.dataset.sid;
      info = null;
      zeichneListe();
      zeichneDetail();
      ladeInfo(sel);
    };
  });
}

function zeile(u, p) {
  const on = !!p;
  const sid = U.esc(u.steamId || '');
  const sub = on
    ? [baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · ') || 'im Spiel'
    : 'offline';
  return `<button type="button" class="cp-pl-row${sel === u.steamId ? ' on' : ''}" data-sid="${sid}">`
    + `<span class="cp-pl-status${on ? ' on' : ''}" title="${on ? 'im Spiel' : 'offline'}"></span>`
    + `<span class="cp-pl-main"><span class="cp-pl-name">${U.esc(userLabel(u))}</span>`
    + `<span class="cp-pl-sub">${U.esc(sub)}</span></span></button>`;
}

// ── Detail ─────────────────────────────────────────────────────────────────
async function ladeInfo(steamId) {
  if (!C.can('team.userInfo')) return;
  try {
    const d = await C.api('POST', '/admin/user-info', { steamId });
    if (sel !== steamId) return;   // inzwischen jemand anderes gewaehlt
    info = d;
    zeichneDetail();
  } catch (e) {
    if (sel === steamId) { info = { fehler: e.message }; zeichneDetail(); }
  }
}

function REITER() {
  return [
    { id: 'info', label: 'Übersicht', cap: null },
    { id: 'msg', label: 'Nachricht', cap: 'team.toast' },
    { id: 'gift', label: 'Beschenken', cap: 'team.gift' },
    { id: 'act', label: 'Eingriff', cap: 'team.lightning' },
  ].filter((t) => !t.cap || C.can(t.cap));
}

function zeichneDetail() {
  const box = el('plDetail');
  if (!box) return;
  if (!sel) { box.innerHTML = U.empty('Links einen Spieler wählen.'); return; }

  const u = alle.find((x) => x.steamId === sel);
  const name = u ? userLabel(u) : sel;
  const on = onlineMap().has(sel);
  const reiter = REITER();
  if (!reiter.some((t) => t.id === tab)) tab = 'info';

  box.innerHTML = `<div class="cp-pl-title">`
    + `<span class="cp-pl-status${on ? ' on' : ''}"></span>`
    + `<span>${U.esc(name)}</span>`
    // Offline neutral, NICHT rot: cp-badge-off ist ein Fehlerton, und nicht
    // im Spiel zu sein ist kein Fehler.
    + `<span class="cp-badge${on ? ' cp-badge-ok' : ''}">${on ? 'im Spiel' : 'offline'}</span>`
    + `</div>`
    + U.tabs(reiter, tab)
    + `<div id="plTab" class="cp-stack"></div>`;

  box.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; zeichneDetail(); };
  });

  const t = el('plTab');
  if (tab === 'info') infoTab(t);
  else if (tab === 'msg') msgTab(t, name);
  else if (tab === 'gift') giftTab(t, name);
  else actTab(t, name, on);
}

function infoTab(box) {
  if (!C.can('team.userInfo')) { box.innerHTML = U.hint('Profile öffnen ist Moderatoren und Admins vorbehalten.'); return; }
  if (!info) { box.innerHTML = U.muted('Lade…'); return; }
  if (info.fehler) { box.innerHTML = U.muted('Nicht abrufbar: ' + info.fehler); return; }

  const d = info;
  const dino = d.dino && d.dino.online
    ? [baseClass(d.dino.dinoClass), fmtGrow(d.dino.grow)].filter(Boolean).join(' · ')
      + (d.dino.elderReplicationStacks ? ` · Elder ×${d.dino.elderReplicationStacks}` : '')
    : 'Aktuell nicht im Spiel';
  const toks = Object.entries(d.tokens || {}).filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ×${n}`).join(', ');

  box.innerHTML = `<div class="cp-pl-facts">`
    + fakt('SteamID', d.steamId || sel)
    + fakt('Rang', d.rank || '—')
    + fakt('Dino', dino)
    + (d.points != null ? fakt('Punkte', String(d.points)) : '')
    + fakt('Token', toks || '—')
    + `</div>`;
}

function fakt(k, v) {
  return `<div class="cp-pl-fact"><span class="cp-pl-fact-k">${U.esc(k)}</span>`
    + `<span class="cp-pl-fact-v">${U.esc(v)}</span></div>`;
}

function msgTab(box, name) {
  box.innerHTML = U.textarea('plToast', '', 'Text an den Spieler…')
    + `<div class="cp-btn-row cp-btn-row-left">` + U.btn('plToastGo', 'Senden', { size: 'sm' }) + `</div>`
    + U.hint('Erscheint beim Spieler, sobald er im Spiel ist.');
  el('plToastGo').onclick = async () => {
    const t = (el('plToast').value || '').trim();
    if (!t) { C.toast('Text eingeben.', 'error'); return; }
    const b = el('plToastGo');
    b.disabled = true;
    try {
      await C.api('POST', '/admin/toast', { targetSteamId: sel, text: t });
      el('plToast').value = '';
      C.toast(`Nachricht an ${name} gesendet.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { b.disabled = false; }
  };
}

// Die Geschenkarten sind im Backend hartkodiert und werden nirgends als Liste
// ausgeliefert — der Client muss sie leider doppeln.
const GESCHENKE = [
  { value: 'points', label: 'Punkte' },
  { value: 'hunger', label: 'Hunger' },
  { value: 'thirst', label: 'Durst' },
  { value: 'protein', label: 'Protein' },
  { value: 'carbs', label: 'Kohlenhydrate' },
  { value: 'lipid', label: 'Fett' },
  { value: 'heal', label: 'Heilung' },
  { value: 'grow_boost', label: 'Wachstums-Schub' },
  { value: 'grow_stop', label: 'Wachstums-Stopp' },
  { value: 'insta_grow', label: 'Sofort-Wachstum' },
];

function giftTab(box, name) {
  box.innerHTML = `<div class="cp-row">`
    + U.select('plGiftT', 'Was', GESCHENKE, 'points')
    + U.field('plGiftN', 'Menge', { type: 'number', value: '1', min: 1 })
    + `</div><div class="cp-btn-row cp-btn-row-left">`
    + U.btn('plGiftGo', 'Vergeben', { size: 'sm' }) + `</div>`;
  el('plGiftGo').onclick = async () => {
    const typ = el('plGiftT').value;
    const n = parseInt(el('plGiftN').value, 10);
    if (!Number.isFinite(n) || n < 1) { C.toast('Menge muss mindestens 1 sein.', 'error'); return; }
    const b = el('plGiftGo');
    b.disabled = true;
    try {
      const d = await C.api('POST', '/admin/gift', { targetKind: 'user', targetId: sel, type: typ, amount: n });
      const l = (GESCHENKE.find((g) => g.value === typ) || {}).label || typ;
      C.toast(`${n}× ${l} an ${name} vergeben${d && d.affected != null ? ` (${d.affected})` : ''}.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { b.disabled = false; }
  };
}

function actTab(box, name, on) {
  box.innerHTML = (C.can('team.follow')
      ? U.item('Spieler verfolgen', 'Setzt die Overwatch-Ansicht auf diesen Spieler.',
          U.btn('plFollow', 'Folgen', { size: 'sm' }))
      : '')
    + U.item('Blitzschlag (Slay)',
        'Tötet den aktiven Dino. Nicht umkehrbar — zum Bestätigen zweimal klicken.',
        U.btn('plSlay', 'Blitzschlag', { size: 'sm', variant: 'danger' }))
    + (on ? '' : U.hint('Der Spieler ist nicht im Spiel — ein Blitzschlag findet keinen Dino.'));

  const f = el('plFollow');
  if (f) f.onclick = async () => {
    f.disabled = true;
    try {
      await C.api('POST', '/admin/follow', { targetSteamId: sel });
      C.toast(`Folge ${name}.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { f.disabled = false; }
  };

  const s = el('plSlay');
  s.onclick = () => {
    if (s.dataset.armed) {
      delete s.dataset.armed;
      s.disabled = true;
      C.api('POST', '/admin/lightning', { steamId: sel })
        .then((d) => C.toast(d && d.slayed ? `${name} wurde geslayed.` : 'Blitz gesendet — kein aktiver Dino?', 'success'))
        .catch((e) => C.toast('Fehlgeschlagen: ' + e.message, 'error'))
        .finally(() => { s.disabled = false; s.textContent = 'Blitzschlag'; });
      return;
    }
    s.dataset.armed = '1';
    s.textContent = 'Sicher? Dino töten';
    setTimeout(() => {
      if (!s.dataset.armed) return;
      delete s.dataset.armed;
      s.textContent = 'Blitzschlag';
    }, 2500);
  };
}
