// Auflösung und Anzeige von Staff-User-Einträgen (RP- / Steam- / Discord-Name).
// Rein funktional — kein DOM, kein State außer dem geteilten USER_POOLS-Register.

// Alle User-Picker (Admin-Panel + Dino-Token/Prime via userSearchHTML) teilen dieses Verhalten.
// Ein natives <datalist> mit ~1000 Optionen zeigt in Chromium NICHT zuverlässig alle Vorschläge
// (deshalb wurden User "nicht gefunden", obwohl sie in der Liste standen). Lösung: das Datalist
// wird beim Tippen dynamisch mit nur den Top-Treffern befüllt — mit wenigen Optionen klappt es.
// USER_POOLS: input-id → User-Array, das dieses Feld durchsucht.
export const USER_POOLS = {};

// userLabel baut den Anzeigetext "RP (Steam, Discord)". Fehlende Teile fallen graziös
// weg: ohne RP-Name → "Steam (Discord)", ohne Steam → "RP (Discord)" usw. So sieht Staff alle
// gesetzten Namen auf einen Blick, und die Substring-Suche (das Label enthält alle drei) trifft
// jeden der drei Namen.
export function userLabel(u) {
  const rp = (u.rpName || '').trim();
  const steam = (u.ingameName || '').trim();
  const disc = (u.discordName || u.name || '').trim();
  const primary = rp || steam || disc || u.steamId || '';
  const extras = [];
  if (rp) { if (steam) extras.push(steam); if (disc && disc !== steam) extras.push(disc); }
  else if (steam) { if (disc && disc !== steam) extras.push(disc); }
  return extras.length ? `${primary} (${extras.join(', ')})` : primary;
}

// userNames = alle gesetzten Namen eines Users (RP/Steam/Discord/Legacy) klein geschrieben.
export function userNames(u) {
  return [u.rpName, u.ingameName, u.discordName, u.name].filter(Boolean).map((s) => s.toLowerCase());
}

// warnItemUser bringt ein /admin/players/search-Item (playerName = Ingame) auf die gemeinsame
// User-Form, damit userLabel/matchUser (RP/Steam/Discord) auch auf die Verwarnungs-Suche passen.
export function warnItemUser(p) {
  return { steamId: p.steamId, discordId: p.discordId, rpName: p.rpName, ingameName: p.playerName, discordName: p.discordName, name: p.discordName || p.playerName };
}

// matchUser löst den getippten/eingefügten Wert robust zum User auf: SteamID/DiscordID exakt
// (Copy-Paste!), kombiniertes Label bzw. einer der drei Namen exakt (case-insensitive),
// Dedup-Suffix "… (…1234)", sonst eindeutiger Teilstring über RP/Steam/Discord.
export function matchUser(v, users) {
  v = (v || '').trim();
  users = users || [];
  if (!v) return null;
  const lv = v.toLowerCase();
  let m = users.find((u) => u.steamId === v || u.discordId === v);
  if (m) return m;
  const label = users.filter((u) => userLabel(u).toLowerCase() === lv);
  if (label.length === 1) return label[0];
  const exact = users.filter((u) => userNames(u).includes(lv));
  if (exact.length === 1) return exact[0];
  const suf = v.match(/\(…(\w{4})\)\s*$/);
  if (suf) {
    m = users.find((u) => (u.steamId || u.discordId || '').slice(-4) === suf[1] && lv.startsWith(userLabel(u).toLowerCase()));
    if (m) return m;
  }
  const sub = users.filter((u) => userLabel(u).toLowerCase().includes(lv) || (u.steamId || '').includes(v));
  if (sub.length === 1) return sub[0];
  return (label[0] || exact[0]) || null; // mehrdeutig → erster Kandidat; sonst nichts
}
