import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGING, DRY, config } from './lib/config.mjs';
import { logger } from './lib/log.mjs';
import { sha1, fetchWithRetry, sleep, isMain } from './lib/util.mjs';
import { ogImage } from './lib/opengraph.mjs';

const log = logger('media');

const CARDS_FILE = join(STAGING, 'cards.json');
const CACHE_FILE = join(STAGING, 'pexels-cache.json');

const PHOTO_URL = 'https://api.pexels.com/v1/search';
// L'API video vit sur /videos/search, pas sous /v1. On garde un repli au cas ou.
const VIDEO_URLS = ['https://api.pexels.com/videos/search', 'https://api.pexels.com/v1/videos/search'];

const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
let requests = 0;

function saveCache() {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

async function pexels(url, query, extra = '') {
  const key = `${url}|${query}|${extra}`;
  if (cache[key]) return cache[key];

  // 200 requetes/heure sur le palier gratuit. Un lot de 60 cartes en
  // consomme 60 au pire, mais on espace quand meme.
  if (requests > 0) await sleep(250);
  requests++;

  const res = await fetchWithRetry(
    `${url}?query=${encodeURIComponent(query)}&per_page=8&orientation=portrait${extra}`,
    { headers: { Authorization: config.pexelsKey } },
  );

  if (res.status === 429) throw new Error('quota Pexels atteint');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  cache[key] = json;
  return json;
}

/**
 * Choix deterministe : relancer le pipeline sur la meme carte redonne la
 * meme image, et deux cartes partageant une requete prennent des images
 * differentes.
 */
function pick(list, seed) {
  if (!list?.length) return null;
  return list[parseInt(sha1(seed).slice(0, 8), 16) % list.length];
}

async function resolvePhoto(card) {
  const json = await pexels(PHOTO_URL, card.media_query);
  const photo = pick(json.photos, card.id);
  if (!photo) return null;

  return {
    media_type: 'photo',
    // src.portrait fait 800x1200 : le bon ratio pour une carte plein ecran,
    // donc un recadrage "cover" ne perd rien d'important.
    media_fit: 'cover',
    media_url: photo.src?.portrait ?? photo.src?.large ?? photo.src?.original,
    media_poster: photo.src?.tiny ?? null,
    media_credit: `Photo : ${photo.photographer} / Pexels`,
    media_credit_url: photo.url,
  };
}

/**
 * Une video reellement liee au sujet, trouvee par Opus en mode harvest.
 * L'identifiant a deja ete valide contre le format officiel dans harvest.mjs.
 */
function resolveYouTube(card) {
  if (!card.youtube_id) return null;
  return {
    media_type: 'youtube',
    media_fit: 'cover',
    media_url: card.youtube_id,
    media_poster: `https://i.ytimg.com/vi/${card.youtube_id}/hqdefault.jpg`,
    media_credit: 'Vidéo : YouTube',
    media_credit_url: `https://www.youtube.com/watch?v=${card.youtube_id}`,
  };
}

/** L'image de partage de l'article : pertinente, mais souvent en 1200x630. */
async function resolveOg(card) {
  if (!card.source_url) return null;

  const found = await ogImage(card.source_url);
  if (!found) return null;

  return {
    media_type: 'photo',
    // "contain" : l'app affiche l'image entiere sur un fond floute plutot
    // que de decapiter un graphique ou un titre en la recadrant.
    media_fit: 'contain',
    media_url: found.url,
    media_poster: null,
    media_credit: found.site ?? card.source_name ?? null,
    media_credit_url: card.source_url,
  };
}

async function resolveVideo(card) {
  let json = null;
  for (const url of VIDEO_URLS) {
    try {
      json = await pexels(url, card.media_query, '&size=medium');
      break;
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) throw err;
    }
  }

  const video = pick(json?.videos, card.id);
  if (!video) return null;

  // Un mp4 vertical de qualite raisonnable, sans exploser le forfait data.
  const file = (video.video_files ?? [])
    .filter((f) => f.file_type === 'video/mp4' && f.height >= 640 && f.height <= 1400)
    .sort((a, b) => a.height - b.height)[0];
  if (!file) return null;

  return {
    media_type: 'video',
    media_fit: 'cover',
    media_url: file.link,
    media_poster: video.image ?? null,
    media_credit: `Vidéo : ${video.user?.name ?? 'Pexels'} / Pexels`,
    media_credit_url: video.url,
  };
}

export async function enrichMedia() {
  if (!existsSync(CARDS_FILE)) {
    log.warn('aucun cards.json en staging — lancer generate.mjs d\'abord');
    return { enriched: 0, fallback: 0 };
  }

  const staged = JSON.parse(readFileSync(CARDS_FILE, 'utf8'));
  const cards = staged.cards ?? [];
  if (!cards.length) return { enriched: 0, fallback: 0 };

  // Pexels n'est plus indispensable : sans cle, og:image fait encore le
  // travail sur la plupart des cartes, et le degrade absorbe le reste.
  let pexelsDown = !config.pexelsKey;
  if (pexelsDown) log.warn('PEXELS_API_KEY absent — repli sur og:image puis degrades');

  let enriched = 0;
  let fallback = 0;
  const used = { youtube: 0, video: 0, og: 0, photo: 0 };

  // Filet de securite generique, en plus du filtre sur le nom de fichier :
  // une og:image qui revient sur plusieurs cartes est l'image par defaut du
  // site, pas celle de l'article.
  const ogSeen = new Map();

  for (const card of cards) {
    // Ordre de preference : une video reellement liee au sujet, puis du
    // mouvement pour les heros, puis l'image publiee par l'article, et enfin
    // une photo de stock. Du plus pertinent au plus generique.
    const chain = [
      ['youtube', () => resolveYouTube(card)],
      ...(card.hero && !pexelsDown ? [['video', () => resolveVideo(card)]] : []),
      [
        'og',
        async () => {
          const found = await resolveOg(card);
          if (!found) return null;
          const seen = (ogSeen.get(found.media_url) ?? 0) + 1;
          ogSeen.set(found.media_url, seen);
          return seen > 2 ? null : found;
        },
      ],
      ...(pexelsDown ? [] : [['photo', () => resolvePhoto(card)]]),
    ];

    let media = null;
    for (const [kind, step] of chain) {
      try {
        media = await step();
        if (media) {
          used[kind]++;
          break;
        }
      } catch (err) {
        log.warn(`media ${kind} "${card.media_query}" : ${err.message}`);
        if (/quota/.test(err.message)) {
          log.warn('quota Pexels epuise, la suite se rabat sur og:image');
          pexelsDown = true;
        }
      }
    }

    if (media) {
      Object.assign(card, media);
      enriched++;
    } else {
      fallback++;
    }

    await sleep(120); // courtoisie envers les sites sources
  }

  log.info(
    `sources media : ${used.youtube} youtube, ${used.video} video, ${used.og} og:image, ${used.photo} stock`,
  );

  saveCache();
  log.info(`${enriched} cartes illustrees, ${fallback} en degrade, ${requests} appels Pexels`);

  if (DRY) {
    for (const card of cards.slice(0, 3)) {
      log.info(`  ${card.media_type} — ${card.media_url ?? '(degrade)'} — ${card.media_credit ?? ''}`);
    }
    log.info('--dry : staging non modifie');
    return { enriched, fallback };
  }

  writeFileSync(CARDS_FILE, JSON.stringify(staged, null, 2));
  return { enriched, fallback };
}

if (isMain(import.meta.url)) {
  enrichMedia()
    .then((r) => log.info(`termine : ${JSON.stringify(r)}`))
    .catch((err) => {
      log.error(err.message);
      process.exit(1);
    });
}
