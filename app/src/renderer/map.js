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

// ── Kalibrierung (Welt → normalisiert [0..1] auf dem Kartenbild) ─────────────
const DEFAULTS = { cx: 0, cy: 0, scale: 8.3e-7, flipY: true };
let cal = loadCal();

function loadCal() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bf-cal')) }; }
  catch { return { ...DEFAULTS }; }
}
export function getCal() { return cal; }
export function setCal(patch) { cal = { ...cal, ...patch }; localStorage.setItem('bf-cal', JSON.stringify(cal)); }
export function resetCal() { cal = { ...DEFAULTS }; localStorage.setItem('bf-cal', JSON.stringify(cal)); }

// Welt → normalisiert (0..1, 0=oben/links)
export function worldToNorm(wx, wy) {
  const nx = (wx - cal.cx) * cal.scale + 0.5;
  const ny = cal.flipY ? 0.5 - (wy - cal.cy) * cal.scale : 0.5 + (wy - cal.cy) * cal.scale;
  return { nx, ny };
}

// normalisiert → Welt (für Wegpunkte)
export function normToWorld(nx, ny) {
  const wx = (nx - 0.5) / cal.scale + cal.cx;
  const wy = cal.flipY ? (0.5 - ny) / cal.scale + cal.cy : (ny - 0.5) / cal.scale + cal.cy;
  return { x: wx, y: wy };
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
  ctx.clearRect(0, 0, w, h);

  if (mapReady) ctx.drawImage(mapImg, 0, 0, w, h);
  else { ctx.fillStyle = '#15102a'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#6b5b8c'; ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Kartenbild fehlt (assets/map.jpg)', w/2, h/2); }

  drawZones(ctx, (nx, ny) => ({ px: nx * w, py: ny * h }));
  for (const wp of waypoints) {
    const { nx, ny } = worldToNorm(wp.x, wp.y);
    drawWaypoint(ctx, nx * w, ny * h);
  }
  for (const p of players) {
    if (p.isDead) continue;
    const { nx, ny } = worldToNorm(p.x, p.y);
    drawPlayer(ctx, nx * w, ny * h, p, 1);
  }
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
  for (const p of players) {
    if (p.isDead || p.isYou) continue;
    const { px, py } = toPx(...Object.values(worldToNorm(p.x, p.y)));
    drawPlayer(ctx, px, py, p, 0.8);
  }
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
