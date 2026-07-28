'use strict';

/**
 * Datenschicht für den L'Osteria Bestellrechner.
 *
 * Quelle: Smoothr-Plattform (öffentlich lesbare API, keine Anmeldung nötig).
 *   - Venue:    GET /v1/general/venue/{venueId}          -> u.a. articleCategories (Liste von Kategorie-IDs)
 *   - Kategorie: GET /v1/general/articleCategory/{catId}  -> Kategorie inkl. articles[]
 *
 * Dieses Modul läuft in reinem Node (globales fetch ab Node 18) und wird sowohl
 * vom Electron-Hauptprozess als auch vom Snapshot-Skript verwendet.
 */

const API_BASE = 'https://api.smoothr.de';

// Kategorien, die im System existieren, aber nicht auf die Kundenkarte gehören.
const HIDDEN_CATEGORY_NAMES = new Set([
  'unassigned',
  'mehrweg',
  'mehrwegverpackung',
  'pfand',
]);

/** Nimmt aus einem lokalisierten Feld ({de,en,...}) den deutschen bzw. ersten sinnvollen Wert. */
function pickLocalized(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.de === 'string' && value.de.trim()) return value.de;
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return '';
}

/** Wandelt das Preis-Feld (MongoDB Decimal {$numberDecimal:"11.50"} oder Zahl) in eine Zahl. */
function parsePrice(price) {
  if (price == null) return 0;
  if (typeof price === 'number') return price;
  if (typeof price === 'string') return parseFloat(price) || 0;
  if (typeof price === 'object' && price.$numberDecimal != null) {
    return parseFloat(price.$numberDecimal) || 0;
  }
  return 0;
}

/** Holt aus dem assets-Objekt die Bild-URLs (leere Strings werden ignoriert). */
function pickImage(assets) {
  if (!assets || typeof assets !== 'object') return null;
  const clean = (s) => (typeof s === 'string' && s.trim() ? s : null);
  const thumb = clean(assets.thumb);
  const medium = clean(assets.medium);
  const large = clean(assets.large);
  const original = clean(assets.original);
  if (!thumb && !medium && !large && !original) return null;
  return {
    thumb: thumb || medium || large || original,
    medium: medium || large || thumb || original,
    large: large || original || medium || thumb,
  };
}

function normalizeArticle(a) {
  const name = pickLocalized(a.name).trim();
  const price = parsePrice(a.price);
  // groups sind ID-Verweise auf Optionsgruppen (siehe fetchOptionGroups)
  const groupIds = (Array.isArray(a.groups) ? a.groups : []).filter(
    (g) => typeof g === 'string'
  );
  return {
    id: a._id || a.id || name,
    name,
    description: pickLocalized(a.description).trim(),
    price,
    image: pickImage(a.assets),
    kcal: typeof a.kcal === 'number' ? a.kcal : null,
    groupIds,
    // "konfigurierbar" = Artikel mit Optionsgruppen (z. B. Build your own / Halb|Halb).
    configurable: groupIds.length > 0,
  };
}

/** Eine Auswahlmöglichkeit innerhalb einer Optionsgruppe. */
function normalizeOption(o) {
  return {
    id: o._id || o.id,
    name: pickLocalized(o.name).trim(),
    price: parsePrice(o.price),
  };
}

/**
 * Lädt alle Optionsgruppen des Betriebs (Saucen, Käse, Toppings, Hälften,
 * "Zutat weglassen" …) und legt sie als Nachschlagewerk ab. Artikel verweisen
 * über groupIds darauf – so bleibt die Datei kompakt, obwohl sich viele
 * Artikel dieselben Gruppen teilen.
 */
async function fetchOptionGroups(venueId) {
  const raw = await fetchJson(
    `${API_BASE}/v1/general/articleoption/byvenue/${venueId}`
  );
  const list = Array.isArray(raw) ? raw : [];
  const groups = {};

  for (const g of list) {
    if (!g || g.visible === false || g.deletedAt) continue;
    const options = (Array.isArray(g.articles) ? g.articles : [])
      .filter((o) => o && o.isActive !== false && !o.deletedAt)
      .map(normalizeOption)
      .filter((o) => o.name);
    if (options.length === 0) continue;

    const min = Number(g.requiredAmount) || 0;
    const rawLimit = Number(g.limit);
    const multiple = g.hasMultiple === true;
    // limit 0/fehlend bedeutet "unbegrenzt" bei Mehrfachauswahl
    const max = rawLimit > 0 ? rawLimit : multiple ? 999 : 1;

    groups[g._id] = {
      id: g._id,
      name: pickLocalized(g.name).trim(),
      min,
      max,
      multiple,
      options,
    };
  }
  return groups;
}

function isArticleVisible(a) {
  if (!a) return false;
  if (a.isActive === false) return false;
  if (a.deletedAt) return false;
  if (!pickLocalized(a.name).trim()) return false;
  return true;
}

function isCategoryVisible(cat) {
  const name = pickLocalized(cat && cat.name).trim().toLowerCase();
  if (!name) return false;
  if (HIDDEN_CATEGORY_NAMES.has(name)) return false;
  return true;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
  return res.json();
}

/**
 * Lädt die vollständige, normalisierte Speisekarte einer Filiale.
 * @param {string} venueId Smoothr-Venue-ID
 * @returns {Promise<object>} normalisiertes Menü
 */
async function fetchMenu(venueId) {
  const [venue, optionGroups] = await Promise.all([
    fetchJson(`${API_BASE}/v1/general/venue/${venueId}`),
    fetchOptionGroups(venueId).catch((err) => {
      console.error('Optionsgruppen fehlgeschlagen:', err.message);
      return {};
    }),
  ]);

  const categoryIds = (venue.articleCategories || []).filter(
    (x) => typeof x === 'string'
  );

  const rawCategories = await Promise.all(
    categoryIds.map((id) =>
      fetchJson(`${API_BASE}/v1/general/articleCategory/${id}`).catch(
        (err) => {
          console.error(`Kategorie ${id} fehlgeschlagen:`, err.message);
          return null;
        }
      )
    )
  );

  const categories = [];
  for (const cat of rawCategories) {
    if (!cat || !isCategoryVisible(cat)) continue;
    const articles = (cat.articles || [])
      .filter(isArticleVisible)
      .map(normalizeArticle);
    if (articles.length === 0) continue;
    categories.push({
      id: cat._id || cat.id,
      name: pickLocalized(cat.name).trim(),
      articles,
    });
  }

  return {
    venue: {
      id: venue._id || venueId,
      name: pickLocalized(venue.name).trim(),
      street: pickLocalized(venue.street).trim(),
      number: pickLocalized(venue.number).trim(),
      postalCode: pickLocalized(venue.postalCode).trim(),
      city: pickLocalized(venue.city).trim(),
      currencySymbol: venue.currencySymbol || '€',
    },
    fetchedAt: new Date().toISOString(),
    categories,
    optionGroups,
  };
}

module.exports = {
  API_BASE,
  fetchMenu,
  fetchOptionGroups,
  // exportiert für Tests/Wiederverwendung:
  pickLocalized,
  parsePrice,
  pickImage,
  normalizeArticle,
};
