#!/usr/bin/env node
// Robot de collecte d’À l’affût : sorties de la semaine, sorties annoncées, tracklists et featurings.
// Node 22, aucune dépendance. Lancé toutes les heures par GitHub Actions (voir .github/workflows/update.yml).
//
// Sources : Deezer (discographies, pré-sorties, artistes similaires), Apple Music (précommandes),
// MusicBrainz, Wikipédia (« Upcoming releases » des pages « 20xx in hip-hop ») et data/annonces.json.
// Le résultat précédent (déjà publié sur le site) sert de cache : chaque passage ne télécharge que le nouveau.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SITE = (process.env.SITE_URL || 'https://zvxltt.github.io/a-l-affut').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || 'site/data';
const UA = 'AlAffutBot/1.0 (+https://github.com/zvxltt/a-l-affut)';
const FAST = process.env.FAST === '1'; // tests hors ligne : pas d’attente entre les requêtes
const MIN = 60e3, HOUR = 36e5, DAY = 864e5;
const T0 = Date.now();
// au-delà, les étapes facultatives (Apple, MusicBrainz, presse) s’arrêtent pour que la publication passe toujours
const DEADLINE = T0 + (Number(process.env.BUDGET_MIN) || 38) * 60e3;
// découverte élargie (rap underground, petits artistes) ; DRY=1 : essai sans rien publier, avec le résumé de ce qui serait ajouté
const UG_ON = process.env.UG === '1';
const DRY = process.env.DRY === '1';
const UG_V = 1;   // changer ce numéro relance toutes les découvertes au passage suivant
const log =(...a) => console.log(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(4)} s]`, ...a);

/* ------------------------------------------------------------------ dates */
const parisYmd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = parisYmd(new Date());
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekStartOf = s => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7)); return d.toISOString().slice(0, 10); };
const HISTORY_FROM = addDays(weekStartOf(TODAY), -7 * 8);   // 8 semaines consultables
const FEATS_FROM = addDays(TODAY, -21);                      // crédits détaillés pour les 3 dernières semaines
const FUTURE_TO = addDays(TODAY, 420);
const YEAR = Number(TODAY.slice(0, 4));

/* ------------------------------------------------------------------ outils */
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uniqBy = (arr, f) => { const seen = new Set(); return arr.filter(x => { const k = f(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const baseTitle = s => String(s || '')
  .replace(/\s*[(\[][^)\]]*(deluxe|edition|édition|version|bonus|remaster|réédition|extended|explicit|clean|anniversary)[^)\]]*[)\]]/ig, '')
  .replace(/\s+-\s+(single|ep)$/i, '').trim();
const FEAT_PAREN = /\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|avec|with)\s+([^)\]]+?)\s*[)\]]/i;
const FEAT_TAIL = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
let KNOWN = new Set();
function splitNames(s) {
  const raw = String(s || '').trim();
  if (KNOWN.has(norm(raw))) return [raw];
  return raw.split(/\s*,\s*|\s+&\s+|\s+et\s+|\s+and\s+|\s+x\s+/i).map(x => x.trim()).filter(Boolean);
}
function splitFeat(title) {
  const s = String(title || '');
  let m = s.match(FEAT_PAREN);
  if (m) return { clean: s.replace(FEAT_PAREN, '').trim() || s, feats: splitNames(m[1]) };
  m = s.match(FEAT_TAIL);
  if (m) return { clean: s.replace(FEAT_TAIL, '').trim() || s, feats: splitNames(m[1]) };
  return { clean: s, feats: [] };
}
const FR_RE = /[éèêëàâùûçôîïœ]|\b(le|la|les|des|du|une?|et|est|pas|mon|ma|mes|ton|ta|tes|je|tu|il|elle|nous|vous|on|ce|ça|qui|que|pour|avec|sans|dans|sur|moi|toi|plus|tout|rien|jamais|vie|nuit|coeur|amour|frère|soleil|mal|bien|fou|folle)\b/i;
const EN_RE = /\b(the|you|your|my|me|i|im|it|is|in|on|of|and|love|baby|night|dont|cant|we|they|money|life|feel|girl|time|world|up|down|out)\b/i;
const ES_RE = /[ñáíóú¿¡]|\b(el|los|las|mi|para|una|del|por|como|corazón|noche|quiero|eres|vida|amor|baila|bebé|mami|papi|perreo|contigo|pero|todo|nada|soy|estoy|dime|ella|otra|vez|mucho)\b/i;

/* ------------------------------------------------------------------ réseau */
function limiter(perWindow, windowMs, conc) {
  const stamps = [], queue = [];
  let active = 0, timer = null;
  const pump = () => {
    timer = null;
    while (queue.length && active < conc) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > windowMs) stamps.shift();
      if (stamps.length >= perWindow) { timer = setTimeout(pump, windowMs - (now - stamps[0]) + 25); return; }
      const job = queue.shift();
      active++; stamps.push(now);
      Promise.resolve().then(job.fn).then(job.ok, job.ko).finally(() => { active--; if (!timer) pump(); });
    }
  };
  return fn => new Promise((ok, ko) => { queue.push({ fn, ok, ko }); if (!timer) pump(); });
}
const stats = { deezer: 0, deezerErrors: 0, apple: 0, musicbrainz: 0, wikipedia: 0 };

async function getJson(url, { timeout = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

const dzQueue = FAST ? limiter(1e6, 1000, 50) : limiter(40, 5200, 8);
class DzError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function dz(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let data;
    try { data = await dzQueue(() => getJson(`https://api.deezer.com${path}`)); stats.deezer++; }
    catch (e) { if (attempt >= 2) { stats.deezerErrors++; throw e; } await sleep(1500 * (attempt + 1)); continue; }
    if (data && data.error) {
      const code = data.error.code;
      if (code === 4 || code === 700) { await sleep(2500 * (attempt + 1)); continue; } // quota ou service occupé
      throw new DzError(code, data.error.message || 'Deezer');
    }
    return data;
  }
  stats.deezerErrors++;
  throw new Error(`Deezer indisponible : ${path}`);
}
function spaced(gapMs) {
  let last = 0;
  return async fn => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try { return await fn(); } finally { last = Date.now(); }
  };
}
const appleGap = spaced(FAST ? 0 : 3200);   // Apple : ~20 requêtes / minute
// Si un service refuse plusieurs fois de suite, on le laisse tranquille jusqu’au passage suivant.
let appleFails = 0, mbFails = 0;
async function apple(url) {
  if (appleFails >= 4 || Date.now() > DEADLINE) throw new Error('Apple suspendu pour ce passage');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const j = await appleGap(() => getJson(url, { timeout: 40000 })); stats.apple++; appleFails = 0; return j; }
    catch (e) { await sleep(FAST ? 0 : e.status === 403 || e.status === 429 ? 20000 : 4000); }
  }
  appleFails++;
  throw new Error('Apple indisponible');
}
const mbGap = spaced(FAST ? 0 : 1150);      // MusicBrainz : 1 requête / seconde
async function mb(url) {
  if (mbFails >= 4 || Date.now() > DEADLINE) throw new Error('MusicBrainz suspendu pour ce passage');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const j = await mbGap(() => getJson(url)); stats.musicbrainz++; mbFails = 0; return j; }
    catch (e) { await sleep(FAST ? 0 : 3000); }
  }
  mbFails++;
  throw new Error('MusicBrainz indisponible');
}
async function loadPrevious(name, fallback) {
  try { return await getJson(`${SITE}/data/${name}?t=${Date.now()}`, { timeout: 40000 }); }
  catch (e) { log(`pas de ${name} précédent (${e.message}) : on repart de zéro`); return fallback; }
}

/* ------------------------------------------------------------------ données de départ */
// Stars internationales qu’on ne veut pas suivre, même si elles apparaissent comme « similaires ».
const IGNORE = new Set([542, 4050205, 259, 564, 10583405, 12246, 1562681, 9635624, 160, 134790, 11152580, 429675, 7803478, 1424821, 92, 75491, 892, 13817211, 416239, 3469, 10600841, 5297021, 6890425, 384236, 163, 75798, 1001, 412, 14175163]);

async function loadSeeds() {
  const raw = await readFile('scripts/artists.txt', 'utf8');
  const itunes = JSON.parse(await readFile('scripts/itunes.json', 'utf8'));
  const seeds = {};
  for (const line of raw.trim().split('\n')) {
    const [id, cat, fans, name] = line.split('|');
    seeds[id] = { n: name, c: cat, f: Number(fans) || 0, src: 'seed', it: itunes[id] || 0 };
  }
  return seeds;
}
async function loadAnnonces() {
  try { return JSON.parse(await readFile('data/annonces.json', 'utf8')).items || []; }
  catch (e) { return []; }
}

/* ------------------------------------------------------------------ classement */
// rfr / rus / mfr : genre fixe ; fr : rap ou musique FR selon la sortie ; frx : découvert près d’artistes de variété.
// « International » = le top 150 France et les très grandes stars, pas les artistes croisés au hasard des voisinages
const minorInt = a => a.c === 'int' && !a.top && a.src !== 'seed' && (a.f || 0) < 2e6;
function catOf(a, genreId, genreName, title) {
  if (a.c === 'int') return minorInt(a) ? null : 'int';
  // petit artiste découvert autour du rap (ro) : ses sorties rangées dans un autre genre ne sont pas gardées
  if (a.ro && ((genreId > 0 && genreId !== 116) || (!(genreId > 0) && genreName && !/rap|hip/i.test(genreName)))) return null;
  if (a.c === 'rfr' || a.c === 'rus' || a.c === 'mfr') return a.c;
  const gid = genreId > 0 ? genreId : null;
  const known = gid != null || !!genreName;
  const rap = gid === 116 || /rap|hip/i.test(genreName || '');
  if (a.c === 'fr') return !known || rap ? 'rfr' : 'mfr';
  const t = String(title || '').replace(/'/g, '');
  if (rap) return EN_RE.test(t) && !FR_RE.test(t) ? 'rus' : 'rfr';
  return FR_RE.test(t) ? 'mfr' : null;
}
// Popularité « en France » pour l’ordre d’affichage : le top 150 France passe devant, l’international après.
function pop(a) {
  if (!a) return 0;
  const top = a.top ? 1 + (151 - a.top) / 50 : 1;   // n° 1 : ×4, n° 150 : ×1
  return (a.f || 0) * top * (a.c === 'int' ? 0.4 : 1);
}
// Sortie dont on ignore le genre (annonce presse, MusicBrainz) : on suit la discographie de l’artiste.
function leanCat(a) {
  if (a.c === 'int') return minorInt(a) ? null : 'int';
  if (a.c === 'rfr' || a.c === 'rus' || a.c === 'mfr') return a.c;
  if (typeof a.rp === 'number') return a.rp >= 50 ? 'rfr' : 'mfr';
  return 'mfr';
}

/* ------------------------------------------------------------------ découverte d’artistes */
// 1) Artistes « similaires » sur Deezer, sur deux niveaux (les artistes de départ, puis les plus suivis des découverts).
const isRapCat = c => c === 'rfr' || c === 'fr' || c === 'rus';
// en dessous de ces fans, un artiste découvert autour du rap n’apporte que ses sorties rap (ro)
const RAP_ONLY_FANS = { rfr: 10000, fr: 10000, rus: 60000 };
const roFor = (c, f) => (UG_ON && RAP_ONLY_FANS[c] && f < RAP_ONLY_FANS[c] ? { ro: 1 } : {});
async function discoverRelated(state) {
  const due = !state.relAt || Date.now() - state.relAt >= 6 * DAY || (UG_ON && state.relV !== UG_V);
  if (!due) return;
  const artists = state.artists;
  // points de départ : la liste de départ, les artistes très suivis et, avec la découverte élargie, tout le rap déjà suivi
  // à partir de 12 000 fans (60 000 en rap US) : leurs voisins font remonter la scène underground
  const base = Object.entries(artists)
    .filter(([, a]) => a.c !== 'int' && (a.src === 'seed' || a.f >= 120000 || (UG_ON && isRapCat(a.c) && a.f >= (a.c === 'rus' ? 60000 : 12000))))
    .sort((x, y) => (x[1].src === 'seed' ? -1 : 0) - (y[1].src === 'seed' ? -1 : 0) || y[1].f - x[1].f)
    .slice(0, UG_ON ? 2600 : 1200);
  log(`découverte : artistes similaires de ${base.length} artistes…`);
  const votes = new Map();
  await Promise.all(base.map(([id, s]) => dz(`/artist/${id}/related?limit=40`).then(res => {
    const cat = s.c === 'frx' ? 'mfr' : s.c;
    for (const r of res.data || []) {
      if (artists[r.id] || IGNORE.has(r.id)) continue;
      const v = votes.get(r.id) || { id: r.id, n: r.name, f: r.nb_fan || 0, cats: {} };
      v.cats[cat] = (v.cats[cat] || 0) + 1;
      v.f = r.nb_fan || v.f;
      votes.set(r.id, v);
    }
  }).catch(() => {})));
  let added = 0;
  const cands = [...votes.values()].map(v => {
    const total = Object.values(v.cats).reduce((a, b) => a + b, 0);
    const top = Object.entries(v.cats).sort((a, b) => b[1] - a[1])[0][0];
    return { ...v, total, top };
  }).sort((a, b) => b.total - a.total || b.f - a.f);
  for (const v of cands) {
    const cat = v.top === 'mfr' ? 'frx' : v.top;
    // découverte élargie : le rap FR jusqu’à 1 500 fans s’il est voisin d’au moins deux artistes suivis
    const minFans = UG_ON ? (cat === 'rus' ? 25000 : cat === 'frx' ? 40000 : cat === 'fr' ? 5000 : 1500) : (cat === 'rus' ? 60000 : cat === 'frx' ? 40000 : 10000);
    if (v.f < minFans) continue;
    if (v.total < 2 && v.f < (UG_ON && cat === 'rfr' ? 30000 : 250000)) continue;
    artists[v.id] = { n: v.n, c: cat, f: v.f, src: 'rel', it: 0, ...roFor(cat, v.f) };
    if (++added >= (UG_ON ? 4000 : 1500)) break;
  }
  state.relAt = Date.now();
  if (UG_ON) state.relV = UG_V;
  log(`découverte : ${added} artistes similaires ajoutés (${Object.keys(artists).length} suivis)`);
}

// 2) Catégories Wikipédia : rappeurs français, belges, suisses, québécois, chanteurs français, rappeurs américains.
// ug : seuil de la découverte élargie (rap underground) ; ugOnly : catégorie lue seulement avec elle
const WIKI_CATS = [
  { lang: 'fr', cat: 'Catégorie:Rappeur français', depth: 2, c: 'rfr', min: 8000, ug: 1500 },
  { lang: 'fr', cat: 'Catégorie:Rappeuse française', depth: 1, c: 'rfr', min: 8000, ug: 1500 },
  { lang: 'fr', cat: 'Catégorie:Groupe français de hip-hop', depth: 1, c: 'rfr', min: 8000, ug: 1500 },
  { lang: 'fr', cat: 'Catégorie:Rappeur belge', depth: 1, c: 'rfr', min: 8000, ug: 1500 },
  { lang: 'fr', cat: 'Catégorie:Rappeuse belge', depth: 1, c: 'rfr', min: 8000, ug: 1500 },
  { lang: 'fr', cat: 'Catégorie:Rappeur suisse', depth: 1, c: 'rfr', min: 8000, ug: 1500 },
  { lang: 'fr', cat: 'Catégorie:Rappeuse suisse', depth: 1, c: 'rfr', min: 8000, ug: 1500, ugOnly: true },
  { lang: 'fr', cat: 'Catégorie:Groupe belge de hip-hop', depth: 1, c: 'rfr', min: 8000, ug: 1500, ugOnly: true },
  { lang: 'fr', cat: 'Catégorie:Groupe suisse de hip-hop', depth: 1, c: 'rfr', min: 8000, ug: 1500, ugOnly: true },
  { lang: 'fr', cat: 'Catégorie:Rappeur québécois', depth: 1, c: 'rfr', min: 10000, ug: 3000 },
  { lang: 'fr', cat: 'Catégorie:Rappeuse québécoise', depth: 1, c: 'rfr', min: 10000, ug: 3000, ugOnly: true },
  { lang: 'fr', cat: 'Catégorie:Chanteuse française du XXIe siècle', depth: 0, c: 'fr', min: 50000 },
  { lang: 'fr', cat: 'Catégorie:Chanteur français du XXIe siècle', depth: 0, c: 'fr', min: 50000 },
  { lang: 'fr', cat: 'Catégorie:Auteur-compositeur-interprète français', depth: 0, c: 'fr', min: 50000 },
  { lang: 'fr', cat: 'Catégorie:Chanteuse française de pop', depth: 0, c: 'fr', min: 40000 },
  { lang: 'fr', cat: 'Catégorie:Chanteur français de pop', depth: 0, c: 'fr', min: 40000 },
  { lang: 'en', cat: 'Category:21st-century American rappers', depth: 1, c: 'rus', min: 60000, ug: 25000 },
  { lang: 'en', cat: 'Category:Underground rappers', depth: 0, c: 'rus', min: 60000, ug: 15000, ugOnly: true },
];
async function wikiCategoryMembers(lang, cat, depth) {
  const names = [];
  const queue = [[cat, 0]];
  const done = new Set();
  while (queue.length && names.length < 6000) {
    const [c, d] = queue.shift();
    if (done.has(c)) continue;
    done.add(c);
    let cont = '';
    do {
      const j = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(c)}&cmlimit=500&cmtype=page|subcat&format=json&formatversion=2${cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ''}`);
      stats.wikipedia++;
      for (const m of (j.query && j.query.categorymembers) || []) {
        if (m.ns === 14) { if (d < depth) queue.push([m.title, d + 1]); }
        else if (m.ns === 0) names.push(m.title.replace(/\s*\([^)]*\)\s*$/, '').trim());
      }
      cont = j.continue && j.continue.cmcontinue;
    } while (cont);
  }
  return names;
}
async function discoverWikiCategories(state) {
  state.searched = state.searched || {};
  if (UG_ON && state.catV !== UG_V) {
    // nouveaux seuils : les noms trouvés sur Deezer mais trop peu suivis jusqu’ici sont revérifiés
    // (les valeurs de « searched » sont des identifiants Deezer, 0, ou une date pour les noms tirés des annonces)
    for (const [k, v] of Object.entries(state.searched)) if (typeof v === 'number' && v > 0 && v < 1e11 && !state.artists[v]) delete state.searched[k];
    state.catPending = []; state.catAt = 0; state.catV = UG_V;
  }
  if (UG_ON && !DRY && Date.now() - T0 > 14 * MIN) { log('découverte Wikipédia : remise au passage suivant'); return; }
  let pending = state.catPending || [];
  if (!pending.length && (!state.catAt || Date.now() - state.catAt > 6 * DAY)) {
    for (const def of WIKI_CATS) {
      if (def.ugOnly && !UG_ON) continue;
      try {
        const names = await wikiCategoryMembers(def.lang, def.cat, def.depth);
        for (const n of names) pending.push([n, def.c, UG_ON && def.ug ? def.ug : def.min]);
      } catch (e) { log(`catégorie Wikipédia illisible : ${def.cat}`); }
    }
    state.catAt = Date.now();
  }
  if (!pending.length) return;
  const known = new Set(Object.values(state.artists).map(a => norm(a.n)));
  const seen = new Set();
  pending = pending.filter(([n]) => {
    const k = norm(n);
    if (!k || k.length < 2 || seen.has(k) || known.has(k) || state.searched[k] !== undefined) return false;
    seen.add(k);
    return true;
  });
  const batch = pending.slice(0, 2500);
  let added = 0;
  await Promise.all(batch.map(([name, c, min]) => dz(`/search/artist?limit=10&q=${encodeURIComponent(name)}`).then(res => {
    const m = (res.data || []).filter(a => norm(a.name) === norm(name)).sort((a, b) => b.nb_fan - a.nb_fan)[0];
    state.searched[norm(name)] = m ? m.id : 0;
    if (m && m.nb_fan >= min && !state.artists[m.id] && !IGNORE.has(m.id)) {
      state.artists[m.id] = { n: m.name, c, f: m.nb_fan, src: 'cat', it: 0, ...roFor(c, m.nb_fan) };
      added++;
    }
  }).catch(() => {})));
  state.catPending = pending.slice(2500);
  log(`découverte Wikipédia : ${batch.length} noms vérifiés, ${added} artistes ajoutés, ${state.catPending.length} restants`);
}

// 3) Liste de noms (scripts/underground.txt) : rap underground, indé, classiques, retrouvés sur Deezer par leur nom exact.
async function loadUnderground() {
  try {
    const raw = await readFile('scripts/underground.txt', 'utf8');
    return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split('|'))
      .filter(([n, c]) => n && (c === 'rfr' || c === 'rus'));
  } catch (e) { return []; }
}
async function discoverUnderground(state, list) {
  state.ug = state.ug || {};   // nom normalisé -> { id (0 : introuvable ou ambigu), t } ; relu au bout de 30 jours
  const known = new Set(Object.values(state.artists).map(a => norm(a.n)));
  const todo = uniqBy(list, ([n]) => norm(n)).filter(([n]) => {
    const k = norm(n), e = state.ug[k];
    if (!k || known.has(k)) return false;
    return !e || (Date.now() - e.t > 30 * DAY && !(e.id && state.artists[e.id]));
  }).slice(0, 400);
  if (!todo.length) return;
  let added = 0, unsure = 0;
  await Promise.all(todo.map(([name, c]) => dz(`/search/artist?limit=15&q=${encodeURIComponent(name)}`).then(res => {
    const ms = (res.data || []).filter(a => norm(a.name) === norm(name)).sort((a, b) => b.nb_fan - a.nb_fan);
    // deux homonymes de taille comparable : on ne devine pas
    const m = ms.length > 1 && ms[1].nb_fan > ms[0].nb_fan * 0.35 ? null : ms[0];
    if (!m && ms.length > 1) unsure++;
    state.ug[norm(name)] = { id: m ? m.id : 0, t: Date.now() };
    if (!m || state.artists[m.id] || IGNORE.has(m.id) || m.nb_fan < (c === 'rus' ? 1000 : 200)) return;
    state.artists[m.id] = { n: m.name, c, f: m.nb_fan, src: 'ug', it: 0, ...roFor(c, m.nb_fan) };
    added++;
  }).catch(() => {})));
  log(`découverte liste underground : ${todo.length} noms cherchés, ${added} artistes ajoutés${unsure ? `, ${unsure} homonymes écartés` : ''}`);
}

// 4) Playlists Deezer du rap underground et de la nouvelle scène : les artistes présents dans au moins deux playlists.
const PL_QUERIES = [
  ...['rap fr underground', 'rap français underground', 'underground rap français', 'rap underground fr', 'rap fr indé', 'rap indépendant',
    'nouvelle scène rap fr', 'nouvelle école rap fr', 'rap fr pépites', 'pépites rap', 'rap fr découvertes', 'rap fr à découvrir', 'rap fr fresh',
    'drill fr', 'trap fr', 'cloud rap fr', 'boom bap fr', 'rap conscient', 'rap fr old school', 'rap belge', 'rap suisse', 'rap québécois',
    'rap marseille', 'rap lyon', 'rap toulouse', 'rap lille'].map(q => [q, 'rfr']),
  ...['underground hip hop', 'underground rap', 'boom bap', 'rap us underground', 'abstract hip hop', 'jazz rap', 'plugg', 'rage rap'].map(q => [q, 'rus']),
];
async function discoverPlaylists(state) {
  const due = !state.plAt || Date.now() - state.plAt >= 6 * DAY || state.plV !== UG_V;
  if (!due) return;
  if (!DRY && Date.now() - T0 > 12 * MIN) { log('découverte playlists : remise au passage suivant'); return; }
  const artists = state.artists;
  const seenPl = new Set(), pls = [];
  await Promise.all(PL_QUERIES.map(([q, c]) => dz(`/search/playlist?limit=12&q=${encodeURIComponent(q)}`).then(res => {
    let n = 0;
    for (const p of res.data || []) {
      if (n >= 6 || seenPl.has(p.id) || (p.nb_tracks || 0) < 15) continue;
      seenPl.add(p.id); pls.push({ id: p.id, c }); n++;
    }
  }).catch(() => {})));
  const votes = new Map();
  await Promise.all(pls.map(p => dz(`/playlist/${p.id}/tracks?limit=400`).then(res => {
    const inThis = new Set();
    for (const t of res.data || []) {
      const ar = t && t.artist;
      if (!ar || !ar.id || inThis.has(ar.id)) continue;
      inThis.add(ar.id);
      if (artists[ar.id] || IGNORE.has(ar.id) || NOT_ARTIST.has(spacedNorm(ar.name))) continue;
      const v = votes.get(ar.id) || { id: ar.id, n: ar.name, pl: 0, cats: {} };
      v.pl++; v.cats[p.c] = (v.cats[p.c] || 0) + 1;
      votes.set(ar.id, v);
    }
  }).catch(() => {})));
  const cands = [...votes.values()].filter(v => v.pl >= 2).sort((a, b) => b.pl - a.pl).slice(0, 1500);
  let added = 0;
  await Promise.all(cands.map(v => dz(`/artist/${v.id}`).then(ar => {
    const c = (v.cats.rus || 0) > (v.cats.rfr || 0) ? 'rus' : 'rfr';
    const f = ar.nb_fan || 0;
    if (artists[v.id] || f < (c === 'rus' ? 5000 : 800)) return;
    artists[v.id] = { n: ar.name || v.n, c, f, src: 'pl', it: 0, ...roFor(c, f) };
    added++;
  }).catch(() => {})));
  state.plAt = Date.now(); state.plV = UG_V;
  log(`découverte playlists : ${pls.length} playlists, ${votes.size} artistes non suivis, ${cands.length} dans 2 playlists ou plus, ${added} ajoutés`);
}

// Les artistes cités dans les annonces Wikipédia sont ajoutés s’ils existent sur Deezer.
async function discoverFromNames(state, names) {
  const artists = state.artists;
  const byName = new Map(Object.entries(artists).map(([id, a]) => [norm(a.n), id]));
  state.searched = state.searched || {};
  const todo = uniqBy(names, norm).filter(n => !byName.has(norm(n)) && !state.searched[norm(n)]).slice(0, 80);
  let added = 0;
  await Promise.all(todo.map(name => dz(`/search/artist?limit=10&q=${encodeURIComponent(name)}`).then(res => {
    state.searched[norm(name)] = Date.now();
    const m = (res.data || []).filter(a => norm(a.name) === norm(name)).sort((a, b) => b.nb_fan - a.nb_fan)[0];
    if (m && m.nb_fan >= 25000 && !artists[m.id] && !IGNORE.has(m.id)) { artists[m.id] = { n: m.name, c: 'rus', f: m.nb_fan, src: 'wiki', it: 0 }; added++; }
  }).catch(() => {})));
  if (added) log(`découverte Wikipédia : ${added} artistes ajoutés`);
}

/* ------------------------------------------------------------------ Deezer */
// Artiste actif (sortie depuis moins de 5 mois ou sortie annoncée) : relu à chaque passage.
// Moins actif : toutes les 6 heures. En sommeil depuis plus de 16 mois : une fois par jour.
async function fetchDiscographies(state) {
  const artists = state.artists;
  state.disco = state.disco || {};
  const now = Date.now();
  const ids = Object.keys(artists);
  const out = new Map();
  const todo = [];
  // version des données dérivées (genre, langue des titres) : on relit tout une fois quand elle change
  const DISCO_V = 2, force = state.discoV !== DISCO_V;
  for (const id of ids) {
    const a = artists[id], e = state.disco[id];
    if (e && !force) {
      const age = a.last ? (Date.parse(TODAY) - Date.parse(a.last)) / DAY : 9999;
      const future = e.items.some(x => x.date > TODAY);
      const ttl = future || age <= 150 ? 0 : age <= 500 ? 6 * HOUR : 24 * HOUR;
      if (ttl && now - e.t < ttl) { out.set(id, e.items.filter(x => x.date >= HISTORY_FROM)); continue; }
    }
    todo.push(id);
  }
  let fails = 0;
  if (force) state.discoV = DISCO_V;
  await Promise.all(todo.map(id => dz(`/artist/${id}/albums?limit=1000`).then(res => {
    const items = [];
    let last = '', rap = 0, rnb = 0, known = 0, fr = 0, en = 0, es = 0;
    for (const x of res.data || []) {
      if (x.genre_id > 0) { known++; if (x.genre_id === 116) rap++; if (x.genre_id === 165) rnb++; }
      const t = String(x.title || '').replace(/'/g, '');
      const isEs = ES_RE.test(t), isFr = FR_RE.test(t) && !isEs, isEn = EN_RE.test(t);
      if (isEs) es++; else if (isFr && !isEn) fr++; else if (isEn && !isFr) en++;
      const d = x.release_date || '';
      if (!isYmd(d)) continue;
      if (d <= TODAY && d > last) last = d;
      if (d < HISTORY_FROM || d > FUTURE_TO) continue;
      items.push({ id: x.id, title: x.title, date: d, rt: x.record_type, genre: x.genre_id, md5: x.md5_image || '', fans: x.fans || 0, ex: x.explicit_lyrics ? 1 : 0 });
    }
    artists[id].last = last;
    const a = artists[id];
    if (known) { a.rp = Math.round((100 * rap) / known); a.rb = Math.round((100 * rnb) / known); }   // part de rap et de R&B
    if (fr + en + es >= 6) { a.lf = Math.round((100 * fr) / (fr + en + es)); a.ls = Math.round((100 * es) / (fr + en + es)); }   // titres en français, en espagnol
    // Le rap US, c’est du rap : la pop, le R&B ou le reggaeton rangés là par voisinage passent en International.
    // Un artiste du top France aux titres anglais passe en International, et inversement aux titres français.
    if (a.src !== 'seed') {
      if (a.c === 'rus' && ((known >= 3 && a.rp < 30) || a.ls >= 30)) a.c = 'int';
      const top = a.src === 'top' || a.top;
      if (top && a.c === 'fr' && typeof a.lf === 'number' && a.lf < 15) a.c = 'int';
      else if (top && a.c === 'int' && a.lf >= 60) a.c = 'fr';
    }
    state.disco[id] = { t: Date.now(), items };
    out.set(id, items);
  }).catch(e => {
    if (e instanceof DzError && e.code === 800) { state.disco[id] = { t: Date.now(), items: [] }; return; }
    fails++;
    if (state.disco[id]) out.set(id, state.disco[id].items.filter(x => x.date >= HISTORY_FROM));
  })));
  for (const id of Object.keys(state.disco)) if (!artists[id]) delete state.disco[id];
  log(`Deezer : ${todo.length} discographies relues sur ${ids.length} artistes (${fails} échecs)`);
  return { map: out, fails, total: todo.length };
}

// Essai (DRY=1) : ce que la découverte ajouterait, et les sorties que ces artistes apporteraient.
async function dryRunReport(state, before) {
  const added = Object.entries(state.artists).filter(([id]) => !before.has(id));
  const groups = {};
  for (const [id, a] of added) (groups[`${a.src}/${a.c}${a.ro ? '/ro' : ''}`] = groups[`${a.src}/${a.c}${a.ro ? '/ro' : ''}`] || []).push([id, a]);
  log(`ESSAI : ${added.length} artistes ajoutés (${before.size} → ${Object.keys(state.artists).length})`);
  for (const [g, list] of Object.entries(groups).sort((x, y) => y[1].length - x[1].length)) {
    list.sort((x, y) => y[1].f - x[1].f);
    const pick = list.length <= 60 ? list : [...list.slice(0, 45), ...list.slice(-15)];
    log(`  ${g} : ${list.length} — ${pick.map(([, a]) => `${a.n} (${a.f})`).join(', ')}`);
  }
  const sub = { artists: Object.fromEntries(added), disco: {}, discoV: 2 };
  const discos = await fetchDiscographies(sub);
  const rel = buildDeezerReleases(sub.artists, discos.map, {});
  const ws = weekStartOf(TODAY), we = addDays(ws, 6), lw = addDays(ws, -7);
  const count = list => { const o = {}; for (const r of list) o[`${r.cat}/${r.rt}`] = (o[`${r.cat}/${r.rt}`] || 0) + 1; return JSON.stringify(o); };
  const thisWeek = rel.filter(r => r.date >= ws && r.date <= we), lastWeek = rel.filter(r => r.date >= lw && r.date < ws), future = rel.filter(r => r.date > TODAY);
  log(`ESSAI : ${rel.length} sorties apportées ; cette semaine ${thisWeek.length} ${count(thisWeek)} ; semaine dernière ${lastWeek.length} ${count(lastWeek)} ; à venir ${future.length} ${count(future)}`);
  const active = Object.values(sub.artists).filter(a => a.last && (Date.parse(TODAY) - Date.parse(a.last)) / DAY <= 150).length;
  log(`ESSAI : ${active} de ces artistes ont sorti quelque chose depuis 5 mois (relus à chaque passage)`);
  log(`ESSAI : cette semaine — ${thisWeek.sort((a, b) => b.fans - a.fans).slice(0, 40).map(r => `${r.arts[0].n} – ${r.title} [${r.rt}/${r.cat}]`).join(' ; ')}`);
  log(`ESSAI : requêtes ${JSON.stringify(stats)}`);
}

function buildDeezerReleases(artists, discos, albums) {
  const map = new Map();
  for (const [id, items] of discos) {
    const a = artists[id];
    if (!a) continue;
    for (const x of items) {
      let r = map.get(x.id);
      if (!r) {
        const cat = catOf(a, x.genre, '', x.title);
        if (!cat) continue;
        r = { ...x, cat, arts: [] };
        map.set(x.id, r);
      }
      if (!r.arts.some(z => z.id === id)) r.arts.push({ id, ...a });
    }
  }
  // versions explicite et clean de la même sortie : on garde la meilleure
  const best = new Map();
  for (const r of map.values()) {
    r.arts.sort((x, y) => y.f - x.f);
    const k = `${r.arts.map(x => x.id).join(',')}|${norm(r.title)}|${r.date}`;
    const p = best.get(k);
    if (!p || (r.ex && !p.ex) || (r.ex === p.ex && r.fans > p.fans)) best.set(k, r);
  }
  return [...best.values()];
}

function albumMeta(alb) {
  const mains = (alb.contributors || []).filter(c => c.role === 'Main').map(c => c.name);
  if (!mains.length && alb.artist) mains.push(alb.artist.name);
  return {
    a: mains.join(' & '), n: alb.nb_tracks || 0, du: alb.duration || 0, lb: alb.label || '',
    g: ((alb.genres && alb.genres.data) || []).map(g => g.name).join(', '), t: Date.now(),
  };
}
async function fetchAlbumDetails(releases, state, details) {
  const todo = releases.filter(r => {
    const m = state.albums[r.id];
    if (!m) return true;
    if (r.date > TODAY) return Date.now() - m.t > 12 * HOUR;                  // pré-sortie : on suit les changements
    if (r.date >= addDays(TODAY, -2)) return Date.now() - m.t > 6 * HOUR;     // tout juste sortie
    return !details[`dz${r.id}`];
  }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 1200);
  let n = 0;
  await Promise.all(todo.map(r => dz(`/album/${r.id}`).then(async alb => {
    const meta = albumMeta(alb);
    let tracks = (alb.tracks && alb.tracks.data) || [];
    if ((alb.nb_tracks || 0) > tracks.length) {
      try { const more = await dz(`/album/${r.id}/tracks?limit=300`); if (more.data && more.data.length) tracks = more.data; } catch (e) { /* première page seulement */ }
    }
    const mains = new Set(meta.a.split(' & ').map(norm));
    const prev = details[`dz${r.id}`] || [];
    details[`dz${r.id}`] = tracks.map((t, i) => {
      const sp = splitFeat(t.title || '');
      const by = t.artist && !mains.has(norm(t.artist.name)) ? t.artist.name : '';
      const old = prev.find(p => p[6] === t.id);
      const feats = old && state.feats[r.id] ? old[2] : sp.feats.filter(f => !mains.has(norm(f)) && norm(f) !== norm(by));
      return [i + 1, sp.clean || t.title, feats, by, t.duration || 0, t.explicit_lyrics ? 1 : 0, t.id];
    });
    state.albums[r.id] = meta;
    n++;
  }).catch(() => {})));
  log(`Deezer : ${n} fiches d’album mises à jour`);
}
// Crédits exacts (artistes invités) titre par titre, pour les sorties récentes et à venir.
async function fetchTrackCredits(releases, state, details) {
  const fresh = v => v === 1 || (v > 1 && Date.now() - v < 12 * HOUR);
  const todo = releases.filter(r => r.date >= FEATS_FROM && !fresh(state.feats[r.id]) && details[`dz${r.id}`]);
  let budget = 3000, done = 0;
  for (const group of chunk(todo, 40)) {
    if (budget <= 0) break;
    await Promise.all(group.map(async r => {
      const rows = details[`dz${r.id}`].slice(0, 60);
      budget -= rows.length;
      const mains = new Set((state.albums[r.id] ? state.albums[r.id].a : '').split(' & ').map(norm));
      let ok = 0;
      await Promise.all(rows.map(row => dz(`/track/${row[6]}`).then(x => {
        ok++;
        const names = (x.contributors || [])
          .filter(c => c.role === 'Featured' || (c.role === 'Main' && !mains.has(norm(c.name))))
          .map(c => c.name).filter(nm => !mains.has(norm(nm)) && norm(nm) !== norm(row[3]));
        if (names.length) row[2] = uniqBy(names, norm);
      }).catch(() => {})));
      if (ok === rows.length) state.feats[r.id] = r.date <= TODAY ? 1 : Date.now();
      done++;
    }));
  }
  log(`Deezer : crédits détaillés pour ${done} sorties`);
}

/* ------------------------------------------------------------------ Apple Music */
// Identifiants Apple Music des artistes suivis : 70 recherches à chaque passage, les plus suivis d’abord.
async function appleIds(state) {
  const missing = Object.entries(state.artists).filter(([, a]) => !a.it && a.f >= 8000 && (!a.itT || Date.now() - a.itT > 30 * DAY))
    .sort((x, y) => y[1].f - x[1].f).slice(0, FAST ? 1000 : 70);
  let found = 0, tried = 0;
  for (const [, a] of missing) {
    if (Date.now() > DEADLINE) break;
    try {
      const j = await apple(`https://itunes.apple.com/search?entity=musicArtist&country=fr&limit=8&term=${encodeURIComponent(a.n)}`);
      const m = (j.results || []).find(x => norm(x.artistName) === norm(a.n));
      a.it = m ? m.artistId : 0;
      a.itT = Date.now();
      tried++;
      if (m) found++;
    } catch (e) { break; }   // Apple refuse : on reprendra au passage suivant
  }
  if (missing.length) log(`Apple Music : ${found} identifiants trouvés sur ${tried} artistes cherchés`);
}

async function appleStep(state, details) {
  const due = !state.apple || Date.now() - state.apple.t > 5.5 * HOUR;
  if (!due || Date.now() > DEADLINE) return;
  const artists = state.artists;
  // précommandes : sorties datées dans le futur
  const list = Object.entries(artists).filter(([, a]) => a.it).sort((x, y) => y[1].f - x[1].f);
  const byIt = new Map(list.map(([id, a]) => [a.it, { id, ...a }]));
  const items = [];
  const failed = new Set();
  let ok = 0;
  for (const group of chunk(list, 10)) {
    try {
      const j = await apple(`https://itunes.apple.com/lookup?entity=album&sort=recent&limit=60&country=fr&id=${group.map(([, a]) => a.it).join(',')}`);
      ok++;
      for (const x of j.results || []) {
        if (x.wrapperType !== 'collection' || !x.releaseDate) continue;
        const date = x.releaseDate.slice(0, 10);
        if (!isYmd(date) || date <= TODAY || date > FUTURE_TO) continue;
        const a = byIt.get(x.artistId);
        if (!a) continue;
        const name = x.collectionName || '';
        const rt = / - Single$/i.test(name) ? 'single' : / - EP$/i.test(name) ? 'ep' : (x.trackCount && x.trackCount <= 3 ? 'single' : 'album');
        items.push({
          id: x.collectionId, aid: a.id, title: name.replace(/ - (Single|EP)$/i, ''), artist: x.artistName, date, rt,
          n: x.trackCount || 0, ex: x.collectionExplicitness === 'explicit' ? 1 : 0, genre: x.primaryGenreName || '',
          cover: (x.artworkUrl100 || '').replace(/\/\d+x\d+bb\./, '/{s}x{s}bb.'), link: (x.collectionViewUrl || '').replace(/\?.*$/, ''),
          label: String(x.copyright || '').replace(/^[℗©]\s*\d{4}\s*/, ''),
        });
      }
    } catch (e) { for (const [id] of group) failed.add(id); }
  }
  // un groupe d’artistes resté sans réponse garde ses précommandes déjà connues
  const keep = ((state.apple && state.apple.items) || []).filter(x => failed.has(x.aid) && x.date > TODAY);
  const uniq = uniqBy([...items, ...keep], x => String(x.id));
  // tracklists connues des précommandes
  for (const group of chunk(uniq, 10)) {
    try {
      const j = await apple(`https://itunes.apple.com/lookup?entity=song&country=fr&limit=200&id=${group.map(x => x.id).join(',')}`);
      for (const it of group) {
        const tracks = (j.results || []).filter(t => t.wrapperType === 'track' && t.collectionId === it.id)
          .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
        const main = norm(it.artist);
        details[`it${it.id}`] = tracks.map((t, i) => {
          const sp = splitFeat(t.trackName || '');
          const by = norm(t.artistName) !== main ? t.artistName : '';
          return [t.trackNumber || i + 1, sp.clean, sp.feats, by, Math.round((t.trackTimeMillis || 0) / 1000), t.trackExplicitness === 'explicit' ? 1 : 0, 0, t.previewUrl || ''];
        });
      }
    } catch (e) { /* tracklist plus tard */ }
  }
  if (ok) state.apple = { t: Date.now(), items: uniq };
  log(`Apple Music : ${uniq.length} précommandes (${ok}/${chunk(list, 10).length} requêtes réussies)`);
}

/* ------------------------------------------------------------------ MusicBrainz */
async function musicbrainzStep(state, details) {
  const due = !state.mb || Date.now() - state.mb.t > 5.5 * HOUR;
  if (!due || Date.now() > DEADLINE) return;
  const list = Object.entries(state.artists).sort((x, y) => y[1].f - x[1].f);
  const byName = new Map(list.map(([id, a]) => [norm(a.n), { id, ...a }]));
  const from = addDays(TODAY, 1);
  const items = [];
  const failed = new Set();
  let ok = 0;
  for (const group of chunk(list, 25)) {
    const q = `firstreleasedate:[${from} TO ${FUTURE_TO}] AND (${group.map(([, a]) => `artist:"${a.n.replace(/["\\]/g, '\\$&')}"`).join(' OR ')})`;
    try {
      const j = await mb(`https://musicbrainz.org/ws/2/release-group?fmt=json&limit=100&query=${encodeURIComponent(q)}`);
      ok++;
      for (const g of j['release-groups'] || []) {
        const date = g['first-release-date'] || '';
        if (!isYmd(date) || date <= TODAY) continue;
        const credit = g['artist-credit'] || [];
        const names = credit.map(c => c.name || (c.artist && c.artist.name) || '');
        const a = names.map(n => byName.get(norm(n))).find(Boolean);
        if (!a) continue;
        const type = String(g['primary-type'] || '').toLowerCase();
        items.push({ id: g.id, aid: a.id, title: g.title, date, rt: type === 'single' ? 'single' : type === 'ep' ? 'ep' : 'album', artist: credit.map((c, k) => names[k] + (c.joinphrase || '')).join('').trim() });
      }
    } catch (e) { for (const [id] of group) failed.add(id); }
  }
  const keep = ((state.mb && state.mb.items) || []).filter(x => failed.has(x.aid) && x.date > TODAY);
  const uniq = uniqBy([...items, ...keep], x => x.id);
  let n = 0;
  for (const it of uniq) {
    if (details[`mb${it.id}`] || n >= 40) continue;
    try {
      const j = await mb(`https://musicbrainz.org/ws/2/release?release-group=${it.id}&inc=recordings+artist-credits+labels&fmt=json&limit=10`);
      const size = rel => (rel.media || []).reduce((s, m) => s + (m['track-count'] || 0), 0);
      const rel = (j.releases || []).sort((a, b) => size(b) - size(a))[0];
      if (rel) {
        const mains = new Set((rel['artist-credit'] || []).map(c => norm(c.name)));
        details[`mb${it.id}`] = (rel.media || []).flatMap(m => m.tracks || []).map((t, i) => {
          const sp = splitFeat(t.title || '');
          const credit = (t['artist-credit'] || []).map(c => c.name).filter(nm => !mains.has(norm(nm)));
          return [i + 1, sp.clean, uniqBy([...credit, ...sp.feats], norm), '', Math.round((t.length || 0) / 1000), 0, 0];
        });
        const li = (rel['label-info'] || []).find(x => x.label);
        if (li) it.label = li.label.name;
      }
      n++;
    } catch (e) { /* plus tard */ }
  }
  if (ok) state.mb = { t: Date.now(), items: uniq };
  log(`MusicBrainz : ${uniq.length} sorties annoncées`);
}

/* ------------------------------------------------------------------ Wikipédia */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function cleanWiki(s) {
  return String(s || '')
    .replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\{\{\s*(?:TBA|tba|TBD)\s*\}\}/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/'{2,}/g, '').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
export function parseWikiUpcoming(wikitext, year) {
  const a = wikitext.indexOf('== Upcoming releases ==');
  if (a < 0) return [];
  const rest = '\n' + wikitext.slice(a + 23);
  const end = rest.search(/\n==[^=]/);
  const sec = end > 0 ? rest.slice(0, end) : rest;
  const parts = sec.split(/\n===\s*([^=\n]+?)\s*===/);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const m = MONTHS.indexOf(parts[i].trim().toLowerCase());
    if (m < 0) continue; // « Unscheduled and TBA » : pas de date
    let day = null;
    for (const row of parts[i + 1].split(/\n\|-/).slice(1)) {
      const cells = [];
      for (const line of row.split('\n')) {
        if (!line.startsWith('|') || line.startsWith('|}') || line.startsWith('|-') || line.startsWith('|+')) continue;
        for (const c of line.slice(1).split('||')) cells.push(c.replace(/^\s*(?:[a-z-]+\s*=\s*"[^"]*"\s*)+\|(?!\|)/i, '').trim());
      }
      let artist, album;
      if (cells.length >= 5) { day = parseInt(cleanWiki(cells[0]), 10); [artist, album] = [cells[1], cells[2]]; }
      else if (cells.length === 4) { [artist, album] = [cells[0], cells[1]]; }
      else continue;
      if (!day || day < 1 || day > 31) continue;
      artist = cleanWiki(artist);
      album = cleanWiki(album);
      if (!artist) continue;
      out.push({ artist: /^various artists$/i.test(artist) ? 'Divers artistes' : artist, title: album || 'Titre à venir', date: `${year}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}` });
    }
  }
  return out;
}
async function wikipediaStep(state) {
  const due = !state.wiki || Date.now() - state.wiki.t > 3 * HOUR;
  if (!due) return;
  const items = [];
  let ok = 0;
  for (const year of [YEAR, YEAR + 1]) {
    try {
      const j = await getJson(`https://en.wikipedia.org/w/api.php?action=parse&page=${year}_in_hip-hop&prop=wikitext&format=json&formatversion=2&redirects=1`);
      stats.wikipedia++;
      if (j.parse && j.parse.wikitext) { items.push(...parseWikiUpcoming(j.parse.wikitext, year)); ok++; }
    } catch (e) { /* page absente */ }
  }
  if (ok) state.wiki = { t: Date.now(), items: items.filter(x => x.date > TODAY && x.date <= FUTURE_TO) };
  log(`Wikipédia : ${state.wiki ? state.wiki.items.length : 0} sorties annoncées`);
}


/* ------------------------------------------------------------------ presse */
// Les annonces faites sur Instagram sont reprises par les médias : le robot lit Google Actualités et les flux
// des médias rap, et repère les titres du type « X annonce son album pour le 4 décembre ».
// L’artiste retenu est le sujet de la phrase, celui qui annonce, jamais un nom cité en passant :
// « Star Academy : Léa Doffey annonce son album » concerne Léa Doffey, et dans « Morphine annonce l’album Cocoon »,
// Cocoon est un titre, pas l’artiste du même nom. Un sujet que le robot ne suit pas encore est vérifié sur Deezer
// et ajouté s’il est proche des artistes suivis.
const FEEDS = [
  'https://raplume.eu/feed/', 'https://www.rapunchline.fr/feed/', 'https://www.hiphopcorner.fr/feed/', 'https://www.reaphit.com/feed/',
  'https://lerapcetaitmieuxavant.fr/feed/', 'https://www.booska-p.com/feed/', 'https://www.abcdrduson.com/feed/', 'https://www.lerapenfrance.fr/feed/',
  'https://www.xxlmag.com/feed/', 'https://www.rap-up.com/feed/', 'https://hiphopdx.com/rss/news.xml', 'https://www.hotnewhiphop.com/rss.xml',
];
const GN_FR = ['"annonce son nouvel album"', '"annonce son album"', '"nouvel album" "date de sortie"', '"date de sortie" album rappeur', '"nouvel EP"',
  'mixtape "date de sortie"', 'album "sortira le"', 'album "prévu le" rap', '"premier album" "date de sortie"', 'rappeuse album "sortie"',
  'chanteuse "nouvel album" "sortira"', 'chanteur "nouvel album" "sortira"', 'album "attendu le"'];
const GN_EN = ['rapper announces new album release date', '"new album" "release date" rapper', 'announces album "out" hip-hop', 'mixtape "release date" rapper'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_FR = /\b(\d{1,2})(?:er)?\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)(?:\s+(20\d\d))?\b/gi;
const DATE_EN = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/gi;
const REL_FR = /\b(albums?|eps?|mixtapes?|tapes?|projets?|opus|disques?|singles?|titres?|morceaux?|morceau|réédition)\b/i;
const ACT_FR = /\b(annonc\w*|sort\w*|para[iî]t\w*|prévu\w*|attendu\w*|dévoil\w*|disponible|arriv\w*|débarqu\w*|dates?|précommande\w*|rendez-vous)\b/i;
const REL_EN = /\b(albums?|eps?|mixtapes?|tapes?|projects?|lps?|singles?|deluxe)\b/i;
const ACT_EN = /\b(announc\w*|releas\w*|drop\w*|arriv\w*|due|set for|coming|out|dates?)\b/i;
const NOPE = /\b(concert\w*|tourn[ée]e|zénith|zenith|stade|olympia|accor arena|bercy|billet\w*|festival|spectacle|showcase|documentaire|film|série|livre|exposition|procès|tribunal|tour|tickets|arena|documentary|movie|book|lawsuit|court|arrest\w*|certifi\w*|disque d['’]or|platine|anniversaire|birthday)\b/i;
// noms qui sont aussi des mots courants : on exige la majuscule et des limites de mot
const COMMON = new Set(['future', 'logic', 'pomme', 'santa', 'offset', 'marine', 'ambre', 'helena', 'kalash', 'vegedream', 'naza', 'drake',
  'cocoon', 'common', 'soprano', 'gold', 'indochine', 'phoenix', 'justice', 'eden', 'genesis', 'nirvana', 'sniper', 'scylla', 'luidji']);
// jamais retenus comme artiste d’une annonce (émissions, compilations)
const NOT_ARTIST = new Set(['star academy', 'various artists', 'divers artistes', 'artistes divers', 'multi interpretes', 'the voice',
  'nouvelle star', 'popstars', 'compilation', 'soundtrack', 'original soundtrack']);
// sujets de phrase qui ne sont pas des artistes
const NOT_SUBJECT = new Set(['netflix', 'spotify', 'deezer', 'apple', 'apple music', 'youtube', 'tiktok', 'instagram', 'twitch', 'google',
  'universal', 'universal music', 'sony', 'sony music', 'warner', 'warner music', 'fnac', 'amazon', 'tf1', 'm6', 'nrj', 'skyrock', 'mouv',
  'france', 'paris', 'marseille', 'lyon', 'belgique', 'quebec', 'grammy', 'grammys', 'victoires', 'sacem', 'snep', 'billboard', 'complex',
  'xxl', 'pitchfork', 'booska p', 'hip hop', 'rap us', 'rap fr', 'rap francais', 'star academy', 'the voice']);
// mots qui ne font pas partie d’un nom d’artiste en tête de phrase
const CAP_STOP = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'son', 'sa', 'ses', 'leur', 'leurs', 'ce', 'cette', 'ces',
  'cet', 'il', 'elle', 'ils', 'elles', 'on', 'the', 'a', 'an', 'his', 'her', 'their', 'its', 'he', 'she', 'they', 'it', 'we', 'you', 'i', 'new',
  'nouvel', 'nouveau', 'nouvelle', 'album', 'albums', 'ep', 'mixtape', 'single', 'projet', 'rap', 'rappeur', 'rappeuse', 'chanteur', 'chanteuse',
  'artiste', 'groupe', 'duo', 'exclu', 'exclusif', 'officiel', 'officiellement', 'apres', 'avant', 'enfin', 'deja', 'voici', 'voila', 'info',
  'infos', 'news', 'breaking', 'watch', 'listen', 'video', 'clip', 'audio', 'live', 'interview', 'premier', 'premiere', 'dernier', 'derniere',
  'surprise', 'fans', 'us', 'fr', 'francais', 'francaise', 'americain', 'legende', 'icone', 'pourquoi', 'comment', 'quand', 'qui', 'that',
  'this', 'after', 'before', 'finally', 'officially', 'report', 'reportedly', 'rapper', 'singer', 'producer', 'hip', 'hop', 'r', 'b', 'update',
  'official', 'debut', 'first', 'last', 'latest', 'star', 'academy', 'mais', 'et', 'ou', 'and', 'or', 'but', 'so', 'now', 'today', 'tonight',
  'musique', 'music', 'culture', 'actu', 'actualite', 'people', 'media', 'medias', 'tele', 'tv', 'cinema', 'sortie', 'sorties', 'nouveautes',
  'hits', 'playlist', 'classement', 'top', 'charts', 'chart', 'concert', 'concerts', 'soiree', 'emission', 'jeu', 'gta']);
const spacedNorm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// guillemets appariés : « … », “ … ”, " … ", ‘ … ’ et ' … ' (une apostrophe dans un mot ne ferme rien)
const QUOTE_RE = /«\s*([^»]{1,80}?)\s*»|“\s*([^”]{1,80}?)\s*”|"\s*([^"]{1,80}?)\s*"|‘\s*(.{1,80}?)\s*’(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])'(.{1,60}?)'(?![\p{L}\p{N}])/gu;
const QUOTE_DESC = /(?:album|EP|mixtape|projet|opus|LP|tape)(?:\s+[\p{L}’'-]+){0,3}?\s*(?:intitulé|baptisé|titled|called|,)?\s*[«“"‘]\s*([^»”"’]{1,80}?)\s*[»”"’]/iu;
function quotedIn(s) {
  const str = String(s || '');
  for (const m of str.matchAll(QUOTE_RE)) {
    const q = (m[1] || m[2] || m[3] || m[4] || m[5] || '').trim();
    const k = spacedNorm(q);
    if (!k || NOT_ARTIST.has(k) || NOT_SUBJECT.has(k) || GENERIC_TITLE.has(k)) continue;
    if (!str.slice(0, m.index).trim() && /^\s*:/.test(str.slice(m.index + m[0].length))) continue;   // étiquette de tête
    return q;
  }
  return '';
}
const maskQuotes = s => String(s || '').replace(QUOTE_RE, m => ' '.repeat(m.length));
const VERB_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[
  'annonc(?:e|ent|era|eront)', 'd[ée]voil(?:e|ent|era)', 'sort(?:ent|ira|iront)?', 'revien(?:t|nent|dra)', 'pr[ée]par(?:e|ent)',
  'teas(?:e|es|ent|ed)', 'officialis(?:e|ent)', 'livr(?:e|ent|era)', 'pr[ée]sent(?:e|ent)', 'partag(?:e|ent)', 'confirm(?:e|ent|s|ed)',
  'publi(?:e|ent|era)', 'lanc(?:e|ent)', 'd[ée]gain(?:e|ent)', 'l[âa]ch(?:e|ent)', 'balanc(?:e|ent)', 'arriv(?:e|es|ent|ing)', 'd[ée]barqu(?:e|ent)',
  'est de retour', 'sont de retour', 'fait son retour', 'font leur retour', 'signe son retour',
  'announc(?:e|es|ed|ing)', 'unveil(?:s|ed|ing)?', 'reveal(?:s|ed|ing)?', 'shar(?:e|es|ed|ing)', 'drop(?:s|ped|ping)?', 'releas(?:e|es|ed|ing)',
  'sets?', 'detail(?:s|ed)', 'return(?:s|ed|ing)?', 'read(?:ies|ying)', 'preps?', 'deliver(?:s|ed)?', 'plans?', 'is back', 'are back',
].join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const SEP_RE = /\s[-–—]\s|[:|–—,;!?()[\]«»“”"]/g;
// mots mis entre guillemets qui ne sont pas des titres : un « premier » album, un album « surprise »…
const GENERIC_TITLE = new Set(['premier', 'premiere', 'dernier', 'derniere', 'nouveau', 'nouvel', 'nouvelle', 'ultime', 'vrai', 'grand',
  'retour', 'surprise', 'final', 'debut', 'first', 'last', 'new', 'surprise album', 'album surprise', 'deluxe', 'live']);
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function cleanOutlet(s) {
  const t = String(s || '').trim();
  if (!/^https?:\/\//i.test(t)) return t;
  try { return new URL(t).hostname.replace(/^www\./, ''); } catch (e) { return t; }
}
function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const tag = t => { const x = block.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i')); return x ? decodeEntities(x[1]).trim() : ''; };
    const strip = h => decodeEntities(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let title = strip(tag('title'));
    const source = strip(tag('source'));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    items.push({ title, desc: strip(tag('description')).slice(0, 400), link: tag('link'), pub: Date.parse(tag('pubDate')) || Date.now(), outlet: cleanOutlet(source) });
  }
  return items;
}
async function getText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: ctl.signal });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.text();
  } finally { clearTimeout(t); }
}
function makeMatchers(artists) {
  const byFirst = new Map();
  for (const [id, a] of Object.entries(artists)) {
    const key = spacedNorm(a.n);
    if (!key || key.length < 2 || NOT_ARTIST.has(key)) continue;
    if (a.ro && !key.includes(' ') && key.length <= 6) continue;   // petit artiste au nom court : trop de faux positifs
    const strict = key.replace(/ /g, '').length <= 5 || COMMON.has(key);
    const m = { id, a, key, strict, re: strict ? new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(a.n)}(?=$|[^\\p{L}\\p{N}])`, 'u') : null };
    const first = key.split(' ')[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push(m);
  }
  return byFirst;
}
// Rôle d’un nom dans la phrase : « l’album inédit Cocoon », « album intitulé Gold » → titre ;
// « avec Gazo », « feat. Tiakola » → invité. Dans les deux cas ce n’est pas l’artiste qui annonce.
const TITLE_MARK = new Set(['album', 'albums', 'ep', 'mixtape', 'tape', 'projet', 'opus', 'disque', 'single', 'titre', 'morceau', 'lp',
  'record', 'intitule', 'intitulee', 'baptise', 'baptisee', 'titled', 'called', 'nomme', 'nommee', 'extrait', 'track', 'chanson', 'clip', 'song']);
const FEAT_MARK = new Set(['avec', 'with', 'feat', 'ft', 'featuring', 'invite', 'invites', 'convie']);
const POSS = new Set(['de', 'd', 'du', 'des', 'of', 'from', 'by', 'par']);
function roleAt(words, i) {
  if (i > 0 && FEAT_MARK.has(words[i - 1])) return 'feat';
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    if (POSS.has(words[j])) return null;
    if (TITLE_MARK.has(words[j])) return 'title';
  }
  return null;
}
// artistes suivis présents dans le texte, avec leur position (en mots) et leur rôle
function artistHits(text, byFirst) {
  const words = spacedNorm(text).split(' ').filter(Boolean);
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    for (const m of byFirst.get(words[i]) || []) {
      const len = m.key.split(' ').length;
      if (words.slice(i, i + len).join(' ') !== m.key || (m.strict && !m.re.test(text))) continue;
      hits.push({ m, i, end: i + len, role: roleAt(words, i) });
    }
  }
  return { words, hits };
}
// artiste sujet le plus tôt dans le texte (le plus long à égalité)
function findArtist(text, byFirst) {
  let best = null;
  for (const h of artistHits(text, byFirst).hits) {
    if (!h.role && (!best || h.i < best.i || (h.i === best.i && h.end > best.end))) best = h;
  }
  return best ? best.m : null;
}
// artiste qui termine le texte, juste avant le verbe (« Tyler, The Creator annonce »)
function artistAtEnd(text, byFirst) {
  const { words, hits } = artistHits(text, byFirst);
  let best = null;
  for (const h of hits) if (!h.role && h.end === words.length && (!best || h.i < best.i)) best = h;
  return best ? best.m : null;
}
// artiste en tête du titre, ou complément du nom : « l’album de X », « X’s new album »
function artistAnchored(text, byFirst) {
  const { words, hits } = artistHits(text, byFirst);
  let best = null;
  for (const h of hits) {
    if (h.role) continue;
    const ok = h.i === 0 || POSS.has(words[h.i - 1]) || words[h.end] === 's';
    if (ok && (!best || h.i < best.i)) best = h;
  }
  return best ? best.m : null;
}
// nom propre qui précède le verbe : suite de mots à majuscule, sans « Le rappeur », « Exclu »…,
// et qui n’est ni un titre (« l’album Cocoon ») ni un invité (« avec Gazo »)
function nameLike(clause) {
  const toks = String(clause || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 8) return null;
  const run = [];
  let i = toks.length - 1;
  for (; i >= 0; i--) {
    const t = toks[i];
    const plain = spacedNorm(t);
    if (!plain || CAP_STOP.has(plain) || !/^[\p{Lu}\p{N}$]/u.test(t)) break;
    run.unshift(t);
  }
  if (!run.length) return null;
  const before = toks.slice(Math.max(0, i - 2), i + 1).map(t => spacedNorm(t)).join(' ').split(' ').filter(Boolean);
  if (before.length && roleAt([...before, '?'], before.length)) return null;
  const name = run.join(' ').replace(/[’']s$/i, '').trim();
  const plain = spacedNorm(name);
  if (name.length < 2 || name.length > 40 || /^\d+$/.test(name) || NOT_SUBJECT.has(plain)) return null;
  if (!plain.includes(' ') && plain.length < 5) return null;   // « Léa » seul : trop vague
  return name;
}
// un artiste suivi trouvé dans un nom plus long (« Nas » dans « Lil Nas X ») n’est pas le sujet
function resolveIn(text, byFirst) {
  const a = findArtist(text, byFirst);
  const name = nameLike(text);
  if (a) {
    const nk = name ? spacedNorm(name) : '';
    if (nk && nk !== a.key && ` ${nk} `.includes(` ${a.key} `)) return { unknown: name };
    return { artist: a };
  }
  return name ? { unknown: name } : null;
}
function subjectOf(title, byFirst) {
  const masked = maskQuotes(title);
  const v = VERB_RE.exec(masked);
  if (v) {
    const pre = masked.slice(0, v.index).replace(/\s+$/, '');
    let cut = 0;
    for (const m of pre.matchAll(SEP_RE)) cut = m.index + m[0].length;
    const clause = pre.slice(cut).trim();
    const r = clause ? resolveIn(clause, byFirst) : null;
    if (r && r.artist) return r;
    const end = artistAtEnd(pre, byFirst);
    if (end) return { artist: end };
    if (r && r.unknown) return r;
  }
  // sujet sous-entendu : « Ninho : son album sort le 5 décembre »
  let unknown = null;
  const head = masked.search(/\s[-–—|]\s|:/);
  if (head > 0) {
    const r = resolveIn(masked.slice(0, head), byFirst);
    if (r && r.artist) return r;
    unknown = r;
  }
  const a = artistAnchored(masked, byFirst);
  return a ? { artist: a } : unknown;
}
function findDate(text, pub) {
  const found = [];
  for (const re of [DATE_FR, DATE_EN]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      let day, mon, year;
      if (re === DATE_FR) { day = +m[1]; mon = MONTH[norm(m[2])]; year = m[3] ? +m[3] : 0; }
      else { mon = MONTH[norm(m[1])]; day = +m[2]; year = m[3] ? +m[3] : 0; }
      if (!mon || day < 1 || day > 31) continue;
      const p = new Date(pub);
      if (!year) {
        year = p.getUTCFullYear();
        if (Date.UTC(year, mon - 1, day) < pub - 10 * DAY) year++;
      }
      const date = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const win = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 40);
      // « album le 5 février, et un concert le 9 » : le concert qui suit ne disqualifie pas l’album
      const near = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 12);
      found.push({ date, win, near, fr: re === DATE_FR });
    }
  }
  return found;
}
function extractAnnouncement(item, byFirst) {
  const subj = subjectOf(item.title, byFirst);
  if (!subj) return null;
  const text = `${item.title} — ${item.desc || ''}`;
  let pick = null;
  for (const d of findDate(text, item.pub)) {
    if (d.date <= TODAY || d.date > addDays(TODAY, 240)) continue;
    const rel = d.fr ? REL_FR : REL_EN, act = d.fr ? ACT_FR : ACT_EN;
    if (!rel.test(d.win) || !act.test(d.win) || NOPE.test(d.near)) continue;
    pick = d;
    break;
  }
  if (!pick) return null;
  const who = subj.artist ? subj.artist.a.n : subj.unknown;
  let title = quotedIn(item.title);
  if (!title) { const qd = String(item.desc || '').match(QUOTE_DESC); title = qd ? qd[1].trim() : ''; }
  if (title && (norm(title) === norm(who) || GENERIC_TITLE.has(spacedNorm(title)) || title.split(/\s+/).length > 9
    || /\d{1,2}(er)?\s+(janv|f[ée]v|mars|avr|mai|juin|juil|ao[uû]|sept|oct|nov|d[ée]c)/i.test(title))) title = '';
  const quoted = !!title;
  const ctx = pick.win;
  const rt = /\bEP\b/.test(ctx) || /\bEP\b/.test(item.title) ? 'ep'
    : /\b(single|titre|morceau)\b/i.test(ctx) && !/\b(album|mixtape|projet|project)\b/i.test(ctx) ? 'single' : 'album';
  const mixtape = /mixtape|\btape\b/i.test(ctx);
  if (!title) title = rt === 'ep' ? 'Nouvel EP' : rt === 'single' ? 'Nouveau single' : mixtape ? 'Nouvelle mixtape' : 'Nouvel album';
  let outlet = cleanOutlet(item.outlet);
  if (!outlet) { try { outlet = new URL(item.link).hostname.replace(/^www\./, ''); } catch (e) { outlet = ''; } }
  const base = { title, quoted, date: pick.date, rt, link: item.link, outlet, pub: item.pub, lang: pick.fr ? 'fr' : 'en', h: item.title };
  return subj.artist ? { aid: subj.artist.id, artist: subj.artist.a.n, ...base } : { unknown: subj.unknown, ...base };
}
// Sujets inconnus : on les cherche sur Deezer (nom exact) et on ne garde que ceux dont les artistes similaires
// sont déjà suivis — la catégorie (rap FR, rap US, musique FR) vient de ces voisins.
async function discoverPressArtists(state, cands) {
  const artists = state.artists;
  state.pressSeen = state.pressSeen || {};
  const known = new Set(Object.values(artists).map(a => norm(a.n)));
  const RAPPY = /\b(rap|rappeur|rappeuse|rapper|hip-hop|hip hop|drill|street|mixtape|feat|r&b|afro)\b/i;
  const todo = uniqBy([...cands].sort((x, y) => Number(RAPPY.test(y.h || '')) - Number(RAPPY.test(x.h || '')) || (x.lang === 'fr' ? -1 : 1)), c => norm(c.unknown))
    .filter(c => {
      const k = norm(c.unknown);
      return k.length >= 3 && !known.has(k) && !NOT_SUBJECT.has(spacedNorm(c.unknown)) && !/rock|metal|jazz|classique|opera/i.test(c.outlet || '')
        && !(state.pressSeen[k] && Date.now() - state.pressSeen[k] < 14 * DAY);
    }).slice(0, 40);
  let added = 0;
  for (const c of todo) {
    if (Date.now() > DEADLINE) break;
    const name = c.unknown;
    state.pressSeen[norm(name)] = Date.now();
    try {
      const res = await dz(`/search/artist?limit=10&q=${encodeURIComponent(name)}`);
      const m = (res.data || []).filter(a => norm(a.name) === norm(name)).sort((a, b) => b.nb_fan - a.nb_fan)[0];
      if (!m || m.nb_fan < 3000 || artists[m.id] || IGNORE.has(m.id)) continue;
      const rel = (await dz(`/artist/${m.id}/related?limit=40`)).data || [];
      const votes = {};
      for (const r of rel) {
        const f = artists[r.id];
        if (f && f.c !== 'int') { const k = f.c === 'frx' ? 'mfr' : f.c; votes[k] = (votes[k] || 0) + 1; }
      }
      const total = Object.values(votes).reduce((t, v) => t + v, 0);
      // au moins deux voisins suivis, et au moins un sur dix
      if (total < Math.max(2, Math.ceil(rel.length * 0.1))) continue;
      const top = Object.entries(votes).sort((x, y) => y[1] - x[1])[0][0];
      if (top === 'rus' && m.nb_fan < 20000) continue;
      if (c.lang === 'en' && top !== 'rus') continue;   // annonce en anglais : seul le rap US est concerné
      artists[m.id] = { n: m.name, c: top === 'mfr' ? 'frx' : top, f: m.nb_fan, src: 'press', it: 0 };
      added++;
    } catch (e) { /* on réessaiera dans 14 jours */ }
  }
  for (const [k, t] of Object.entries(state.pressSeen)) if (Date.now() - t > 60 * DAY) delete state.pressSeen[k];
  if (todo.length) log(`presse : ${todo.length} noms inconnus vérifiés sur Deezer, ${added} artistes ajoutés`);
  return added;
}
// une annonce par artiste et par sortie : un vrai titre l’emporte, puis l’article le plus récent.
// Une annonce sans titre plus ancienne qu’une annonce titrée du même artiste est périmée (date repoussée…).
function dedupeNews(list) {
  const kept = [];
  for (const a of [...list].sort((x, y) => Number(y.quoted) - Number(x.quoted) || y.pub - x.pub)) {
    const dup = kept.some(k => k.aid === a.aid && (Math.abs(Date.parse(k.date) - Date.parse(a.date)) <= 6 * DAY
      || (k.quoted && a.quoted && norm(k.title) === norm(a.title))
      || (!a.quoted && (k.quoted ? k.pub > a.pub : k.rt === a.rt))));
    if (!dup) kept.push(a);
  }
  return kept;
}
const newsGap = spaced(FAST ? 0 : 1300);
async function pressStep(state) {
  const due = !state.news || !state.news.raw || Date.now() - state.news.t > 2 * HOUR;
  const artists = state.artists;
  let byFirst = makeMatchers(artists);
  if (!due || Date.now() > DEADLINE) {
    // pas de lecture cette fois, mais les annonces déjà repérées sont relues avec les règles et les artistes du jour
    if (state.news && state.news.raw) state.news.items = dedupeNews(state.news.raw.map(r => extractAnnouncement(r, byFirst)).filter(a => a && !a.unknown && a.date > TODAY));
    return;
  }
  const urls = [];
  const gn = (q, en) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:30d`)}&${en ? 'hl=en-US&gl=US&ceid=US:en' : 'hl=fr&gl=FR&ceid=FR:fr'}`;
  for (const q of GN_FR) urls.push(gn(q, false));
  for (const q of GN_EN) urls.push(gn(q, true));
  // les prochains vendredis : « album "4 décembre" », « "December 4" album rapper »
  let fri = addDays(TODAY, 1);
  while (new Date(`${fri}T12:00:00Z`).getUTCDay() !== 5) fri = addDays(fri, 1);
  for (let k = 0; k < 10; k++) {
    const d = addDays(fri, 7 * k), day = Number(d.slice(8)), mon = Number(d.slice(5, 7)) - 1;
    const fr = `${day === 1 ? '1er' : day} ${FR_MONTHS[mon]}`;
    urls.push(gn(`album "${fr}"`, false));
    if (k < 6) urls.push(gn(`rappeur "${fr}"`, false));
    if (k < 8) urls.push(gn(`"${EN_MONTHS[mon]} ${day}" album rapper`, true));
  }
  // les artistes les plus suivis à chaque passage, puis 40 autres à tour de rôle
  const byFans = Object.values(artists).filter(a => !NOT_ARTIST.has(spacedNorm(a.n))).sort((x, y) => y.f - x.f);
  const isFr = a => ['rfr', 'fr', 'mfr', 'frx'].includes(a.c);
  const query = a => (isFr(a) ? gn(`"${a.n}" album`, false) : gn(`"${a.n}" album release date`, true));
  const top = [...byFans.filter(isFr).slice(0, 45), ...byFans.filter(a => a.c === 'rus').slice(0, 20)];
  for (const a of top) urls.push(query(a));
  const topSet = new Set(top);
  const pool = byFans.filter(a => a.f >= 15000 && !topSet.has(a));
  if (pool.length) {
    const start = (state.newsRot || 0) % pool.length;
    for (let i = 0; i < Math.min(40, pool.length); i++) urls.push(query(pool[(start + i) % pool.length]));
    state.newsRot = (start + 40) % pool.length;
  }
  let ok = 0, read = 0, gnFails = 0;
  const fresh = [];
  for (const url of [...FEEDS, ...urls]) {
    if (Date.now() > DEADLINE) break;
    const google = url.includes('news.google.com');
    if (google && gnFails >= 3) continue;
    try {
      const xml = google ? await newsGap(() => getText(url)) : await getText(url);
      const items = parseRss(xml);
      ok++; read += items.length;
      for (const it of items) if (extractAnnouncement(it, byFirst)) fresh.push(it);
    } catch (e) { if (google) gnFails++; }
  }
  // les articles déjà repérés sont relus avec les règles du jour : une erreur corrigée disparaît d’elle-même
  const prevRaw = (state.news && state.news.raw) || [];
  let raw = uniqBy([...fresh, ...prevRaw].filter(r => r && r.title && Date.now() - r.pub < 150 * DAY), r => r.link || r.title);
  const unknown = raw.map(r => extractAnnouncement(r, byFirst)).filter(a => a && a.unknown);
  if (unknown.length && await discoverPressArtists(state, unknown)) byFirst = makeMatchers(state.artists);
  const all = [];
  raw = raw.filter(r => {
    const a = extractAnnouncement(r, byFirst);
    if (!a || a.date <= TODAY) return false;
    if (!a.unknown) all.push(a);
    return true;
  }).sort((a, b) => b.pub - a.pub).slice(0, 400);
  state.news = { t: Date.now(), raw, items: dedupeNews(all) };
  log(`presse : ${ok} flux lus, ${read} articles, ${state.news.items.length} annonces retenues`);
}

/* ------------------------------------------------------------------ classements */
// Les 150 artistes les plus écoutés en France sont suivis d’office. La liste vient des classements Spotify France
// publiés par kworb.net et elle est recalculée chaque jour : un artiste qui perce entre dans le suivi tout seul.
// Score : écoutes de la semaine (ramenées à l’année) + cumul des titres classés depuis 2017 (moyenne par an).
// Un invité (« w/ … ») compte pour moitié. Ceux qui ne relèvent ni du rap FR, ni du rap US, ni de la musique
// française sont rangés en « International ».
const CHART_WEEK = 'https://kworb.net/spotify/country/fr_weekly.html';
const CHART_TOTAL = 'https://kworb.net/spotify/country/fr_weekly_totals.html';
const TOP_N = 150;
const NOT_CHART = /\b(soundtrack|original score|bande originale|grand theft auto|gp explorer|nouvelle ecole|arcane|huntr ?x|kpop demon hunters|colors|various artists|star academy|cast)\b/i;
function parseKworb(html, col) {
  const heads = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim());
  const ci = heads.indexOf(col), ai = heads.findIndex(h => /artist/i.test(h));
  if (ci < 0 || ai < 0) return [];
  const rows = [];
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
    if (cells.length <= Math.max(ci, ai)) continue;
    const cell = cells[ai];
    const sep = cell.indexOf(' - ');
    const artists = [...cell.matchAll(/<a href="[^"]*artist\/[^"]+"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(a => ({ name: decodeEntities(a[1]).trim().replace(/\s*\((?:FR|US|UK|BE|CA|CH|DE|rapper|rappeur|band|artist|singer)\)$/i, ''), main: sep < 0 || a.index < sep }));
    const n = Number(String(cells[ci]).replace(/[^0-9]/g, '')) || 0;
    if (artists.length && n) rows.push({ n, artists });
  }
  return rows;
}
async function chartsStep(state) {
  if (state.charts && Date.now() - state.charts.t < 20 * HOUR) return;
  let week, total;
  try {
    [week, total] = await Promise.all([getText(CHART_WEEK), getText(CHART_TOTAL)]);
  } catch (e) { log(`classements : indisponibles (${e.message}), on garde la liste d’hier`); return; }
  const score = new Map();
  const bump = (name, v) => {
    const k = norm(name);
    if (!k || NOT_CHART.test(name)) return;
    const o = score.get(k) || { n: name, s: 0 };
    o.s += v;
    score.set(k, o);
  };
  const w = parseKworb(week, 'Streams'), t = parseKworb(total, 'Total');
  if (w.length < 50 || t.length < 500) { log(`classements : page inattendue (${w.length}/${t.length} lignes), ignorée`); return; }
  for (const r of w) for (const a of r.artists) bump(a.name, (a.main ? 1 : 0.5) * r.n * 52);
  for (const r of t) for (const a of r.artists) bump(a.name, (a.main ? 1 : 0.5) * r.n / 9);
  const ranked = [...score.values()].sort((x, y) => y.s - x.s).slice(0, TOP_N);
  const artists = state.artists;
  const byName = new Map(Object.entries(artists).map(([id, a]) => [norm(a.n), id]));
  for (const a of Object.values(artists)) delete a.top;
  const list = [];
  let added = 0, missing = 0;
  for (const [i, r] of ranked.entries()) {
    let id = byName.get(norm(r.n));
    if (!id) {
      try {
        const res = await dz(`/search/artist?limit=10&q=${encodeURIComponent(r.n)}`);
        const m = (res.data || []).filter(a => norm(a.name) === norm(r.n)).sort((a, b) => b.nb_fan - a.nb_fan)[0];
        if (!m || m.nb_fan < 1000) { missing++; continue; }
        id = String(m.id);
        if (!artists[id]) {
          // catégorie d’après les voisins déjà suivis : français → rap ou musique selon chaque sortie, rap US, sinon International
          const rel = (await dz(`/artist/${m.id}/related?limit=40`)).data || [];
          const votes = {};
          for (const x of rel) {
            const f = artists[x.id];
            if (f && f.c !== 'int') { const k = f.c === 'rus' ? 'rus' : 'fr'; votes[k] = (votes[k] || 0) + 1; }
          }
          const fr = votes.fr || 0, us = votes.rus || 0;
          const c = fr >= 2 && fr >= us ? 'fr' : us >= 2 ? 'rus' : 'int';
          artists[id] = { n: m.name, c, f: m.nb_fan, src: 'top', it: 0 };
          byName.set(norm(m.name), id);
          added++;
        }
      } catch (e) { missing++; continue; }
    }
    artists[id].top = i + 1;
    // un artiste du top France rangé « proche de la variété » (frx) : rap ou musique FR selon chaque sortie
    if (artists[id].c === 'frx') artists[id].c = 'fr';
    list.push({ n: artists[id].n, id, s: Math.round(r.s) });
  }
  state.charts = { t: Date.now(), list };
  log(`classements : top ${list.length} France, ${added} artistes ajoutés${missing ? `, ${missing} introuvables sur Deezer` : ''}`);
}

/* ------------------------------------------------------------------ concerts */
// Concerts et festivals en France, en Belgique et en Suisse des artistes suivis, d’après l’API Discovery de
// Ticketmaster (clé gratuite rangée dans le secret GitHub TICKETMASTER_KEY). Relus toutes les 12 heures, sur un an.
const TM_KEY = process.env.TICKETMASTER_KEY || '';
const TM_COUNTRIES = ['FR', 'BE', 'CH'];
const tmGap = spaced(FAST ? 0 : 260);                // 5 requêtes par seconde au plus
async function tm(params) {
  const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(TM_KEY)}&segmentId=KZFzniwnSyZfZ7v7nJ&size=200&sort=date,asc&locale=*&${params}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const j = await tmGap(() => getJson(url, { timeout: 30000 })); stats.ticketmaster = (stats.ticketmaster || 0) + 1; return j; }
    catch (e) { if (e.status === 401 || e.status === 403) throw e; await sleep(FAST ? 0 : e.status === 429 ? 5000 : 2000); }
  }
  throw new Error('Ticketmaster indisponible');
}
// l’API ne rend que 1 000 résultats par recherche : une période trop chargée est coupée en deux
async function tmScan(cc, from, to, out) {
  const range = `countryCode=${cc}&startDateTime=${from}T00:00:00Z&endDateTime=${to}T23:59:59Z`;
  const first = await tm(`${range}&page=0`);
  const total = (first.page && first.page.totalElements) || 0;
  if (total > 1000 && from < to) {
    const mid = addDays(from, Math.floor((Date.parse(to) - Date.parse(from)) / DAY / 2));
    await tmScan(cc, from, mid, out);
    await tmScan(cc, addDays(mid, 1), to, out);
    return;
  }
  out.push(...((first._embedded && first._embedded.events) || []));
  for (let p = 1; p < Math.min(Math.ceil(total / 200), 5); p++) {
    if (Date.now() > DEADLINE) return;
    const j = await tm(`${range}&page=${p}`);
    out.push(...((j._embedded && j._embedded.events) || []));
  }
}
// Songkick publie pour chaque grande ville l’agenda complet des concerts, avec des données structurées
// (schema.org MusicEvent) lisibles sans clé : on lit les agendas des grandes villes de France, de Belgique et de Suisse.
const SK_METROS = [
  ['28909-france-paris', 'FR'], ['28889-france-lyon', 'FR'], ['156979-france-marseille', 'FR'], ['28930-france-toulouse', 'FR'],
  ['28851-france-bordeaux', 'FR'], ['28886-france-lille', 'FR'], ['28901-france-nantes', 'FR'], ['28928-france-strasbourg', 'FR'],
  ['28896-france-montpellier', 'FR'], ['28903-france-nice', 'FR'], ['28916-france-rennes', 'FR'], ['28863-france-clermont-ferrand', 'FR'],
  ['28918-france-rouen', 'FR'], ['28876-france-grenoble', 'FR'], ['28869-france-dijon', 'FR'], ['28894-france-metz', 'FR'],
  ['28899-france-nancy', 'FR'], ['28932-france-tours', 'FR'], ['28855-france-caen', 'FR'], ['104876-france-saint-etienne', 'FR'],
  ['28840-france-angers', 'FR'], ['182976-belgium-brussels', 'BE'], ['26862-belgium-liege', 'BE'], ['26852-belgium-antwerp', 'BE'],
  ['35345-belgium-ghent', 'BE'], ['26855-belgium-charleroi', 'BE'], ['27453-switzerland-geneva', 'CH'], ['27454-switzerland-lausanne', 'CH'],
  ['104761-switzerland-zurich', 'CH'], ['27451-switzerland-basel', 'CH'], ['27452-switzerland-bern', 'CH'], ['35384-switzerland-fribourg', 'CH'],
];
const SK_COUNTRY = { france: 'FR', belgium: 'BE', belgique: 'BE', switzerland: 'CH', suisse: 'CH' };
const skGap = spaced(FAST ? 0 : 1200);
async function songkickEvents() {
  const out = [];
  let pagesOk = 0, metrosOk = 0;
  for (const [metro, cc] of SK_METROS) {
    let got = false;
    for (let page = 1; page <= 40; page++) {
      if (Date.now() > DEADLINE) return { out, pagesOk, metrosOk };
      let html;
      try { html = await skGap(() => getText(`https://www.songkick.com/metro-areas/${metro}?page=${page}`)); }
      catch (e) { break; }
      const evs = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m => {
        try { const j = JSON.parse(m[1]); return Array.isArray(j) ? j : [j]; } catch (e) { return []; }
      }).filter(x => x && (x['@type'] === 'MusicEvent' || x['@type'] === 'Festival'));
      if (!evs.length) break;
      pagesOk++; got = true;
      for (const e of evs) {
        const loc = e.location || {}, addr = loc.address || {};
        const status = String(e.eventStatus || '');
        out.push({
          id: `sk${(String(e.url || '').match(/concerts\/(\d+)/) || [])[1] || norm(e.name)}`,
          d: String(e.startDate || '').slice(0, 10), h: (String(e.startDate || '').match(/T(\d\d:\d\d)/) || [])[1] || '',
          name: e['@type'] === 'Festival' ? String(e.name || '').replace(/\s+@\s+.*$/, '') : '', performers: (Array.isArray(e.performer) ? e.performer : [e.performer]).filter(Boolean).map(x => x.name),
          venue: loc.name || '', city: addr.addressLocality || '', cc: SK_COUNTRY[spacedNorm(addr.addressCountry)] || cc,
          url: String(e.url || '').replace(/\?.*$/, ''), img: e.image || '', price: 0,
          status: /Cancelled/i.test(status) ? 'cancelled' : /Postponed/i.test(status) ? 'postponed' : /Rescheduled/i.test(status) ? 'rescheduled' : '',
          fest: e['@type'] === 'Festival',
        });
      }
      if (!/page=\d+#metro-area-calendar/.test(html) || !html.includes(`page=${page + 1}`)) break;
    }
    if (got) metrosOk++;
  }
  return { out, pagesOk, metrosOk };
}
async function ticketmasterEvents() {
  const raw = [];
  for (const cc of TM_COUNTRIES) {
    try { await tmScan(cc, TODAY, addDays(TODAY, 365), raw); }
    catch (e) { log(`concerts : Ticketmaster ${cc} indisponible (${e.message})`); if (e.status === 401 || e.status === 403) break; }
  }
  return uniqBy(raw, x => x.id).map(e => {
    const v = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || {};
    const imgs = e.images || [];
    const img = imgs.filter(i => i.ratio === '16_9' && i.width >= 500).sort((x, y) => x.width - y.width)[0] || imgs[0];
    const prices = (e.priceRanges || []).map(q => q.min).filter(n => n > 0);
    const code = e.dates && e.dates.status && e.dates.status.code;
    const atts = (e._embedded && e._embedded.attractions) || [];
    return {
      id: `tm${e.id}`, d: (e.dates && e.dates.start && e.dates.start.localDate) || '', h: String((e.dates && e.dates.start && e.dates.start.localTime) || '').slice(0, 5),
      name: e.name || '', performers: atts.map(x => x.name), venue: v.name || '', city: (v.city && v.city.name) || '',
      cc: (v.country && v.country.countryCode) || '', url: e.url || '', img: img ? img.url : '', price: prices.length ? Math.min(...prices) : 0,
      status: code === 'cancelled' ? 'cancelled' : code === 'postponed' || code === 'rescheduled' ? code : '', fest: atts.length >= 4,
    };
  });
}
async function concertsStep(state) {
  const prev = state.concerts || { t: 0, items: [] };
  if (Date.now() - prev.t < 12 * HOUR || Date.now() > DEADLINE) return;
  const sk = await songkickEvents();
  const tmList = TM_KEY ? await ticketmasterEvents() : [];
  if (!sk.pagesOk && !tmList.length) { log('concerts : agendas indisponibles, on garde les dates d’avant'); return; }
  const byName = new Map();
  for (const [id, a] of Object.entries(state.artists)) {
    const k = norm(a.n);
    if (k.length >= (a.ro ? 5 : 3) && !NOT_ARTIST.has(spacedNorm(a.n))) byName.set(k, { id, ...a });
  }
  const items = [];
  const seen = new Set();
  // Ticketmaster d’abord quand il est branché : il donne le prix et le lien direct vers les billets
  for (const e of [...tmList, ...sk.out]) {
    if (e.status === 'cancelled' || !isYmd(e.d) || e.d < TODAY || e.d > addDays(TODAY, 400)) continue;
    const hits = uniqBy(e.performers.map(n => byName.get(norm(n))).filter(Boolean), x => x.id).sort((x, y) => pop(y) - pop(x));
    if (!hits.length) continue;
    const c = leanCat(hits[0]);
    if (!c) continue;
    const key = `${norm(hits[0].n)}|${e.d}|${norm(e.city)}`;   // même date vue sur plusieurs agendas ou en plusieurs formules
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: e.id, d: e.d, h: e.h, n: e.name, a: hits.map(h => h.n), c, v: e.venue, ci: e.city, cc: e.cc, u: e.url, im: e.img,
      pr: e.price, st: e.status, fe: e.fest || e.performers.length >= 4 ? 1 : 0, p: Math.round(pop(hits[0])),
    });
  }
  items.sort((x, y) => x.d.localeCompare(y.d) || y.p - x.p);
  // un agenda resté muet ne doit pas effacer les dates déjà connues
  if (items.length < (prev.items || []).filter(x => x.d >= TODAY).length * 0.5) { log(`concerts : seulement ${items.length} dates trouvées, on garde les précédentes`); return; }
  state.concerts = { t: Date.now(), items };
  log(`concerts : ${sk.metrosOk}/${SK_METROS.length} villes lues (${sk.pagesOk} pages, ${sk.out.length} événements)${TM_KEY ? `, ${tmList.length} Ticketmaster` : ''} → ${items.length} dates d’artistes suivis`);
}

/* ------------------------------------------------------------------ assemblage */
function matchArtist(name, byName) {
  const n = norm(name);
  if (byName.has(n)) return byName.get(n);
  for (const part of String(name).split(/\s*(?:&|,| and | x | feat\.? | featuring | with )\s*/i)) {
    const p = norm(part);
    if (p && byName.has(p)) return byName.get(p);
  }
  return null;
}
function catForExternal(a, genreName, title, fallback) {
  if (!a) return fallback;
  const c = catOf(a, null, genreName, title);
  return c || fallback;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const seeds = await loadSeeds();
  const prevState = await loadPrevious('state.json', null);
  const prevReleases = await loadPrevious('releases.json', null);
  const details = (await loadPrevious('details.json', null)) || {};
  const state = prevState && prevState.v === 1 ? prevState : { v: 1, artists: {}, albums: {}, feats: {} };
  state.albums = state.albums || {};
  state.feats = state.feats || {};
  // les artistes de la liste de départ font foi (nom, genre, identifiant Apple)
  for (const [id, s] of Object.entries(seeds)) {
    const old = state.artists[id] || {};
    state.artists[id] = { ...old, ...s, it: s.it || old.it || 0, itT: old.itT };
  }
  for (const [id, a] of Object.entries(state.artists)) if (a.src === 'seed' && !seeds[id]) delete state.artists[id];
  KNOWN = new Set(Object.values(state.artists).map(a => norm(a.n)));

  const before = new Set(Object.keys(state.artists));
  await chartsStep(state);
  await wikipediaStep(state);
  await discoverRelated(state);
  if (UG_ON) {
    try { await discoverUnderground(state, await loadUnderground()); } catch (e) { log(`liste underground : ${e.message}`); }
    try { await discoverPlaylists(state); } catch (e) { log(`playlists : ${e.message}`); }
  }
  await discoverWikiCategories(state);
  if (DRY) { await dryRunReport(state, before); return; }
  if (state.wiki) await discoverFromNames(state, state.wiki.items.map(x => x.artist).filter(n => n !== 'Divers artistes'));
  KNOWN = new Set(Object.values(state.artists).map(a => norm(a.n)));
  const artists = state.artists;
  log(`${Object.keys(artists).length} artistes suivis`);

  const discos = await fetchDiscographies(state);
  if (discos.total > 20 && discos.fails > discos.total * 0.3) throw new Error(`trop d’échecs Deezer (${discos.fails}/${discos.total}), publication annulée`);
  const releases = buildDeezerReleases(artists, discos.map, state.albums);
  log(`Deezer : ${releases.length} sorties entre ${HISTORY_FROM} et ${FUTURE_TO}`);
  await fetchAlbumDetails(releases, state, details);
  await fetchTrackCredits(releases, state, details);
  await appleIds(state);
  await appleStep(state, details);
  await musicbrainzStep(state, details);
  await pressStep(state);
  await concertsStep(state);

  /* ---- fusion ---- */
  const byName = new Map(Object.entries(artists).map(([id, a]) => [norm(a.n), { id, ...a }]));
  const items = [];
  const index = new Map();
  const keyOf = (artist, title) => `${norm(artist).slice(0, 40)}|${norm(baseTitle(title)).slice(0, 60)}`;
  const add = (it, keyArtists) => {
    for (const ka of keyArtists) {
      const k = keyOf(ka, it.t);
      const p = index.get(k);
      // deux sorties Deezer distinctes (album et réédition « Deluxe », « Bonus »…) restent séparées
      if (p && !(p.s.includes('dz') && it.s.includes('dz'))) {
        for (const s of it.s) if (!p.s.includes(s)) p.s.push(s);
        if (!p.am && it.am) p.am = it.am;
        if (!p.cu && !p.cv && it.cu) p.cu = it.cu;
        if (!p.mb && it.mb) p.mb = it.mb;
        if (!p.src && it.src) p.src = it.src;
        return p;
      }
    }
    for (const ka of keyArtists) { const k = keyOf(ka, it.t); if (!index.has(k)) index.set(k, it); }
    items.push(it);
    return it;
  };

  for (const r of releases) {
    const meta = state.albums[r.id];
    const mainName = meta && meta.a ? meta.a : r.arts.map(x => x.n).join(' & ');
    const sp = splitFeat(r.title);
    const mainsN = norm(mainName);
    const feats = [...sp.feats];
    for (const x of r.arts) if (!mainsN.includes(norm(x.n)) && !feats.some(f => norm(f) === norm(x.n))) feats.push(x.n);
    const tracks = details[`dz${r.id}`];
    if (tracks && tracks.length <= 3 && r.rt !== 'album') for (const row of tracks) for (const f of row[2]) if (!feats.some(z => norm(z) === norm(f))) feats.push(f);
    const it = {
      k: `dz${r.id}`, t: sp.clean || r.title, a: mainName, f: uniqBy(feats, norm).filter(f => !mainsN.includes(norm(f))), d: r.date,
      rt: ['album', 'ep', 'single', 'compile'].includes(r.rt) ? r.rt : 'album', c: r.cat, cv: r.md5,
      n: meta ? meta.n : 0, du: meta ? meta.du : 0, lb: meta ? meta.lb : '', g: meta ? meta.g : '', ex: r.ex,
      p: Math.round(Math.max(...r.arts.map(pop)) + (r.fans || 0) * 4), s: ['dz'], dz: r.id,
    };
    add(it, [mainName.split(' & ')[0], r.arts[0].n]);
  }
  for (const x of (state.apple && state.apple.items) || []) {
    const a = artists[x.aid];
    if (!a || x.date <= TODAY) continue;
    const c = catOf(a, null, x.genre, x.title);
    if (!c) continue;
    const sp = splitFeat(x.title);
    add({ k: `it${x.id}`, t: sp.clean, a: x.artist || a.n, f: sp.feats, d: x.date, rt: x.rt, c, cu: x.cover, n: x.n, du: 0, lb: x.label || '', g: x.genre, ex: x.ex, p: Math.round(pop(a)), s: ['it'], am: x.link }, [x.artist, a.n]);
  }
  for (const x of (state.mb && state.mb.items) || []) {
    const a = artists[x.aid];
    if (!a || x.date <= TODAY) continue;
    const c = leanCat(a);
    if (!c) continue;
    add({ k: `mb${x.id}`, t: x.title, a: x.artist || a.n, f: [], d: x.date, rt: x.rt, c, n: 0, du: 0, lb: x.label || '', g: '', ex: 0, p: Math.round(pop(a) * 0.9), s: ['mb'], mb: x.id }, [a.n, x.artist]);
  }
  for (const x of (state.wiki && state.wiki.items) || []) {
    if (x.date <= TODAY) continue;
    const a = matchArtist(x.artist, byName);
    const c = catForExternal(a, 'hip-hop', x.title, 'rus');
    add({ k: `wk${norm(x.artist).slice(0, 24)}${x.date.replace(/-/g, '')}${norm(x.title).slice(0, 12)}`, t: x.title, a: x.artist, f: [], d: x.date, rt: 'album', c, n: 0, du: 0, lb: '', g: 'Hip-hop', ex: 0, p: a ? a.f * 0.8 : 15000, s: ['wk'] }, [x.artist, a && a.n].filter(Boolean));
  }
  for (const x of await loadAnnonces()) {
    if (!isYmd(x.date) || x.date <= TODAY || !x.artist || !x.title) continue;
    const a = matchArtist(x.artist, byName);
    const c = ['rfr', 'rus', 'mfr'].includes(x.cat) ? x.cat : catForExternal(a, '', x.title, 'rfr');
    add({ k: `an${norm(x.artist).slice(0, 24)}${x.date.replace(/-/g, '')}${norm(x.title).slice(0, 12)}`, t: x.title, a: x.artist, f: [], d: x.date, rt: ['album', 'ep', 'single'].includes(x.type) ? x.type : 'album', c, n: 0, du: 0, lb: '', g: '', ex: 0, p: a ? a.f : 30000, s: ['an'], src: x.source || '' }, [x.artist, a && a.n].filter(Boolean));
  }

  // annonces repérées dans la presse : on complète ce qui est déjà connu, sinon on ajoute
  const byArtist = new Map();
  for (const it of items) for (const nm of String(it.a).split(/\s*&\s*/)) {
    const k = norm(nm);
    if (!byArtist.has(k)) byArtist.set(k, []);
    byArtist.get(k).push(it);
  }
  const near = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= 6 * DAY;
  for (const x of (state.news && state.news.items) || []) {
    const a = artists[x.aid];
    if (!a || x.date <= TODAY) continue;
    const list = byArtist.get(norm(a.n)) || [];
    const same = list.find(it => it.d > TODAY && near(it.d, x.date));
    if (same) {
      if (!same.s.includes('pr')) same.s.push('pr');
      if (!same.pl) { same.pl = x.link; same.po = x.outlet; }
      if (x.quoted && /^(nouvel album|nouvel ep|nouvelle mixtape|nouveau single|titre à venir)$/i.test(same.t)) same.t = x.title;
      continue;
    }
    const c = leanCat(a);
    if (!c) continue;
    const it = { k: `pr${x.aid}${x.date.replace(/-/g, '')}`, t: x.title, a: a.n, f: [], d: x.date, rt: x.rt, c, n: 0, du: 0, lb: '', g: '', ex: 0, p: Math.round(pop(a) * 0.95), s: ['pr'], pl: x.link, po: x.outlet };
    items.push(it);
    list.push(it);
    byArtist.set(norm(a.n), list);
  }

  // doublons d'une même sortie le même jour (version « Clean », instrumentale, « Radio Edit », mention répétée…)
  const kept = dedupeReleases(items);
  if (kept.length !== items.length) console.log(`doublons retirés : ${items.length - kept.length}`);
  items.splice(0, items.length, ...kept);

  // nettoyage du cache : on ne garde que ce qui sert encore
  const live = new Set(items.map(i => i.k));
  for (const k of Object.keys(details)) if (!live.has(k)) delete details[k];
  const liveAlbums = new Set(releases.map(r => String(r.id)));
  for (const k of Object.keys(state.albums)) if (!liveAlbums.has(k)) delete state.albums[k];
  for (const k of Object.keys(state.feats)) if (!liveAlbums.has(k)) delete state.feats[k];

  const prevCount = prevReleases && prevReleases.items ? prevReleases.items.length : 0;
  if (prevCount > 50 && items.length < prevCount * 0.4) throw new Error(`seulement ${items.length} sorties contre ${prevCount} : publication annulée`);

  items.sort((a, b) => b.d.localeCompare(a.d) || b.p - a.p);
  const generatedAt = new Date().toISOString();
  const upcoming = items.filter(i => i.d > TODAY).length;
  await writeFile(`${OUT}/releases.json`, JSON.stringify({ v: 1, generatedAt, today: TODAY, artists: Object.keys(artists).length, items }));
  await writeFile(`${OUT}/details.json`, JSON.stringify(details));
  const concerts = ((state.concerts && state.concerts.items) || []).filter(x => x.d >= TODAY);
  await writeFile(`${OUT}/concerts.json`, JSON.stringify({ v: 1, generatedAt, updatedAt: state.concerts ? new Date(state.concerts.t).toISOString() : null, items: concerts }));
  await writeFile(`${OUT}/state.json`, JSON.stringify(state));
  log(`terminé : ${items.length} sorties dont ${upcoming} à venir · requêtes ${JSON.stringify(stats)}`);
}

// même artiste, même jour, même format, même titre une fois les parenthèses et crochets retirés :
// on garde la version principale (pas « Clean », « Instrumental »…), puis celle qui a la tracklist (Deezer), la plus complète
const VARIANT_RE = /[(\[][^)\]]*\b(clean|instrumental|radio edit|edit|sped up|slowed|a ?cappella|acapella|karaok\w*)\b[^)\]]*[)\]]/i;
function dedupeReleases(items) {
  const coreTitle = t => norm(String(t || '').replace(/[(\[][^)\]]*[)\]]/g, ''));
  const fmt = rt => (rt === 'compile' ? 'album' : rt);
  const score = it => (VARIANT_RE.test(it.t) ? 0 : 1e9) + (String(it.k).startsWith('dz') ? 1e8 : 0) + (it.n || 0) * 1e4 + (it.p || 0) / 1e3;
  const groups = new Map();
  for (const it of items) {
    const core = coreTitle(it.t);
    const key = core ? `${norm(it.a)}|${it.d}|${fmt(it.rt)}|${core}` : `#${it.k}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, it); continue; }
    const [best, other] = score(it) > score(g) ? [it, g] : [g, it];
    best.s = [...new Set([...(best.s || []), ...(other.s || [])])];
    if (!best.pl && other.pl) { best.pl = other.pl; best.po = other.po; }
    if (!best.am && other.am) best.am = other.am;
    if (!best.mb && other.mb) best.mb = other.mb;
    groups.set(key, best);
  }
  const keep = new Set(groups.values());
  return items.filter(it => keep.has(it));
}

export { extractAnnouncement, makeMatchers, parseRss, subjectOf, quotedIn, dedupeNews, leanCat, dedupeReleases };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
}
