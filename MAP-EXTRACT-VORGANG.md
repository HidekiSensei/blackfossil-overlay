# Vorgang: Gateway-Map-Textur aus The Isle extrahieren (Windows)

**Ziel:** Die **hochauflösende Gateway-Map-Textur** aus den Spieldateien von The Isle (Unreal Engine) als **PNG in Originalauflösung** exportieren — als Quelle für die neue Cluster-/HD-Karte im Overlay.

> Diese Datei liegt im ProtonDrive-Repo und ist auf der Windows-Maschine sichtbar. Claude Code (Windows) kann die PowerShell-Schritte ausführen; die FModel-Schritte sind GUI (kurz beschrieben).

---

## Überblick
The Isle (Evrima) ist ein Unreal-Engine-Spiel (Evrima-Branch lange **UE 4.26**, ggf. neuere UE5-Version). Die Spiel-Assets liegen verschlüsselt in `.pak`/`.utoc`/`.ucas`-Dateien. Werkzeug der Wahl: **FModel** (öffnet die Paks, browst die Assets, exportiert Texturen als PNG). Da die Paks i. d. R. **AES-verschlüsselt** sind, brauchen wir den **AES-Key** (entweder aus einer Community-Liste oder selbst aus der Shipping-`.exe` extrahiert).

**Ergebnis, das wir wollen:** die farbige, top-down **Insel-Textur** (Satelliten-/Kartenlook), so groß wie möglich (idealerweise 4096²/8192²). NICHT die graue Heightmap.

---

## Schritt 1 — Spielpfad + Paks finden (PowerShell)
```powershell
# The Isle Steam-AppID = 376210. Installordner suchen (auch auf anderen Laufwerken):
$libs = Get-Content "$env:ProgramFiles(x86)\Steam\steamapps\libraryfolders.vdf" -ErrorAction SilentlyContinue
# Fallback-Standardpfad:
$isle = "C:\Program Files (x86)\Steam\steamapps\common\The Isle"
if (!(Test-Path $isle)) {
  # alle Laufwerke nach dem Ordner durchsuchen
  Get-PSDrive -PSProvider FileSystem | ForEach-Object {
    Get-ChildItem "$($_.Root)" -Directory -Filter "The Isle" -Recurse -ErrorAction SilentlyContinue -Depth 6 |
      Select-Object -First 1 -ExpandProperty FullName
  }
}
# Paks + Shipping-Exe anzeigen:
Get-ChildItem "$isle\TheIsle\Content\Paks" -Recurse -Include *.pak,*.utoc,*.ucas -ErrorAction SilentlyContinue | Select FullName,Length
Get-ChildItem "$isle\TheIsle\Binaries" -Recurse -Filter *-Shipping.exe -ErrorAction SilentlyContinue | Select FullName
```
→ Merke dir den **Paks-Ordner** (z. B. `…\The Isle\TheIsle\Content\Paks`) und die **Shipping-Exe** (z. B. `…\Binaries\Win64\TheIsle-Win64-Shipping.exe`).

---

## Schritt 2 — FModel installieren
- FModel braucht die **.NET 8 Desktop Runtime**. Installieren (falls fehlt):
  ```powershell
  winget install --id Microsoft.DotNet.DesktopRuntime.8 -e --silent
  winget install --id FModel.FModel -e --silent   # falls im winget-Repo; sonst manuell:
  ```
- Falls winget FModel nicht kennt: von **https://fmodel.app** herunterladen und installieren (offizielle Quelle).

---

## Schritt 3 — AES-Key besorgen
Zwei Wege — probiere zuerst A (schnell), sonst B (immer aktuell):

**A) Community-Liste:** FModel hat eine Key-Sammlung: https://github.com/FModel/Unreal-Game-Keys — dort nach „The Isle" suchen. Achtung: Keys ändern sich teils pro Update → wenn der Key nicht passt, Weg B.

**B) Selbst aus der Shipping-Exe extrahieren (verlässlich für die aktuelle Version):**
- Tool „AES Key Finder" laden (Anleitung/Repo: https://github.com/Cracko298/UE4-AES-Key-Extracting-Guide).
- `AES_finder.exe` in denselben Ordner wie die **Shipping-Exe** legen, ausführen, 15–30 s warten → `Key.txt` mit dem AES-256-Key (Format `0x…`, 64 Hex-Zeichen).

> Falls die Paks **unverschlüsselt** sind (FModel lädt sie ohne Key), diesen Schritt überspringen.

---

## Schritt 4 — FModel konfigurieren
1. FModel öffnen → **Settings**:
   - **Game's archive directory** = der Paks-Ordner aus Schritt 1.
   - **UE Version** = zuerst **`GAME_UE4_26`** wählen. Wenn Texturen später falsch/leer aussehen, alternativ eine UE5-Version testen (FModel zeigt beim Laden oft die passende Version an).
2. **Directory → AES**: den Key aus Schritt 3 eintragen (bei „Main Key").
3. **Load** / Verzeichnis laden → links erscheint der Asset-Baum.

---

## Schritt 5 — Map-Textur finden
Oben in FModel die **Suche** nutzen. Suchbegriffe (nacheinander probieren):
```
map, minimap, gateway, cartography, island, world, T_Map, T_Minimap, TableMap, Topograph, Satellite, MI_Map
```
Die richtige Datei ist eine **Textur (T_… / .uasset)**, die beim Anklicken in der Vorschau die **top-down Insel** zeigt (grüne Insel, Küsten, Flüsse — wie die aktuelle Overlay-Karte). Häufige Ablageorte:
```
TheIsle/Content/UI/…/Map
TheIsle/Content/…/Cartography
TheIsle/Content/…/Minimap
TheIsle/Content/…/HUD/Map
```
- Rechts zeigt FModel die **Auflösung** der Textur (z. B. 4096×4096). Je größer, desto besser.
- **Nicht** nehmen: eine **graue Heightmap** (Höhenkarte) oder eine reine Masken-Textur. Wir wollen die **farbige** Karte.
- Falls es mehrere gibt (z. B. `_Base`, `_Color`, `_Diffuse` vs. `_Height`, `_Mask`): die farbige/Base/Diffuse nehmen.
- Falls die Karte als **mehrere Kacheln** vorliegt (z. B. `Map_0_0`, `Map_0_1`, …): **alle** exportieren — ich setze sie zusammen.

---

## Schritt 6 — Als PNG exportieren
- Rechtsklick auf die Textur → **Save Texture (.png)** (bzw. „Export"). FModel exportiert in **Originalauflösung**.
- Zielordner merken (FModel-Standard: `…\FModel\Output\Exports\…`).
- **Notieren:** exakte **Auflösung** (Breite × Höhe) der exportierten PNG.

---

## Schritt 7 — Ergebnis übergeben
- Die PNG (+ ggf. Kachel-PNGs) hierhin kopieren, damit sie über ProtonDrive synct:
  ```
  BlackFossil\Overlay\map-source\        (neuen Ordner anlegen)
  ```
  Also z. B. nach `…\ProtonDrive…\BlackFossil\Overlay\map-source\gateway-raw.png`.
- Kurze Notiz dazulegen (`map-source\README.txt`): Auflösung, Asset-Pfad in FModel, UE-Version, ob farbig/Heightmap, ob eine oder mehrere Kacheln.

→ Danach übernehme ich (Mac-Seite): zuschneiden/ausrichten auf denselben Ausschnitt, **Kachel-Pyramide** erzeugen, `map.js` auf Tile-Rendering umbauen, Zonen auf Vektor + **Re-Kalibrierung**.

---

## Fallbacks / Stolperfallen
- **Paks verschlüsselt, kein Key gefunden:** Weg B (AES_finder) fast immer erfolgreich; sonst in der The-Isle-Modding-Community (Discord) nach dem aktuellen Evrima-AES-Key fragen.
- **UE-Version passt nicht** (Texturen leer/kaputt): in FModel andere `GAME_UE…`-Version wählen (4.27 / UE5_x).
- **Nur Heightmap gefunden:** dann exportieren wir zusätzlich die Heightmap — daraus lässt sich später eine stylische Karte bauen; für jetzt suchen wir aber die farbige.
- **Virtual Texture / gestreamt:** manche Welt-Composites sind keine einzelne Textur. Dann ist die **UI-/In-Game-Map-Textur** (die beim Karten-Öffnen im Spiel angezeigt wird) unser Ziel — die ist gebacken und exportierbar.
- **Rechtliches:** rein für den eigenen Server-Overlay-Gebrauch. Keine Weiterverbreitung der Spiel-Assets.

---

Quellen: FModel [fmodel.app](https://fmodel.app) · Key-Liste [FModel/Unreal-Game-Keys](https://github.com/FModel/Unreal-Game-Keys) · AES-Extraktion [Cracko298/UE4-AES-Key-Extracting-Guide](https://github.com/Cracko298/UE4-AES-Key-Extracting-Guide)
