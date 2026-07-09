# Changelog

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
