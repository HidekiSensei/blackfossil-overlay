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
import { readFileSync } from 'node:fs';
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

    // App-Session ausstellen (30 Tage)
    const session = jwt.sign(
      { steamId, discordId: user.id, name: user.global_name || user.username },
      SESSION_SECRET,
      { expiresIn: '30d' }
    );

    // Zurück in die App per Deep-Link
    const redirect = `${APP_REDIRECT}?session=${encodeURIComponent(session)}`;
    res.send(htmlPage(
      '✅ Erfolgreich angemeldet!',
      'Du kannst dieses Fenster schließen und zur BlackFossil-App zurückkehren.',
      redirect
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
  });
});

// ── Health ───────────────────────────────────────────────────────────────
app.get('/auth/health', (_req, res) => res.json({ ok: true }));

function htmlPage(title, msg, redirect) {
  return `<!doctype html><html lang="de"><head><meta charset="utf8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BlackFossil</title>
  <style>body{font-family:system-ui;background:#0f0a1e;color:#eee;display:flex;
  align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
  .card{background:#1a1330;padding:40px;border-radius:16px;max-width:420px;border:1px solid #3a2d5c}
  h1{font-size:22px;margin:0 0 12px}p{color:#b3a9cc;line-height:1.5}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${msg}</p></div>
  ${redirect ? `<script>setTimeout(()=>{location.href=${JSON.stringify(redirect)}},800)</script>` : ''}
  </body></html>`;
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Token-Service läuft auf 127.0.0.1:${PORT}`);
  console.log(`   Redirect-URI: ${REDIRECT_URI}`);
  console.log(`   accounts.json: ${ACCOUNTS_PATH}`);
});
