// Karten-Rendering: Welt-Koordinaten → Bild, Zonen, Spieler, Minimap.
// Kalibrierung wird in localStorage gespeichert und ist live justierbar.

// ── Zonen (Welt-Koordinaten, vom Server) ────────────────────────────────────
// Mehrere benannte Zonen über 5 Typen. Array wird IN PLACE mutiert (ES-Module-
// Live-Binding: niemals neu zuweisen). Jedes Element: { id, type, name, points }.
export const ZONE_TYPES = ['pvp', 'pve', 'sanctuary', 'patrol', 'migration'];
export const ZONE_META = {
  pvp:       { color: '#ef4444', label: 'PvP' },
  pve:       { color: '#22c55e', label: 'PvE' },
  sanctuary: { color: '#3b82f6', label: 'Sanctuary' },
  patrol:    { color: '#a855f7', label: 'Patrol' },
  migration: { color: '#f59e0b', label: 'Migration' },
};
export const ZONES = [];

// ── Kalibrierung als affine Abbildung Welt → normalisiert [0..1] ─────────────
// nx = a*wx + b*wy + e ;  ny = c*wx + d*wy + f
// Affin löst Achsentausch, Spiegelung, Drehung und Skalierung auf einmal.
// Nur die Y-Achse spiegeln: nx unverändert (a positiv), ny → 1 − ny (d positiv).
const DEFAULTS = { a: 8.3e-7, b: 0, e: 0.5, c: 0, d: 8.3e-7, f: 0.5 };
const CAL_KEY = 'bf-cal-affine-v2'; // Schlüssel angehoben → alte gespeicherte Kalibrierungen werden ignoriert
let cal = loadCal();

function loadCal() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CAL_KEY)) }; }
  catch { return { ...DEFAULTS }; }
}
// Zonen-Polygone vom Server übernehmen (ZONES in place ersetzen)
function randZoneId() {
  return 'z_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
export function setZones(data) {
  ZONES.length = 0;
  if (data && Array.isArray(data.zones)) {
    for (const z of data.zones) {
      ZONES.push({
        id: z.id || randZoneId(),
        type: ZONE_TYPES.includes(z.type) ? z.type : 'pvp',
        name: z.name || '',
        points: Array.isArray(z.points) ? z.points : [],
      });
    }
    return;
  }
  // Legacy-Fallback: einzelne pvp/pve-Polygone
  if (data && Array.isArray(data.pvp) && data.pvp.length) {
    ZONES.push({ id: randZoneId(), type: 'pvp', name: '', points: data.pvp });
  }
  if (data && Array.isArray(data.pve) && data.pve.length) {
    ZONES.push({ id: randZoneId(), type: 'pve', name: '', points: data.pve });
  }
}
// Neue leere Zone anlegen (Editor)
export function newZone(type) {
  const t = ZONE_TYPES.includes(type) ? type : 'pvp';
  const z = { id: randZoneId(), type: t, name: '', points: [] };
  ZONES.push(z);
  return z;
}

export function getCal() { return cal; }
export function setCalAffine(m) { cal = { ...m }; localStorage.setItem(CAL_KEY, JSON.stringify(cal)); }
export function resetCal() { cal = { ...DEFAULTS }; localStorage.setItem(CAL_KEY, JSON.stringify(cal)); }

export function worldToNorm(wx, wy) {
  return { nx: cal.a * wx + cal.b * wy + cal.e, ny: cal.c * wx + cal.d * wy + cal.f };
}

// normalisiert → Welt (Inverse der 2x2-Matrix)
export function normToWorld(nx, ny) {
  const det = cal.a * cal.d - cal.b * cal.c;
  if (Math.abs(det) < 1e-18) return { x: 0, y: 0 };
  const u = nx - cal.e, v = ny - cal.f;
  return { x: (cal.d * u - cal.b * v) / det, y: (-cal.c * u + cal.a * v) / det };
}

// Affine per Least-Squares über ALLE Korrespondenzen lösen (>=3, mehr = genauer).
// Welt-Koordinaten werden zentriert + skaliert (Hartley-Normalisierung), damit
// die riesigen Zahlen die Berechnung nicht numerisch sprengen.
// pairs = [{world:{x,y}, norm:{nx,ny}}]
export function solveAffine(pairs) {
  if (pairs.length < 3) return false;

  // Schwerpunkt + Skala der Welt-Punkte bestimmen
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p.world.x, 0) / n;
  const my = pairs.reduce((s, p) => s + p.world.y, 0) / n;
  let scale = Math.sqrt(pairs.reduce((s, p) => s + (p.world.x - mx) ** 2 + (p.world.y - my) ** 2, 0) / n);
  if (!isFinite(scale) || scale < 1e-6) scale = 1;

  // In normalisiertem Raum lösen: nx = a'·X + b'·Y + e' mit X=(x-mx)/scale
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, N = 0;
  let Sxnx = 0, Synx = 0, Snx = 0, Sxny = 0, Syny = 0, Sny = 0;
  for (const p of pairs) {
    const x = (p.world.x - mx) / scale, y = (p.world.y - my) / scale;
    const nx = p.norm.nx, ny = p.norm.ny;
    Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y; N += 1;
    Sxnx += x * nx; Synx += y * nx; Snx += nx;
    Sxny += x * ny; Syny += y * ny; Sny += ny;
  }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, N]];
  const sX = solve3(M, [Sxnx, Synx, Snx]);
  const sY = solve3(M, [Sxny, Syny, Sny]);
  if (!sX || !sY) return false;

  // Transform zurück in Welt-Koordinaten zusammensetzen:
  // nx = (a'/scale)·x + (b'/scale)·y + (e' - (a'·mx + b'·my)/scale)
  const compose = (s) => ({
    a: s[0] / scale, b: s[1] / scale,
    e: s[2] - (s[0] * mx + s[1] * my) / scale,
  });
  const cx = compose(sX), cy = compose(sY);
  setCalAffine({ a: cx.a, b: cx.b, e: cx.e, c: cy.a, d: cy.b, f: cy.e });
  return true;
}

// 3x3 lineares Gleichungssystem (Cramer)
function solve3(M, r) {
  const det = (m) =>
    m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1]) -
    m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0]) +
    m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  const col = (i) => M.map((row, k) => row.map((v, j) => (j === i ? r[k] : v)));
  return [det(col(0))/D, det(col(1))/D, det(col(2))/D];
}

// ── Kartenbild laden ─────────────────────────────────────────────────────────
let mapImg = null, mapReady = false;
export function loadMapImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { mapImg = img; mapReady = true; resolve(true); };
    img.onerror = () => { mapReady = false; resolve(false); };
    img.src = src;
  });
}

// ── Zonen-Layer (Sichtbarkeit pro Typ) ───────────────────────────────────────
// Zonen-Rework 2026-07: Sanctuary/Patrol/Migration werden NICHT mehr als PNG-Bilder überlagert,
// sondern aus den vom Team GEZEICHNETEN Zonen als reiner UMRISS gerendert (siehe drawZones).
// ZONE_LAYERS hält nur noch den Ein/Aus-Status pro Typ (Default sichtbar). loadZoneLayer bleibt
// als No-Op erhalten, damit bestehende Aufrufer nicht brechen.
export const ZONE_LAYERS = {
  sanctuary: { visible: true, label: '🛡️ Sanctuary' },
  patrol:    { visible: true, label: '🐾 Patrol' },
  migration: { visible: true, label: '🧭 Migration' },
};

export function loadZoneLayer() { return Promise.resolve(true); } // No-Op (keine Bilder mehr)
export function setZoneLayer(key, on) { if (ZONE_LAYERS[key]) ZONE_LAYERS[key].visible = !!on; }
export function isZoneLayerVisible(key) { return !!(ZONE_LAYERS[key] && ZONE_LAYERS[key].visible); }

// Typen, die nur als Umriss (ohne Name-Label, ohne Füllung) gezeichnet werden.
const OUTLINE_TYPES = new Set(['sanctuary', 'patrol', 'migration']);

// Goldene Patrol-Zone (pro Betrachter, aus /positions). Wird immer hervorgehoben gezeichnet,
// auch wenn der Patrol-Layer ausgeblendet ist.
let goldenZoneId = null;
export function setGoldenZone(id) { goldenZoneId = id || null; }
// Mittelpunkt (Schwerpunkt der Polygon-Ecken) der goldenen Zone in Welt-Koordinaten — für den Kompass.
export function goldenZoneCenter() {
  if (!goldenZoneId) return null;
  const z = ZONES.find((x) => x.id === goldenZoneId);
  if (!z || !Array.isArray(z.points) || !z.points.length) return null;
  let sx = 0, sy = 0, n = 0;
  for (const p of z.points) { if (typeof p.x === 'number' && typeof p.y === 'number') { sx += p.x; sy += p.y; n++; } }
  return n ? { x: sx / n, y: sy / n } : null;
}

// Polygon-Punkte um ihren Schwerpunkt sortieren (für sauberes Füllen)
function orderPolygon(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

// ── Vollbild-Karte zeichnen ──────────────────────────────────────────────────
// view: { ctx, w, h }   players: [{x,y,heading,isYou,name,dino,isDead}]
export function drawFullMap(view, players, waypoints = [], teleports = [], hoveredTp = null, iconScale = 1) {
  const { ctx, w, h } = view;
  if (mapReady) ctx.drawImage(mapImg, 0, 0, w, h);
  else { ctx.fillStyle = '#15102a'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#6b5b8c'; ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Kartenbild fehlt (assets/map.jpg)', w/2, h/2); }

  drawZones(ctx, (nx, ny) => ({ px: nx * w, py: ny * h }));
  for (const wp of waypoints) {
    const { nx, ny } = worldToNorm(wp.x, wp.y);
    drawWaypoint(ctx, nx * w, ny * h, iconScale);
  }
  // Teleport-Punkte (nummeriert; hervorgehoben beim Hover)
  for (const t of teleports) {
    const { nx, ny } = worldToNorm(t.x, t.y);
    drawTeleport(ctx, nx * w, ny * h, t.number, t.id === hoveredTp, iconScale);
  }
  // Eigene Position + Gruppen-Mitglieder (gleiche groupId), farbig
  const self = players.find((p) => p.isYou);
  if (self) {
    for (const p of players) {
      if (p.isYou || p.isDead) continue;
      const inGroup = (self.groupId && p.groupId === self.groupId) || p.ovgroup;
      if (!inGroup) continue;
      const { nx, ny } = worldToNorm(p.x, p.y);
      drawGroupMember(ctx, nx * w, ny * h, p, iconScale);
    }
  }
  if (self && !self.isDead) {
    const { nx, ny } = worldToNorm(self.x, self.y);
    drawPlayer(ctx, nx * w, ny * h, self, iconScale);
  }
}

// ── Heatmap (Aktivitäts-Dichte, keine exakten Positionen) ───────────────────
export function drawHeatmap(view, players, me) {
  const { ctx, w, h } = view;
  if (mapReady) { ctx.drawImage(mapImg, 0, 0, w, h); ctx.fillStyle = 'rgba(8,5,18,0.45)'; ctx.fillRect(0, 0, w, h); }
  else { ctx.fillStyle = '#15102a'; ctx.fillRect(0, 0, w, h); }

  // Dichte-Blobs additiv übereinanderlegen
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const radius = w * 0.05;
  for (const p of players) {
    if (p.isDead) continue;
    const { nx, ny } = worldToNorm(p.x, p.y);
    const px = nx * w, py = ny * h;
    const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
    g.addColorStop(0, 'rgba(255,80,0,0.55)');
    g.addColorStop(0.5, 'rgba(255,180,0,0.22)');
    g.addColorStop(1, 'rgba(255,255,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  drawZones(ctx, (nx, ny) => ({ px: nx * w, py: ny * h }));
  // eigene Position bleibt sichtbar
  if (me && !me.isDead) {
    const { nx, ny } = worldToNorm(me.x, me.y);
    drawPlayer(ctx, nx * w, ny * h, { ...me, isYou: true }, 1);
  }

  ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'left';
  ctx.fillText(`🔥 Heatmap · ${players.filter(p => !p.isDead).length} aktiv`, 14, 24);
}

// ── Minimap (zentriert, Auto-Zoom auf den Sprechradius) ───────────────────────
// speakRange = eigene Sprechreichweite in Welt-Einheiten (für Ring + Zoom-Stufe)
export function drawMinimap(view, players, me, speakRange = 0, waypoints = [], zoomMul = 1) {
  const { ctx, w, h } = view;
  ctx.clearRect(0, 0, w, h);

  const center = me ? worldToNorm(me.x, me.y) : { nx: 0.5, ny: 0.5 };

  // Normalisierter Radius des Sprechbereichs
  let normSpeak = 0;
  if (me && speakRange > 0) {
    const e = worldToNorm(me.x + speakRange, me.y);
    normSpeak = Math.hypot(e.nx - center.nx, e.ny - center.ny);
  }
  // Basis-Zoom (Sprechring ~30% des Minimap-Radius), dann Nutzer-Zoom (zoomMul>1 = rein).
  const baseZoom = normSpeak > 0 ? Math.min(0.28, Math.max(0.03, normSpeak * 3.4)) : 0.10;
  const zoom = Math.min(0.6, Math.max(0.015, baseZoom / zoomMul));

  ctx.save();
  ctx.beginPath(); ctx.arc(w/2, h/2, w/2, 0, Math.PI*2); ctx.clip();

  const toPx = (nx, ny) => ({
    px: ((nx - center.nx) / zoom) * (w/2) + w/2,
    py: ((ny - center.ny) / zoom) * (h/2) + h/2,
  });

  if (mapReady) {
    const sx = (center.nx - zoom) * mapImg.width;
    const sy = (center.ny - zoom) * mapImg.height;
    const sw = 2 * zoom * mapImg.width;
    const sh = 2 * zoom * mapImg.height;
    ctx.drawImage(mapImg, sx, sy, sw, sh, 0, 0, w, h);
  } else { ctx.fillStyle = 'rgba(40,30,70,0.5)'; ctx.fillRect(0,0,w,h); }

  drawZones(ctx, (nx, ny) => toPx(nx, ny));
  ctx.restore();

  // Angedeuteter Sprechradius-Ring
  if (normSpeak > 0) {
    const ringPx = (normSpeak / zoom) * (w/2);
    ctx.save();
    ctx.strokeStyle = 'rgba(139,92,246,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(w/2, h/2, ringPx, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(139,92,246,0.06)';
    ctx.beginPath(); ctx.arc(w/2, h/2, ringPx, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Gruppen-Mitglieder (gleiche groupId), in den Kreis geclippt
  if (me) {
    ctx.save();
    ctx.beginPath(); ctx.arc(w/2, h/2, w/2 - 1, 0, Math.PI*2); ctx.clip();
    for (const p of players) {
      if (p.isYou || p.isDead) continue;
      const inGroup = (me.groupId && p.groupId === me.groupId) || p.ovgroup;
      if (!inGroup) continue;
      const { nx, ny } = worldToNorm(p.x, p.y);
      const { px, py } = toPx(nx, ny);
      drawGroupMember(ctx, px, py, p, 0.9);
    }
    ctx.restore();
  }

  // Wegpunkt-Anzeige: innerhalb des Minimap-Kreises als Marker, außerhalb als
  // Richtungspfeil am Rand (+ Entfernung), damit man weiß, wohin man laufen muss.
  if (me && waypoints && waypoints.length) {
    const wp = waypoints[waypoints.length - 1];
    const wn = worldToNorm(wp.x, wp.y);
    const px = ((wn.nx - center.nx) / zoom) * (w/2) + w/2;
    const py = ((wn.ny - center.ny) / zoom) * (h/2) + h/2;
    const dx = px - w/2, dy = py - h/2, dist = Math.hypot(dx, dy);
    const R = w/2 - 11;
    if (dist <= R) {
      drawWaypoint(ctx, px, py, 0.85);
    } else {
      const ang = Math.atan2(dy, dx);
      const ex = w/2 + Math.cos(ang) * R, ey = h/2 + Math.sin(ang) * R;
      drawArrow(ctx, ex, ey, ang, 9, '#fbbf24');
      const meters = Math.round(Math.hypot(wp.x - me.x, wp.y - me.y) / 100);   // 100 Welt-Einh. = 1 m
      const lx = w/2 + Math.cos(ang) * (R - 16), ly = h/2 + Math.sin(ang) * (R - 16);
      ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3; ctx.strokeText(`${meters}m`, lx, ly);
      ctx.fillStyle = '#fde68a'; ctx.fillText(`${meters}m`, lx, ly);
    }
  }

  // eigener Punkt immer in der Mitte
  if (me) drawPlayer(ctx, w/2, h/2, { ...me, isYou: true }, 1);

  // Rahmen
  ctx.strokeStyle = '#3a2d5c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(w/2, h/2, w/2 - 1, 0, Math.PI*2); ctx.stroke();
}

// ── Helfer ───────────────────────────────────────────────────────────────────
function drawZones(ctx, project) {
  for (const z of ZONES) {
    if (!z.points || !z.points.length) continue;
    const meta = ZONE_META[z.type] || ZONE_META.pvp;
    const outline = OUTLINE_TYPES.has(z.type);
    const isGolden = !!(z.id && z.id === goldenZoneId);
    // Umriss-Zonen (Sanctuary/Patrol/Migration) nur zeichnen, wenn ihr Layer sichtbar ist.
    // Die goldene Zone wird IMMER hervorgehoben — auch bei ausgeblendetem Patrol-Layer.
    if (outline && !isGolden && !isZoneLayerVisible(z.type)) continue;

    const color = meta.color;
    // Punkte in Aufnahme-Reihenfolge (unterstützt komplexe/konkave Formen)
    const pts = z.points.map((p) => {
      const { nx, ny } = worldToNorm(p.x, p.y);
      return project(nx, ny);
    });
    if (pts.length < 2) {
      const pt = pts[0];
      ctx.beginPath(); ctx.arc(pt.px, pt.py, 4, 0, Math.PI * 2);
      ctx.fillStyle = isGolden ? '#fbbf24' : color; ctx.fill();
      continue;
    }
    ctx.beginPath();
    pts.forEach((pt, i) => i ? ctx.lineTo(pt.px, pt.py) : ctx.moveTo(pt.px, pt.py));
    ctx.closePath();

    if (isGolden) {
      // ⭐ Goldene Patrol-Zone: leuchtender Gold-Umriss + zarte Füllung + Stern-Marke.
      ctx.save();
      ctx.fillStyle = 'rgba(251,191,36,0.14)'; ctx.fill();
      ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 12;
      ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 3; ctx.stroke();
      ctx.restore();
      const cx = pts.reduce((s, p) => s + p.px, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.py, 0) / pts.length;
      ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⭐', cx, cy);
    } else if (outline) {
      // Sanctuary/Patrol/Migration: NUR Umriss — keine Füllung, KEIN Name-Label.
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    } else {
      // PvP/PvE: Füllung + Umriss + Label (wie gehabt).
      ctx.fillStyle = color + '22';
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
      const cx = pts.reduce((s, p) => s + p.px, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.py, 0) / pts.length;
      ctx.fillStyle = color; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(z.name || meta.label, cx, cy);
    }
  }
}

// Deterministische Farbe je Gruppen-Mitglied (gleiche Farbe auch im Gruppen-Panel)
const GROUP_COLORS = ['#2dd4bf', '#f59e0b', '#60a5fa', '#f472b6', '#a3e635', '#fb923c', '#22d3ee', '#c084fc'];
export function groupColorFor(id) {
  let h = 0; const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}
// Eigene Position: auffällige, klar sichtbare Farbe (Kontrast zu Karte & Theme)
let SELF_COLOR = '#00e5ff';
// Wegpunkt-Stil (in den Einstellungen anpassbar): Farbe + Größen-Multiplikator.
let WP_COLOR = '#fbbf24';
let WP_SIZE = 1;
// Eigener Pfeil zusätzlich vergrößerbar (Standard 1).
let SELF_SIZE = 1;
// Von der Renderer-Seite gesetzt (localStorage) — überschreibt die Defaults.
export function setMarkerStyle({ selfColor, selfSize, wpColor, wpSize } = {}) {
  if (selfColor) SELF_COLOR = selfColor;
  if (wpColor) WP_COLOR = wpColor;
  if (typeof wpSize === 'number' && wpSize > 0) WP_SIZE = wpSize;
  if (typeof selfSize === 'number' && selfSize > 0) SELF_SIZE = selfSize;
}
// Kleiner Pfeil, der in Blick-/Bewegungsrichtung zeigt.
// Outline skaliert mit der Pfeilgröße (nicht fix), damit sie beim Reinzoomen nicht „verklumpt".
function drawArrow(ctx, px, py, angle, size, color) {
  ctx.save();
  ctx.translate(px, py); ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.72, size * 0.66);
  ctx.lineTo(-size * 0.28, 0);
  ctx.lineTo(-size * 0.72, -size * 0.66);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = Math.max(0.5, size * 0.17); ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
  ctx.restore();
}
// Heading → Karten-Winkel: den Blick-Vektor durch DIESELBE Welt→Karte-Projektion
// schicken wie die Position (worldToNorm). So stimmt die Pfeilrichtung auch bei
// gedrehter/gespiegelter Kalibrierung (sonst zeigt der Pfeil verkehrt).
function headingMapAngle(p) {
  if (typeof p.heading !== 'number' || typeof p.x !== 'number') return -Math.PI / 2;
  const hr = (p.heading - 90) * Math.PI / 180, L = 1000;
  const a0 = worldToNorm(p.x, p.y);
  const a1 = worldToNorm(p.x + Math.cos(hr) * L, p.y + Math.sin(hr) * L);
  const dx = a1.nx - a0.nx, dy = a1.ny - a0.ny;
  // +90° (im Uhrzeigersinn / nach rechts) korrigiert den Pfeil-Offset des Mod-Headings.
  return (dx === 0 && dy === 0) ? -Math.PI / 2 : Math.atan2(dy, dx) + Math.PI / 2;
}
function arrowAngle(p) { return (typeof p.heading === 'number') ? headingMapAngle(p) : ((typeof p.dirAngle === 'number') ? p.dirAngle : -Math.PI / 2); }
function drawGroupMember(ctx, px, py, p, scale) {
  const col = groupColorFor(p.steamId);
  drawArrow(ctx, px, py, arrowAngle(p), 6.5 * scale, col);
  if (p.name) {
    ctx.font = `bold ${11 * scale}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 3 * scale; ctx.strokeText(p.name, px, py - 9 * scale);
    ctx.fillStyle = col; ctx.fillText(p.name, px, py - 9 * scale);
    // Staff sieht bei gesetztem Rollplay-Namen zusätzlich den echten Namen (Backend liefert
    // realName nur an Staff/den Spieler selbst) — kleiner & gedämpft unter dem RP-Namen.
    if (p.realName && p.realName !== p.name) {
      ctx.font = `${9 * scale}px system-ui`;
      ctx.strokeText(p.realName, px, py + 2 * scale);
      ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillText(p.realName, px, py + 2 * scale);
    }
  }
}
function drawPlayer(ctx, px, py, p, scale) {
  const sz = 9 * SELF_SIZE * scale;
  ctx.save(); ctx.shadowColor = SELF_COLOR; ctx.shadowBlur = 7 * scale;   // Glow → klar erkennbar
  // Basis-Punkt unter dem Pfeil → immer als eigene Position erkennbar, auch bei viel Zoom.
  ctx.beginPath(); ctx.arc(px, py, sz * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = SELF_COLOR; ctx.fill();
  ctx.lineWidth = Math.max(0.5, sz * 0.12); ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
  ctx.shadowBlur = 0;
  drawArrow(ctx, px, py, arrowAngle(p), sz, SELF_COLOR);
  ctx.restore();
}

// Wegpunkt: Farbe + Größe aus den Einstellungen (WP_COLOR/WP_SIZE). Rauten-Pin mit Outline.
function drawWaypoint(ctx, px, py, scale = 1) {
  const s = scale * WP_SIZE;
  ctx.save();
  ctx.shadowColor = WP_COLOR; ctx.shadowBlur = 6 * scale;
  ctx.fillStyle = WP_COLOR;
  ctx.beginPath(); ctx.moveTo(px, py-8*s); ctx.lineTo(px+5*s, py); ctx.lineTo(px, py+8*s); ctx.lineTo(px-5*s, py); ctx.closePath();
  ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = Math.max(0.5, 1.2 * s); ctx.stroke();
  ctx.restore();
}

function drawTeleport(ctx, px, py, number, highlight, scale = 1) {
  const r = (highlight ? 13 : 10) * scale;
  ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = highlight ? '#c084fc' : 'rgba(139,92,246,0.92)';
  ctx.fill();
  ctx.lineWidth = (highlight ? 3 : 2) * scale; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `bold ${(highlight ? 13 : 11) * scale}px system-ui`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(number), px, py);
}

// ── Welche Zone(n)? (Point-in-Polygon) ──────────────────────────────────────
export function zoneAt(wx, wy) {
  for (const z of ZONES) {
    if (z.points && z.points.length >= 3 && pointInPolygon(wx, wy, z.points)) {
      return z.name || (ZONE_META[z.type] || ZONE_META.pvp).label;
    }
  }
  return null;
}
// ALLE Zonen an einem Punkt (Zonen sind NICHT exklusiv → Mehrfach-Zugehörigkeit).
// Liefert [{ type, name, label }] in Zonen-Reihenfolge.
export function zonesAt(wx, wy) {
  const out = [];
  for (const z of ZONES) {
    if (z.points && z.points.length >= 3 && pointInPolygon(wx, wy, z.points)) {
      const meta = ZONE_META[z.type] || ZONE_META.pvp;
      out.push({ type: z.type, name: z.name, label: z.name || meta.label });
    }
  }
  return out;
}
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
