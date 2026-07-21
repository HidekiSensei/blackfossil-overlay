// Verbindet die /positions-Spieler mit dem Staff-User-Verzeichnis und haengt die
// beiden Label-Zeilen an, die die Karte zeichnet.
import { userLabel } from './users.js';
import { baseClass, fmtGrow } from './format.js';

// Warum ein Verzeichnis noetig ist: /positions traegt nur `name` und `realName`,
// aber KEINEN Discord-Namen. userLabel braucht fuer "RP (Steam, Discord)" alle
// drei. Die dritte Quelle ist GET /admin/users (staff-gated). Faellt der Call
// aus, bleibt die Karte nutzbar — man verliert nur den Discord-Namen.
export function decoratePositions(players, dir) {
  for (const p of players) {
    const u = dir && dir.get(p.steamId);
    p.label1 = u
      ? userLabel(u)
      : userLabel({ rpName: p.name, ingameName: p.realName, steamId: p.steamId });
    p.label2 = [baseClass(p.dino), fmtGrow(p.grow)].filter(Boolean).join(' · ');
  }
  return players;
}

export function buildUserDir(users) {
  const m = new Map();
  for (const u of users || []) if (u.steamId) m.set(u.steamId, u);
  return m;
}
