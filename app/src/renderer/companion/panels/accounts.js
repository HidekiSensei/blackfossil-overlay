// Accounts-Panel (Moderation): Discord↔Steam-Verknüpfungen suchen, setzen,
// lösen und Duplikate finden. Aus dem Overlay-Admin-Tab „🔗 Accounts"
// (renderAccount/acFind/acLink/acDups) übernommen und ins Companion-Design
// gebracht: Abschnitte mit cp-colhead-Trennlinie, keine Cards.
//
// Admin-Feature (Backend gated die /admin/accounts/*-Endpunkte auf Admin);
// die Nav blendet den Punkt via cap 'team.accounts' (admin) für Nicht-Admins aus.
import { el } from '../../shared/core.js';
import * as U from '../ui.js';

let C = null;
export function initAccounts(ctx) { C = ctx; }

// Eine Verknüpfungs-Zeile mit „Lösen"-Knopf.
function linkRow(r) {
  const s = r.steamId ? ` ↔ 🎮 ${U.esc(r.steamId)}` : '';
  return `<div class="cp-item"><div class="cp-item-main">`
    + `<div class="cp-item-title">${U.esc(r.name || r.discordId || '—')}</div>`
    + `<div class="cp-item-sub cp-td-mono">🆔 ${U.esc(r.discordId || '—')}${s}</div></div>`
    + U.btn('acUnlink_' + (r.discordId || ''), 'Lösen', { variant: 'danger', size: 'sm' })
    + `</div>`;
}
// Bindet die „Lösen"-Knöpfe im Container auf den Unlink-Aufruf.
function bindUnlink(box, reload) {
  box.querySelectorAll('[id^="acUnlink_"]').forEach((b) => {
    const did = b.id.slice('acUnlink_'.length);
    b.onclick = async () => {
      try { await C.api('POST', '/admin/accounts/unlink', { discordId: did }); C.toast('🔗 Verknüpfung gelöst.', 'success'); reload(); }
      catch (e) { C.toast(e.message, 'error'); }
    };
  });
}

export function renderAccounts(root) {
  root.innerHTML = `<div class="cp-pad cp-pad-narrow">
    ${U.header('Accounts', 'Discord↔Steam-Verknüpfungen suchen, setzen und Duplikate finden.')}

    <div class="cp-colhead">🔍 Verknüpfung suchen</div>
    ${U.field('acFind', 'Discord-ID ODER Steam-ID', { placeholder: 'Discord-ID oder SteamID64…' })}
    ${U.btn('acFindBtn', '🔍 Suchen', { size: 'sm' })}
    <div id="acFindResult"></div>

    <div class="cp-colhead" style="margin-top:var(--cp-s5)">🔗 Verknüpfung setzen</div>
    ${U.row(U.field('acLinkD', 'Discord-ID', { placeholder: 'Discord-ID' }),
            U.field('acLinkS', 'Steam-ID', { placeholder: '7656119…' }))}
    ${U.btn('acLinkBtn', '🔗 Verknüpfen', { variant: 'primary' })}
    <div id="acLinkResult" class="cp-muted"></div>

    <div class="cp-colhead" style="margin-top:var(--cp-s5)">🔁 Duplikate</div>
    ${U.btn('acDupBtn', '🔁 Duplikate suchen', { size: 'sm' })}
    <div id="acDupList"></div>
  </div>`;

  el('acFindBtn').onclick = acFind;
  el('acFind').onkeydown = (e) => { if (e.key === 'Enter') acFind(); };
  el('acLinkBtn').onclick = acLink;
  el('acDupBtn').onclick = acDups;
}

async function acFind() {
  const v = el('acFind').value.trim();
  if (!v) { C.toast('ID eingeben.', 'error'); return; }
  const q = /^7656119\d{10}$/.test(v) ? `steamId=${encodeURIComponent(v)}` : `discordId=${encodeURIComponent(v)}`;
  const box = el('acFindResult'); box.innerHTML = U.muted('Suche…');
  try {
    const d = await C.api('GET', `/admin/accounts/find?${q}`);
    const rows = d.results || [];
    box.innerHTML = rows.length ? `<div class="cp-list">${rows.map(linkRow).join('')}</div>` : U.empty('Keine Verknüpfung gefunden.');
    bindUnlink(box, acFind);
  } catch (e) { box.innerHTML = U.muted('Nicht abrufbar: ' + e.message); }
}

async function acLink() {
  const did = el('acLinkD').value.trim(), sid = el('acLinkS').value.trim();
  if (!did || !sid) { C.toast('Discord-ID + Steam-ID eingeben.', 'error'); return; }
  const out = el('acLinkResult'); out.textContent = '…';
  try {
    const d = await C.api('POST', '/admin/accounts/link', { discordId: did, steamId: sid });
    C.toast('🔗 Verknüpft.', 'success');
    let msg = '✅ Verknüpft.';
    if (d && d.previous) msg += ` Vorher: ${d.previous}.`;
    if (d && d.alsoLinkedTo && d.alsoLinkedTo.length) msg += ` ⚠️ Diese SteamID ist auch verknüpft mit: ${d.alsoLinkedTo.join(', ')}.`;
    out.textContent = msg;
  } catch (e) { C.toast(e.message, 'error'); out.textContent = '❌ ' + e.message; }
}

async function acDups() {
  const box = el('acDupList'); box.innerHTML = U.muted('Suche…');
  try {
    const d = await C.api('GET', '/admin/accounts/dups');
    const dups = d.dups || [];
    if (!dups.length) { box.innerHTML = U.empty('Keine Duplikate. 👍'); return; }
    box.innerHTML = dups.map((g) =>
      `<div class="cp-sec">🎮 ${U.esc(g.steamId)} — ${(g.accounts || []).length}× verknüpft</div>`
      + `<div class="cp-list">${(g.accounts || []).map(linkRow).join('')}</div>`).join('');
    bindUnlink(box, acDups);
  } catch (e) { box.innerHTML = U.muted('Nicht abrufbar: ' + e.message); }
}
