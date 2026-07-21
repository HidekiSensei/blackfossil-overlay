// Rechte-Modell — eine Quelle für Overlay und Companion.
//
// Die Ränge spiegeln GET /token und damit auth.Actor im Backend:
//   admin   ADMIN_RANKS   = Developer, Owner, Admin
//   ingame  INGAME_RANKS  = Developer, Owner, Admin, Moderator
//   team    TEAM_RANKS    = bis hinunter zu Junior Support
//   staff   = ingame || team   (entspricht Actor.IsStaff())
//
// WICHTIG: Das hier ist reine ANZEIGE-Logik. Durchgesetzt wird serverseitig
// (requireRank in internal/admin, requireAdminHuman im Audit, h.require in ops).
// Ein Client, der hier lügt, bekommt trotzdem 403. Der Zweck ist, keine
// Schalter zu zeigen, die beim Klick nur scheitern würden.

export function makePerms(token, opts = {}) {
  const admin = !!token.admin;
  // Overlay-Semantik: Admin impliziert beides (overlay.js loadRoleUI).
  const ingame = !!token.ingame || admin;
  const team = !!token.team || admin;
  return {
    admin, ingame, team,
    staff: ingame || team,
    // online = der eigene Dino ist gerade auf dem Server (isYou in /positions).
    // Spieler sehen ihre Daten nur dann; Staff-Werkzeuge hängen NICHT daran.
    online: !!opts.online,
    name: token.name || '',
    rank: token.rank || '',
    // Eigene SteamID. /token nennt sie `identity` (es ist die LiveKit-Identity,
    // die dort gleich der SteamID ist) — deshalb der abweichende Feldname.
    // Gebraucht ueberall dort, wo man eine Aktion auf sich selbst richtet.
    steamId: token.identity || '',
  };
}

// Rang-Stufen, wie requireRank sie kennt.
const LEVEL = {
  any: () => true,
  staff: (p) => p.staff,
  ingame: (p) => p.ingame,
  admin: (p) => p.admin,
};

// Fähigkeiten → benötigte Stufe. Jeder Eintrag nennt den Endpunkt, aus dem die
// Anforderung stammt, damit das bei Backend-Änderungen nachprüfbar bleibt.
export const CAPS = {
  // ── Team ──────────────────────────────────────────────────────────────
  'team.users':        'staff',   // GET  /admin/users
  'team.warnings':     'staff',   // GET/POST /admin/warnings
  'team.userInfo':     'ingame',  // POST /admin/user-info   (NICHT staff!)
  'team.playerAudit':  'staff',   // GET  /admin/player-audit (requireStaffHuman)
  // Team-Audit ist bewusst STRENGER als Player-Audit: es zeigt, was jedes
  // Staff-Mitglied getan hat (internal/audit requireAdminHuman).
  'team.staffAudit':   'admin',   // GET  /admin/staff-audit

  // ── Admin / Welt ──────────────────────────────────────────────────────
  'world.read':        'admin',   // GET  /admin/world/*   (WorldRoutes = admin)
  'world.write':       'admin',   // POST /admin/world/*
  'limits.read':       'any',     // GET  /dino-limits     (jeder Angemeldete)
  'limits.write':      'admin',   // POST /admin/dino-limits
  'ops.read':          'admin',   // GET  /admin/ops/*     (h.require "admin")
  'voice.listen':      'admin',   // POST /voice/listen    (voiceIsAdmin + Audit)
  'dino.polymorph':    'admin',   // POST /admin/players/{id}/polymorph (WorldRoutes = admin)
  'team.lightning':    'ingame',  // POST /admin/lightning  (requireRank "ingame")
  'team.follow':       'ingame',  // POST/DELETE /admin/follow
  'team.toast':        'staff',   // POST /admin/toast
  'team.gift':         'ingame',  // POST /admin/gift
  'token.dino':        'staff',   // /admin/dino-token/*
  'token.pvp':         'staff',   // /admin/pvp/*
  'token.prime':       'staff',   // POST /admin/prime

  // ── Server ────────────────────────────────────────────────────────────
  'server.status':     'staff',   // GET  /admin/server/status
  'server.announce':   'staff',   // POST /admin/server/announce
  'server.wipe':       'ingame',  // POST /admin/server/wipecorpses
  'server.control':    'admin',   // POST /admin/server/control

  // ── Support ───────────────────────────────────────────────────────────
  // Tickets liegen unter /me/* — jeder sieht seine eigenen. Die Bearbeitung
  // (claim/close/forward) ist Staff-Sache.
  'support.read':      'any',     // GET  /me/tickets
  'support.handle':    'staff',   // POST /me/ticket-claim | -close | -forward

  // ── Karte ─────────────────────────────────────────────────────────────
  // /positions liefert technisch allen alles; die Overwatch-Ansicht bleibt
  // trotzdem Staff-only, damit Spieler keine fremden Positionen sehen.
  'map.showAll':       'staff',
  'map.encounters':    'staff',   // GET /ai/encounters
  'map.teleports':     'any',     // GET /teleports
};

export function can(perms, capability) {
  const level = CAPS[capability];
  if (!level) {
    // Unbekannte Fähigkeit = Tippfehler. Sichtbar scheitern statt still
    // freigeben — ein stiller `true` wäre ein Rechteloch.
    console.warn('perms: unbekannte Fähigkeit', capability);
    return false;
  }
  return LEVEL[level](perms);
}
