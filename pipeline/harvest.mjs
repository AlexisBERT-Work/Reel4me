/**
 * Mode "burn" : a lancer a la main quand il reste du quota d'abonnement.
 *
 * Contrairement a generate.mjs, qui se contente de reecrire ce que ingest.mjs
 * a collecte, harvest laisse Opus CHERCHER lui-meme sur le web. Il tourne en
 * rounds successifs et ne s'arrete que sur l'une de ces trois conditions :
 * budget estime atteint, nombre de rounds atteint, ou plafond d'usage renvoye
 * par l'API. Le but est justement de vider ce qui reste de la session.
 *
 *   node harvest.mjs                          # 20 rounds, ~20 $ de quota
 *   node harvest.mjs --budget 5 --rounds 6
 *   node harvest.mjs --dry                    # une seule salve, rien d'ecrit
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, STAGING, DRY, arg, config } from './lib/config.mjs';
import { db, unwrap } from './lib/db.mjs';
import { logger } from './lib/log.mjs';
import { sha1, clamp, isMain } from './lib/util.mjs';
import { generateStructured, isQuotaError } from './llm.js';
import { enrichMedia } from './media.mjs';
import { publish } from './publish.mjs';

const log = logger('harvest');
const schema = JSON.parse(readFileSync(join(ROOT, 'harvest-schema.json'), 'utf8'));

const DEFAULTS = { budget: 20, rounds: 20, perRound: 8 };
const ROUND_TIMEOUT_MS = 900000; // 15 min : la recherche web peut etre lente.

const SYSTEM_PROMPT = `Tu es le chercheur de fond d'un feed de cartes de savoir, lu au telephone par un developpeur francophone qui suit l'IA, le dev, le business et la productivite.

Ton travail : partir a la recherche de choses reellement interessantes sur le web, puis les condenser en cartes. Tu as WebSearch et WebFetch. Sers-t'en vraiment : cherche, ouvre les pages, verifie. Une carte dont tu n'as pas lu la source n'a pas lieu d'exister.

Regles d'ecriture, non negociables :
- Ecris en francais. Les termes techniques restent en anglais quand c'est l'usage (prompt caching, latency, churn, embedding).
- Le titre est une affirmation concrete qui tient debout sans l'article. Jamais une question, jamais un titre d'article recopie.
- Le corps donne le mecanisme ou le chiffre : POURQUOI c'est vrai.
- N'invente jamais un chiffre, un nom, une date ou une URL. source_url doit etre une page que tu as reellement ouverte.
- Bannis : "revolutionnaire", "game changer", "incontournable", "a l'ere de", "dans un monde ou", "il est important de noter", "plongeons dans".
- Le takeaway est actionnable ou memorable, pas un resume du corps.

Sur youtube_url : ne le remplis que si tu es tombe sur une video precise et vraiment pertinente en cherchant. Une chaine vide est un resultat parfaitement acceptable, et de loin preferable a un identifiant devine.

Mieux vaut 5 cartes solides que 8 tiedes.`;

/**
 * Chaque round explore un angle different. Sans ca, Opus repart vers les
 * memes sujets d'actualite a chaque salve et le lot devient monotone.
 */
const ANGLES = [
  'des resultats de recherche recents (papers, benchmarks, evaluations) qui changent une pratique concrete',
  "des post-mortems, retours d'incident et lecons d'ingenierie tirees de systemes en production",
  'des chiffres precis et mesures publiees qui contredisent une intuition repandue',
  'des techniques ou outils concrets, peu connus, applicables cette semaine',
  "des decisions d'architecture et leurs compromis, racontees par ceux qui les ont prises",
  'des modeles economiques, strategies produit et mecaniques de croissance expliques par les chiffres',
  'des anti-patterns et erreurs classiques, avec la raison profonde pour laquelle on y retombe',
  'des avancees en IA appliquee : ce qui marche reellement en production, pas les annonces',
  "des methodes de travail et d'organisation validees par des donnees, pas par des opinions",
  "de l'histoire de l'informatique et des idees anciennes redevenues pertinentes",
];

async function loadContext() {
  // Permet de tester la chaine Opus + recherche web avant meme que Supabase
  // existe. Sans base, pas d'anti-repetition : reserve au --dry.
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    log.warn('Supabase non configure — recolte sans anti-repetition');
    return { titles: [], urls: new Set() };
  }

  const [titles, urls] = await Promise.all([
    db().from('cards').select('title').order('created_at', { ascending: false }).limit(200),
    db().from('cards').select('source_url').order('created_at', { ascending: false }).limit(600),
  ]);

  return {
    titles: (unwrap(titles, 'titres recents') ?? []).map((c) => c.title),
    urls: new Set((unwrap(urls, 'urls recentes') ?? []).map((c) => c.source_url).filter(Boolean)),
  };
}

function buildPrompt({ angle, count, recentTitles }) {
  const parts = [
    `Cherche sur le web ${angle}.`,
    '',
    `Produis ${count} cartes au maximum. Prends le temps de chercher et d'ouvrir les pages avant d'ecrire.`,
    `Varie les sources : ne prends pas ${count} cartes sur le meme site ni sur le meme sujet.`,
    'Privilegie ce qui a moins de 12 mois, sauf si une idee intemporelle est vraiment forte.',
  ];

  if (recentTitles.length) {
    parts.push(
      '',
      "Cartes deja publiees. N'y reviens pas, meme sous un autre angle :",
      recentTitles
        .slice(0, 120)
        .map((t) => `- ${t}`)
        .join('\n'),
    );
  }

  return parts.join('\n');
}

const YOUTUBE_RE =
  /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** Ne fait pas confiance au modele : valide les URL, borne les longueurs. */
function normalize(output, { seenTitles, seenUrls }) {
  const cards = [];

  for (const card of output?.cards ?? []) {
    let url;
    try {
      url = new URL(card.source_url);
      if (!/^https?:$/.test(url.protocol)) continue;
    } catch {
      log.warn(`source_url invalide, carte ignoree : ${card.source_url}`);
      continue;
    }

    const href = url.toString();
    if (seenUrls.has(href)) continue;

    const title = clamp(card.title, 70);
    const key = title.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, '');
    if (!title || !card.body || seenTitles.has(key)) continue;

    seenTitles.add(key);
    seenUrls.add(href);

    // Un identifiant YouTube devine donne une video morte : on n'accepte que
    // ce qui correspond exactement au format officiel.
    const youtubeId = card.youtube_url ? (YOUTUBE_RE.exec(card.youtube_url)?.[1] ?? null) : null;

    cards.push({
      id: sha1(`${href}:${title}`),
      item_id: null,
      topic: card.topic,
      title,
      body: clamp(card.body, 340),
      takeaway: clamp(card.takeaway, 130) || null,
      source_url: href,
      source_name: clamp(card.source_name, 60) || url.hostname.replace(/^www\./, ''),
      media_query: clamp(card.media_query, 60),
      hero: Boolean(card.hero),
      youtube_id: youtubeId,
      media_type: 'gradient',
      media_fit: 'cover',
      media_url: null,
      media_poster: null,
      media_credit: null,
      media_credit_url: null,
    });
  }

  return cards;
}

export async function harvest() {
  const budget = Number(arg('budget', DEFAULTS.budget)) || DEFAULTS.budget;
  const maxRounds = DRY ? 1 : Number(arg('rounds', DEFAULTS.rounds)) || DEFAULTS.rounds;
  const perRound = Number(arg('per-round', DEFAULTS.perRound)) || DEFAULTS.perRound;

  const { titles, urls } = await loadContext();
  const seenTitles = new Set(titles.map((t) => t.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, '')));
  const seenUrls = urls;

  log.info(
    `harvest : jusqu'a ${maxRounds} rounds x ${perRound} cartes, budget ~${budget} $ de quota, ` +
      `${titles.length} titres et ${urls.size} URL deja connus`,
  );

  const cards = [];
  let spent = 0;
  let stopReason = 'rounds epuises';

  for (let round = 0; round < maxRounds; round++) {
    if (spent >= budget) {
      stopReason = 'budget atteint';
      break;
    }

    const angle = ANGLES[round % ANGLES.length];
    log.info(`round ${round + 1}/${maxRounds} — ${angle.slice(0, 60)}… (${spent.toFixed(2)}/${budget} $)`);

    try {
      const { output, costUsd } = await generateStructured({
        prompt: buildPrompt({ angle, count: perRound, recentTitles: titles }),
        schema,
        systemPrompt: SYSTEM_PROMPT,
        model: process.env.HARVEST_MODEL || 'opus',
        allowedTools: ['WebSearch', 'WebFetch'],
        timeoutMs: ROUND_TIMEOUT_MS,
      });

      spent += costUsd;
      const produced = normalize(output, { seenTitles, seenUrls });
      cards.push(...produced);
      log.info(`round ${round + 1} : +${produced.length} cartes (total ${cards.length}, ~${spent.toFixed(2)} $)`);
    } catch (err) {
      if (isQuotaError(err.message)) {
        // C'est la fin normale du mode burn, pas un echec.
        stopReason = 'plafond de quota atteint';
        log.info(`round ${round + 1} : quota epuise, arret propre`);
        break;
      }
      log.error(`round ${round + 1} echoue : ${err.message}`);
      stopReason = 'erreur';
      // Un round rate ne doit pas perdre les precedents : on continue.
    }
  }

  // Borne les heros meme si le modele s'est emballe sur plusieurs rounds.
  const maxHero = Math.ceil(cards.length * 0.2);
  let heroes = 0;
  for (const card of cards) {
    if (card.hero && ++heroes > maxHero) card.hero = false;
  }

  log.info(`${cards.length} cartes recoltees, ~${spent.toFixed(2)} $ de quota estimes (${stopReason})`);

  if (DRY) {
    for (const card of cards.slice(0, 5)) {
      console.log(`\n  ${card.hero ? '★' : '·'} [${card.topic}] ${card.title}`);
      console.log(`    ${card.body}`);
      console.log(`    → ${card.takeaway}`);
      console.log(`    ${card.source_name} — ${card.source_url}`);
      if (card.youtube_id) console.log(`    youtube: ${card.youtube_id}`);
    }
    log.info("--dry : rien n'est ecrit");
    return { cards: cards.length, spent: Number(spent.toFixed(3)), stopReason };
  }

  writeFileSync(join(STAGING, 'cards.json'), JSON.stringify({ cards, itemIds: [] }, null, 2));

  // harvest fait le trajet complet : sans ca, il faudrait enchainer trois
  // commandes a la main apres une recolte qui peut durer une heure.
  await enrichMedia();
  const published = await publish();

  return { cards: cards.length, spent: Number(spent.toFixed(3)), stopReason, ...published };
}

if (isMain(import.meta.url)) {
  harvest()
    .then((r) => log.info(`termine : ${JSON.stringify(r)}`))
    .catch((err) => {
      log.error(err.message);
      process.exit(1);
    });
}
