// Spielerliste ueber der Karte (Team-only).
// Zwei Reiter: einzelne Spieler und Gruppen. Ausgewaehlte werden auf der Karte
// hervorgehoben.
import { escapeHtml, baseClass, fmtGrow } from '../shared/format.js';
import { floatingPanel, close, isOpen } from './floating.js';

const ID = 'playerlist';

export function isPlayerListOpen() { return isOpen(ID); }
export function closePlayerList() { close(ID); }

let tab = 'spieler';
const expanded = new Set();   // aufgeklappte Gruppen-IDs

// Sortiert nach Anzeigename, deutsche Sortierung.
const byName = (a, b) => (a.label1 || a.name || '').localeCompare(b.label1 || b.name || '', 'de');

function matches(p, term) {
  if (!term) return true;
  return (p.label1 || '').toLowerCase().includes(term)
    || (p.name || '').toLowerCase().includes(term)
    || (p.realName || '').toLowerCase().includes(term)
    || String(p.steamId || '').includes(term);
}

// Gruppen aus den Positionen ableiten — es gibt keine eigene Gruppen-Liste.
function buildGroups(players) {
  const map = new Map();
  for (const p of players) {
    if (!p.groupId) continue;
    if (!map.has(p.groupId)) map.set(p.groupId, []);
    map.get(p.groupId).push(p);
  }
  // Einzelne "Gruppen" mit nur einem Mitglied sind keine — die stehen im
  // Spieler-Reiter.
  return [...map.entries()]
    .filter(([, m]) => m.length > 1)
    .map(([id, m]) => ({ id, members: m.sort(byName) }))
    .sort((a, b) => b.members.length - a.members.length);
}

// ctx: { players(), highlight (Set), onChange(), onFocus(steamId) }
export function openPlayerList(ctx) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="cp-tabs cp-float-tabs">
      <button class="cp-tab" data-tab="spieler">Spieler</button>
      <button class="cp-tab" data-tab="gruppen">Gruppen</button>
    </div>
    <input id="plQ" class="cp-input cp-float-search" placeholder="RP-, Steam- oder Discord-Name…" autocomplete="off">
    <div class="cp-float-actions">
      <button id="plNone" class="cp-btn cp-btn-sm">Auswahl leeren</button>
      <span id="plCount" class="cp-muted"></span>
    </div>
    <div id="plList" class="cp-float-list"></div>`;

  const panel = floatingPanel(ID, { title: 'Spieler', body, width: 320, x: 24, y: 24 });
  if (!panel) return;

  const term = () => (body.querySelector('#plQ').value || '').trim().toLowerCase();

  function playerRow(p) {
    const on = ctx.highlight.has(p.steamId);
    const rank = p.admin ? ' cp-pl-admin' : (p.team ? ' cp-pl-team' : '');
    return `<button type="button" class="cp-pl-row${on ? ' on' : ''}" data-id="${escapeHtml(p.steamId)}">`
      + `<span class="cp-pl-dot${rank}"></span><span class="cp-pl-main">`
      + `<span class="cp-pl-name">${escapeHtml(p.label1 || p.name || p.steamId)}</span>`
      + `<span class="cp-pl-sub">${escapeHtml([baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · '))}</span>`
      + `</span></button>`;
  }

  function render() {
    const t = term();
    const all = (ctx.players() || []).filter((p) => !p.isDead);
    body.querySelectorAll('.cp-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

    if (tab === 'spieler') {
      const list = all.filter((p) => matches(p, t)).sort(byName);
      body.querySelector('#plCount').textContent = `${ctx.highlight.size} ausgewählt · ${list.length}/${all.length}`;
      body.querySelector('#plList').innerHTML = list.length
        ? list.map(playerRow).join('')
        : `<div class="cp-empty">Niemand gefunden.</div>`;
    } else {
      const groups = buildGroups(all);
      // Suche klappt die Gruppe des Treffers automatisch auf — sonst muesste man
      // erst raten, in welcher er steckt.
      if (t) for (const g of groups) if (g.members.some((p) => matches(p, t))) expanded.add(g.id);
      const shown = t ? groups.filter((g) => g.members.some((p) => matches(p, t))) : groups;
      body.querySelector('#plCount').textContent = `${ctx.highlight.size} ausgewählt · ${shown.length} Gruppen`;
      body.querySelector('#plList').innerHTML = shown.length
        ? shown.map((g) => {
            const open = expanded.has(g.id);
            // Gruppe gilt als gewaehlt, wenn ALLE Mitglieder markiert sind.
            const sel = g.members.every((p) => ctx.highlight.has(p.steamId));
            return `<div class="cp-grp">`
              + `<div class="cp-grp-head${sel ? ' on' : ''}">`
              + `<button type="button" class="cp-grp-toggle" data-grp-toggle="${escapeHtml(g.id)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button>`
              + `<button type="button" class="cp-grp-pick" data-grp="${escapeHtml(g.id)}">`
              + `<span class="cp-pl-name">${escapeHtml(g.members[0].label1 || g.members[0].name || 'Gruppe')} +${g.members.length - 1}</span>`
              + `<span class="cp-pl-sub">${g.members.length} Mitglieder</span></button></div>`
              + (open ? `<div class="cp-grp-body">${g.members.map(playerRow).join('')}</div>` : '')
              + `</div>`;
          }).join('')
        : `<div class="cp-empty">Keine Gruppen.</div>`;
    }

    body.querySelectorAll('[data-id]').forEach((n) => {
      n.onclick = (e) => {
        const id = n.dataset.id;
        if (ctx.highlight.has(id)) ctx.highlight.delete(id); else ctx.highlight.add(id);
        if (e.altKey && ctx.onFocus) ctx.onFocus(id);
        ctx.onChange();
        render();
      };
    });
    body.querySelectorAll('[data-grp-toggle]').forEach((n) => {
      n.onclick = () => {
        const id = n.dataset.grpToggle;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
      };
    });
    body.querySelectorAll('[data-grp]').forEach((n) => {
      n.onclick = () => {
        // Immer nur EINE Gruppe: Auswahl zuruecksetzen, dann diese setzen.
        // Nochmal auf dieselbe Gruppe klicken hebt die Auswahl wieder auf.
        const g = buildGroups((ctx.players() || []).filter((p) => !p.isDead))
          .find((x) => x.id === n.dataset.grp);
        if (!g) return;
        const already = g.members.every((p) => ctx.highlight.has(p.steamId)) && ctx.highlight.size === g.members.length;
        ctx.highlight.clear();
        if (!already) for (const p of g.members) ctx.highlight.add(p.steamId);
        ctx.onChange();
        render();
      };
    });
  }

  body.querySelectorAll('.cp-tab').forEach((b) => {
    b.onclick = () => { tab = b.dataset.tab; render(); };
  });
  body.querySelector('#plQ').oninput = render;
  body.querySelector('#plNone').onclick = () => { ctx.highlight.clear(); ctx.onChange(); render(); };
  render();

  return { refresh: render };
}
