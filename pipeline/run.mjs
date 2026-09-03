import { logger } from './lib/log.mjs';
import { ingest } from './ingest.mjs';
import { generate } from './generate.mjs';
import { enrichMedia } from './media.mjs';
import { publish } from './publish.mjs';
import { DRY } from './lib/config.mjs';

const log = logger('run');

const STEPS = [
  ['ingest', ingest],
  ['generate', generate],
  ['media', enrichMedia],
  ['publish', publish],
];

const started = Date.now();
log.info(`--- pipeline Reel4me ${DRY ? '(dry run)' : ''} ---`);

for (const [name, step] of STEPS) {
  const t0 = Date.now();
  try {
    const result = await step();
    log.info(`${name} ok en ${((Date.now() - t0) / 1000).toFixed(1)}s : ${JSON.stringify(result)}`);
  } catch (err) {
    // Un echec d'etape est fatal : publier des cartes sans images ou
    // marquer des items traites sans les avoir publies casse l'invariant.
    log.error(`${name} a echoue : ${err.message}`);
    log.error('pipeline interrompu, rien de destructif n\'a ete fait');
    process.exit(1);
  }
}

log.info(`--- termine en ${((Date.now() - started) / 1000).toFixed(1)}s ---`);
