// Spieler (Moderation): Liste links, Detail rechts — wie im Lexikon.
//
// Drei Ziel-Modi, weil das Backend drei verschiedene Wege kennt:
//
//   Spieler  einzelne Konten, mit Strg mehrere. Alle Aktionen moeglich.
//   Rollen   eine Discord-Rolle. NUR Beschenken — /admin/gift faechert
//            serverseitig auf, aber es gibt keinen Endpunkt, der die
//            Mitglieder einer Rolle nennt. Nachricht und Slay brauchen je
//            eine SteamID und sind hier deshalb schlicht nicht machbar.
//   Alle     jeder, der gerade im Spiel ist. Beschenken laeuft ueber
//            targetKind "online" (ein Aufruf), Nachricht und Slay ueber die
//            Positionsliste, also ein Aufruf je Spieler.
//
// Diese Ungleichheit ist keine Designentscheidung von mir, sondern die Lage
// im Backend: /admin/gift nimmt targetKind user|role|online, /admin/toast und
// /admin/lightning nehmen genau eine SteamID.
import { el } from '../../shared/core.js';
import { userLabel, userNames, usersFrom } from '../../shared/users.js';
import { baseClass, fmtGrow } from '../../shared/format.js';
import * as U from '../ui.js';

let C = null;
let alle = [];
let geladen = false;
let rollen = [];
let rollenGeladen = false;
let suche = '';
let modus = 'spieler';          // spieler | rollen | alle
let gewaehlt = new Set();       // steamIds (Modus Spieler)
let selRolle = null;            // roleId (Modus Rollen)
let info = null;                // /admin/user-info des zuletzt einzeln Gewaehlten
let infoFuer = null;
let tab = 'info';
let sichtbar = 60;

const SEITE = 60;
const MODI = [
  { id: 'spieler', label: 'Spieler' },
  { id: 'rollen', label: 'Rollen' },
  { id: 'alle', label: 'Alle im Spiel' },
];

export function initPlayers(ctx) { C = ctx; }

function onlineMap() {
  const m = new Map();
  for (const p of C.players() || []) if (p.steamId && !p.isDead) m.set(p.steamId, p);
  return m;
}

function passt(u, q) {
  if (!q) return true;
  if ((u.steamId || '').includes(q)) return true;
  if ((u.discordId || '').includes(q)) return true;
  return userNames(u).some((n) => n.includes(q));
}

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

// Die tatsaechlichen Ziele als SteamIDs. Im Rollen-Modus leer — dort kann nur
// der Server auffaechern.
function ziele() {
  if (modus === 'alle') return [...onlineMap().keys()];
  if (modus === 'rollen') return [];
  return [...gewaehlt];
}

function nameVon(sid) {
  const u = alle.find((x) => x.steamId === sid);
  return u ? userLabel(u) : sid;
}

export async function renderPlayers(root) {
  root.innerHTML = `<div class="cp-pad">`
    + U.header('Spieler', 'Konten, Rollen und alle Anwesenden.')
    + `<div class="cp-split">`
      + `<div class="cp-split-side">`
        + U.tabs(MODI, modus)
        + `<div id="plSide"></div>`
      + `</div>`
      + `<div id="plDetail" class="cp-split-main"></div>`
    + `</div></div>`;

  root.querySelectorAll('.cp-split-side .cp-tab').forEach((b) => {
    b.onclick = () => {
      modus = b.dataset.tab;
      // Auswahl NICHT ueber Modi hinwegschleppen: sonst schickt man an das
      // Ziel des vorigen Modus, ohne es zu sehen.
      gewaehlt = new Set();
      selRolle = null;
      info = null; infoFuer = null;
      renderPlayers(root);
    };
  });

  if (!geladen) {
    el('plSide').innerHTML = U.muted('Lade…');
    try { alle = usersFrom(await C.api('GET', '/admin/users')); geladen = true; }
    catch (e) { el('plSide').innerHTML = U.muted('Liste nicht abrufbar: ' + e.message); return; }
  }
  if (!el('plSide')) return;

  if (modus === 'rollen') await seiteRollen();
  else if (modus === 'alle') seiteAlle();
  else seiteSpieler();

  zeichneDetail();
}

// ── Seite: Spieler ─────────────────────────────────────────────────────────
function seiteSpieler() {
  el('plSide').innerHTML =
    `<input id="plQ" class="cp-input" placeholder="Name, SteamID, Discord…" autocomplete="off" value="${U.esc(suche)}">`
    + `<div id="plCount" class="cp-muted cp-pl-count"></div>`
    + `<div id="plList" class="cp-pl-list"></div>`
    + U.hint('Mit Strg mehrere wählen.');

  const inp = el('plQ');
  inp.oninput = () => { suche = inp.value; sichtbar = SEITE; zeichneListe(); };
  el('plList').onscroll = (e) => {
    const n = e.target;
    if (n.scrollTop + n.clientHeight >= n.scrollHeight - 240) {
      const ges = treffer().length;
      if (sichtbar < ges) { sichtbar = Math.min(ges, sichtbar + SEITE); zeichneListe(); }
    }
  };
  sichtbar = SEITE;
  zeichneListe();
  inp.focus();
}

function zeichneListe() {
  const box = el('plList');
  if (!box) return;
  const on = onlineMap();
  const liste = treffer();
  const zeigen = liste.slice(0, Math.max(SEITE, sichtbar));

  el('plCount').textContent = `${liste.length} von ${alle.length} · ${on.size} im Spiel`
    + (gewaehlt.size ? ` · ${gewaehlt.size} gewählt` : '');

  const y = box.scrollTop;
  box.innerHTML = zeigen.length
    ? zeigen.map((u) => zeile(u, on.get(u.steamId))).join('')
      + (liste.length > zeigen.length ? `<div class="cp-pl-more">${liste.length - zeigen.length} weitere…</div>` : '')
    : U.empty('Niemanden gefunden.');
  box.scrollTop = y;

  box.querySelectorAll('[data-sid]').forEach((n) => {
    n.onclick = (ev) => {
      const sid = n.dataset.sid;
      // Strg (bzw. Cmd) erweitert, einfacher Klick ersetzt die Auswahl —
      // dasselbe Verhalten wie in jedem Dateimanager.
      if (ev.ctrlKey || ev.metaKey) {
        if (gewaehlt.has(sid)) gewaehlt.delete(sid); else gewaehlt.add(sid);
      } else {
        gewaehlt = new Set([sid]);
      }
      zeichneListe();
      zeichneDetail();
      if (gewaehlt.size === 1) ladeInfo([...gewaehlt][0]);
      else { info = null; infoFuer = null; }
    };
  });
}

function zeile(u, p) {
  const on = !!p;
  const sid = U.esc(u.steamId || '');
  const sub = on ? [baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · ') || 'im Spiel' : 'offline';
  return `<button type="button" class="cp-pl-row${gewaehlt.has(u.steamId) ? ' on' : ''}" data-sid="${sid}">`
    + `<span class="cp-pl-status${on ? ' on' : ''}" title="${on ? 'im Spiel' : 'offline'}"></span>`
    + `<span class="cp-pl-main"><span class="cp-pl-name">${U.esc(userLabel(u))}</span>`
    + `<span class="cp-pl-sub">${U.esc(sub)}</span></span></button>`;
}

// ── Seite: Rollen ──────────────────────────────────────────────────────────
async function seiteRollen() {
  const box = el('plSide');
  box.innerHTML = U.muted('Lade Rollen…');
  if (!rollenGeladen) {
    try {
      const d = await C.api('GET', '/admin/roles');
      rollen = d.roles || [];
      rollenGeladen = true;
    } catch (e) { box.innerHTML = U.muted('Rollen nicht abrufbar: ' + e.message); return; }
  }
  if (!box.isConnected) return;
  box.innerHTML = `<div class="cp-pl-list">` + rollen.map((r) =>
    `<button type="button" class="cp-pl-row${selRolle === r.id ? ' on' : ''}" data-rid="${U.esc(r.id)}">`
    + `<span class="cp-pl-main"><span class="cp-pl-name">${U.esc(r.name)}</span></span></button>`).join('')
    + `</div>`;
  box.querySelectorAll('[data-rid]').forEach((n) => {
    n.onclick = () => { selRolle = n.dataset.rid; seiteRollen(); zeichneDetail(); };
  });
}

// ── Seite: Alle ────────────────────────────────────────────────────────────
function seiteAlle() {
  const on = [...onlineMap().values()];
  el('plSide').innerHTML = U.item('Alle im Spiel', `${on.length} Spieler`, '')
    + `<div class="cp-pl-list">` + on
      .sort((a, b) => nameVon(a.steamId).localeCompare(nameVon(b.steamId), 'de'))
      .map((p) => `<div class="cp-pl-row"><span class="cp-pl-status on"></span>`
        + `<span class="cp-pl-main"><span class="cp-pl-name">${U.esc(nameVon(p.steamId))}</span>`
        + `<span class="cp-pl-sub">${U.esc([baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · '))}</span>`
        + `</span></div>`).join('')
    + `</div>`;
}

// ── Detail ─────────────────────────────────────────────────────────────────
async function ladeInfo(steamId) {
  if (!C.can('team.userInfo')) return;
  infoFuer = steamId;
  try {
    const d = await C.api('POST', '/admin/user-info', { steamId });
    if (infoFuer !== steamId) return;
    info = d;
    zeichneDetail();
  } catch (e) {
    if (infoFuer === steamId) { info = { fehler: e.message }; zeichneDetail(); }
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

function zielText() {
  if (modus === 'rollen') {
    const r = rollen.find((x) => x.id === selRolle);
    return r ? `Rolle „${r.name}"` : null;
  }
  const z = ziele();
  if (!z.length) return null;
  if (modus === 'alle') return `alle ${z.length} im Spiel`;
  return z.length === 1 ? nameVon(z[0]) : `${z.length} Spieler`;
}

function zeichneDetail() {
  const box = el('plDetail');
  if (!box) return;
  const ziel = zielText();
  if (!ziel) {
    box.innerHTML = U.empty(modus === 'rollen' ? 'Links eine Rolle wählen.' : 'Links Spieler wählen.');
    return;
  }
  const reiter = REITER();
  if (!reiter.some((t) => t.id === tab)) tab = 'info';

  box.innerHTML = `<div class="cp-pl-title"><span>${U.esc(ziel)}</span></div>`
    + U.tabs(reiter, tab) + `<div id="plTab" class="cp-stack"></div>`;
  box.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; zeichneDetail(); };
  });

  const t = el('plTab');
  if (tab === 'info') infoTab(t);
  else if (tab === 'msg') msgTab(t);
  else if (tab === 'gift') giftTab(t);
  else actTab(t);
}

// Liste der betroffenen Namen. Ueberall dort gezeigt, wo eine Aktion mehrere
// trifft — man soll nie raten muessen, wen es gleich erwischt.
function zielListe() {
  const z = ziele();
  if (!z.length) return '';
  return `<div class="cp-pl-targets">` + z.map((sid) =>
    `<span class="cp-badge">${U.esc(nameVon(sid))}</span>`).join('') + `</div>`;
}

function infoTab(box) {
  if (modus === 'rollen') {
    const r = rollen.find((x) => x.id === selRolle);
    box.innerHTML = U.item(r ? r.name : '—', 'Discord-Rolle')
      + U.hint('Wie viele Mitglieder die Rolle hat, sagt das Backend nicht — es gibt keinen '
        + 'Endpunkt dafür. Beschenken fächert der Server selbst auf.');
    return;
  }
  const z = ziele();
  if (modus === 'spieler' && z.length === 1) {
    if (!C.can('team.userInfo')) { box.innerHTML = U.hint('Profile öffnen ist Moderatoren und Admins vorbehalten.'); return; }
    if (!info) { box.innerHTML = U.muted('Lade…'); return; }
    if (info.fehler) { box.innerHTML = U.muted('Nicht abrufbar: ' + info.fehler); return; }
    const d = info;
    const dino = d.dino && d.dino.online
      ? [baseClass(d.dino.dinoClass), fmtGrow(d.dino.grow)].filter(Boolean).join(' · ')
        + (d.dino.elderReplicationStacks ? ` · Elder ×${d.dino.elderReplicationStacks}` : '')
      : 'Aktuell nicht im Spiel';
    const toks = Object.entries(d.tokens || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ×${n}`).join(', ');
    box.innerHTML = `<div class="cp-pl-facts">`
      + fakt('SteamID', d.steamId || z[0]) + fakt('Rang', d.rank || '—') + fakt('Dino', dino)
      + (d.points != null ? fakt('Punkte', String(d.points)) : '') + fakt('Token', toks || '—')
      + `</div>`;
    return;
  }
  // Mehrfachauswahl oder "Alle": die Namen selbst sind die Uebersicht.
  box.innerHTML = U.sec(`${z.length} ausgewählt`) + zielListe();
}

function fakt(k, v) {
  return `<div class="cp-pl-fact"><span class="cp-pl-fact-k">${U.esc(k)}</span>`
    + `<span class="cp-pl-fact-v">${U.esc(v)}</span></div>`;
}

// Reihum abarbeiten, wenn das Backend nur Einzelziele kennt. Bewusst
// nacheinander statt parallel: bei 50 Spielern waeren 50 gleichzeitige
// Anfragen unhoeflich gegenueber dem Server, und der Fortschritt waere nicht
// darstellbar.
async function reihum(ids, fn, btn, verb) {
  let ok = 0; let fehler = 0;
  for (let i = 0; i < ids.length; i++) {
    if (btn) btn.textContent = `${verb}… ${i + 1}/${ids.length}`;
    try { await fn(ids[i]); ok++; } catch { fehler++; }
  }
  return { ok, fehler };
}

function msgTab(box) {
  if (modus === 'rollen') {
    box.innerHTML = U.hint('Nachrichten gehen nur an einzelne Spieler — /admin/toast braucht eine '
      + 'SteamID, und welche Mitglieder eine Rolle hat, verrät das Backend nicht. '
      + 'Wähle die Spieler im Reiter „Spieler“.');
    return;
  }
  const z = ziele();
  box.innerHTML = U.textarea('plToast', '', 'Text an den Spieler… (max. 300 Zeichen)')
    + `<div class="cp-btn-row cp-btn-row-left">` + U.btn('plToastGo', `Senden (${z.length})`, { size: 'sm' }) + `</div>`
    + (z.length > 1 ? U.sec('Empfänger') + zielListe() : '')
    + U.hint('Erscheint beim Spieler, sobald er im Spiel ist. Wird einzeln zugestellt.');

  el('plToastGo').onclick = async () => {
    const t = (el('plToast').value || '').trim();
    if (!t) { C.toast('Text eingeben.', 'error'); return; }
    if (t.length > 300) { C.toast('Höchstens 300 Zeichen.', 'error'); return; }
    const b = el('plToastGo');
    b.disabled = true;
    const r = await reihum(z, (sid) => C.api('POST', '/admin/toast', { targetSteamId: sid, text: t }), b, 'Sende');
    b.disabled = false;
    b.textContent = `Senden (${z.length})`;
    el('plToast').value = '';
    C.toast(r.fehler ? `${r.ok} zugestellt, ${r.fehler} fehlgeschlagen.` : `An ${r.ok} zugestellt.`,
      r.fehler ? 'error' : 'success');
  };
}

const GESCHENKE = [
  { value: 'points', label: 'Punkte' }, { value: 'hunger', label: 'Hunger' },
  { value: 'thirst', label: 'Durst' }, { value: 'protein', label: 'Protein' },
  { value: 'carbs', label: 'Kohlenhydrate' }, { value: 'lipid', label: 'Fett' },
  { value: 'heal', label: 'Heilung' }, { value: 'grow_boost', label: 'Wachstums-Schub' },
  { value: 'grow_stop', label: 'Wachstums-Stopp' }, { value: 'insta_grow', label: 'Sofort-Wachstum' },
];

function giftTab(box) {
  const z = ziele();
  const n = modus === 'rollen' ? '' : ` (${z.length})`;
  box.innerHTML = `<div class="cp-row">`
    + U.select('plGiftT', 'Was', GESCHENKE, 'points')
    + U.field('plGiftN', 'Menge', { type: 'number', value: '1', min: 1 })
    + `</div><div class="cp-btn-row cp-btn-row-left">` + U.btn('plGiftGo', `Vergeben${n}`, { size: 'sm' }) + `</div>`
    + (z.length > 1 ? U.sec('Empfänger') + zielListe() : '')
    + (modus !== 'spieler' ? U.hint('Der Server verteilt selbst — ein Aufruf für alle.') : '');

  el('plGiftGo').onclick = async () => {
    const typ = el('plGiftT').value;
    const menge = parseInt(el('plGiftN').value, 10);
    if (!Number.isFinite(menge) || menge < 1) { C.toast('Menge muss mindestens 1 sein.', 'error'); return; }
    const b = el('plGiftGo');
    const l = (GESCHENKE.find((g) => g.value === typ) || {}).label || typ;
    b.disabled = true;
    try {
      if (modus === 'rollen') {
        const d = await C.api('POST', '/admin/gift', { targetKind: 'role', targetId: selRolle, type: typ, amount: menge });
        C.toast(`${menge}× ${l} an ${d && d.affected != null ? d.affected : '?'} Spieler vergeben.`, 'success');
      } else if (modus === 'alle') {
        const d = await C.api('POST', '/admin/gift', { targetKind: 'online', type: typ, amount: menge });
        C.toast(`${menge}× ${l} an ${d && d.affected != null ? d.affected : '?'} Spieler vergeben.`, 'success');
      } else {
        const r = await reihum(z, (sid) => C.api('POST', '/admin/gift',
          { targetKind: 'user', targetId: sid, type: typ, amount: menge }), b, 'Vergebe');
        C.toast(r.fehler ? `${r.ok} vergeben, ${r.fehler} fehlgeschlagen.` : `${menge}× ${l} an ${r.ok} vergeben.`,
          r.fehler ? 'error' : 'success');
      }
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { b.disabled = false; b.textContent = `Vergeben${n}`; }
  };
}

function actTab(box) {
  if (modus === 'rollen') {
    box.innerHTML = U.hint('Blitzschlag trifft immer einen einzelnen Dino — /admin/lightning braucht '
      + 'eine SteamID. Für eine Rolle gibt es keinen Weg, die Mitglieder zu ermitteln.');
    return;
  }
  const z = ziele();
  const on = onlineMap();
  const imSpiel = z.filter((s) => on.has(s));

  box.innerHTML = (C.can('team.follow') && z.length === 1
      ? U.item('Spieler verfolgen', 'Setzt die Overwatch-Ansicht auf diesen Spieler.',
          U.btn('plFollow', 'Folgen', { size: 'sm' }))
      : '')
    + U.sec('Blitzschlag (Slay)')
    // Namen IMMER auflisten, nicht nur die Anzahl: eine Zahl sagt nicht, wen
    // es trifft, und der Dino ist danach tot.
    + `<div class="cp-card cp-card-danger">`
      + `<div class="cp-item-sub">Tötet den aktiven Dino. Nicht umkehrbar. Betroffen:</div>`
      + zielListe()
      + (imSpiel.length !== z.length
        ? U.hint(`${z.length - imSpiel.length} davon sind nicht im Spiel — bei denen findet der Blitz keinen Dino.`)
        : '')
    + `</div>`
    + `<div class="cp-btn-row cp-btn-row-left">`
      + U.btn('plSlay', `Blitzschlag (${z.length})`, { size: 'sm', variant: 'danger' }) + `</div>`;

  const f = el('plFollow');
  if (f) f.onclick = async () => {
    f.disabled = true;
    try {
      await C.api('POST', '/admin/follow', { targetSteamId: z[0] });
      C.toast(`Folge ${nameVon(z[0])}.`, 'success');
    } catch (e) { C.toast('Fehlgeschlagen: ' + e.message, 'error'); }
    finally { f.disabled = false; }
  };

  const s = el('plSlay');
  const zurueck = () => { s.textContent = `Blitzschlag (${z.length})`; };
  s.onclick = async () => {
    if (!s.dataset.armed) {
      s.dataset.armed = '1';
      s.textContent = `Sicher? ${z.length} Dino${z.length === 1 ? '' : 's'} töten`;
      setTimeout(() => { if (s.dataset.armed) { delete s.dataset.armed; zurueck(); } }, 3000);
      return;
    }
    delete s.dataset.armed;
    s.disabled = true;
    const r = await reihum(z, (sid) => C.api('POST', '/admin/lightning', { steamId: sid }), s, 'Schlage');
    s.disabled = false;
    zurueck();
    C.toast(r.fehler ? `${r.ok} geslayed, ${r.fehler} fehlgeschlagen.` : `${r.ok} geslayed.`,
      r.fehler ? 'error' : 'success');
  };
}
