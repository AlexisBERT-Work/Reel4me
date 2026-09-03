import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { ROOT, DRY, arg } from './lib/config.mjs';
import { db, unwrap } from './lib/db.mjs';
import { logger } from './lib/log.mjs';
import { sha1, canonical, fetchWithRetry, sleep, clamp, stripHtml, isMain } from './lib/util.mjs';

const log = logger('ingest');
const sources = JSON.parse(readFileSync(join(ROOT, 'sources.json'), 'utf8'));

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

/** fast-xml-parser rend un objet quand il n'y a qu'un element, un tableau sinon. */
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function makeItem({ source, sourceName, url, title, summary, topicHint, raw }) {
  const clean = canonical(url);
  return {
    id: sha1(clean),
    source,
    source_name: sourceName,
    url: clean,
    title: clamp(title, 300),
    summary: clamp(stripHtml(summary), 1200) || null,
    topic_hint: topicHint || null,
    raw: raw ?? null,
  };
}

/* --------------------------------------------------------- Hacker News */

async function fromHN(cfg) {
  const out = [];
  for (const q of cfg.queries) {
    const url = `https://hn.algolia.com/api/v1/${q.path}?${q.params}`;
    try {
      const res = await fetchWithRetry(url);
      const json = await res.json();
      for (const hit of json.hits ?? []) {
        if (!hit.title) continue;
        out.push(
          makeItem({
            source: 'hn',
            sourceName: 'Hacker News',
            // Les Ask HN / Show HN n'ont pas d'url externe : on pointe le fil.
            url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
            title: hit.title,
            summary: hit.story_text || hit._highlightResult?.title?.value || '',
            raw: {
              points: hit.points ?? 0,
              comments: hit.num_comments ?? 0,
              hn_url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
              created_at: hit.created_at,
            },
          }),
        );
      }
      log.info(`HN ${q.path} : ${json.hits?.length ?? 0} hits`);
    } catch (err) {
      log.warn(`HN ${q.path} indisponible : ${err.message}`);
    }
  }
  return out;
}

/* --------------------------------------------------------------- arXiv */

async function fromArxiv(cfg) {
  // URLSearchParams encoderait le '+' des OR en %2B, ce que l'API arXiv
  // refuse. La query est donc construite a la main.
  const query = cfg.categories.map((c) => `cat:${c}`).join('+OR+');
  const url =
    `https://export.arxiv.org/api/query?search_query=${query}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${cfg.maxResults}`;

  try {
    const res = await fetchWithRetry(url);
    const feed = parser.parse(await res.text())?.feed;
    const entries = list(feed?.entry);
    log.info(`arXiv : ${entries.length} entrees`);

    return entries.map((e) => {
      const authors = list(e.author)
        .map((a) => a?.name)
        .filter(Boolean);
      return makeItem({
        source: 'arxiv',
        sourceName: 'arXiv',
        url: typeof e.id === 'string' ? e.id : e.id?.['#text'],
        title: String(e.title ?? '').replace(/\s+/g, ' '),
        summary: String(e.summary ?? ''),
        topicHint: 'ai',
        raw: { authors: authors.slice(0, 5), published: e.published },
      });
    });
  } catch (err) {
    log.warn(`arXiv indisponible : ${err.message}`);
    return [];
  }
}

/* ----------------------------------------------------------------- RSS */

/** Accepte indifferemment RSS 2.0 (channel/item) et Atom (feed/entry). */
function parseFeed(xml, feed) {
  const doc = parser.parse(xml);
  const rssItems = list(doc?.rss?.channel?.item);
  const atomEntries = list(doc?.feed?.entry);

  const rows = rssItems.length ? rssItems : atomEntries;
  const isAtom = !rssItems.length;

  return rows
    .map((row) => {
      let url;
      if (isAtom) {
        const links = list(row.link);
        const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
        url = alt?.['@_href'] ?? (typeof alt === 'string' ? alt : null);
      } else {
        url = typeof row.link === 'string' ? row.link : row.link?.['#text'] ?? row.guid?.['#text'] ?? row.guid;
      }
      if (!url) return null;

      const title = typeof row.title === 'string' ? row.title : row.title?.['#text'];
      if (!title) return null;

      const summary =
        row.description ?? row.summary ?? row['content:encoded'] ?? row.content?.['#text'] ?? row.content ?? '';

      return makeItem({
        source: 'rss',
        sourceName: feed.name,
        url,
        title: String(title),
        summary: typeof summary === 'string' ? summary : '',
        topicHint: feed.topic,
        raw: { published: row.pubDate ?? row.published ?? row.updated ?? null },
      });
    })
    .filter(Boolean)
    .slice(0, 12); // un blog tres prolifique ne doit pas noyer les autres
}

async function fromRSS(cfg) {
  const out = [];
  for (const feed of cfg.feeds) {
    try {
      const res = await fetchWithRetry(feed.url, {
        headers: { 'user-agent': 'Reel4me/1.0 (personal feed reader)' },
      });
      if (!res.ok) {
        log.warn(`${feed.name} : HTTP ${res.status}`);
        continue;
      }
      const items = parseFeed(await res.text(), feed);
      log.info(`${feed.name} : ${items.length} entrees`);
      out.push(...items);
    } catch (err) {
      log.warn(`${feed.name} indisponible : ${err.message}`);
    }
    await sleep(300); // courtoisie envers les petits blogs
  }
  return out;
}

/* ----------------------------------------------------------------- run */

export async function ingest() {
  const collected = [];

  if (sources.hn?.enabled) collected.push(...(await fromHN(sources.hn)));
  if (sources.arxiv?.enabled) collected.push(...(await fromArxiv(sources.arxiv)));
  if (sources.rss?.enabled) collected.push(...(await fromRSS(sources.rss)));

  // Dedup intra-lot : le meme article peut arriver par HN et par RSS.
  const unique = [...new Map(collected.map((i) => [i.id, i])).values()];
  log.info(`${collected.length} items collectes, ${unique.length} uniques`);

  if (DRY) {
    log.info('--dry : rien n\'est ecrit');
    for (const item of unique.slice(0, 5)) {
      log.info(`  [${item.source_name}] ${clamp(item.title, 80)}`);
    }
    return { collected: collected.length, unique: unique.length, inserted: 0 };
  }

  if (!unique.length) return { collected: 0, unique: 0, inserted: 0 };

  // onConflict + ignoreDuplicates : les items deja vus gardent leur flag
  // processed, on ne les repasse donc jamais dans le generateur.
  const inserted = [];
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    const data = unwrap(
      await db().from('items').upsert(batch, { onConflict: 'id', ignoreDuplicates: true }).select('id'),
      'upsert items',
    );
    inserted.push(...(data ?? []));
  }

  log.info(`${inserted.length} nouveaux items inseres`);
  return { collected: collected.length, unique: unique.length, inserted: inserted.length };
}

if (isMain(import.meta.url)) {
  ingest()
    .then((r) => log.info(`termine : ${JSON.stringify(r)}`))
    .catch((err) => {
      log.error(err.message);
      process.exit(1);
    });
}
