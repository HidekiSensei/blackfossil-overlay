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
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { AccessToken } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';

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
const RANK_ROLES = (process.env.RANK_ROLES ?? 'Owner,Admin,Support,Beta Tester,Fossil').split(',').map((s) => s.trim());
// Welche Ränge zählen als Admin bzw. Team
const ADMIN_RANKS = (process.env.ADMIN_RANKS ?? 'Owner,Admin').split(',').map((s) => s.trim());
const TEAM_RANKS  = (process.env.TEAM_RANKS  ?? 'Owner,Admin,Support').split(',').map((s) => s.trim());

// ── Discord-Rollen-Check (Admin + Tier + Staff-Rang) ────────────────────────
async function getDiscordStatus(discordId) {
  const result = { admin: false, team: false, rank: 'Fossil', tier: 'Fossil', staff: null };
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
    result.staff = null;         // kein zweites Badge mehr
    result.admin = ADMIN_RANKS.includes(rank);
    result.team = TEAM_RANKS.includes(rank);
    return result;
  } catch {
    return result;
  }
}

// ── OAuth State (kurzlebig, in-memory) ─────────────────────────────────────
const stateStore = new Map(); // state -> timestamp
function newState() {
  const s = randomBytes(16).toString('hex');
  stateStore.set(s, Date.now());
  // Alte States (>10 min) aufräumen
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, t] of stateStore) if (t < cutoff) stateStore.delete(k);
  return s;
}

const app = express();

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

// ── 2) Discord-Callback ──────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || !stateStore.has(state)) {
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

    // Steam-ID nachschlagen
    const steamId = lookupSteamId(user.id);
    if (!steamId) {
      return res.status(403).send(htmlPage(
        '⚠️ Account nicht verknüpft',
        'Dein Discord-Account ist noch nicht mit Steam verknüpft. Bitte verknüpfe ihn zuerst im Discord über den ACCOUNT-LINK-Button.'
      ));
    }

    // Höchster Rang + abgeleitete Rechte anhand Discord-Rollen
    const { admin, team, rank, tier, staff } = await getDiscordStatus(user.id);

    // App-Session ausstellen (30 Tage)
    const session = jwt.sign(
      { steamId, discordId: user.id, name: user.global_name || user.username, admin, team, rank, tier, staff, avatar: user.avatar ?? null },
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

  res.json({
    token: await at.toJwt(),
    url: LIVEKIT_URL,
    room: PROXIMITY_ROOM,
    identity: payload.steamId,
    name: payload.name,
    admin: !!payload.admin,
    team: isTeamMember(payload),
    rank: payload.rank || payload.tier || 'Fossil',
    tier: payload.rank || payload.tier || 'Fossil',
    staff: null,
  });
});

// Overlay-Aktivität: wer pollt /positions = hat das Overlay an. Für die Overlay-Pflicht.
const overlayActivity = {}; // steamId → lastSeen-ts (in-memory, periodisch in Datei geflusht)

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
    const r = await fetch(`${PANEL_BASE_URL}/players`, {
      headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Game-Server HTTP ${r.status}`);
    const data = await r.json();
    const ovMembers = new Set(ovMembersOf(readOv(), payload.steamId));
    const players = (data.Players ?? []).map((p) => ({
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
    res.json({ players, you: payload.steamId, toasts });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── 4b) Eigene Dino-Stats ──────────────────────────────────────────────────
app.get('/me', async (req, res) => {
  const auth = req.headers.authorization ?? '';
  const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!sessionToken) return res.status(401).json({ error: 'Keine Session' });
  let payload;
  try { payload = jwt.verify(sessionToken, SESSION_SECRET); }
  catch { return res.status(401).json({ error: 'Session ungültig' }); }

  try {
    const r = await fetch(`${PANEL_BASE_URL}/players`, {
      headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Game-Server HTTP ${r.status}`);
    const data = await r.json();
    const points = getPoints(payload.steamId);
    const tier = payload.tier || 'Fossil';
    const p = (data.Players ?? []).find((x) => x.steamId === payload.steamId);
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
  if (!isTeamMember(payload)) return res.status(403).json({ error: 'Nur für das Team' });

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
  const all = readJson(INVENTORY_FILE, {});
  const have = all[steamId]?.[type] ?? 0;
  if (have < 1) return false;
  all[steamId][type] = have - 1;
  writeJsonFile(INVENTORY_FILE, all);
  return true;
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

function cooldownRemaining(steamId, action) {
  const store = readJson(COOLDOWNS_FILE, {});
  const until = store[steamId]?.[action] ?? 0;
  return Math.max(0, until - Date.now());
}
function startCooldown(steamId, action) {
  const store = readJson(COOLDOWNS_FILE, {});
  if (!store[steamId]) store[steamId] = {};
  const dur = action === 'park' ? PARK_COOLDOWN_MS : action === 'swap' ? SWAP_COOLDOWN_MS : UNPACK_COOLDOWN_MS;
  store[steamId][action] = Date.now() + dur;
  writeJsonFile(COOLDOWNS_FILE, store);
}
function fmtCooldown(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return m > 0 ? `${m} Min ${String(s).padStart(2, '0')} Sek` : `${s} Sek`;
}

// Swap-Regeln (identisch zum Bot)
const SWAP_COOLDOWN_MS = parseInt(process.env.SWAP_COOLDOWN_MIN ?? '5', 10) * 60_000; // TEST: 5 Min (normal 60)
const SWAP_MIN_HEALTH = 1.0;
const SWAP_MIN_STAMINA = 0.75;
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

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(file, data) {
  // Atomar: temp schreiben + umbenennen (verhindert halb geschriebene garage.json bei Parallelzugriff)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
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
  try { return jwt.verify(t, SESSION_SECRET); } catch { return null; }
}
// Team = Owner/Admin/Support — darf Admin-Menü + TP/Kalibrierung nutzen.
// (s.staff als Fallback für alte Sessions; FORCE_TEAM_STEAMIDS als harte Garantie.)
const FORCE_TEAM_STEAMIDS = (process.env.FORCE_TEAM_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const FORCE_ADMIN_STEAMIDS = (process.env.FORCE_ADMIN_STEAMIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
function isTeamMember(s) {
  return !!(s && (s.team || s.admin || s.staff || FORCE_TEAM_STEAMIDS.includes(s.steamId)));
}
// Admin = NUR Owner/Admin (kein Support). Gilt für das ganze Admin-Panel.
function isAdminMember(s) {
  return !!(s && (s.admin || FORCE_ADMIN_STEAMIDS.includes(s.steamId)));
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
  if (!isTeamMember(s)) return res.status(403).json({ error: 'Nur für das Team' });
  try { const r = await controlFetch('/ai/status', 'GET'); return res.status(r.status).json(r.data); }
  catch (e) { return res.status(502).json({ error: e.message }); }
});
app.post('/admin/ai/:action', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isTeamMember(s)) return res.status(403).json({ error: 'Nur für das Team' });
  const path = AI_ACTION_PATHS[req.params.action];
  if (!path) return res.status(400).json({ error: 'Unbekannte Aktion' });
  try {
    const r = await controlFetch(path, 'POST', req.body || {});
    return res.status(r.status).json(r.data);
  } catch (e) { return res.status(502).json({ error: e.message }); }
});
async function fetchPlayers() {
  const r = await fetch(`${PANEL_BASE_URL}/players`, {
    headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Game-Server HTTP ${r.status}`);
  return (await r.json()).Players ?? [];
}

// ── Admin-Verwaltung (NUR Admin): User-Info, Lightning, Beschenken ───────────
function addPoints(steamId, n) { setPointsVal(steamId, getPoints(steamId) + n); }
function addToken(steamId, type, n) {
  const all = readJson(INVENTORY_FILE, {});
  if (!all[steamId]) all[steamId] = {};
  all[steamId][type] = (all[steamId][type] ?? 0) + n;
  writeJsonFile(INVENTORY_FILE, all);
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

// Liste aller verknüpften Discord-User (für das Such-Dropdown)
app.get('/admin/users', async (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
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
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
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
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
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
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
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

// Beschenken: Punkte/Token an einen User, eine Rolle oder alle Online
app.post('/admin/gift', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!isAdminMember(s)) return res.status(403).json({ error: 'Nur für Admins' });
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

// Eigene Support-Tickets (Status, Bearbeiter, neue-Nachricht-Flag) fürs Overlay
app.get('/me/tickets', async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const all = readJson(`${BOT_DATA_DIR}/tickets.json`, {});
  // Eigene Tickets (als Ersteller) + Tickets, die man als Team-Mitglied bearbeitet (claimedBy)
  const mine = Object.entries(all).filter(([, m]) => m && (m.openerId === s.discordId || m.claimedBy === s.discordId));
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
    // 'handler' = ich bearbeite das Ticket (nicht selbst eröffnet), sonst 'opener'
    role: m.openerId === s.discordId ? 'opener' : 'handler',
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
    const raw = await discordApi(`/channels/${channelId}/messages?limit=25`);
    const messages = (Array.isArray(raw) ? raw : [])
      .filter((x) => x && x.author && !x.author.bot)               // keine Bot-Embeds/Systemmeldungen
      .reverse()                                                   // Discord liefert neueste zuerst → chronologisch
      .map((x) => ({
        id: x.id,
        author: (x.member && x.member.nick) || (x.author.global_name) || x.author.username || '?',
        fromMe: x.author.id === s.discordId,
        content: (x.content || '').slice(0, 600),
        hasAttachment: Array.isArray(x.attachments) && x.attachments.length > 0,
        at: x.timestamp ? Date.parse(x.timestamp) : 0,
      }));
    res.json({ ticketId: m.ticketId, category: m.category, messages });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
      if (interested) out.push({ id: ev.id, name: ev.name, start: ev.scheduled_start_time, description: (ev.description || '').slice(0, 200), userCount: ev.user_count ?? null });
    }
    out.sort((a, b) => new Date(a.start || 0) - new Date(b.start || 0));
    res.json({ events: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Overlay-Gruppen (diät-übergreifend, rein overlay-verwaltet) ──────────────
const OVGROUPS_FILE = `${BOT_DATA_DIR}/ovgroups.json`;
const DIET = {
  Tyrannosaurus: 'carni', Rex: 'carni', Allosaurus: 'carni', Carnotaurus: 'carni', Ceratosaurus: 'carni', Deinosuchus: 'carni', Dilophosaurus: 'carni', Herrerasaurus: 'carni', Omniraptor: 'carni', Pteranodon: 'carni', Troodon: 'carni',
  Triceratops: 'herbi', Stegosaurus: 'herbi', Diabloceratops: 'herbi', Tenontosaurus: 'herbi', Maiasaura: 'herbi', Maiasaurus: 'herbi', Pachycephalosaurus: 'herbi', Dryosaurus: 'herbi', Hypsilophodon: 'herbi',
  Gallimimus: 'both', Beipiaosaurus: 'both',
};
const dietOf = (dino) => DIET[dino] || 'both';
const sameDiet = (a, b) => { const x = dietOf(a), y = dietOf(b); return x === y || x === 'both' || y === 'both'; };
function readOv() { return readJson(OVGROUPS_FILE, { groups: {}, invites: [] }); }
function writeOv(d) { writeJsonFile(OVGROUPS_FILE, d); }
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
  if (!gid) { gid = genId(); ov.groups[gid] = { members: [s.steamId] }; }
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
    limit: TOKEN_LIMIT,
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
    // in Garage sichern
    const garage = readJson(GARAGE_FILE, {});
    if (!garage[s.steamId]) garage[s.steamId] = [];
    // Token-Limit prüfen
    if (garage[s.steamId].length >= TOKEN_LIMIT) {
      return res.status(409).json({ error: `Garage voll (${garage[s.steamId].length}/${TOKEN_LIMIT}). Verkaufe oder spiele zuerst einen aus.` });
    }
    garage[s.steamId].push({ id: genId(), savedAt: Date.now(), snapshot });
    writeJsonFile(GARAGE_FILE, garage);
    // Dino im Spiel einparken (despawn)
    const pr = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/pack`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!pr.ok) throw new Error(`Einparken fehlgeschlagen (${pr.status})`);
    startCooldown(s.steamId, 'park');
    res.json({ ok: true, dino: snapshot.dinoClass, count: garage[s.steamId].length, limit: TOKEN_LIMIT });
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
    startCooldown(s.steamId, 'unpack');
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

    // Sicherheits-Checks (identisch zum Discord-Swap)
    if (current.isBleeding) return res.status(409).json({ error: 'Swap nicht möglich: Dein Dino blutet (im Kampf).' });
    if ((current.health ?? 0) < SWAP_MIN_HEALTH) return res.status(409).json({ error: `Swap nicht möglich: Health muss 100% sein (aktuell ${Math.round((current.health ?? 0) * 100)}%).` });
    if ((current.stamina ?? 0) < SWAP_MIN_STAMINA) return res.status(409).json({ error: `Swap nicht möglich: Stamina muss ≥ ${Math.round(SWAP_MIN_STAMINA * 100)}% sein (aktuell ${Math.round((current.stamina ?? 0) * 100)}%).` });
    const dist = nearestOtherPlayerM(current, players);
    if (dist < SWAP_MIN_DISTANCE_M) return res.status(409).json({ error: `Swap nicht möglich: Spieler zu nah (${Math.round(dist)} m, nötig ≥ ${SWAP_MIN_DISTANCE_M} m).` });

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
    isTeam: isTeamMember(s),
    isAdmin: isTeamMember(s), // abwärtskompatibel für ältere Overlay-Clients
  });
});

// TP-Punkt an aktueller Position erstellen (Team)
app.post('/teleports', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isTeamMember(s)) return res.status(403).json({ error: 'Nur für das Team' });
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

// TP-Punkt löschen (Team)
app.delete('/teleports/:id', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  if (!isTeamMember(s)) return res.status(403).json({ error: 'Nur für das Team' });
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
    const where = Number.isFinite(tp.z) ? { x: tp.x, y: tp.y, z: tp.z + TP_Z_OFFSET } : { x: tp.x, y: tp.y };
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/teleport`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ where }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Teleport fehlgeschlagen (${r.status})`);
    if (tp.price > 0) setPointsVal(s.steamId, pts - tp.price);
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
function setPointsVal(steamId, v) { const p = readJson(POINTS_FILE, {}); p[steamId] = Math.max(0, Math.round(v)); writeJsonFile(POINTS_FILE, p); }

// Marktplatz + eigener Kontostand
app.get('/market', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const market = readJson(MARKETPLACE_FILE, []);
  res.json({
    points: getPoints(s.steamId),
    offers: market.map((o) => ({ ...slotCard(o), price: o.price, mine: o.sellerSteamId === s.steamId })),
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
  setPointsVal(s.steamId, getPoints(s.steamId) + earned);
  garage[s.steamId] = slots.filter((x) => x.id !== slotId);
  writeJsonFile(GARAGE_FILE, garage);
  res.json({ ok: true, earned, points: getPoints(s.steamId) });
});

// An Spieler verkaufen (Marktplatz-Listing)
app.post('/market/sell-player', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const { slotId, price } = req.body ?? {};
  const p = parseInt(price);
  if (!Number.isFinite(p) || p <= 0) return res.status(400).json({ error: 'Ungültiger Preis' });
  const garage = readJson(GARAGE_FILE, {});
  const slots = garage[s.steamId] ?? [];
  const slot = slots.find((x) => x.id === slotId);
  if (!slot) return res.status(404).json({ error: 'Slot nicht gefunden' });
  const market = readJson(MARKETPLACE_FILE, []);
  market.push({ ...slot, sellerSteamId: s.steamId, price: p });
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
  const buyerPoints = getPoints(s.steamId);
  if (buyerPoints < offer.price) return res.status(402).json({ error: 'Nicht genug Punkte' });

  // Punkte verschieben
  setPointsVal(s.steamId, buyerPoints - offer.price);
  setPointsVal(offer.sellerSteamId, getPoints(offer.sellerSteamId) + offer.price);
  // Token in Käufer-Garage
  const garage = readJson(GARAGE_FILE, {});
  if (!garage[s.steamId]) garage[s.steamId] = [];
  garage[s.steamId].push({ id: genId(), savedAt: Date.now(), snapshot: offer.snapshot, ...(offer.label ? { label: offer.label } : {}) });
  writeJsonFile(GARAGE_FILE, garage);
  // Vom Markt nehmen
  writeJsonFile(MARKETPLACE_FILE, market.filter((o) => o.id !== offerId));
  res.json({ ok: true, points: getPoints(s.steamId), dino: offer.snapshot?.dinoClass });
});

// ── 9) Skin-Editor (Relay an Game-Server) ───────────────────────────────────
const TIER_ORDER = ['Fossil', 'Knochen', 'Bernstein', 'Obsidian'];
const SKIN_REQUIRE_TIER = process.env.SKIN_REQUIRE_TIER ?? ''; // leer = für alle frei

app.post('/skin', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  // Optionales Tier-Gate (später aktivierbar)
  if (SKIN_REQUIRE_TIER) {
    const have = TIER_ORDER.indexOf(s.tier || 'Fossil');
    const need = TIER_ORDER.indexOf(SKIN_REQUIRE_TIER);
    if (have < need) return res.status(403).json({ error: `Skin-Editor ab Tier "${SKIN_REQUIRE_TIER}"` });
  }
  // 1) Frischen Spieler-Status holen — Skin geht nur auf einem lebenden Ingame-Dino
  let current;
  try {
    current = (await fetchPlayers()).find((p) => p.steamId === s.steamId);
  } catch (err) {
    return res.status(502).json({ error: `Spielerdaten nicht erreichbar: ${err.message}` });
  }
  if (!current) return res.status(409).json({ error: 'Du musst im Spiel auf einem Dino sein, um den Skin zu ändern.' });
  if (current.isDead) return res.status(409).json({ error: 'Dein Dino ist tot — Skin kann nicht geändert werden.' });

  const b = req.body ?? {};
  // 2) Skin-Felder auf den FRISCHEN Snapshot mergen (kein veralteter/partieller Body)
  const payload = { ...current };
  payload.skinVariation = Number(b.skinVariation) || 0;
  payload.patternIndex = Number(b.patternIndex) || 0;
  payload.themeIndex = Number(b.themeIndex) || 0;
  for (const k of ['maleDisplayColor', 'markingsColor', 'bodyColor', 'flankColor', 'underbellyColor', 'teethColor', 'mouthColor', 'clawsColor', 'detailColor', 'eyesColor']) {
    // The Isle behandelt exakt 0,0,0 als „kein Override" → Skins greifen dann nicht.
    // Auf einen winzigen Epsilon clampen (optisch weiter schwarz, aber != 0).
    if (Array.isArray(b[k]) && b[k].length === 3) payload[k] = b[k].map((v) => Math.max(0.0001, Number(v) || 0));
  }
  try {
    const r = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/skin`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      // Echten Grund vom Game-Server durchreichen (Cooldown, „im Menü", …) statt generisch
      let detail = `HTTP ${r.status}`;
      try { const e = await r.json(); detail = e.message ?? e.error ?? e.Msg ?? detail; }
      catch { try { const t = await r.text(); if (t) detail = t.slice(0, 200); } catch {} }
      return res.status(502).json({ error: `Skin-Update fehlgeschlagen: ${detail}` });
    }
    res.json({ ok: true });
  } catch (err) {
    const msg = err.name === 'TimeoutError'
      ? 'Game-Server hat nicht rechtzeitig geantwortet — bitte gleich nochmal versuchen.'
      : err.message;
    res.status(502).json({ error: msg });
  }
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Token-Service läuft auf 127.0.0.1:${PORT}`);
  console.log(`   Redirect-URI: ${REDIRECT_URI}`);
  console.log(`   accounts.json: ${ACCOUNTS_PATH}`);
});
