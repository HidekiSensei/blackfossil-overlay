// Spieler (Moderation): vollstaendige Liste, Suche, Detailansicht.
//
// Zwei Quellen, bewusst zusammengefuehrt:
//   /admin/users  — ALLE bekannten Konten (~1100), mit RP-, Steam- und
//                   Discord-Namen. Weiss nichts darueber, wer gerade spielt.
//   /positions    — nur die gerade Anwesenden, dafuer mit Dino und Wachstum.
//
// Die Liste zeigt beide zusammen: wer online ist, steht oben und traegt seinen
// Dino. Ohne diese Zusammenfuehrung muesste man raten, ob ein Spieler gerade
// erreichbar ist — und genau das ist bei einer Moderationsaufgabe die erste
// Frage.
import { el } from '../../shared/core.js';
import { userLabel, userNames, usersFrom } from '../../shared/users.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let alle = [];          // /admin/users, einmal geladen
let geladen = false;
let suche = '';
let offen = null;       // steamId des aufgeklappten Spielers

export function initPlayers(ctx) { C = ctx; }

// Online-Zustand aus den laufenden Positionsabfragen. Map statt Suche je Zeile:
// bei ~1100 Konten waere das sonst quadratisch.
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

export async function renderPlayers(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow cp-pad-full">`
    + U.header('Spieler', 'Alle bekannten Konten — Anwesende zuerst.')
    + `<div id="plBar"></div><div id="plBody">${U.muted('Lade Spielerliste…')}</div></div>`;

  if (!geladen) {
    try {
      alle = usersFrom(await C.api('GET', '/admin/users'));
      geladen = true;
    } catch (e) {
      el('plBody').innerHTML = U.muted('Spielerliste nicht abrufbar: ' + e.message);
      return;
    }
  }

  el('plBar').innerHTML = `<div class="cp-row cp-row-tight">`
    + `<input id="plQ" class="cp-input" placeholder="Name, RP-Name, SteamID oder Discord…" autocomplete="off" value="${U.esc(suche)}">`
    + `<span id="plCount" class="cp-muted"></span></div>`;

  const inp = el('plQ');
  inp.oninput = () => { suche = inp.value; zeichne(); };
  zeichne();
  // Fokus ins Suchfeld: wer hierher navigiert, sucht in aller Regel jemanden.
  inp.focus();
}

function zeichne() {
  const box = el('plBody');
  if (!box) return;
  const on = onlineMap();
  const q = suche.trim().toLowerCase();

  // Anwesende zuerst, darin alphabetisch — sonst muesste man in einer
  // 1100-Zeilen-Liste nach den zwanzig Relevanten suchen.
  const treffer = alle.filter((u) => passt(u, q)).sort((a, b) => {
    const oa = on.has(a.steamId) ? 0 : 1;
    const ob = on.has(b.steamId) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return userLabel(a).localeCompare(userLabel(b), 'de');
  });

  el('plCount').textContent = `${treffer.length} von ${alle.length} · ${on.size} im Spiel`;

  // Deckel gegen Ruckeln: 1100 Zeilen auf einmal zu zeichnen kostet spuerbar,
  // und niemand liest sie. Wer mehr will, sucht.
  const MAX = 200;
  const zeigen = treffer.slice(0, MAX);

  box.innerHTML = zeigen.length
    ? `<div class="cp-pl-list">` + zeigen.map((u) => zeile(u, on.get(u.steamId))).join('') + `</div>`
      + (treffer.length > MAX ? U.hint(`${treffer.length - MAX} weitere — Suche eingrenzen.`) : '')
    : U.empty('Niemanden gefunden.');

  box.querySelectorAll('[data-sid]').forEach((n) => {
    n.onclick = () => {
      const sid = n.dataset.sid;
      offen = offen === sid ? null : sid;   // nochmal klicken schliesst wieder
      zeichne();
      if (offen) ladeDetail(offen);
    };
  });
}

function zeile(u, p) {
  const on = !!p;
  const sid = U.esc(u.steamId || '');
  const sub = on
    ? [baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · ') || 'im Spiel'
    : 'offline';
  const auf = offen === u.steamId;
  return `<div class="cp-pl-entry${auf ? ' auf' : ''}">`
    + `<button type="button" class="cp-pl-head" data-sid="${sid}">`
    + `<span class="cp-pl-status${on ? ' on' : ''}" title="${on ? 'im Spiel' : 'offline'}"></span>`
    + `<span class="cp-pl-main"><span class="cp-pl-name">${U.esc(userLabel(u))}</span>`
    + `<span class="cp-pl-sub">${U.esc(sub)}</span></span>`
    + `<span class="cp-pl-caret">${auf ? '▾' : '▸'}</span></button>`
    + (auf ? `<div class="cp-pl-detail" id="plDet-${sid}">${U.muted('Lade…')}</div>` : '')
    + `</div>`;
}

// ── Detail ─────────────────────────────────────────────────────────────────
async function ladeDetail(steamId) {
  const box = el('plDet-' + steamId);
  if (!box) return;
  if (!C.can('team.userInfo')) {
    box.innerHTML = U.hint('Profile öffnen ist Moderatoren und Admins vorbehalten.');
    return;
  }
  try {
    const d = await C.api('POST', '/admin/user-info', { steamId });
    if (!box.isConnected) return;   // inzwischen zugeklappt
    box.innerHTML = detailHtml(steamId, d);
    wireAktionen(steamId, d.name || steamId);
  } catch (e) {
    if (box.isConnected) box.innerHTML = U.muted('Nicht abrufbar: ' + e.message);
  }
}

function detailHtml(steamId, d) {
  const on = d.dino && d.dino.online;
  const dino = on
    ? [baseClass(d.dino.dinoClass), fmtGrow(d.dino.grow)].filter(Boolean).join(' · ')
      + (d.dino.elderReplicationStacks ? ` · Elder ×${d.dino.elderReplicationStacks}` : '')
    : 'Aktuell nicht im Spiel';
  const toks = Object.entries(d.tokens || {}).filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ×${n}`).join(', ');

  return `<div class="cp-pl-facts">`
    + fakt('SteamID', d.steamId || steamId)
    + fakt('Rang', d.rank || '—')
    + fakt('Dino', dino)
    + (d.points != null ? fakt('Punkte', String(d.points)) : '')
    + fakt('Token', toks || '—')
    + `</div>`
    + aktionenHtml(steamId);
}

function fakt(k, v) {
  return `<div class="cp-pl-fact"><span class="cp-pl-fact-k">${U.esc(k)}</span>`
    + `<span class="cp-pl-fact-v">${U.esc(v)}</span></div>`;
}

// ── Aktionen ───────────────────────────────────────────────────────────────
//
// Nur, was es im Backend WIRKLICH gibt. Das Overlay bietet an einem fremden
// Spieler ausschliesslich diese vier Griffe an; Wachstum, Geschlecht,
// Einparken und Vitals sind dort Selbstbedienung des jeweiligen Spielers und
// haben keinen Staff-Endpunkt. Wer sie hier anboete, baute Knoepfe, die
// nirgends ankommen.
//
// Geschenkarten sind im Backend hartkodiert (admin.go) und werden nirgends
// als Liste ausgeliefert — sie muss der Client leider doppeln.
const GESCHENKE = [
  { v: 'points', l: 'Punkte' },
  { v: 'hunger', l: 'Hunger' },
  { v: 'thirst', l: 'Durst' },
  { v: 'protein', l: 'Protein' },
  { v: 'carbs', l: 'Kohlenhydrate' },
  { v: 'lipid', l: 'Fett' },
  { v: 'heal', l: 'Heilung' },
  { v: 'grow_boost', l: 'Wachstums-Schub' },
  { v: 'grow_stop', l: 'Wachstums-Stopp' },
  { v: 'insta_grow', l: 'Sofort-Wachstum' },
];

function aktionenHtml(steamId) {
  const teile = [];

  if (C.can('team.toast')) {
    teile.push(U.sec('Nachricht')
      + U.textarea('plToast-' + steamId, '', 'Text an den Spieler (erscheint, sobald er im Spiel ist)…')
      + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('plToastGo-' + steamId, 'Senden', { size: 'sm' }) + `</div>`);
  }

  if (C.can('team.gift')) {
    teile.push(U.sec('Beschenken')
      + `<div class="cp-row">`
      + U.select('plGiftT-' + steamId, 'Was', GESCHENKE.map((g) => ({ value: g.v, label: g.l })), 'points')
      + U.field('plGiftN-' + steamId, 'Menge', { type: 'number', value: '1', min: 1 })
      + `</div><div class="cp-btn-row cp-btn-row-left">`
      + U.btn('plGiftGo-' + steamId, 'Vergeben', { size: 'sm' }) + `</div>`);
  }

  const harte = [];
  if (C.can('team.follow')) harte.push(U.btn('plFollow-' + steamId, 'Folgen', { size: 'sm' }));
  // Lightning toetet den aktiven Dino. Deshalb als Gefahr markiert und mit
  // Zwei-Klick-Bestaetigung — es gibt kein Zurueck.
  if (C.can('team.lightning')) harte.push(U.btn('plSlay-' + steamId, 'Blitzschlag (Slay)', { size: 'sm', variant: 'danger' }));
  if (harte.length) teile.push(U.sec('Eingriff') + `<div class="cp-btn-row cp-btn-row-left">${harte.join('')}</div>`);

  return teile.length ? teile.join('') : U.hint('Für Eingriffe fehlen dir die Rechte.');
}

function wireAktionen(steamId, name) {
  const b = (id) => el(id + '-' + steamId);

  const toastGo = b('plToastGo');
  if (toastGo) toastGo.onclick = async () => {
    const t = (b('plToast').value || '').trim();
    if (!t) { C.toast('Text eingeben.', 'error'); return; }
    toastGo.disabled = true;
    try {
      await C.api('POST', '/admin/toast', { targetSteamId: steamId, text: t });
      b('plToast').value = '';
      C.toast(`Nachricht an ${name} gesendet.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { toastGo.disabled = false; }
  };

  const giftGo = b('plGiftGo');
  if (giftGo) giftGo.onclick = async () => {
    const typ = b('plGiftT').value;
    const n = parseInt(b('plGiftN').value, 10);
    if (!Number.isFinite(n) || n < 1) { C.toast('Menge muss mindestens 1 sein.', 'error'); return; }
    giftGo.disabled = true;
    try {
      const d = await C.api('POST', '/admin/gift', { targetKind: 'user', targetId: steamId, type: typ, amount: n });
      const label = (GESCHENKE.find((g) => g.v === typ) || {}).l || typ;
      C.toast(`${n}× ${label} an ${name} vergeben${d && d.affected != null ? ` (${d.affected})` : ''}.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { giftGo.disabled = false; }
  };

  const follow = b('plFollow');
  if (follow) follow.onclick = async () => {
    follow.disabled = true;
    try {
      await C.api('POST', '/admin/follow', { targetSteamId: steamId });
      C.toast(`Folge ${name}.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { follow.disabled = false; }
  };

  const slay = b('plSlay');
  if (slay) slay.onclick = () => {
    // Zwei Klicks, wie beim Kadaver-Leeren: der Dino ist danach tot.
    if (slay.dataset.armed) {
      delete slay.dataset.armed;
      slay.disabled = true;
      C.api('POST', '/admin/lightning', { steamId })
        .then((d) => C.toast(d && d.slayed ? `${name} wurde geslayed.` : 'Blitz gesendet — kein aktiver Dino?', 'success'))
        .catch((e) => C.toast('Fehlgeschlagen: ' + e.message, 'error'))
        .finally(() => { slay.disabled = false; slay.textContent = 'Blitzschlag (Slay)'; });
      return;
    }
    slay.dataset.armed = '1';
    slay.textContent = 'Sicher? Dino töten';
    setTimeout(() => {
      if (!slay.dataset.armed) return;
      delete slay.dataset.armed;
      slay.textContent = 'Blitzschlag (Slay)';
    }, 2500);
  };
}
