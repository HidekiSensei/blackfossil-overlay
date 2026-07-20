// Gemeinsamer App-Kern: DOM-Zugriff, API-Aufrufe, Fehler-Normalisierung.
// Alles, was App-State braucht (Token, API-Basis, Toasts), wird per Factory
// injiziert — diese Datei hält selbst keinen State und importiert nichts aus
// overlay.js. Nur so ist sie auch aus der Companion-App nutzbar.

export const el = (id) => document.getElementById(id);

// apiErr normalisiert beide Fehlerformen: {error:{code,message}} (Go-Backend)
// und {error:"text"} (Legacy-token-service-Proxy).
export function apiErr(d, fallback) {
  const e = d && d.error;
  if (e && typeof e === 'object') return e.message || e.code || fallback || 'Fehler';
  return e || fallback || 'Fehler';
}

// makeApi baut den generischen API-Aufrufer (GET/POST/PATCH/DELETE → geparste
// Antwort, wirft bei !ok).
//
// tokenBase und token sind GETTER-Funktionen, keine Werte: beide werden erst
// asynchron gesetzt (config kommt aus window.bf.getConfig(), sessionToken aus
// der Session). Würden wir sie als Werte übergeben, wäre der Client für immer
// auf undefined festgenagelt.
export function makeApi({ tokenBase, token }) {
  return async function api(method, path, body) {
    const opt = { method, headers: { Authorization: `Bearer ${token()}` } };
    if (body !== undefined && body !== null) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(`${tokenBase()}${path}`, opt);
    let d = {}; try { d = await r.json(); } catch { /* leerer Body ist ok */ }
    if (!r.ok) {
      // apiErr liefert IMMER einen Text ("Fehler" als letzter Fallback) — ein
      // `apiErr(d) || \`HTTP ${r.status}\`` waere also toter Code gewesen und
      // verschluckte den Statuscode. Genau der ist aber die nuetzliche Auskunft,
      // wenn der Body nichts hergibt: ein 404 (Endpunkt auf dieser Umgebung nicht
      // deployed) sieht sonst aus wie ein 500.
      const err = new Error(d && d.error ? apiErr(d) : `HTTP ${r.status}`);
      err.status = r.status;   // Panels koennen so gezielt auf 404/403 reagieren
      throw err;
    }
    return d;
  };
}

// makeApiAction: POST + Erfolgs-Toast + optionaler Reload, Fehler landen als
// Error-Toast statt als Exception. `after` läuft nach jedem Erfolg (im Overlay
// pollHud, in der Companion i. d. R. nichts).
export function makeApiAction({ api, toast, after }) {
  return async function apiAction(path, body, okMsg, reload) {
    try {
      const d = await api('POST', path, body || {});
      toast(okMsg.replace('{dino}', d.dino || ''), 'success');
      if (after) after();
      if (reload) await reload();
    } catch (err) { toast(err.message, 'error'); }
  };
}

// armConfirm: Zwei-Klick-Bestätigung für destruktive Aktionen. Der erste Klick
// beschriftet den Button für 2,5 s um, erst der zweite löst aus.
export function armConfirm(btn, label, fn) {
  if (btn.dataset.armed) { fn(); return; }
  btn.dataset.armed = '1';
  const t = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = t; delete btn.dataset.armed; }, 2500);
}
