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
import { readFileSync, writeFileSync } from 'node:fs';
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

// ── Discord-Rollen-Check ────────────────────────────────────────────────────
async function isDiscordAdmin(discordId) {
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID) return false;
  try {
    const headers = { Authorization: `Bot ${DISCORD_BOT_TOKEN}` };
    const [mRes, rRes] = await Promise.all([
      fetch(`https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}`, { headers }),
      fetch(`https://discord.com/api/guilds/${DISCORD_GUILD_ID}/roles`, { headers }),
    ]);
    if (!mRes.ok || !rRes.ok) return false;
    const member = await mRes.json();
    const roles = await rRes.json();
    const adminRoleIds = new Set(roles.filter((r) => ADMIN_ROLE_NAMES.includes(r.name)).map((r) => r.id));
    return (member.roles || []).some((id) => adminRoleIds.has(id));
  } catch {
    return false;
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

    // Admin/Owner-Status anhand Discord-Rolle
    const admin = await isDiscordAdmin(user.id);

    // App-Session ausstellen (30 Tage)
    const session = jwt.sign(
      { steamId, discordId: user.id, name: user.global_name || user.username, admin },
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
  });
});

// ── 4) Spielerpositionen relayen (Welt-Koordinaten) ────────────────────────
app.get('/positions', async (req, res) => {
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
    const players = (data.Players ?? []).map((p) => ({
      steamId: p.steamId,
      name: p.playerName,
      dino: p.dinoClass,
      x: p.location?.x ?? 0,
      y: p.location?.y ?? 0,
      heading: p.lookDirection ?? 0,
      isDead: !!p.isDead,
      isYou: p.steamId === payload.steamId,
    }));
    res.json({ players, you: payload.steamId });
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
    const p = (data.Players ?? []).find((x) => x.steamId === payload.steamId);
    if (!p) return res.json({ online: false });
    res.json({
      online: true,
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
    });
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
  if (!payload.admin) return res.status(403).json({ error: 'Nur Admins' });

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

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonFile(file, data) { writeFileSync(file, JSON.stringify(data, null, 2)); }
function genId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function sessionFrom(req) {
  const auth = req.headers.authorization ?? '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t) return null;
  try { return jwt.verify(t, SESSION_SECRET); } catch { return null; }
}
async function fetchPlayers() {
  const r = await fetch(`${PANEL_BASE_URL}/players`, {
    headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Game-Server HTTP ${r.status}`);
  return (await r.json()).Players ?? [];
}

// Garage anzeigen
app.get('/garage', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const garage = readJson(GARAGE_FILE, {});
  const slots = (garage[s.steamId] ?? []).map((slot) => ({
    id: slot.id,
    label: slot.label ?? null,
    savedAt: slot.savedAt,
    dino: slot.snapshot?.dinoClass ?? '?',
    gender: slot.snapshot?.gender ?? '',
    grow: slot.snapshot?.grow ?? 0,
    isElder: !!slot.snapshot?.isElder,
  }));
  res.json({ slots });
});

// Aktuellen Dino einparken
app.post('/garage/park', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  try {
    const players = await fetchPlayers();
    const snapshot = players.find((p) => p.steamId === s.steamId);
    if (!snapshot) return res.status(409).json({ error: 'Du bist nicht im Spiel.' });
    // in Garage sichern
    const garage = readJson(GARAGE_FILE, {});
    if (!garage[s.steamId]) garage[s.steamId] = [];
    garage[s.steamId].push({ id: genId(), savedAt: Date.now(), snapshot });
    writeJsonFile(GARAGE_FILE, garage);
    // Dino im Spiel einparken (despawn)
    const pr = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/pack`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!pr.ok) throw new Error(`Einparken fehlgeschlagen (${pr.status})`);
    res.json({ ok: true, dino: snapshot.dinoClass });
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
    const garage = readJson(GARAGE_FILE, {});
    const slots = garage[s.steamId] ?? [];
    const slot = slots.find((x) => x.id === slotId);
    if (!slot) return res.status(404).json({ error: 'Slot nicht gefunden' });

    const players = await fetchPlayers();
    if (!players.find((p) => p.steamId === s.steamId)) return res.status(409).json({ error: 'Du musst im Spiel sein (auf einem Dino).' });

    const ur = await fetch(`${PANEL_BASE_URL}/players/${encodeURIComponent(s.steamId)}/unpack`, {
      method: 'POST', headers: { Authorization: `Bearer ${PANEL_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(slot.snapshot),
    });
    if (!ur.ok) throw new Error(`Ausparken fehlgeschlagen (${ur.status})`);
    // aus Garage entfernen
    garage[s.steamId] = slots.filter((x) => x.id !== slotId);
    writeJsonFile(GARAGE_FILE, garage);
    res.json({ ok: true, dino: slot.snapshot?.dinoClass });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── 8) Dino-Markt (Bot-seitige JSON-Daten) ──────────────────────────────────
const MARKETPLACE_FILE = `${BOT_DATA_DIR}/marketplace.json`;
const POINTS_FILE = `${BOT_DATA_DIR}/points.json`;
const SERVER_SELL_PRICE = parseInt(process.env.SERVER_SELL_PRICE ?? '500');

function getPoints(steamId) { return readJson(POINTS_FILE, {})[steamId] ?? 0; }
function setPointsVal(steamId, v) { const p = readJson(POINTS_FILE, {}); p[steamId] = Math.max(0, Math.round(v)); writeJsonFile(POINTS_FILE, p); }

// Marktplatz + eigener Kontostand
app.get('/market', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Keine Session' });
  const market = readJson(MARKETPLACE_FILE, []);
  res.json({
    points: getPoints(s.steamId),
    offers: market.map((o) => ({
      id: o.id,
      dino: o.snapshot?.dinoClass ?? '?',
      gender: o.snapshot?.gender ?? '',
      grow: o.snapshot?.grow ?? 0,
      isElder: !!o.snapshot?.isElder,
      label: o.label ?? null,
      price: o.price,
      mine: o.sellerSteamId === s.steamId,
    })),
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
  setPointsVal(s.steamId, getPoints(s.steamId) + SERVER_SELL_PRICE);
  garage[s.steamId] = slots.filter((x) => x.id !== slotId);
  writeJsonFile(GARAGE_FILE, garage);
  res.json({ ok: true, earned: SERVER_SELL_PRICE, points: getPoints(s.steamId) });
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
  return `<!doctype html><html lang="de"><head><meta charset="utf8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BlackFossil</title>
  <style>body{font-family:system-ui;background:#0f0a1e;color:#eee;display:flex;
  align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}
  .card{background:#1a1330;padding:36px;border-radius:16px;max-width:440px;border:1px solid #3a2d5c}
  h1{font-size:22px;margin:0 0 12px}p{color:#b3a9cc;line-height:1.5}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${msg}</p>${fallback}</div></body></html>`;
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Token-Service läuft auf 127.0.0.1:${PORT}`);
  console.log(`   Redirect-URI: ${REDIRECT_URI}`);
  console.log(`   accounts.json: ${ACCOUNTS_PATH}`);
});
