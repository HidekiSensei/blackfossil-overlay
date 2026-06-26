// Karten-Rendering: Welt-Koordinaten → Bild, Zonen, Spieler, Minimap.
// Kalibrierung wird in localStorage gespeichert und ist live justierbar.

// ── Zonen (Welt-Koordinaten, vom Server) ────────────────────────────────────
export const ZONES = {
  pvp: {
    label: 'PVP', color: '#ef4444',
    points: [
      { x: 364958.415, y: -323066.7 },
      { x: 324911.477, y: -290337.75 },
      { x: 247492.094, y: -356983.359 },
      { x: 310160.555, y: -437747.444 },
    ],
  },
  pve: {
    label: 'PVE', color: '#22c55e',
    points: [
      { x: -274705.875, y: 32377.529 },
      { x: -197118.469, y: 52323.938 },
      { x: -241417.556, y: 152630.258 },
      { x: -333486.383, y: 124673.398 },
    ],
  },
};

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
// Zonen-Polygone vom Server übernehmen
export function setZones(data) {
  if (Array.isArray(data.pvp)) ZONES.pvp.points = data.pvp;
  if (Array.isArray(data.pve)) ZONES.pve.points = data.pve;
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

// ── Zonen-Layer (transparente PNGs in Kartengröße, deckungsgleich überlagert) ──
// Geometrie steckt im Bild selbst → kein Polygon nötig. Default unsichtbar.
export const ZONE_LAYERS = {
  sanctuary: { img: null, ready: false, visible: false, src: 'assets/zone-sanctuary.png', label: '🛡️ Sanctuary' },
  patrol:    { img: null, ready: false, visible: false, src: 'assets/zone-patrol.png',    label: '🐾 Patrol' },
  migration: { img: null, ready: false, visible: false, src: 'assets/zone-migration.png', label: '🧭 Migration' },
};

export function loadZoneLayer(key) {
  const L = ZONE_LAYERS[key];
  if (!L) return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { L.img = img; L.ready = true; resolve(true); };
    img.onerror = () => { L.ready = false; resolve(false); };
    img.src = L.src;
  });
}

export function setZoneLayer(key, on) { if (ZONE_LAYERS[key]) ZONE_LAYERS[key].visible = !!on; }
export function isZoneLayerVisible(key) { return !!(ZONE_LAYERS[key] && ZONE_LAYERS[key].visible); }

// Sichtbare Layer-Bilder deckungsgleich über die Karte zeichnen (volle Map-Ausdehnung).
function drawZoneLayers(ctx, w, h) {
  for (const L of Object.values(ZONE_LAYERS)) {
    if (L.visible && L.ready) ctx.drawImage(L.img, 0, 0, w, h);
  }
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

  drawZoneLayers(ctx, w, h);
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
export function drawMinimap(view, players, me, speakRange = 0, waypoints = []) {
  const { ctx, w, h } = view;
  ctx.clearRect(0, 0, w, h);

  const center = me ? worldToNorm(me.x, me.y) : { nx: 0.5, ny: 0.5 };

  // Normalisierter Radius des Sprechbereichs
  let normSpeak = 0;
  if (me && speakRange > 0) {
    const e = worldToNorm(me.x + speakRange, me.y);
    normSpeak = Math.hypot(e.nx - center.nx, e.ny - center.ny);
  }
  // Zoom so wählen, dass der Sprechring ~30% des Minimap-Radius einnimmt
  // (etwas weiter rausgezoomt für mehr Überblick)
  const zoom = normSpeak > 0 ? Math.min(0.28, Math.max(0.03, normSpeak * 3.4)) : 0.10;

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
  for (const z of Object.values(ZONES)) {
    if (!z.points.length) continue;
    // Punkte in Aufnahme-Reihenfolge (unterstützt komplexe/konkave Formen)
    const pts = z.points.map((p) => {
      const { nx, ny } = worldToNorm(p.x, p.y);
      return project(nx, ny);
    });
    ctx.beginPath();
    pts.forEach((pt, i) => i ? ctx.lineTo(pt.px, pt.py) : ctx.moveTo(pt.px, pt.py));
    ctx.closePath();
    ctx.fillStyle = z.color + '22';
    ctx.strokeStyle = z.color; ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
    // Label im Schwerpunkt
    const cx = pts.reduce((s,p)=>s+p.px,0)/pts.length, cy = pts.reduce((s,p)=>s+p.py,0)/pts.length;
    ctx.fillStyle = z.color; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(z.label, cx, cy);
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
const SELF_COLOR = '#00e5ff';
// Kleiner Pfeil, der in Blick-/Bewegungsrichtung zeigt
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
  ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
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
  return (dx === 0 && dy === 0) ? -Math.PI / 2 : Math.atan2(dy, dx);
}
function arrowAngle(p) { return (typeof p.dirAngle === 'number') ? p.dirAngle : headingMapAngle(p); }
function drawGroupMember(ctx, px, py, p, scale) {
  const col = groupColorFor(p.steamId);
  drawArrow(ctx, px, py, arrowAngle(p), 6.5 * scale, col);
  if (p.name) {
    ctx.font = `bold ${11 * scale}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 3 * scale; ctx.strokeText(p.name, px, py - 9 * scale);
    ctx.fillStyle = col; ctx.fillText(p.name, px, py - 9 * scale);
  }
}
function drawPlayer(ctx, px, py, p, scale) {
  ctx.save(); ctx.shadowColor = SELF_COLOR; ctx.shadowBlur = 8 * scale;   // Glow → klar erkennbar
  drawArrow(ctx, px, py, arrowAngle(p), 8.5 * scale, SELF_COLOR);
  ctx.restore();
}

function drawWaypoint(ctx, px, py, scale = 1) {
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath(); ctx.moveTo(px, py-8*scale); ctx.lineTo(px+5*scale, py); ctx.lineTo(px, py+8*scale); ctx.lineTo(px-5*scale, py); ctx.closePath();
  ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1 * scale; ctx.stroke();
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

// ── Welche Zone? (Point-in-Polygon) ─────────────────────────────────────────
export function zoneAt(wx, wy) {
  for (const [key, z] of Object.entries(ZONES)) {
    if (pointInPolygon(wx, wy, z.points)) return z.label;
  }
  return null;
}
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
