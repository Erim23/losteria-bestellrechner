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

/**
 * Bestimmt die Runden-Kennung: entweder aus dem Link (#r=…) oder – der
 * Normalfall – der heutige Tag, damit alle automatisch zusammenfinden.
 */
export function resolveRoundId() {
  const m = /[#&?]r=([A-Za-z0-9_-]{1,60})/.exec(location.hash || '');
  if (m) return m[1];
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `tag-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Verlinkbare Adresse der aktuellen Runde. */
export function roundLink() {
  const base = location.href.split('#')[0];
  return `${base}#r=${roundId}`;
}

/* ---------------- Start ---------------- */

/**
 * Startet die Team-Schicht. Wirft, wenn Firebase nicht erreichbar ist –
 * die App läuft dann im Einzelbetrieb weiter.
 */
export async function initTeam() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  db = getFirestore(app);

  const cred = await signInAnonymously(auth);
  uid = cred.user.uid;
  roundId = resolveRoundId();

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

/** Eine Position gehört genau einer Person und einem Artikel. */
function itemRef(articleId) {
  return doc(db, 'rounds', roundId, 'items', `${uid}__${articleId}`);
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
          price: Number(d.price) || 0,
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

/** Legt einen Artikel in den gemeinsamen Warenkorb (bzw. erhöht die Menge). */
export async function addItem(article, userName) {
  await setDoc(
    itemRef(article.id),
    {
      articleId: article.id,
      name: article.name,
      price: article.price,
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
export async function setQty(articleId, qty) {
  if (qty <= 0) {
    await deleteDoc(itemRef(articleId));
    return;
  }
  await setDoc(
    itemRef(articleId),
    { qty, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

/** Entfernt alle eigenen Positionen. */
export async function clearMine(items) {
  const mine = items.filter((i) => i.mine);
  await Promise.all(mine.map((i) => deleteDoc(itemRef(i.articleId))));
}

/** Aktualisiert den Namen an allen eigenen Positionen (nach Namenswechsel). */
export async function renameMyItems(items, newName) {
  const mine = items.filter((i) => i.mine);
  await Promise.all(
    mine.map((i) =>
      setDoc(itemRef(i.articleId), { userName: newName }, { merge: true })
    )
  );
}

/** Ändert die gemeinsamen Einstellungen (Rabatt, Marken). */
export async function setShared(patch) {
  await setDoc(roundRef(), patch, { merge: true });
}
