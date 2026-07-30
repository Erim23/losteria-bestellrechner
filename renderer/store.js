/**
 * Team-Datenschicht: gemeinsamer Warenkorb über Firebase.
 *
 * - Anmeldung erfolgt anonym und unsichtbar (kein Login-Dialog, kein Passwort).
 *   Sie dient nur dazu, jedem Gerät eine stabile Kennung zu geben, damit die
 *   Regeln durchsetzen können: jeder darf nur seine eigenen Positionen ändern.
 * - Der Name wird lokal im Browser gespeichert (localStorage), also einmal pro
 *   Gerät eingegeben und danach behalten.
 * - Eine "Bestellrunde" ist standardmäßig der heutige Tag. Wer die Seite
 *   aufruft, landet damit automatisch in derselben Runde wie die Kollegen,
 *   und am nächsten Tag ist der Warenkorb von allein wieder leer.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js';
import {
  getAuth,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  increment,
} from 'https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const NAME_KEY = 'losteria.userName';

let db = null;
let uid = null;
let roundId = null;
let unsubRound = null;
let unsubItems = null;

/** Öffentlicher Zustand der Team-Schicht. */
export const team = {
  ready: false,
  uid: null,
  roundId: null,
  error: null,
};

/* ---------------- Name (pro Gerät gespeichert) ---------------- */

export function getStoredName() {
  try {
    const n = localStorage.getItem(NAME_KEY);
    return n && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

export function setStoredName(name) {
  try {
    localStorage.setItem(NAME_KEY, String(name).trim());
  } catch {
    /* privater Modus o. Ä. – dann gilt der Name nur für diese Sitzung */
  }
}

/* ---------------- Bestellrunde ---------------- */

/** Wechselt die Runde (z. B. beim Gruppenwechsel). */
export function setRoundId(id) {
  roundId = id;
  team.roundId = id;
}

/* ---------------- Start ---------------- */

/**
 * Startet die Team-Schicht. Wirft, wenn Firebase nicht erreichbar ist –
 * die App läuft dann im Einzelbetrieb weiter.
 */
export async function initTeam(initialRoundId) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  db = getFirestore(app);

  const cred = await signInAnonymously(auth);
  uid = cred.user.uid;
  roundId = initialRoundId;

  team.ready = true;
  team.uid = uid;
  team.roundId = roundId;
  return { uid, roundId };
}

function roundRef() {
  return doc(db, 'rounds', roundId);
}

function itemsRef() {
  return collection(db, 'rounds', roundId, 'items');
}

/**
 * Eine Position gehört genau einer Person, einem Artikel und einer
 * Zusammenstellung. Gleiches Gericht mit anderen Extras = eigene Position.
 */
function itemKey(articleId, variant) {
  return variant
    ? `${uid}__${articleId}__${variant}`
    : `${uid}__${articleId}`;
}

function itemRefByKey(key) {
  return doc(db, 'rounds', roundId, 'items', key);
}

/**
 * Abonniert die Runde: gemeinsame Einstellungen (Rabatt/Marken) und alle
 * Positionen. Die Rückrufe feuern bei jeder Änderung – auch von anderen.
 */
export function subscribe({ onShared, onItems, onError }) {
  unsubRound = onSnapshot(
    roundRef(),
    (snap) => {
      const d = snap.exists() ? snap.data() : {};
      onShared({
        discountActive: !!d.discountActive,
        marksTotal: Number(d.marksTotal) || 0,
        marksByUid: d.marksByUid && typeof d.marksByUid === 'object' ? d.marksByUid : {},
        // Ergebnisse des Glücksrads (wer ruft an, wer holt ab)
        draw: d.draw && typeof d.draw === 'object' ? d.draw : {},
        // Anzeigename der Gruppe – damit Beitretende ihn auch sehen
        groupName: typeof d.groupName === 'string' ? d.groupName : '',
      });
    },
    onError
  );

  unsubItems = onSnapshot(
    itemsRef(),
    (snap) => {
      const items = [];
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const qty = Number(d.qty) || 0;
        if (qty <= 0) return;
        items.push({
          key: docSnap.id,
          articleId: d.articleId,
          name: d.name || '',
          // price ist der Stückpreis einschließlich gewählter Extras
          price: Number(d.price) || 0,
          basePrice: Number(d.basePrice ?? d.price) || 0,
          options: Array.isArray(d.options) ? d.options : [],
          image: d.image || null,
          qty,
          uid: d.uid,
          userName: d.userName || 'Ohne Namen',
          mine: d.uid === uid,
        });
      });
      onItems(items);
    },
    onError
  );
}

export function unsubscribe() {
  if (unsubRound) unsubRound();
  if (unsubItems) unsubItems();
  unsubRound = null;
  unsubItems = null;
}

/* ---------------- Änderungen ---------------- */

/**
 * Legt einen Artikel in den gemeinsamen Warenkorb (bzw. erhöht die Menge).
 * config = { options: [{name, price}], unitPrice, variant }
 */
export async function addItem(article, userName, config) {
  const options = (config && config.options) || [];
  const unitPrice =
    config && typeof config.unitPrice === 'number'
      ? config.unitPrice
      : article.price;
  const variant = (config && config.variant) || '';

  await setDoc(
    itemRefByKey(itemKey(article.id, variant)),
    {
      articleId: article.id,
      name: article.name,
      price: unitPrice,
      basePrice: article.price,
      options,
      image: article.image ? article.image.thumb : null,
      uid,
      userName,
      qty: increment(1),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

/** Setzt die Menge einer eigenen Position; 0 entfernt sie. */
export async function setQtyByKey(key, qty) {
  if (qty <= 0) {
    await deleteDoc(itemRefByKey(key));
    return;
  }
  await setDoc(
    itemRefByKey(key),
    { qty, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/**
 * Entfernt eine Position anhand ihrer Dokument-Kennung. Auch fremde – damit
 * Tippfehler und Positionen abwesender Kollegen aufgeräumt werden können.
 */
export async function deleteItemByKey(key) {
  await deleteDoc(doc(db, 'rounds', roundId, 'items', key));
}

/** Entfernt alle eigenen Positionen. */
export async function clearMine(items) {
  const mine = items.filter((i) => i.mine);
  await Promise.all(mine.map((i) => deleteDoc(itemRefByKey(i.key))));
}

/** Aktualisiert den Namen an allen eigenen Positionen (nach Namenswechsel). */
export async function renameMyItems(items, newName) {
  const mine = items.filter((i) => i.mine);
  await Promise.all(
    mine.map((i) =>
      setDoc(itemRefByKey(i.key), { userName: newName }, { merge: true })
    )
  );
}

/** Ändert die gemeinsamen Einstellungen (Rabatt, Marken). */
export async function setShared(patch) {
  await setDoc(roundRef(), patch, { merge: true });
}
