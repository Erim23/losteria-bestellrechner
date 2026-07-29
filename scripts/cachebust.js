'use strict';

/**
 * Hängt eine Version an alle eigenen Dateiverweise, damit Browser nach einer
 * Änderung sofort die neue Fassung laden.
 *
 * Hintergrund: GitHub Pages liefert alles mit "max-age=600" aus. Ohne
 * Versionsangabe sehen Besucher bis zu 10 Minuten lang die alte Fassung.
 *
 * Wird nur im Pages-Deployment ausgeführt (nicht lokal und nicht in Electron).
 * Aufruf:  node scripts/cachebust.js <version>
 */

const fs = require('fs');
const path = require('path');

const version = (process.argv[2] || String(Date.now())).replace(
  /[^A-Za-z0-9_.-]/g,
  ''
);
const RENDERER = path.join(__dirname, '..', 'renderer');

/**
 * Ersetzt feste Textstellen in einer Datei. Fehlt eine davon, bricht der
 * Vorgang ab – sonst würde stillschweigend ohne Versionsangabe veröffentlicht.
 */
function replaceIn(file, pairs) {
  const full = path.join(RENDERER, file);
  let text = fs.readFileSync(full, 'utf8');

  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.error(`FEHLER: "${from}" nicht in ${file} gefunden.`);
      console.error('Wurde eine Datei umbenannt? Bitte cachebust.js anpassen.');
      process.exit(1);
    }
    text = text.split(from).join(to);
  }

  fs.writeFileSync(full, text, 'utf8');
  console.log(`versioniert: ${file}`);
}

replaceIn('index.html', [
  ['href="styles.css"', `href="styles.css?v=${version}"`],
  ['src="app.js"', `src="app.js?v=${version}"`],
]);

// Auch die Verweise innerhalb der Module, sonst bleiben diese im Cache hängen.
replaceIn('app.js', [
  ["from './store.js'", `from './store.js?v=${version}'`],
  ["fetch('./menu-seed.json')", `fetch('./menu-seed.json?v=${version}')`],
]);

replaceIn('store.js', [
  ["from './firebase-config.js'", `from './firebase-config.js?v=${version}'`],
]);

console.log(`\nVersion: ${version}`);
