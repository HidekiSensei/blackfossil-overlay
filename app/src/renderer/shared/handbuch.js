// Staff-Handbuch — Katalog aller Staff-Funktionen (aus dem echten Code).
// Aus overlay.js herausgeloest, damit Overlay UND Companion dieselbe Quelle
// nutzen (wie shared/lexikon.js). Reine Daten, keine Darstellung.
//
// Je Eintrag: id, cat (Kategorie mit Emoji), title, need ('staff'|'ingame'|
// 'admin' — benoetigter Rang), where[] (wo man die Funktion findet), short,
// details, steps[], caveat. Angezeigt werden nur Funktionen, die der Rang des
// Betrachters wirklich ausfuehren darf.

// Rang-Badge: [Label, Farbe]. any = Fallback.
export const HB_BADGE = { staff: ['Support-Team', '#22c55e'], ingame: ['Moderator+', '#3b82f6'], admin: ['Admin', '#ef4444'], any: ['Staff', '#9aa0a6'] };

export const HANDBUCH = [
  // 🦕 Dino-Token
  { id: 'token_create', cat: '🦕 Dino-Token', title: 'Dino-Token geben', need: 'staff',
    where: ['Overlay → Admin → 🦕 Dino-Token', 'Discord → Support-Panel → DINO TOKEN GEBEN'],
    short: 'Kompletten Dino als Garage-Token an einen Spieler vergeben.',
    details: 'Erstellt einen frei konfigurierten Dino und legt ihn als Token in die Garage des Ziel-Spielers. Spezies, Wachstum, Geschlecht, Prime-Bedingungen, Elder-Stacks und alle Mutationen (Base/Parent/Elder) sind wählbar. Ziel per Spieler-Auswahl, SteamID oder ganzer Rolle.',
    steps: ['Ziel wählen (Spieler / SteamID / Rolle)', 'Dino-Spezies wählen', 'Wachstum & Geschlecht', 'Prime-Bedingungen & Elder-Stacks', 'Mutationen wählen', 'Bestätigen'],
    caveat: 'Der Token landet in der Garage — der Spieler spielt ihn selbst auf. Jede Vergabe wird im Audit-Log protokolliert.' },
  { id: 'token_edit', cat: '🦕 Dino-Token', title: 'Dino-Token bearbeiten', need: 'staff',
    where: ['Overlay → Admin → 🦕 Dino-Token', 'Discord → Support-Panel → DINO TOKEN BEARBEITEN'],
    short: 'Vitals, Grow, Prime & Mutationen eines vorhandenen Garage-Tokens ändern.',
    details: 'Öffnet einen bestehenden Garage-Token eines Spielers und passt Wachstum, Geschlecht, Elder-Stacks, Prime-Bedingungen und Mutationen an.', steps: ['Spieler/SteamID wählen', 'Garage-Slot wählen', 'Werte anpassen', 'Speichern'], caveat: '' },
  { id: 'token_delete', cat: '🦕 Dino-Token', title: 'Dino-Token löschen', need: 'staff',
    where: ['Overlay → Admin → 🦕 Dino-Token', 'Discord → Support-Panel → DINO TOKEN LÖSCHEN'],
    short: 'Einen Token aus der Garage eines Spielers entfernen.', details: 'Löscht einen einzelnen Garage-Slot eines Spielers unwiderruflich.', steps: ['Spieler/SteamID wählen', 'Slot wählen', 'Bestätigen'], caveat: 'Unwiderruflich — der eingelagerte Dino ist danach weg.' },
  // 🏆 PvP / Prime
  { id: 'pvp_grant', cat: '🏆 PvP / Prime', title: 'PvP-Build verteilen', need: 'staff',
    where: ['Overlay → Admin → 🏆 PvP / Prime', 'Discord → Support-Panel → PVP-BUILD VERTEILEN'],
    short: 'Vordefinierten Turnier-Dino (100 %, Elder 3×, 16 Mutationen) vergeben.', details: 'Verteilt einen fertig konfigurierten Turnier-Build an einen Spieler, eine SteamID oder eine ganze Rolle — für PvP-Events.', steps: ['Build wählen', 'Ziel wählen (User/SteamID/Rolle)', 'Bestätigen'], caveat: 'Als Garage-Token. Über „PvP-Build entfernen" wieder einsammelbar.' },
  { id: 'pvp_remove', cat: '🏆 PvP / Prime', title: 'PvP-Build entfernen', need: 'staff',
    where: ['Overlay → Admin → 🏆 PvP / Prime', 'Discord → Support-Panel → PVP-BUILD ENTFERNEN'],
    short: 'Alle verteilten Turnier-Builds bei User/SteamID/Rolle wieder einsammeln.', details: 'Entfernt die per „PvP-Build verteilen" vergebenen Turnier-Token wieder aus den Garagen.', steps: ['Ziel wählen', 'Bestätigen'], caveat: '' },
  { id: 'prime', cat: '🏆 PvP / Prime', title: 'Prime-Bedingungen setzen', need: 'staff',
    where: ['Overlay → Admin → 🏆 PvP / Prime', 'Discord → Support-Panel → PRIME CONDITIONS'],
    short: 'Prime-Bedingungen auf dem AKTIVEN Ingame-Dino eines Spielers freischalten.', details: 'Setzt die gewählten Prime-Bedingungen (1–10) direkt auf den Dino, den der Spieler gerade ingame spielt.', steps: ['Spieler wählen', 'Bedingungen anhaken', 'Anwenden'], caveat: 'Der Spieler muss lebend ingame auf einem Dino sein.' },
  // ⚔️ Ingame-Eingriffe
  { id: 'lightning', cat: '⚔️ Ingame-Eingriffe', title: 'Lightning Strike (Slay)', need: 'ingame',
    where: ['Overlay → Admin → 🛠️ Tools', 'Discord → Support-Panel → LIGHTNING STRIKE'],
    short: 'Den aktiven Dino eines Spielers per Blitz töten.', details: 'Tötet den aktuell gespielten Dino eines Spielers (Slay) — z. B. bei Regelverstoß oder Steckenbleiben.', steps: ['Spieler wählen', 'Bestätigen'], caveat: 'Der Dino stirbt. Wird protokolliert.' },
  { id: 'gift', cat: '⚔️ Ingame-Eingriffe', title: 'Beschenken (Punkte/Token)', need: 'ingame',
    where: ['Overlay → Admin → 🛠️ Tools'],
    short: 'Punkte oder Token an einen User oder eine ganze Rolle vergeben.', details: 'Schenkt Punkte oder Inventar-Token (z. B. Grow-Boost, Lootbox) an einzelne Spieler oder alle Mitglieder einer Rolle.', steps: ['Ziel wählen (User/Rolle)', 'Typ & Menge', 'Bestätigen'], caveat: 'Wird protokolliert.' },
  { id: 'wipecorpses', cat: '⚔️ Ingame-Eingriffe', title: 'Leichen-Wipe', need: 'ingame',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'KI-Dinos & Kadaver auf dem Server leeren.', details: 'Räumt herumliegende Kadaver und KI-Dinos ab (Performance/Aufräumen).', steps: ['Im Server-Tab auslösen'], caveat: 'Kann kurz ruckeln, während der Server aufräumt.' },
  // ⚠️ Verwarnungen & Moderation
  { id: 'warn', cat: '⚠️ Verwarnungen & Moderation', title: 'User verwarnen', need: 'staff',
    where: ['Overlay → Admin → ⚠️ Verwarnungen', 'Discord → Support-Panel → VERWARNEN'],
    short: 'Verwarnung mit Grund + Regel-Paragraph erfassen (laufende Nummer automatisch).', details: 'Erfasst eine Verwarnung für einen User. Steam- und Discord-ID werden automatisch verknüpft, die laufende Nummer (1./2./3. …) zählt das System. Jede Verwarnung wird im Doku-Channel als Embed festgehalten.', steps: ['User wählen oder SteamID eingeben', 'Regel-Paragraph angeben', 'Grund angeben', 'Erfassen'], caveat: 'Doku-Channel vorher per /verwarn-channel setzen.' },
  { id: 'warn_search', cat: '⚠️ Verwarnungen & Moderation', title: 'Verwarnungen durchsuchen', need: 'staff',
    where: ['Overlay → Admin → ⚠️ Verwarnungen', 'Discord → Support-Panel → VERWARNUNGEN'],
    short: 'Liste der verwarnten User durchsuchen (User-ID, Steam, Grund, Paragraph).', details: 'Zeigt alle Verwarnungen, filterbar per Suchbegriff — inkl. Anzahl je User, Grund, Paragraph, Aussteller und Datum.', steps: ['Suchbegriff eingeben (leer = neueste)', 'Ergebnisse ansehen'], caveat: '' },
  { id: 'ban', cat: '⚠️ Verwarnungen & Moderation', title: 'Bann / Timeout', need: 'ingame',
    where: ['Discord → Support-/Admin-Panel'],
    short: 'Einen User vom Discord bannen oder timeouten.', details: 'Discord-Moderation: dauerhafter Bann oder temporärer Timeout eines Users. Wird ins Audit-Log geschrieben.', steps: ['User wählen', 'Dauer/Grund', 'Bestätigen'], caveat: 'Discord-seitige Aktion — betrifft nicht den Game-Server.' },
  { id: 'ticket', cat: '⚠️ Verwarnungen & Moderation', title: 'Support-Tickets bearbeiten', need: 'staff',
    where: ['Discord → Ticket-System', 'Overlay → Support (Tickets)'],
    short: 'Tickets übernehmen (claim), übergeben (forward) und schließen.', details: 'Support-Tickets der Spieler bearbeiten: übernehmen, an ein anderes Team-Mitglied übergeben, oder mit Grund schließen (Transcript wird archiviert).', steps: ['Ticket öffnen', 'Übernehmen / Übergeben / Schließen'], caveat: '' },
  // 🖥️ Server & KI
  { id: 'announce', cat: '🖥️ Server & KI', title: 'Ingame-Ankündigung', need: 'staff',
    where: ['Overlay → Team → 🛠️ Tools', 'Discord → Support-Panel → ANNOUNCEMENT'],
    short: 'Nachricht an alle Spieler ingame senden.', details: 'Sendet einen Broadcast an alle Spieler auf dem Server (z. B. Event-Hinweis, Restart-Warnung).', steps: ['Text eingeben', 'Senden'], caveat: '' },
  { id: 'srv_status', cat: '🖥️ Server & KI', title: 'Server-Status', need: 'staff',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'Aktuellen Server-Status & Spielerzahl ansehen.', details: 'Zeigt, ob der Game-Server läuft, wie viele Spieler online sind usw.', steps: ['Server-Tab öffnen'], caveat: '' },
  { id: 'srv_control', cat: '🖥️ Server & KI', title: 'Server-Steuerung (Start/Stop/Restart)', need: 'admin',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'Den Game-Server starten, stoppen oder neu starten.', details: 'Steuert den Game-Server-Prozess über den control-server. Nur für Admins/Owner.', steps: ['Aktion wählen', 'Bestätigen'], caveat: 'Betrifft ALLE Spieler — Restart trennt jeden. Mit Ankündigung vorwarnen.' },
  { id: 'ai_control', cat: '🖥️ Server & KI', title: 'KI-Dino-Steuerung', need: 'ingame',
    where: ['Overlay → Admin → 📢 Server'],
    short: 'KI-Dino-Dichte / -Spawns steuern.', details: 'Status und Steuerung der KI-Dinos (Dichte, Spawns). Gefährlichere Aktionen sind Admin-beschränkt.', steps: ['KI-Status ansehen', 'Aktion auslösen'], caveat: '' },
  { id: 'dino_limits', cat: '🖥️ Server & KI', title: 'Dino-Limits', need: 'ingame',
    where: ['Overlay → Admin', 'Discord → /dino-limits'],
    short: 'Maximale gleichzeitige Anzahl je Spezies festlegen.', details: 'Setzt Server-weite Caps, wie viele Dinos einer Spezies gleichzeitig gespielt werden dürfen (z. B. Rex-Limit).', steps: ['Spezies-Limit eintragen', 'Speichern'], caveat: 'Greift beim Swappen/Spawnen.' },
  // 👤 Spieler
  { id: 'user_info', cat: '👤 Spieler', title: 'Spieler-Info', need: 'ingame',
    where: ['Overlay → Admin → 🛠️ Tools'],
    short: 'Discord↔Steam, Punkte, Abo-Rang & mehr zu einem Spieler nachschlagen.', details: 'Zeigt die verknüpften IDs, Punktestand, Abo-Rang, Inventar und weitere Infos zu einem Spieler.', steps: ['Spieler/SteamID wählen', 'Infos ansehen'], caveat: '' },
  // 🔗 Accounts (Admin)
  { id: 'accounts_find', cat: '🔗 Accounts', title: 'Account suchen', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Discord↔Steam-Verknüpfung eines Users finden.', details: 'Sucht die Verknüpfung eines Accounts (per Discord-, Steam-ID oder Name).', steps: ['Suchbegriff eingeben'], caveat: '' },
  { id: 'accounts_link', cat: '🔗 Accounts', title: 'Account verknüpfen', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Discord- und Steam-ID manuell verknüpfen.', details: 'Legt eine Verknüpfung zwischen Discord- und Steam-Account an (falls die automatische Verknüpfung nicht griff).', steps: ['Discord-ID + Steam-ID eingeben', 'Verknüpfen'], caveat: 'Überschreibt eine bestehende Verknüpfung.' },
  { id: 'accounts_unlink', cat: '🔗 Accounts', title: 'Account trennen', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Eine Discord↔Steam-Verknüpfung aufheben.', details: 'Trennt die Verknüpfung eines Accounts.', steps: ['Account wählen', 'Trennen'], caveat: '' },
  { id: 'accounts_dups', cat: '🔗 Accounts', title: 'Doppel-Accounts finden', need: 'admin',
    where: ['Overlay → Admin → 🔗 Accounts'],
    short: 'Mehrfach-Verknüpfungen / verdächtige Accounts aufspüren.', details: 'Listet Accounts mit auffälligen Mehrfach-Verknüpfungen (Multi-Account-Verdacht).', steps: ['Liste ansehen'], caveat: '' },
  // 🎁 Wirtschaft
  { id: 'lootbox_config', cat: '🎁 Wirtschaft', title: 'Lootbox-Drop-Gewichte', need: 'admin',
    where: ['Overlay → Admin → 🎁 Lootbox'],
    short: 'Preis & Drop-Wahrscheinlichkeiten der Lootbox einstellen.', details: 'Konfiguriert den Preis pro Lootbox und die Gewichte der einzelnen Belohnungen.', steps: ['Kosten & Gewichte anpassen', 'Speichern'], caveat: 'Betrifft die Wirtschaft — mit Bedacht ändern.' },
];

