// Tests des règles Firestore sur l'émulateur (lancés par .github/workflows/rules.yml).
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, query, where, writeBatch, serverTimestamp, deleteField, Timestamp, documentId, limit } from 'firebase/firestore';

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

let snap; // withSecurityRulesDisabled ne renvoie pas le résultat du rappel
await env.withSecurityRulesDisabled(async c => { snap = (await getDoc(doc(c.firestore(), 'reviews', `${K}__alice`))).data(); });
await t('modifier sa note pendant la semaine', () => assertSucceeds(setDoc(doc(db('alice'), 'reviews', `${K}__alice`), review('alice', K, today, { r: 9, at: snap.at }))));
await t('changer la date de création refusé', () => assertFails(setDoc(doc(db('alice'), 'reviews', `${K}__alice`), review('alice', K, today, { at: Timestamp.fromDate(new Date(2020, 0, 1)) }))));
await t('modifier la note d’un autre refusé', () => assertFails(updateDoc(doc(db('bob'), 'reviews', `${K}__alice`), { r: 2, up: serverTimestamp() })));

// notes des sons (tr : un caractère par titre, 0 = pas de note, a = 10) et titres (tl)
const S = 'dz777';
const titles = ['Intro', 'Deux', 'Trois', 'Quatre'].join('\n');
await t('notes des sons sans note d’ensemble', () => assertSucceeds(setDoc(doc(db('bob'), 'reviews', `${S}__bob`), review('bob', S, today, { r: 0, tr: '80a', tl: titles }))));
await t('modifier les notes des sons (comme le site : updateDoc)', () => assertSucceeds(updateDoc(doc(db('bob'), 'reviews', `${S}__bob`), { tr: '80a5', up: serverTimestamp() })));
await t('ajouter la note d’ensemble et la critique', () => assertSucceeds(updateDoc(doc(db('bob'), 'reviews', `${S}__bob`), { r: 7, tx: 'Bon projet.', up: serverTimestamp() })));
await t('retirer la critique (deleteField)', () => assertSucceeds(updateDoc(doc(db('bob'), 'reviews', `${S}__bob`), { tx: deleteField(), up: serverTimestamp() })));
await t('retirer la note d’ensemble en gardant les sons', () => assertSucceeds(updateDoc(doc(db('bob'), 'reviews', `${S}__bob`), { r: 0, up: serverTimestamp() })));
await t('plus rien de noté refusé (il faut supprimer)', () => assertFails(updateDoc(doc(db('bob'), 'reviews', `${S}__bob`), { tr: deleteField(), tl: deleteField(), up: serverTimestamp() })));
await t('ni note ni son refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `y1__bob`), review('bob', 'y1', today, { r: 0 }))));
await t('sons tous à zéro refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `y2__bob`), review('bob', 'y2', today, { r: 0, tr: '000' }))));
await t('caractère inconnu dans les sons refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `y3__bob`), review('bob', 'y3', today, { r: 8, tr: '8b' }))));
await t('151 sons refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `y4__bob`), review('bob', 'y4', today, { r: 8, tr: '5'.repeat(151) }))));
await t('150 sons permis', () => assertSucceeds(setDoc(doc(db('bob'), 'reviews', `y5__bob`), review('bob', 'y5', today, { r: 8, tr: '5'.repeat(150) }))));
await t('sons en nombre refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `y6__bob`), review('bob', 'y6', today, { r: 8, tr: 85 }))));
await t('titres trop longs refusé', () => assertFails(setDoc(doc(db('bob'), 'reviews', `y7__bob`), review('bob', 'y7', today, { r: 0, tr: '9', tl: 'x'.repeat(8001) }))));
await t('single noté (rt single)', () => assertSucceeds(setDoc(doc(db('bob'), 'reviews', `y8__bob`), review('bob', 'y8', today, { rt: 'single' }))));
await t('deuxième écriture d’une note créée dans la séance (sans renvoyer at)', async () => {
  await assertSucceeds(setDoc(doc(db('bob'), 'reviews', `y9__bob`), review('bob', 'y9', today, { r: 6 })));
  await assertSucceeds(updateDoc(doc(db('bob'), 'reviews', `y9__bob`), { r: 9, up: serverTimestamp() }));
});

// une vieille note, écrite hors des règles pour le test
const OLD = addDays(today, -30);
await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'reviews', `old1__alice`), { ...review('alice', 'old1', OLD), at: Timestamp.fromDate(new Date(OLD)), up: Timestamp.fromDate(new Date(OLD)) }));
await t('vieille note : changer la note refusé', () => assertFails(updateDoc(doc(db('alice'), 'reviews', 'old1__alice'), { r: 2, up: serverTimestamp() })));
await t('vieille note : noter un son refusé', () => assertFails(updateDoc(doc(db('alice'), 'reviews', 'old1__alice'), { tr: '9', tl: 'Intro', up: serverTimestamp() })));
await t('vieille note : recopier le nouveau pseudo permis', () => assertSucceeds(updateDoc(doc(db('alice'), 'reviews', 'old1__alice'), { h: 'alice2', n: 'Alice', up: serverTimestamp() })));
await t('photo : recopiée sur une vieille note', () => assertSucceeds(updateDoc(doc(db('alice'), 'reviews', 'old1__alice'), { ph: `data:image/webp;base64,${'UklGR'.repeat(1200)}`, up: serverTimestamp() })));
await t('vieille note : supprimer permis', () => assertSucceeds(deleteDoc(doc(db('alice'), 'reviews', 'old1__alice'))));
await t('supprimer la note d’un autre refusé', () => assertFails(deleteDoc(doc(db('bob'), 'reviews', `${K}__alice`))));

await t('vitrine de 4 sorties', () => assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { sc: [1, 2, 3, 4].map(i => ({ k: `dz${i}`, t: 'T', a: 'A', img: '' })), up: serverTimestamp() })));
await t('vitrine de 5 sorties refusée', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { sc: [1, 2, 3, 4, 5].map(i => ({ k: `dz${i}` })), up: serverTimestamp() })));
await t('abonnements : s’abonner', () => assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { fr: ['bob'], up: serverTimestamp() })));
await t('abonnements : 301 abonnements refusé', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { fr: Array.from({ length: 301 }, (_, i) => `u${i}`), up: serverTimestamp() })));
await t('abonnements : liste au mauvais format refusée', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { fr: 'bob', up: serverTimestamp() })));
await t('abonnements : modifier les abonnements d’un autre refusé', () => assertFails(updateDoc(doc(db('bob'), 'users', 'alice'), { fr: [], up: serverTimestamp() })));
await t('abonnés : qui me suit (lecture publique)', () => assertSucceeds(getDocs(query(collection(db(null), 'users'), where('fr', 'array-contains', 'bob'), limit(1000)))));
await t('abonnements : profils par identifiants (lecture publique)', () => assertSucceeds(getDocs(query(collection(db(null), 'users'), where(documentId(), 'in', ['alice', 'bob'])))));
await t('recherche d’un pseudo par son début (lecture publique)', () => assertSucceeds(getDocs(query(collection(db(null), 'users'), where('h', '>=', 'al'), where('h', '<', 'al\uf8ff'), limit(10)))));
await t('fil des abonnements : notes de plusieurs membres pour une semaine', () => assertSucceeds(getDocs(query(collection(db('bob'), 'reviews'), where('uid', 'in', ['alice', 'carol']), where('w', '==', weekStart(today)), limit(500)))));
// photo de profil : petite image intégrée au profil et aux notes, grande image dans photos/{uid}
const PHS = `data:image/webp;base64,${'UklGR'.repeat(1200)}`;            // ~6 000 caractères
const PHB = `data:image/jpeg;base64,${'/9j/4A'.repeat(7000)}`;           // ~42 000 caractères
await t('photo : petite image dans son profil', () => assertSucceeds(updateDoc(doc(db('alice'), 'users', 'alice'), { ph: PHS, up: serverTimestamp() })));
await t('photo : adresse https (photo Google) permise', () => assertSucceeds(updateDoc(doc(db('bob'), 'users', 'bob'), { ph: 'https://lh3.googleusercontent.com/a/abc=s96-c', up: serverTimestamp() })));
await t('photo : retirer (vide) permis', () => assertSucceeds(updateDoc(doc(db('bob'), 'users', 'bob'), { ph: '', up: serverTimestamp() })));
await t('photo : trop lourde dans le profil refusée', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { ph: `data:image/webp;base64,${'A'.repeat(9000)}`, up: serverTimestamp() })));
await t('photo : adresse non https refusée', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { ph: 'javascript:alert(1)', up: serverTimestamp() })));
await t('photo : image d’un autre format refusée', () => assertFails(updateDoc(doc(db('alice'), 'users', 'alice'), { ph: 'data:image/svg+xml;base64,PHN2Zz4=', up: serverTimestamp() })));
await t('photo : recopiée sur une note pendant la semaine', () => assertSucceeds(updateDoc(doc(db('alice'), 'reviews', `${K}__alice`), { ph: PHS, up: serverTimestamp() })));
await t('photo : grande image enregistrée', () => assertSucceeds(setDoc(doc(db('alice'), 'photos', 'alice'), { d: PHB, up: serverTimestamp() })));
await t('photo : grande image lisible par tous', () => assertSucceeds(getDoc(doc(db(null), 'photos', 'alice'))));
await t('photo : grande image d’un autre refusée', () => assertFails(setDoc(doc(db('bob'), 'photos', 'alice'), { d: PHB, up: serverTimestamp() })));
await t('photo : grande image trop lourde refusée', () => assertFails(setDoc(doc(db('alice'), 'photos', 'alice'), { d: `data:image/jpeg;base64,${'A'.repeat(60001)}`, up: serverTimestamp() })));
await t('photo : champ inconnu refusé', () => assertFails(setDoc(doc(db('alice'), 'photos', 'alice'), { d: PHS, up: serverTimestamp(), x: 1 })));
await t('photo : supprimer la sienne', () => assertSucceeds(deleteDoc(doc(db('alice'), 'photos', 'alice'))));
await t('photo : supprimer celle d’un autre refusé', () => assertFails(deleteDoc(doc(db('bob'), 'photos', 'alice'))));
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
