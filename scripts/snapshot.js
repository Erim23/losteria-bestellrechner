'use strict';

/**
 * Lädt die aktuelle Speisekarte der konfigurierten Filiale und speichert sie als
 * renderer/menu-seed.json. Diese Datei dient als Offline-Fallback (Seed) und als
 * Test-Fixture für die Oberfläche.
 *
 * Aufruf:  node scripts/snapshot.js
 */

const fs = require('fs');
const path = require('path');
const { fetchMenu } = require('../src/menu');

// L'Osteria Bonn Portlandweg (53227) – "Rheinwerk"
const VENUE_ID = '67b87e42e1690c89bedf3875';

async function main() {
  console.log('Lade Speisekarte von der Smoothr-API ...');
  const menu = await fetchMenu(VENUE_ID);

  const outPath = path.join(__dirname, '..', 'renderer', 'menu-seed.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // --- Plausibilitätsprüfung -------------------------------------------
  // Die Datenschicht macht bei einem Teilausfall der Schnittstelle bewusst
  // weiter (lieber Speisekarte ohne Extras als gar keine). Für den
  // gespeicherten Stand wäre das fatal: ein einziger Aussetzer würde die
  // Optionen dauerhaft löschen. Deshalb hier lieber abbrechen als
  // Unvollständiges festschreiben.
  const previous = (() => {
    try {
      return JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {
      return null;
    }
  })();

  const zaehle = (m) => ({
    kategorien: (m.categories || []).length,
    artikel: (m.categories || []).reduce((n, c) => n + c.articles.length, 0),
    gruppen: Object.keys(m.optionGroups || {}).length,
  });

  const neu = zaehle(menu);
  const abbruch = [];

  if (neu.kategorien === 0) abbruch.push('keine Kategorien geliefert');
  if (neu.artikel === 0) abbruch.push('keine Artikel geliefert');
  if (neu.gruppen === 0) abbruch.push('keine Optionsgruppen geliefert');

  if (previous) {
    const alt = zaehle(previous);
    const eingebrochen = (a, b, was) => {
      if (a > 0 && b < a * 0.6) {
        abbruch.push(`${was} von ${a} auf ${b} eingebrochen`);
      }
    };
    eingebrochen(alt.artikel, neu.artikel, 'Artikelzahl');
    eingebrochen(alt.gruppen, neu.gruppen, 'Optionsgruppen');
  }

  if (abbruch.length) {
    console.error('\nABBRUCH – Speisekarte wirkt unvollständig:');
    for (const grund of abbruch) console.error('  - ' + grund);
    console.error(
      '\nDer bisherige Stand bleibt unangetastet. Meist ein vorübergehender\n' +
        'Aussetzer der Schnittstelle – einfach später erneut ausführen.'
    );
    process.exit(1);
  }
  // ---------------------------------------------------------------------

  // Nur schreiben, wenn sich inhaltlich etwas geändert hat – sonst würde der
  // Zeitstempel allein täglich einen Commit auslösen.
  const withoutTimestamp = (m) => {
    const copy = Object.assign({}, m);
    delete copy.fetchedAt;
    return JSON.stringify(copy);
  };
  let unchanged = false;
  try {
    const previous = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    unchanged = withoutTimestamp(previous) === withoutTimestamp(menu);
  } catch {
    /* noch keine Datei vorhanden */
  }

  if (!unchanged) {
    fs.writeFileSync(outPath, JSON.stringify(menu, null, 2), 'utf8');
  }

  const totalArticles = menu.categories.reduce(
    (sum, c) => sum + c.articles.length,
    0
  );
  const withImage = menu.categories.reduce(
    (sum, c) => sum + c.articles.filter((a) => a.image).length,
    0
  );

  console.log(`\nFiliale : ${menu.venue.name}`);
  console.log(
    `Adresse : ${menu.venue.street} ${menu.venue.number}, ${menu.venue.postalCode} ${menu.venue.city}`
  );
  const configurable = menu.categories.reduce(
    (sum, c) => sum + c.articles.filter((a) => a.configurable).length,
    0
  );
  const groupCount = Object.keys(menu.optionGroups || {}).length;
  const optionCount = Object.values(menu.optionGroups || {}).reduce(
    (sum, g) => sum + g.options.length,
    0
  );

  console.log(`Kategorien: ${menu.categories.length}`);
  console.log(`Artikel   : ${totalArticles} (davon mit Bild: ${withImage})`);
  console.log(`Konfigurierbar: ${configurable}`);
  console.log(`Optionsgruppen: ${groupCount} mit ${optionCount} Optionen`);
  console.log('\nKategorien:');
  for (const c of menu.categories) {
    console.log(`  - ${c.name}: ${c.articles.length}`);
  }
  console.log(
    unchanged
      ? `\nUnverändert – Datei nicht angefasst: ${outPath}`
      : `\nGespeichert: ${outPath}`
  );
}

main().catch((err) => {
  console.error('FEHLER:', err);
  process.exit(1);
});
