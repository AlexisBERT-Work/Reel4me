import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGING, DRY } from './lib/config.mjs';
import { db, unwrap } from './lib/db.mjs';
import { logger } from './lib/log.mjs';
import { chunk, isMain } from './lib/util.mjs';

const log = logger('publish');
const CARDS_FILE = join(STAGING, 'cards.json');

export async function publish() {
  if (!existsSync(CARDS_FILE)) {
    log.warn('aucun cards.json en staging');
    return { published: 0, processed: 0 };
  }

  const staged = JSON.parse(readFileSync(CARDS_FILE, 'utf8'));
  const cards = staged.cards ?? [];
  const itemIds = staged.itemIds ?? [];

  if (DRY) {
    log.info(`--dry : ${cards.length} cartes seraient publiees, ${itemIds.length} items marques traites`);
    return { published: 0, processed: 0 };
  }

  let published = 0;
  for (const batch of chunk(cards, 100)) {
    // media_query, hero et youtube_id pilotent le pipeline, pas le front :
    // ce ne sont pas des colonnes de la table.
    const rows = batch.map(({ media_query, hero, youtube_id, ...row }) => row);
    const data = unwrap(
      await db().from('cards').upsert(rows, { onConflict: 'id' }).select('id'),
      'upsert cards',
    );
    published += data?.length ?? 0;
  }

  // Marque traite APRES publication : si la generation plante, les items
  // repassent dans le lot du lendemain au lieu d'etre perdus.
  let processed = 0;
  for (const batch of chunk(itemIds, 300)) {
    const data = unwrap(
      await db().from('items').update({ processed: true }).in('id', batch).select('id'),
      'marquage items',
    );
    processed += data?.length ?? 0;
  }

  writeFileSync(CARDS_FILE, JSON.stringify({ cards: [], itemIds: [] }, null, 2));
  log.info(`${published} cartes publiees, ${processed} items marques traites`);
  return { published, processed };
}

if (isMain(import.meta.url)) {
  publish()
    .then((r) => log.info(`termine : ${JSON.stringify(r)}`))
    .catch((err) => {
      log.error(err.message);
      process.exit(1);
    });
}
