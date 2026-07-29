'use strict';

import * as store from './store.js';

/* ---------------- Hilfen ---------------- */

const EUR = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
});
const fmt = (n) => EUR.format(n || 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const MARK_VALUE = 6; // Wert einer Essensmarke in Euro
const DISCOUNT_RATE = 0.2; // 20 %

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slug(s, i) {
  return 'cat-' + i + '-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Vereinfacht Text für die Suche: Kleinschreibung und deutsche Umlaute
 * aufgelöst, damit "kase" auch "Käse" findet.
 */
function fold(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss');
}

/* ---------------- Zustand ---------------- */

const state = {
  menu: null,
  mode: 'local', // 'team' sobald Firebase läuft
  userName: null,
  items: [], // Positionen: {key, articleId, name, price, options, qty, uid, userName, mine}
  shared: { discountActive: false, marksTotal: 0, marksByUid: {} },
  articleById: new Map(),
  optionGroups: {}, // Nachschlagewerk der Optionsgruppen
  teamConfirmed: false, // true, sobald Firestore erfolgreich geliefert hat
  config: null, // aktuell offener Zusammenstellen-Dialog
};

/* ---------------- Optionsgruppen (Extras, Hälften, Toppings) ---------------- */

/**
 * Die Gruppennamen im Kassensystem sind intern ("Pizza BYO Sauce AG.").
 * Hier werden sie in lesbare Überschriften übersetzt.
 */
function groupDisplayName(raw) {
  const n = String(raw || '').trim();
  if (/weglassen/i.test(n)) {
    // Klammerinhalt behalten, sonst sind bei Halb|Halb beide Gruppen gleich
    const m = /\(([^)]+)\)/.exec(n);
    return m ? `Zutaten weglassen (${m[1].trim()})` : 'Zutaten weglassen';
  }
  if (/halb\s*\|\s*halb\s*1/i.test(n)) return 'Erste Hälfte';
  if (/halb\s*\|\s*halb\s*2/i.test(n)) return 'Zweite Hälfte';
  if (/^topping pizza 1\/2 zweite/i.test(n)) return 'Extra-Toppings zweite Hälfte';
  if (/^topping pizza 1\/2/i.test(n)) return 'Extra-Toppings erste Hälfte';
  if (/möchtest du toppings/i.test(n)) return 'Extra-Toppings';
  if (/^pop up/i.test(n)) return 'Empfehlung';
  return (
    n
      .replace(/^pizza byo\s*/i, '')
      .replace(/\s*\bAG\b\.?\s*$/i, '')
      .replace(/\s*\bnew\b\.?\s*$/i, '')
      .replace(/\.\s*$/, '')
      .trim() || 'Auswahl'
  );
}

/**
 * Hälften-Gruppen von "Pizza Halb | Halb": Ihre Optionen tragen den VOLLEN
 * Pizzapreis. Laut Beschreibung wird die teurere Hälfte berechnet – deshalb
 * dürfen sie nicht addiert werden.
 *
 * Hinweis: Das offizielle Kennzeichen dafür liegt nur hinter der
 * GraphQL-Schnittstelle. Wir erkennen die Gruppen daher am Namen; sollte
 * L'Osteria sie umbenennen, muss das hier nachgezogen werden.
 */
function isHalfGroup(raw) {
  return /halb\s*\|\s*halb\s*\d/i.test(String(raw || ''));
}

/** Inhalt der Klammer, z. B. "… weglassen (Hawaii)." -> "hawaii" */
function parenthetical(raw) {
  const m = /\(([^)]+)\)/.exec(String(raw || ''));
  return m ? m[1].trim().toLowerCase() : null;
}

/** "1/2 Margherita" -> "margherita" */
function halfBaseName(optionName) {
  return String(optionName || '')
    .replace(/^\s*1\/2\s*/i, '')
    .trim()
    .toLowerCase();
}

/**
 * Liefert die anzuzeigenden Gruppen eines Artikels: Pflichtauswahl zuerst.
 * Bei "Halb | Halb" gibt es 45 "Zutat weglassen"-Gruppen – eine pro Pizza.
 * Davon werden nur die eingeblendet, die zu den gewählten Hälften passen.
 */
function groupsForArticle(article, selection) {
  const all = (article.groupIds || [])
    .map((id) => state.optionGroups[id])
    .filter(Boolean)
    .map((g) => ({
      ...g,
      label: groupDisplayName(g.name),
      isHalf: isHalfGroup(g.name),
      required: g.min >= 1,
    }));

  const omitGroups = all.filter((g) => /weglassen/i.test(g.name));
  let visible = all;

  if (omitGroups.length > 1) {
    // Nur die "weglassen"-Gruppen der aktuell gewählten Hälften zeigen
    const chosen = new Set();
    if (selection) {
      for (const g of all) {
        if (!g.isHalf) continue;
        const sel = selection.get(g.id);
        if (!sel) continue;
        for (const oid of sel) {
          const opt = g.options.find((o) => o.id === oid);
          if (opt) chosen.add(halfBaseName(opt.name));
        }
      }
    }
    visible = all.filter((g) => {
      if (!/weglassen/i.test(g.name)) return true;
      const p = parenthetical(g.name);
      return p ? chosen.has(p) : false;
    });
  }

  // Pflichtgruppen nach oben, sonst Reihenfolge beibehalten
  return visible.sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
}

/** Stückpreis: Grundpreis + Extras, Hälften zählen nur mit dem teureren Wert. */
function priceForSelection(article, groups, selection) {
  let extra = 0;
  let halfMax = 0;
  let halfUsed = false;

  for (const g of groups) {
    const sel = selection.get(g.id);
    if (!sel || sel.size === 0) continue;
    for (const oid of sel) {
      const opt = g.options.find((o) => o.id === oid);
      if (!opt) continue;
      if (g.isHalf) {
        halfUsed = true;
        halfMax = Math.max(halfMax, opt.price);
      } else {
        extra += opt.price;
      }
    }
  }
  return round2(article.price + extra + (halfUsed ? halfMax : 0));
}

/** Fehlende Pflichtauswahlen als lesbare Liste. */
function missingRequired(groups, selection) {
  const missing = [];
  for (const g of groups) {
    if (g.min < 1) continue;
    const size = (selection.get(g.id) || new Set()).size;
    if (size < g.min) missing.push(g.label);
  }
  return missing;
}

/** Flache Liste der gewählten Optionen (für Warenkorb und Ablesen). */
function selectedOptions(groups, selection) {
  const out = [];
  for (const g of groups) {
    const sel = selection.get(g.id);
    if (!sel) continue;
    for (const oid of sel) {
      const opt = g.options.find((o) => o.id === oid);
      // half kennzeichnet Hälften: ihr Preis ist kein Zuschlag, sondern
      // der Pizzapreis selbst (nur die teurere Hälfte wird berechnet).
      if (opt)
        out.push({
          id: opt.id,
          name: opt.name,
          price: opt.price,
          half: !!g.isHalf,
        });
    }
  }
  return out;
}

/** Kurze, stabile Kennung einer Zusammenstellung (für die Positions-ID). */
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function variantOf(options) {
  if (!options.length) return '';
  return hashString(
    options
      .map((o) => o.id)
      .sort()
      .join(',')
  );
}

/** Muss vor dem Hinzufügen zwingend zusammengestellt werden? */
function needsConfig(article) {
  if (!article.configurable) return false;
  if (article.price === 0) return true; // z. B. Halb | Halb
  const groups = groupsForArticle(article, null);
  return groups.some((g) => g.required);
}

/** Gibt es überhaupt etwas zum Anpassen? */
function hasOptions(article) {
  return (
    article.configurable && groupsForArticle(article, null).length > 0
  );
}

/** Schaltet auf Einzelbetrieb um, wenn der Team-Warenkorb nicht nutzbar ist. */
function fallbackToLocal(message) {
  store.unsubscribe();
  state.mode = 'local';
  state.items = [];
  state.shared = { discountActive: false, marksTotal: 0, marksByUid: {} };
  // Leiste bleibt sichtbar, aber nur mit dem, was ohne Team Sinn ergibt:
  // die Ableseansicht ist auch beim Alleinbestellen praktisch.
  const bar = document.getElementById('team-bar');
  if (bar) {
    bar.hidden = false;
    document.getElementById('team-round').textContent = 'Einzelbetrieb';
    document.querySelector('.team-me').hidden = true;
    document.querySelector('.team-sep').hidden = true;
    document.getElementById('btn-share').hidden = true;
  }
  const gate = document.getElementById('name-gate');
  if (gate) gate.hidden = true;
  renderCart();
  if (message) showToast(message);
}

/* ---------------- Daten laden ---------------- */

async function loadMenuData() {
  if (window.losteria && typeof window.losteria.loadMenu === 'function') {
    return window.losteria.loadMenu();
  }
  const res = await fetch('./menu-seed.json');
  return { menu: await res.json(), source: 'seed' };
}

async function boot() {
  let result;
  try {
    result = await loadMenuData();
  } catch (err) {
    document.getElementById('menu').innerHTML =
      '<div class="loading">Speisekarte konnte nicht geladen werden.<br>' +
      esc(String(err && err.message ? err.message : err)) +
      '</div>';
    return;
  }

  if (!result || !result.menu) {
    document.getElementById('menu').innerHTML =
      '<div class="loading">Keine Speisekarte verfügbar.' +
      (result && result.error ? '<br>' + esc(result.error) : '') +
      '</div>';
    return;
  }

  state.menu = result.menu;
  state.optionGroups = state.menu.optionGroups || {};
  for (const cat of state.menu.categories) {
    for (const a of cat.articles) state.articleById.set(a.id, a);
  }

  renderHeader(result);
  renderNav();
  renderMenu();
  bindEvents();

  // Team-Betrieb versuchen; scheitert er, läuft alles lokal weiter.
  state.userName = store.getStoredName();
  try {
    await store.initTeam();
    state.mode = 'team';
    setupTeamBar();
    store.subscribe({
      onShared: (shared) => {
        state.shared = shared;
        renderBreakdown();
        if (!document.getElementById('detail-modal').hidden) renderDetail();
      },
      onItems: (items) => {
        state.teamConfirmed = true;
        state.items = items;
        renderCart();
        if (!document.getElementById('detail-modal').hidden) renderDetail();
        if (!document.getElementById('readout-modal').hidden) renderReadout();
      },
      onError: (err) => {
        console.error('Firestore-Fehler:', err);
        // Kam noch nie etwas an, ist der Team-Betrieb nicht nutzbar
        // (z. B. Zugriffsregeln noch nicht veröffentlicht) – dann sauber
        // in den Einzelbetrieb zurückfallen, statt halb kaputt dastehen.
        if (!state.teamConfirmed) {
          fallbackToLocal(
            err && err.code === 'permission-denied'
              ? 'Gemeinsamer Warenkorb noch nicht freigeschaltet – läuft im Einzelbetrieb.'
              : 'Kein Zugriff auf den gemeinsamen Warenkorb – läuft im Einzelbetrieb.'
          );
        } else {
          showToast('Verbindung zum gemeinsamen Warenkorb gestört');
        }
      },
    });
    if (!state.userName) openNameGate();
  } catch (err) {
    console.warn('Team-Betrieb nicht verfügbar, Einzelbetrieb:', err);
    state.mode = 'local';
    renderCart();
  }

  renderCart();
}

/* ---------------- Kopfzeile & Team-Leiste ---------------- */

function renderHeader(result) {
  const v = state.menu.venue || {};
  document.getElementById('venue-name').textContent = v.name || "L'Osteria";
  const addr = [
    [v.street, v.number].filter(Boolean).join(' '),
    [v.postalCode, v.city].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
  document.getElementById('venue-addr').textContent = addr;

  // Im Normalbetrieb keine Anzeige: die Speisekarte wird täglich automatisch
  // aktualisiert. Nur wenn das erkennbar länger nicht passiert ist, wird
  // dezent gewarnt – sonst würden veraltete Preise unbemerkt bleiben.
  const badge = document.getElementById('data-source');
  badge.hidden = true;

  const fetchedAt = state.menu.fetchedAt ? new Date(state.menu.fetchedAt) : null;
  if (fetchedAt && !isNaN(fetchedAt)) {
    const days = (Date.now() - fetchedAt.getTime()) / 86400000;
    if (days > 7) {
      badge.hidden = false;
      badge.className = 'source-badge offline';
      badge.textContent =
        'Speisekarte vom ' + fetchedAt.toLocaleDateString('de-DE');
      badge.title = 'Die automatische Aktualisierung lief länger nicht.';
    }
  }
}

function setupTeamBar() {
  const bar = document.getElementById('team-bar');
  bar.hidden = false;
  const id = store.team.roundId || '';
  const m = /^tag-(\d{4})-(\d{2})-(\d{2})$/.exec(id);
  document.getElementById('team-round').textContent = m
    ? `Bestellrunde ${m[3]}.${m[2]}.${m[1]}`
    : `Bestellrunde ${id}`;
  updateNameLabel();
}

function updateNameLabel() {
  const el = document.getElementById('team-name');
  if (el) el.textContent = state.userName || '—';
}

/* ---------------- Namensabfrage ---------------- */

function openNameGate() {
  const gate = document.getElementById('name-gate');
  const input = document.getElementById('name-input');
  document.getElementById('name-error').hidden = true;
  input.value = state.userName || '';
  gate.hidden = false;
  setTimeout(() => input.focus(), 50);
}

async function saveName() {
  const input = document.getElementById('name-input');
  const name = input.value.trim();
  if (!name) {
    document.getElementById('name-error').hidden = false;
    return;
  }
  const previous = state.userName;
  state.userName = name;
  store.setStoredName(name);
  updateNameLabel();
  document.getElementById('name-gate').hidden = true;

  // Name an bereits eingetragenen eigenen Positionen mitziehen
  if (state.mode === 'team' && previous && previous !== name) {
    try {
      await store.renameMyItems(state.items, name);
    } catch (err) {
      console.error('Umbenennen fehlgeschlagen:', err);
    }
  }
  renderCart();
}

/* ---------------- Navigation ---------------- */

function renderNav() {
  const nav = document.getElementById('cat-nav');
  nav.innerHTML = '';
  state.menu.categories.forEach((cat, i) => {
    const chip = document.createElement('button');
    chip.className = 'cat-chip' + (i === 0 ? ' active' : '');
    chip.textContent = cat.name;
    chip.dataset.target = slug(cat.name, i);
    chip.addEventListener('click', () => {
      const el = document.getElementById(chip.dataset.target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.appendChild(chip);
  });
}

/* ---------------- Speisekarte ---------------- */

function placeholderImg(name) {
  const ph = document.createElement('div');
  ph.className = 'dish-img placeholder';
  ph.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return ph;
}

function dishCard(article, categoryName) {
  const card = document.createElement('div');
  card.className = 'dish';
  // Durchsuchbarer Text: Name, Beschreibung und Kategorie
  card.dataset.q = fold(
    article.name + ' ' + (article.description || '') + ' ' + (categoryName || '')
  );

  const imgUrl = article.image && article.image.medium;
  if (imgUrl) {
    const img = document.createElement('img');
    img.className = 'dish-img';
    img.loading = 'lazy';
    img.src = imgUrl;
    img.alt = article.name;
    img.addEventListener('error', () => {
      img.replaceWith(placeholderImg(article.name));
    });
    card.appendChild(img);
  } else {
    card.appendChild(placeholderImg(article.name));
  }

  const mustConfig = needsConfig(article);
  const canConfig = hasOptions(article);

  const body = document.createElement('div');
  body.className = 'dish-body';
  body.innerHTML =
    '<div class="dish-name">' +
    esc(article.name) +
    '</div>' +
    '<div class="dish-desc">' +
    esc(article.description) +
    '</div>' +
    '<div class="dish-foot">' +
    '<span class="dish-price">' +
    (mustConfig && article.price === 0 ? 'nach Auswahl' : fmt(article.price)) +
    '</span>' +
    '</div>';

  const foot = body.querySelector('.dish-foot');

  // Optionale Extras: kleiner Zusatzknopf, damit ein Klick auf + schnell bleibt
  if (canConfig && !mustConfig) {
    const extrasBtn = document.createElement('button');
    extrasBtn.className = 'extras-btn';
    extrasBtn.textContent = 'Extras';
    extrasBtn.title = 'Zutaten und Extras wählen';
    extrasBtn.addEventListener('click', () => openConfig(article));
    foot.appendChild(extrasBtn);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = mustConfig ? '›' : '+';
  addBtn.title = mustConfig ? 'Zusammenstellen' : 'In den Warenkorb';
  addBtn.addEventListener('click', () => {
    if (mustConfig) openConfig(article);
    else addToCart(article);
  });
  foot.appendChild(addBtn);

  card.appendChild(body);
  return card;
}

/* ---------------- Zusammenstellen-Dialog ---------------- */

function openConfig(article) {
  if (state.mode === 'team' && !state.userName) {
    openNameGate();
    return;
  }
  state.config = { article, selection: new Map() };
  document.getElementById('config-title').textContent = article.name;
  const desc = document.getElementById('config-desc');
  desc.textContent = article.description || '';
  desc.hidden = !article.description;
  document.getElementById('config-modal').hidden = false;
  renderConfig();
}

function closeConfig() {
  document.getElementById('config-modal').hidden = true;
  state.config = null;
}

function renderConfig() {
  if (!state.config) return;
  const { article, selection } = state.config;
  const groups = groupsForArticle(article, selection);
  state.config.groups = groups;

  const body = document.getElementById('config-body');
  let html = '';

  for (const g of groups) {
    const sel = selection.get(g.id) || new Set();
    const single = g.max === 1 && !g.multiple;
    let hint;
    if (g.required && single) hint = 'genau eine Auswahl';
    else if (g.required) hint = `mindestens ${g.min}`;
    else if (single) hint = 'höchstens eine';
    else if (g.max < 999) hint = `bis zu ${g.max}`;
    else hint = 'beliebig viele';

    // Lange, freiwillige Listen eingeklappt, damit der Dialog handlich bleibt
    const collapse = !g.required && g.options.length > 10 && sel.size === 0;

    html +=
      '<section class="opt-group' +
      (collapse ? ' collapsed' : '') +
      '" data-group="' +
      esc(g.id) +
      '">' +
      '<button class="opt-head" data-toggle="' +
      esc(g.id) +
      '">' +
      '<span class="opt-title">' +
      esc(g.label) +
      (g.required ? ' <span class="req">Pflicht</span>' : '') +
      '</span>' +
      '<span class="opt-hint">' +
      hint +
      (sel.size ? ' · ' + sel.size + ' gewählt' : '') +
      (collapse ? ' ▾' : '') +
      '</span>' +
      '</button>' +
      '<div class="opt-list">';

    for (const o of g.options) {
      const on = sel.has(o.id);
      html +=
        '<label class="opt' +
        (on ? ' on' : '') +
        '">' +
        '<input type="' +
        (single ? 'radio' : 'checkbox') +
        '" name="g-' +
        esc(g.id) +
        '" data-group="' +
        esc(g.id) +
        '" data-option="' +
        esc(o.id) +
        '"' +
        (on ? ' checked' : '') +
        '>' +
        '<span class="opt-name">' +
        esc(o.name) +
        '</span>' +
        (o.price > 0
          ? '<span class="opt-price">' +
            (g.isHalf ? '' : '+ ') +
            fmt(o.price) +
            '</span>'
          : '') +
        '</label>';
    }
    html += '</div></section>';
  }

  body.innerHTML = html;

  body.querySelectorAll('input[data-option]').forEach((input) => {
    input.addEventListener('change', () =>
      toggleOption(input.dataset.group, input.dataset.option)
    );
  });
  body.querySelectorAll('.opt-head').forEach((head) => {
    head.addEventListener('click', () => {
      head.parentElement.classList.toggle('collapsed');
    });
  });

  updateConfigFoot();
}

function toggleOption(groupId, optionId) {
  const { selection, groups } = state.config;
  const g = groups.find((x) => x.id === groupId);
  if (!g) return;

  let sel = selection.get(groupId);
  if (!sel) {
    sel = new Set();
    selection.set(groupId, sel);
  }

  const single = g.max === 1 && !g.multiple;
  if (single) {
    // Einzelauswahl: vorherige ersetzen (nochmal klicken hebt sie auf)
    if (sel.has(optionId)) sel.clear();
    else {
      sel.clear();
      sel.add(optionId);
    }
  } else if (sel.has(optionId)) {
    sel.delete(optionId);
  } else if (sel.size >= g.max) {
    showToast(`Höchstens ${g.max} bei "${g.label}"`);
  } else {
    sel.add(optionId);
  }

  // Neu zeichnen, weil sich bei Hälften die Zusatzgruppen ändern können
  renderConfig();
}

function updateConfigFoot() {
  const { article, selection, groups } = state.config;
  const price = priceForSelection(article, groups, selection);
  const missing = missingRequired(groups, selection);

  document.getElementById('config-price').textContent = fmt(price);
  const hint = document.getElementById('config-hint');
  const addBtn = document.getElementById('config-add');

  if (missing.length) {
    hint.textContent = 'Bitte noch wählen: ' + missing.join(', ');
    hint.hidden = false;
    addBtn.disabled = true;
  } else {
    hint.hidden = true;
    addBtn.disabled = false;
  }
}

async function confirmConfig() {
  if (!state.config) return;
  const { article, selection, groups } = state.config;
  if (missingRequired(groups, selection).length) return;

  const options = selectedOptions(groups, selection);
  const unitPrice = priceForSelection(article, groups, selection);
  closeConfig();
  await addToCart(article, {
    options,
    unitPrice,
    variant: variantOf(options),
  });
}

function renderMenu() {
  const menu = document.getElementById('menu');
  menu.innerHTML = '';
  state.menu.categories.forEach((cat, i) => {
    const section = document.createElement('section');
    section.className = 'menu-section';
    section.id = slug(cat.name, i);

    const title = document.createElement('h2');
    title.className = 'section-title';
    title.textContent = cat.name;
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'card-grid';
    cat.articles.forEach((a) => grid.appendChild(dishCard(a, cat.name)));
    section.appendChild(grid);
    menu.appendChild(section);
  });

  // Hinweis, wenn die Suche nichts findet
  const empty = document.createElement('div');
  empty.id = 'search-empty';
  empty.className = 'search-empty';
  empty.hidden = true;
  menu.appendChild(empty);

  setupScrollSpy();
}

/* ---------------- Suche ---------------- */

/**
 * Filtert die Speisekarte. Alle eingegebenen Wörter müssen vorkommen,
 * Reihenfolge egal ("pizza salami" findet die Salami-Pizza).
 */
function runSearch(rawTerm) {
  const term = fold(rawTerm).trim();
  const words = term ? term.split(/\s+/) : [];
  const active = words.length > 0;

  document.body.classList.toggle('searching', active);
  document.getElementById('search-clear').hidden = !active;

  let hits = 0;
  for (const card of document.querySelectorAll('.dish')) {
    const hay = card.dataset.q || '';
    const match = !active || words.every((w) => hay.includes(w));
    card.hidden = !match;
    if (match) hits++;
  }

  // Kategorien ohne Treffer ausblenden
  for (const section of document.querySelectorAll('.menu-section')) {
    const visible = section.querySelector('.dish:not([hidden])');
    section.hidden = active && !visible;
  }

  const countEl = document.getElementById('search-count');
  countEl.hidden = !active;
  countEl.textContent = hits === 1 ? '1 Treffer' : hits + ' Treffer';

  const emptyEl = document.getElementById('search-empty');
  if (emptyEl) {
    emptyEl.hidden = !(active && hits === 0);
    emptyEl.textContent = 'Kein Gericht gefunden für „' + rawTerm.trim() + '".';
  }

  if (active) document.getElementById('menu').scrollTop = 0;
}

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  runSearch('');
  input.focus();
}

function setupScrollSpy() {
  const menu = document.getElementById('menu');
  const chips = Array.from(document.querySelectorAll('.cat-chip'));
  const sections = Array.from(document.querySelectorAll('.menu-section'));
  if (!sections.length) return;

  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          chips.forEach((c) =>
            c.classList.toggle('active', c.dataset.target === entry.target.id)
          );
        }
      });
    },
    { root: menu, rootMargin: '0px 0px -75% 0px', threshold: 0 }
  );
  sections.forEach((s) => obs.observe(s));
}

/* ---------------- Warenkorb ---------------- */

async function addToCart(article, config) {
  if (state.mode === 'team' && !state.userName) {
    openNameGate();
    return;
  }
  const options = (config && config.options) || [];
  const unitPrice =
    config && typeof config.unitPrice === 'number'
      ? config.unitPrice
      : article.price;
  const variant = (config && config.variant) || '';

  if (state.mode === 'team') {
    try {
      await store.addItem(article, state.userName, {
        options,
        unitPrice,
        variant,
      });
      showToast(article.name + ' hinzugefügt');
    } catch (err) {
      console.error(err);
      showToast('Konnte nicht hinzugefügt werden');
    }
    return;
  }
  // Einzelbetrieb
  const key = 'local__' + article.id + (variant ? '__' + variant : '');
  const found = state.items.find((i) => i.key === key);
  if (found) found.qty += 1;
  else
    state.items.push({
      key,
      articleId: article.id,
      name: article.name,
      price: unitPrice,
      basePrice: article.price,
      options,
      image: article.image ? article.image.thumb : null,
      qty: 1,
      uid: 'local',
      userName: state.userName || 'Ich',
      mine: true,
    });
  showToast(article.name + ' hinzugefügt');
  renderCart();
}

async function changeQty(entry, delta) {
  const next = entry.qty + delta;
  if (state.mode === 'team') {
    try {
      await store.setQtyByKey(entry.key, next);
    } catch (err) {
      console.error(err);
      showToast('Änderung nicht möglich');
    }
    return;
  }
  entry.qty = next;
  if (entry.qty <= 0) state.items = state.items.filter((i) => i !== entry);
  renderCart();
}

/** Gewählte Extras als kurze Zeile, z. B. "Tomatensauce · Edamer · + Salami". */
function optionsSummary(options) {
  if (!options || !options.length) return '';
  return options
    .map((o) => (o.price > 0 && !o.half ? '+ ' + o.name : o.name))
    .join(' · ');
}

async function clearMine() {
  if (state.mode === 'team') {
    try {
      await store.clearMine(state.items);
    } catch (err) {
      console.error(err);
      showToast('Leeren nicht möglich');
    }
    return;
  }
  state.items = [];
  renderCart();
}

function cartRow(entry) {
  const row = document.createElement('div');
  row.className = 'cart-row' + (entry.mine ? '' : ' foreign');

  row.innerHTML =
    (entry.image
      ? '<img class="cart-thumb" src="' + esc(entry.image) + '" alt="">'
      : '<div class="cart-thumb"></div>') +
    '<div class="cart-info">' +
    '<div class="cart-name">' +
    esc(entry.name) +
    '</div>' +
    (entry.options && entry.options.length
      ? '<div class="cart-options">' +
        esc(optionsSummary(entry.options)) +
        '</div>'
      : '') +
    '<div class="cart-unit">' +
    fmt(entry.price) +
    ' / Stück' +
    (state.mode === 'team' && !entry.mine
      ? ' · <span class="cart-owner">' + esc(entry.userName) + '</span>'
      : '') +
    '</div>' +
    '</div>' +
    '<div class="cart-right">' +
    '<div class="cart-line">' +
    fmt(round2(entry.price * entry.qty)) +
    '</div>' +
    (entry.mine
      ? '<div class="qty">' +
        '<button data-act="minus">−</button>' +
        '<span>' +
        entry.qty +
        '</span>' +
        '<button data-act="plus">+</button>' +
        '</div>'
      : '<div class="qty-static">×' +
        entry.qty +
        '<button class="remove-foreign" title="Position entfernen" ' +
        'aria-label="Position entfernen">✕</button></div>') +
    '</div>';

  if (entry.mine) {
    row
      .querySelector('[data-act="minus"]')
      .addEventListener('click', () => changeQty(entry, -1));
    row
      .querySelector('[data-act="plus"]')
      .addEventListener('click', () => changeQty(entry, +1));
  } else {
    const rm = row.querySelector('.remove-foreign');
    if (rm) rm.addEventListener('click', () => removeForeign(entry));
  }
  return row;
}

/** Entfernt eine fremde Position (Aufräumen für die ganze Runde). */
async function removeForeign(entry) {
  try {
    await store.deleteItemByKey(entry.key);
    showToast(entry.name + ' entfernt (' + entry.userName + ')');
  } catch (err) {
    console.error(err);
    showToast('Entfernen nicht möglich');
  }
}

function renderCart() {
  const wrap = document.getElementById('cart-items');
  const empty = document.getElementById('cart-empty');
  const clearBtn = document.getElementById('cart-clear');
  wrap.innerHTML = '';

  const hasItems = state.items.length > 0;
  empty.hidden = hasItems;
  clearBtn.hidden = !state.items.some((i) => i.mine);
  document.getElementById('btn-detail').hidden = !hasItems;

  const persons = personsFromItems(state.items);

  if (state.mode === 'team' && persons.length > 1) {
    // Nach Person gruppieren, eigene Auswahl zuerst
    persons.sort((a, b) => {
      const am = a.uid === store.team.uid ? 0 : 1;
      const bm = b.uid === store.team.uid ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name, 'de');
    });
    for (const p of persons) {
      const head = document.createElement('div');
      head.className = 'person-head';
      head.innerHTML =
        '<span>' +
        esc(p.name) +
        (p.uid === store.team.uid ? ' <span class="you">(du)</span>' : '') +
        '</span><span>' +
        fmt(round2(p.subtotal)) +
        '</span>';
      wrap.appendChild(head);
      for (const e of p.items) wrap.appendChild(cartRow(e));
    }
  } else {
    for (const e of state.items) wrap.appendChild(cartRow(e));
  }

  renderBreakdown();
  updateCartBar();
}

/** Aktualisiert die Warenkorb-Leiste des Handy-Layouts. */
function updateCartBar() {
  let count = 0;
  let sum = 0;
  for (const e of state.items) {
    count += e.qty;
    sum += e.price * e.qty;
  }
  const countEl = document.getElementById('cart-bar-count');
  const totalEl = document.getElementById('cart-bar-total');
  if (countEl) {
    countEl.textContent = count === 1 ? '1 Artikel' : count + ' Artikel';
  }
  if (totalEl) totalEl.textContent = fmt(round2(sum));
  if (count === 0) closeCartSheet();
}

function openCartSheet() {
  document.body.classList.add('cart-open');
}

function closeCartSheet() {
  document.body.classList.remove('cart-open');
}

/* ---------------- Personen & Essensmarken ---------------- */

function personsFromItems(items) {
  const map = new Map();
  for (const e of items) {
    let p = map.get(e.uid);
    if (!p) {
      p = { uid: e.uid, name: e.userName || 'Ohne Namen', subtotal: 0, items: [] };
      map.set(e.uid, p);
    }
    p.subtotal += e.price * e.qty;
    p.items.push(e);
  }
  const list = Array.from(map.values());
  list.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return list;
}

/**
 * Verteilt die Essensmarken: jede Person bekommt erst mal eine, der Rest
 * bleibt als "noch zu verteilen" übrig. Ausdrücklich zugewiesene Marken
 * (z. B. wer zwei mitgebracht hat) haben Vorrang.
 */
function distributeMarks(persons, marksTotal, overrides) {
  const perPerson = new Map();
  let assigned = 0;

  for (const p of persons) {
    const v = overrides ? overrides[p.uid] : undefined;
    if (typeof v === 'number' && isFinite(v)) {
      const n = Math.max(0, Math.floor(v));
      perPerson.set(p.uid, n);
      assigned += n;
    }
  }

  let pool = Math.max(0, marksTotal - assigned);
  for (const p of persons) {
    if (perPerson.has(p.uid)) continue;
    if (pool > 0) {
      perPerson.set(p.uid, 1);
      pool -= 1;
    } else {
      perPerson.set(p.uid, 0);
    }
  }
  return { perPerson, pool };
}

/* ---------------- Rechner (Gesamt) ---------------- */

function computeTotals() {
  let subtotal = 0;
  for (const e of state.items) subtotal += e.price * e.qty;
  subtotal = round2(subtotal);

  const discount = state.shared.discountActive
    ? round2(subtotal * DISCOUNT_RATE)
    : 0;
  const afterDiscount = round2(subtotal - discount);

  const marks = Math.max(0, Math.floor(state.shared.marksTotal) || 0);
  const marksValue = marks * MARK_VALUE;
  const appliedMarks = round2(Math.min(marksValue, afterDiscount));
  const wasted = round2(Math.max(0, marksValue - afterDiscount));
  const remaining = round2(Math.max(0, afterDiscount - marksValue));
  const maxMarks =
    afterDiscount > 0 ? Math.floor(afterDiscount / MARK_VALUE + 1e-9) : 0;

  return {
    subtotal,
    discount,
    afterDiscount,
    marks,
    marksValue,
    appliedMarks,
    wasted,
    remaining,
    maxMarks,
  };
}

function renderBreakdown() {
  const t = computeTotals();
  const el = document.getElementById('breakdown');
  let html = '';

  html +=
    '<div class="bd-row sub"><span>Zwischensumme</span><span>' +
    fmt(t.subtotal) +
    '</span></div>';

  if (state.shared.discountActive) {
    html +=
      '<div class="bd-row discount"><span>Rabatt (20 %)</span><span>− ' +
      fmt(t.discount) +
      '</span></div>';
    html +=
      '<div class="bd-row"><span>Summe nach Rabatt</span><span>' +
      fmt(t.afterDiscount) +
      '</span></div>';
  }

  if (t.marks > 0) {
    html +=
      '<div class="bd-row marks-row"><span>' +
      t.marks +
      ' Essensmarke' +
      (t.marks === 1 ? '' : 'n') +
      ' × 6,00 €</span><span>− ' +
      fmt(t.appliedMarks) +
      '</span></div>';
  }

  if (t.wasted > 0) {
    html +=
      '<div class="bd-hint">Essensmarken werden ohne Wechselgeld verrechnet: ' +
      '<b>' +
      fmt(t.wasted) +
      ' verfallen</b>. Sinnvoll sind höchstens <b>' +
      t.maxMarks +
      '</b> Marken.</div>';
  }

  html +=
    '<div class="bd-total"><span class="label">Restbetrag zu zahlen</span>' +
    '<span class="value">' +
    fmt(t.remaining) +
    '</span></div>';

  const saved = round2(t.discount + t.appliedMarks);
  if (saved > 0) {
    html += '<div class="bd-saved">nicht bar zu zahlen: ' + fmt(saved) + '</div>';
  }

  el.innerHTML = html;

  const input = document.getElementById('marks-input');
  if (input && String(t.marks) !== input.value) input.value = t.marks;

  const btn = document.getElementById('discount-toggle');
  btn.setAttribute('aria-pressed', String(state.shared.discountActive));
  btn.querySelector('.discount-label').textContent = state.shared.discountActive
    ? '20 % Rabatt aktiv'
    : '20 % Rabatt aktivieren';
}

/* ---------------- Erweiterte Ansicht: wer zahlt was ---------------- */

function renderDetail() {
  const body = document.getElementById('detail-body');
  const persons = personsFromItems(state.items);
  const t = computeTotals();
  const { perPerson, pool } = distributeMarks(
    persons,
    state.shared.marksTotal,
    state.shared.marksByUid
  );

  if (persons.length === 0) {
    body.innerHTML = '<p class="dialog-text">Der Warenkorb ist leer.</p>';
    return;
  }

  let html =
    '<div class="detail-summary">' +
    '<div><span>Bestellung gesamt</span><b>' +
    fmt(t.subtotal) +
    '</b></div>' +
    (state.shared.discountActive
      ? '<div><span>nach 20 % Rabatt</span><b>' + fmt(t.afterDiscount) + '</b></div>'
      : '') +
    '<div><span>Essensmarken insgesamt</span><b>' +
    t.marks +
    '</b></div>' +
    '<div><span>noch zu verteilen</span><b>' +
    pool +
    '</b></div>' +
    '</div>';

  // Nicht zugeordnete Marken würden die Summen unten kleiner erscheinen
  // lassen als in der Gesamtansicht – das muss man sehen können.
  if (pool > 0) {
    html +=
      '<div class="bd-hint pool-hint">' +
      '<b>' +
      pool +
      ' Marke' +
      (pool === 1 ? '' : 'n') +
      ' noch niemandem zugeordnet.</b> Die Beträge unten berücksichtigen nur ' +
      'zugeordnete Marken. Ordne sie mit + der richtigen Person zu' +
      '<button id="btn-distribute" class="ghost-btn">Rest gleichmäßig verteilen</button>' +
      '</div>';
  }

  html += '<div class="person-list">';
  for (const p of persons) {
    const share = state.shared.discountActive
      ? round2(p.subtotal * (1 - DISCOUNT_RATE))
      : round2(p.subtotal);
    const marks = perPerson.get(p.uid) || 0;
    const marksValue = marks * MARK_VALUE;
    const cash = round2(Math.max(0, share - marksValue));
    const wasted = round2(Math.max(0, marksValue - share));

    html +=
      '<div class="person-card">' +
      '<div class="person-card-head">' +
      '<b>' +
      esc(p.name) +
      (p.uid === store.team.uid ? ' <span class="you">(du)</span>' : '') +
      '</b>' +
      '<span class="muted">' +
      p.items.reduce((s, i) => s + i.qty, 0) +
      ' Artikel</span>' +
      '</div>' +
      '<div class="person-lines">' +
      p.items
        .map(
          (i) =>
            '<div class="person-line"><span>' +
            i.qty +
            '× ' +
            esc(i.name) +
            (i.options && i.options.length
              ? '<span class="person-line-opts"> (' +
                esc(optionsSummary(i.options)) +
                ')</span>'
              : '') +
            '</span><span>' +
            fmt(round2(i.price * i.qty)) +
            '</span></div>'
        )
        .join('') +
      '</div>' +
      '<div class="person-calc">' +
      '<div class="bd-row sub"><span>Anteil' +
      (state.shared.discountActive ? ' (nach Rabatt)' : '') +
      '</span><span>' +
      fmt(share) +
      '</span></div>' +
      '<div class="bd-row marks-row person-marks">' +
      '<span>Essensmarken</span>' +
      '<span class="marks-ctl">' +
      '<button class="step-btn small" data-uid="' +
      esc(p.uid) +
      '" data-delta="-1" aria-label="weniger">−</button>' +
      '<b>' +
      marks +
      '</b>' +
      '<button class="step-btn small" data-uid="' +
      esc(p.uid) +
      '" data-delta="1" aria-label="mehr">+</button>' +
      '</span>' +
      '</div>' +
      (wasted > 0
        ? '<div class="bd-hint">' +
          fmt(wasted) +
          ' verfallen (Marke ist mehr wert als der Anteil).</div>'
        : '') +
      '<div class="bd-total"><span class="label">zahlt bar</span><span class="value small">' +
      fmt(cash) +
      '</span></div>' +
      '</div>' +
      '</div>';
  }
  html += '</div>';

  body.innerHTML = html;

  body.querySelectorAll('.marks-ctl .step-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      changePersonMarks(btn.dataset.uid, Number(btn.dataset.delta))
    );
  });

  const distBtn = document.getElementById('btn-distribute');
  if (distBtn) distBtn.addEventListener('click', distributeRest);
}

/** Verteilt die noch nicht zugeordneten Marken der Reihe nach auf alle. */
async function distributeRest() {
  const persons = personsFromItems(state.items);
  const { perPerson, pool } = distributeMarks(
    persons,
    state.shared.marksTotal,
    state.shared.marksByUid
  );
  if (pool <= 0 || persons.length === 0) return;

  const overrides = {};
  for (const p of persons) overrides[p.uid] = perPerson.get(p.uid) || 0;
  let left = pool;
  let i = 0;
  while (left > 0) {
    const p = persons[i % persons.length];
    overrides[p.uid] += 1;
    left -= 1;
    i += 1;
  }
  await updateShared({ marksByUid: overrides });
}

/**
 * Ändert die Marken einer Person. Ist nichts mehr zu verteilen, wächst die
 * Gesamtzahl – der Fall "hat zwei Marken mitgebracht".
 */
async function changePersonMarks(uid, delta) {
  const persons = personsFromItems(state.items);
  const { perPerson, pool } = distributeMarks(
    persons,
    state.shared.marksTotal,
    state.shared.marksByUid
  );
  const current = perPerson.get(uid) || 0;
  const next = Math.max(0, current + delta);
  if (next === current) return;

  const overrides = Object.assign({}, state.shared.marksByUid);
  overrides[uid] = next;

  let total = Math.max(0, Math.floor(state.shared.marksTotal) || 0);
  if (delta > 0 && pool <= 0) total += 1; // zusätzliche Marke mitgebracht
  if (delta < 0) total = Math.max(total, 0);

  await updateShared({ marksTotal: total, marksByUid: overrides });
}

/* ---------------- Ableseansicht für den Anruf ---------------- */

function renderReadout() {
  const body = document.getElementById('readout-body');
  const t = computeTotals();

  // Gleiche Artikel zusammenfassen – aber nur bei gleicher Zusammenstellung,
  // sonst würde eine Pizza mit Extras mit einer ohne verschmolzen.
  const agg = new Map();
  for (const e of state.items) {
    const optKey = (e.options || [])
      .map((o) => o.id || o.name)
      .sort()
      .join(',');
    const key = e.articleId + '|' + optKey;
    const cur = agg.get(key);
    if (cur) cur.qty += e.qty;
    else
      agg.set(key, {
        name: e.name,
        price: e.price,
        qty: e.qty,
        options: e.options || [],
      });
  }
  const lines = Array.from(agg.values()).sort((a, b) =>
    a.name.localeCompare(b.name, 'de')
  );

  if (lines.length === 0) {
    body.innerHTML = '<p class="dialog-text">Der Warenkorb ist leer.</p>';
    return;
  }

  let html = '<ol class="readout-list">';
  for (const l of lines) {
    html +=
      '<li><span class="ro-qty">' +
      l.qty +
      '×</span><span class="ro-name">' +
      esc(l.name) +
      (l.options && l.options.length
        ? '<span class="ro-opts">' + esc(optionsSummary(l.options)) + '</span>'
        : '') +
      '</span><span class="ro-sum">' +
      fmt(round2(l.price * l.qty)) +
      '</span></li>';
  }
  html += '</ol>';

  html +=
    '<div class="readout-total">' +
    '<div class="bd-row"><span>Zwischensumme</span><span>' +
    fmt(t.subtotal) +
    '</span></div>' +
    (state.shared.discountActive
      ? '<div class="bd-row discount"><span>Rabatt (20 %)</span><span>− ' +
        fmt(t.discount) +
        '</span></div>'
      : '') +
    (t.marks > 0
      ? '<div class="bd-row marks-row"><span>' +
        t.marks +
        ' Essensmarken</span><span>− ' +
        fmt(t.appliedMarks) +
        '</span></div>'
      : '') +
    '<div class="bd-total"><span class="label">bar zu zahlen</span><span class="value">' +
    fmt(t.remaining) +
    '</span></div>' +
    '</div>';

  body.innerHTML = html;
}

/* ---------------- Gemeinsame Einstellungen ändern ---------------- */

async function updateShared(patch) {
  if (state.mode === 'team') {
    try {
      await store.setShared(patch);
      return;
    } catch (err) {
      console.error(err);
      showToast('Änderung nicht möglich');
      return;
    }
  }
  Object.assign(state.shared, patch);
  renderBreakdown();
  if (!document.getElementById('detail-modal').hidden) renderDetail();
}

/* ---------------- Ereignisse ---------------- */

function bindEvents() {
  // Rabatt
  document.getElementById('discount-toggle').addEventListener('click', () => {
    updateShared({ discountActive: !state.shared.discountActive });
  });

  // Essensmarken (gesamt)
  const setMarks = (n) =>
    updateShared({ marksTotal: Math.max(0, Math.floor(n) || 0) });
  document
    .getElementById('marks-minus')
    .addEventListener('click', () => setMarks(state.shared.marksTotal - 1));
  document
    .getElementById('marks-plus')
    .addEventListener('click', () => setMarks(state.shared.marksTotal + 1));
  document
    .getElementById('marks-input')
    .addEventListener('change', (e) => setMarks(e.target.value));
  document
    .getElementById('marks-max')
    .addEventListener('click', () => setMarks(computeTotals().maxMarks));

  document.getElementById('cart-clear').addEventListener('click', clearMine);

  // Handy-Layout
  document.getElementById('cart-bar').addEventListener('click', openCartSheet);
  document.getElementById('cart-close').addEventListener('click', closeCartSheet);
  document
    .getElementById('sheet-backdrop')
    .addEventListener('click', closeCartSheet);

  // Name
  document.getElementById('name-save').addEventListener('click', saveName);
  document.getElementById('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName();
  });
  document.getElementById('name-change').addEventListener('click', openNameGate);

  // Erweiterte Ansicht
  document.getElementById('btn-detail').addEventListener('click', () => {
    renderDetail();
    document.getElementById('detail-modal').hidden = false;
  });
  document.getElementById('detail-close').addEventListener('click', () => {
    document.getElementById('detail-modal').hidden = true;
  });

  // Ableseansicht
  document.getElementById('btn-readout').addEventListener('click', () => {
    renderReadout();
    document.getElementById('readout-modal').hidden = false;
  });
  document.getElementById('readout-close').addEventListener('click', () => {
    document.getElementById('readout-modal').hidden = true;
  });

  // Link teilen
  document.getElementById('btn-share').addEventListener('click', async () => {
    const link = store.roundLink();
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link kopiert – jetzt an die Kollegen schicken');
    } catch {
      showToast(link);
    }
  });

  // Suche
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => runSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // nicht gleichzeitig Dialoge schließen
      clearSearch();
    }
  });
  document.getElementById('search-clear').addEventListener('click', clearSearch);

  // Zusammenstellen
  document.getElementById('config-close').addEventListener('click', closeConfig);
  document.getElementById('config-add').addEventListener('click', confirmConfig);

  // Schließen per Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeCartSheet();
    closeConfig();
    document.getElementById('detail-modal').hidden = true;
    document.getElementById('readout-modal').hidden = true;
  });

  // Klick auf den dunklen Rand schließt die Dialoge
  for (const id of ['detail-modal', 'readout-modal']) {
    const el = document.getElementById(id);
    el.addEventListener('click', (e) => {
      if (e.target === el) el.hidden = true;
    });
  }
  const cfg = document.getElementById('config-modal');
  cfg.addEventListener('click', (e) => {
    if (e.target === cfg) closeConfig();
  });
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 250);
  }, 1800);
}

/* ---------------- Start ---------------- */

boot();
