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
const DEFAULTS = { a: 8.3e-7, b: 0, e: 0.5, c: 0, d: -8.3e-7, f: 0.5 };
let cal = loadCal();

function loadCal() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bf-cal-affine')) }; }
  catch { return { ...DEFAULTS }; }
}
export function getCal() { return cal; }
export function setCalAffine(m) { cal = { ...m }; localStorage.setItem('bf-cal-affine', JSON.stringify(cal)); }
export function resetCal() { cal = { ...DEFAULTS }; localStorage.setItem('bf-cal-affine', JSON.stringify(cal)); }

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

// Polygon-Punkte um ihren Schwerpunkt sortieren (für sauberes Füllen)
function orderPolygon(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

// ── Vollbild-Karte zeichnen ──────────────────────────────────────────────────
// view: { ctx, w, h }   players: [{x,y,heading,isYou,name,dino,isDead}]
export function drawFullMap(view, players, waypoints = []) {
  const { ctx, w, h } = view;
  if (mapReady) ctx.drawImage(mapImg, 0, 0, w, h);
  else { ctx.fillStyle = '#15102a'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#6b5b8c'; ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Kartenbild fehlt (assets/map.jpg)', w/2, h/2); }

  drawZones(ctx, (nx, ny) => ({ px: nx * w, py: ny * h }));
  for (const wp of waypoints) {
    const { nx, ny } = worldToNorm(wp.x, wp.y);
    drawWaypoint(ctx, nx * w, ny * h);
  }
  // Nur die eigene Position anzeigen (keine fremden Spielerpunkte)
  const self = players.find((p) => p.isYou);
  if (self && !self.isDead) {
    const { nx, ny } = worldToNorm(self.x, self.y);
    drawPlayer(ctx, nx * w, ny * h, self, 1);
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

// ── Minimap (zentriert auf eigene Position, gezoomt) ──────────────────────────
// zoom = wie viel vom Normalraum sichtbar ist (kleiner = näher rangezoomt)
export function drawMinimap(view, players, me, zoom = 0.16) {
  const { ctx, w, h } = view;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  // Kreis-Maske
  ctx.beginPath(); ctx.arc(w/2, h/2, w/2, 0, Math.PI*2); ctx.clip();

  const center = me ? worldToNorm(me.x, me.y) : { nx: 0.5, ny: 0.5 };
  // Normraum-Ausschnitt → Minimap-Pixel
  const toPx = (nx, ny) => ({
    px: ((nx - center.nx) / zoom) * (w/2) + w/2,
    py: ((ny - center.ny) / zoom) * (h/2) + h/2,
  });

  if (mapReady) {
    // passenden Bildausschnitt zeichnen
    const sx = (center.nx - zoom) * mapImg.width;
    const sy = (center.ny - zoom) * mapImg.height;
    const sw = 2 * zoom * mapImg.width;
    const sh = 2 * zoom * mapImg.height;
    ctx.drawImage(mapImg, sx, sy, sw, sh, 0, 0, w, h);
  } else { ctx.fillStyle = 'rgba(40,30,70,0.5)'; ctx.fillRect(0,0,w,h); }

  drawZones(ctx, (nx, ny) => toPx(nx, ny));
  // keine fremden Spielerpunkte auf der Minimap
  ctx.restore();

  // eigener Punkt immer in der Mitte (über der Maske)
  if (me) drawPlayer(ctx, w/2, h/2, { ...me, isYou: true }, 1);

  // Rahmen
  ctx.strokeStyle = '#3a2d5c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(w/2, h/2, w/2 - 1, 0, Math.PI*2); ctx.stroke();
}

// ── Helfer ───────────────────────────────────────────────────────────────────
function drawZones(ctx, project) {
  for (const z of Object.values(ZONES)) {
    const pts = orderPolygon(z.points).map((p) => {
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

function drawPlayer(ctx, px, py, p, scale) {
  const r = 5 * scale;
  // Blickrichtungs-Pfeil
  if (typeof p.heading === 'number') {
    const a = (p.heading - 90) * Math.PI / 180;
    ctx.strokeStyle = p.isYou ? '#8b5cf6' : '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a)*r*2.4, py + Math.sin(a)*r*2.4); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI*2);
  ctx.fillStyle = p.isYou ? '#8b5cf6' : '#fff';
  ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
}

function drawWaypoint(ctx, px, py) {
  ctx.fillStyle = '#fbbf24';
  ctx.beginPath(); ctx.moveTo(px, py-8); ctx.lineTo(px+5, py); ctx.lineTo(px, py+8); ctx.lineTo(px-5, py); ctx.closePath();
  ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
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
