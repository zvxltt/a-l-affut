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
const log = (...a) => console.log(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(4)} s]`, ...a);

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
async function apple(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const j = await appleGap(() => getJson(url, { timeout: 40000 })); stats.apple++; return j; }
    catch (e) { await sleep(e.status === 403 || e.status === 429 ? 30000 : 4000); }
  }
  throw new Error('Apple indisponible');
}
const mbGap = spaced(FAST ? 0 : 1150);      // MusicBrainz : 1 requête / seconde
async function mb(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const j = await mbGap(() => getJson(url)); stats.musicbrainz++; return j; }
    catch (e) { await sleep(3000); }
  }
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
function catOf(a, genreId, genreName, title) {
  if (a.c === 'rfr' || a.c === 'rus' || a.c === 'mfr') return a.c;
  const gid = genreId > 0 ? genreId : null;
  const known = gid != null || !!genreName;
  const rap = gid === 116 || /rap|hip/i.test(genreName || '');
  if (a.c === 'fr') return !known || rap ? 'rfr' : 'mfr';
  const t = String(title || '').replace(/'/g, '');
  if (rap) return EN_RE.test(t) && !FR_RE.test(t) ? 'rus' : 'rfr';
  return FR_RE.test(t) ? 'mfr' : null;
}

/* ------------------------------------------------------------------ découverte d’artistes */
// 1) Artistes « similaires » sur Deezer, sur deux niveaux (les artistes de départ, puis les plus suivis des découverts).
async function discoverRelated(state) {
  if (state.relAt && Date.now() - state.relAt < 6 * DAY) return;
  const artists = state.artists;
  const base = Object.entries(artists)
    .filter(([, a]) => a.src === 'seed' || a.f >= 120000)
    .sort((x, y) => (x[1].src === 'seed' ? -1 : 0) - (y[1].src === 'seed' ? -1 : 0) || y[1].f - x[1].f)
    .slice(0, 1200);
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
    const minFans = cat === 'rus' ? 60000 : cat === 'frx' ? 40000 : 10000;
    if (v.f < minFans) continue;
    if (v.total < 2 && v.f < 250000) continue;
    artists[v.id] = { n: v.n, c: cat, f: v.f, src: 'rel', it: 0 };
    if (++added >= 1500) break;
  }
  state.relAt = Date.now();
  log(`découverte : ${added} artistes similaires ajoutés (${Object.keys(artists).length} suivis)`);
}

// 2) Catégories Wikipédia : rappeurs français, belges, suisses, québécois, chanteurs français, rappeurs américains.
const WIKI_CATS = [
  { lang: 'fr', cat: 'Catégorie:Rappeur français', depth: 2, c: 'rfr', min: 8000 },
  { lang: 'fr', cat: 'Catégorie:Rappeuse française', depth: 1, c: 'rfr', min: 8000 },
  { lang: 'fr', cat: 'Catégorie:Groupe français de hip-hop', depth: 1, c: 'rfr', min: 8000 },
  { lang: 'fr', cat: 'Catégorie:Rappeur belge', depth: 1, c: 'rfr', min: 8000 },
  { lang: 'fr', cat: 'Catégorie:Rappeuse belge', depth: 1, c: 'rfr', min: 8000 },
  { lang: 'fr', cat: 'Catégorie:Rappeur suisse', depth: 1, c: 'rfr', min: 8000 },
  { lang: 'fr', cat: 'Catégorie:Rappeur québécois', depth: 1, c: 'rfr', min: 10000 },
  { lang: 'fr', cat: 'Catégorie:Chanteuse française du XXIe siècle', depth: 0, c: 'fr', min: 50000 },
  { lang: 'fr', cat: 'Catégorie:Chanteur français du XXIe siècle', depth: 0, c: 'fr', min: 50000 },
  { lang: 'fr', cat: 'Catégorie:Auteur-compositeur-interprète français', depth: 0, c: 'fr', min: 50000 },
  { lang: 'fr', cat: 'Catégorie:Chanteuse française de pop', depth: 0, c: 'fr', min: 40000 },
  { lang: 'fr', cat: 'Catégorie:Chanteur français de pop', depth: 0, c: 'fr', min: 40000 },
  { lang: 'en', cat: 'Category:21st-century American rappers', depth: 1, c: 'rus', min: 60000 },
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
  let pending = state.catPending || [];
  if (!pending.length && (!state.catAt || Date.now() - state.catAt > 6 * DAY)) {
    for (const def of WIKI_CATS) {
      try {
        const names = await wikiCategoryMembers(def.lang, def.cat, def.depth);
        for (const n of names) pending.push([n, def.c, def.min]);
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
      state.artists[m.id] = { n: m.name, c, f: m.nb_fan, src: 'cat', it: 0 };
      added++;
    }
  }).catch(() => {})));
  state.catPending = pending.slice(2500);
  log(`découverte Wikipédia : ${batch.length} noms vérifiés, ${added} artistes ajoutés, ${state.catPending.length} restants`);
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
  for (const id of ids) {
    const a = artists[id], e = state.disco[id];
    if (e) {
      const age = a.last ? (Date.parse(TODAY) - Date.parse(a.last)) / DAY : 9999;
      const future = e.items.some(x => x.date > TODAY);
      const ttl = future || age <= 150 ? 0 : age <= 500 ? 6 * HOUR : 24 * HOUR;
      if (ttl && now - e.t < ttl) { out.set(id, e.items.filter(x => x.date >= HISTORY_FROM)); continue; }
    }
    todo.push(id);
  }
  let fails = 0;
  await Promise.all(todo.map(id => dz(`/artist/${id}/albums?limit=1000`).then(res => {
    const items = [];
    let last = '';
    for (const x of res.data || []) {
      const d = x.release_date || '';
      if (!isYmd(d)) continue;
      if (d <= TODAY && d > last) last = d;
      if (d < HISTORY_FROM || d > FUTURE_TO) continue;
      items.push({ id: x.id, title: x.title, date: d, rt: x.record_type, genre: x.genre_id, md5: x.md5_image || '', fans: x.fans || 0, ex: x.explicit_lyrics ? 1 : 0 });
    }
    artists[id].last = last;
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
async function appleStep(state, details) {
  const due = !state.apple || Date.now() - state.apple.t > 5.5 * HOUR;
  if (!due) return;
  const artists = state.artists;
  // 1) identifiants Apple manquants (au plus 90 par passage)
  const missing = Object.entries(artists).filter(([, a]) => !a.it && a.f >= 20000 && (!a.itT || Date.now() - a.itT > 30 * DAY))
    .sort((x, y) => y[1].f - x[1].f).slice(0, 140);
  for (const [, a] of missing) {
    try {
      const j = await apple(`https://itunes.apple.com/search?entity=musicArtist&country=fr&limit=8&term=${encodeURIComponent(a.n)}`);
      const m = (j.results || []).find(x => norm(x.artistName) === norm(a.n));
      a.it = m ? m.artistId : 0;
    } catch (e) { /* on réessaiera */ }
    a.itT = Date.now();
  }
  // 2) précommandes : sorties datées dans le futur
  const list = Object.entries(artists).filter(([, a]) => a.it).sort((x, y) => y[1].f - x[1].f);
  const byIt = new Map(list.map(([id, a]) => [a.it, { id, ...a }]));
  const items = [];
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
    } catch (e) { /* on continue */ }
  }
  const uniq = uniqBy(items, x => String(x.id));
  // 3) tracklists connues des précommandes
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
  log(`Apple Music : ${uniq.length} précommandes (${ok}/${chunk(list, 10).length} requêtes réussies, ${missing.length} identifiants cherchés)`);
}

/* ------------------------------------------------------------------ MusicBrainz */
async function musicbrainzStep(state, details) {
  const due = !state.mb || Date.now() - state.mb.t > 5.5 * HOUR;
  if (!due) return;
  const list = Object.entries(state.artists).sort((x, y) => y[1].f - x[1].f);
  const byName = new Map(list.map(([id, a]) => [norm(a.n), { id, ...a }]));
  const from = addDays(TODAY, 1);
  const items = [];
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
    } catch (e) { /* on continue */ }
  }
  const uniq = uniqBy(items, x => x.id);
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
// des médias rap, et repère les phrases du type « X annonce son album pour le 4 décembre ».
const FEEDS = [
  'https://raplume.eu/feed/', 'https://www.rapunchline.fr/feed/', 'https://www.hiphopcorner.fr/feed/', 'https://www.reaphit.com/feed/',
  'https://lerapcetaitmieuxavant.fr/feed/', 'https://www.booska-p.com/feed/', 'https://www.abcdrduson.com/feed/', 'https://www.lerapenfrance.fr/feed/',
  'https://www.xxlmag.com/feed/', 'https://www.rap-up.com/feed/', 'https://hiphopdx.com/rss/news.xml', 'https://www.hotnewhiphop.com/rss.xml',
];
const GN_FR = ['"annonce son nouvel album"', '"annonce son album"', '"nouvel album" "date de sortie"', '"date de sortie" album rappeur', '"nouvel EP"',
  'mixtape "date de sortie"', 'album "sortira le"', 'album "prévu le" rap', '"premier album" "date de sortie"', 'rappeuse album "sortie"',
  'chanteuse "nouvel album" "sortira"', 'chanteur "nouvel album" "sortira"', 'album "attendu le"'];
const GN_EN = ['rapper announces new album release date', '"new album" "release date" rapper', 'announces album "out" hip-hop', 'mixtape "release date" rapper'];
const MONTH = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_FR = /\b(\d{1,2})(?:er)?\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)(?:\s+(20\d\d))?\b/gi;
const DATE_EN = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/gi;
const REL_FR = /\b(album|ep|mixtape|tape|projet|opus|disque|single|titre|morceau|réédition)\b/i;
const ACT_FR = /\b(annonc\w*|sortira|sortie|sort|sortir|prévu\w*|attendu\w*|dévoil\w*|disponible|arrive|débarque|date|précommande)\b/i;
const REL_EN = /\b(album|ep|mixtape|tape|project|lp|single|deluxe)\b/i;
const ACT_EN = /\b(announc\w*|releas\w*|drop\w*|arriv\w*|due|set for|coming|out|dates?)\b/i;
const NOPE = /\b(concert\w*|tourn[ée]e|zénith|zenith|stade|olympia|accor arena|bercy|billet\w*|festival|spectacle|showcase|documentaire|film|série|livre|exposition|procès|tribunal|tour|tickets|arena|documentary|movie|book|lawsuit|court|arrest\w*|certifi\w*|disque d['’]or|platine|anniversaire|birthday)\b/i;
const COMMON = new Set(['future', 'logic', 'pomme', 'santa', 'offset', 'marine', 'ambre', 'helena', 'kalash', 'vegedream', 'naza', 'drake']);
const spacedNorm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const tag = t => { const x = block.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i')); return x ? decodeEntities(x[1]).trim() : ''; };
    const strip = h => decodeEntities(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    let title = strip(tag('title'));
    let outlet = strip(tag('source'));
    if (outlet && title.endsWith(` - ${outlet}`)) title = title.slice(0, -(outlet.length + 3));
    items.push({ title, desc: strip(tag('description')).slice(0, 600), link: tag('link'), pub: Date.parse(tag('pubDate')) || Date.now(), outlet });
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
    if (!key || key.length < 2) continue;
    const strict = key.replace(/ /g, '').length <= 5 || COMMON.has(key);
    const m = { id, a, key, strict, re: strict ? new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(a.n)}(?=$|[^\\p{L}\\p{N}])`, 'u') : null };
    const first = key.split(' ')[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push(m);
  }
  return byFirst;
}
function findArtist(title, byFirst) {
  const n = ` ${spacedNorm(title)} `;
  const words = n.trim().split(' ');
  let best = null;
  for (let i = 0; i < words.length; i++) {
    for (const m of byFirst.get(words[i]) || []) {
      if (!n.includes(` ${m.key} `)) continue;
      if (m.strict && !m.re.test(title)) continue;
      const pos = n.indexOf(` ${m.key} `);
      if (!best || pos < best.pos || (pos === best.pos && m.key.length > best.m.key.length)) best = { m, pos };
    }
  }
  return best ? best.m : null;
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
      found.push({ date, win, fr: re === DATE_FR });
    }
  }
  return found;
}
function extractAnnouncement(item, byFirst) {
  const artist = findArtist(item.title, byFirst);
  if (!artist) return null;
  const text = `${item.title} — ${item.desc}`;
  let pick = null;
  for (const d of findDate(text, item.pub)) {
    if (d.date <= TODAY || d.date > addDays(TODAY, 240)) continue;
    const rel = d.fr ? REL_FR : REL_EN, act = d.fr ? ACT_FR : ACT_EN;
    if (!rel.test(d.win) || !act.test(d.win) || NOPE.test(d.win)) continue;
    pick = d;
    break;
  }
  if (!pick) return null;
  const QUOTE = /[«“"‘]\s*([^»”"’]{2,70}?)\s*[»”"’]|(?:^|\s)'([^']{2,60})'(?=\s|$|[,.:;!?])/;
  const qm = item.title.match(QUOTE) || item.desc.match(QUOTE);
  const q = qm ? [qm[0], (qm[1] || qm[2] || '').trim()] : null;
  let title = q ? q[1].trim() : '';
  if (title && (norm(title) === norm(artist.a.n) || /\d{1,2}\s+(janv|f[ée]v|mars|avr|mai|juin|juil|ao[uû]|sept|oct|nov|d[ée]c)/i.test(title))) title = '';
  const ctx = pick.win;
  const rt = /\bEP\b/.test(ctx) || /\bEP\b/.test(item.title) ? 'ep'
    : /\b(single|titre|morceau)\b/i.test(ctx) && !/\b(album|mixtape|projet|project)\b/i.test(ctx) ? 'single' : 'album';
  const mixtape = /mixtape|\btape\b/i.test(ctx);
  if (!title) title = rt === 'ep' ? 'Nouvel EP' : rt === 'single' ? 'Nouveau single' : mixtape ? 'Nouvelle mixtape' : 'Nouvel album';
  let outlet = item.outlet;
  if (!outlet) { try { outlet = new URL(item.link).hostname.replace(/^www\./, ''); } catch (e) { outlet = ''; } }
  return { aid: artist.id, artist: artist.a.n, title, quoted: !!q && title === q[1].trim(), date: pick.date, rt, link: item.link, outlet, pub: item.pub };
}
const newsGap = spaced(FAST ? 0 : 1300);
async function pressStep(state) {
  const due = !state.news || Date.now() - state.news.t > 2 * HOUR;
  if (!due) return;
  const artists = state.artists;
  const byFirst = makeMatchers(artists);
  const urls = [];
  const gn = (q, en) => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:30d`)}&${en ? 'hl=en-US&gl=US&ceid=US:en' : 'hl=fr&gl=FR&ceid=FR:fr'}`;
  for (const q of GN_FR) urls.push(gn(q, false));
  for (const q of GN_EN) urls.push(gn(q, true));
  const top = (cats, n) => Object.values(artists).filter(a => cats.includes(a.c)).sort((x, y) => y.f - x.f).slice(0, n);
  for (const a of top(['rfr', 'fr', 'mfr', 'frx'], 45)) urls.push(gn(`"${a.n}" album`, false));
  for (const a of top(['rus'], 20)) urls.push(gn(`"${a.n}" album release date`, true));
  let ok = 0, read = 0, gnFails = 0;
  const found = [];
  for (const url of [...FEEDS, ...urls]) {
    const google = url.includes('news.google.com');
    if (google && gnFails >= 3) continue;
    try {
      const xml = google ? await newsGap(() => getText(url)) : await getText(url);
      const items = parseRss(xml);
      ok++; read += items.length;
      for (const it of items) { const a = extractAnnouncement(it, byFirst); if (a) found.push(a); }
    } catch (e) { if (google) gnFails++; }
  }
  // une annonce par artiste et par date, en gardant un vrai titre si un article le donne
  const best = new Map();
  for (const a of found.sort((x, y) => Number(y.quoted) - Number(x.quoted) || y.pub - x.pub)) {
    const k = `${a.aid}|${a.date}`;
    if (!best.has(k)) best.set(k, a);
  }
  state.news = { t: Date.now(), items: [...best.values()] };
  log(`presse : ${ok} flux lus, ${read} articles, ${state.news.items.length} annonces repérées`);
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

  await wikipediaStep(state);
  await discoverRelated(state);
  await discoverWikiCategories(state);
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
  await appleStep(state, details);
  await musicbrainzStep(state, details);
  await pressStep(state);

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
      p: r.arts[0].f + (r.fans || 0) * 4, s: ['dz'], dz: r.id,
    };
    add(it, [mainName.split(' & ')[0], r.arts[0].n]);
  }
  for (const x of (state.apple && state.apple.items) || []) {
    const a = artists[x.aid];
    if (!a || x.date <= TODAY) continue;
    const c = catOf(a, null, x.genre, x.title);
    if (!c) continue;
    const sp = splitFeat(x.title);
    add({ k: `it${x.id}`, t: sp.clean, a: x.artist || a.n, f: sp.feats, d: x.date, rt: x.rt, c, cu: x.cover, n: x.n, du: 0, lb: x.label || '', g: x.genre, ex: x.ex, p: a.f, s: ['it'], am: x.link }, [x.artist, a.n]);
  }
  for (const x of (state.mb && state.mb.items) || []) {
    const a = artists[x.aid];
    if (!a || x.date <= TODAY) continue;
    const c = catOf(a, null, '', x.title) || (a.c === 'frx' ? 'mfr' : 'rfr');
    add({ k: `mb${x.id}`, t: x.title, a: x.artist || a.n, f: [], d: x.date, rt: x.rt, c, n: 0, du: 0, lb: x.label || '', g: '', ex: 0, p: a.f * 0.9, s: ['mb'], mb: x.id }, [a.n, x.artist]);
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
    const c = catOf(a, null, '', x.title) || (a.c === 'rus' ? 'rus' : a.c === 'frx' || a.c === 'mfr' ? 'mfr' : 'rfr');
    const it = { k: `pr${x.aid}${x.date.replace(/-/g, '')}`, t: x.title, a: a.n, f: [], d: x.date, rt: x.rt, c, n: 0, du: 0, lb: '', g: '', ex: 0, p: a.f * 0.95, s: ['pr'], pl: x.link, po: x.outlet };
    items.push(it);
    list.push(it);
    byArtist.set(norm(a.n), list);
  }

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
  await writeFile(`${OUT}/state.json`, JSON.stringify(state));
  log(`terminé : ${items.length} sorties dont ${upcoming} à venir · requêtes ${JSON.stringify(stats)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
}
