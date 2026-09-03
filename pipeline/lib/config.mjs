import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STAGING = join(ROOT, '.staging');
export const LOGS = join(ROOT, 'logs');

// Node 22 lit le .env nativement. Pas de dependance dotenv, et surtout pas de
// --env-file dans les scripts : le Planificateur de taches lance run.mjs
// directement, sans passer par npm.
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

mkdirSync(STAGING, { recursive: true });
mkdirSync(LOGS, { recursive: true });

/** Lit `--nom valeur` dans argv. */
export function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

/** Lit `--nom` (booleen). */
export function has(name) {
  return process.argv.includes(`--${name}`);
}

export const DRY = has('dry');

export const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  pexelsKey: process.env.PEXELS_API_KEY,
  llmBackend: process.env.LLM_BACKEND || 'claude-code',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeBin: process.env.CLAUDE_BIN || process.env.CLAUDE_CODE_CLI_JS,
};

/** Echoue tot et clairement plutot que de planter au premier appel reseau. */
export function requireEnv(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    const names = {
      supabaseUrl: 'SUPABASE_URL',
      supabaseServiceKey: 'SUPABASE_SERVICE_KEY',
      pexelsKey: 'PEXELS_API_KEY',
      anthropicApiKey: 'ANTHROPIC_API_KEY',
    };
    throw new Error(
      `Variables manquantes dans pipeline/.env : ${missing.map((m) => names[m] || m).join(', ')}\n` +
        `Copier .env.example en .env et remplir.`,
    );
  }
}
