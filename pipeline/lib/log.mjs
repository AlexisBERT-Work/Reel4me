import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOGS } from './config.mjs';

const day = new Date().toISOString().slice(0, 10);
const file = join(LOGS, `${day}.log`);

function write(level, scope, msg) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(file, line + '\n');
  } catch {
    // Un disque plein ne doit pas tuer le pipeline.
  }
}

export function logger(scope) {
  return {
    info: (msg) => write('info', scope, msg),
    warn: (msg) => write('warn', scope, msg),
    error: (msg) => write('error', scope, msg),
  };
}
