/**
 * BlackFossil Token-Service
 * - Discord-OAuth-Login → Steam-ID-Lookup (accounts.json) → App-Session (JWT)
 * - LiveKit-Token-Ausgabe für den Proximity-Voice-Raum
 *
 * Läuft auf dem Linux-Server hinter Caddy:
 *   /auth*  und /token  → dieser Service (Port 8090)
 *   alles andere        → LiveKit (Port 7880)
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { AccessToken } from 'livekit-server-sdk';
import { randomBytes, createVerify, createHmac, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { MUTATIONS, PRIME_LABELS, DINOS, getDiet, activeSpecies, mutationsFor, PVP_BUILDS, PVP_LABEL_PREFIX, getPvpBuild } from './staffConfig.js';

// ── Konfiguration ──────────────────────────────────────────────────────────
const PORT             = process.env.PORT             ?? 8090;
const PUBLIC_BASE      = process.env.PUBLIC_BASE      ?? 'https://voice.blackfossil.de';
const LIVEKIT_URL      = process.env.LIVEKIT_URL      ?? 'wss://voice.blackfossil.de';
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const SESSION_SECRET     = process.env.SESSION_SECRET;
const ACCOUNTS_PATH      = process.env.ACCOUNTS_PATH  ?? '/opt/blackfossil-bot/data/accounts.json';
const PROXIMITY_ROOM     = process.env.PROXIMITY_ROOM ?? 'proximity';
// Game-Server (Nyors) für Positionsdaten
const PANEL_BASE_URL     = process.env.PANEL_BASE_URL ?? 'http://100.117.32.93:8765';
const PANEL_ADMIN_TOKEN  = process.env.PANEL_ADMIN_TOKEN ?? '';
// Discord-Rollen-Check (für Admin/Owner-Rechte, z.B. Kalibrierung)
const DISCORD_BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN ?? '';
const DISCORD_GUILD_ID   = process.env.DISCORD_GUILD_ID ?? '';
const ADMIN_ROLE_NAMES   = (process.env.ADMIN_ROLE_NAMES ?? 'Owner,Admin').split(',').map((s) => s.trim());
// Deep-Link zurück in die Electron-App
const APP_REDIRECT       = process.env.APP_REDIRECT   ?? 'blackfossil://auth';

const REDIRECT_URI = `${PUBLIC_BASE}/auth/callback`;

for (const [k, v] of Object.entries({ DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, SESSION_SECRET })) {
  if (!v) { console.error(`❌ Env-Variable fehlt: ${k}`); process.exit(1); }
}

// ── Discord↔Steam Lookup ─────────────────────────────────────────────────
function lookupSteamId(discordId) {
  try {
    const accounts = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'));
    return accounts[discordId] ?? null;
  } catch (err) {
    console.error('accounts.json Lesefehler:', err.message);
    return null;
  }
}

// Abo-Tiers von höchstem zu niedrigstem (Discord-Rollennamen)
const TIER_ROLES = (process.env.TIER_ROLES ?? 'Obsidian,Bernstein,Knochen').split(',').map((s) => s.trim());
// Staff-Ränge von höchstem zu niedrigstem
const STAFF_ROLES = (process.env.STAFF_ROLES ?? 'Owner,Admin,Supporter').split(',').map((s) => s.trim());
// EINHEITLICHE Rang-Leiter (höchster → niedrigster). Es wird nur der höchste angezeigt.
const RANK_ROLES = (process.env.RANK_ROLES ?? 'Owner,Admin,Moderator,Support,Beta Tester,Fossil').split(',').map((s) => s.trim());
// Rechte-Stufen: admin = volle Config; ingame = Ingame-Tools (Moderator+); team = alle Staff inkl. Support
const ADMIN_RANKS  = (process.env.ADMIN_RANKS  ?? 'Owner,Admin').split(',').map((s) => s.trim());
const INGAME_RANKS = (process.env.INGAME_RANKS ?? 'Owner,Admin,Moderator').split(',').map((s) => s.trim());
const TEAM_RANKS   = (process.env.TEAM_RANKS   ?? 'Owner,Admin,Moderator,Support').split(',').map((s) => s.trim());

// ── PayPal-Abos (Subscriptions → Discord-Rolle) ─────────────────────────────
const WEB_BASE            = process.env.WEB_BASE            ?? 'https://www.blackfossil.de';
const PAYPAL_ENV          = process.env.PAYPAL_ENV          ?? 'live'; // 'live' | 'sandbox'
const PAYPAL_API          = PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const PAYPAL_CLIENT_ID    = process.env.PAYPAL_CLIENT_ID    ?? '';
const PAYPAL_CLIENT_SECRET= process.env.PAYPAL_CLIENT_SECRET?? '';
const PAYPAL_WEBHOOK_ID   = process.env.PAYPAL_WEBHOOK_ID   ?? '';
// Plan-ID → Discord-Rollenname. IDs nach dem paypal-setup.mjs-Lauf in die ENV eintragen.
const PAYPAL_PLANS = {};
for (const [plan, role] of [
  [process.env.PAYPAL_PLAN_KNOCHEN,   'Knochen'],
  [process.env.PAYPAL_PLAN_BERNSTEIN, 'Bernstein'],
  [process.env.PAYPAL_PLAN_OBSIDIAN,  'Obsidian'],
]) { if (plan) PAYPAL_PLANS[plan] = role; }
// Alle Abo-Rollen (für sauberes Entziehen/Upgrade)
const ALL_TIER_ROLES = ['Knochen', 'Bernstein', 'Obsidian'];
// 🧪 Test-/Comp-Rolle: wer diese Discord-Rolle hat, bekommt SOFORT volle Obsidian-Perks
// (umgeht den Go-Live-Stichtag — fürs Testen vor dem Release & für verschenkte Ränge).
const FORCE_OBSIDIAN_ROLE = process.env.ABO_FORCE_OBSIDIAN_ROLE ?? 'Joe';
// 🎨 Rolle, die den Skin-Creator gratis macht (sonst Free-Verhalten) — z. B. Beta-Tester.
const SKIN_FREE_ROLE = process.env.SKIN_FREE_ROLE ?? 'Beta Tester';

// ── Discord-Rollen-Check (Admin + Tier + Staff-Rang) ────────────────────────
async function getDiscordStatus(discordId) {
  const result = { admin: false, ingame: false, team: false, rank: 'Fossil', tier: 'Fossil', aboTier: null, aboForce: null, staff: null, betaTester: false, ok: false };
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return result;
  try {
    const headers = { Authorization: `Bot ${DISCORD_BOT_TOKEN}` };
    const [mRes, rRes] = await Promise.all([
      fetch(`https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}`, { headers }),
      fetch(`https://discord.com/api/guilds/${DISCORD_GUILD_ID}/roles`, { headers }),
    ]);
    if (!mRes.ok || !rRes.ok) return result;
    const member = await mRes.json();
    const roles = await rRes.json();
    const myRoleNames = new Set(roles.filter((r) => (member.roles || []).includes(r.id)).map((r) => r.name));
    // NUR den höchsten Rang aus der einheitlichen Leiter laden (Default: niedrigster = Fossil).
    // So gibt es keine Berechtigungs-Konflikte durch mehrere/niedrigere Rollen.
    const rank = RANK_ROLES.find((n) => myRoleNames.has(n)) ?? RANK_ROLES[RANK_ROLES.length - 1];
    result.rank = rank;
    result.tier = rank;          // HUD zeigt nur diesen einen Rang
    // Abo-Rang (Knochen/Bernstein/Obsidian) separat ermitteln — steht NICHT in RANK_ROLES.
    // Höchsten gehaltenen Abo-Rang nehmen (ALL_TIER_ROLES ist aufsteigend sortiert).
    result.aboTier = [...ALL_TIER_ROLES].reverse().find((n) => myRoleNames.has(n)) || null;
    // 🧪 Obsidian-Override (umgeht Stichtag, s. aboPerkIdx): „Joe"-Test-/Comp-Rolle ODER Team
    // (TEAM_RANKS) → das Team hat ständig die vollen Obsidian-Perks.
    result.aboForce = ((FORCE_OBSIDIAN_ROLE && myRoleNames.has(FORCE_OBSIDIAN_ROLE)) || TEAM_RANKS.includes(rank)) ? 'Obsidian' : null;
    result.staff = null;         // kein zweites Badge mehr
    result.admin = ADMIN_RANKS.includes(rank);
    result.ingame = INGAME_RANKS.includes(rank);
    result.team = TEAM_RANKS.includes(rank);
    result.betaTester = myRoleNames.has(SKIN_FREE_ROLE);   // 🎨 Skin-Creator gratis
    result.ok = true;   // Discord-Auflösung erfolgreich (vs. Fallback bei Fehler)
    return result;
  } catch {
    return result;
  }
}

// Kurzlebiger Cache für getDiscordStatus (60s). Nutzt /token, um bei jedem Overlay-Start den
// LIVE-Status aufzulösen (Team/Rang/Abo wirken sofort, kein Neu-Login nötig). 4s-Timeout gegen
// Discord-Hänger → null; nur erfolgreiche Auflösungen werden gecacht (Fehler sofort neu versuchen).
const _dStatusCache = new Map();    // discordId → { at, status }
const _dStatusInflight = new Map(); // discordId → Promise (dedup gleichzeitiger Refreshes)
async function getDiscordStatusCached(discordId) {
  const c = _dStatusCache.get(discordId);
  if (c && Date.now() - c.at < 60000) return c.status;
  if (_dStatusInflight.has(discordId)) return _dStatusInflight.get(discordId);
  const p = (async () => {
    const s = await Promise.race([
      getDiscordStatus(discordId),
      new Promise((res) => setTimeout(() => res(null), 4000)),
    ]);
    if (s && s.ok) _dStatusCache.set(discordId, { at: Date.now(), status: s });
    _dStatusInflight.delete(discordId);
    return s;
  })();
  _dStatusInflight.set(discordId, p);
  return p;
}
// Live-aboForce (Team/Joe) aus dem Cache statt aus dem eingefrorenen JWT — so wirken Team-/
// Rollen-Änderungen auch bei der server-seitigen Perk-Durchsetzung ohne Neu-Login. Cache-Wert
// bis 5 Min alt wird toleriert (sessionFrom hält ihn frisch); kein Treffer → JWT-Claim als Fallback.
function liveAboForce(s) {
  const c = s && s.discordId ? _dStatusCache.get(s.discordId) : null;
  if (c && c.status && c.status.ok && Date.now() - c.at < 300000) return c.status.aboForce;
  return s ? s.aboForce : null;
}
// Live-Beta-Tester-Status (Cache, sonst JWT-Claim) — macht den Skin-Creator gratis.
function liveBeta(s) {
  const c = s && s.discordId ? _dStatusCache.get(s.discordId) : null;
  if (c && c.status && c.status.ok && Date.now() - c.at < 300000) return !!c.status.betaTester;
  return !!(s && s.betaTester);
}

// ── OAuth State (kurzlebig, in-memory) ─────────────────────────────────────
const stateStore = new Map(); // state -> { ts, mode, ret }
function newState(meta = {}) {
  const s = randomBytes(16).toString('hex');
  stateStore.set(s, { ts: Date.now(), mode: 'app', ...meta });
  // Alte States (>10 min) aufräumen
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of stateStore) if ((v?.ts ?? 0) < cutoff) stateStore.delete(k);
  return s;
}

const app = express();

// CORS für die von der Website (www.blackfossil.de) per fetch aufgerufenen Endpunkte
// (Stripe-Checkout + Kündigung). Cross-Origin POST+JSON braucht Preflight-Antwort + Allow-Origin.
app.use((req, res, next) => {
  if (req.path.startsWith('/stripe/') || req.path === '/me/cancel-subscription') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// ── 1) Login starten ───────────────────────────────────────────────────────
app.get('/auth/login', (_req, res) => {
  const state = newState();
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// ── 1b) Web-Login (für die Website / Abo-Kauf) ─────────────────────────────
// Gleiche Discord-App + Redirect-URI wie der App-Login; nur der State markiert
// "web", damit der Callback zur Website zurückleitet statt in die App.
app.get('/auth/web/login', (req, res) => {
  let ret = String(req.query.return ?? `${WEB_BASE}/abo.html`);
  // Nur Rücksprünge auf die eigene Website erlauben (offene Redirects vermeiden)
  try { if (new URL(ret).origin !== new URL(WEB_BASE).origin) ret = `${WEB_BASE}/abo.html`; }
  catch { ret = `${WEB_BASE}/abo.html`; }
  const state = newState({ mode: 'web', ret });
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// ── 2) Discord-Callback ──────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = state ? stateStore.get(state) : null;
  if (!code || !state || !st) {
    return res.status(400).send(htmlPage('❌ Login fehlgeschlagen', 'Ungültige oder abgelaufene Anfrage. Bitte versuche es erneut.'));
  }
  stateStore.delete(state);

  try {
    // Code gegen Token tauschen
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Discord Token-Tausch fehlgeschlagen (${tokenRes.status})`);
    const { access_token } = await tokenRes.json();

    // Discord-User abrufen
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userRes.ok) throw new Error('Discord-User konnte nicht geladen werden');
    const user = await userRes.json();

    // Steam-ID nachschlagen + Rang/Rechte (Rang braucht kein Steam)
    const steamId = lookupSteamId(user.id);
    const { admin, ingame, team, rank, tier, aboTier, aboForce, staff, betaTester } = await getDiscordStatus(user.id);

    // Web-Login (Abo-Kauf): zurück zur Website mit Discord-ID. Steam ist hier
    // NICHT Pflicht — die Abo-Rolle wird über die Discord-ID vergeben.
    if (st.mode === 'web') {
      const back = new URL(st.ret || `${WEB_BASE}/abo.html`);
      back.searchParams.set('discord_id', user.id);
      back.searchParams.set('name', user.global_name || user.username);
      back.searchParams.set('tier', tier || 'Fossil');
      back.searchParams.set('abo', aboTier || '');   // aktueller Abo-Rang für die Website (leer = keiner)
      // Signiertes Web-Token → erlaubt der Abo-Seite abgesicherte Aktionen (Kündigung),
      // ohne dass jemand fremde Abos über eine geratene discordId kündigen kann.
      back.searchParams.set('wtoken', jwt.sign({ discordId: user.id, web: true }, SESSION_SECRET, { expiresIn: '60d' }));
      return res.redirect(back.toString());
    }

    // App-Login braucht eine Steam-Verknüpfung
    if (!steamId) {
      return res.status(403).send(htmlPage(
        '⚠️ Account nicht verknüpft',
        'Dein Discord-Account ist noch nicht mit Steam verknüpft. Bitte verknüpfe ihn zuerst im Discord über den ACCOUNT-LINK-Button.'
      ));
    }

    // App-Session ausstellen (30 Tage)
    const session = jwt.sign(
      { steamId, discordId: user.id, name: user.global_name || user.username, admin, ingame, team, rank, tier, aboForce, staff, betaTester, avatar: user.avatar ?? null },
      SESSION_SECRET,
      { expiresIn: '30d' }
    );

    // Zurück in die App per Deep-Link
    const redirect = `${APP_REDIRECT}?session=${encodeURIComponent(session)}`;
    res.send(htmlPage(
      '✅ Erfolgreich angemeldet!',
      'Du kannst dieses Fenster schließen und zur BlackFossil-App zurückkehren.',
      redirect,
      session
    ));
  } catch (err) {
    console.error('Callback-Fehler:', err);
    res.status(500).send(htmlPage('❌ Fehler', err.message));
  }
});

// ── 3) LiveKit-Token ausgeben ───────────────────────────────────────────────
app.get('/token', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });

  let payload;
  try {
    payload = jwt.verify(sessionToken, SESSION_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session ungültig oder abgelaufen' });
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: payload.steamId,
    name: payload.name,
    ttl: '1h',
  });
  at.addGrant({ roomJoin: true, room: PROXIMITY_ROOM, canPublish: true, canSubscribe: true });

  // LIVE-Status (60s gecacht) statt der beim Login eingefrorenen JWT-Claims → Team-/Rang-/
  // Abo-Änderungen wirken sofort, ohne dass sich der User neu einloggen muss. Bei Discord-
  // Fehler/Timeout: sauberer Fallback auf die JWT-Claims (kein Downgrade durch Aussetzer).
  const live = payload.discordId ? await getDiscordStatusCached(payload.discordId) : null;
  const st = live && live.ok ? live : null;
  const admin = st ? st.admin : !!payload.admin;
  const ingame = st ? st.ingame : (!!payload.ingame || !!payload.admin);
  const team = st ? st.team : isTeamMember(payload);
  const rank = (st && st.rank) || payload.rank || payload.tier || 'Fossil';
  const aboForce = st ? st.aboForce : payload.aboForce;

  res.json({
    token: await at.toJwt(),
    url: LIVEKIT_URL,
    room: PROXIMITY_ROOM,
    identity: payload.steamId,
    name: payload.name,
    admin: !!admin,
    ingame: !!ingame || !!admin,
    team,
    rank,
    tier: rank,
    staff: null,
    // Effektiver Abo-Rang (Theme-Gating/Zombie/Skin). Team/Joe → Obsidian (aboForce, jetzt live);
    // sonst live aus subscriptions.json ab dem Go-Live-Stichtag.
    aboTier: aboForce || (aboPerksLive() ? aboTierFor(payload.discordId) : null),
    // 🎨 Skin-Creator gratis? Ab Knochen ODER Beta-Tester-Rolle (sonst Free = zahlt Punkte).
    skinFree: skinFreeFor(payload),
  });
});

// Overlay-Aktivität: wer pollt /positions = hat das Overlay an. Für die Overlay-Pflicht.
const overlayActivity = {}; // steamId → lastSeen-ts (in-memory, periodisch in Datei geflusht)

// ── Gruppen-Chat (eigener Relay, datenschutzfreundlich, in-memory) ──────────
const chatStore = {};        // gruppenKey → [{id,name,steamId,text,ts}]
const chatGroupCache = {};   // steamId → {key,name,ts} — wird aus /positions gefüllt (keine Extra-Game-Last)
let chatSeq = 1;
const CHAT_MAX = 80;                 // max. Nachrichten pro Gruppe
const CHAT_TTL = 1000 * 60 * 60;     // Nachrichten nach 1h verwerfen
const CHAT_CACHE_TTL = 20000;        // Gruppen-Key-Cache 20s gültig
// Gruppen-Schlüssel eines Spielers: Overlay-Gruppe bevorzugt, sonst In-Game-groupId.
// Nutzt den Cache aus /positions; nur als Fallback ein Game-API-Call.
async function chatGroupKey(steamId) {
  const c = chatGroupCache[steamId];
  if (c && Date.now() - c.ts < CHAT_CACHE_TTL) return c;
  const ov = readOv();
  const og = myOvGroupId(ov, steamId);
  let key = og ? 'ov:' + og : null, name = steamId;
  if (!key) { try { const ps = await fetchPlayers(); const p = ps.find((x) => x.steamId === steamId); if (p) { name = p.playerName; if (p.groupId != null) key = 'g:' + p.groupId; } } catch {} }
  const entry = { key, name, ts: Date.now() };
  chatGroupCache[steamId] = entry;
  return entry;
}

// ── 4) Spielerpositionen relayen (Welt-Koordinaten) ────────────────────────
app.get('/positions', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });

  let payload;
  try { payload = jwt.verify(sessionToken, SESSION_SECRET); }
  catch { return res.status(401).json({ error: 'Session ungültig' }); }
  overlayActivity[payload.steamId] = Date.now(); // Overlay ist aktiv

  try {
    const gamePlayers = await fetchPlayers();   // gecacht (~1s) → keine Last-Vervielfachung
    const ov = readOv();
    if (enforceGroupDiet(ov, gamePlayers)) writeOv(ov);   // Diät-Wechsel → Auto-Kick
    const ovMembers = new Set(ovMembersOf(ov, payload.steamId));
    const players = gamePlayers.map((p) => ({
      steamId: p.steamId,
      name: p.playerName,
      dino: p.dinoClass,
      x: p.location?.x ?? 0,
      y: p.location?.y ?? 0,
      z: p.location?.z ?? 0,
      heading: p.lookDirection ?? 0,
      isDead: !!p.isDead,
      isYou: p.steamId === payload.steamId,
      groupId: p.groupId ?? null,
      grow: p.grow ?? null,
      health: p.health ?? null,
      partnerSteamId: p.partnerSteamId ?? null,
      ovgroup: ovMembers.has(p.steamId) && p.steamId !== payload.steamId,
    }));
    // Ausstehende Overlay-Toasts für diesen Spieler ausliefern + leeren
    let toasts = [];
    try {
      const tf = `${BOT_DATA_DIR}/toasts.json`;
      const store = readJson(tf, {});
      if (Array.isArray(store[payload.steamId]) && store[payload.steamId].length) {
        toasts = store[payload.steamId];
        delete store[payload.steamId];
        writeJsonFile(tf, store);
      }
    } catch {}
    // Chat-Gruppen-Key für diesen Spieler cachen (ohne Extra-Game-Call)
    { const og = myOvGroupId(ov, payload.steamId);
      const meP = players.find((x) => x.isYou);
      const key = og ? 'ov:' + og : (meP && meP.groupId != null ? 'g:' + meP.groupId : null);
      chatGroupCache[payload.steamId] = { key, name: (meP && meP.name) || payload.steamId, ts: Date.now() }; }
    res.json({ players, you: payload.steamId, toasts });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── 4c) Gruppen-Chat: senden + abfragen ────────────────────────────────────
app.post('/group/chat', express.json(), async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const text = String(req.body?.text ?? '').trim().slice(0, 240);
  if (!text) return res.status(400).json({ error: 'Leere Nachricht' });
  const { key, name } = await chatGroupKey(s.steamId);
  if (!key) return res.status(400).json({ error: 'Keine Gruppe' });
  const msg = { id: chatSeq++, name, steamId: s.steamId, text, ts: Date.now() };
  const arr = chatStore[key] || (chatStore[key] = []);
  arr.push(msg);
  if (arr.length > CHAT_MAX) arr.splice(0, arr.length - CHAT_MAX);
  res.json({ ok: true, id: msg.id });
});

app.get('/group/chat', async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const since = parseInt(req.query.since) || 0;
  const { key } = await chatGroupKey(s.steamId);
  if (!key) return res.json({ messages: [], group: null });
  const now = Date.now();
  const arr = (chatStore[key] || []).filter((m) => now - m.ts < CHAT_TTL);
  chatStore[key] = arr;   // alte Nachrichten weglaufen lassen
  const messages = arr.filter((m) => m.id > since)
    .map((m) => ({ id: m.id, name: m.name, text: m.text, ts: m.ts, me: m.steamId === s.steamId }));
  res.json({ messages, group: key });
});

// ── Speicher-Janitor: hält die In-Memory-Stores beschränkt ─────────────────
// Ohne das wachsen chatStore (stille Gruppen), chatGroupCache und overlayActivity
// über Tage/Wochen unbegrenzt. Läuft alle 10 Min und räumt Veraltetes weg.
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(chatStore)) {
    const kept = chatStore[key].filter((m) => now - m.ts < CHAT_TTL);
    if (kept.length) chatStore[key] = kept; else delete chatStore[key];
  }
  for (const sid of Object.keys(chatGroupCache)) {
    if (now - (chatGroupCache[sid]?.ts || 0) > 60 * 60_000) delete chatGroupCache[sid];
  }
  for (const sid of Object.keys(overlayActivity)) {
    if (now - overlayActivity[sid] > 6 * 60 * 60_000) delete overlayActivity[sid];
  }
}, 10 * 60_000).unref?.();

// ── 4b) Eigene Dino-Stats ──────────────────────────────────────────────────
app.get('/me', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });
  let payload;
  try { payload = jwt.verify(sessionToken, SESSION_SECRET); }
  catch { return res.status(401).json({ error: 'Session ungültig' }); }

  try {
    const gamePlayers = await fetchPlayers();   // gecacht (~1s)
    const points = getPoints(payload.steamId);
    const tier = payload.tier || 'Fossil';
    const p = gamePlayers.find((x) => x.steamId === payload.steamId);
    const tokens = getInventory(payload.steamId);
    const playtime = readJson(`${BOT_DATA_DIR}/playtime.json`, {})[payload.discordId]?.totalSeconds ?? 0;
    const avatarUrl = payload.avatar ? `https://cdn.discordapp.com/avatars/${payload.discordId}/${payload.avatar}.png?size=64` : null;
    if (!p) return res.json({ online: false, points, tier, name: payload.name, tokens, playtime, avatarUrl });
    res.json({
      online: true,
      points, tier, tokens, playtime, avatarUrl,
      name: p.playerName,
      dino: p.dinoClass,
      gender: p.gender,
      grow: p.grow,
      health: p.health,
      hunger: p.hunger,
      thirst: p.thirst,
      stamina: p.stamina,
      blood: p.blood,
      carbs: p.carbs,
      protein: p.protein,
      lipid: p.lipid,
      isElder: !!p.isElder,
      isHatchling: !!p.isHatchling,
      isPrime: !!p.isPrime,
      elderStacks: p.elderReplicationStacks ?? 0,
      isBleeding: !!p.isBleeding,
      primes: Array.from({ length: 10 }, (_, i) => !!p[`primeCondition${i + 1}`]),
      skin: {
        skinVariation: p.skinVariation ?? 0,
        patternIndex: p.patternIndex ?? 0,
        themeIndex: p.themeIndex ?? 0,
        colors: {
          maleDisplayColor: p.maleDisplayColor, markingsColor: p.markingsColor, bodyColor: p.bodyColor,
          flankColor: p.flankColor, underbellyColor: p.underbellyColor, teethColor: p.teethColor,
          mouthColor: p.mouthColor, clawsColor: p.clawsColor, detailColor: p.detailColor, eyesColor: p.eyesColor,
        },
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Live-Vitals (HP & Co.) — eigener, schneller Endpoint für das Herz/HUD.
// Combat-relevant → frischer Cache (VITALS_MAX_AGE). Sehr leicht: nur eigener Eintrag. ──
app.get('/me/vitals', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  try {
    const p = (await fetchPlayers(VITALS_MAX_AGE)).find((x) => x.steamId === s.steamId);
    if (!p) return res.json({ online: false });
    res.json({ online: true, health: p.health ?? null, blood: p.blood ?? null, stamina: p.stamina ?? null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── 4c) Token einlösen (Overlay) ────────────────────────────────────────────
app.post('/tokens/redeem', express.json(), async (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });
  let payload;
  try { payload = jwt.verify(sessionToken, SESSION_SECRET); }
  catch { return res.status(401).json({ error: 'Session ungültig' }); }

  const type = String(req.body?.type ?? '');
  const def = TOKEN_DEFS[type];
  if (!def) return res.status(400).json({ error: 'Unbekannter Token' });
  if ((getInventory(payload.steamId)[type] ?? 0) < 1) return res.status(400).json({ error: 'Kein Token dieses Typs.' });

  try {
    const r = await fetch(`${PANEL_BASE_URL}/players`, { headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Game-Server HTTP ${r.status}`);
    const p = ((await r.json()).Players ?? []).find((x) => x.steamId === payload.steamId);
    if (!p) return res.status(400).json({ error: 'Du musst online auf einem Dino sein.' });

    const sid = encodeURIComponent(payload.steamId);
    const post = (path, body) => fetch(`${PANEL_BASE_URL}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    let gr;
    if (def.effect === 'grow_set') gr = await post(`/players/${sid}/grow`, { value: INSTA_GROW_TARGET });
    else if (def.effect === 'grow_add') gr = await post(`/players/${sid}/grow`, { value: Math.min(1, (p.grow ?? 0) + GROW_BOOST_STEP) });
    else gr = await post('/vitals', vitalsBody(payload.steamId, def.apiField, 1));
    if (!gr.ok) throw new Error(`Anwenden fehlgeschlagen (HTTP ${gr.status})`);

    if (!removeOneToken(payload.steamId, type)) return res.status(400).json({ error: 'Token nicht mehr vorhanden.' });
    // Insta-Grow benutzt → laufende RP-Quest zählt nicht mehr (Wachstum muss „echt" sein)
    if (def.effect === 'grow_set') {
      try { const all = readJson(QUESTS_FILE, {}); const q = all[payload.steamId]; if (q && q.active && q.active.status === 'active') { q.active.instaUsed = true; writeJsonFile(QUESTS_FILE, all); } } catch {}
    }
    res.json({ ok: true, label: def.label, emoji: def.emoji, tokens: getInventory(payload.steamId) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── 5) Karten-Kalibrierung (zentral geteilt) ────────────────────────────────
const CALIBRATION_FILE = process.env.CALIBRATION_FILE ?? '/opt/token-service/calibration.json';

app.get('/calibration', (_req, res) => {
  try {
    const data = JSON.parse(readFileSync(CALIBRATION_FILE, 'utf8'));
    res.json(data);
  } catch {
    res.json({}); // noch keine gespeichert
  }
});

app.post('/calibration', express.json(), (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });
  let payload;
  try { payload = jwt.verify(sessionToken, SESSION_SECRET); }
  catch { return res.status(401).json({ error: 'Session ungültig' }); }
  if (!isAdminMember(payload)) return res.status(403).json({ error: 'Nur für Admins' });

  const affine = req.body?.affine;
  if (!affine || typeof affine.a !== 'number') return res.status(400).json({ error: 'Ungültige Kalibrierung' });
  try {
    writeFileSync(CALIBRATION_FILE, JSON.stringify({ affine, by: payload.name, at: Date.now() }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 6) Zonen (PVP/PVE Polygone, zentral geteilt) ────────────────────────────
const ZONES_FILE = process.env.ZONES_FILE ?? '/opt/token-service/zones.json';

app.get('/zones', (_req, res) => {
  try { res.json(JSON.parse(readFileSync(ZONES_FILE, 'utf8'))); }
  catch { res.json({}); }
});

app.post('/zones', express.json(), (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });
  let payload;
  try { payload = jwt.verify(sessionToken, SESSION_SECRET); }
  catch { return res.status(401).json({ error: 'Session ungültig' }); }
  if (!payload.admin) return res.status(403).json({ error: 'Nur Admins' });

  const { pvp, pve } = req.body ?? {};
  if (!Array.isArray(pvp) && !Array.isArray(pve)) return res.status(400).json({ error: 'Ungültige Zonen' });
  try {
    writeFileSync(ZONES_FILE, JSON.stringify({ pvp: pvp ?? [], pve: pve ?? [], by: payload.name, at: Date.now() }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7) Garage (Bot-seitige JSON-Daten, gemeinsam genutzt) ───────────────────
const BOT_DATA_DIR = process.env.BOT_DATA_DIR ?? '/opt/blackfossil-bot/data';
const GARAGE_FILE = `${BOT_DATA_DIR}/garage.json`;

// ── Token-Inventar (geteilt mit dem Bot: inventory.json) ────────────────────
const INVENTORY_FILE = `${BOT_DATA_DIR}/inventory.json`;
const INSTA_GROW_TARGET = parseFloat(process.env.INSTANT_GROW_TARGET_PCT ?? '80') / 100;
const GROW_BOOST_STEP = parseFloat(process.env.GROW_BOOST_STEP ?? '0.1');
// Reihenfolge + Wirkung müssen mit dem Bot (client.ts TOKEN_TYPES) übereinstimmen.
const TOKEN_ORDER = ['hunger', 'thirst', 'protein', 'carbs', 'lipid', 'heal', 'grow_boost', 'insta_grow'];
const TOKEN_DEFS = {
  hunger:     { label: 'Hunger-Token',     emoji: '🍖', effect: 'vital', apiField: 'food' },
  thirst:     { label: 'Durst-Token',      emoji: '💧', effect: 'vital', apiField: 'water' },
  protein:    { label: 'Protein-Token',    emoji: '🥩', effect: 'vital', apiField: 'nutrients.proteins' },
  carbs:      { label: 'Carbs-Token',      emoji: '🌿', effect: 'vital', apiField: 'nutrients.carbs' },
  lipid:      { label: 'Lipid-Token',      emoji: '🥑', effect: 'vital', apiField: 'nutrients.lipids' },
  heal:       { label: 'Heal-Token',       emoji: '❤️', effect: 'vital', apiField: 'health' },
  grow_boost: { label: 'Grow-Boost-Token', emoji: '📈', effect: 'grow_add' },
  insta_grow: { label: 'Insta-Grow-Token', emoji: '⚡', effect: 'grow_set' },
};
function getInventory(steamId) {
  const all = readJson(INVENTORY_FILE, {});
  const inv = {};
  for (const t of TOKEN_ORDER) inv[t] = all[steamId]?.[t] ?? 0;
  return inv;
}
function removeOneToken(steamId, type) {
  return withFileLock(INVENTORY_FILE, () => {
    const all = readJson(INVENTORY_FILE, {});
    const have = all[steamId]?.[type] ?? 0;
    if (have < 1) return false;
    all[steamId][type] = have - 1;
    writeJsonFile(INVENTORY_FILE, all);
    return true;
  });
}
// Punkt-Pfad ("nutrients.proteins") → verschachteltes Objekt mit Wert
function vitalsBody(steamId, apiField, val) {
  const entry = { steamId };
  const parts = apiField.split('.');
  let cur = entry;
  for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] ?? {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = val;
  return [entry];
}

// Token-Limit & Cooldowns — geteilt mit dem Bot über dieselben Dateien in BOT_DATA_DIR.
const COOLDOWNS_FILE = `${BOT_DATA_DIR}/cooldowns.json`;
const TOKEN_LIMIT = parseInt(process.env.TOKEN_LIMIT ?? '50', 10);
const PARK_COOLDOWN_MS = parseInt(process.env.PARK_COOLDOWN_MIN ?? '5', 10) * 60_000;   // TEST: 5 Min (normal 30)
const UNPACK_COOLDOWN_MS = parseInt(process.env.UNPACK_COOLDOWN_MIN ?? '5', 10) * 60_000; // TEST: 5 Min (normal 30)

// ════════════════════════════════════════════════════════════════════════════
// 🎁 ABO-PERKS — ZENTRALE KONFIGURATION
// Tiers: Fossil(0) < Knochen(1) < Bernstein(2) < Obsidian(3).
// Ingame-Vorteile zünden erst ab dem Stichtag ABO_PERKS_START (aboPerksLive()).
//
// ⚙️ SEASON-WECHSEL: ALLE Perk-Werte hier zentral anpassen. Ein Season-Wipe löscht
//    die SPIELER-Daten (garage.json, points.json, inventories, cooldowns.json,
//    quests.json, marketplace/auctions/wants) — DIESE Config bleibt bestehen.
//    Werte ändern → Datei kopieren + `pm2 restart bf-token`. Reihenfolge in jedem
//    Array = [Fossil, Knochen, Bernstein, Obsidian].
// ════════════════════════════════════════════════════════════════════════════
const ABO_TIERS = ['Fossil', 'Knochen', 'Bernstein', 'Obsidian'];
const ABO_PERKS = {
  garageSlots:   [10, 20, 40, 80],       // 🚗 Garage-Plätze (für alle gratis, Free vermindert)
  cooldownMin:   [30, 20, 10, 5],        // ⏱️ Ein-/Ausparken-Cooldown in Minuten
  questsPerDay:  [2, 3, 4, 5],           // 📜 Quest-Rolls/Tag (Basis 2 + Tier-Bonus)
  marketSlots:   [2, 3, 4, 5],           // 🛒 gleichzeitige Markt-Angebote (Basis 2 + Tier-Bonus)
  skinSlots:     [1, 2, 5, 10],          // 💾 Skin-Vorlagen-Speicherplätze (Free: 1, zahlt fürs Speichern)
  growBiweekly:  [0, 1, 2, 3],           // 🌱 Instant-Grow-Token alle 14 Tage ab Kaufdatum (Bot-Job)
  lootboxWeekly: [0, 1, 2, 3],           // 🎁 Lootboxen alle 7 Tage ab Kaufdatum (Bot-Job)
  welcomeBonus:  [0, 1000, 1500, 2000],  // 💰 Willkommens-Punkte (= ABO_BONUS, hier dokumentiert)
};
const aboIdx = (tier) => { const i = ABO_TIERS.indexOf(tier); return i < 0 ? 0 : i; };
// Aktiver Abo-Rang eines Discord-Users — LIVE aus subscriptions.json (höchster gehaltener;
// kein Re-Login nötig). null = kein Abo.
function aboTierFor(discordId) {
  if (!discordId) return null;
  const subs = readJson(`${BOT_DATA_DIR}/subscriptions.json`, {});
  let best = null, bestIdx = 0;
  for (const meta of Object.values(subs)) {
    if (String(meta.discordId) !== String(discordId)) continue;
    const i = aboIdx(meta.tier);
    if (i > bestIdx) { bestIdx = i; best = meta.tier; }
  }
  return best;
}
// Effektiver Perk-Index (0–3): respektiert den Go-Live-Stichtag (vorher → Fossil/0).
function aboPerkIdx(s) {
  const force = liveAboForce(s);   // 🧪 Joe-Test-/Comp-Override + Team → sofort Obsidian (LIVE, kein Stichtag)
  if (force) return aboIdx(force);
  return aboPerksLive() ? aboIdx(aboTierFor(s && s.discordId)) : 0;
}
const garageLimitFor = (s) => ABO_PERKS.garageSlots[aboPerkIdx(s)];
const cooldownMsFor  = (s) => ABO_PERKS.cooldownMin[aboPerkIdx(s)] * 60_000;
const questLimitFor  = (s) => ABO_PERKS.questsPerDay[aboPerkIdx(s)];
const marketLimitFor = (s) => ABO_PERKS.marketSlots[aboPerkIdx(s)];
const skinSlotsFor   = (s) => ABO_PERKS.skinSlots[aboPerkIdx(s)];
const skinFreeFor    = (s) => aboPerkIdx(s) >= 1 || liveBeta(s);   // Skin-Creator gratis ab Knochen ODER mit Beta-Tester-Rolle
// 💰 Skin-Punkt-Kosten — gelten NUR für Free (skinFreeFor=false). Ab Knochen alles gratis.
const SKIN_COSTS = { color: 50, tplSave: 500, tplApply: 250 };   // pro geänderte Farbe · Vorlage speichern · Vorlage anwenden
// Aktive öffentliche Markt-Listings eines Spielers (gemeinsamer Pool gegen marketLimitFor):
// Dino-Markt + Token-Auktionen + Gesuche. Direkt-Tausch (P2P, TTL-begrenzt) zählt NICHT mit.
// (sweep* sind Funktions-Deklarationen → gehoistet, daher hier nutzbar.)
const countMarketListings = (steamId) =>
  sweepMarketplace().filter((o) => o.sellerSteamId === steamId).length
  + sweepAuctions().filter((a) => a.sellerSteamId === steamId).length
  + sweepWants().filter((w) => w.requesterSteamId === steamId).length;

function cooldownRemaining(steamId, action) {
  const store = readJson(COOLDOWNS_FILE, {});
  const until = store[steamId]?.[action] ?? 0;
  return Math.max(0, until - Date.now());
}
// durMs optional → tier-abhängiger Cooldown (s. cooldownMsFor); sonst Action-Default.
function startCooldown(steamId, action, durMs) {
  withFileLock(COOLDOWNS_FILE, () => {
    const store = readJson(COOLDOWNS_FILE, {});
    if (!store[steamId]) store[steamId] = {};
    const dur = Number.isFinite(durMs) ? durMs
      : (action === 'park' ? PARK_COOLDOWN_MS : action === 'swap' ? SWAP_COOLDOWN_MS : UNPACK_COOLDOWN_MS);
    store[steamId][action] = Date.now() + dur;
    writeJsonFile(COOLDOWNS_FILE, store);
  });
}
function fmtCooldown(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? `${m} Min ${String(s).padStart(2, '0')} Sek` : `${s} Sek`;
}

// Swap-Regeln (identisch zum Bot)
const SWAP_COOLDOWN_MS = parseInt(process.env.SWAP_COOLDOWN_MIN ?? '5', 10) * 60_000; // TEST: 5 Min (normal 60)
const SWAP_MIN_HEALTH = 1.0;
const SWAP_MIN_BLOOD = 1.0;
const SWAP_MIN_STAMINA = 0.90;
const SWAP_MIN_DISTANCE_M = 50;
const WORLD_UNITS_PER_M = parseInt(process.env.WORLD_UNITS_PER_M ?? '200', 10);
const baseClass = (c) => (c || '').split('_')[0];
function nearestOtherPlayerM(me, all) {
  let min = Infinity;
  for (const p of all) {
    if (p.steamId === me.steamId || p.isDead) continue;
    const d = Math.hypot(p.location.x - me.location.x, p.location.y - me.location.y) / WORLD_UNITS_PER_M;
    if (d < min) min = d;
  }
  return min;
}
// Spezies-Namen normalisieren (Spielklasse → kanonischer Limit-Name aus DINO_LIMIT_SPECIES).
const SPECIES_ALIAS = { Rex: 'Tyrannosaurus', Maiasaurus: 'Maiasaura' };
const canonSpecies = (dinoClass) => { const b = baseClass(dinoClass); return SPECIES_ALIAS[b] || b; };
// Anti-PvP-Flucht-Gate: voller Dino (100% Health/Blut/Stamina, nicht blutend). Gibt Fehlertext oder null.
function fullDinoGateError(p, action) {
  if (!p) return 'Du musst im Spiel sein (auf einem Dino).';
  if (p.isBleeding) return `${action} nicht möglich: Dein Dino blutet (im Kampf).`;
  if ((p.health ?? 0) < 1) return `${action} nicht möglich: Health muss 100% sein (aktuell ${Math.round((p.health ?? 0) * 100)}%).`;
  if ((p.blood ?? 0) < 1) return `${action} nicht möglich: Blut muss 100% sein (aktuell ${Math.round((p.blood ?? 0) * 100)}%).`;
  if ((p.stamina ?? 0) < 1) return `${action} nicht möglich: Stamina muss 100% sein (aktuell ${Math.round((p.stamina ?? 0) * 100)}%).`;
  return null;
}
// Lebende Anzahl einer (kanonischen) Spezies auf dem Server.
function speciesCount(players, canonSp) {
  return players.filter((p) => p && !p.isDead && canonSpecies(p.dinoClass) === canonSp).length;
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(file, data) {
  // Atomar: temp schreiben + umbenennen (verhindert halb geschriebene garage.json bei Parallelzugriff)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

// ── Cross-Process-File-Lock ────────────────────────────────────────────────
// Bot UND token-service schreiben dieselben Files. Ein temp+rename verhindert nur
// halb geschriebene Dateien, NICHT verlorene Updates (read→ändern→write von 2
// Prozessen). withFileLock kapselt die GANZE read-modify-write-Transaktion über ein
// O_EXCL-Lockfile, das beide Prozesse identisch benutzen. Nur für KURZE, rein lokale
// Transaktionen — NIE über einen await/Netzwerk-Call halten.
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }
function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  const TIMEOUT_MS = 5000, STALE_MS = 15000;
  let fd = null;
  while (true) {
    try { fd = openSync(lock, 'wx'); break; }            // exklusiv anlegen = Lock erhalten
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() - start > TIMEOUT_MS) {              // Notfall: lieber ohne Lock weiter als Operation verlieren
        console.warn(`⚠️ withFileLock Timeout für ${lock} — fahre ohne Lock fort`);
        break;
      }
      sleepSync(12);
    }
  }
  try { return fn(); }
  finally { if (fd !== null) { try { closeSync(fd); } catch {} try { unlinkSync(lock); } catch {} } }
}

// Overlay-Aktivität alle 5s in die geteilte Datei flushen (Bot liest sie für die Overlay-Pflicht)
const OVERLAY_ACTIVE_FILE = `${BOT_DATA_DIR}/overlay_active.json`;
setInterval(() => {
  try {
    const now = Date.now();
    for (const k of Object.keys(overlayActivity)) if (now - overlayActivity[k] > 120_000) delete overlayActivity[k];
    writeJsonFile(OVERLAY_ACTIVE_FILE, overlayActivity);
  } catch {}
}, 5000);
function genId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function sessionFrom(req) {
  const auth = req.headers.authorization ?? '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t) return null;
  let s;
  try { s = jwt.verify(t, SESSION_SECRET); } catch { return null; }
  // Live-Status im Hintergrund frisch halten (fire-and-forget, bei warmem Cache quasi gratis) →
  // Team/Rang/Abo greifen server-seitig ohne Neu-Login. Darf die Auth NIEMALS beeinflussen.
  if (s && s.discordId) { try { getDiscordStatusCached(s.discordId).catch(() => {}); } catch {} }
  return s;
}
// Team = Owner/Admin/Support — darf Admin-Menü + TP/Kalibrierung nutzen.
// (s.staff als Fallback für alte Sessions; FORCE_TEAM_STEAMIDS als harte Garantie.)
const FORCE_TEAM_STEAMIDS = (process.env.FORCE_TEAM_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const FORCE_ADMIN_STEAMIDS = (process.env.FORCE_ADMIN_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function isTeamMember(s) {
  return !!(s && (s.team || s.admin || s.staff || FORCE_TEAM_STEAMIDS.includes(s.steamId)));
}
// Admin = NUR Owner/Admin (volle Config: Beschenken, Dino-Limits, Rollen).
function isAdminMember(s) {
  return !!(s && (s.admin || FORCE_ADMIN_STEAMIDS.includes(s.steamId)));
}
// Ingame = Owner/Admin/Moderator — Ingame-Tools (AI, Lightning, TP, Kalibrierung).
function isIngameMember(s) {
  return !!(s && (s.ingame || s.admin || FORCE_ADMIN_STEAMIDS.includes(s.steamId)));
}

// ── AI-Dinos: Proxy zum control-server (Game-Box), nur Team ──────────────────
const CONTROL_SERVER_URL = process.env.CONTROL_SERVER_URL ?? 'http://100.117.32.93:9100';
const CONTROL_AUTH_TOKEN = process.env.CONTROL_AUTH_TOKEN ?? '';
const AI_ACTION_PATHS = {
  spawn: '/ai/spawn', start: '/ai/start', stop: '/ai/stop',
  despawnall: '/ai/despawnall', killall: '/ai/killall',
  panic: '/ai/panic', disable: '/ai/disable', enable: '/ai/enable',
};
async function controlFetch(path, method = 'POST', body) {
  const r = await fetch(`${CONTROL_SERVER_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${CONTROL_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}
app.get('/admin/ai/status', async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });
  try { const r = await controlFetch('/ai/status', 'GET'); return res.status(r.status).json(r.data); }
  catch (e) { return res.status(502).json({ error: e.message }); }
});
// Gefährliche AI-Aktionen NUR für Admins (Owner/Admin); spawn/start/stop/enable = Moderator+
const AI_ADMIN_ONLY = new Set(['despawnall', 'killall', 'panic', 'disable']);
app.post('/admin/ai/:action', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  const needAdmin = AI_ADMIN_ONLY.has(req.params.action);
  if (needAdmin ? !isAdminMember(s) : !isIngameMember(s))
    return res.status(403).json({ error: needAdmin ? 'Nur für Admins' : 'Nur für Moderatoren+' });
  const path = AI_ACTION_PATHS[req.params.action];
  if (!path) return res.status(400).json({ error: 'Unbekannte Aktion' });
  try {
    const r = await controlFetch(path, 'POST', req.body || {});
    return res.status(r.status).json(r.data);
  } catch (e) { return res.status(502).json({ error: e.message }); }
});
// Spielerliste vom Game-Server — mit kurzem geteiltem Cache (~1s) + In-Flight-Dedup.
// So kollabieren ALLE gleichzeitigen /positions-, /me- und Chat-Polls auf
// höchstens ~1 Game-API-Call pro Sekunde, unabhängig von der Nutzerzahl.
const PLAYERS_TTL = Number(process.env.PLAYERS_CACHE_MS ?? 750);
// Vitals/HP wollen frischer sein (Combat-Stat) → kürzeres Max-Alter beim Abruf.
const VITALS_MAX_AGE = Number(process.env.VITALS_CACHE_MS ?? 300);
let _playersCache = { ts: 0, data: null, inflight: null };
// maxAge = wie alt der Cache höchstens sein darf, sonst frisch holen (In-Flight-Dedup bleibt).
async function fetchPlayers(maxAge = PLAYERS_TTL) {
  const now = Date.now();
  if (_playersCache.data && now - _playersCache.ts < maxAge) return _playersCache.data;
  if (_playersCache.inflight) return _playersCache.inflight;   // laufenden Abruf mitnutzen
  _playersCache.inflight = (async () => {
    try {
      const r = await fetch(`${PANEL_BASE_URL}/players`, {
        headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`Game-Server HTTP ${r.status}`);
      const arr = (await r.json()).Players ?? [];
      _playersCache = { ts: Date.now(), data: arr, inflight: null };
      return arr;
    } catch (e) { _playersCache.inflight = null; throw e; }
  })();
  return _playersCache.inflight;
}

// ── Admin-Verwaltung (NUR Admin): User-Info, Lightning, Beschenken ───────────
function addPoints(steamId, n) {
  return withFileLock(POINTS_FILE, () => {
    const p = readJson(POINTS_FILE, {});
    p[steamId] = Math.max(0, Math.round((p[steamId] ?? 0) + n));
    writeJsonFile(POINTS_FILE, p);
    return p[steamId];
  });
}
// Atomar abbuchen: prüft Guthaben UND zieht ab innerhalb EINES Locks (kein TOCTOU).
// Gibt false zurück, wenn nicht genug Punkte — dann wird nichts geändert.
function spendPoints(steamId, cost) {
  return withFileLock(POINTS_FILE, () => {
    const p = readJson(POINTS_FILE, {});
    const have = p[steamId] ?? 0;
    if (have < cost) return false;
    p[steamId] = Math.max(0, Math.round(have - cost));
    writeJsonFile(POINTS_FILE, p);
    return true;
  });
}
function addToken(steamId, type, n) {
  return withFileLock(INVENTORY_FILE, () => {
    const all = readJson(INVENTORY_FILE, {});
    if (!all[steamId]) all[steamId] = {};
    all[steamId][type] = (all[steamId][type] ?? 0) + n;
    writeJsonFile(INVENTORY_FILE, all);
    return all[steamId][type];
  });
}
async function discordApi(path) {
  const r = await fetch(`https://discord.com/api${path}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Discord ${r.status}`);
  return r.json();
}
let _membersCache = { at: 0, list: null };
async function guildMembers() {
  if (_membersCache.list && Date.now() - _membersCache.at < 60_000) return _membersCache.list;
  const list = await discordApi(`/guilds/${DISCORD_GUILD_ID}/members?limit=1000`);
  _membersCache = { at: Date.now(), list };
  return list;
}

// ── PayPal-Helfer ────────────────────────────────────────────────────────────
async function paypalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`PayPal-Token ${r.status}`);
  return (await r.json()).access_token;
}
// PayPal-Zertifikat (für die Webhook-Signatur) laden + cachen.
const _paypalCertCache = new Map();   // url → { pem, ts }
async function fetchPaypalCert(url) {
  const cached = _paypalCertCache.get(url);
  if (cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000) return cached.pem;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Cert-Download ${r.status}`);
  const pem = await r.text();
  _paypalCertCache.set(url, { pem, ts: Date.now() });
  return pem;
}
// Prüft die Echtheit eines Webhook-Events OFFLINE über die rohen Body-Bytes.
// PayPal signiert `transmissionId|transmissionTime|webhookId|crc32(rawBody)` mit
// SHA256withRSA gegen das Cert aus paypal-cert-url. Die REST-Verify-API scheiterte,
// weil express.json() den Body neu serialisiert → crc32 stimmte nicht mehr.
async function verifyPaypalWebhook(headers, rawBody) {
  try {
    const transmissionId = headers['paypal-transmission-id'];
    const transmissionTime = headers['paypal-transmission-time'];
    const transmissionSig = headers['paypal-transmission-sig'];
    const certUrl = headers['paypal-cert-url'];
    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !PAYPAL_WEBHOOK_ID || !rawBody) return false;
    // cert_url MUSS eine PayPal-Domain sein (gegen SSRF / gefälschte Certs)
    let host;
    try { host = new URL(certUrl).hostname; } catch { return false; }
    if (!/(^|\.)paypal\.com$/i.test(host)) return false;
    const crc = crc32(rawBody) >>> 0;
    const expected = `${transmissionId}|${transmissionTime}|${PAYPAL_WEBHOOK_ID}|${crc}`;
    const pem = await fetchPaypalCert(certUrl);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(expected);
    verifier.end();
    return verifier.verify(pem, transmissionSig, 'base64');
  } catch (e) {
    console.error('PayPal-Webhook-Verify-Fehler:', e.message);
    return false;
  }
}
// Discord-Rolle (per Name) vergeben/entziehen. Bot braucht "Rollen verwalten" + höher als die Rolle.
async function setMemberRole(discordId, roleName, add) {
  const roles = await discordApi(`/guilds/${DISCORD_GUILD_ID}/roles`);
  const role = roles.find((r) => r.name === roleName);
  if (!role) throw new Error(`Rolle nicht gefunden: ${roleName}`);
  const r = await fetch(`https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}/roles/${role.id}`, {
    method: add ? 'PUT' : 'DELETE',
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'X-Audit-Log-Reason': 'BlackFossil PayPal-Abo' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok && r.status !== 204) throw new Error(`Discord Rolle ${add ? 'add' : 'remove'} ${r.status}`);
}

// Willkommens-DM an den Abonnenten (per Bot-Token). Scheitert still, wenn DMs zu sind.
async function sendDiscordDM(discordId, content) {
  try {
    const ch = await fetch('https://discord.com/api/users/@me/channels', {
      method: 'POST', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: discordId }), signal: AbortSignal.timeout(8000),
    });
    if (!ch.ok) return;
    const dm = await ch.json();
    await fetch(`https://discord.com/api/channels/${dm.id}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }), signal: AbortSignal.timeout(8000),
    });
  } catch { /* DMs evtl. gesperrt — ignorieren */ }
}

// Status einer PayPal-Subscription abfragen (für den periodischen Abgleich).
async function paypalGetSubscription(subId) {
  const token = await paypalToken();
  const r = await fetch(`${PAYPAL_API}/v1/billing/subscriptions/${encodeURIComponent(subId)}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  return r.json();
}

// PayPal-Subscription kündigen (für Upgrades: alte Subscription beenden, damit nicht doppelt abgebucht wird).
async function paypalCancelSubscription(subId, reason = 'Upgrade auf höheren Rang') {
  try {
    const token = await paypalToken();
    const r = await fetch(`${PAYPAL_API}/v1/billing/subscriptions/${encodeURIComponent(subId)}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok || r.status === 204;
  } catch { return false; }
}

// Liste aller verknüpften Discord-User (für das Such-Dropdown)
app.get('/admin/users', async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return res.status(503).json({ error: 'Discord nicht konfiguriert' });
  try {
    const accounts = readJson(ACCOUNTS_PATH, {});
    const members = await guildMembers();
    const users = members
      .filter((m) => m.user && accounts[m.user.id])
      .map((m) => ({ discordId: m.user.id, name: m.nick || m.user.global_name || m.user.username, steamId: accounts[m.user.id] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ users });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Liste aller Rollen (für Beschenken an Rolle)
app.get('/admin/roles', async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });   // nur Rollen-Liste fürs Beschenken-Dropdown
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return res.status(503).json({ error: 'Discord nicht konfiguriert' });
  try {
    const roles = await discordApi(`/guilds/${DISCORD_GUILD_ID}/roles`);
    const out = roles
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));
    res.json({ roles: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// User-Info: Punkte, Token, Rang/Rollen, Live-Dino
app.post('/admin/user-info', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });
  const steamId = String(req.body?.steamId || '').trim();
  if (!/^\d{17}$/.test(steamId)) return res.status(400).json({ error: 'Ungültige SteamID' });
  const accounts = readJson(ACCOUNTS_PATH, {});
  const discordId = Object.keys(accounts).find((d) => accounts[d] === steamId) || null;
  let name = null, rank = null, roles = [];
  if (discordId && DISCORD_BOT_TOKEN && DISCORD_GUILD_ID) {
    try {
      const [member, allRoles] = await Promise.all([
        discordApi(`/guilds/${DISCORD_GUILD_ID}/members/${discordId}`),
        discordApi(`/guilds/${DISCORD_GUILD_ID}/roles`),
      ]);
      name = member.nick || member.user?.global_name || member.user?.username || null;
      const mine = new Set(member.roles || []);
      roles = allRoles.filter((r) => mine.has(r.id) && r.name !== '@everyone').map((r) => r.name);
      rank = RANK_ROLES.find((n) => roles.includes(n)) || null;
    } catch {}
  }
  let dino = { online: false };
  try {
    const players = await fetchPlayers();
    const p = players.find((x) => x.steamId === steamId);
    if (p) dino = { online: true, dinoClass: p.dinoClass, gender: p.gender, grow: p.grow, health: p.health, isElder: p.isElder, elderReplicationStacks: p.elderReplicationStacks };
  } catch {}
  res.json({ steamId, discordId, name, rank, roles, points: getPoints(steamId), tokens: getInventory(steamId), dino });
});

// Lightning Strike (Slay) auf den aktiven Ingame-Dino
app.post('/admin/lightning', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });
  const steamId = String(req.body?.steamId || '').trim();
  if (!/^\d{17}$/.test(steamId)) return res.status(400).json({ error: 'Ungültige SteamID' });
  try {
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(steamId)}/lightning`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slay: true }), signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.Msg || d.error || `HTTP ${r.status}` });
    res.json({ ok: true, slayed: !!d.slayed });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Eigenen aktiven Dino töten (Slay) — jeder darf seinen EIGENEN Dino slayen (kein Admin nötig)
app.post('/me/slay', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  try {
    // Leiser Selbst-Tod: Health auf 0 → Dino stirbt OHNE Lightning-Strike (kein lauter Blitz-Sound).
    const r = await fetch(`${PANEL_BASE_URL}/vitals`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(vitalsBody(s.steamId, 'health', 0)), signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.Msg || d.error || `HTTP ${r.status}` });
    res.json({ ok: true, slayed: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Beschenken: Punkte/Token an einen User, eine Rolle oder alle Online
app.post('/admin/gift', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });   // Beschenken ab Moderator
  const { targetKind, targetId, type } = req.body || {};
  const amt = Math.round(Number(req.body?.amount));
  if (!amt || amt < 1) return res.status(400).json({ error: 'Menge ungültig' });
  if (type !== 'points' && !TOKEN_ORDER.includes(type)) return res.status(400).json({ error: 'Typ ungültig' });
  let steamIds = [];
  try {
    if (targetKind === 'user') {
      if (!/^\d{17}$/.test(String(targetId || ''))) return res.status(400).json({ error: 'Ungültige SteamID' });
      steamIds = [String(targetId)];
    } else if (targetKind === 'online') {
      steamIds = (await fetchPlayers()).map((p) => p.steamId).filter(Boolean);
    } else if (targetKind === 'role') {
      const accounts = readJson(ACCOUNTS_PATH, {});
      const members = await guildMembers();
      steamIds = members.filter((m) => (m.roles || []).includes(String(targetId)) && m.user && accounts[m.user.id]).map((m) => accounts[m.user.id]);
    } else {
      return res.status(400).json({ error: 'Ziel ungültig' });
    }
  } catch (e) { return res.status(502).json({ error: e.message }); }
  steamIds = [...new Set(steamIds)];
  if (!steamIds.length) return res.status(400).json({ error: 'Keine Empfänger gefunden' });
  for (const sid of steamIds) {
    if (type === 'points') addPoints(sid, amt); else addToken(sid, type, amt);
  }
  res.json({ ok: true, affected: steamIds.length, type, amount: amt });
});

// ── Dino-Limits (Admin setzt im Overlay, sichtbar für alle + im Discord) ─────
// In BOT_DATA_DIR, damit der Discord-Bot sie direkt lesen kann. {species: maxAnzahl},
// 0/fehlt = unbegrenzt. Wird per syncNyorsClassLimits() nativ in Nyors durchgesetzt
// (Spezies bei Cap aus dem Spawn-Picker entfernt — kein Kill, bestehende Dinos bleiben).
const DINO_LIMITS_FILE = `${BOT_DATA_DIR}/dinolimits.json`;
const DINO_LIMIT_SPECIES = [
  'Tyrannosaurus', 'Allosaurus', 'Carnotaurus', 'Ceratosaurus', 'Dilophosaurus', 'Herrerasaurus',
  'Omniraptor', 'Troodon', 'Pteranodon', 'Deinosuchus', 'Beipiaosaurus', 'Triceratops',
  'Diabloceratops', 'Stegosaurus', 'Tenontosaurus', 'Dryosaurus', 'Hypsilophodon',
  'Pachycephalosaurus', 'Maiasaura', 'Gallimimus',
];
app.get('/dino-limits', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  res.json({ species: DINO_LIMIT_SPECIES, limits: readJson(DINO_LIMITS_FILE, {}) });
});
app.post('/admin/dino-limits', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const incoming = req.body?.limits || {};
  const limits = {};
  for (const sp of DINO_LIMIT_SPECIES) {
    const v = parseInt(incoming[sp], 10);
    if (Number.isFinite(v) && v > 0) limits[sp] = v;   // 0/leer = unbegrenzt → nicht speichern
  }
  writeJsonFile(DINO_LIMITS_FILE, limits);
  syncNyorsClassLimits().catch((e) => console.error('Nyors class-limit sync (admin):', e.message));   // sofort live ziehen
  res.json({ ok: true, limits });
});

// ── STAFF: DINO-TOKEN-TOOLS (geben/bearbeiten/löschen) — Owner/Admin/Support/Moderator ──
// Staff = Team (Owner/Admin/Support) ODER Ingame (Owner/Admin/Moderator).
function isStaffMember(s) { return !!(s && (s.team || s.admin || s.ingame || s.staff || FORCE_TEAM_STEAMIDS.includes(s.steamId))); }
const ZERO = [0, 0, 0];
// Vollständigen Garage-Snapshot bauen (gleiches Format wie der Bot-Support-Builder).
function buildDinoSnapshot(steamId, dinoClass, grow, gender, elderStacks, primes, mutations, label) {
  const snap = {
    steamId, playerName: label || 'Token', dinoClass, gender,
    isDead: false, isBleeding: false, isHatchling: grow < 0.1, isElder: elderStacks > 0, isPrime: (primes || []).length >= 5,
    elderReplicationStacks: elderStacks, location: { x: 0, y: 0, z: 0 },
    health: 100, hunger: 100, thirst: 100, stamina: 100, blood: 100, grow,
    carbs: 100, protein: 100, lipid: 100,
    skinVariation: 0, patternIndex: 0, themeIndex: 0,
    maleDisplayColor: ZERO, markingsColor: ZERO, bodyColor: ZERO, flankColor: ZERO, underbellyColor: ZERO,
    teethColor: ZERO, mouthColor: ZERO, clawsColor: ZERO, detailColor: ZERO, eyesColor: ZERO,
    mutations: padMutations(mutations),
    playerPing: 0, groupId: null, timeOnMenu: 0,
  };
  for (let i = 1; i <= 10; i++) snap[`primeCondition${i}`] = (primes || []).includes(i);
  return snap;
}
function addGarageSlot(steamId, snapshot, label) {
  return withFileLock(GARAGE_FILE, () => {
    const g = readJson(GARAGE_FILE, {});
    const slot = { id: genId(), savedAt: Date.now(), snapshot, ...(label ? { label } : {}) };
    (g[steamId] = g[steamId] || []).push(slot);
    writeJsonFile(GARAGE_FILE, g);
    return slot;
  });
}
// Mutationen defensiv deduplizieren (keine Doppelvergabe über base/parent/elder) + Slot-Caps.
function dedupMutations(m) {
  const seen = new Set();
  const clean = (arr, max) => { const out = []; for (const v of (arr || [])) { if (v && !seen.has(v) && out.length < max) { seen.add(v); out.push(v); } } return out; };
  return { base: clean(m?.base, 4), parent: clean(m?.parent, 4), elder: clean(m?.elder, 8) };
}
// Mutationen auf die von Nyors erwarteten Slot-Zahlen auffüllen (base/parent 4, elder 8;
// leere Slots = null). Sonst lehnt /swap mit "mutations.base must have 4 entries" ab.
function padMutations(m) {
  const pad = (arr, n) => { const src = Array.isArray(arr) ? arr : []; return Array.from({ length: n }, (_, i) => src[i] ?? null); };
  return { base: pad(m?.base, 4), parent: pad(m?.parent, 4), elder: pad(m?.elder, 8) };
}
const cleanPrimes = (arr) => [...new Set((arr || []).map(Number).filter((n) => n >= 1 && n <= 10))];
// Ziel(e) auflösen: einzelner User (Steam/Discord), Rolle (alle verknüpften Member) oder alle Online.
async function resolveDinoTargets(body) {
  const kind = body?.targetKind || 'user';
  if (kind === 'online') { try { return (await fetchPlayers()).map((p) => p.steamId).filter(Boolean); } catch { return []; } }
  if (kind === 'role') {
    const roleId = String(body?.roleId || ''); if (!roleId) return [];
    try {
      const members = await guildMembers();
      const acc = readJson(ACCOUNTS_PATH, {});
      return members.filter((m) => (m.roles || []).includes(roleId) && m.user && acc[m.user.id]).map((m) => String(acc[m.user.id]));
    } catch { return []; }
  }
  if (body?.targetSteamId) return [String(body.targetSteamId)];
  if (body?.targetDiscordId) { const sid = lookupSteamId(String(body.targetDiscordId)); return sid ? [String(sid)] : []; }
  return [];
}

// Config für den Overlay-Builder (Spezies, Diäten, Prime-Labels, Mutationen)
app.get('/admin/dino-token/config', (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  res.json({ species: activeSpecies(), dietBySpecies: DINOS, primeLabels: PRIME_LABELS, mutations: MUTATIONS });
});

// Garage eines Ziels auflisten (für Bearbeiten/Löschen)
app.get('/admin/dino-token/garage', (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  let steamId = req.query.steamId ? String(req.query.steamId) : null;
  if (!steamId && req.query.discordId) steamId = lookupSteamId(String(req.query.discordId));
  if (!steamId) return res.status(400).json({ error: 'Kein Ziel (steamId/discordId).' });
  const slots = (readJson(GARAGE_FILE, {})[steamId] || []).map((sl) => {
    const sn = sl.snapshot || {};
    const primes = []; for (let i = 1; i <= 10; i++) if (sn[`primeCondition${i}`]) primes.push(i);
    return { ...slotCard(sl), label: sl.label ?? null, elderStacks: sn.elderReplicationStacks ?? 0, primes, mutations: sn.mutations ?? { base: [], parent: [], elder: [] } };
  });
  res.json({ steamId, slots });
});

// Dino-Token geben (an User / Rolle→alle / Online→alle)
app.post('/admin/dino-token/create', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const b = req.body || {};
  const dino = baseClass(String(b.dino || ''));
  if (!dino) return res.status(400).json({ error: 'Keine Spezies.' });
  const gender = b.gender === 'Female' ? 'Female' : 'Male';
  const grow = Math.max(0.01, Math.min(1, Number(b.grow) || 0.25));
  const elderStacks = Math.max(0, Math.min(3, parseInt(b.elderStacks, 10) || 0));
  const primes = cleanPrimes(b.primes);
  const mutations = dedupMutations(b.mutations);
  const targets = await resolveDinoTargets(b);
  if (!targets.length) return res.status(404).json({ error: 'Kein gültiges Ziel gefunden.' });
  const label = b.label ? String(b.label).slice(0, 60) : `🎁 ${dino}`;
  for (const sid of targets) {
    try { addGarageSlot(sid, buildDinoSnapshot(sid, dino, grow, gender, elderStacks, primes, mutations, label), label); } catch {}
  }
  res.json({ ok: true, count: targets.length, dino });
});

// Dino-Token bearbeiten (vorhandenen Garage-Slot anpassen)
app.post('/admin/dino-token/edit', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const b = req.body || {};
  const steamId = b.targetSteamId ? String(b.targetSteamId) : (b.targetDiscordId ? lookupSteamId(String(b.targetDiscordId)) : null);
  if (!steamId) return res.status(400).json({ error: 'Kein Ziel.' });
  const upd = withFileLock(GARAGE_FILE, () => {
    const g = readJson(GARAGE_FILE, {});
    const slots = g[steamId] || [];
    const slot = slots.find((x) => x.id === b.slotId);
    if (!slot) return { err: 'Slot nicht gefunden.' };
    const sn = slot.snapshot || {};
    if (b.grow != null) { sn.grow = Math.max(0.01, Math.min(1, Number(b.grow))); sn.isHatchling = sn.grow < 0.1; }
    if (b.gender === 'Male' || b.gender === 'Female') sn.gender = b.gender;
    if (b.elderStacks != null) { sn.elderReplicationStacks = Math.max(0, Math.min(3, parseInt(b.elderStacks, 10) || 0)); sn.isElder = sn.elderReplicationStacks > 0; }
    if (b.primes != null) { const pr = cleanPrimes(b.primes); for (let i = 1; i <= 10; i++) sn[`primeCondition${i}`] = pr.includes(i); sn.isPrime = pr.length >= 5; }
    if (b.mutations != null) sn.mutations = padMutations(dedupMutations(b.mutations));
    slot.snapshot = sn;
    writeJsonFile(GARAGE_FILE, g);
    return { ok: true };
  });
  if (upd.err) return res.status(404).json({ error: upd.err });
  res.json({ ok: true });
});

// Dino-Token löschen
app.post('/admin/dino-token/delete', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const b = req.body || {};
  const steamId = b.targetSteamId ? String(b.targetSteamId) : (b.targetDiscordId ? lookupSteamId(String(b.targetDiscordId)) : null);
  if (!steamId) return res.status(400).json({ error: 'Kein Ziel.' });
  const upd = withFileLock(GARAGE_FILE, () => {
    const g = readJson(GARAGE_FILE, {});
    const slots = g[steamId] || [];
    if (!slots.find((x) => x.id === b.slotId)) return { err: 'Slot nicht gefunden.' };
    g[steamId] = slots.filter((x) => x.id !== b.slotId);
    writeJsonFile(GARAGE_FILE, g);
    return { ok: true };
  });
  if (upd.err) return res.status(404).json({ error: upd.err });
  res.json({ ok: true });
});

// ── ADMIN: ACCOUNT-VERWALTUNG (Discord↔Steam Link / Find / Dupes) ────────────
async function discordNameMap() {
  try { const m = await guildMembers(); const map = {}; for (const x of m) if (x.user) map[x.user.id] = x.nick || x.user.global_name || x.user.username; return map; } catch { return {}; }
}
// Duplikate: SteamIDs an >1 Discord-Account
app.get('/admin/accounts/dups', async (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const acc = readJson(ACCOUNTS_PATH, {});
  const bySteam = {};
  for (const [d, sid] of Object.entries(acc)) (bySteam[String(sid)] = bySteam[String(sid)] || []).push(d);
  const names = await discordNameMap();
  const dups = Object.entries(bySteam).filter(([, ds]) => ds.length > 1).map(([sid, ds]) => ({ steamId: sid, accounts: ds.map((d) => ({ discordId: d, name: names[d] || null })) }));
  res.json({ dups });
});
// Verknüpfung suchen (per Discord- oder Steam-ID)
app.get('/admin/accounts/find', async (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const acc = readJson(ACCOUNTS_PATH, {});
  const names = await discordNameMap();
  const did = req.query.discordId ? String(req.query.discordId).trim() : null;
  const sid = req.query.steamId ? String(req.query.steamId).trim() : null;
  if (did) return res.json({ query: 'discord', results: acc[did] ? [{ discordId: did, steamId: String(acc[did]), name: names[did] || null }] : [] });
  if (sid) return res.json({ query: 'steam', results: Object.keys(acc).filter((d) => String(acc[d]) === sid).map((d) => ({ discordId: d, steamId: sid, name: names[d] || null })) });
  res.status(400).json({ error: 'Discord- oder Steam-ID angeben.' });
});
// Verknüpfung setzen/überschreiben
app.post('/admin/accounts/link', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const did = String(req.body?.discordId || '').trim(), sid = String(req.body?.steamId || '').trim();
  if (!/^\d{5,25}$/.test(did)) return res.status(400).json({ error: 'Ungültige Discord-ID.' });
  if (!/^7656119\d{10}$/.test(sid)) return res.status(400).json({ error: 'Ungültige SteamID64 (muss mit 7656119 beginnen, 17 Ziffern).' });
  const out = withFileLock(ACCOUNTS_PATH, () => {
    const acc = readJson(ACCOUNTS_PATH, {});
    const prev = acc[did] ? String(acc[did]) : null;
    const dupOf = Object.keys(acc).filter((d) => d !== did && String(acc[d]) === sid);
    acc[did] = sid; writeJsonFile(ACCOUNTS_PATH, acc);
    return { prev, dupOf };
  });
  res.json({ ok: true, previous: out.prev, alsoLinkedTo: out.dupOf });
});
// Verknüpfung löschen
app.post('/admin/accounts/unlink', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const did = String(req.body?.discordId || '').trim();
  if (!did) return res.status(400).json({ error: 'Keine Discord-ID.' });
  const existed = withFileLock(ACCOUNTS_PATH, () => {
    const acc = readJson(ACCOUNTS_PATH, {});
    if (!(did in acc)) return false;
    delete acc[did]; writeJsonFile(ACCOUNTS_PATH, acc);
    return true;
  });
  if (!existed) return res.status(404).json({ error: 'Keine Verknüpfung für diese Discord-ID.' });
  res.json({ ok: true });
});

// ── STAFF: PvP-BUILDS verteilen/einsammeln + PRIME auf aktiven Dino ──────────
app.get('/admin/pvp/config', (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  res.json({ builds: PVP_BUILDS.map((b) => ({ key: b.key, label: b.label, dinoClass: b.dinoClass, blurb: b.blurb })), primeLabels: PRIME_LABELS });
});

// PvP-Build verteilen (an User / Rolle→alle / Online→alle)
app.post('/admin/pvp/grant', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const build = getPvpBuild(String(req.body?.buildKey || ''));
  if (!build) return res.status(400).json({ error: 'Unbekannter Build.' });
  const targets = await resolveDinoTargets(req.body || {});
  if (!targets.length) return res.status(404).json({ error: 'Kein gültiges Ziel gefunden.' });
  const label = `${PVP_LABEL_PREFIX} · ${build.dinoClass}`;
  const allPrimes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const sid of targets) {
    try { addGarageSlot(sid, buildDinoSnapshot(sid, build.dinoClass, 1, 'Male', 3, allPrimes, build.mutations, label), label); } catch {}
  }
  res.json({ ok: true, count: targets.length, dino: build.dinoClass });
});

// PvP-Builds wieder einsammeln (alle Slots mit dem PvP-Label-Marker entfernen)
app.post('/admin/pvp/remove', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const targets = await resolveDinoTargets(req.body || {});
  if (!targets.length) return res.status(404).json({ error: 'Kein gültiges Ziel gefunden.' });
  let removed = 0;
  for (const sid of targets) {
    try {
      withFileLock(GARAGE_FILE, () => {
        const g = readJson(GARAGE_FILE, {});
        const slots = g[sid] || [];
        const keep = slots.filter((x) => !String(x.label || '').startsWith(PVP_LABEL_PREFIX));
        removed += slots.length - keep.length;
        g[sid] = keep;
        writeJsonFile(GARAGE_FILE, g);
      });
    } catch {}
  }
  res.json({ ok: true, removed });
});

// Prime Conditions LIVE auf den aktiven Ingame-Dino setzen (Nyors /elder)
app.post('/admin/prime', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const b = req.body || {};
  const steamId = b.targetSteamId ? String(b.targetSteamId) : (b.targetDiscordId ? lookupSteamId(String(b.targetDiscordId)) : null);
  if (!steamId) return res.status(400).json({ error: 'Kein Ziel.' });
  const primes = cleanPrimes(b.primes);
  // Muss ingame sein — wirkt auf den aktiven Dino, nicht auf einen Token.
  let cur; try { cur = (await fetchPlayers()).find((p) => p.steamId === steamId); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!cur || cur.isDead) return res.status(409).json({ error: 'Spieler ist nicht (lebend) ingame — Prime geht nur auf den aktiven Dino.' });
  const body = {};
  for (let i = 1; i <= 10; i++) body[`primeCondition${i}`] = primes.includes(i);
  try {
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(steamId)}/elder`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.Msg || d.error || `HTTP ${r.status}` });
    res.json({ ok: true, dino: cur.dinoClass, count: primes.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── STAFF/ADMIN: Announce + Server-Steuerung (über control-server) ───────────
app.post('/admin/server/announce', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Nachricht fehlt.' });
  try { const r = await controlFetch('/announce', 'POST', { message }); return res.status(r.status).json(r.data); }
  catch (e) { return res.status(502).json({ error: e.message }); }
});
app.get('/admin/server/status', async (req, res) => {
  const s = sessionFrom(req);
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  try { const r = await controlFetch('/status', 'GET'); return res.status(r.status).json(r.data); }
  catch (e) { return res.status(502).json({ error: e.message }); }
});
app.post('/admin/server/wipecorpses', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isIngameMember(s)) return res.status(403).json({ error: 'Nur für Moderatoren+' });
  try { const r = await controlFetch('/wipecorpses', 'POST', {}); return res.status(r.status).json(r.data); }
  catch (e) { return res.status(502).json({ error: e.message }); }
});
const SERVER_CTL_ACTIONS = new Set(['start', 'stop', 'restart']);
app.post('/admin/server/control', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });   // Start/Stop/Restart = gefährlich
  const action = String(req.body?.action || '');
  if (!SERVER_CTL_ACTIONS.has(action)) return res.status(400).json({ error: 'Unbekannte Aktion.' });
  try { const r = await controlFetch('/' + action, 'POST', {}); return res.status(r.status).json(r.data); }
  catch (e) { return res.status(502).json({ error: e.message }); }
});

// Darf ein Staff-Mitglied ein OFFENES (noch nicht angenommenes) Ticket in seiner
// Liste sehen?  Regel (Hideki): nicht an eine Rolle übergeben → alle im Team sehen es;
// an eine Rolle übergeben → nur, wenn die Rolle dem eigenen Rang oder niedriger entspricht.
// (Zugewiesene Tickets laufen separat über claimedBy === discordId.)
function staffCanSeeOpenTicket(s, m) {
  if (!m.forwardedRole) return true;                       // nicht an eine Rolle übergeben → alle
  const tIdx = RANK_ROLES.indexOf(m.forwardedRole);
  if (tIdx === -1) return true;                            // Rolle außerhalb der Rang-Leiter (z.B. Joe) → nicht gaten
  const myIdx = RANK_ROLES.indexOf(s.rank);
  if (myIdx === -1) return false;                          // kein bekannter Rang → keine offenen Rollen-Tickets
  return tIdx >= myIdx;                                    // Ticket-Rang = eigener Rang oder niedriger
}

// Eigene Support-Tickets (Status, Bearbeiter, neue-Nachricht-Flag) fürs Overlay
app.get('/me/tickets', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const all = readJson(`${BOT_DATA_DIR}/tickets.json`, {});
  const staff = isStaffMember(s);
  // Eigene (Ersteller) + von mir bearbeitete + (für Staff) offene Tickets meines Rangs/niedriger bzw. nicht an Rolle übergeben
  const mine = Object.entries(all).filter(([, m]) => m && (m.openerId === s.discordId || m.claimedBy === s.discordId || (staff && !m.claimedBy && staffCanSeeOpenTicket(s, m))));
  let nameOf = () => null;
  try {
    if (DISCORD_BOT_TOKEN && DISCORD_GUILD_ID && mine.some(([, m]) => m.claimedBy)) {
      const members = await guildMembers();
      const map = new Map(members.filter((x) => x.user).map((x) => [x.user.id, x.nick || x.user.global_name || x.user.username]));
      nameOf = (id) => map.get(id) || null;
    }
  } catch {}
  const tickets = mine.map(([channelId, m]) => ({
    channelId,
    ticketId: m.ticketId,
    category: m.category,
    status: m.claimedBy ? 'in_bearbeitung' : 'offen',
    handler: m.claimedBy ? nameOf(m.claimedBy) : null,
    // Rolle aus meiner Sicht: opener (selbst eröffnet) · handler (ich bearbeite) · available (offen, übernehmbar)
    role: m.openerId === s.discordId ? 'opener' : (m.claimedBy === s.discordId ? 'handler' : 'available'),
    openerName: m.openerTag || null,
    createdAt: m.createdAt,
    lastMessageAt: m.lastMessageAt || m.createdAt || 0,
    lastFromOther: m.lastMessageBy ? m.lastMessageBy !== s.discordId : false,
  })).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  res.json({ tickets });
});

// Echte Channel-Nachrichten eines Tickets (für das Chat-Fenster im Overlay-Profil).
// Autorisiert für den Ersteller ODER den bearbeitenden Team-Member. Bot-Nachrichten
// (Embeds/Systemmeldungen) werden ausgeblendet — nur die echte Konversation.
app.get('/me/ticket-messages', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const channelId = String(req.query.channelId || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channelId fehlt' });
  const all = readJson(`${BOT_DATA_DIR}/tickets.json`, {});
  const m = all[channelId];
  if (!m) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  if (m.openerId !== s.discordId && m.claimedBy !== s.discordId) return res.status(403).json({ error: 'Kein Zugriff' });
  if (!DISCORD_BOT_TOKEN) return res.status(503).json({ error: 'Discord nicht konfiguriert' });
  try {
    const raw = await discordApi(`/channels/${channelId}/messages?limit=50`);
    const messages = (Array.isArray(raw) ? raw : [])
      .filter((x) => x && x.author && (x.content || (Array.isArray(x.attachments) && x.attachments.length) || (Array.isArray(x.embeds) && x.embeds.length)))
      .reverse()                                                   // Discord liefert neueste zuerst → chronologisch
      .map((x) => {
        const embedTxt = (Array.isArray(x.embeds) ? x.embeds : []).map((e) => [e.title, e.description].filter(Boolean).join(' — ')).filter(Boolean).join(' · ');
        let content = (x.content || embedTxt) || '';
        let author = x.author.bot ? (x.author.global_name || x.author.username || 'Bot') : ((x.member && x.member.nick) || x.author.global_name || x.author.username || '?');
        let fromBot = !!x.author.bot;
        let fromMe = x.author.id === s.discordId;
        // Overlay-relayte Nachrichten kommen als Bot-Message „**Name:** Text" → als menschliche Nachricht darstellen
        const rel = fromBot ? content.match(/^\*\*(.+?):\*\*\s([\s\S]*)$/) : null;
        if (rel) { author = rel[1]; content = rel[2]; fromBot = false; fromMe = rel[1] === (s.name || ''); }
        return {
          id: x.id, author, fromMe, fromBot,
          content: content.slice(0, 600),
          hasAttachment: Array.isArray(x.attachments) && x.attachments.length > 0,
          at: x.timestamp ? Date.parse(x.timestamp) : 0,
        };
      });
    res.json({ ticketId: m.ticketId, category: m.category, messages });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Ticket: Schreiben / Öffnen / Team-Aktionen (Overlay-Support-Panel) ───────
const TICKET_REQ_FILE = `${BOT_DATA_DIR}/ticket_requests.json`;
const TICKETS_PATH = `${BOT_DATA_DIR}/tickets.json`;
const TICKET_OPEN_CATS = [
  { id: 'help',   label: 'Frage / Hilfe',  emoji: '❓' },
  { id: 'report', label: 'Spieler melden', emoji: '🚨' },
];
function queueTicketRequest(req) {
  withFileLock(TICKET_REQ_FILE, () => { const all = readJson(TICKET_REQ_FILE, []); all.push({ id: genId(), ts: Date.now(), ...req }); writeJsonFile(TICKET_REQ_FILE, all); });
}
const ticketAccess = (s, m) => !!(m && (m.openerId === s.discordId || m.claimedBy === s.discordId || isStaffMember(s)));

// Config fürs Support-Panel (öffenbare Kategorien, Staff-Flag, Weiterleit-Ziele)
app.get('/me/ticket-config', async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const staff = isStaffMember(s);
  const out = { categories: TICKET_OPEN_CATS, isStaff: staff };
  if (staff) {
    try { const roles = await discordApi(`/guilds/${DISCORD_GUILD_ID}/roles`); out.roles = roles.filter((r) => r.name !== '@everyone' && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name })); } catch { out.roles = []; }
    try { const acc = readJson(ACCOUNTS_PATH, {}); const names = await discordNameMap(); out.users = Object.keys(acc).map((d) => ({ discordId: d, name: names[d] || d })).sort((a, b) => String(a.name).localeCompare(String(b.name))); } catch { out.users = []; }
  }
  res.json(out);
});

// Nachricht in ein Ticket schreiben → postet „**Name:** Text" in den Discord-Channel
app.post('/me/ticket-send', express.json(), async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const channelId = String(req.body?.channelId || '').trim();
  const message = String(req.body?.message || '').trim();
  if (!channelId || !message) return res.status(400).json({ error: 'channelId/message fehlt' });
  const m = readJson(TICKETS_PATH, {})[channelId];
  if (!m) return res.status(404).json({ error: 'Ticket nicht gefunden' });
  if (!ticketAccess(s, m)) return res.status(403).json({ error: 'Kein Zugriff' });
  if (!DISCORD_BOT_TOKEN) return res.status(503).json({ error: 'Discord nicht konfiguriert' });
  try {
    const r = await fetch(`https://discord.com/api/channels/${channelId}/messages`, {
      method: 'POST', headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `**${(s.name || 'Spieler').slice(0, 40)}:** ${message.slice(0, 1500)}`, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Discord ${r.status}`);
    withFileLock(TICKETS_PATH, () => { const t = readJson(TICKETS_PATH, {}); if (t[channelId]) { t[channelId].lastMessageAt = Date.now(); t[channelId].lastMessageBy = s.discordId; writeJsonFile(TICKETS_PATH, t); } });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Neues Ticket öffnen (help / report) — Channel-Erstellung macht der Bot-Job
app.post('/me/ticket-open', express.json(), (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const category = String(req.body?.category || '');
  if (!TICKET_OPEN_CATS.some((c) => c.id === category)) return res.status(400).json({ error: 'Ungültige Kategorie.' });
  const desc = String(req.body?.message || '').trim().slice(0, 1500);
  if (!desc) return res.status(400).json({ error: 'Bitte beschreibe dein Anliegen.' });
  let message = desc;
  if (category === 'report') {
    const known = !!req.body?.reportKnown;
    const target = String(req.body?.reportTarget || '').trim().slice(0, 100);
    message = known ? `🚨 **Spieler melden** — Gemeldeter Spieler: **${target || '—'}**\n\n${desc}`
                    : `🚨 **Spieler melden** — Spieler **unbekannt**\n\n${desc}`;
  }
  const all = readJson(TICKETS_PATH, {});
  if (Object.values(all).some((m) => m.openerId === s.discordId && m.category === category)) {
    return res.status(409).json({ error: `Du hast bereits ein offenes ${category === 'help' ? 'Hilfe' : 'Melde'}-Ticket.` });
  }
  queueTicketRequest({ type: 'open', discordId: s.discordId, openerTag: s.name || 'Spieler', category, message });
  res.json({ ok: true, queued: true });
});

// Team: annehmen / weiterleiten / schließen — verarbeitet der Bot-Job
app.post('/me/ticket-claim', express.json(), (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const channelId = String(req.body?.channelId || '').trim();
  if (!channelId) return res.status(400).json({ error: 'channelId fehlt' });
  queueTicketRequest({ type: 'claim', discordId: s.discordId, channelId });
  res.json({ ok: true, queued: true });
});
app.post('/me/ticket-forward', express.json(), (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const channelId = String(req.body?.channelId || '').trim();
  const targetType = req.body?.targetType === 'user' ? 'user' : 'role';
  const targetId = String(req.body?.targetId || '').trim();
  if (!channelId || !targetId) return res.status(400).json({ error: 'channelId/targetId fehlt' });
  queueTicketRequest({ type: 'forward', discordId: s.discordId, channelId, targetType, targetId });
  res.json({ ok: true, queued: true });
});
app.post('/me/ticket-close', express.json(), (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isStaffMember(s)) return res.status(403).json({ error: 'Nur für Staff' });
  const channelId = String(req.body?.channelId || '').trim();
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (!channelId || !reason) return res.status(400).json({ error: 'channelId/Grund fehlt' });
  queueTicketRequest({ type: 'close', discordId: s.discordId, channelId, reason });
  res.json({ ok: true, queued: true });
});

// ── RP-Quests (BF-Challenge): Dino + Handicap + Kleinigkeit + RP-Rolle ───────
// Erfüllt, wenn man mit dem gerollten Dino Prime erreicht UND ≥80% Wachstum hat.
// Insta-Grow zählt NICHT (setzt grow auf 80% → würde sonst sofort erfüllen) → voidet die Quest.
// Limit: 2 Rolls/Tag, 1 aktive Quest gleichzeitig (kein Reroll der laufenden Quest).
const QUESTS_FILE = process.env.QUESTS_FILE ?? '/opt/token-service/quests.json';
const QUEST_DAILY_LIMIT = 2;
const QUEST_GROW_TARGET = 0.8;
const QUEST_REWARD_POINTS = parseInt(process.env.QUEST_REWARD_POINTS ?? '250');   // Belohnung pro erfüllter RP-Quest
// Dino-Roster (key = Spielklasse via baseClass). Bei Bedarf an den Server anpassen.
const QUEST_DINOS = [
  { key: 'Tyrannosaurus', name: 'Tyrannosaurus', diet: 'carni' },
  { key: 'Allosaurus', name: 'Allosaurus', diet: 'carni' },
  { key: 'Carnotaurus', name: 'Carnotaurus', diet: 'carni' },
  { key: 'Ceratosaurus', name: 'Ceratosaurus', diet: 'carni' },
  { key: 'Dilophosaurus', name: 'Dilophosaurus', diet: 'carni' },
  { key: 'Herrerasaurus', name: 'Herrerasaurus', diet: 'carni' },
  { key: 'Omniraptor', name: 'Omniraptor', diet: 'carni' },
  { key: 'Troodon', name: 'Troodon', diet: 'carni' },
  { key: 'Pteranodon', name: 'Pteranodon', diet: 'carni' },
  { key: 'Deinosuchus', name: 'Deinosuchus', diet: 'carni' },
  { key: 'Beipiaosaurus', name: 'Beipiaosaurus', diet: 'omni' },
  { key: 'Triceratops', name: 'Triceratops', diet: 'herbi' },
  { key: 'Diabloceratops', name: 'Diabloceratops', diet: 'herbi' },
  { key: 'Stegosaurus', name: 'Stegosaurus', diet: 'herbi' },
  { key: 'Tenontosaurus', name: 'Tenontosaurus', diet: 'herbi' },
  { key: 'Dryosaurus', name: 'Dryosaurus', diet: 'herbi' },
  { key: 'Hypsilophodon', name: 'Hypsilophodon', diet: 'herbi' },
  { key: 'Pachycephalosaurus', name: 'Pachycephalosaurus', diet: 'herbi' },
  { key: 'Maiasaura', name: 'Maiasaura', diet: 'herbi' },
  { key: 'Gallimimus', name: 'Gallimimus', diet: 'herbi' },
];
const QUEST_HANDICAPS = [
  'Durstlimit: Du darfst erst trinken, wenn dein Durst unter 35% fällt.',
  'Hungerlimit: Du darfst erst fressen, wenn dein Hunger unter 30% fällt.',
  'Einzelgänger: Du darfst keiner Gruppe beitreten.',
  'Nachtaktiv: Bewege dich nur bei Nacht — tagsüber wird gerastet.',
  'Wasserscheu: Meide tiefes Wasser, wo immer es geht.',
  'Pazifist: Greife nie zuerst an — nur Selbstverteidigung.',
  'Kein Sprint: Du darfst nicht sprinten (außer in echter Lebensgefahr).',
  'Standorttreu: Verlasse deine Startregion nicht.',
  'Stummer Jäger: Keine Calls/Brüllen.',
  'Dauerläufer: Bleib stets in Bewegung — kein langes Rasten.',
  'Angsthase: Flieh vor jedem größeren Dino.',
  'Revierfürst: Verteidige dein Leben lang genau einen Ort.',
  'Minimalist: Nutze keine Token.',
  'Schmerzempfindlich: Unter 50% HP sofort zurückziehen.',
  'Sparflamme: Halte deine Stamina immer über 50%.',
  'Wanderer: Erreiche jeden Tag eine neue Region.',
  'Kein Nesten: Du darfst in diesem Leben nicht nesten.',
  'Höhlenmensch: Raste nur in Deckung (Höhlen/Büsche).',
  'Vorsichtig: Offene Flächen nur langsam/geduckt überqueren.',
  'Hungerkünstler: Iss pro Tag nur einmal richtig satt.',
  'Schattenläufer: Meide offenes Gelände bei Tag.',
  'Aas-Eid (Carni): Nur Aas fressen, keine lebende Beute reißen.',
  'Treuer Schatten: Bleib in Sichtweite eines Begleiters (wenn erlaubt).',
  'Salzwasser-Fan: Trinke nur an Küsten/Seen, nicht an Flüssen.',
  'Frühaufsteher: Schlafe nie länger als nötig.',
  'Markierer: Hinterlasse an jedem Rastplatz eine Spur (RP).',
  'Tagträumer: Raste sichtbar mindestens 1× pro Stunde.',
  'Eigenbrötler: Im Voice nur in deiner RP-Rolle sprechen.',
  'Grenzgänger: Bleib immer in der Nähe einer Zonengrenze.',
  'Sammler: Besuche pro Tag mindestens 3 markante Orte.',
];
const QUEST_RP_ROLES = [
  'Der Stammesälteste — ruhig, langsam, als hättest du die Insel ewig überlebt.',
  'Der nervöse Späher — redet schnell und sieht überall Gefahr.',
  'Der großspurige Angeber — übertreibt jede Heldentat.',
  'Der weise Eremit — spricht in Rätseln und Sprichwörtern.',
  'Der ewige Optimist — immer gut gelaunt, alles wird gut.',
  'Der grummelige Veteran — meckert über die „Jugend von heute".',
  'Der adelige Snob — hält sich für etwas Besseres.',
  'Der schüchterne Neuling — traut sich kaum etwas zu.',
  'Der Verschwörungstheoretiker — die Admins beobachten uns alle.',
  'Der Poet — beschreibt die Insel in Versen.',
  'Der Marktschreier — preist alles an wie auf dem Basar.',
  'Der Ritter — Ehre, Eid und edle Worte.',
  'Der Pirat — „Arrr!", Seemannsgarn, gierig nach Beute.',
  'Der Hippie — Frieden, Liebe, alle sind Freunde.',
  'Der Detektiv — analysiert jede Spur laut.',
  'Die Tratschtante — verbreitet Gerüchte über andere Dinos.',
  'Der Stoiker — nichts bringt dich aus der Ruhe.',
  'Die Drama-Queen — alles ist eine Katastrophe.',
  'Der Coach — feuert ständig alle motivierend an.',
  'Der Geizhals — zählt jeden Bissen, teilt nie.',
  'Der Fremdenführer — erklärt ungefragt die Sehenswürdigkeiten.',
  'Der Wahrsager — sagt düstere Zukunft voraus.',
  'Der Gentleman — höflich, zuvorkommend, altmodisch.',
  'Der Punk — gegen jede Regel, rebellisch.',
  'Der Wissenschaftler — kommentiert alles sachlich-nüchtern.',
  'Der Barde — besingt jede seiner Taten.',
  'Der Feigling, der den Helden spielt — prahlt, flieht aber zuerst.',
  'Der überfürsorgliche Elternteil — sorgt sich um alle.',
  'Der einsame Wolf mit Herz — wirkt hart, ist aber gutmütig.',
  'Der Kriegsveteran — erzählt von „der großen Migration".',
];
const QUEST_KLEINIGKEITEN = [
  'Benenne dich nach einem Käse.',
  'Erfinde einen Schlachtruf und nutze ihn vor jedem Kampf.',
  'Gib jedem Gruppenmitglied einen Spitznamen.',
  'Begrüße jeden fremden Dino mit einem kleinen „Tanz".',
  'Hab eine irrationale Angst vor einer bestimmten Spezies.',
  'Du hasst Regen und beschwerst dich lautstark darüber.',
  'Behaupte, du seist eigentlich ein ganz anderer Dino.',
  'Sprich nur im Flüsterton (leiser Voice).',
  'Kommentiere jeden Sonnenaufgang.',
  'Erkläre jede Wasserstelle zu deinem „Königreich".',
  'Verbeuge dich vor jedem größeren Dino.',
  'Führe ein imaginäres Haustier mit dir (RP).',
  'Zähle bei langen Wegen laut deine Schritte.',
  'Jeder Kill braucht eine dramatische „letzte Worte"-Rede.',
  'Sammle „Schätze" — raste an besonders markanten Felsen.',
];
const questPick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function questDayKey() { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`; }
function questFor(steamId) {
  const all = readJson(QUESTS_FILE, {});
  let q = all[steamId] || { dayKey: questDayKey(), rollsToday: 0, active: null, done: [] };
  if (q.dayKey !== questDayKey()) { q.dayKey = questDayKey(); q.rollsToday = 0; }   // täglicher Reset
  return { all, q };
}
app.get('/me/quest', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const { all, q } = questFor(s.steamId);
  let justCompleted = false, progress = null;
  if (q.active && q.active.status === 'active') {
    try {
      const p = (await fetchPlayers()).find((x) => x.steamId === s.steamId);
      const grace = Date.now() - (q.active.startedAt || 0) < 20000;   // 20s Anlauf, bis Dino aufgespielt ist
      if (!p) {
        progress = { online: false };
      } else if (p.isDead) {
        if (!grace) q.active.status = 'failed';        // als Quest-Dino gestorben → Fehlschlag
        progress = { online: true, dead: true };
      } else {
        const rightDino = baseClass(p.dinoClass) === q.active.dino;
        progress = { online: true, dino: baseClass(p.dinoClass), grow: p.grow ?? 0, isPrime: !!p.isPrime, rightDino };
        if (!rightDino) {
          if (!grace) q.active.status = 'failed';      // Dino gewechselt/neu gespawnt → Fehlschlag
        } else if (!q.active.instaUsed && (p.grow ?? 0) >= QUEST_GROW_TARGET && p.isPrime && Date.now() - (q.active.startedAt || 0) > 30000) {
          // 30s-Grace: direkt nach dem Start ist der Dino kurz noch auf 100% (bis grow→25% greift)
          q.active.status = 'done'; q.active.completedAt = Date.now(); q.active.reward = QUEST_REWARD_POINTS;
          addPoints(s.steamId, QUEST_REWARD_POINTS);     // Belohnung gutschreiben
          q.done = q.done || []; q.done.push(q.active); q.active = null; justCompleted = true;
        }
      }
    } catch {}
  }
  all[s.steamId] = q; writeJsonFile(QUESTS_FILE, all);
  res.json({ dayKey: q.dayKey, rollsToday: q.rollsToday, dailyLimit: questLimitFor(s), growTarget: QUEST_GROW_TARGET, reward: QUEST_REWARD_POINTS, active: q.active, doneCount: (q.done || []).length, justCompleted, progress });
});
app.post('/me/quest/roll', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const type = String(req.body?.type ?? 'rp');
  if (type !== 'rp') return res.status(400).json({ error: 'Diese Quest-Art kommt bald.' });
  const { all, q } = questFor(s.steamId);
  if (q.active) return res.status(409).json({ error: 'Du hast bereits eine Quest — erst abschließen oder aufgeben.' });
  const qLimit = questLimitFor(s);
  if (q.rollsToday >= qLimit) return res.status(429).json({ error: `Tageslimit erreicht (${qLimit} pro Tag).` });
  const dino = questPick(QUEST_DINOS);
  q.active = {
    id: `${Date.now()}-${Math.floor(Math.random() * 1e4)}`, type: 'rp',
    dino: dino.key, dinoName: dino.name, diet: dino.diet,
    handicap: questPick(QUEST_HANDICAPS), kleinigkeit: questPick(QUEST_KLEINIGKEITEN), rpRole: questPick(QUEST_RP_ROLES),
    rolledAt: Date.now(), status: 'rolled', instaUsed: false,   // gerollt, aber noch NICHT gestartet
  };
  q.rollsToday += 1;
  all[s.steamId] = q; writeJsonFile(QUESTS_FILE, all);
  res.json({ active: q.active, rollsToday: q.rollsToday, dailyLimit: questLimitFor(s) });
});
// Quest STARTEN (auch Neustart nach Fehlschlag): aktuellen Dino einparken + als
// Quest-Dino-Juvi (25%, zufälliges Geschlecht) aufspielen. So beginnt das Tracking sauber.
app.post('/me/quest/start', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const { all, q } = questFor(s.steamId);
  if (!q.active || !['rolled', 'failed'].includes(q.active.status)) return res.status(409).json({ error: 'Keine startbare Quest.' });
  let players; try { players = await fetchPlayers(); } catch (e) { return res.status(502).json({ error: e.message }); }
  const current = players.find((p) => p.steamId === s.steamId);
  if (!current || current.isDead) return res.status(409).json({ error: 'Du musst lebend im Spiel auf einem Dino sein.' });
  // 1) Aktuellen Dino sichern — NUR beim ersten Start (status 'rolled') und nur,
  //    wenn es nicht ohnehin schon der Quest-Dino ist. Beim Neustart nach Tod wird
  //    NICHT geparkt (sonst sammeln sich Dutzende Quest-Dinos in der Garage an).
  if (q.active.status === 'rolled' && baseClass(current.dinoClass) !== q.active.dino) {
    try {
      const garage = readJson(GARAGE_FILE, {});
      garage[s.steamId] = [...(garage[s.steamId] || []), { id: genId(), savedAt: Date.now(), snapshot: current, fromQuest: true }];
      writeJsonFile(GARAGE_FILE, garage);
    } catch {}
  }
  // 2) Quest-Dino als Juvi (25%) mit zufälligem Geschlecht aufspielen
  const gender = Math.random() < 0.5 ? 'Male' : 'Female';
  const sid = encodeURIComponent(s.steamId);
  try {
    // Vollständigen Snapshot (sonst „health missing"): aktuellen Spieler spreaden,
    // dann Klasse/Geschlecht/Wachstum überschreiben + Vitals auf voll (frischer Juvi).
    // WICHTIG (Anti-Dupe): die Genetik des geparkten Dinos NICHT übernehmen — sonst bekäme
    // der Quest-Juvi dessen Mutationen + Prime/Elder-Bedingungen und man könnte Dinos duplizieren.
    const cleanGenes = { mutations: padMutations(null), isPrime: false, isElder: false, elderReplicationStacks: 0 };
    for (let i = 1; i <= 10; i++) cleanGenes[`primeCondition${i}`] = false;
    const swapBody = {
      ...current, class: q.active.dino, dinoClass: q.active.dino, gender,
      grow: 0.25, growth: 0.25, health: 1, stamina: 1, hunger: 1, thirst: 1, blood: 1, keepLocation: true,
      ...cleanGenes,
    };
    const sr = await fetch(`${PANEL_BASE_URL}/players/${sid}/swap`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody),
      signal: AbortSignal.timeout(15000),
    });
    if (!sr.ok) { let d = `HTTP ${sr.status}`; try { const e = await sr.json(); d = e.message ?? e.error ?? e.Msg ?? d; } catch {} throw new Error(d); }
    // Swap ist ASYNCHRON (Dino spawnt ~1–3 s später) und ignoriert das grow-Feld.
    // Deshalb das Wachstum NACH dem Spawn auf 25% setzen — mit kurzer Wartezeit + 1 Retry.
    const setGrow = async () => { try { await fetch(`${PANEL_BASE_URL}/players/${sid}/grow`, { method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 0.25 }), signal: AbortSignal.timeout(8000) }); } catch {} };
    await new Promise((r) => setTimeout(r, 2500)); await setGrow();
    await new Promise((r) => setTimeout(r, 1500)); await setGrow();
  } catch (err) { return res.status(502).json({ error: `Quest-Dino konnte nicht aufgespielt werden: ${err.message}` }); }
  q.active.status = 'active'; q.active.startedAt = Date.now(); q.active.gender = gender; q.active.instaUsed = false; q.active.startGrow = 0.25;
  all[s.steamId] = q; writeJsonFile(QUESTS_FILE, all);
  res.json({ ok: true, active: q.active });
});
app.post('/me/quest/abandon', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const { all, q } = questFor(s.steamId);
  if (q.active) { q.active.status = 'void'; q.active = null; }
  all[s.steamId] = q; writeJsonFile(QUESTS_FILE, all);
  res.json({ ok: true, rollsToday: q.rollsToday, dailyLimit: questLimitFor(s) });
});

// Geschlecht ändern (Skin-Editor): The Isle kann das Geschlecht nur per Respawn
// wechseln → selber Dino, selbes Wachstum, neues Geschlecht via /swap.
app.post('/me/gender', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  // Geschlechtswechsel ist erst ab Rang Bernstein freigeschaltet.
  if (aboPerkIdx(s) < 2) return res.status(403).json({ error: 'Geschlechtswechsel ist ab Rang Bernstein freigeschaltet.' });
  const gender = req.body?.gender;
  if (gender !== 'Male' && gender !== 'Female') return res.status(400).json({ error: 'Ungültiges Geschlecht' });
  let players; try { players = await fetchPlayers(); } catch (e) { return res.status(502).json({ error: e.message }); }
  const current = players.find((p) => p.steamId === s.steamId);
  if (!current || current.isDead) return res.status(409).json({ error: 'Du musst lebend im Spiel auf einem Dino sein.' });
  if (current.gender === gender) return res.json({ ok: true, gender, unchanged: true });
  const sid = encodeURIComponent(s.steamId);
  try {
    const sr = await fetch(`${PANEL_BASE_URL}/players/${sid}/swap`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...current, gender, class: baseClass(current.dinoClass), dinoClass: current.dinoClass, grow: current.grow, growth: current.grow, keepLocation: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sr.ok) { let d = `HTTP ${sr.status}`; try { const e = await sr.json(); d = e.message ?? e.error ?? e.Msg ?? d; } catch {} throw new Error(d); }
  } catch (err) { return res.status(502).json({ error: `Geschlechtswechsel fehlgeschlagen: ${err.message}` }); }
  res.json({ ok: true, gender });
});

// Discord-Scheduled-Events, an denen der User „interessiert" ist (mit 60s-Cache)
let _evCache = { at: 0, events: null };
const _evUsers = new Map(); // eventId → { at, ids:Set }
async function guildEvents() {
  if (_evCache.events && Date.now() - _evCache.at < 60000) return _evCache.events;
  const ev = await discordApi(`/guilds/${DISCORD_GUILD_ID}/scheduled-events?with_user_count=true`);
  _evCache = { at: Date.now(), events: ev };
  return ev;
}
async function eventUserIds(eventId) {
  const c = _evUsers.get(eventId);
  if (c && Date.now() - c.at < 60000) return c.ids;
  const users = await discordApi(`/guilds/${DISCORD_GUILD_ID}/scheduled-events/${eventId}/users?limit=100`);
  const ids = new Set(users.map((u) => u.user?.id).filter(Boolean));
  _evUsers.set(eventId, { at: Date.now(), ids });
  return ids;
}
app.get('/me/events', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return res.json({ events: [] });
  try {
    const events = await guildEvents();
    const out = [];
    for (const ev of events) {
      let interested = false;
      try { interested = (await eventUserIds(ev.id)).has(s.discordId); } catch {}
      const image = ev.image ? `https://cdn.discordapp.com/guild-events/${ev.id}/${ev.image}.png?size=1024` : null;
      out.push({
        id: ev.id, name: ev.name,
        start: ev.scheduled_start_time, end: ev.scheduled_end_time || null,
        description: ev.description || '',
        image, location: (ev.entity_metadata && ev.entity_metadata.location) || null,
        status: ev.status, userCount: ev.user_count ?? null, interested,
      });
    }
    // Interessierte zuerst, dann nach Startzeit
    out.sort((a, b) => (b.interested - a.interested) || (new Date(a.start || 0) - new Date(b.start || 0)));
    res.json({ events: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Overlay-Gruppen (diät-übergreifend, rein overlay-verwaltet) ──────────────
const OVGROUPS_FILE = `${BOT_DATA_DIR}/ovgroups.json`;
const DIET = {
  Tyrannosaurus: 'carni', Rex: 'carni', Allosaurus: 'carni', Carnotaurus: 'carni', Ceratosaurus: 'carni', Deinosuchus: 'carni', Dilophosaurus: 'carni', Herrerasaurus: 'carni', Omniraptor: 'carni', Pteranodon: 'carni', Troodon: 'carni',
  Triceratops: 'herbi', Stegosaurus: 'herbi', Diabloceratops: 'herbi', Tenontosaurus: 'herbi', Maiasaura: 'herbi', Maiasaurus: 'herbi', Pachycephalosaurus: 'herbi', Dryosaurus: 'herbi', Hypsilophodon: 'herbi',
  // Omnivoren zählen zur Kategorie Herbivoren (können mit Herbis in eine Gruppe)
  Gallimimus: 'herbi', Beipiaosaurus: 'herbi',
};
const dietOf = (dino) => DIET[dino] || 'both';
const sameDiet = (a, b) => { const x = dietOf(a), y = dietOf(b); return x === y || x === 'both' || y === 'both'; };
function readOv() { return readJson(OVGROUPS_FILE, { groups: {}, invites: [] }); }
function writeOv(d) { writeJsonFile(OVGROUPS_FILE, d); }
// Overlay-Toast für einen Spieler einreihen (wird beim nächsten /positions abgeholt)
function queueOverlayToast(steamId, msg) {
  try { const tf = `${BOT_DATA_DIR}/toasts.json`; const store = readJson(tf, {}); (store[steamId] = store[steamId] || []).push(msg); writeJsonFile(tf, store); } catch {}
}
// Diät-Konsistenz der Gruppen erzwingen: wer den Dino auf eine andere Diät wechselt,
// fliegt automatisch raus. Gruppen-Diät wird beim ersten bekannten Mitglied festgelegt.
// (Omnivoren = Herbivoren, siehe DIET.) Läuft im /positions-Dauer-Poll → quasi sofort.
function enforceGroupDiet(ov, players) {
  let changed = false;
  const dinoOf = (sid) => { const p = players.find((x) => x.steamId === sid && !x.isDead); return p ? p.dinoClass : null; };
  for (const [gid, g] of Object.entries(ov.groups || {})) {
    const members = g.members || [];
    if (!members.length) { delete ov.groups[gid]; changed = true; continue; }
    if (!g.diet) {  // Gruppen-Diät initialisieren (erstes online-Mitglied mit klarer Diät)
      for (const sid of members) { const dc = dinoOf(sid); const d = dc ? dietOf(dc) : null; if (d && d !== 'both') { g.diet = d; changed = true; break; } }
    }
    if (!g.diet) continue;
    const keep = [];
    for (const sid of members) {
      const dc = dinoOf(sid);
      if (!dc) { keep.push(sid); continue; }            // offline/unbekannt → nicht kicken
      const d = dietOf(dc);
      if (d === 'both' || d === g.diet) keep.push(sid);
      else { changed = true; queueOverlayToast(sid, '⚠️ Du wurdest aus der Gruppe entfernt (Dino-/Diät-Wechsel).'); }
    }
    if (keep.length !== members.length) g.members = keep;
    if (!g.members.length) { delete ov.groups[gid]; changed = true; }
  }
  return changed;
}
function myOvGroupId(ov, steamId) { for (const [gid, g] of Object.entries(ov.groups || {})) if ((g.members || []).includes(steamId)) return gid; return null; }
function ovMembersOf(ov, steamId) { const gid = myOvGroupId(ov, steamId); return gid ? (ov.groups[gid].members || []) : []; }

app.get('/ovgroup', async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const ov = readOv();
  const gid = myOvGroupId(ov, s.steamId);
  let players = []; try { players = await fetchPlayers(); } catch {}
  const pName = (sid) => { const p = players.find((x) => x.steamId === sid); return p ? p.playerName : sid; };
  const members = gid ? (ov.groups[gid].members || []).map((sid) => ({ steamId: sid, name: pName(sid), me: sid === s.steamId })) : [];
  const invites = (ov.invites || []).filter((i) => i.to === s.steamId).map((i) => ({ gid: i.gid, fromName: i.fromName || pName(i.from) }));
  res.json({ groupId: gid, members, invites });
});

app.get('/ovgroup/invitable', async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  let players = []; try { players = await fetchPlayers(); } catch (e) { return res.status(502).json({ error: e.message }); }
  const me = players.find((p) => p.steamId === s.steamId);
  if (!me) return res.json({ players: [] });
  const ov = readOv(); const mine = new Set(ovMembersOf(ov, s.steamId));
  const out = players
    .filter((p) => p.steamId !== s.steamId && !p.isDead && !mine.has(p.steamId) && sameDiet(me.dinoClass, p.dinoClass))
    .map((p) => ({ steamId: p.steamId, name: p.playerName, dino: p.dinoClass }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ players: out });
});

app.post('/ovgroup/invite', express.json(), async (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const to = String(req.body?.toSteamId || ''); if (!/^\d{17}$/.test(to)) return res.status(400).json({ error: 'Ungültige SteamID' });
  let players = []; try { players = await fetchPlayers(); } catch (e) { return res.status(502).json({ error: e.message }); }
  const me = players.find((p) => p.steamId === s.steamId), tp = players.find((p) => p.steamId === to);
  if (!me) return res.status(409).json({ error: 'Du bist nicht im Spiel.' });
  if (!tp) return res.status(409).json({ error: 'Spieler ist nicht im Spiel.' });
  if (!sameDiet(me.dinoClass, tp.dinoClass)) return res.status(400).json({ error: 'Andere Diät — Einladung nicht möglich.' });
  const ov = readOv();
  let gid = myOvGroupId(ov, s.steamId);
  if (!gid) { gid = genId(); ov.groups[gid] = { members: [s.steamId], diet: dietOf(me.dinoClass) }; }
  ov.invites = (ov.invites || []).filter((i) => !(i.to === to && i.gid === gid));
  ov.invites.push({ to, from: s.steamId, fromName: me.playerName, gid, at: Date.now() });
  writeOv(ov);
  res.json({ ok: true });
});

app.post('/ovgroup/accept', express.json(), (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const gid = String(req.body?.gid || '');
  const ov = readOv();
  const inv = (ov.invites || []).find((i) => i.to === s.steamId && i.gid === gid);
  if (!inv || !ov.groups[gid]) return res.status(404).json({ error: 'Einladung nicht gefunden' });
  const old = myOvGroupId(ov, s.steamId);
  if (old && old !== gid) { ov.groups[old].members = ov.groups[old].members.filter((x) => x !== s.steamId); if (!ov.groups[old].members.length) delete ov.groups[old]; }
  if (!ov.groups[gid].members.includes(s.steamId)) ov.groups[gid].members.push(s.steamId);
  ov.invites = ov.invites.filter((i) => !(i.to === s.steamId && i.gid === gid));
  writeOv(ov);
  res.json({ ok: true });
});

app.post('/ovgroup/leave', (req, res) => {
  const s = sessionFrom(req); if (!s) return res.status(401).json({ error: 'Keine Session' });
  const ov = readOv(); const gid = myOvGroupId(ov, s.steamId);
  if (gid) { ov.groups[gid].members = ov.groups[gid].members.filter((x) => x !== s.steamId); if (ov.groups[gid].members.length <= 1) delete ov.groups[gid]; ov.invites = (ov.invites || []).filter((i) => i.from !== s.steamId); writeOv(ov); }
  res.json({ ok: true });
});

// Karten-Daten aus einem Garage-/Markt-Slot (Farben, Vitals, Mutationen)
function slotCard(slot) {
  const sn = slot.snapshot ?? {};
  return {
    id: slot.id,
    label: slot.label ?? null,
    savedAt: slot.savedAt,
    dino: sn.dinoClass ?? '?',
    gender: sn.gender ?? '',
    grow: sn.grow ?? 0,
    isElder: !!sn.isElder,
    isPrime: !!sn.isPrime,
    serverPrice: serverSellPrice(sn.dinoClass),     // Punkte beim Verkauf an den Server
    sellMinGrow: SELL_MIN_GROW,                      // nötiges Mindest-Wachstum dafür
    health: sn.health ?? 0, hunger: sn.hunger ?? 0, thirst: sn.thirst ?? 0, stamina: sn.stamina ?? 0, blood: sn.blood ?? 0,
    patternIndex: sn.patternIndex ?? 0,
    colors: {
      body: sn.bodyColor, markings: sn.markingsColor, underbelly: sn.underbellyColor,
      flank: sn.flankColor, detail: sn.detailColor, eyes: sn.eyesColor, male: sn.maleDisplayColor,
    },
    mutations: sn.mutations ?? { base: [], parent: [], elder: [] },
  };
}

// Garage anzeigen
app.get('/garage', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const garage = readJson(GARAGE_FILE, {});
  const slots = garage[s.steamId] ?? [];
  res.json({
    slots: slots.map(slotCard),
    limit: garageLimitFor(s),
    count: slots.length,
    cooldowns: {
      park: cooldownRemaining(s.steamId, 'park'),
      unpark: cooldownRemaining(s.steamId, 'unpack'),
    },
  });
});

// Aktuellen Dino einparken
app.post('/garage/park', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  try {
    // Cooldown (gesynct mit dem Bot)
    const cd = cooldownRemaining(s.steamId, 'park');
    if (cd > 0) return res.status(429).json({ error: `Einparken gesperrt — warte noch ${fmtCooldown(cd)}.` });

    const players = await fetchPlayers();
    const snapshot = players.find((p) => p.steamId === s.steamId);
    if (!snapshot) return res.status(409).json({ error: 'Du bist nicht im Spiel.' });
    // Anti-Flucht-Gate: nur mit vollem Dino einparken
    const pgate = fullDinoGateError(snapshot, 'Einparken');
    if (pgate) return res.status(409).json({ error: pgate });
    // in Garage sichern
    const garage = readJson(GARAGE_FILE, {});
    if (!garage[s.steamId]) garage[s.steamId] = [];
    // Garage-Limit prüfen (tier-abhängig: Free 10 / Knochen 20 / Bernstein 40 / Obsidian 80)
    const gLimit = garageLimitFor(s);
    if (garage[s.steamId].length >= gLimit) {
      return res.status(409).json({ error: `Garage voll (${garage[s.steamId].length}/${gLimit}). Verkaufe oder spiele zuerst einen aus.` });
    }
    garage[s.steamId].push({ id: genId(), savedAt: Date.now(), snapshot });
    writeJsonFile(GARAGE_FILE, garage);
    // Dino im Spiel einparken (despawn)
    const pr = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/pack`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!pr.ok) throw new Error(`Einparken fehlgeschlagen (${pr.status})`);
    startCooldown(s.steamId, 'park', cooldownMsFor(s));
    res.json({ ok: true, dino: snapshot.dinoClass, count: garage[s.steamId].length, limit: gLimit });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Dino aus der Garage ausparken (auf aktuellen Dino)
app.post('/garage/unpark', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const slotId = req.body?.slotId;
  if (!slotId) return res.status(400).json({ error: 'slotId fehlt' });
  try {
    const cd = cooldownRemaining(s.steamId, 'unpack');
    if (cd > 0) return res.status(429).json({ error: `Ausparken gesperrt — warte noch ${fmtCooldown(cd)}.` });

    const garage = readJson(GARAGE_FILE, {});
    const slots = garage[s.steamId] ?? [];
    const slot = slots.find((x) => x.id === slotId);
    if (!slot) return res.status(404).json({ error: 'Slot nicht gefunden' });

    const players = await fetchPlayers();
    const meNow = players.find((p) => p.steamId === s.steamId);
    if (!meNow) return res.status(409).json({ error: 'Du musst im Spiel sein (auf einem Dino).' });

    // Ausparken: kein 100%-Gate, aber NICHT im Kampf (blutend) und ≥ 50 m von anderen Spielern
    // entfernt — damit es nicht als PvP-Flucht missbraucht wird.
    if (meNow.isBleeding) return res.status(409).json({ error: 'Ausparken nicht möglich: Dein Dino blutet (im Kampf).' });
    const distU = nearestOtherPlayerM(meNow, players);
    if (distU < SWAP_MIN_DISTANCE_M) return res.status(409).json({ error: `Ausparken nicht möglich: Spieler zu nah (${Math.round(distU)} m, nötig ≥ ${SWAP_MIN_DISTANCE_M} m).` });

    // Spezies-Check: nur auf gleiche Spezies aufspielbar (Basis, ohne Wachstums-Suffix)
    if (baseClass(meNow.dinoClass) !== baseClass(slot.snapshot?.dinoClass)) {
      return res.status(409).json({ error: `Spezies stimmt nicht: Du spielst ${baseClass(meNow.dinoClass)}, der Token ist ${baseClass(slot.snapshot?.dinoClass)}.` });
    }

    const ur = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/unpack`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(slot.snapshot),
    });
    if (!ur.ok) throw new Error(`Ausparken fehlgeschlagen (${ur.status})`);
    // Unpack ist ASYNCHRON (200 = "Unpack started", Aufspielen folgt ~1–3 s später).
    // Sobald die API 200 liefert, gilt der Token als verbraucht → SOFORT entfernen. Die
    // frühere 1500ms-Bestätigung war zu kurz fürs async-Aufspielen und schlug oft fehl →
    // Token blieb trotz aufgespieltem Dino in der Garage → Duplikation. Bei API-Fehler
    // (!ur.ok) wirft der throw oben und der Token bleibt unangetastet (kein Verlust).
    // Datei NEU einlesen, damit parallele Schreiber (/park, swap) nichts verlieren.
    const fresh = readJson(GARAGE_FILE, {});
    fresh[s.steamId] = (fresh[s.steamId] ?? []).filter((x) => x.id !== slotId);
    writeJsonFile(GARAGE_FILE, fresh);
    startCooldown(s.steamId, 'unpack', cooldownMsFor(s));
    res.json({ ok: true, dino: slot.snapshot?.dinoClass });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Dino wechseln (aktuellen sicher einparken, dann Ziel aufspielen)
app.post('/garage/swap', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const slotId = req.body?.slotId;
  if (!slotId) return res.status(400).json({ error: 'slotId fehlt' });
  try {
    const cd = cooldownRemaining(s.steamId, 'swap');
    if (cd > 0) return res.status(429).json({ error: `Swap gesperrt — warte noch ${fmtCooldown(cd)}.` });

    const garage = readJson(GARAGE_FILE, {});
    const slots = garage[s.steamId] ?? [];
    const slot = slots.find((x) => x.id === slotId);
    if (!slot) return res.status(404).json({ error: 'Slot nicht gefunden' });

    const players = await fetchPlayers();
    const current = players.find((p) => p.steamId === s.steamId);
    if (!current) return res.status(409).json({ error: 'Du musst im Spiel sein (auf einem Dino).' });

    // Swap-Regeln: voller Dino (100% HP/Blut/Stamina, nicht blutend) + Abstand zu Spielern.
    const sgate = fullDinoGateError(current, 'Swap');
    if (sgate) return res.status(409).json({ error: sgate });
    const dist = nearestOtherPlayerM(current, players);
    if (dist < SWAP_MIN_DISTANCE_M) return res.status(409).json({ error: `Swap nicht möglich: Spieler zu nah (${Math.round(dist)} m, nötig ≥ ${SWAP_MIN_DISTANCE_M} m).` });
    // Spezies-Limit: nicht auf eine bereits volle Spezies wechseln (außer man spielt sie schon).
    const targetSp = canonSpecies(slot.snapshot?.dinoClass);
    if (targetSp !== canonSpecies(current.dinoClass)) {
      const spLimit = (readJson(DINO_LIMITS_FILE, {}))[targetSp] || 0;
      if (spLimit > 0 && speciesCount(players, targetSp) >= spLimit) {
        return res.status(409).json({ error: `${targetSp}-Limit erreicht (max. ${spLimit} gleichzeitig). Es sind schon genug ${targetSp} unterwegs — bitte später erneut wechseln.` });
      }
    }

    // 1) Aktuellen Dino IMMER zuerst sichern, damit er nicht verloren geht
    const parkedId = genId();
    garage[s.steamId] = [...slots, { id: parkedId, savedAt: Date.now(), snapshot: current }];
    writeJsonFile(GARAGE_FILE, garage);

    // 2) Ziel-Dino aufspielen (Basis-Spezies + aktuelle Position)
    const sr = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/swap`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...slot.snapshot, class: baseClass(slot.snapshot.dinoClass), keepLocation: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!sr.ok) {
      // Rollback: gerade erstellten Park-Slot wieder entfernen, Ziel-Slot bleibt erhalten
      const g2 = readJson(GARAGE_FILE, {});
      g2[s.steamId] = (g2[s.steamId] ?? []).filter((x) => x.id !== parkedId);
      writeJsonFile(GARAGE_FILE, g2);
      let detail = `HTTP ${sr.status}`;
      try { const e = await sr.json(); detail = e.message ?? e.error ?? e.Msg ?? detail; } catch {}
      return res.status(502).json({ error: `Wechsel fehlgeschlagen: ${detail}` });
    }
    // 3) Erst jetzt den verbrauchten Ziel-Slot entfernen
    const g3 = readJson(GARAGE_FILE, {});
    g3[s.steamId] = (g3[s.steamId] ?? []).filter((x) => x.id !== slotId);
    writeJsonFile(GARAGE_FILE, g3);
    startCooldown(s.steamId, 'swap');
    res.json({ ok: true, dino: slot.snapshot?.dinoClass, parked: current.dinoClass });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Teleport (nur für die Karten-Kalibrierung). Setzt den Spieler an x/y, gibt die
// tatsächliche Position zurück (für robuste Welt→Karte-Paare).
app.post('/player/teleport', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });   // Kalibrier-Teleport = Admin
  const x = Number(req.body?.x), y = Number(req.body?.y);
  const z = Number.isFinite(Number(req.body?.z)) ? Number(req.body.z) : undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'x/y fehlen' });
  try {
    // Ohne z: aktuelle Höhe des Spielers nehmen (sonst landet er bei z=0 unter der Map)
    let zVal = z;
    if (zVal === undefined) {
      const cur = (await fetchPlayers().catch(() => [])).find((p) => p.steamId === s.steamId);
      if (Number.isFinite(cur?.location?.z)) zVal = cur.location.z;
    }
    const where = Number.isFinite(zVal) ? { x, y, z: zVal } : { x, y };
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/teleport`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Teleport fehlgeschlagen (${r.status})`);
    const d = await r.json().catch(() => ({}));
    // Tatsächliche Position kurz darauf aus dem Spieler-Snapshot lesen (falls geклampt)
    await new Promise((rr) => setTimeout(rr, 900));
    const after = (await fetchPlayers().catch(() => [])).find((p) => p.steamId === s.steamId);
    res.json({ ok: true, x: after?.location?.x ?? d.x ?? x, y: after?.location?.y ?? d.y ?? y });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Teleport-Punkte (Admin erstellt, alle nutzen) ───────────────────────────
const TELEPORTS_FILE = `${BOT_DATA_DIR}/teleports.json`;
const TP_COOLDOWNS_FILE = `${BOT_DATA_DIR}/tp_cooldowns.json`;
// Beim Teleport zu einem TP-Punkt etwas höher absetzen → niemand steckt im Boden fest.
const TP_Z_OFFSET = parseInt(process.env.TP_Z_OFFSET ?? '150', 10);

function tpCooldownRemaining(steamId, tpId) {
  const store = readJson(TP_COOLDOWNS_FILE, {});
  return Math.max(0, (store[steamId]?.[tpId] ?? 0) - Date.now());
}
function tpStartCooldown(steamId, tpId, minutes) {
  const store = readJson(TP_COOLDOWNS_FILE, {});
  if (!store[steamId]) store[steamId] = {};
  store[steamId][tpId] = Date.now() + minutes * 60_000;
  writeJsonFile(TP_COOLDOWNS_FILE, store);
}

// Liste aller TP-Punkte (+ Preis, aktiver Cooldown des Anfragenden, eigene Punkte)
app.get('/teleports', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const tps = readJson(TELEPORTS_FILE, []);
  res.json({
    teleports: tps.map((t) => ({
      id: t.id, number: t.number, name: t.name, price: t.price, cooldownMin: t.cooldownMin,
      x: t.x, y: t.y, cooldownRemaining: tpCooldownRemaining(s.steamId, t.id),
    })),
    points: getPoints(s.steamId),
    isTeam: isIngameMember(s),
    isAdmin: isIngameMember(s), // Ingame-Tools (Moderator+) — abwärtskompatibel für ältere Clients
  });
});

// TP-Punkt an aktueller Position erstellen (nur Admin)
app.post('/teleports', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const name = String(req.body?.name ?? '').trim().slice(0, 40);
  const price = Math.max(0, Math.round(Number(req.body?.price) || 0));
  const cooldownMin = Math.max(0, Math.round(Number(req.body?.cooldownMin) || 0));
  if (!name) return res.status(400).json({ error: 'Name fehlt' });
  try {
    const cur = (await fetchPlayers().catch(() => [])).find((p) => p.steamId === s.steamId);
    if (!cur) return res.status(409).json({ error: 'Du musst im Spiel sein (Position wird übernommen).' });
    const tps = readJson(TELEPORTS_FILE, []);
    const number = tps.reduce((m, t) => Math.max(m, t.number || 0), 0) + 1;
    const tp = { id: genId(), number, name, price, cooldownMin, x: cur.location.x, y: cur.location.y, z: cur.location.z };
    tps.push(tp);
    writeJsonFile(TELEPORTS_FILE, tps);
    res.json({ ok: true, teleport: tp });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// TP-Punkt löschen (nur Admin)
app.delete('/teleports/:id', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
  const tps = readJson(TELEPORTS_FILE, []);
  const next = tps.filter((t) => t.id !== req.params.id);
  if (next.length === tps.length) return res.status(404).json({ error: 'Nicht gefunden' });
  writeJsonFile(TELEPORTS_FILE, next);
  res.json({ ok: true });
});

// TP nutzen: Cooldown + Preis prüfen, teleportieren, abziehen, Cooldown setzen
app.post('/teleports/:id/use', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const tps = readJson(TELEPORTS_FILE, []);
  const tp = tps.find((t) => t.id === req.params.id);
  if (!tp) return res.status(404).json({ error: 'TP-Punkt nicht gefunden' });
  const cd = tpCooldownRemaining(s.steamId, tp.id);
  if (cd > 0) return res.status(429).json({ error: `Cooldown — warte noch ${fmtCooldown(cd)}.` });
  const pts = getPoints(s.steamId);
  if (pts < tp.price) return res.status(402).json({ error: `Zu wenig Punkte (${pts}/${tp.price}).` });
  try {
    const cur = (await fetchPlayers().catch(() => [])).find((p) => p.steamId === s.steamId);
    if (!cur) return res.status(409).json({ error: 'Du musst im Spiel sein.' });
    // Anti-Flucht-Gate: nur mit vollem Dino teleportieren
    const tgate = fullDinoGateError(cur, 'Teleport');
    if (tgate) return res.status(409).json({ error: tgate });
    const where = Number.isFinite(tp.z) ? { x: tp.x, y: tp.y, z: tp.z + TP_Z_OFFSET } : { x: tp.x, y: tp.y };
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/teleport`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Teleport fehlgeschlagen (${r.status})`);
    if (tp.price > 0) spendPoints(s.steamId, tp.price);   // atomar abbuchen (nach erfolgreichem TP)
    if (tp.cooldownMin > 0) tpStartCooldown(s.steamId, tp.id, tp.cooldownMin);
    res.json({ ok: true, name: tp.name, points: getPoints(s.steamId), cooldownRemaining: tpCooldownRemaining(s.steamId, tp.id) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ── 8) Dino-Markt (Bot-seitige JSON-Daten) ──────────────────────────────────
const MARKETPLACE_FILE = `${BOT_DATA_DIR}/marketplace.json`;
const POINTS_FILE = `${BOT_DATA_DIR}/points.json`;
// Server-Ankauf: fester Preis je Tier (identisch zum Bot, src/config/sellPrices.ts) + 75%-Gate.
const SELL_TIER_PRICES = { apex: 500, mid: 250, small: 100 };
const SELL_MIN_GROW = 0.75;
const SELL_SPECIES_TIER = {
  Tyrannosaurus: 'apex', Rex: 'apex', Allosaurus: 'apex', Deinosuchus: 'apex',
  Carnotaurus: 'mid', Ceratosaurus: 'mid', Triceratops: 'mid', Stegosaurus: 'mid',
  Maiasaura: 'mid', Maiasaurus: 'mid', Tenontosaurus: 'mid', Diabloceratops: 'mid', Pachycephalosaurus: 'mid',
  Dilophosaurus: 'small', Herrerasaurus: 'small', Omniraptor: 'small', Troodon: 'small', Pteranodon: 'small',
  Dryosaurus: 'small', Hypsilophodon: 'small', Beipiaosaurus: 'small', Gallimimus: 'small',
};
const serverSellPrice = (dinoClass) => SELL_TIER_PRICES[SELL_SPECIES_TIER[baseClass(dinoClass)] ?? 'small'];

function getPoints(steamId) { return readJson(POINTS_FILE, {})[steamId] ?? 0; }
function setPointsVal(steamId, v) {
  withFileLock(POINTS_FILE, () => {
    const p = readJson(POINTS_FILE, {});
    p[steamId] = Math.max(0, Math.round(v));
    writeJsonFile(POINTS_FILE, p);
  });
}

// Marktplatz + eigener Kontostand
app.get('/market', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const market = sweepMarketplace();
  const wants = sweepWants().filter((w) => w.wantKind === 'dino');
  res.json({
    points: getPoints(s.steamId),
    inventory: getInventory(s.steamId),
    tokenDefs: TOKEN_ORDER.map((id) => ({ id, label: TOKEN_DEFS[id].label, emoji: TOKEN_DEFS[id].emoji })),
    offerHours: AUCTION_HOURS,
    marketLimit: marketLimitFor(s), marketUsed: countMarketListings(s.steamId),
    offers: market.map((o) => ({ ...slotCard(o), price: o.price, mine: o.sellerSteamId === s.steamId, expiresAt: o.expiresAt })),
    wants: wants.map((w) => ({ ...w, mine: w.requesterSteamId === s.steamId, offerText: wantOfferText(w) })),
  });
});

// An den Server verkaufen (Festpreis)
app.post('/market/sell-server', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const slotId = req.body?.slotId;
  const garage = readJson(GARAGE_FILE, {});
  const slots = garage[s.steamId] ?? [];
  const slot = slots.find((x) => x.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Slot nicht gefunden' });
  if ((slot.snapshot?.grow ?? 0) < SELL_MIN_GROW) {
    return res.status(409).json({ error: `Verkauf erst ab ${Math.round(SELL_MIN_GROW * 100)}% Wachstum möglich.` });
  }
  const earned = serverSellPrice(slot.snapshot?.dinoClass);
  addPoints(s.steamId, earned);
  garage[s.steamId] = slots.filter((x) => x.id !== slotId);
  writeJsonFile(GARAGE_FILE, garage);
  res.json({ ok: true, earned, points: getPoints(s.steamId) });
});

// Dino-Slot direkt aus der Garage löschen (ohne Verkauf)
app.post('/garage/delete', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const slotId = req.body?.slotId;
  const garage = readJson(GARAGE_FILE, {});
  const slots = garage[s.steamId] ?? [];
  if (!slots.find((x) => x.id === slotId)) return res.status(404).json({ error: 'Slot nicht gefunden' });
  garage[s.steamId] = slots.filter((x) => x.id !== slotId);
  writeJsonFile(GARAGE_FILE, garage);
  res.json({ ok: true, dino: '' });
});

// An Spieler verkaufen (Marktplatz-Listing)
app.post('/market/sell-player', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const mLimit = marketLimitFor(s);
  if (countMarketListings(s.steamId) >= mLimit) return res.status(403).json({ error: `Markt-Limit erreicht (${mLimit} gleichzeitige Angebote). Höhere Abo-Ränge schalten mehr frei.` });
  const { slotId, price } = req.body ?? {};
  const p = parseInt(price);
  if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Ungültiger Preis' });
  const garage = readJson(GARAGE_FILE, {});
  const slots = garage[s.steamId] ?? [];
  const slot = slots.find((x) => x.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Slot nicht gefunden' });
  const now = Date.now();
  const market = readJson(MARKETPLACE_FILE, []);
  market.push({ ...slot, sellerSteamId: s.steamId, sellerName: s.name || 'Spieler', price: p, listedAt: now, expiresAt: now + OFFER_TTL_MS });
  writeJsonFile(MARKETPLACE_FILE, market);
  garage[s.steamId] = slots.filter((x) => x.id !== slotId);
  writeJsonFile(GARAGE_FILE, garage);
  res.json({ ok: true });
});

// Kaufen
app.post('/market/buy', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const offerId = req.body?.offerId;
  const market = readJson(MARKETPLACE_FILE, []);
  const offer = market.find((o) => o.id === offerId);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  if (offer.sellerSteamId === s.steamId) return res.status(400).json({ error: 'Eigenes Angebot' });
  // Punkte atomar abbuchen (prüft Guthaben innerhalb des Locks → kein TOCTOU/Doppel-Kauf der Punkte)
  if (!spendPoints(s.steamId, offer.price)) return res.status(402).json({ error: 'Nicht genug Punkte' });
  addPoints(offer.sellerSteamId, offer.price);   // Verkäufer atomar gutschreiben
  // Token in Käufer-Garage
  const garage = readJson(GARAGE_FILE, {});
  if (!garage[s.steamId]) garage[s.steamId] = [];
  garage[s.steamId].push({ id: genId(), savedAt: Date.now(), snapshot: offer.snapshot, ...(offer.label ? { label: offer.label } : {}) });
  writeJsonFile(GARAGE_FILE, garage);
  // Vom Markt nehmen
  writeJsonFile(MARKETPLACE_FILE, market.filter((o) => o.id !== offerId));
  res.json({ ok: true, points: getPoints(s.steamId), dino: offer.snapshot?.dinoClass });
});

// ── 8b) TOKEN-MARKT (Auktionshaus + Direkt-Tausch) — geteilt mit dem Discord-Bot ──
// Auktionen liegen in der GLEICHEN auctions.json wie der Bot (gemeinsamer Markt).
// Direkt-Tausch nutzt eine eigene token_trades.json (Overlay-nativ, mit Discord-DM-Hinweis).
const AUCTIONS_FILE   = `${BOT_DATA_DIR}/auctions.json`;
const TOKEN_TRADES_FILE = `${BOT_DATA_DIR}/token_trades.json`;
const AUCTION_HOURS   = parseInt(process.env.AUCTION_HOURS ?? '72', 10);   // ALLE Angebote sind 72h befristet
const OFFER_TTL_MS    = AUCTION_HOURS * 3_600_000;
const TRADE_TTL_MS    = OFFER_TTL_MS;   // Direkt-Tausch-Angebote ebenfalls 72h

// Discord-ID zu einer SteamID finden (Reverse von accounts.json)
function lookupDiscordId(steamId) {
  try { const acc = readJson(ACCOUNTS_PATH, {}); return Object.keys(acc).find((d) => String(acc[d]) === String(steamId)) || null; }
  catch { return null; }
}
// Mehrere Token atomar abbuchen (prüft Bestand im selben Lock → kein TOCTOU).
function removeTokens(steamId, type, n) {
  return withFileLock(INVENTORY_FILE, () => {
    const all = readJson(INVENTORY_FILE, {});
    const have = all[steamId]?.[type] ?? 0;
    if (have < n) return false;
    if (!all[steamId]) all[steamId] = {};
    all[steamId][type] = have - n;
    writeJsonFile(INVENTORY_FILE, all);
    return true;
  });
}
const tokenLabel = (t) => { const d = TOKEN_DEFS[t]; return d ? `${d.emoji} ${d.label}` : t; };
function auctionPriceLabel(a) {
  return a.priceKind === 'points' ? `${(a.priceAmount || 0).toLocaleString('de-DE')} Punkte`
                                  : `${a.priceAmount}× ${tokenLabel(a.priceTokenType)}`;
}
// Abgelaufene Auktionen entfernen + Escrow-Token an Verkäufer zurück. Gibt aktive zurück.
function sweepAuctions() {
  const r = withFileLock(AUCTIONS_FILE, () => {
    const now = Date.now();
    const all = readJson(AUCTIONS_FILE, []);
    const active = [], expired = [];
    for (const a of all) (((a.expiresAt ?? 0) <= now) ? expired : active).push(a);
    if (expired.length) writeJsonFile(AUCTIONS_FILE, active);
    return { active, expired };
  });
  for (const a of r.expired) { try { addToken(a.sellerSteamId, a.tokenType, a.qty); } catch {} }
  return r.active;
}
// Abgelaufene Direkt-Tausch-Angebote entfernen + Geber-Escrow zurück. Gibt aktive zurück.
function sweepTrades() {
  const r = withFileLock(TOKEN_TRADES_FILE, () => {
    const now = Date.now();
    const all = readJson(TOKEN_TRADES_FILE, []);
    const active = [], expired = [];
    for (const t of all) (((t.expiresAt ?? 0) <= now) ? expired : active).push(t);
    if (expired.length) writeJsonFile(TOKEN_TRADES_FILE, active);
    return { active, expired };
  });
  for (const t of r.expired) { try { addToken(t.fromSteamId, t.giveType, t.giveQty); } catch {} }
  return r.active;
}

// Konsolidierter Token-Markt-State fürs Overlay (Auktionen + eigene Tausch-Angebote + Online-Spieler)
app.get('/tokenmarket', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const auctions = sweepAuctions();
  const trades = sweepTrades();
  // Online-Spieler als Tauschpartner (best-effort — Token-Markt funktioniert auch, wenn der Game-Server aus ist)
  let players = [];
  try {
    players = (await fetchPlayers())
      .filter((p) => p.steamId && p.steamId !== s.steamId)
      .map((p) => ({ steamId: p.steamId, name: p.playerName || 'Spieler' }));
  } catch { players = []; }
  res.json({
    points: getPoints(s.steamId),
    inventory: getInventory(s.steamId),
    tokenDefs: TOKEN_ORDER.map((id) => ({ id, label: TOKEN_DEFS[id].label, emoji: TOKEN_DEFS[id].emoji })),
    auctionHours: AUCTION_HOURS,
    marketLimit: marketLimitFor(s), marketUsed: countMarketListings(s.steamId),
    auctions: auctions.map((a) => ({ ...a, mine: a.sellerSteamId === s.steamId, priceText: auctionPriceLabel(a) })),
    wants: sweepWants().filter((w) => w.wantKind === 'token').map((w) => ({ ...w, mine: w.requesterSteamId === s.steamId, offerText: wantOfferText(w) })),
    players,
    trades: {
      incoming: trades.filter((t) => t.toSteamId === s.steamId),
      outgoing: trades.filter((t) => t.fromSteamId === s.steamId),
    },
  });
});

// Auktion erstellen (Escrow: Token aus dem Inventar sperren)
app.post('/tokenmarket/auction/create', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const mLimit = marketLimitFor(s);
  if (countMarketListings(s.steamId) >= mLimit) return res.status(403).json({ error: `Markt-Limit erreicht (${mLimit} gleichzeitige Angebote). Höhere Abo-Ränge schalten mehr frei.` });
  const { tokenType, priceKind, priceTokenType } = req.body ?? {};
  const qty = parseInt(req.body?.qty), priceAmount = parseInt(req.body?.priceAmount);
  if (!TOKEN_DEFS[tokenType]) return res.status(400).json({ error: 'Unbekannter Token' });
  if (!Number.isFinite(qty) || qty < 1 || qty > 25) return res.status(400).json({ error: 'Ungültige Menge (1–25)' });
  if (!Number.isFinite(priceAmount) || priceAmount < 1) return res.status(400).json({ error: 'Ungültiger Preis' });
  if (priceKind === 'token') { if (!TOKEN_DEFS[priceTokenType]) return res.status(400).json({ error: 'Unbekannter Preis-Token' }); }
  else if (priceKind !== 'points') return res.status(400).json({ error: 'Ungültige Preis-Art' });
  if (!removeTokens(s.steamId, tokenType, qty)) return res.status(400).json({ error: `Du hast nicht genug ${TOKEN_DEFS[tokenType].label}.` });
  const now = Date.now();
  const a = {
    id: genId(), sellerSteamId: s.steamId, sellerDiscordId: s.discordId || lookupDiscordId(s.steamId) || '', sellerName: s.name || 'Spieler',
    tokenType, qty, priceKind, priceAmount, ...(priceKind === 'token' ? { priceTokenType } : {}),
    createdAt: now, expiresAt: now + AUCTION_HOURS * 3_600_000,
  };
  withFileLock(AUCTIONS_FILE, () => { const all = readJson(AUCTIONS_FILE, []); all.push(a); writeJsonFile(AUCTIONS_FILE, all); });
  res.json({ ok: true, auction: a });
});

// Eigene Auktion abbrechen (Escrow zurück)
app.post('/tokenmarket/auction/cancel', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const id = req.body?.auctionId;
  const claim = withFileLock(AUCTIONS_FILE, () => {
    const all = readJson(AUCTIONS_FILE, []);
    const a = all.find((x) => x.id === id);
    if (!a) return { err: 'Auktion nicht gefunden.' };
    if (a.sellerSteamId !== s.steamId) return { err: 'Nicht deine Auktion.' };
    writeJsonFile(AUCTIONS_FILE, all.filter((x) => x.id !== id));
    return { a };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  addToken(s.steamId, claim.a.tokenType, claim.a.qty);
  res.json({ ok: true });
});

// Auktion kaufen (atomar: erst unter Lock „claimen" = entfernen, dann bezahlen; bei Fehler zurück)
app.post('/tokenmarket/auction/buy', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  sweepAuctions();
  const id = req.body?.auctionId;
  const claim = withFileLock(AUCTIONS_FILE, () => {
    const all = readJson(AUCTIONS_FILE, []);
    const a = all.find((x) => x.id === id);
    if (!a) return { err: 'Angebot nicht mehr verfügbar.' };
    if (a.sellerSteamId === s.steamId) return { err: 'Das ist dein eigenes Angebot.' };
    writeJsonFile(AUCTIONS_FILE, all.filter((x) => x.id !== id));   // claim
    return { a };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  const a = claim.a;
  let paid = false;
  if (a.priceKind === 'points') { paid = spendPoints(s.steamId, a.priceAmount); if (paid) addPoints(a.sellerSteamId, a.priceAmount); }
  else { paid = removeTokens(s.steamId, a.priceTokenType, a.priceAmount); if (paid) addToken(a.sellerSteamId, a.priceTokenType, a.priceAmount); }
  if (!paid) {
    withFileLock(AUCTIONS_FILE, () => { const all = readJson(AUCTIONS_FILE, []); all.push(a); writeJsonFile(AUCTIONS_FILE, all); });   // zurücklegen
    return res.status(402).json({ error: a.priceKind === 'points' ? `Nicht genug Punkte (${a.priceAmount} nötig).` : `Nicht genug ${TOKEN_DEFS[a.priceTokenType].label}.` });
  }
  const have = addToken(s.steamId, a.tokenType, a.qty);
  sendDiscordDM(a.sellerDiscordId,
    `💰 **Auktion verkauft!** Dein Angebot **${a.qty}× ${tokenLabel(a.tokenType)}** wurde von **${s.name || 'einem Spieler'}** gekauft.\n` +
    `Erlös: **${auctionPriceLabel(a)}** ${a.priceKind === 'points' ? '(gutgeschrieben)' : '(im Inventar)'}.`).catch(() => {});
  res.json({ ok: true, have, points: getPoints(s.steamId) });
});

// Direkt-Tausch: Angebot erstellen (Geber-Token werden geescrowed; Partner per DM informiert)
app.post('/tokenmarket/trade/offer', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const { toSteamId, giveType, wantType, toName } = req.body ?? {};
  const giveQty = parseInt(req.body?.giveQty), wantQty = parseInt(req.body?.wantQty);
  if (!toSteamId || String(toSteamId) === String(s.steamId)) return res.status(400).json({ error: 'Ungültiger Tauschpartner.' });
  if (!TOKEN_DEFS[giveType] || !TOKEN_DEFS[wantType]) return res.status(400).json({ error: 'Unbekannter Token.' });
  if (!Number.isFinite(giveQty) || giveQty < 1 || giveQty > 25) return res.status(400).json({ error: 'Ungültige Menge (geben).' });
  if (!Number.isFinite(wantQty) || wantQty < 1 || wantQty > 25) return res.status(400).json({ error: 'Ungültige Menge (wollen).' });
  const toDiscordId = lookupDiscordId(toSteamId);
  if (!removeTokens(s.steamId, giveType, giveQty)) return res.status(400).json({ error: `Du hast nicht genug ${TOKEN_DEFS[giveType].label}.` });
  const now = Date.now();
  const t = {
    id: genId(), fromSteamId: s.steamId, fromDiscordId: s.discordId || lookupDiscordId(s.steamId) || '', fromName: s.name || 'Spieler',
    toSteamId: String(toSteamId), toDiscordId: toDiscordId || '', toName: String(toName || 'Spieler'),
    giveType, giveQty, wantType, wantQty, createdAt: now, expiresAt: now + TRADE_TTL_MS,
  };
  withFileLock(TOKEN_TRADES_FILE, () => { const all = readJson(TOKEN_TRADES_FILE, []); all.push(t); writeJsonFile(TOKEN_TRADES_FILE, all); });
  if (toDiscordId) sendDiscordDM(toDiscordId,
    `🔄 **Tausch-Angebot** von **${t.fromName}** (im Overlay):\n> Du bekommst: **${giveQty}× ${tokenLabel(giveType)}**\n> Du gibst dafür: **${wantQty}× ${tokenLabel(wantType)}**\n` +
    `Im Overlay unter **Markt → Token-Markt → Direkt-Tausch** annehmen/ablehnen. *(${Math.round(TRADE_TTL_MS / 60000)} Min)*`).catch(() => {});
  res.json({ ok: true, trade: t });
});

// Direkt-Tausch: annehmen (nur Empfänger) — atomar prüfen + tauschen
app.post('/tokenmarket/trade/accept', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  sweepTrades();
  const id = req.body?.tradeId;
  const claim = withFileLock(TOKEN_TRADES_FILE, () => {
    const all = readJson(TOKEN_TRADES_FILE, []);
    const t = all.find((x) => x.id === id);
    if (!t) return { err: 'Angebot nicht mehr verfügbar.' };
    if (t.toSteamId !== s.steamId) return { err: 'Nicht für dich bestimmt.' };
    writeJsonFile(TOKEN_TRADES_FILE, all.filter((x) => x.id !== id));   // claim
    return { t };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  const t = claim.t;
  // Empfänger zahlt die want-Token; Geber-Escrow geht an Empfänger; want-Token an Geber.
  if (!removeTokens(s.steamId, t.wantType, t.wantQty)) {
    addToken(t.fromSteamId, t.giveType, t.giveQty);   // Geber-Escrow zurück
    return res.status(400).json({ error: `Du hast nicht genug ${TOKEN_DEFS[t.wantType].label}.` });
  }
  addToken(s.steamId, t.giveType, t.giveQty);
  addToken(t.fromSteamId, t.wantType, t.wantQty);
  sendDiscordDM(t.fromDiscordId,
    `🤝 **Tausch abgeschlossen!** **${t.toName}** hat angenommen.\n> Gegeben: ${t.giveQty}× ${tokenLabel(t.giveType)}\n> Erhalten: ${t.wantQty}× ${tokenLabel(t.wantType)}`).catch(() => {});
  res.json({ ok: true, inventory: getInventory(s.steamId) });
});

// Direkt-Tausch: ablehnen (Empfänger) oder abbrechen (Sender) — Geber-Escrow zurück
app.post('/tokenmarket/trade/cancel', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const id = req.body?.tradeId;
  const claim = withFileLock(TOKEN_TRADES_FILE, () => {
    const all = readJson(TOKEN_TRADES_FILE, []);
    const t = all.find((x) => x.id === id);
    if (!t) return { err: 'Angebot nicht gefunden.' };
    if (t.fromSteamId !== s.steamId && t.toSteamId !== s.steamId) return { err: 'Nicht beteiligt.' };
    writeJsonFile(TOKEN_TRADES_FILE, all.filter((x) => x.id !== id));
    return { t, bySender: t.fromSteamId === s.steamId };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  addToken(claim.t.fromSteamId, claim.t.giveType, claim.t.giveQty);   // Escrow zurück an Geber
  const other = claim.bySender ? claim.t.toDiscordId : claim.t.fromDiscordId;
  if (other) sendDiscordDM(other, `🔄 Ein Token-Tausch wurde ${claim.bySender ? 'vom Anbieter zurückgezogen' : 'abgelehnt'}.`).catch(() => {});
  res.json({ ok: true });
});

// ── 8c) MARKTPLATZ-ABLAUF (72h) + ZURÜCKZIEHEN + GESUCHE (Want-to-buy) ────────
const WANTS_FILE = `${BOT_DATA_DIR}/wants.json`;

// Abgelaufene Dino-Marktangebote (72h) → Dino zurück in die Garage. Gibt aktive zurück.
function sweepMarketplace() {
  const r = withFileLock(MARKETPLACE_FILE, () => {
    const now = Date.now();
    const all = readJson(MARKETPLACE_FILE, []);
    const active = [], expired = [];
    for (const o of all) (((o.expiresAt ?? Infinity) <= now) ? expired : active).push(o);
    if (expired.length) writeJsonFile(MARKETPLACE_FILE, active);
    return { active, expired };
  });
  for (const o of r.expired) {
    try { withFileLock(GARAGE_FILE, () => { const g = readJson(GARAGE_FILE, {}); (g[o.sellerSteamId] = g[o.sellerSteamId] || []).push({ id: genId(), savedAt: Date.now(), snapshot: o.snapshot, ...(o.label ? { label: o.label } : {}) }); writeJsonFile(GARAGE_FILE, g); }); } catch {}
  }
  return r.active;
}

// Eigenes Dino-Angebot zurückziehen → Dino zurück in die Garage
app.post('/market/withdraw', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const id = req.body?.offerId;
  const claim = withFileLock(MARKETPLACE_FILE, () => {
    const all = readJson(MARKETPLACE_FILE, []);
    const o = all.find((x) => x.id === id);
    if (!o) return { err: 'Angebot nicht gefunden.' };
    if (o.sellerSteamId !== s.steamId) return { err: 'Nicht dein Angebot.' };
    writeJsonFile(MARKETPLACE_FILE, all.filter((x) => x.id !== id));
    return { o };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  withFileLock(GARAGE_FILE, () => { const g = readJson(GARAGE_FILE, {}); (g[s.steamId] = g[s.steamId] || []).push({ id: genId(), savedAt: Date.now(), snapshot: claim.o.snapshot, ...(claim.o.label ? { label: claim.o.label } : {}) }); writeJsonFile(GARAGE_FILE, g); });
  res.json({ ok: true });
});

// Text der Gesuch-Gegenleistung
function wantOfferText(w) {
  return w.offerKind === 'points' ? `${(w.offerAmount || 0).toLocaleString('de-DE')} Pkt.` : `${w.offerAmount}× ${tokenLabel(w.offerTokenType)}`;
}
// Abgelaufene Gesuche (72h) → Escrow (Punkte/Token) an den Suchenden zurück. Gibt aktive zurück.
function sweepWants() {
  const r = withFileLock(WANTS_FILE, () => {
    const now = Date.now();
    const all = readJson(WANTS_FILE, []);
    const active = [], expired = [];
    for (const w of all) (((w.expiresAt ?? 0) <= now) ? expired : active).push(w);
    if (expired.length) writeJsonFile(WANTS_FILE, active);
    return { active, expired };
  });
  for (const w of r.expired) {
    try { if (w.offerKind === 'points') addPoints(w.requesterSteamId, w.offerAmount); else addToken(w.requesterSteamId, w.offerTokenType, w.offerAmount); } catch {}
  }
  return r.active;
}

// Gesuch erstellen (Escrow: Gegenleistung sofort sperren)
app.post('/wants/create', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const mLimit = marketLimitFor(s);
  if (countMarketListings(s.steamId) >= mLimit) return res.status(403).json({ error: `Markt-Limit erreicht (${mLimit} gleichzeitige Angebote). Höhere Abo-Ränge schalten mehr frei.` });
  const { wantKind, wantDino, wantTokenType, offerKind, offerTokenType } = req.body ?? {};
  const wantQty = parseInt(req.body?.wantQty), offerAmount = parseInt(req.body?.offerAmount);
  if (wantKind !== 'dino' && wantKind !== 'token') return res.status(400).json({ error: 'Ungültige Gesuch-Art.' });
  if (wantKind === 'dino') { if (!wantDino || typeof wantDino !== 'string') return res.status(400).json({ error: 'Welcher Dino wird gesucht?' }); }
  else { if (!TOKEN_DEFS[wantTokenType]) return res.status(400).json({ error: 'Unbekannter Token.' }); if (!Number.isFinite(wantQty) || wantQty < 1 || wantQty > 25) return res.status(400).json({ error: 'Ungültige Menge (1–25).' }); }
  if (!Number.isFinite(offerAmount) || offerAmount < 1) return res.status(400).json({ error: 'Ungültiges Gebot.' });
  if (offerKind === 'token') { if (!TOKEN_DEFS[offerTokenType]) return res.status(400).json({ error: 'Unbekannter Gebot-Token.' }); }
  else if (offerKind !== 'points') return res.status(400).json({ error: 'Ungültige Gebot-Art.' });
  // Escrow der Gegenleistung
  if (offerKind === 'points') { if (!spendPoints(s.steamId, offerAmount)) return res.status(402).json({ error: `Nicht genug Punkte (${offerAmount} nötig).` }); }
  else { if (!removeTokens(s.steamId, offerTokenType, offerAmount)) return res.status(400).json({ error: `Du hast nicht genug ${TOKEN_DEFS[offerTokenType].label}.` }); }
  const now = Date.now();
  const w = {
    id: genId(), requesterSteamId: s.steamId, requesterDiscordId: s.discordId || lookupDiscordId(s.steamId) || '', requesterName: s.name || 'Spieler',
    wantKind, ...(wantKind === 'dino' ? { wantDino: baseClass(wantDino) } : { wantTokenType, wantQty }),
    offerKind, offerAmount, ...(offerKind === 'token' ? { offerTokenType } : {}),
    createdAt: now, expiresAt: now + OFFER_TTL_MS,
  };
  withFileLock(WANTS_FILE, () => { const all = readJson(WANTS_FILE, []); all.push(w); writeJsonFile(WANTS_FILE, all); });
  res.json({ ok: true, want: w });
});

// Eigenes Gesuch zurückziehen → Escrow zurück
app.post('/wants/cancel', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const id = req.body?.wantId;
  const claim = withFileLock(WANTS_FILE, () => {
    const all = readJson(WANTS_FILE, []);
    const w = all.find((x) => x.id === id);
    if (!w) return { err: 'Gesuch nicht gefunden.' };
    if (w.requesterSteamId !== s.steamId) return { err: 'Nicht dein Gesuch.' };
    writeJsonFile(WANTS_FILE, all.filter((x) => x.id !== id));
    return { w };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  const w = claim.w;
  if (w.offerKind === 'points') addPoints(s.steamId, w.offerAmount); else addToken(s.steamId, w.offerTokenType, w.offerAmount);
  res.json({ ok: true });
});

// Gesuch erfüllen (claim → liefern → Escrow auszahlen; bei Fehler Gesuch zurücklegen)
app.post('/wants/fulfill', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  sweepWants();
  const id = req.body?.wantId, slotId = req.body?.slotId;
  const claim = withFileLock(WANTS_FILE, () => {
    const all = readJson(WANTS_FILE, []);
    const w = all.find((x) => x.id === id);
    if (!w) return { err: 'Gesuch nicht mehr verfügbar.' };
    if (w.requesterSteamId === s.steamId) return { err: 'Das ist dein eigenes Gesuch.' };
    writeJsonFile(WANTS_FILE, all.filter((x) => x.id !== id));
    return { w };
  });
  if (claim.err) return res.status(409).json({ error: claim.err });
  const w = claim.w;
  const restoreWant = () => withFileLock(WANTS_FILE, () => { const all = readJson(WANTS_FILE, []); all.push(w); writeJsonFile(WANTS_FILE, all); });
  if (w.wantKind === 'token') {
    if (!removeTokens(s.steamId, w.wantTokenType, w.wantQty)) { restoreWant(); return res.status(400).json({ error: `Du hast nicht genug ${TOKEN_DEFS[w.wantTokenType].label}.` }); }
    addToken(w.requesterSteamId, w.wantTokenType, w.wantQty);
  } else {
    const moved = withFileLock(GARAGE_FILE, () => {
      const g = readJson(GARAGE_FILE, {});
      const slots = g[s.steamId] || [];
      const slot = slots.find((x) => x.id === slotId);
      if (!slot) return { err: 'Dino-Slot nicht gefunden.' };
      if (baseClass(slot.snapshot?.dinoClass) !== w.wantDino) return { err: `Dieser Dino passt nicht (gesucht: ${w.wantDino}).` };
      g[s.steamId] = slots.filter((x) => x.id !== slotId);
      (g[w.requesterSteamId] = g[w.requesterSteamId] || []).push({ id: genId(), savedAt: Date.now(), snapshot: slot.snapshot, ...(slot.label ? { label: slot.label } : {}) });
      writeJsonFile(GARAGE_FILE, g);
      return { ok: true };
    });
    if (moved.err) { restoreWant(); return res.status(409).json({ error: moved.err }); }
  }
  if (w.offerKind === 'points') addPoints(s.steamId, w.offerAmount); else addToken(s.steamId, w.offerTokenType, w.offerAmount);
  const got = w.wantKind === 'token' ? `${w.wantQty}× ${tokenLabel(w.wantTokenType)}` : `einen ${w.wantDino}`;
  sendDiscordDM(w.requesterDiscordId, `✅ **Gesuch erfüllt!** **${s.name || 'Ein Spieler'}** hat dir **${got}** geliefert. Deine Gegenleistung (${wantOfferText(w)}) wurde übergeben.`).catch(() => {});
  res.json({ ok: true });
});

// ── 9) Skin-Editor (Relay an Game-Server) + Skin-Ökonomie ───────────────────
const TIER_ORDER = ['Fossil', 'Knochen', 'Bernstein', 'Obsidian'];
const SKIN_REQUIRE_TIER = process.env.SKIN_REQUIRE_TIER ?? ''; // leer = für alle frei
const SKIN_COLOR_FIELDS = ['maleDisplayColor', 'markingsColor', 'bodyColor', 'flankColor', 'underbellyColor', 'teethColor', 'mouthColor', 'clawsColor', 'detailColor', 'eyesColor'];
const SKIN_TEMPLATES_FILE = `${BOT_DATA_DIR}/skin_templates.json`;   // { steamId: [ {id,name,skinVariation,patternIndex,themeIndex,colors} ] }

// 🧹 EINMALIGER Vorlagen-Reset zum Abo-Perks-Launch (neue Skin-Ökonomie → sauberer Start).
// Läuft GENAU EINMAL: die Marker-Datei verhindert Wiederholung bei künftigen Deploys/Neustarts.
// Für einen erneuten Reset in einer späteren Season die Versionsnummer im Marker erhöhen (v2, …).
const SKIN_TPL_RESET_MARKER = `${BOT_DATA_DIR}/.skin_templates_reset_v1`;
try {
  if (!existsSync(SKIN_TPL_RESET_MARKER)) {
    writeJsonFile(SKIN_TEMPLATES_FILE, {});
    writeFileSync(SKIN_TPL_RESET_MARKER, new Date().toISOString());
    console.log('[skin] Vorlagen einmalig zurückgesetzt (Launch-Reset v1).');
  }
} catch (e) { console.warn('[skin] Vorlagen-Reset übersprungen:', e.message); }

// Frischen, LEBENDEN Dino holen (Skin geht nur auf lebendem Ingame-Dino). Wirft {status,error}.
async function fetchLivingDino(steamId) {
  let current;
  try { current = (await fetchPlayers()).find((p) => p.steamId === steamId); }
  catch (err) { throw { status: 502, error: `Spielerdaten nicht erreichbar: ${err.message}` }; }
  if (!current) throw { status: 409, error: 'Du musst im Spiel auf einem Dino sein, um den Skin zu ändern.' };
  if (current.isDead) throw { status: 409, error: 'Dein Dino ist tot — Skin kann nicht geändert werden.' };
  return current;
}
const clampColor = (arr) => arr.map((v) => Math.max(0.0001, Number(v) || 0));   // 0,0,0 = „kein Override" → Epsilon
const colorsFromBody = (b) => {
  const colors = {};
  for (const k of SKIN_COLOR_FIELDS) if (Array.isArray(b?.[k]) && b[k].length === 3) colors[k] = b[k];
  return colors;
};
// Wie viele Farbfelder ändern sich ggü. dem aktuellen Dino? (Toleranz 0.01/Kanal) → Free-Kosten.
function changedColorCount(current, colors) {
  let n = 0;
  for (const k of SKIN_COLOR_FIELDS) {
    const next = colors[k]; if (!Array.isArray(next) || next.length !== 3) continue;
    const cur = Array.isArray(current[k]) ? current[k] : [0, 0, 0];
    if (next.some((v, i) => Math.abs(Number(v) - Number(cur[i] ?? 0)) > 0.01)) n++;
  }
  return n;
}
// Skin-Felder auf den FRISCHEN Snapshot mergen + an Nyors pushen. Wirft {status,error}.
async function pushSkin(steamId, current, fields) {
  const payload = { ...current };
  payload.skinVariation = Number(fields.skinVariation) || 0;
  payload.patternIndex = Number(fields.patternIndex) || 0;
  payload.themeIndex = Number(fields.themeIndex) || 0;
  if (fields.gender === 'Male' || fields.gender === 'Female') payload.gender = fields.gender;
  for (const k of SKIN_COLOR_FIELDS) {
    const c = fields.colors && fields.colors[k];
    if (Array.isArray(c) && c.length === 3) payload[k] = clampColor(c);
  }
  let r;
  try {
    r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(steamId)}/skin`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw { status: 502, error: err.name === 'TimeoutError' ? 'Game-Server hat nicht rechtzeitig geantwortet — bitte gleich nochmal versuchen.' : err.message };
  }
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const e = await r.json(); detail = e.message ?? e.error ?? e.Msg ?? detail; }
    catch { try { const t = await r.text(); if (t) detail = t.slice(0, 200); } catch {} }
    throw { status: 502, error: `Skin-Update fehlgeschlagen: ${detail}` };
  }
}
const readSkinTemplates = (steamId) => { const all = readJson(SKIN_TEMPLATES_FILE, {}); return Array.isArray(all[steamId]) ? all[steamId] : []; };

app.post('/skin', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (SKIN_REQUIRE_TIER) {
    const have = TIER_ORDER.indexOf(s.tier || 'Fossil');
    const need = TIER_ORDER.indexOf(SKIN_REQUIRE_TIER);
    if (have < need) return res.status(403).json({ error: `Skin-Editor ab Tier "${SKIN_REQUIRE_TIER}"` });
  }
  try {
    const current = await fetchLivingDino(s.steamId);
    const b = req.body ?? {};
    const colors = colorsFromBody(b);
    // 💰 Free zahlt 50 pro GEÄNDERTE Farbe (Muster/Variation/Gender bleiben gratis); ab Knochen alles gratis.
    // Atomar reservieren, bei Push-Fehler zurückbuchen → kein Punkt-Verlust ohne angewendeten Skin.
    let charged = 0;
    if (!skinFreeFor(s)) {
      const cost = changedColorCount(current, colors) * SKIN_COSTS.color;
      if (cost > 0) {
        if (!spendPoints(s.steamId, cost)) return res.status(402).json({ error: `Nicht genug Punkte — ${cost} nötig (${SKIN_COSTS.color} pro geänderte Farbe).`, cost });
        charged = cost;
      }
    }
    // Gender NUR ab Bernstein — sonst ignorieren (kein Bypass des Geschlecht-Gates via Skin-Push).
    const skinGender = aboPerkIdx(s) >= 2 ? b.gender : undefined;
    try { await pushSkin(s.steamId, current, { skinVariation: b.skinVariation, patternIndex: b.patternIndex, themeIndex: b.themeIndex, gender: skinGender, colors }); }
    catch (e) { if (charged) addPoints(s.steamId, charged); throw e; }
    res.json({ ok: true, charged, points: getPoints(s.steamId) });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    res.status(502).json({ error: e.message || 'Fehler' });
  }
});

// ── Skin-Vorlagen (server-seitig, dino-übergreifend) — Slots + Free-Kosten ───
// GET: Liste + Slot-Limit/Kosten fürs Overlay-Gating.
app.get('/skin/templates', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const templates = readSkinTemplates(s.steamId);
  res.json({ templates, limit: skinSlotsFor(s), used: templates.length, free: skinFreeFor(s), costs: SKIN_COSTS });
});

// Speichern (Free zahlt SKIN_COSTS.tplSave, nur bei NEU; Überschreiben gleicher Name = gratis).
app.post('/skin/templates', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const b = req.body ?? {};
  const name = String(b.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'Vorlagen-Name fehlt.' });
  const colors = {};
  for (const k of SKIN_COLOR_FIELDS) if (Array.isArray(b.colors?.[k]) && b.colors[k].length === 3) colors[k] = b.colors[k].map(Number);
  const list = readSkinTemplates(s.steamId);
  const isNew = !list.some((t) => t.name === name);
  if (isNew && list.length >= skinSlotsFor(s)) {
    return res.status(409).json({ error: `Keine freien Vorlagen-Slots (${skinSlotsFor(s)}). Lösche eine Vorlage oder hol dir einen höheren Rang.` });
  }
  let charged = 0;
  if (!skinFreeFor(s) && isNew) {
    if (!spendPoints(s.steamId, SKIN_COSTS.tplSave)) return res.status(402).json({ error: `Nicht genug Punkte — Speichern kostet ${SKIN_COSTS.tplSave}.` });
    charged = SKIN_COSTS.tplSave;
  }
  const templates = withFileLock(SKIN_TEMPLATES_FILE, () => {
    const all = readJson(SKIN_TEMPLATES_FILE, {});
    const cur = Array.isArray(all[s.steamId]) ? all[s.steamId] : [];
    const i = cur.findIndex((t) => t.name === name);
    const tpl = { id: i >= 0 ? cur[i].id : genId(), name, skinVariation: Number(b.skinVariation) || 0, patternIndex: Number(b.patternIndex) || 0, themeIndex: Number(b.themeIndex) || 0, colors };
    if (i >= 0) cur[i] = tpl; else cur.push(tpl);
    all[s.steamId] = cur; writeJsonFile(SKIN_TEMPLATES_FILE, all);
    return cur;
  });
  res.json({ ok: true, charged, points: getPoints(s.steamId), templates, limit: skinSlotsFor(s), used: templates.length });
});

// Löschen (gratis).
app.delete('/skin/templates/:id', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const templates = withFileLock(SKIN_TEMPLATES_FILE, () => {
    const all = readJson(SKIN_TEMPLATES_FILE, {});
    const cur = (Array.isArray(all[s.steamId]) ? all[s.steamId] : []).filter((t) => t.id !== req.params.id);
    all[s.steamId] = cur; writeJsonFile(SKIN_TEMPLATES_FILE, all);
    return cur;
  });
  res.json({ ok: true, templates, limit: skinSlotsFor(s), used: templates.length });
});

// Vorlage anwenden (Free zahlt SKIN_COSTS.tplApply pauschal; Farben kommen server-seitig aus der Vorlage → nicht manipulierbar).
app.post('/skin/templates/:id/apply', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const tpl = readSkinTemplates(s.steamId).find((t) => t.id === req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
  try {
    const current = await fetchLivingDino(s.steamId);
    let charged = 0;
    if (!skinFreeFor(s)) {
      if (!spendPoints(s.steamId, SKIN_COSTS.tplApply)) return res.status(402).json({ error: `Nicht genug Punkte — Vorlage anwenden kostet ${SKIN_COSTS.tplApply}.` });
      charged = SKIN_COSTS.tplApply;
    }
    try { await pushSkin(s.steamId, current, tpl); }
    catch (e) { if (charged) addPoints(s.steamId, charged); throw e; }
    res.json({ ok: true, charged, points: getPoints(s.steamId) });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.error });
    res.status(502).json({ error: e.message || 'Fehler' });
  }
});

// 🧟 Zombie-/Corpse-Look (0–1) — EXKLUSIV Obsidian (Backend-Erzwingung). Setzt den
// "forced body-gore"-Wert via Nyors /players/:id/zombie. Rein kosmetisch (kein Slay).
// Der Slider im Skin-Creator ruft das auf; Caddy: durch /me* abgedeckt.
app.post('/me/zombie', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (aboPerkIdx(s) < 3) return res.status(403).json({ error: 'Der Zombie-Look ist exklusiv für Obsidian.' });
  const value = Math.max(0, Math.min(1, Number(req.body?.value) || 0));
  try {
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/zombie`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }), signal: AbortSignal.timeout(8000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d.Msg || d.error || `HTTP ${r.status}` });
    res.json({ ok: true, value });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── 10) Öffentlicher Server-Status (für die Webseite, kein Login) ───────────
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS ?? '100');
app.get('/public/status', async (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const players = await fetchPlayers();
    res.json({ online: players.length, max: MAX_PLAYERS, up: true });
  } catch {
    res.json({ online: 0, max: MAX_PLAYERS, up: false });
  }
});

// Aktueller Abo-Rang eines Discord-Users (für die Website, KEIN Login nötig).
// Quelle = subscriptions.json (aktive PayPal-Abos). So zeigt die Abo-Seite den Rang
// auch bei bereits eingeloggten Nutzern, deren Login-Param fehlt.
app.get('/public/abo', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const did = String(req.query.discord_id || '').trim();
  if (!/^\d{5,25}$/.test(did)) return res.json({ tier: null });
  const subs = readJson(SUBSCRIPTIONS_FILE, {});
  const order = ['Knochen', 'Bernstein', 'Obsidian'];
  let tier = null;
  for (const meta of Object.values(subs)) {
    if (String(meta.discordId) === did && order.includes(meta.tier)
        && order.indexOf(meta.tier) > order.indexOf(tier || '')) tier = meta.tier;
  }
  res.json({ tier });
});

// ── Health ───────────────────────────────────────────────────────────────
app.get('/auth/health', (_req, res) => res.json({ ok: true }));

function htmlPage(title, msg, redirect, fallbackSession) {
  const fallback = fallbackSession ? `
    <div style="margin-top:20px;text-align:left">
      <p style="font-size:13px;margin-bottom:8px">Falls die App sich nicht automatisch anmeldet:</p>
      <textarea id="tok" readonly style="width:100%;height:90px;
        background:#120d24;color:#b3a9cc;border:1px solid #3a2d5c;border-radius:6px;
        font-size:11px;padding:8px;resize:none">${fallbackSession}</textarea>
      <button onclick="copyTok()" style="width:100%;margin-top:8px;background:#8b5cf6;color:#fff;
        border:0;border-radius:8px;padding:12px;font-size:14px;font-weight:600;cursor:pointer">
        📋 Token kopieren</button>
      <button onclick="location.href=${JSON.stringify(redirect)}" style="width:100%;margin-top:8px;
        background:transparent;color:#b3a9cc;border:1px solid #3a2d5c;border-radius:8px;
        padding:10px;font-size:13px;cursor:pointer">App öffnen</button>
      <div id="copied" style="color:#22c55e;font-size:13px;margin-top:8px;height:18px"></div>
    </div>
    <script>
      function copyTok(){
        var t=document.getElementById('tok');
        t.select(); t.setSelectionRange(0,99999);
        navigator.clipboard.writeText(t.value).then(function(){
          document.getElementById('copied').textContent='✅ Kopiert! Füge ihn in der App ein.';
        }).catch(function(){
          document.execCommand('copy');
          document.getElementById('copied').textContent='✅ Kopiert!';
        });
      }
    </script>` : '';
  // Automatischer Rücksprung zur App (http-Loopback → kein Browser-Block).
  const autoRedirect = (redirect && fallbackSession)
    ? `<script>setTimeout(function(){location.href=${JSON.stringify(redirect)}},250)</script>`
    : '';
  return `<!doctype html><html lang="de"><head><meta charset="utf8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BlackFossil</title>
  <style>body{font-family:system-ui;background:#0f0a1e;color:#eee;display:flex;
  align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
  .card{background:#1a1330;padding:36px;border-radius:16px;max-width:440px;border:1px solid #3a2d5c}
  h1{font-size:22px;margin:0 0 12px}p{color:#b3a9cc;line-height:1.5}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${msg}</p>${fallback}</div>${autoRedirect}</body></html>`;
}

// ── PayPal-Webhook: Abo-Status → Discord-Rolle ─────────────────────────────
// PayPal ruft diesen Endpoint bei Subscription-Events auf. custom_id = Discord-ID
// (von der Website beim Kauf gesetzt), plan_id → Rolle (Knochen/Bernstein/Obsidian).
// ── Abo-Buchhaltung (geteilte Daten-Files in BOT_DATA_DIR) ──────────────────
const SUBSCRIPTIONS_FILE = `${BOT_DATA_DIR}/subscriptions.json`;   // subId → {discordId, creatorCode, planId, tier, startedAt}
const LEDGER_FILE        = `${BOT_DATA_DIR}/revenue_ledger.json`;  // [{Zahlung}] für die Buchhaltung
const CREATOR_CODES_FILE = `${BOT_DATA_DIR}/creator_codes.json`;   // { "code"(lowercase): {name, share 0..1} }
// Creator-Code → {code, name, share}. Unbekannter/leerer Code → null.
function creatorForCode(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const cfg = readJson(CREATOR_CODES_FILE, {});
  const e = cfg[c.toLowerCase()];
  return e ? { code: c, name: e.name ?? c, share: Math.max(0, Math.min(1, Number(e.share) || 0)) } : { code: c, name: null, share: 0 };
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Abo-Willkommens-Bonus (Punkte je Rang, aufsteigend) ──────────────────────
// Beim Abschluss/Upgrade eines Rangs gibt es einmalig Punkte gutgeschrieben.
const ABO_BONUS = { Knochen: 1000, Bernstein: 1500, Obsidian: 2000 };
const ABO_BONUS_FILE = `${BOT_DATA_DIR}/abo_bonus.json`;   // { discordId: höchster bereits gutgeschriebener Bonus }
// VORVERKAUF-STICHTAG: Abos werden schon vorher verkauft (Rolle/Badge sofort), aber die
// Ingame-Vorteile (Bonus-Punkte) zünden erst ab diesem Zeitpunkt. ISO-Datum in der ENV setzen
// (z. B. ABO_PERKS_START=2026-07-01T00:00:00+02:00). Leer/ungültig = sofort aktiv (kein Stichtag).
const ABO_PERKS_START = process.env.ABO_PERKS_START ? Date.parse(process.env.ABO_PERKS_START) : 0;
function aboPerksLive() { return !ABO_PERKS_START || Number.isNaN(ABO_PERKS_START) || Date.now() >= ABO_PERKS_START; }
// Schreibt den Bonus für den (höchsten je erreichten) Rang gut. Farm-sicher: nur die
// Differenz zum bisher höchsten Bonus, also kein Mehrfach-Kassieren durch Kündigen+Neuabschluss
// oder Hoch-/Runterstufen. Vor dem Stichtag bzw. ohne Steam-Verknüpfung → pending; der stündliche
// reconcileSubscriptions holt den Bonus automatisch nach (nahtlos, sobald beides erfüllt ist).
function grantAboBonus(discordId, roleName) {
  const target = ABO_BONUS[roleName] || 0;
  if (!target) return { granted: 0, pending: false, reason: null };
  if (!aboPerksLive()) return { granted: 0, pending: true, reason: 'date' };   // Vorverkauf → später nachholen
  const steamId = lookupSteamId(discordId);
  if (!steamId) return { granted: 0, pending: true, reason: 'no-steam' };       // Steam fehlt → später nachholen
  // Differenz innerhalb des Locks bestimmen + Marker persistieren; Punkte danach buchen (eigenes Lock).
  const delta = withFileLock(ABO_BONUS_FILE, () => {
    const all = readJson(ABO_BONUS_FILE, {});
    const prev = Number(all[discordId] || 0);
    if (target <= prev) return 0;
    all[discordId] = target;
    writeJsonFile(ABO_BONUS_FILE, all);
    return target - prev;
  });
  if (delta > 0) addPoints(steamId, delta);
  return { granted: delta, pending: false, reason: null };
}

app.post('/paypal/webhook', express.json({ type: '*/*', limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const event = req.body || {};
  try {
    if (!PAYPAL_WEBHOOK_ID || !PAYPAL_CLIENT_ID) {
      console.error('PayPal-Webhook: nicht konfiguriert (PAYPAL_WEBHOOK_ID/CLIENT_ID fehlen)');
      return res.sendStatus(503);
    }
    if (!(await verifyPaypalWebhook(req.headers, req.rawBody))) {
      console.warn('PayPal-Webhook: ungültige Signatur — verworfen');
      return res.sendStatus(400);
    }
    const type = event.event_type || '';
    const rsc = event.resource || {};

    if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const [didRaw, codeRaw] = String(rsc.custom_id || '').split('|');
      const discordId = (didRaw || '').trim();
      const creatorCode = (codeRaw || '').trim();
      const roleName = PAYPAL_PLANS[rsc.plan_id || ''];
      if (!/^\d{5,25}$/.test(discordId) || !roleName) {
        console.warn(`PayPal-Webhook: ACTIVATED ohne gültige discordId/plan_id — ignoriert`);
        return res.sendStatus(200);
      }
      // Genau EINEN Tier halten: andere Abo-Rollen entziehen, neue vergeben
      for (const other of ALL_TIER_ROLES) {
        if (other !== roleName) { try { await setMemberRole(discordId, other, false); } catch {} }
      }
      await setMemberRole(discordId, roleName, true);
      // Upgrade-Sauberkeit: ältere noch laufende Abos desselben Users bei PayPal kündigen,
      // damit beim Hoch-/Runterstufen nicht doppelt abgebucht wird (neues Abo ersetzt das alte).
      const priorSubs = readJson(SUBSCRIPTIONS_FILE, {});
      for (const [oldId, meta] of Object.entries(priorSubs)) {
        if (oldId !== rsc.id && String(meta.discordId) === discordId) {
          await paypalCancelSubscription(oldId).catch(() => {});
          withFileLock(SUBSCRIPTIONS_FILE, () => { const s = readJson(SUBSCRIPTIONS_FILE, {}); delete s[oldId]; writeJsonFile(SUBSCRIPTIONS_FILE, s); });
          console.log(`🔁 Altes Abo ${oldId} von ${discordId} gekündigt (Wechsel auf ${roleName})`);
        }
      }
      // Subscription-Mapping merken → spätere Zahlungen dem Creator-Code zuordnen
      withFileLock(SUBSCRIPTIONS_FILE, () => {
        const subs = readJson(SUBSCRIPTIONS_FILE, {});
        subs[rsc.id] = { discordId, creatorCode, planId: rsc.plan_id || '', tier: roleName, startedAt: Date.now() };
        writeJsonFile(SUBSCRIPTIONS_FILE, subs);
      });
      // Willkommens-Bonus-Punkte gutschreiben (aufsteigend je Rang, einmalig je Stufe)
      const bonus = grantAboBonus(discordId, roleName);
      // Willkommens-DM (fire-and-forget, blockiert die Webhook-Antwort nicht)
      const bonusLine = bonus.granted > 0
        ? `\n\n💰 Als Willkommens-Bonus wurden dir **${bonus.granted} Punkte** gutgeschrieben.`
        : bonus.reason === 'date'
          ? `\n\n🚀 **Vorverkauf:** Dein Willkommens-Bonus (**${ABO_BONUS[roleName]} Punkte**) wird automatisch gutgeschrieben, sobald die Ingame-Vorteile live sind. Verknüpfe schon mal deinen Steam-Account im Discord, dann klappt's nahtlos.`
          : bonus.reason === 'no-steam'
            ? `\n\n💰 Deine Bonus-Punkte für **${roleName}** liegen bereit — verknüpfe deinen Steam-Account im Discord, dann werden sie automatisch gutgeschrieben.`
            : '';
      sendDiscordDM(discordId,
        `🎉 Danke für deine Unterstützung! Dein Rang **${roleName}** ist jetzt aktiv. ❤️` +
        bonusLine +
        `\n\nKündigen kannst du jederzeit selbst in deinem PayPal-Konto unter „Einstellungen → Automatische Zahlungen".`
      ).catch(() => {});
      console.log(`✅ Abo aktiv: ${discordId} → ${roleName}${creatorCode ? ` (Code ${creatorCode})` : ''}${bonus.granted ? ` (+${bonus.granted} Punkte)` : bonus.reason ? ` (Bonus pending: ${bonus.reason})` : ''}`);

    } else if (['BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.SUSPENDED'].includes(type)) {
      const discordId = String(rsc.custom_id || '').split('|')[0].trim();
      const roleName = PAYPAL_PLANS[rsc.plan_id || ''];
      if (/^\d{5,25}$/.test(discordId) && roleName) {
        await setMemberRole(discordId, roleName, false);
        console.log(`⛔ Abo beendet (${type}): ${discordId} → ${roleName} entzogen`);
      }

    } else if (type === 'PAYMENT.SALE.COMPLETED') {
      // Jede (auch wiederkehrende) Abo-Zahlung → Einnahmen-Ledger
      const subId = rsc.billing_agreement_id || '';   // = Subscription-ID bei Abos
      const txId = rsc.id || '';
      if (!subId || !txId) return res.sendStatus(200);   // Nicht-Abo-Zahlung → ignorieren
      const gross = round2(rsc.amount?.total);
      const fee = round2(rsc.transaction_fee?.value);
      const net = round2(gross - fee);
      const meta = readJson(SUBSCRIPTIONS_FILE, {})[subId] || {};
      const creator = creatorForCode(meta.creatorCode);
      const creatorShare = creator ? round2(net * creator.share) : 0;
      const entry = {
        txId, subId, provider: 'paypal',
        date: rsc.create_time || new Date().toISOString(),
        discordId: meta.discordId || null,
        tier: meta.tier || null,
        currency: rsc.amount?.currency || 'EUR',
        gross, fee, net,
        creatorCode: creator?.code || '',
        creatorName: creator?.name || null,
        creatorSharePct: creator ? creator.share : 0,
        creatorShare,
        houseShare: round2(net - creatorShare),
        payoutStatus: 'offen',
      };
      withFileLock(LEDGER_FILE, () => {
        const ledger = readJson(LEDGER_FILE, []);
        if (ledger.some((e) => e.txId === txId)) return;   // Dedup (PayPal sendet Events ggf. mehrfach)
        ledger.push(entry);
        writeJsonFile(LEDGER_FILE, ledger);
      });
      console.log(`💶 Zahlung gebucht: ${gross} ${entry.currency} (netto ${net})${entry.creatorCode ? ` → ${entry.creatorCode} ${creatorShare}` : ''}`);
    }

    res.sendStatus(200);
  } catch (e) {
    // Nicht-2xx → PayPal wiederholt das Event (gut bei transienten Fehlern)
    console.error('PayPal-Webhook-Fehler:', e.message);
    res.sendStatus(500);
  }
});

// ── Stripe (Karten-Abos, parallel zu PayPal) ────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const STRIPE_PRICES = {
  Knochen: process.env.STRIPE_PRICE_KNOCHEN ?? '',
  Bernstein: process.env.STRIPE_PRICE_BERNSTEIN ?? '',
  Obsidian: process.env.STRIPE_PRICE_OBSIDIAN ?? '',
};
// Form-encoded POST an die Stripe-API (Bearer-Auth).
async function stripeApi(path, params) {
  const r = await fetch('https://api.stripe.com' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Stripe HTTP ${r.status}`);
  return d;
}
async function stripeGet(path) {
  const r = await fetch('https://api.stripe.com' + path, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Stripe HTTP ${r.status}`);
  return d;
}
// Stripe-Webhook-Signatur prüfen: Header `t=…,v1=…`, HMAC-SHA256 über `${t}.${rawBody}`.
function verifyStripeSig(rawBody, sigHeader) {
  try {
    if (!sigHeader || !STRIPE_WEBHOOK_SECRET || !rawBody) return null;
    const parts = Object.fromEntries(String(sigHeader).split(',').map((kv) => kv.split('=')));
    if (!parts.t || !parts.v1) return null;
    const expected = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${rawBody.toString('utf8')}`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(parts.v1);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return null;   // 5-Min-Replay-Schutz
    return JSON.parse(rawBody.toString('utf8'));
  } catch { return null; }
}

// Checkout-Session erzeugen — Discord-ID als client_reference_id (wie PayPals custom_id).
app.post('/stripe/checkout', express.json(), async (req, res) => {
  const tier = String(req.body?.tier || '').trim();
  const discordId = String(req.body?.discordId || '').trim();
  const creatorCode = String(req.body?.creatorCode || '').trim().slice(0, 50);
  const priceId = STRIPE_PRICES[tier];
  if (!priceId) return res.status(400).json({ error: 'Ungültiger Rang.' });
  if (!/^\d{5,25}$/.test(discordId)) return res.status(400).json({ error: 'Bitte zuerst mit Discord einloggen.' });
  try {
    const s = await stripeApi('/v1/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      client_reference_id: discordId,
      'metadata[discordId]': discordId,
      'metadata[tier]': tier,
      'metadata[creatorCode]': creatorCode,
      'subscription_data[metadata][discordId]': discordId,
      'subscription_data[metadata][tier]': tier,
      'subscription_data[metadata][creatorCode]': creatorCode,
      allow_promotion_codes: 'true',
      locale: 'de',
      success_url: 'https://www.blackfossil.de/abo?paid=1',
      cancel_url: 'https://www.blackfossil.de/abo?cancel=1',
    });
    res.json({ url: s.url });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Stripe-Webhook: Abo-Aktivierung/Kündigung → Rolle + Willkommens-Bonus (spiegelt PayPal).
app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const event = verifyStripeSig(req.body, req.headers['stripe-signature']);
  if (!event) { console.warn('Stripe-Webhook: ungültige Signatur — verworfen'); return res.sendStatus(400); }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.mode === 'subscription' && s.payment_status === 'paid') {
        const discordId = String(s.client_reference_id || s.metadata?.discordId || '').trim();
        const tier = s.metadata?.tier;
        const creatorCode = s.metadata?.creatorCode || '';
        const subId = s.subscription;
        if (/^\d{5,25}$/.test(discordId) && ALL_TIER_ROLES.includes(tier) && subId) {
          for (const other of ALL_TIER_ROLES) if (other !== tier) { try { await setMemberRole(discordId, other, false); } catch {} }
          await setMemberRole(discordId, tier, true);
          withFileLock(SUBSCRIPTIONS_FILE, () => {
            const subs = readJson(SUBSCRIPTIONS_FILE, {});
            subs[subId] = { discordId, creatorCode, provider: 'stripe', tier, startedAt: Date.now() };
            writeJsonFile(SUBSCRIPTIONS_FILE, subs);
          });
          const bonus = grantAboBonus(discordId, tier);
          sendDiscordDM(discordId,
            `🎉 Danke für deine Unterstützung! Dein Rang **${tier}** ist jetzt aktiv. ❤️` +
            (bonus.granted > 0 ? `\n\n💰 Willkommens-Bonus: **${bonus.granted} Punkte** gutgeschrieben.` : '') +
            `\n\nKündigen kannst du jederzeit über den Link in deiner Stripe-Zahlungsbestätigung.`
          ).catch(() => {});
          console.log(`✅ Stripe-Abo aktiv: ${discordId} → ${tier}${creatorCode ? ` (Code ${creatorCode})` : ''}${bonus.granted ? ` (+${bonus.granted} Punkte)` : bonus.reason ? ` (Bonus pending: ${bonus.reason})` : ''}`);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const discordId = String(sub.metadata?.discordId || '').trim();
      const tier = sub.metadata?.tier;
      if (/^\d{5,25}$/.test(discordId) && ALL_TIER_ROLES.includes(tier)) {
        try { await setMemberRole(discordId, tier, false); } catch {}
        withFileLock(SUBSCRIPTIONS_FILE, () => { const subs = readJson(SUBSCRIPTIONS_FILE, {}); delete subs[sub.id]; writeJsonFile(SUBSCRIPTIONS_FILE, subs); });
        console.log(`⛔ Stripe-Abo gekündigt: ${discordId} → ${tier} entzogen`);
      }
    } else if (event.type === 'invoice.paid') {
      // Jede (auch wiederkehrende) Zahlung → Einnahmen-Ledger (spiegelt PayPals PAYMENT.SALE.COMPLETED).
      const inv = event.data.object;
      const subId = inv.subscription, txId = inv.id;
      if (subId && txId) {
        let meta = readJson(SUBSCRIPTIONS_FILE, {})[subId] || {};
        if (!meta.discordId) {   // Ereignis-Reihenfolge nicht garantiert → notfalls aus der Subscription lesen
          try { const sub = await stripeGet(`/v1/subscriptions/${subId}`); meta = { discordId: sub.metadata?.discordId, tier: sub.metadata?.tier, creatorCode: sub.metadata?.creatorCode }; } catch {}
        }
        const gross = round2((inv.amount_paid ?? inv.total ?? 0) / 100);
        let fee = 0;
        try { if (inv.charge) { const ch = await stripeGet(`/v1/charges/${inv.charge}?expand[]=balance_transaction`); fee = round2((ch.balance_transaction?.fee ?? 0) / 100); } } catch {}
        const net = round2(gross - fee);
        const creator = creatorForCode(meta.creatorCode);
        const creatorShare = creator ? round2(net * creator.share) : 0;
        const entry = {
          txId, subId, provider: 'stripe',
          date: new Date((inv.created ?? Date.now() / 1000) * 1000).toISOString(),
          discordId: meta.discordId || null, tier: meta.tier || null,
          currency: (inv.currency || 'eur').toUpperCase(),
          gross, fee, net,
          creatorCode: creator?.code || '', creatorName: creator?.name || null,
          creatorSharePct: creator ? creator.share : 0, creatorShare,
          houseShare: round2(net - creatorShare), payoutStatus: 'offen',
        };
        withFileLock(LEDGER_FILE, () => {
          const ledger = readJson(LEDGER_FILE, []);
          if (ledger.some((e) => e.txId === txId)) return;   // Dedup
          ledger.push(entry); writeJsonFile(LEDGER_FILE, ledger);
        });
        console.log(`💶 Stripe-Zahlung gebucht: ${gross} ${entry.currency} (netto ${net})${entry.creatorCode ? ` → ${entry.creatorCode} ${creatorShare}` : ''}`);
      }
    }
    res.sendStatus(200);
  } catch (e) { console.error('Stripe-Webhook-Fehler:', e.message); res.sendStatus(500); }
});

// Kündigung durch den Nutzer (Abo-Seite) — abgesichert über das signierte Web-Token (wtoken),
// NICHT über eine ungeprüfte discordId (sonst könnte jeder fremde Abos kündigen).
app.post('/me/cancel-subscription', express.json(), async (req, res) => {
  let discordId;
  try { const p = jwt.verify(String(req.body?.wtoken || ''), SESSION_SECRET); discordId = String(p.discordId || ''); }
  catch { return res.status(401).json({ error: 'Bitte neu mit Discord einloggen.' }); }
  if (!/^\d{5,25}$/.test(discordId)) return res.status(401).json({ error: 'Ungültige Sitzung.' });
  const subs = readJson(SUBSCRIPTIONS_FILE, {});
  const mine = Object.entries(subs).filter(([, m]) => String(m.discordId) === discordId);
  if (!mine.length) return res.status(404).json({ error: 'Kein aktives Abo gefunden.' });
  let cancelled = 0; let stripeOnly = true;
  for (const [subId, m] of mine) {
    try {
      if (m.provider === 'stripe') { await stripeApi(`/v1/subscriptions/${subId}`, { cancel_at_period_end: 'true' }); }
      else { stripeOnly = false; await paypalCancelSubscription(subId, 'Kündigung durch Nutzer'); }
      cancelled++;
    } catch (e) { console.error('Kündigung fehlgeschlagen:', subId, e.message); }
  }
  // Rollen-Entzug läuft über die Provider-Webhooks (Stripe: zum Periodenende; PayPal: sofort).
  res.json({ ok: cancelled > 0, cancelled, atPeriodEnd: stripeOnly });
});

// ── Periodischer Abgleich: aktive PayPal-Abos ↔ Discord-Rollen ──────────────
// Fängt Fälle ab, in denen ein Webhook verloren ging (Rolle nicht vergeben, oder
// Kündigung verpasst). Geht NUR über die uns bekannten Subscriptions (subscriptions.json).
async function reconcileSubscriptions() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !DISCORD_BOT_TOKEN) return;
  const subs = readJson(SUBSCRIPTIONS_FILE, {});
  const ids = Object.keys(subs);
  if (!ids.length) return;
  let synced = 0, ended = 0;
  for (const subId of ids) {
    try {
      const meta = subs[subId] || {};
      if (meta.provider === 'stripe') continue;   // Stripe-Abos laufen über den Stripe-Webhook, nicht PayPal
      const roleName = meta.tier;
      const did = String(meta.discordId || '');
      if (!roleName || !/^\d{5,25}$/.test(did)) continue;
      const sub = await paypalGetSubscription(subId);
      if (!sub || !sub.status) continue;
      if (sub.status === 'ACTIVE') {
        await setMemberRole(did, roleName, true).catch(() => {}); synced++;
        // Bonus-Punkte nachholen, falls beim Kauf noch kein Steam verknüpft war (idempotent).
        try { grantAboBonus(did, roleName); } catch {}
      } else if (['CANCELLED', 'EXPIRED', 'SUSPENDED'].includes(sub.status)) {
        await setMemberRole(did, roleName, false).catch(() => {});
        withFileLock(SUBSCRIPTIONS_FILE, () => { const s = readJson(SUBSCRIPTIONS_FILE, {}); delete s[subId]; writeJsonFile(SUBSCRIPTIONS_FILE, s); });
        ended++;
      }
      await new Promise((r) => setTimeout(r, 400));   // Drossel gegen Rate-Limits
    } catch { /* einzelnes Abo überspringen */ }
  }
  if (synced || ended) console.log(`🔄 Abo-Abgleich: ${synced} aktiv bestätigt, ${ended} beendet/entfernt`);
}
setInterval(() => { reconcileSubscriptions().catch(() => {}); }, 60 * 60_000).unref?.();   // stündlich

// ── Spezies-Limit: native Durchsetzung über Nyors class-limits ──────────────
// Nyors entfernt eine Spezies bei Erreichen des Caps aus dem Spawn-Picker (KEIN Kill,
// kein Parken, bestehende Dinos bleiben). Wir spiegeln dinolimits.json in die Nyors-API:
// gesetzte Limits (bulk) upserten, entfernte löschen, Feature aktivieren. Kill-Switch:
// SPECIES_LIMIT_ENFORCE=0. (Der alte reaktive Slay-Job ist damit ersetzt.)
async function nyClassLimit(method, path, body) {
  const r = await fetch(`${PANEL_BASE_URL}${path}`, {
    method, headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
  return r.json().catch(() => ({}));
}
async function syncNyorsClassLimits() {
  const want = readJson(DINO_LIMITS_FILE, {});
  const wantArr = Object.entries(want)
    .filter(([, v]) => Number(v) > 0)
    .map(([cls, lim]) => ({ class: cls, limit: Math.max(0, Math.floor(Number(lim))) }));
  const wantKeys = new Set(wantArr.map((x) => x.class.toLowerCase()));
  // Aktuelle Nyors-Caps holen → früher gesetzte, jetzt nicht mehr gewünschte Limits wieder freigeben.
  let current = [];
  try { current = (await nyClassLimit('GET', '/world/class-limits')).classes || []; } catch {}
  for (const c of current) {
    if (typeof c.limit === 'number' && c.limit >= 0 && !wantKeys.has(String(c.class).toLowerCase())) {
      await nyClassLimit('DELETE', `/world/class-limits/${encodeURIComponent(c.class)}`).catch(() => {});
    }
  }
  if (wantArr.length) await nyClassLimit('POST', '/world/class-limits', wantArr);   // bulk upsert (Array!)
  await nyClassLimit('PATCH', '/world/class-limits/status', { class_limits_enabled: wantArr.length > 0 });
  return wantArr.length;
}
if ((process.env.SPECIES_LIMIT_ENFORCE ?? '1') === '1') {
  const run = () => syncNyorsClassLimits()
    .then((n) => console.log(`🦖 Nyors class-limits synchronisiert (${n} Limit(s) aktiv)`))
    .catch((e) => console.error('Nyors class-limit sync:', e.message));
  setTimeout(run, 8000);                      // kurz nach Start
  setInterval(run, 5 * 60_000).unref?.();     // Reconcile — überlebt Game-Server-Neustarts
  console.log('✅ Spezies-Limit (nativ via Nyors class-limits) aktiv');
}
setTimeout(() => { reconcileSubscriptions().catch(() => {}); }, 90_000).unref?.();           // einmal ~90s nach Start

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Token-Service läuft auf 127.0.0.1:${PORT}`);
  console.log(`   Redirect-URI: ${REDIRECT_URI}`);
  console.log(`   accounts.json: ${ACCOUNTS_PATH}`);
});
