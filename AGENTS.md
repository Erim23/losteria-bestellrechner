# Projektregeln für KI-Agenten

Gilt für alle Agenten, die an diesem Projekt arbeiten (ChatGPT Codex liest
diese Datei direkt, Claude Code über `CLAUDE.md`). **Bitte vor jeder Arbeit
lesen.**

## Worum es geht

Bestellrechner für die L'Osteria Bonn Portlandweg. Läuft produktiv unter
<https://erim23.github.io/losteria-bestellrechner/> und wird täglich von
mehreren Kollegen für die Mittagsbestellung benutzt.

## Das Wichtigste zuerst

**Jeder Push auf `main` ist nach etwa 30 Sekunden live.** Es gibt keine
Testumgebung. Eine kaputte Änderung steht sofort vor Kollegen, die gerade
bestellen.

**Niemals in der echten Bestellrunde testen.** Die App benutzt auch beim
lokalen Entwickeln dieselbe Firebase-Datenbank wie der Echtbetrieb.
Testbestellungen landen sonst im Warenkorb der Kollegen. Stattdessen eine
eigene Runde verwenden – `http://localhost:4599/#r=test-<name>` – und
hinterher aufräumen.

**`firestore.rules` wird nicht automatisch ausgerollt.** Die Datei im Repo ist
reine Dokumentation. Änderungen daran wirken erst, wenn sie jemand von Hand in
der Firebase-Konsole einfügt (Firestore → Regeln → Veröffentlichen). Wer die
Datei ändert, muss ausdrücklich darauf hinweisen.

## Zusammenarbeit

Am Projekt arbeiten zwei Personen mit je eigenem KI-Agenten. Das Wissen eines
Agenten über den Dateistand ist immer eine Momentaufnahme.

- **Vor jeder Arbeit** `git fetch origin` und prüfen, was dazugekommen ist:
  `git log HEAD..origin/main --oneline`.
- **Dateien vor dem Bearbeiten frisch einlesen** – nicht aus dem Gedächtnis
  arbeiten.
- **Nach dem Zusammenführen kontrollieren**, dass fremde Änderungen noch da
  sind. Das ist hier schon einmal schiefgegangen: Ein Rebase hat eine
  automatisch aktualisierte Speisekarte überschrieben.
- **Zügig pushen**, statt Änderungen liegen zu lassen.
- **Bei abgelehntem Push erst nachsehen**, was dazugekommen ist, bevor
  zusammengeführt wird.
- Übliches Vorgehen: eigener Zweig und Pull Request. Beide dürfen selbst
  zusammenführen, wenn die Änderung sauber ist.
- `renderer/app.js` hat über 3000 Zeilen und ist die Hauptkonfliktquelle – bei
  größeren Umbauten kurz absprechen.

## Aufbau

| Pfad | Zweck |
| --- | --- |
| `renderer/` | Die Web-App. Genau dieser Ordner wird auf GitHub Pages veröffentlicht. |
| `renderer/menu-seed.json` | Speisekarte. Wird automatisch aktualisiert – **nicht von Hand bearbeiten**. |
| `renderer/firebase-config.js` | Öffentliche Projektkennung, kein Geheimnis. |
| `src/menu.js` | Datenschicht: holt und normalisiert die Speisekarte (läuft in Node). |
| `src/main.js`, `src/preload.js` | Electron-Variante für den Einzelbetrieb. |
| `scripts/snapshot.js` | Holt die Speisekarte, prüft sie auf Plausibilität, schreibt den Seed. |
| `scripts/serve.js` | Kleiner Entwicklungsserver (`npm run serve`, Port 4599). |
| `scripts/cachebust.js` | Läuft nur beim Veröffentlichen; hängt die Commit-Kennung an alle Dateiverweise. |
| `.github/workflows/pages.yml` | Veröffentlichung auf GitHub Pages. |
| `.github/workflows/menu-refresh.yml` | Tägliche Speisekarten-Aktualisierung. |

Zwei Eigenheiten, die man kennen muss:

- Die Aktualisierung **stößt die Veröffentlichung ausdrücklich an**. Grund:
  GitHub löst bei Commits, die eine Action mit dem eingebauten Token macht,
  keine weiteren Abläufe aus. Ohne diesen Schritt käme die neue Speisekarte nie
  live an.
- Der Snapshot unterscheidet `fetchedAt` (Inhalt zuletzt geändert) von
  `checkedAt` (zuletzt erfolgreich nachgesehen). Der Veraltet-Hinweis in der
  Kopfzeile misst `checkedAt`.

## Fachliche Regeln, die nicht kaputtgehen dürfen

- **Rechenreihenfolge:** Zwischensumme → 20 % Rabatt → danach Essensmarken
  (je 6 €) auf den Restbetrag.
- **Marken-Verteilung** in der erweiterten Ansicht: jede Person bekommt erst
  eine Marke, der Rest wird von Hand zugeordnet. Ein „+" bei leerem Topf
  erhöht die Gesamtzahl.
- **Pizza Halb | Halb:** Es wird die **teurere** Hälfte berechnet, nicht die
  Summe. Erkannt wird das an den Gruppennamen, weil das offizielle Kennzeichen
  nur über die GraphQL-Schnittstelle käme.
- **Runde = Gruppe + Datum.** Der geteilte Link enthält nur die Gruppe
  (`#g=...`). Die Stammgruppe „Azubibüro" behält bewusst ihre alte Kennung
  `tag-JJJJ-MM-TT`, damit alte Links gültig bleiben.
- **Favoriten hängen am eingetragenen Namen**, nicht am Gerät.
- **Die Notiz gehört zur Zusammenstellung.** Zweimal dasselbe Gericht mit
  unterschiedlicher Notiz bleibt zwei Positionen.

## Entwickeln und Prüfen

```bash
npm install
npm run serve     # http://localhost:4599
npm start         # Electron-Variante
```

Beim Prüfen im Browser: **tatsächliche Sichtbarkeit messen** (`display`,
`getClientRects()`), nicht nur das `hidden`-Attribut. Genau daran ist hier
schon ein Test vorbeigelaufen, während die Oberfläche sichtbar kaputt war –
eine eigene `display`-Regel schlägt das eingebaute `display:none` von
`[hidden]`. Außerdem immer die Konsole ansehen und die Handy-Breite (390 px)
mitprüfen.
