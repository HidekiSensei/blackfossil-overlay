Gateway-Map-Textur — Extraktion aus The Isle (Evrima)
=====================================================
Datum: 2026-07-04

Datei:            gateway-raw.png
Auflösung:        1792 x 1043 (Breite x Höhe)
Format:           PF_B8G8R8A8 (farbig, unkomprimiert — das ist die volle Originalauflösung
                  der In-Game-Kartentextur; KEINE Heightmap, KEINE Maske)
Kacheln:          eine einzige (keine Tiles)

Asset-Pfad:       TheIsle/Content/TheIsle/UI/Game/Textures/new_map
Quelle:           CLIENT-Paks  D:\Launcher\Steam\steamapps\common\The Isle\TheIsle\Content\Paks
                  (pakchunk*-WindowsClient, IoStore .utoc/.ucas, Oodle-komprimiert, AES-verschlüsselt)
AES-Main-Key:     0x9575FC2B9E612ADAB80906DB3A176591ECB47181DDA631000BD7FC4C875282E6
                  (aus Shipping-Exe via AESDumpster verifiziert; identisch mit Discord-Key des neuen Updates)
Engine/Version:   Mappings-Datei "5.4.3-0+UE5-TheIsle.usmap"; CUE4Parse-Profil = GAME_UE5_6
                  (The Isle hat ein Hybrid-Format: Zen-Package-Layout = 5.6, Assets = 5.4 — daher UE5_6)

Werkzeug (statt FModel-GUI, weil UE5 unversioned properties + .usmap nötig):
  Headless-Extraktor  C:\dev\isle-extract\  (.NET 10, CUE4Parse 1.2.2.202607)
  Aufruf:  set USMAP=<pfad zur .usmap>
           IsleExtract.exe <paks-ordner> GAME_UE5_6 <aes-key> "export:<asset>|<out.png>"
  Die .usmap liegt im Projekt: C:\dev\isle-extract\TheIsle.usmap

Hinweis: 1792x1043 ist die native Auflösung der gebackenen UI-Karte — eine höher aufgelöste
Variante existiert im Spiel nicht. Nächster Schritt (Mac-Seite): zuschneiden/ausrichten auf
denselben Ausschnitt wie die aktuelle Overlay-Karte, ggf. Tile-Pyramide, Zonen re-kalibrieren.
