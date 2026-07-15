# Gateway In-Game-Capture — Anleitung

Ziel: ein möglichst senkrechtes, gleichmäßig ausgeleuchtetes Top-Down-Bild der **aktuellen** Gateway,
das ich danach entzerre, (ggf. aus Kacheln) zusammensetze und auf die Overlay-Weltkoordinaten kalibriere.

## Vorbereitung (im Spiel)
1. The Isle normal über Steam starten (EAC ok — wir spielen/fotografieren nur, KEINE Injektion).
2. Auf eine **Gateway** kommen, wo du eine **freie Kamera** hast:
   - eigener Server als **Admin** (Admin-Free-Cam / Spectate-Fly), oder
   - Spectator nach Tod, oder
   - was bei dir am einfachsten geht.
3. Falls du Admin bist: **Wetter klar**, **Zeit ~12:00 (Mittag)** → gleichmäßiges Licht, keine langen Schatten,
   möglichst wenig Nebel/Wolken.
4. **HUD ausblenden** (Screenshot-/Photomode-Taste bzw. HUD-Toggle), damit keine UI im Bild ist.

## Aufnahme
- **Variante A (schnell, 1 Bild):** In die Kartenmitte, so **hoch wie möglich** fliegen, Kamera **exakt senkrecht nach unten**,
  Blick nach **Norden** ausgerichtet (Kompass oben = N). Ein Screenshot der ganzen Insel.
  → gut als Basis, aber Ränder perspektivisch verzerrt.
- **Variante B (genauer, Kacheln):** Mittlere Höhe, senkrecht nach unten, die Insel in einem **Raster** abfliegen
  (z.B. 3×3 oder 4×4), jede Kachel mit **~30–40 % Überlappung** zur Nachbarkachel. Immer gleiche Höhe & gleicher
  Nord-Blick. → ich stitche das zu einer scharfen Gesamtkarte.

## Ablegen
- Screenshots (PNG/JPG) hier ablegen: `Overlay\map-source\capture\`
- Bei Kacheln bitte in Reihenfolge benennen, z.B. `row1_col1.png`, `row1_col2.png`, … (oder einfach fortlaufend).
- Wenn du Referenzpunkte kennst (z.B. eine POI-Weltkoordinate oder das Koordinaten-Gitter), notier sie kurz —
  hilft bei der Kalibrierung.

## Erster Test
Mach bitte **zuerst einen einzigen** hohen Top-Down-Screenshot (Variante A) und leg ihn in `capture\` ab.
Ich schaue mir Qualität/Verzerrung/Ausleuchtung an und sage dir dann, ob Variante A reicht oder wir
auf Kacheln (B) gehen — und wie genau du Höhe/Ausrichtung einstellen sollst.
