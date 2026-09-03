import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, STAGING, DRY, arg, has } from './lib/config.mjs';
import { db, unwrap } from './lib/db.mjs';
import { logger } from './lib/log.mjs';
import { sha1, chunk, clamp, isMain } from './lib/util.mjs';
import { generateStructured } from './llm.js';

const log = logger('generate');

// --sample : items en dur, aucune dependance a Supabase. Sert a valider la
// chaine claude -p / --json-schema / structured_output avant tout le reste.
const SAMPLE = has('sample');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema.json'), 'utf8'));

const BATCH_SIZE = 20;
const DEFAULT_LIMIT = 60;
const MAX_HERO_RATIO = 0.2;

const SYSTEM_PROMPT = `Tu es l'editeur d'un feed de cartes de savoir, lu au telephone par un developpeur francophone qui suit l'IA, le dev, le business et la productivite.

Regles d'ecriture, non negociables :
- Ecris en francais. Les termes techniques restent en anglais quand c'est l'usage (prompt caching, latency, churn, embedding).
- Le titre est une affirmation concrete qui tient debout sans l'article. Jamais une question, jamais le titre de la source recopie.
- Le corps donne le mecanisme ou le chiffre : POURQUOI c'est vrai. Si la source ne le dit pas, mets skip a true plutot que de meubler.
- N'invente jamais un chiffre, un nom ou une date absents de la source.
- Si la source annonce un resultat preliminaire ou un benchmark unique, dis-le explicitement.
- Bannis : "revolutionnaire", "game changer", "incontournable", "a l'ere de", "dans un monde ou", "il est important de noter", "plongeons dans".
- Le takeaway est actionnable ou memorable, pas un resume du corps.

Mets skip a true pour : offres d'emploi, annonces de levee de fonds, changelogs sans idee, polemiques et drama, articles dont tu n'as que le titre sans matiere exploitable.
Mieux vaut 12 bonnes cartes que 20 tiedes.`;

/* ------------------------------------------------- boucle de retour */

/**
 * Transforme les interactions du telephone en consignes pour le prompt.
 * C'est ce qui differencie le feed d'un simple resumeur de RSS.
 */
async function buildProfile() {
  if (SAMPLE) return null;
  const since = new Date(Date.now() - 14 * 864e5).toISOString();

  let rows;
  try {
    rows = unwrap(
      await db()
        .from('interactions')
        .select('action, dwell_ms, cards(topic, title)')
        .gte('created_at', since)
        .limit(2000),
      'lecture interactions',
    );
  } catch (err) {
    log.warn(`profil indisponible (${err.message}) — generation non ponderee`);
    return null;
  }

  const usable = (rows ?? []).filter((r) => r.cards);
  if (usable.length < 15) {
    log.info(`profil : ${usable.length} interactions, trop peu pour ponderer`);
    return null;
  }

  const topics = new Map();
  const words = new Map();
  const STOP = new Set(
    ('le la les un une des de du et ou a au aux en dans pour par sur avec sans que qui quoi ce cet cette ' +
      'son sa ses leur leurs est sont etre plus moins tout tous the a an of to in for on with and or is are')
      .split(' '),
  );

  for (const row of usable) {
    const positive = row.action === 'kept' || row.action === 'opened' || row.action === 'more';
    const negative = row.action === 'skipped' || row.action === 'less';
    if (!positive && !negative) continue;

    const t = topics.get(row.cards.topic) ?? { up: 0, down: 0 };
    positive ? t.up++ : t.down++;
    topics.set(row.cards.topic, t);

    for (const w of row.cards.title.toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ0-9-]{3,}/g) ?? []) {
      if (STOP.has(w)) continue;
      const s = words.get(w) ?? { up: 0, down: 0 };
      positive ? s.up++ : s.down++;
      words.set(w, s);
    }
  }

  const rate = ([, v]) => v.up / (v.up + v.down);
  const ranked = [...topics.entries()].filter(([, v]) => v.up + v.down >= 3).sort((a, b) => rate(b) - rate(a));

  const hot = [...words.entries()]
    .filter(([, v]) => v.up >= 2 && v.up > v.down)
    .sort((a, b) => b.up - a.up)
    .slice(0, 8)
    .map(([w]) => w);

  const cold = [...words.entries()]
    .filter(([, v]) => v.down >= 3 && v.down > v.up * 2)
    .sort((a, b) => b.down - a.down)
    .slice(0, 8)
    .map(([w]) => w);

  const lines = [];
  if (ranked.length) {
    lines.push(
      'Retention par sujet sur 14 jours : ' +
        ranked.map(([k, v]) => `${k} ${Math.round(rate([k, v]) * 100)}%`).join(', ') +
        '. Donne plus de place aux sujets du haut.',
    );
  }
  if (hot.length) lines.push(`Themes qui accrochent : ${hot.join(', ')}.`);
  if (cold.length) lines.push(`Themes systematiquement passes, a eviter : ${cold.join(', ')}.`);

  log.info(`profil construit sur ${usable.length} interactions`);
  return lines.join('\n');
}

/* ----------------------------------------------------------- sources */

const SAMPLE_ITEMS = [
  {
    id: sha1('sample:prompt-caching'),
    source: 'rss',
    source_name: 'Cloudflare Blog',
    url: 'https://example.invalid/prompt-caching',
    title: 'How we cut LLM inference costs by 78% with prefix caching',
    summary:
      'Our gateway re-sends the same 12k-token system prompt on every request. By keeping the prefix byte-identical and caching it, cache reads cost about a tenth of a fresh input token. Hit rate went from 0% to 94% after we moved the request timestamp out of the system prompt and into the user turn. Median latency dropped from 2.1s to 0.6s.',
    topic_hint: 'dev',
    raw: null,
  },
  {
    id: sha1('sample:hiring'),
    source: 'hn',
    source_name: 'Hacker News',
    url: 'https://example.invalid/hiring',
    title: 'Acme (YC W24) is hiring a senior backend engineer, remote EU',
    summary: 'We are a seed-stage startup building developer tools. Competitive salary and equity.',
    topic_hint: null,
    raw: { points: 3, comments: 0 },
  },
  {
    id: sha1('sample:arxiv-context'),
    source: 'arxiv',
    source_name: 'arXiv',
    url: 'https://example.invalid/arxiv-context',
    title: 'Lost in the Middle: How Language Models Use Long Contexts',
    summary:
      'We analyze performance across input position on multi-document QA. Models are markedly better at using information at the very beginning or very end of the input context, and degrade substantially when relevant information sits in the middle. The effect persists even in models explicitly trained for long contexts, and holds across model sizes from 7B to 70B.',
    topic_hint: 'ai',
    raw: { authors: ['Liu', 'Lin'] },
  },
];

async function loadItems(limit) {
  if (SAMPLE) return SAMPLE_ITEMS.slice(0, limit);
  return (
    unwrap(
      await db()
        .from('items')
        .select('id, source, source_name, url, title, summary, topic_hint, raw')
        .eq('processed', false)
        .order('fetched_at', { ascending: false })
        .limit(limit),
      'lecture items',
    ) ?? []
  );
}

async function loadRecentTitles() {
  if (SAMPLE) return [];
  const data = unwrap(
    await db().from('cards').select('title').order('created_at', { ascending: false }).limit(60),
    'lecture titres recents',
  );
  return (data ?? []).map((c) => c.title);
}

/* -------------------------------------------------------- generation */

function buildPrompt({ count, profile, recentTitles }) {
  const parts = [
    `Voici ${count} items bruts issus de Hacker News, arXiv et de blogs d'ingenierie, au format JSON sur l'entree standard.`,
    `Produis une carte par item exploitable. Pour les items sans matiere, renvoie quand meme l'objet avec skip a true.`,
    `Recopie item_id a l'identique depuis l'entree, c'est la cle de rattachement.`,
    `Marque hero a true pour au plus 1 carte sur 5 : celles dont l'idee est la plus forte visuellement.`,
  ];

  if (profile) {
    parts.push(`\nCe que l'historique de lecture indique :\n${profile}`);
  } else {
    parts.push(`\nPas encore assez d'historique de lecture : couvre large, varie les sujets et les sources.`);
  }

  if (recentTitles.length) {
    parts.push(
      `\nCartes deja publiees recemment. N'y reviens pas, meme sous un autre angle :\n` +
        recentTitles.map((t) => `- ${t}`).join('\n'),
    );
  }

  return parts.join('\n');
}

/** Ne fait pas confiance au modele : valide, borne et deduplique. */
function normalize(raw, itemsById, seenTitles) {
  const out = [];

  for (const card of raw?.cards ?? []) {
    if (card.skip) continue;

    const item = itemsById.get(card.item_id);
    if (!item) {
      log.warn(`item_id inconnu, carte ignoree : ${card.item_id}`);
      continue;
    }

    const title = clamp(card.title, 70);
    const key = title.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, '');
    if (!title || !card.body || seenTitles.has(key)) continue;
    seenTitles.add(key);

    out.push({
      id: sha1(`${item.id}:${title}`),
      item_id: item.id,
      topic: card.topic,
      title,
      body: clamp(card.body, 340),
      takeaway: clamp(card.takeaway, 130) || null,
      source_url: item.url,
      source_name: item.source_name,
      media_query: clamp(card.media_query, 60),
      hero: Boolean(card.hero),
      media_type: 'gradient',
      media_url: null,
      media_poster: null,
      media_credit: null,
      media_credit_url: null,
    });
  }

  return out;
}

export async function generate() {
  const limit = Number(arg('limit', DEFAULT_LIMIT)) || DEFAULT_LIMIT;

  const [items, recentTitles, profile] = await Promise.all([
    loadItems(limit),
    loadRecentTitles(),
    buildProfile(),
  ]);

  if (!items.length) {
    log.info('aucun item non traite — rien a generer');
    writeFileSync(join(STAGING, 'cards.json'), JSON.stringify({ cards: [], itemIds: [] }, null, 2));
    return { items: 0, cards: 0 };
  }

  log.info(`${items.length} items a traiter, ${recentTitles.length} titres recents en anti-repetition`);

  const itemsById = new Map(items.map((i) => [i.id, i]));
  const seenTitles = new Set(recentTitles.map((t) => t.toLowerCase().replace(/[^a-zà-ÿ0-9]/g, '')));
  const cards = [];

  for (const [index, batch] of chunk(items, BATCH_SIZE).entries()) {
    const payload = batch.map((i) => ({
      item_id: i.id,
      source: i.source_name,
      title: i.title,
      summary: i.summary,
      url: i.url,
      topic_hint: i.topic_hint,
      signals: i.raw,
    }));

    log.info(`lot ${index + 1} : ${batch.length} items…`);
    try {
      const { output, costUsd } = await generateStructured({
        prompt: buildPrompt({ count: batch.length, profile, recentTitles }),
        stdin: JSON.stringify(payload, null, 1),
        schema,
        systemPrompt: SYSTEM_PROMPT,
      });
      const produced = normalize(output, itemsById, seenTitles);
      log.info(
        `lot ${index + 1} : ${produced.length} cartes retenues sur ${batch.length} items ` +
          `(~${costUsd.toFixed(3)} $ de quota estimes)`,
      );
      cards.push(...produced);
    } catch (err) {
      log.error(`lot ${index + 1} echoue : ${err.message}`);
      // Un lot rate ne doit pas perdre les lots precedents.
    }
  }

  // Borne le nombre de heros meme si le modele s'est emballe.
  const maxHero = Math.ceil(cards.length * MAX_HERO_RATIO);
  let heroCount = 0;
  for (const card of cards) {
    if (card.hero && ++heroCount > maxHero) card.hero = false;
  }

  log.info(`${cards.length} cartes generees (${Math.min(heroCount, maxHero)} heros)`);

  if (DRY) {
    for (const card of cards.slice(0, 3)) {
      console.log(`\n  ${card.hero ? '★' : '·'} [${card.topic}] ${card.title}`);
      console.log(`    ${card.body}`);
      console.log(`    → ${card.takeaway}`);
      console.log(`    img: "${card.media_query}"  src: ${card.source_name}`);
    }
    log.info('--dry : rien n\'est ecrit');
    return { items: items.length, cards: cards.length };
  }

  writeFileSync(
    join(STAGING, 'cards.json'),
    JSON.stringify({ cards, itemIds: items.map((i) => i.id) }, null, 2),
  );
  return { items: items.length, cards: cards.length };
}

if (isMain(import.meta.url)) {
  generate()
    .then((r) => log.info(`termine : ${JSON.stringify(r)}`))
    .catch((err) => {
      log.error(err.message);
      process.exit(1);
    });
}
