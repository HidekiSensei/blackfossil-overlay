# Changelog

<!-- Kuratiert & spielerfreundlich. CI erzeugt daraus releases.json fürs Overlay-Update-Fenster.
     Neue Version: einen "## vX.Y.Z — Titel"-Abschnitt oben ergänzen (Version MUSS zu package.json
     passen), Punkte unter "## [Unreleased]" nach oben verschieben. "### Intern" wird aus den
     öffentlichen Notes herausgefiltert. -->

## [Unreleased]

## v1.10.0 — Die Companion-App 🖥️

### ✨ Neu

- **Companion-App** — eine zweite Anwendung neben dem Overlay, die **ohne laufendes Spiel**
  funktioniert. Damit sind Karte, Team- und Server-Werkzeuge erreichbar, ohne selbst online zu sein.
  Sie installiert sich getrennt und läuft parallel zum Overlay.
  - **Vollbild-Karte** mit allen Spielern: Namen, Dino und Wachstum, Spuren der letzten Minuten,
    Rechteck-Auswahl, Zoom bis 15×, Heatmap.
  - **Karten-Editor** für Zonen, Teleports und KI-Encounter — anlegen, verschieben, Punkte
    hinzufügen und löschen, alles hinter einem Bearbeiten-Schalter.
  - **Spieler** — alle Konten durchsuchbar, Anwesende zuerst. Im Detail: Nachricht schicken,
    beschenken, folgen, Blitzschlag. Mehrere gleichzeitig per Strg.
  - **Tokens** — Dino-Token mit Art, Geschlecht, Wachstum, Primes und Mutationen; dazu die Garage
    eines Spielers ansehen, bearbeiten und aufräumen. PvP-Turnier-Builds vergeben.
  - **Dino-Verwaltung**, **Welt** (Tageszeit, Wetter, Wachstums-Stopp), **Ankündigungen**,
    **Support-Tickets**, **Verwarnungen**, **Accounts**, **Lexikon** und ein **Staff-Handbuch**.
  - **Player- und Team-Audit** als echte Tabellen mit Filtern und Sortierung.
  - **Mithören**: Admins können den Sprachfunk im Umkreis eines Spielers verfolgen.

- **Wandern** im Overlay — Bestenliste fürs Laufen, Fliegen und Schwimmen, mit Wochen- und
  Gesamtwertung, persönlichen Rekorden und Live-Distanzanzeige. Dinos lassen sich benennen.

- **Farbschemata** in der Companion: sieben Vorlagen plus eigene Farbe. Ein Farbwert genügt —
  Akzente, Rahmen und Hintergründe leiten sich daraus ab.

### 🔧 Verbessert

- **Server-Panel** im Overlay in Reiter aufgeteilt, mit neuem Übersichts-Dashboard: Auslastung,
  Festplatte, Datenbank-Antwortzeit und ein 24-Stunden-Verlauf der Spielerzahl.
- **Updates und Änderungshinweise** kommen jetzt vom eigenen Server statt von GitHub. Für dich
  ändert sich am Ablauf nichts — es aktualisiert sich weiterhin von selbst.
- Ein **roter Punkt** an den Einstellungen zeigt an, wenn eine neue Version bereitsteht; ein Klick
  führt direkt dorthin.

### 🐛 Behoben

- **Windows**: Das Overlay lag im Fenstermodus versetzt über dem Spiel und misst sich jetzt korrekt ein.
- **Sprachfunk**: Kurzes Flackern des Todes-Zustands konnte die Tonkette zerlegen — entprellt.
- **Zuschauen**: Im Zuschauer-Modus zeigt die Karte einen Punkt statt eines Blickrichtungs-Pfeils,
  und der Kompass blendet sich aus.
- Kartenmarker behalten ihre Bedeutung, statt sich mitzufärben — ein Teleportpunkt sieht überall
  gleich aus.

### Intern

- Auto-Update und Release-Notes laufen über das eigene Backend (`/overlay`), damit das Repository
  privat werden kann. Overlay und Companion nutzen getrennte Kanäle.
- Neuer CI-Riegel gegen versehentlich committete Test-Umleitungen (Produktions-URL, Ports).
- Installer werden nicht mehr blind zwischengespeichert — der Dateiname ist versionslos, wodurch
  bis zu einen Tag lang die alte Fassung ausgeliefert wurde.
- Rang-Prüfung für das Schreiben der Class-Limits ergänzt (fehlte vollständig).

## v1.9.2 — Menü-Frischekur & Software-Tab ✨

### ✨ Neu
- Neuer **Software**-Tab in den Einstellungen: zeigt die Version und die letzten Änderungen.
- Menüs überarbeitet: echte Reiter-Tabs, einheitliche Buttons/Regler/Schalter, aufgeräumtes Design.
- Eigener **Ansage**-Tab im Team-Panel für server-weite Durchsagen.
- Fenster-Transparenz der Menüs umschaltbar (unter „HUD-Sichtbarkeit").

### 🔧 Fixes
- Einstellungen, Team- und Admin-Fenster sind jetzt gleich groß und scrollen sauber.
- Player-Audit: der Aktions-Filter ist jetzt ein durchsuchbares Auswahl-Popup statt der fummeligen Liste.

## v1.9.1 — Voice-Hotfix 🔧

### 🔧 Fixes
- Knistern behoben, Ausgabegerät-Auswahl korrigiert, Not-Aus-Schalter für 3D/Effekte.

## v1.9.0 — Räumlicher Ton & Gottstimme 🎙️

### ✨ Neu
- Räumlicher Voice-Ton (3D-Panning) — du hörst, aus welcher Richtung jemand spricht.
- **Gottstimme**: server-weite Admin-Durchsage „von oben" mit dezentem Himmels-Hall.
- Unterwasser dämpft die Stimmen jetzt hörbar.

## v1.8.2 — Test-Installer parallel 🧪

### ✨ Neu
- Test-Version läuft parallel zur Produktiv-App (eigener Deep-Link + eigener Datenordner).

## v1.7.5 — Kalibrierung: endlich alle Punkte an Land ✅

### 🔧 Fixes
- **Echter Fix für die Kalibrier-Punkte im Ozean.** Die Auto-Kalibrierung mischte bisher die gezeichneten Zonen-Ecken in die Zielauswahl — und deren äußerste Ecken liegen im Wasser. Dadurch teleportierte sie zu Wasser-Punkten und die zuvor angepassten Land-Anker wurden nie verwendet. Jetzt nutzt sie **ausschließlich die pixel-verifizierten Land-Punkte**.

## v1.7.4 — Kalibrierung: Referenzpunkte jetzt wirklich an Land 🎯

### 🔧 Fixes
- **Auto-Kalibrierung teleportiert jetzt zu Punkten, die sicher an Land liegen** (pixel-genau aus der Karte gewählt und verifiziert) — die vorherigen Ziele lagen teils noch im Ozean und ließen sich nicht anklicken. (Wer bereits kalibriert hat, muss nichts tun.)

## v1.7.2 — Neue Karte & verschiebbare Timer 🗺️

### ✨ Neu
- **🗺️ Neue Karte: Gateway V5.0** — aktualisiertes Kartenbild mit überarbeitetem Gateway, neuen Anlagen und Flussverläufen. Alle Positionen, Zonen und Wegpunkte passen weiterhin exakt (gleiche Kalibrierung).
- **⏱️ Timer sind jetzt frei platzierbar**: Der **Grow-Timer**, der **Goldene-Zone-Timer** und der **PvE-Einpark-Countdown** sitzen jetzt standardmäßig **oben neben deiner Punkte-Anzeige** — und lassen sich wie die anderen HUD-Elemente **verschieben und skalieren** (Einstellungen → HUD anpassen).
  - Im Bearbeiten-Modus werden die Timer als **Vorschau eingeblendet**, auch wenn gerade keiner läuft — so kannst du sie jederzeit platzieren.
  - „Layout zurücksetzen" stellt die Standard-Position neben den Punkten wieder her.

## v1.7.1 — Goldene Patrol-Zone: Feinschliff 🔧

### 🔧 Fixes
- **HUD erscheint erst bei Bedarf**: Der Goldene-Zone-Timer (inkl. „alle müssen rein"-Hinweis) wird jetzt erst angezeigt, wenn **mind. einer aus der Gruppe (oder du selbst) schon einmal in der goldenen Zone war**. Vorher war die Anzeige dauerhaft sichtbar und dadurch störend. (Wo die Zone liegt, zeigt weiterhin die goldene Markierung auf der Karte.)
- **Timer läuft jetzt rund**: Der Countdown springt nicht mehr bei jedem Server-Poll zurück, sondern zählt flüssig herunter.
- **Kein „Zonen-Springen" mehr**: Die goldene Zone wechselt nicht mehr fälschlich, während man drinsteht (kurzzeitige Server-Aussetzer werden abgefangen).

## v1.7.0 — Zonen-Rework & Goldene Patrol-Zone ⭐

### ✨ Neu
- **⭐ Goldene Patrol-Zone**: Pro Gruppe (oder allein) ist zufällig **eine Patrol-Zone golden**. Steht **die ganze Gruppe 15 Minuten** darin, gibt es **+100 Punkte pro Person**. Danach 15 Min Pause, dann rotiert eine neue goldene Zone rein. Ein **HUD-Timer oben** zeigt den Fortschritt.
  - Verlässt **jemand** die Zone, **pausiert** der Timer (kein Reset) — mit klarem Hinweis: „ALLE müssen in die Patrol-Zone, damit der Timer weiterläuft".
  - Die goldene Zone ist auf der Karte **golden hervorgehoben** (auch wenn der Patrol-Layer ausgeblendet ist).
- **👑 Prime über unsere Zonen**: Besuchte **Patrol-/Migrations-/Sanctuary-Zonen** zählen jetzt für die Elder-/Prime-Bedingungen (4 Patrol-Zonen, 2 Migrations-Zonen, Sanctuary als Juvenile) — pro Dino-Leben getrackt.

### 🗺️ Karte
- **Sanctuary / Patrol / Migration** werden jetzt als **sauberer Umriss** aus den vom Team gezeichneten Zonen gezeichnet (kein festes Bild, **kein Name-Label** mehr) — pro Typ **ein-/ausblendbar**.
- Die Zonen-Anzeige zeigt jetzt **alle** Zonen, in denen du gerade stehst (z. B. „Patrol · Migration") — Zonen überlappen sich, mehrere gelten gleichzeitig.

## v1.5.0 — Lootbox & Grow-Boosts direkt im Overlay 🎁

### ✨ Neu
- **🎁 Lootbox-Panel** (neuer Dock-Button): Boxen mit **Punkten** oder **Gratis-Boxen** öffnen, Drop-Chancen sehen und den Gewinn direkt ins Token-Inventar bekommen — komplett im Overlay, kein Discord mehr nötig.
- **📈 Grow-Boost** (Token): beschleunigt dein Wachstum **~1 Stunde** lang (+~20 %/h aktiver Spielzeit).
- **⏹️ Grow-Stop** (neuer Token): **stoppt** dein Wachstum **1 Stunde** lang auf einer **selbst gewählten Prozentzahl** — per Schieberegler einstellbar.
- **⚡ Insta-Grow** (Token): setzt dein Wachstum sofort auf 80 %.
- Alle Grow-Token werden im Lootbox-Panel unter **„Deine Grow-Token"** angezeigt und mit einem Klick eingelöst.

### 🛡️ Admin
- Neuer Admin-Tab **🎁 Lootbox**: **Box-Preis** und **Drop-Gewichte** je Token live einstellbar.

## v1.2.4 — Fix: Farbthemen fürs Team 🎨

### 🔧 Fixes
- **Team-Mitglieder** haben jetzt zuverlässig **alle Farbthemen** freigeschaltet (keine Schloss-Symbole mehr), inklusive **🎨 Eigene Farbe** mit Color-Picker — wie es für Obsidian/Team gedacht ist.

## v1.2.3 — Dino-Info & Karte 🦖

### 🧬 Dino-Info
- **Mutationen neu dargestellt** — übersichtlich nach **Basis / Eltern / Elder** gruppiert und tabellarisch mit **deutscher Kurzbeschreibung** je Mutation (was sie bewirkt). Auch im Garage-/Markt-Detail.
- **Prime-Fortschritt** — neuer Fortschrittsbalken (x/5 Bedingungen), klarere Bezeichnungen, „auto"-Markierung für automatische Bedingungen und kleine Zwischenschritt-Hinweise.
- **⚰️ Entomben-Button** — deinen aktuellen Dino direkt aus der Dino-Info entomben (neben „💀 Slay").

### 🔊 Voice
- **Sprecher-Anzeige in Rollenfarbe** — wer gerade in deiner Nähe spricht, wird in seiner **Discord-Rollenfarbe** angezeigt. Spender, Abonnenten und Team sind so auf einen Blick erkennbar.

### 🗺️ Karte
- **Wegpunkt anpassbar** — Farbe & Größe des Wegpunkt-Markers frei einstellbar (Einstellungen → 🗺️ Karten-Marker).
- **Spieler-Pfeil** — eigene Position/Blickrichtung bleibt beim Reinzoomen gut sichtbar; Pfeil-Farbe wählbar.

## v1.2.2 — Performance ⚡

### ⚡ Performance / FPS
- **Deutlich weniger FPS-Verlust im Spiel** — teure Dauer-Effekte (Weichzeichner, animierte Vitalbalken, HP-Herz, drehender Minimap-Ring) laufen jetzt nur noch, wenn das Dock/Panel offen ist. Beim Spielen bleibt das Overlay statisch und GPU-schonend.
- **Neues „⚡ Low-Spec / Performance"-Menü in den Einstellungen** — Master-Schalter „Low-Spec-Modus" plus Einzelschalter für **🌫️ Weichzeichner**, **⚡ Effekte** und **🗺️ Minimap**. Alle Einstellungen bleiben gespeichert.

## v1.1.1 — Bugfix

### 🔧 Fixes
- **🔊 „Wen du gerade hörst"** zeigt jetzt wirklich nur noch die Spieler, die du auch **hören kannst** — Sprecher außerhalb deiner Reichweite (oder wenn du taub bzw. jemanden stummgeschaltet hast) erscheinen nicht mehr.

## v1.1.0 — Großes Feature-Update 🦖

### 🆕 Neue Features
- **🆘 Support direkt im Overlay** — öffne Hilfe- oder „Spieler melden"-Tickets und chatte direkt im Overlay (immer synchron mit Discord). Das Team kann Tickets annehmen, weiterleiten und schließen.
- **🎁 Token-Markt im Overlay** — Token-Auktionen und Direkt-Tausch mit anderen Spielern, geteilt mit dem Discord-Markt.
- **🔎 Gesuche (Want-to-buy)** — suche gezielt nach Dinos/Token und biete Punkte oder Token. Plus **📋 „Meine Angebote"** mit Überblick über alles Eigene. Alle Angebote laufen jetzt 72 Stunden.
- **🦖 Profil: „Dinos auf dem Server"** — die rechte Profilspalte zeigt jetzt live die aktuelle Anzahl jeder Spezies vs. Limit (die Tickets sind in den Support-Bereich gewandert).
- **🗺️ Minimap an/aus** — neuer Schalter in den Einstellungen.
- **🔊 „Wen du gerade hörst"** — die Info-Box zeigt die Namen der Spieler, die du gerade über Voice hörst.

### ⚔️ Balance / Anti-Flucht
- **Einparken, Swap & Teleport** funktionieren nur noch mit vollem Dino (100 % Health, Blut & Stamina, nicht blutend) — damit sie nicht als Flucht aus dem PvP missbraucht werden.
- **Ausparken** braucht jetzt mindestens **50 m** Abstand zum nächsten Spieler.
- **Spezies-Limit** — ist eine Spezies voll, wird sie aus dem Spawn-Picker entfernt. Bestehende Dinos bleiben, niemand wird getötet.

### 🔧 Verbesserungen & Fixes
- Selbst-Slay tötet jetzt **leise** — kein lauter Blitz-Sound mehr.
- Quest-Fix: keine Übernahme von Mutationen/Prime mehr (Dupe behoben).
- Diverse Stabilitäts- und Performance-Verbesserungen.

### 🛠️ Für das Team
- Komplette Staff-Verwaltung jetzt im Overlay (tab-basiert): Dino-Token, PvP-Builds, Prime, Account-Verwaltung, Server-Steuerung & Ansagen.

> ⬆️ Das Update installiert sich beim nächsten Start automatisch.
