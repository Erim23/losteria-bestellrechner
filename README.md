# L'Osteria Bestellrechner

Ein Desktop-Programm (Windows, Electron), das die Speisekarte der **L'Osteria Bonn
Portlandweg (Rheinwerk)** anzeigt, einen Warenkorb führt und den zu zahlenden Betrag
mit **Essensmarken** und **20 %-Rabatt** berechnet.

- **Filiale:** L'Osteria Bonn Portlandweg, Portlandweg 4, 53227 Bonn
- **Datenquelle:** öffentliche Smoothr-API (`api.smoothr.de`) – dieselbe, die auch
  `order.losteria.net` verwendet. Die Speisekarte wird **live** geladen; offline
  greift die App auf einen Zwischenspeicher bzw. den mitgelieferten Stand zurück.

## Funktionen

- Vollständige Speisekarte nach Kategorien (Pizza, Pasta, Antipasti, Insalatone,
  Dolci, Getränke …) mit Bildern, Beschreibungen und Preisen.
- Gerichte per Klick in den Warenkorb legen, Mengen ändern.
- **20 %-Rabatt** als Umschalter.
- **Essensmarken** (1 Marke = 6,00 €): Anzahl frei wählbar, „Max"-Knopf für die
  verschwendungsfreie Höchstzahl, Warnung wenn Marken verfallen.
- Reihenfolge der Berechnung: **erst Rabatt, dann Essensmarken auf den Restbetrag**.

### Rechenbeispiel

```
Warenkorb           50,00 €
− 20 % Rabatt       −10,00 €   → 40,00 €
− 5 Essensmarken    −30,00 €   (5 × 6 €)
──────────────────────────────
Restbetrag           10,00 €
```

## Voraussetzungen

- [Node.js](https://nodejs.org/) (Version 18 oder neuer)

## Loslegen

```bash
npm install      # einmalig: Abhängigkeiten installieren
npm start        # App starten
```

## Weitere Befehle

| Befehl             | Zweck                                                              |
| ------------------ | ------------------------------------------------------------------ |
| `npm start`        | Startet die Desktop-App.                                           |
| `npm run pack`     | Baut die portable App nach `dist/win-unpacked/` (ohne Zusatz­setup). |
| `npm run dist`     | Baut einen Windows-Installer (`.exe`) – **braucht Entwicklermodus**. |
| `npm run snapshot` | Aktualisiert den mitgelieferten Speisekarten-Stand (Seed).         |
| `npm run serve`    | Startet einen kleinen Web-Server zum Testen der Oberfläche.        |

## Als `.exe` bauen

**Empfohlen – portable App (funktioniert ohne Zusatzeinrichtung):**

```bash
npm run pack
```

Ergebnis: `dist/win-unpacked/`. Die App startest du per Doppelklick auf
`LOsteria Bestellrechner.exe` in diesem Ordner. Den ganzen Ordner kannst du
kopieren/zippen und weitergeben.

**Optional – Installer (`…Setup….exe`):**

```bash
npm run dist
```

Dafür muss unter Windows der **Entwicklermodus** aktiv sein
(Einstellungen → Datenschutz & Sicherheit → Für Entwickler → „Entwicklermodus"),
sonst kann `electron-builder` die Signier-Werkzeuge nicht entpacken
(Fehler „Cannot create symbolic link"). Alternativ ein Terminal **als Administrator**
verwenden. Beim ersten Mal lädt der Builder zusätzliche Werkzeuge aus dem Internet nach.

## Projektstruktur

```
losteria-rechner/
├─ src/
│  ├─ main.js      Electron-Hauptprozess (Fenster, Laden/Caching der Speisekarte)
│  ├─ preload.js   sichere Brücke Renderer ↔ Hauptprozess
│  └─ menu.js      Datenschicht: lädt & normalisiert die Speisekarte (Smoothr-API)
├─ renderer/
│  ├─ index.html   Oberfläche
│  ├─ styles.css   Gestaltung (L'Osteria-Look)
│  ├─ app.js       Speisekarte, Warenkorb, Rechner
│  └─ menu-seed.json  Offline-Fallback (per `npm run snapshot` erzeugt)
└─ scripts/
   ├─ snapshot.js  erzeugt menu-seed.json
   └─ serve.js     Test-Server für die Oberfläche
```

## Hinweis

Die verwendete Smoothr-API ist inoffiziell/undokumentiert. Sollte L'Osteria die
Schnittstelle ändern, muss ggf. die Datenschicht (`src/menu.js`) angepasst werden.
Die andere Bonner Filiale lässt sich über die `VENUE_ID` in `src/main.js` bzw.
`scripts/snapshot.js` einstellen.
