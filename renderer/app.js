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
  shared: {
    discountActive: false,
    marksTotal: 0,
    marksByUid: {},
    draw: {},
    groupName: '',
  },
  groupId: null, // aktuelle Gruppe (null = Startseite)
  groupMetaName: '', // zentral hinterlegter Gruppenname
  articleById: new Map(),
  optionGroups: {}, // Nachschlagewerk der Optionsgruppen
  teamConfirmed: false, // true, sobald Firestore erfolgreich geliefert hat
  config: null, // aktuell offener Zusammenstellen-Dialog
  wheel: {
    mode: 'call', // 'call' = anrufen, 'pickup' = abholen
    excluded: new Set(), // abgewählte Namen
    rotation: 0,
    spinning: false,
  },
  drawSeen: { call: 0, pickup: 0 }, // zuletzt gesehene Ergebnisse
  drawReady: false, // erst nach dem ersten Abgleich Konfetti zeigen
};

/* ---------------- Gruppen (getrennte Bestellräume) ---------------- */

const GROUPS_KEY = 'losteria.groups';
const LAST_GROUP_KEY = 'losteria.lastGroup';

/**
 * Die ursprüngliche Gruppe behält bewusst ihre alte Runden-Kennung
 * ("tag-JJJJ-MM-TT"). Nur so bleiben bereits laufende Bestellungen und
 * geteilte Links unverändert gültig.
 */
const LEGACY_GROUP = { id: 'stamm', name: 'Azubibüro' };

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Jede Gruppe bekommt pro Tag eine eigene Runde – täglich frischer Start. */
function roundIdFor(groupId) {
  if (!groupId || groupId === LEGACY_GROUP.id) return 'tag-' + todayStamp();
  return groupId + '__' + todayStamp();
}

function groupFromHash() {
  const m = /[#&]g=([A-Za-z0-9_-]{1,60})/.exec(location.hash || '');
  return m ? m[1] : null;
}

/** Nur für Tests und Altlinks: exakte Runde erzwingen. */
function roundFromHash() {
  const m = /[#&]r=([A-Za-z0-9_-]{1,60})/.exec(location.hash || '');
  return m ? m[1] : null;
}

function loadGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((g) => g && g.id) : [];
  } catch {
    return [];
  }
}

function saveGroups(list) {
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(list));
  } catch {
    /* privater Modus – dann gilt die Liste nur für diese Sitzung */
  }
}

/** Merkt sich eine Gruppe lokal, damit sie im Menü auftaucht. */
function rememberGroup(id, name) {
  const list = loadGroups();
  const found = list.find((g) => g.id === id);
  if (found) {
    if (name && found.name !== name) found.name = name;
  } else {
    list.push({ id, name: name || prettyGroupName(id) });
  }
  saveGroups(list);
  try {
    localStorage.setItem(LAST_GROUP_KEY, id);
  } catch {
    /* egal */
  }
}

/** "marketing-k7m2" -> "Marketing" */
function prettyGroupName(id) {
  if (!id || id === LEGACY_GROUP.id) return LEGACY_GROUP.name;
  const ohneAnhang = String(id).replace(/-[a-z0-9]{4}$/i, '');
  const worte = ohneAnhang.split('-').filter(Boolean);
  return (
    worte.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || id
  );
}

/** Erzeugt aus einem Namen eine eindeutige Kennung. */
function makeGroupId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const zeichen = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let anhang = '';
  const zufall = new Uint32Array(4);
  (crypto || window.crypto).getRandomValues(zufall);
  for (let i = 0; i < 4; i++) anhang += zeichen[zufall[i] % zeichen.length];
  return (slug || 'gruppe') + '-' + anhang;
}

/** Anzeigename der aktuellen Gruppe: geteilt > lokal > aus der Kennung. */
function currentGroupName() {
  if (state.groupMetaName) return state.groupMetaName;
  if (state.shared.groupName) return state.shared.groupName;
  const local = loadGroups().find((g) => g.id === state.groupId);
  if (local && local.name) return local.name;
  return prettyGroupName(state.groupId);
}

/** Link, der direkt in die aktuelle Gruppe führt. */
function groupLink() {
  const base = location.href.split('#')[0];
  if (!state.groupId || state.groupId === LEGACY_GROUP.id) return base;
  return base + '#g=' + state.groupId;
}

/**
 * Entscheidet beim Start, in welcher Gruppe wir landen.
 * Rückgabe null bedeutet: Startseite zur Auswahl zeigen.
 */
function resolveStartGroup() {
  const ausLink = groupFromHash();
  if (ausLink) return ausLink;

  let letzte = null;
  try {
    letzte = localStorage.getItem(LAST_GROUP_KEY);
  } catch {
    /* egal */
  }
  if (letzte) return letzte;

  // Wer die App schon benutzt hat (Name hinterlegt), gehörte bisher zur
  // Stammgruppe – der soll nicht plötzlich vor einer Auswahl stehen.
  if (store.getStoredName()) return LEGACY_GROUP.id;

  return null;
}

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

  const startGruppe = resolveStartGroup();
  const festeRunde = roundFromHash(); // Altlink/Test: exakte Runde
  state.groupId = startGruppe;

  try {
    await store.initTeam(
      festeRunde || roundIdFor(startGruppe || LEGACY_GROUP.id)
    );
    state.mode = 'team';
    setupTeamBar();
    // Erst die Gruppe klären, dann den Namen – sonst lägen zwei Abfragen
    // übereinander.
    if (!festeRunde && !startGruppe) {
      openGroupGate();
    }
    store.subscribe({
      onShared: (shared) => {
        state.shared = shared;
        syncGroupName();
        renderBreakdown();
        handleDrawUpdate();
        if (!document.getElementById('detail-modal').hidden) renderDetail();
        if (!document.getElementById('wheel-modal').hidden) {
          renderWheelSvg();
          updateSpinState();
        }
      },
      onItems: (items) => {
        state.teamConfirmed = true;
        state.items = items;
        renderCart();
        if (!document.getElementById('detail-modal').hidden) renderDetail();
        if (!document.getElementById('readout-modal').hidden) renderReadout();
        if (!document.getElementById('wheel-modal').hidden) {
          renderPeopleChips();
          renderWheelSvg();
          updateSpinState();
        }
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
    if (state.groupId) applyGroupMeta(state.groupId);
    if (!state.userName && document.getElementById('group-gate').hidden) {
      openNameGate();
    }
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
  renderRoundLabel();
  updateNameLabel();
}

/** Zeigt Gruppe und Datum der laufenden Runde. */
function renderRoundLabel() {
  const el = document.getElementById('team-round');
  if (!el) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const datum = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  el.textContent = state.groupId
    ? `${currentGroupName()} · ${datum}`
    : `Bestellrunde ${datum}`;
}

/** Älterer Weg: Name lag in der Tagesrunde. Wird nur noch gelesen. */
function syncGroupName() {
  if (state.mode !== 'team') return;
  if (state.shared.groupName) {
    rememberGroup(state.groupId, state.shared.groupName);
  }
  renderRoundLabel();
}

/**
 * Holt Name und Löschzustand der Gruppe. Beides gilt für alle, liegt also
 * zentral und nicht nur im Browser des Anlegenden.
 */
async function applyGroupMeta(groupId, nameVorschlag) {
  if (state.mode !== 'team' || !groupId) return;
  const meta = await store.getGroupMeta(groupId);

  if (meta.deleted) {
    await handleDeletedGroup(groupId);
    return;
  }

  if (meta.name) {
    rememberGroup(groupId, meta.name);
    state.groupMetaName = meta.name;
  } else {
    // Noch kein Name hinterlegt: einmalig nachtragen, damit ihn alle sehen.
    const lokal = loadGroups().find((g) => g.id === groupId);
    const name =
      nameVorschlag ||
      (lokal && lokal.name) ||
      (groupId === LEGACY_GROUP.id ? LEGACY_GROUP.name : prettyGroupName(groupId));
    state.groupMetaName = name;
    try {
      await store.setGroupMeta(groupId, { name });
    } catch (err) {
      console.error('Gruppenname nicht speicherbar:', err);
    }
  }
  renderRoundLabel();
}

/** Wurde die Gruppe von jemandem gelöscht, verlassen wir sie. */
async function handleDeletedGroup(groupId) {
  forgetGroup(groupId);
  showToast('Diese Gruppe wurde gelöscht.');

  // Adresse bereinigen, sonst käme die Meldung bei jedem Neuladen wieder
  if (groupFromHash() === groupId) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  const rest = loadGroups();
  if (rest.length) {
    await switchGroup(rest[0].id, rest[0].name);
    return;
  }

  store.unsubscribe();
  state.groupId = null;
  state.groupMetaName = '';
  state.items = [];
  renderRoundLabel();
  renderCart();
  openGroupGate();
}

/** Entfernt eine Gruppe aus der lokalen Liste. */
function forgetGroup(id) {
  saveGroups(loadGroups().filter((g) => g.id !== id));
  try {
    if (localStorage.getItem(LAST_GROUP_KEY) === id) {
      localStorage.removeItem(LAST_GROUP_KEY);
    }
  } catch {
    /* egal */
  }
}

function updateNameLabel() {
  const el = document.getElementById('team-name');
  if (el) el.textContent = state.userName || '—';
}

/* ---------------- Gruppe wechseln, Menü, Startseite ---------------- */

/** Wechselt die Gruppe, ohne die Seite neu zu laden. */
async function switchGroup(groupId, name) {
  if (state.mode !== 'team') return;
  if (groupId === state.groupId) {
    closeMenu();
    return;
  }

  store.unsubscribe();
  state.groupId = groupId;
  state.groupMetaName = '';
  state.items = [];
  state.shared = {
    discountActive: false,
    marksTotal: 0,
    marksByUid: {},
    draw: {},
    groupName: '',
  };
  state.drawSeen = { call: 0, pickup: 0 };
  state.drawReady = false;
  state.wheel.excluded = new Set();

  rememberGroup(groupId, name);
  store.setRoundId(roundIdFor(groupId));

  // Link mitziehen, damit Teilen und Neuladen in dieser Gruppe bleiben
  const neuerHash =
    groupId === LEGACY_GROUP.id ? '' : '#g=' + groupId;
  history.replaceState(null, '', location.pathname + location.search + neuerHash);

  renderRoundLabel();
  renderCart();
  renderDrawChips();

  store.subscribe({
    onShared: (shared) => {
      state.shared = shared;
      syncGroupName();
      renderBreakdown();
      handleDrawUpdate();
      if (!document.getElementById('detail-modal').hidden) renderDetail();
      if (!document.getElementById('wheel-modal').hidden) {
        renderWheelSvg();
        updateSpinState();
      }
    },
    onItems: (items) => {
      state.items = items;
      renderCart();
      if (!document.getElementById('wheel-modal').hidden) {
        renderPeopleChips();
        renderWheelSvg();
        updateSpinState();
      }
    },
    onError: (err) => {
      console.error('Firestore-Fehler:', err);
      showToast('Verbindung zur Gruppe gestört');
    },
  });

  closeMenu();
  closeGroupGate();
  await applyGroupMeta(groupId, name);
  showToast('Gruppe: ' + currentGroupName());

  // Gruppe steht – jetzt darf nach dem Namen gefragt werden
  if (!state.userName) openNameGate();
}

function openMenu() {
  renderGroupList();
  document.getElementById('menu-panel').hidden = false;
}

function closeMenu() {
  const el = document.getElementById('menu-panel');
  if (el) el.hidden = true;
}

function renderGroupList() {
  const list = document.getElementById('menu-groups');
  list.innerHTML = '';

  const gruppen = loadGroups();
  // Die Stammgruppe steht immer zur Verfügung
  if (!gruppen.some((g) => g.id === LEGACY_GROUP.id)) {
    gruppen.unshift({ id: LEGACY_GROUP.id, name: LEGACY_GROUP.name });
  }

  for (const g of gruppen) {
    const aktiv = g.id === state.groupId;
    const name = g.name || prettyGroupName(g.id);

    const row = document.createElement('div');
    row.className = 'menu-group' + (aktiv ? ' is-active' : '');

    const wechsel = document.createElement('button');
    wechsel.className = 'mg-switch';
    wechsel.innerHTML =
      '<span class="mg-name">' +
      esc(name) +
      '</span>' +
      (aktiv ? '<span class="mg-tag">hier</span>' : '');
    wechsel.addEventListener('click', () => switchGroup(g.id, g.name));
    row.appendChild(wechsel);

    const werkzeuge = document.createElement('span');
    werkzeuge.className = 'mg-tools';

    const umbenennen = document.createElement('button');
    umbenennen.className = 'mg-tool';
    umbenennen.title = 'Umbenennen';
    umbenennen.setAttribute('aria-label', 'Gruppe umbenennen');
    umbenennen.textContent = '✏️';
    umbenennen.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(row, g.id, name);
    });
    werkzeuge.appendChild(umbenennen);

    const loeschen = document.createElement('button');
    loeschen.className = 'mg-tool';
    loeschen.title = 'Löschen';
    loeschen.setAttribute('aria-label', 'Gruppe löschen');
    loeschen.textContent = '🗑️';
    loeschen.addEventListener('click', (e) => {
      e.stopPropagation();
      askDelete(row, g.id, name);
    });
    werkzeuge.appendChild(loeschen);

    row.appendChild(werkzeuge);
    list.appendChild(row);
  }
}

/** Zeile in ein Eingabefeld verwandeln. */
function startRename(row, groupId, aktuellerName) {
  row.innerHTML = '';
  row.classList.add('is-editing');

  const feld = document.createElement('input');
  feld.className = 'text-input mg-input';
  feld.value = aktuellerName;
  feld.maxLength = 28;

  const ok = document.createElement('button');
  ok.className = 'mg-tool';
  ok.textContent = '✓';
  ok.title = 'Speichern';

  const ab = document.createElement('button');
  ab.className = 'mg-tool';
  ab.textContent = '✕';
  ab.title = 'Abbrechen';

  ok.addEventListener('click', () => renameGroup(groupId, feld.value));
  ab.addEventListener('click', () => renderGroupList());
  feld.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameGroup(groupId, feld.value);
    if (e.key === 'Escape') {
      e.stopPropagation();
      renderGroupList();
    }
  });

  row.appendChild(feld);
  row.appendChild(ok);
  row.appendChild(ab);
  feld.focus();
  feld.select();
}

/** Rückfrage vor dem Löschen – es trifft auch die Bestellungen der anderen. */
function askDelete(row, groupId, name) {
  row.innerHTML = '';
  row.classList.add('is-confirming');

  const text = document.createElement('span');
  text.className = 'mg-confirm-text';
  text.textContent = '„' + name + '" für alle löschen?';

  const ja = document.createElement('button');
  ja.className = 'mg-danger';
  ja.textContent = 'Löschen';

  const nein = document.createElement('button');
  nein.className = 'mg-tool';
  nein.textContent = 'Abbrechen';

  ja.addEventListener('click', () => deleteGroup(groupId));
  nein.addEventListener('click', () => renderGroupList());

  row.appendChild(text);
  row.appendChild(ja);
  row.appendChild(nein);
}

/** Benennt eine Gruppe für alle um. */
async function renameGroup(groupId, neuerName) {
  const name = String(neuerName || '').trim();
  if (!name) return;
  try {
    await store.setGroupMeta(groupId, { name });
    rememberGroup(groupId, name);
    if (groupId === state.groupId) {
      state.groupMetaName = name;
      renderRoundLabel();
    }
    renderGroupList();
    showToast('Gruppe heißt jetzt „' + name + '"');
  } catch (err) {
    console.error(err);
    showToast('Umbenennen nicht möglich');
  }
}

/**
 * Löscht eine Gruppe für alle: sie wird zentral als gelöscht vermerkt und
 * ihre heutigen Bestellungen werden entfernt. Wer sie noch offen hat, fliegt
 * beim nächsten Betreten heraus.
 */
async function deleteGroup(groupId) {
  try {
    const entfernt = await store.wipeRound(roundIdFor(groupId));
    await store.setGroupMeta(groupId, { deleted: true });
    forgetGroup(groupId);

    if (groupId === state.groupId) {
      const rest = loadGroups();
      if (rest.length) {
        await switchGroup(rest[0].id, rest[0].name);
      } else {
        state.groupId = null;
        state.groupMetaName = '';
        state.items = [];
        store.unsubscribe();
        renderCart();
        closeMenu();
        openGroupGate();
      }
    } else {
      renderGroupList();
    }
    showToast(
      'Gruppe gelöscht' + (entfernt ? ' (' + entfernt + ' Positionen)' : '')
    );
  } catch (err) {
    console.error(err);
    showToast('Löschen nicht möglich');
  }
}

async function createGroup() {
  const input = document.getElementById('new-group-name');
  const name = input.value.trim();
  const fehler = document.getElementById('new-group-error');
  if (!name) {
    fehler.hidden = false;
    return;
  }
  fehler.hidden = true;
  input.value = '';
  const id = makeGroupId(name);
  // Der Name wird beim Betreten zentral hinterlegt (applyGroupMeta),
  // damit ihn auch Beitretende sehen.
  await switchGroup(id, name);
}

function openGroupGate() {
  renderGroupGate();
  document.getElementById('group-gate').hidden = false;
}

function closeGroupGate() {
  const el = document.getElementById('group-gate');
  if (el) el.hidden = true;
}

function renderGroupGate() {
  const box = document.getElementById('gate-groups');
  box.innerHTML = '';
  const gruppen = loadGroups();
  if (!gruppen.some((g) => g.id === LEGACY_GROUP.id)) {
    gruppen.unshift({ id: LEGACY_GROUP.id, name: LEGACY_GROUP.name });
  }
  for (const g of gruppen) {
    const btn = document.createElement('button');
    btn.className = 'gate-group';
    btn.textContent = g.name || prettyGroupName(g.id);
    btn.addEventListener('click', () => switchGroup(g.id, g.name));
    box.appendChild(btn);
  }
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

/* ---------------- Glücksrad: wer ruft an, wer holt ab ---------------- */

const WHEEL_COLORS = [
  '#db002a',
  '#2a2622',
  '#a80020',
  '#8a5a00',
  '#2e7d4f',
  '#7d0018',
  '#5a4633',
  '#b5455f',
];
const SPIN_MS = 4000;

function prefersReducedMotion() {
  return (
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Alle Personen der Bestellrunde – plus man selbst. */
function wheelPeople() {
  const names = new Set();
  for (const e of state.items) if (e.userName) names.add(e.userName);
  if (state.userName) names.add(state.userName);
  return Array.from(names).sort((a, b) => a.localeCompare(b, 'de'));
}

/**
 * Wer landet auf dem Rad: alle Ausgewählten. Beim Abholen wird zusätzlich
 * übersprungen, wer schon anrufen muss – außer es bliebe niemand übrig.
 */
function wheelCandidates() {
  const chosen = wheelPeople().filter((n) => !state.wheel.excluded.has(n));
  if (state.wheel.mode !== 'pickup') return chosen;
  const caller = state.shared.draw && state.shared.draw.call;
  if (!caller || !caller.name) return chosen;
  const rest = chosen.filter((n) => n !== caller.name);
  return rest.length ? rest : chosen;
}

/** Punkt auf dem Rad; Winkel im Uhrzeigersinn ab 12 Uhr. */
function polar(radius, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: 100 + radius * Math.sin(rad),
    y: 100 - radius * Math.cos(rad),
  };
}

function shortName(n) {
  const s = String(n || '');
  return s.length > 12 ? s.slice(0, 11) + '…' : s;
}

function renderWheelSvg() {
  const svg = document.getElementById('wheel-svg');
  const list = wheelCandidates();
  const n = list.length;
  let html = '';

  if (n === 0) {
    html =
      '<circle cx="100" cy="100" r="95" fill="#efe7d7"/>' +
      '<text x="100" y="104" text-anchor="middle" fill="#8a8175" font-size="11">' +
      'niemand ausgewählt</text>';
  } else if (n === 1) {
    html =
      '<circle cx="100" cy="100" r="95" fill="' +
      WHEEL_COLORS[0] +
      '"/><text x="100" y="105" text-anchor="middle" fill="#fff" font-size="13">' +
      esc(shortName(list[0])) +
      '</text>';
  } else {
    const seg = 360 / n;
    for (let i = 0; i < n; i++) {
      const a0 = i * seg;
      const a1 = a0 + seg;
      const p0 = polar(95, a0);
      const p1 = polar(95, a1);
      const largeArc = seg > 180 ? 1 : 0;
      html +=
        '<path d="M 100 100 L ' +
        p0.x.toFixed(2) +
        ' ' +
        p0.y.toFixed(2) +
        ' A 95 95 0 ' +
        largeArc +
        ' 1 ' +
        p1.x.toFixed(2) +
        ' ' +
        p1.y.toFixed(2) +
        ' Z" fill="' +
        WHEEL_COLORS[i % WHEEL_COLORS.length] +
        '" stroke="#fff" stroke-width="1"/>';

      // Beschriftung mittig im Segment, nie auf dem Kopf
      const mid = a0 + seg / 2;
      const t = polar(62, mid);
      const rot = mid > 90 && mid < 270 ? mid + 180 : mid;
      html +=
        '<text x="' +
        t.x.toFixed(2) +
        '" y="' +
        t.y.toFixed(2) +
        '" fill="#fff" text-anchor="middle" dominant-baseline="middle" ' +
        'transform="rotate(' +
        rot.toFixed(2) +
        ' ' +
        t.x.toFixed(2) +
        ' ' +
        t.y.toFixed(2) +
        ')">' +
        esc(shortName(list[i])) +
        '</text>';
    }
  }

  html +=
    '<circle cx="100" cy="100" r="9" fill="#fff" stroke="#e6ddcc" stroke-width="2"/>';
  svg.innerHTML = html;
}

/**
 * Drehwinkel, damit das Segment der gezogenen Person unter dem Zeiger
 * stehen bleibt. Die Person wird zuerst gezogen, der Winkel daraus berechnet –
 * so kann Anzeige und Ergebnis nicht auseinanderlaufen.
 */
function rotationFor(index, count, current) {
  const seg = 360 / count;
  const target = index * seg + seg / 2;
  const need = (360 - target) % 360;
  const fullTurns = Math.ceil(current / 360) * 360;
  return fullTurns + 360 * 5 + need;
}

function renderPeopleChips() {
  const box = document.getElementById('people-list');
  const people = wheelPeople();
  box.innerHTML = '';

  if (!people.length) {
    box.innerHTML =
      '<div class="people-empty">Noch niemand in der Bestellrunde.</div>';
    return;
  }

  for (const name of people) {
    const chip = document.createElement('button');
    chip.className =
      'person-chip' + (state.wheel.excluded.has(name) ? '' : ' on');
    chip.textContent = name;
    chip.addEventListener('click', () => {
      if (state.wheel.excluded.has(name)) state.wheel.excluded.delete(name);
      else state.wheel.excluded.add(name);
      renderPeopleChips();
      renderWheelSvg();
      updateSpinState();
    });
    box.appendChild(chip);
  }
}

function updateSpinState() {
  const btn = document.getElementById('wheel-spin');
  const list = wheelCandidates();
  btn.disabled = list.length === 0 || state.wheel.spinning;
  btn.textContent = state.wheel.spinning
    ? 'dreht …'
    : list.length === 0
      ? 'niemand ausgewählt'
      : 'Drehen';
}

function showDrawResult(mode, name, celebrate) {
  const el = document.getElementById('wheel-result');
  el.hidden = false;
  el.innerHTML =
    '🎉 Glückwunsch!<br><b>' +
    esc(name) +
    '</b> ' +
    (mode === 'pickup' ? 'muss abholen.' : 'muss anrufen.');
  if (celebrate) confettiBurst();
}

function setWheelMode(mode) {
  state.wheel.mode = mode;
  for (const box of document.querySelectorAll('.mode-box')) {
    box.classList.toggle('is-active', box.dataset.mode === mode);
  }
  renderWheelSvg();
  updateSpinState();

  // Vorhandenes Ergebnis dieses Modus anzeigen (ohne erneutes Konfetti)
  const entry = (state.shared.draw || {})[mode];
  const el = document.getElementById('wheel-result');
  if (entry && entry.name) showDrawResult(mode, entry.name, false);
  else el.hidden = true;
}

function openWheel() {
  document.getElementById('wheel-modal').hidden = false;
  renderPeopleChips();
  setWheelMode(state.wheel.mode);
}

function closeWheel() {
  document.getElementById('wheel-modal').hidden = true;
}

async function spinWheel() {
  const w = state.wheel;
  if (w.spinning) return;
  const list = wheelCandidates();
  if (!list.length) return;

  w.spinning = true;
  updateSpinState();
  document.getElementById('wheel-result').hidden = true;

  const index = Math.floor(Math.random() * list.length);
  const winner = list[index];

  const svg = document.getElementById('wheel-svg');
  w.rotation = rotationFor(index, list.length, w.rotation);
  svg.style.transform = 'rotate(' + w.rotation + 'deg)';

  // Bewusst über eine Zeitspanne statt über transitionend: das Ereignis kann
  // ausbleiben (z. B. ohne laufende Animation) und das Rad bliebe hängen.
  const dur = prefersReducedMotion() ? 600 : SPIN_MS;
  await new Promise((r) => setTimeout(r, dur + 120));

  w.spinning = false;
  updateSpinState();
  showDrawResult(w.mode, winner, true);

  const entry = {
    name: winner,
    at: Date.now(),
    by: (store.team && store.team.uid) || 'local',
  };
  state.drawSeen[w.mode] = entry.at; // eigenes Ergebnis nicht doppelt feiern
  const draw = Object.assign({}, state.shared.draw || {}, { [w.mode]: entry });
  await updateShared({ draw });
}

/** Zeigt in der Bestellrunden-Leiste, wer gezogen wurde. */
function renderDrawChips() {
  const d = state.shared.draw || {};
  const set = (id, entry, verb) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (entry && entry.name) {
      el.hidden = false;
      el.textContent = entry.name + ' ' + verb;
    } else {
      el.hidden = true;
    }
  };
  set('draw-caller', d.call, 'ruft an');
  set('draw-pickup', d.pickup, 'holt ab');
}

/** Feiert Ergebnisse, die jemand anderes gedreht hat. */
function handleDrawUpdate() {
  const d = state.shared.draw || {};
  const myUid = (store.team && store.team.uid) || 'local';

  for (const mode of ['call', 'pickup']) {
    const entry = d[mode];
    const at = entry && entry.at ? Number(entry.at) : 0;

    if (!state.drawReady) {
      // Beim ersten Abgleich nur merken – sonst würde beim Öffnen der Seite
      // ein längst bekanntes Ergebnis erneut gefeiert.
      state.drawSeen[mode] = at;
      continue;
    }
    if (at > (state.drawSeen[mode] || 0)) {
      state.drawSeen[mode] = at;
      if (entry.by !== myUid) {
        showToast(
          '🎉 ' + entry.name + (mode === 'pickup' ? ' holt ab!' : ' ruft an!')
        );
        confettiBurst();
      }
    }
  }
  state.drawReady = true;
  renderDrawChips();
}

/* ---------------- Konfetti (ohne fremde Bibliothek) ---------------- */

let confettiRaf = null;
let confettiStop = null;
function confettiBurst() {
  if (prefersReducedMotion()) return;

  const canvas = document.getElementById('confetti');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.hidden = false;

  const colors = ['#db002a', '#f01238', '#ffd166', '#2e7d4f', '#ffffff', '#a80020'];
  const parts = [];
  for (let i = 0; i < 140; i++) {
    parts.push({
      x: w / 2 + (Math.random() - 0.5) * Math.min(300, w * 0.7),
      y: h * 0.35 + (Math.random() - 0.5) * 90,
      vx: (Math.random() - 0.5) * 7,
      vy: Math.random() * -9 - 3,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 9,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.32,
      col: colors[(Math.random() * colors.length) | 0],
    });
  }

  if (confettiRaf) cancelAnimationFrame(confettiRaf);
  // Sicherheitsnetz: läuft die Animation nicht (z. B. Hintergrund-Tab),
  // würde die Fläche sonst dauerhaft liegen bleiben.
  if (confettiStop) clearTimeout(confettiStop);
  confettiStop = setTimeout(() => {
    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    confettiRaf = null;
    ctx.clearRect(0, 0, w, h);
    canvas.hidden = true;
  }, 3600);

  const start = performance.now();

  const tick = (now) => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, w, h);
    let visible = 0;

    for (const p of parts) {
      p.vy += 0.28;
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y < h + 40) visible++;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - elapsed / 2600);
      ctx.fillStyle = p.col;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (elapsed < 2800 && visible > 0) {
      confettiRaf = requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, w, h);
      canvas.hidden = true;
      confettiRaf = null;
      if (confettiStop) clearTimeout(confettiStop);
    }
  };
  confettiRaf = requestAnimationFrame(tick);
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
  renderDrawChips();
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
    const link = groupLink();
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

  // Menü und Gruppen
  document.getElementById('menu-open').addEventListener('click', openMenu);
  document.getElementById('menu-close').addEventListener('click', closeMenu);
  document.getElementById('menu-backdrop').addEventListener('click', closeMenu);
  document.getElementById('new-group-save').addEventListener('click', createGroup);
  document.getElementById('new-group-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createGroup();
  });
  document.getElementById('menu-share').addEventListener('click', async () => {
    const link = groupLink();
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link zu „' + currentGroupName() + '" kopiert');
    } catch {
      showToast(link);
    }
  });
  document.getElementById('gate-create').addEventListener('click', async () => {
    const input = document.getElementById('gate-group-name');
    const name = input.value.trim();
    if (!name) {
      document.getElementById('gate-error').hidden = false;
      return;
    }
    input.value = '';
    const id = makeGroupId(name);
    await switchGroup(id, name);
  });
  document.getElementById('gate-group-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('gate-create').click();
  });

  // Glücksrad
  document.getElementById('wheel-open').addEventListener('click', openWheel);
  document.getElementById('wheel-close').addEventListener('click', closeWheel);
  document.getElementById('wheel-spin').addEventListener('click', spinWheel);
  for (const box of document.querySelectorAll('.mode-box')) {
    box.addEventListener('click', () => setWheelMode(box.dataset.mode));
  }
  document.getElementById('draw-caller').addEventListener('click', () => {
    setWheelMode('call');
    openWheel();
  });
  document.getElementById('draw-pickup').addEventListener('click', () => {
    setWheelMode('pickup');
    openWheel();
  });

  // Schließen per Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeCartSheet();
    closeConfig();
    if (!state.wheel.spinning) closeWheel();
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
  const wheelModal = document.getElementById('wheel-modal');
  wheelModal.addEventListener('click', (e) => {
    if (e.target === wheelModal && !state.wheel.spinning) closeWheel();
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
