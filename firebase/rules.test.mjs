// Tests des règles Firestore sur l'émulateur (lancés par .github/workflows/rules.yml).
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, query, where, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-affut',
  firestore: { rules: readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
});
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const weekStart = s => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7)); return ymd(d); };
const today = ymd(new Date());
let fails = 0;
async function t(name, run) {
  try { await run(); console.log('✓', name); } catch (e) { fails++; console.log('✗', name, '—', e.message); }
}
const db = uid => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const review = (uid, k, d, extra = {}) => ({
  k, uid, r: 8, w: weekStart(d), d, t: 'Titre', a: 'Artiste', img: 'https://cdn-images.dzcdn.net/x.jpg', rt: 'album', c: 'rfr',
  h: uid, n: uid, ph: '', at: serverTimestamp(), up: serverTimestamp(), ...extra,
});
async function createProfile(uid, h) {
  const f = db(uid);
  const b = writeBatch(f);
  b.set(doc(f, 'handles', h), { uid });
  b.set(doc(f, 'users', uid), { h, n: uid, ph: '', bio: '', sc: [], since: serverTimestamp(), up: serverTimestamp() });
  return b.commit();
}

await t('création de profil (pseudo + profil)', () => assertSucceeds(createProfile('alice', 'alice')));
await t('pseudo déjà pris refusé', () => assertFails(createProfile('bob', 'alice')));
await t('pseudo invalide refusé', () => assertFails(createProfile('bob', 'Bob!')));
await t('pseudo sans profil refusé', () => assertFails(setDoc(doc(db('bob'), 'handles', 'bobby'), { uid: 'bob' })));
await t('profil de bob', () => assertSucceeds(createProfile('bob', 'bob')));

const K = 'dz123456';
await t('note pendant la semaine de sortie', () => assertSucceeds(setDoc(doc(db('alice'), 'reviews', `${K}__alice`), review('alice', K, today, { tx: 'Très bon album.' }))));
await t('mauvaise semaine refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x1__alice`), review('alice', 'x1', today, { w: addDays(weekStart(today), -7) }))));
await t('sortie d’il y a 10 jours refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x2__alice`), review('alice', 'x2', addDays(today, -10)))));
await t('sortie pas encore sortie refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x3__alice`), review('alice', 'x3', addDays(today, 3)))));
await t('note 11 refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x4__alice`), review('alice', 'x4', today, { r: 11 }))));
await t('note 0 refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x5__alice`), review('alice', 'x5', today, { r: 0 }))));
await t('note en texte refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x6__alice`), review('alice', 'x6', today, { r: '5' }))));
await t('critique trop longue refusée', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x7__alice`), review('alice', 'x7', today, { tx: 'a'.repeat(3001) }))));
await t('champ inconnu refusé', () => assertFails(setDoc(doc(db('alice'), 'reviews', `x8__alice`), review('alice', 'x8', today, { admin: true }))));
await t('écrire au nom d’un autre refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `${K}__alice`), review('alice', K, today))));
await t('identifiant de document incohérent refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `autre__bob`), review('bob', K, today))));
await t('sans connexion refusé', () => assertFails(setDoc(doc(db(null), 'reviews', `${K}__anon`), review('anon', K, today))));
await t('lecture publique des notes', () => assertSucceeds(getDocs(query(collection(db(null), 'reviews'), where('k', '==', K)))));
await t('lecture publique d’un profil', () => assertSucceeds(getDoc(doc(db(null), 'users', 'alice'))));

const snap = await env.withSecurityRulesDisabled(async c => (await getDoc(doc(c.firestore(), 'reviews', `${K}__alice`))).data());
await t('modifier sa note pendant la semaine', () => assertSucceeds(setDoc(doc(db('alice'), 'reviews', `${K}__alice`), review('alice', K, today, { r: 9, at: snap.at }))));
await t('changer la date de création refusé', () => assertFails(setDoc(doc(db('alice'), 'reviews', `${K}__alice`), review('alice', K, today, { at: Timestamp.fromDate(new Date(2020, 0, 1)) }))));
await t('modifier la note d’un autre refusé', () => assertFails(updateDoc(doc(db('bob'), 'reviews', `${K}__alice`), { r: 2, up: serverTimestamp() })));

// une vieille note, écrite hors des règles pour le test
const OLD = addDays(today, -30);
await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'reviews', `old1__alice`), { ...review('alice', 'old1', OLD), at: Timestamp.fromDate(new Date(OLD)), up: Timestamp.fromDate(new Date(OLD)) }));
await t('vieille note : changer la note refusé', () => assertFails(updateDoc(doc(db('alice'), 'reviews', 'old1__alice'), { r: 2, up: serverTimestamp() })));
await t('vieille note : recopier le nouveau pseudo permis', () => assertSucceeds(updateDoc(doc(db('alice'), 'reviews', 'old1__alice'), { h: 'alice2', n: 'Alice', up: serverTimestamp() })));
await t('vieille note : supprimer permis', () => assertSucceeds(deleteDoc(doc(db('alice'), 'reviews', 'old1__alice'))));
await t('supprimer la note d’un autre refusé', () => assertFails(deleteDoc(doc(db('bob'), 'reviews', `${K}__alice`))));

await t('vitrine de 4 sorties', () => assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { sc: [1, 2, 3, 4].map(i => ({ k: `dz${i}`, t: 'T', a: 'A', img: '' })), up: serverTimestamp() })));
await t('vitrine de 5 sorties refusée', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { sc: [1, 2, 3, 4, 5].map(i => ({ k: `dz${i}` })), up: serverTimestamp() })));
await t('modifier le profil d’un autre refusé', () => assertFails(updateDoc(doc(db('bob'), 'users', 'alice'), { n: 'pirate', up: serverTimestamp() })));
await t('prendre le pseudo d’un autre dans son profil refusé', () => assertFails(updateDoc(doc(db('bob'), 'users', 'bob'), { h: 'alice', up: serverTimestamp() })));
await t('changer de pseudo', async () => {
  const f = db('alice');
  const b = writeBatch(f);
  b.set(doc(f, 'handles', 'alice2'), { uid: 'alice' });
  b.update(doc(f, 'users', 'alice'), { h: 'alice2', up: serverTimestamp() });
  b.delete(doc(f, 'handles', 'alice'));
  await assertSucceeds(b.commit());
});
await t('supprimer le pseudo d’un autre refusé', () => assertFails(deleteDoc(doc(db('alice'), 'handles', 'bob'))));
await t('supprimer son compte (profil + pseudo)', async () => {
  const f = db('alice');
  const b = writeBatch(f);
  b.delete(doc(f, 'reviews', `${K}__alice`));
  b.delete(doc(f, 'users', 'alice'));
  b.delete(doc(f, 'handles', 'alice2'));
  await assertSucceeds(b.commit());
});

await env.cleanup();
console.log(fails ? `\n${fails} test(s) en échec` : '\nToutes les règles se comportent comme prévu');
process.exit(fails ? 1 : 0);
