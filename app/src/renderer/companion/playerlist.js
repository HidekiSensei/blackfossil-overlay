// Spielerliste ueber der Karte (Team-only).
// Suche ueber RP-, Steam- und Discord-Name; ausgewaehlte Spieler werden auf der
// Karte hervorgehoben.
import { escapeHtml, baseClass, fmtGrow } from '../shared/format.js';
import { floatingPanel, close, isOpen } from './floating.js';

const ID = 'playerlist';

export function isPlayerListOpen() { return isOpen(ID); }
export function closePlayerList() { close(ID); }

// ctx: { players(), highlight (Set), onChange(), onFocus(steamId) }
export function openPlayerList(ctx) {
  const body = document.createElement('div');
  body.innerHTML = `
    <input id="plQ" class="cp-input cp-float-search" placeholder="RP-, Steam- oder Discord-Name…" autocomplete="off">
    <div class="cp-float-actions">
      <button id="plNone" class="cp-btn cp-btn-sm">Auswahl leeren</button>
      <span id="plCount" class="cp-muted"></span>
    </div>
    <div id="plList" class="cp-float-list"></div>`;

  const panel = floatingPanel(ID, { title: 'Spieler', body, width: 300, x: 24, y: 24 });
  if (!panel) return;

  const q = () => (body.querySelector('#plQ').value || '').trim().toLowerCase();

  function render() {
    const term = q();
    const all = (ctx.players() || []).filter((p) => !p.isDead);
    // Suche ueber das fertige Label (enthaelt RP, Steam und Discord) plus die
    // SteamID fuers Einfuegen aus der Zwischenablage.
    const list = all.filter((p) => !term
      || (p.label1 || '').toLowerCase().includes(term)
      || (p.name || '').toLowerCase().includes(term)
      || (p.realName || '').toLowerCase().includes(term)
      || String(p.steamId || '').includes(term));
    list.sort((a, b) => (a.label1 || a.name || '').localeCompare(b.label1 || b.name || '', 'de'));

    body.querySelector('#plCount').textContent =
      `${ctx.highlight.size} ausgewählt · ${list.length}/${all.length}`;

    body.querySelector('#plList').innerHTML = list.length
      ? list.map((p) => {
          const on = ctx.highlight.has(p.steamId);
          return `<button type="button" class="cp-pl-row${on ? ' on' : ''}" data-id="${escapeHtml(p.steamId)}">`
            + `<span class="cp-pl-dot"></span><span class="cp-pl-main">`
            + `<span class="cp-pl-name">${escapeHtml(p.label1 || p.name || p.steamId)}</span>`
            + `<span class="cp-pl-sub">${escapeHtml([baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · '))}</span>`
            + `</span></button>`;
        }).join('')
      : `<div class="cp-empty">Niemand gefunden.</div>`;

    body.querySelectorAll('[data-id]').forEach((n) => {
      n.onclick = (e) => {
        const id = n.dataset.id;
        if (ctx.highlight.has(id)) ctx.highlight.delete(id); else ctx.highlight.add(id);
        // Klick mit gedrueckter Alt-Taste zentriert zusaetzlich auf den Spieler.
        if (e.altKey && ctx.onFocus) ctx.onFocus(id);
        ctx.onChange();
        render();
      };
    });
  }

  body.querySelector('#plQ').oninput = render;
  body.querySelector('#plNone').onclick = () => { ctx.highlight.clear(); ctx.onChange(); render(); };
  render();

  // Die Liste lebt von /positions und wird dort aktualisiert.
  return { refresh: render };
}
