'use strict';

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
  cart: new Map(), // id -> { article, qty }
  discountActive: false,
  marks: 0,
};

/* ---------------- Daten laden ---------------- */

async function loadData() {
  if (window.losteria && typeof window.losteria.loadMenu === 'function') {
    return window.losteria.loadMenu();
  }
  // Browser-Fallback (Test ohne Electron): Seed direkt laden.
  const res = await fetch('./menu-seed.json');
  const menu = await res.json();
  return { menu, source: 'seed' };
}

async function boot() {
  let result;
  try {
    result = await loadData();
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
  renderHeader(result);
  renderNav();
  renderMenu();
  renderCart();
  bindCalcEvents();
}

/* ---------------- Header ---------------- */

function renderHeader(result) {
  const v = state.menu.venue || {};
  document.getElementById('venue-name').textContent =
    v.name || "L'Osteria";
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

function placeholderImg(name) {
  const ph = document.createElement('div');
  ph.className = 'dish-img placeholder';
  ph.textContent = (name || '?').trim().charAt(0).toUpperCase();
  return ph;
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

function addToCart(article) {
  const entry = state.cart.get(article.id);
  if (entry) entry.qty += 1;
  else state.cart.set(article.id, { article, qty: 1 });
  showToast(article.name + ' hinzugefügt');
  renderCart();
}

function changeQty(id, delta) {
  const entry = state.cart.get(id);
  if (!entry) return;
  entry.qty += delta;
  if (entry.qty <= 0) state.cart.delete(id);
  renderCart();
}

function clearCart() {
  state.cart.clear();
  renderCart();
}

function renderCart() {
  const wrap = document.getElementById('cart-items');
  const empty = document.getElementById('cart-empty');
  const clearBtn = document.getElementById('cart-clear');
  wrap.innerHTML = '';

  const entries = Array.from(state.cart.values());
  empty.hidden = entries.length > 0;
  clearBtn.hidden = entries.length === 0;

  for (const { article, qty } of entries) {
    const row = document.createElement('div');
    row.className = 'cart-row';

    const imgUrl = article.image && article.image.thumb;
    row.innerHTML =
      (imgUrl
        ? '<img class="cart-thumb" src="' + esc(imgUrl) + '" alt="">'
        : '<div class="cart-thumb"></div>') +
      '<div class="cart-info">' +
      '<div class="cart-name">' +
      esc(article.name) +
      '</div>' +
      '<div class="cart-unit">' +
      fmt(article.price) +
      ' / Stück</div>' +
      '</div>' +
      '<div class="cart-right">' +
      '<div class="cart-line">' +
      fmt(round2(article.price * qty)) +
      '</div>' +
      '<div class="qty">' +
      '<button data-act="minus">−</button>' +
      '<span>' +
      qty +
      '</span>' +
      '<button data-act="plus">+</button>' +
      '</div>' +
      '</div>';

    row.querySelector('[data-act="minus"]').addEventListener('click', () =>
      changeQty(article.id, -1)
    );
    row.querySelector('[data-act="plus"]').addEventListener('click', () =>
      changeQty(article.id, +1)
    );
    wrap.appendChild(row);
  }

  renderBreakdown();
}

/* ---------------- Rechner ---------------- */

function computeTotals() {
  let subtotal = 0;
  for (const { article, qty } of state.cart.values()) {
    subtotal += article.price * qty;
  }
  subtotal = round2(subtotal);

  const discount = state.discountActive ? round2(subtotal * DISCOUNT_RATE) : 0;
  const afterDiscount = round2(subtotal - discount);

  const marks = Math.max(0, Math.floor(state.marks) || 0);
  const marksValue = marks * MARK_VALUE;
  const appliedMarks = round2(Math.min(marksValue, afterDiscount));
  const wasted = round2(Math.max(0, marksValue - afterDiscount));
  const remaining = round2(Math.max(0, afterDiscount - marksValue));
  // größte Markenzahl, die den Betrag nicht übersteigt (kein Verfall)
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

  if (state.discountActive) {
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

  html += '<div class="bd-total"><span class="label">Restbetrag zu zahlen</span>' +
    '<span class="value">' +
    fmt(t.remaining) +
    '</span></div>';

  const saved = round2(t.discount + t.appliedMarks);
  if (saved > 0) {
    html +=
      '<div class="bd-saved">nicht bar zu zahlen: ' + fmt(saved) + '</div>';
  }

  el.innerHTML = html;

  // Marken-Eingabefeld mit Zustand synchronisieren
  const input = document.getElementById('marks-input');
  if (input && String(t.marks) !== input.value) input.value = t.marks;
}

function setMarks(n) {
  state.marks = Math.max(0, Math.floor(n) || 0);
  renderBreakdown();
}

function bindCalcEvents() {
  const discountBtn = document.getElementById('discount-toggle');
  discountBtn.addEventListener('click', () => {
    state.discountActive = !state.discountActive;
    discountBtn.setAttribute('aria-pressed', String(state.discountActive));
    discountBtn.querySelector('.discount-label').textContent = state.discountActive
      ? '20 % Rabatt aktiv'
      : '20 % Rabatt aktivieren';
    renderBreakdown();
  });

  document
    .getElementById('marks-minus')
    .addEventListener('click', () => setMarks(state.marks - 1));
  document
    .getElementById('marks-plus')
    .addEventListener('click', () => setMarks(state.marks + 1));
  document
    .getElementById('marks-input')
    .addEventListener('input', (e) => setMarks(e.target.value));
  document.getElementById('marks-max').addEventListener('click', () => {
    setMarks(computeTotals().maxMarks);
  });

  document.getElementById('cart-clear').addEventListener('click', clearCart);
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
  }, 1400);
}

/* ---------------- Start ---------------- */

boot();
