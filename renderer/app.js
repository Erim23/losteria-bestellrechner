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

/* ---------------- Zustand ---------------- */

const state = {
  menu: null,
  mode: 'local', // 'team' sobald Firebase läuft
  userName: null,
  items: [], // Positionen: {key, articleId, name, price, image, qty, uid, userName, mine}
  shared: { discountActive: false, marksTotal: 0, marksByUid: {} },
  articleById: new Map(),
  teamConfirmed: false, // true, sobald Firestore erfolgreich geliefert hat
};

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

  const badge = document.getElementById('data-source');
  badge.hidden = false;
  if (result.source === 'live') {
    badge.textContent = 'Live · aktuelle Preise';
    badge.className = 'source-badge live';
  } else {
    badge.textContent =
      result.source === 'cache'
        ? 'Offline · zwischengespeichert'
        : 'Offline · Beispielstand';
    badge.className = 'source-badge offline';
    badge.title = result.error ? 'Grund: ' + result.error : '';
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

function dishCard(article) {
  const card = document.createElement('div');
  card.className = 'dish';

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
    fmt(article.price) +
    '</span>' +
    '</div>';

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+';
  addBtn.title = 'In den Warenkorb';
  addBtn.addEventListener('click', () => addToCart(article));
  body.querySelector('.dish-foot').appendChild(addBtn);

  card.appendChild(body);
  return card;
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
    cat.articles.forEach((a) => grid.appendChild(dishCard(a)));
    section.appendChild(grid);
    menu.appendChild(section);
  });

  setupScrollSpy();
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

async function addToCart(article) {
  if (state.mode === 'team' && !state.userName) {
    openNameGate();
    return;
  }
  if (state.mode === 'team') {
    try {
      await store.addItem(article, state.userName);
      showToast(article.name + ' hinzugefügt');
    } catch (err) {
      console.error(err);
      showToast('Konnte nicht hinzugefügt werden');
    }
    return;
  }
  // Einzelbetrieb
  const key = 'local__' + article.id;
  const found = state.items.find((i) => i.key === key);
  if (found) found.qty += 1;
  else
    state.items.push({
      key,
      articleId: article.id,
      name: article.name,
      price: article.price,
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
      await store.setQty(entry.articleId, next);
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
      : '<div class="qty-static">×' + entry.qty + '</div>') +
    '</div>';

  if (entry.mine) {
    row
      .querySelector('[data-act="minus"]')
      .addEventListener('click', () => changeQty(entry, -1));
    row
      .querySelector('[data-act="plus"]')
      .addEventListener('click', () => changeQty(entry, +1));
  }
  return row;
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

  // Gleiche Artikel über alle Personen zusammenfassen
  const agg = new Map();
  for (const e of state.items) {
    const cur = agg.get(e.articleId);
    if (cur) cur.qty += e.qty;
    else agg.set(e.articleId, { name: e.name, price: e.price, qty: e.qty });
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

  // Schließen per Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeCartSheet();
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
