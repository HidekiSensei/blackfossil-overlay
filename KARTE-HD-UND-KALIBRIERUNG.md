# Karte: schärfer beim Zoomen + genauerer Positions-Sync

Kurz-Anleitung zu zwei Fragen: (A) wie die Karte beim Reinzoomen scharf bleibt und (B) wie der
Sync „Spielerposition ↔ Kartenposition" genauer wird.

## Ausgangslage (aktueller Code)
- **Karte:** `app/src/renderer/assets/map.jpg` — tatsächlich **WebP**, **1920 × 1923 px** (Raster).
  Gezeichnet per `ctx.drawImage` in `map.js` (`drawFullMap`/`drawMinimap`). Beim Zoom (bis 8×) wird
  das Rasterbild hochskaliert → **wird unscharf**.
- **Zonen-Layer** liegen deckungsgleich als PNG in derselben Auflösung
  (`zone-sanctuary.png`, `zone-patrol.png`, `zone-migration.png`).
- **Kalibrierung:** Affin-Transformation (2×2-Matrix + Verschiebung) in `map.js`
  (`worldToNorm`/`normToWorld`/`solveAffine`), gespeichert in `localStorage['bf-cal-affine-v2']`
  und serverseitig geteilt über den `/calibration`-Endpunkt. Aktuell **von Hand kalibriert**
  (Genauigkeit grob ~10–50 px, je nach gesetzten Punkten).

---

## A) Schärfer beim Zoomen

### Option 1 — Höher aufgelöste Raster-Karte  ✅ empfohlen (bester Aufwand/Nutzen)
„Echtes SVG" gibt es für Gateway **nicht** offiziell, und die Karte selbst als Vektor
**nachzuzeichnen wäre enorme Handarbeit** (Küstenlinien, Flüsse, Höhen …). Der pragmatische
Gewinn ist eine **größere Raster-Karte**:

1. Eine **hochauflösende Gateway-Karte** besorgen (z. B. 4096×4096 oder 8192×8192).
   Quellen: offizielle Karte in hoher Auflösung bzw. Community-Karten. **Wichtig:** exakt
   **dasselbe Bildausschnitt/Seitenverhältnis** wie die aktuelle `map.jpg`, sonst passen die
   Zonen-Layer und die Kalibrierung nicht mehr.
2. Als WebP speichern (gute Qualität/Größe) und `assets/map.jpg` ersetzen.
3. Die **Zonen-Layer in gleicher Auflösung** neu exportieren (deckungsgleich), sonst verrutschen sie.
4. Nichts am Code nötig — die Kalibrierung arbeitet in **normalisierten** Koordinaten [0..1],
   ist also von der Pixel-Auflösung unabhängig.

**Trade-off:** mehr Speicher/VRAM. 4096² ist ein guter Kompromiss (deutlich schärfer, moderat groß);
8192² ist am schärfsten, aber schwerer (RAM/Ladezeit). Empfehlung: **4096²** testen.

### Option 2 — Kachel-Pyramide (Tiling), nur wenn Option 1 nicht reicht
Wie bei Google Maps: mehrere Zoomstufen als Kacheln, es werden nur die sichtbaren Kacheln der
passenden Stufe gezeichnet. **Gestochen scharf auf jeder Stufe**, aber deutlich mehr Bau- und
Vorbereitungsaufwand (Kacheln erzeugen + Lade-/Zeichen-Logik in `map.js`). Nur lohnend, wenn 4096²/8192²
nicht ausreicht.

### Option 3 — Echtes SVG
Nur sinnvoll, wenn es eine fertige Vektor-Quelle der Karte gäbe. Gibt es aktuell nicht →
**nicht empfohlen** (Nachzeichnen = zu viel Aufwand für den Nutzen).

---

## B) Positions-Sync genauer machen

Das Overlay rechnet Welt-Koordinaten → Kartenposition über eine **Affin-Transformation**. Deren
Genauigkeit hängt **nur** von den Kalibrier-Punkten ab (nicht von der Bildauflösung).

The Isle zeigt im HUD **LAT / LONG** (Insert-Taste). Diese sind lineare Funktionen der Welt-X/Y —
also perfekt für eine exakte Affin-Lösung. So wird's genauer:

1. **Mehr und breiter verteilte Referenzpunkte** setzen (nicht alle in einer Ecke): am besten
   4–6 Punkte, verteilt über die ganze Karte (Ecken + Mitte). Der vorhandene Auto-/Manuell-Kalibrier-
   Modus im Overlay macht genau das (`solveAffine` löst per kleinster Quadrate).
2. **Exakte Punkte statt Augenmaß:** an einem bekannten Ort stehen, dessen Welt-XY/LAT-LONG man kennt,
   und den Punkt präzise auf der Karte anklicken. Je genauer die Klicks, desto besser die Matrix.
3. **Kartenecken bestimmen:** kennt man die Welt-Koordinaten der 4 Kartenecken, ergibt sich eine
   nahezu perfekte Matrix (die Community-Map-Tools kennen diese Bounds — von dort übernehmbar).
4. **Einmal gut kalibrieren → für alle teilen:** eine gute Kalibrierung über den `/calibration`-Endpunkt
   hochladen, dann bekommen sie alle Spieler automatisch.

**Fazit:** Für „scharf beim Zoomen" → **HD-Raster (4096²)** einbauen. Für „genauerer Sync" → einmalig
**sauber mit breit verteilten Punkten kalibrieren** (idealerweise aus bekannten Karten-Bounds) und die
Kalibrierung serverseitig teilen. Beides ist unabhängig voneinander.

> Wenn du eine HD-Karten-Datei lieferst (gleicher Ausschnitt/Seitenverhältnis wie die aktuelle),
> baue ich sie inkl. passender Zonen-Layer ein — das war in dieser Runde bewusst „nur Anleitung".
