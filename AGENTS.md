# AGENTS.md — blackfossil-overlay

Ergänzt die Regeln im Dev-Root (`/home/san/dev/blackfossil/AGENTS.md`). Hier steht
nur, was für dieses Repo gilt.

## Companion lokal starten — zum Testen und zum Vorführen

Das Overlay lässt sich schwer testen (es beendet sich, wenn The Isle nicht läuft).
Die **Companion** dagegen läuft ohne Spiel und ist damit die Stelle, an der man
tatsächlich etwas nachprüfen kann. Der folgende Ablauf hat sich eingespielt.

### Voraussetzungen

Electron braucht eine Anzeige. Auf dieser Maschine läuft eine Sitzung auf
`DISPLAY=:1` — ohne die Variable startet nichts.

`node_modules` liegt nur im Haupt-Checkout. In einem frischen Worktree einmal
verlinken, sonst fehlt esbuild:

```bash
ln -s /home/san/dev/blackfossil/blackfossil-overlay/app/node_modules app/node_modules
```

**Der Renderer wird gebündelt.** `src/renderer/dist/` ist das, was die HTML-Datei
lädt — ohne `npm run build:renderer` hat jede Änderung an `src/renderer/*.js`
**keinerlei Wirkung**. Das ist die häufigste Ursache für „ich sehe meine Änderung
nicht".

### Zwei temporäre Zeilen in `app/src/companion-main.js`

Beide **niemals committen**.

```js
// Zeile 28 — auf Prod umleiten, weil auf api-test oft niemand online ist
const TOKEN_BASE = 'https://api.blackfossil.de';   // TEMPORÄR: LIVE

// Ausweichport, damit die Instanz NEBEN der installierten Companion läuft
const LOGIN_PORT = 53119;   // TEMPORÄR (installiert: 53118)
```

Ohne den Portwechsel beendet sich die neue Instanz sofort: die installierte App
hält 53118 und den Single-Instance-Lock.

### Starten

Eigenes Datenverzeichnis, damit sich beide Instanzen nicht in die Quere kommen.
Die Sitzung wird hineinkopiert, dann ist man sofort angemeldet:

```bash
mkdir -p /tmp/bf-review
cp "$HOME/.config/BlackFossil Companion Test/session.json" /tmp/bf-review/
cd app && npm run build:renderer
DISPLAY=:1 npx electron src/companion-main.js --user-data-dir=/tmp/bf-review
```

## Schreibzugriffe im Testlauf blockieren

**Das ist Pflicht, sobald gegen Prod getestet wird.** Ein Testlauf klickt Knöpfe,
und ein Fehlklick auf Live kann Zonen überschreiben, Dinos töten oder Limits
löschen. Der Riegel wird in den Renderer injiziert und fängt alles ab, was kein
GET ist:

```js
const _f = window.fetch;
window.fetch = (u, o) => {
  const m = ((o && o.method) || 'GET').toUpperCase();
  if (m !== 'GET') {
    console.log('BLOCKIERT ' + m + ' ' + u);
    return Promise.reject(new Error('Testlauf: Schreibzugriff blockiert'));
  }
  return _f(u, o);
};
```

Er soll **melden**, nicht still schlucken — `BLOCKIERT …` in der Ausgabe zeigt,
dass ein Testschritt etwas versucht hat, das man nicht wollte.

Braucht ein Test eine bestimmte Schreib-Route (etwa `POST /admin/user-info`, das
trotz POST nur liest), wird sie ausdrücklich ausgenommen:

```js
if (m !== 'GET' && !/user-info/.test(u)) { … }
```

Nie pauschal aufmachen. Wer den Riegel ganz weglässt, testet auf einem
Produktivsystem ohne Netz.

## Automatisierter Durchlauf

`app/src/companion-main.js` wird **temporär** instrumentiert. Muster:

```js
function __probe(win) {
  // Electron 33: (event, level, message, …). Neuere Versionen liefern ein
  // Event-Objekt — beides abfangen.
  win.webContents.on('console-message', (...a) => {
    const m = typeof a[2] === 'string' ? a[2] : (a[0] && a[0].message) || '';
    if (/^(JSERROR|REJECT|BLOCKIERT|T:)/.test(m)) console.log('[R]', m);
  });
  const js = (c) => win.webContents.executeJavaScript(c);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  win.webContents.on('did-finish-load', async () => {
    try {
      await js(`window.onerror=(m,s,l)=>console.log('JSERROR '+m+' @'+l);
        window.addEventListener('unhandledrejection',
          e=>console.log('REJECT '+(e.reason&&e.reason.message||e.reason)));true;`);
      await wait(5000);          // Login + erste Abfragen
      // … Schritte …
      console.log('[R] T: FERTIG');
    } catch (e) { console.log('[R] T: TESTFEHLER ' + (e && e.message)); }
  });
}
```

Eingehängt direkt nach dem `new BrowserWindow(…)`-Block, aufgerufen als
`__probe(win)`.

**Beide Fehlerarten mitschneiden.** `window.onerror` allein reicht nicht — die
meisten Fehler in diesem Code sind abgelehnte Promises und tauchen nur in
`unhandledrejection` auf.

Screenshots über `win.webContents.capturePage()`. Sie sind kein Beiwerk: mehr als
einmal hat eine DOM-Abfrage „alles da" gemeldet, während das Bild zeigte, dass ein
Element hinter einem anderen lag oder die Seite leer war.

## Fallen, die wirklich passiert sind

**Nicht die instrumentierte Datei sichern.** Wer `cp companion-main.js /tmp/backup`
macht, nachdem die Instrumentierung drin ist, und später erneut instrumentiert,
bekommt `SyntaxError: Identifier '__SHOT' has already been declared`. Zum
Zurücksetzen immer:

```bash
git checkout -- src/companion-main.js
```

Danach die beiden temporären Zeilen neu setzen, falls die Instanz weiterlaufen
soll.

**Die Review-Instanz nicht unter laufendem Betrieb überschreiben.** Wird
`companion-main.js` für einen Testlauf geändert, während die Vorführ-Instanz noch
läuft, stirbt Letztere. Entweder vorher beenden oder für Tests ein eigenes
Datenverzeichnis **und** einen dritten Port nehmen.

**`grep -c` gibt Exit-Code 1 bei null Treffern.** In einer `&&`-Kette bricht damit
alles Folgende ab — schon zweimal ist so ein Commit nicht zustande gekommen,
obwohl die Ausgabe unauffällig aussah.

**Statisch prüfen, ob jede angefasste ID auch erzeugt wird.** Eine Verdrahtung auf
ein nicht existierendes Element wirft beim `.onclick`, und **alles danach in
derselben Funktion läuft nie** — so waren einmal die Polymorph-Vorlagen tot, ohne
dass es beim Bauen auffiel:

```bash
node -e "
const fs=require('fs');
const src=fs.readFileSync('src/renderer/companion/panels/DATEI.js','utf8');
const roh=[...new Set([...src.matchAll(/el\('([A-Za-z0-9]+)'/g)].map(m=>m[1]))];
const erz=new Set([
  ...[...src.matchAll(/id=\\\\?\"([A-Za-z0-9]+)\\\\?\"/g)].map(m=>m[1]),
  ...[...src.matchAll(/U\.(?:btn|field|select|textarea|check)\('([A-Za-z0-9]+)'/g)].map(m=>m[1]),
]);
const f=roh.filter(id=>!erz.has(id));
console.log(f.length ? 'NIE ERZEUGT: '+f.join(', ') : 'IDs OK');
"
```

**Textersetzungen hart fehlschlagen lassen.** Ein `s.replace(alt, neu)`, dessen
Anker nicht mehr passt, tut still nichts. Immer vorher `assert alt in s` — sonst
merkt man erst zur Laufzeit, dass die Hälfte fehlt.

**Messwerte prüfen, bevor man sie als Beleg nimmt.** Zweimal hat ein verhakter
Testausdruck für jede Ansicht denselben Wert gemeldet. Wenn eine Prüfung
verdächtig gleichförmig aussieht, ist sie meist kaputt und belegt nichts.

## Vor dem Commit

```bash
git status --short           # companion-main.js darf NICHT dabei sein
npm run build:renderer
npm run test:shared
```

`src/renderer/dist/` ist ignoriert und gehört nicht in den Commit.

## Backend-Änderungen prüfen

Go ist auf dieser Maschine nicht installiert. Bauen und Testen läuft im Container:

```bash
podman run --rm -v "$PWD":/src:Z -w /src \
  -e GOFLAGS=-mod=mod -e GOCACHE=/tmp/gc -e GOMODCACHE=/tmp/gm \
  docker.io/library/golang:1.26 \
  sh -c 'go build ./... && go vet ./... && go test ./...'
```

Nicht ungefragt `gofmt` über berührte Dateien laufen lassen — mehrere sind im
Bestand bereits unformatiert, und eine Formatierung bläht den Diff mit Rauschen
auf, das mit der Änderung nichts zu tun hat.
