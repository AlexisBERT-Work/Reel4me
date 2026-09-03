import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './lib/config.mjs';
import { logger } from './lib/log.mjs';

const log = logger('llm');

/* ------------------------------------------------------------------ *
 * Backend 1 — Claude Code headless (abonnement Max, 0 EUR)
 * ------------------------------------------------------------------ */

let cachedCli = null;

const WIN = process.platform === 'win32';

/**
 * Localise l'executable Claude Code et retourne de quoi le lancer.
 *
 * Pourquoi ne pas simplement spawn('claude') : sous Windows, npm pose un shim
 * `claude.cmd`, et child_process.spawn ne resout pas les .cmd sans
 * shell: true. Or shell: true fait passer les arguments par cmd.exe, qui
 * massacre les guillemets du JSON Schema. On vise donc toujours un binaire
 * reel — aucun shell, aucun probleme de quoting.
 *
 * Depuis la 2.1.x le package livre un binaire natif (bin/claude.exe). Les
 * versions plus anciennes livraient un cli.js a passer a node : les deux
 * formes sont gerees.
 */
function resolveCli() {
  if (cachedCli) return cachedCli;

  /** @type {Array<{file: string, prefixArgs: string[]}>} */
  const candidates = [];
  const add = (p, viaNode = false) => {
    if (p) candidates.push(viaNode ? { file: process.execPath, prefixArgs: [p], probe: p } : { file: p, prefixArgs: [], probe: p });
  };

  if (config.claudeBin) add(config.claudeBin, config.claudeBin.endsWith('.js'));

  const roots = [];
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      shell: WIN,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (globalRoot) roots.push(globalRoot);
  } catch {
    // npm absent du PATH : on tente quand meme les emplacements connus.
  }

  if (WIN) {
    roots.push(join(process.env.APPDATA || '', 'npm', 'node_modules'));
  } else {
    roots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules');
  }
  roots.push(join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'local', 'node_modules'));

  for (const root of roots) {
    const pkg = join(root, '@anthropic-ai', 'claude-code');
    add(join(pkg, 'bin', WIN ? 'claude.exe' : 'claude'));  // packaging natif (2.1+)
    add(join(pkg, 'cli.js'), true);                        // packaging historique
  }

  const found = candidates.find((c) => existsSync(c.probe));
  if (!found) {
    throw new Error(
      'Claude Code introuvable. Installer avec :\n' +
        '  npm i -g @anthropic-ai/claude-code\n' +
        'puis lancer `claude` une fois pour valider le login.\n' +
        'Si le chemin est inhabituel, renseigner CLAUDE_BIN dans pipeline/.env.',
    );
  }

  cachedCli = found;
  log.info(`Claude Code : ${found.probe}`);
  return found;
}

/** Vrai si l'echec vient d'un plafond d'usage plutot que d'une vraie erreur. */
export function isQuotaError(message) {
  return /rate.?limit|usage limit|quota|too many requests|429|limit reached/i.test(String(message));
}

function runClaudeCode({ prompt, stdin, schema, systemPrompt, model, allowedTools, timeoutMs }) {
  const { file, prefixArgs } = resolveCli();

  // Pas de --bare : le mode bare ignore les identifiants OAuth et exige
  // ANTHROPIC_API_KEY. C'est precisement ce qu'on veut eviter ici.
  const args = [
    ...prefixArgs,
    '-p',
    prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--permission-mode',
    'dontAsk',
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  // dontAsk refuse tout ce qui n'est pas explicitement autorise : sans cette
  // ligne, la recherche web du mode harvest serait bloquee sans message.
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));

  const chosen = model || process.env.CLAUDE_MODEL;
  if (chosen) args.push('--model', chosen);

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude -p : timeout apres ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Lancement de Claude Code impossible : ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude -p a quitte avec le code ${code}\n${err.trim() || out.trim()}`));
      }

      let payload;
      try {
        payload = JSON.parse(out);
      } catch {
        return reject(new Error(`Sortie de claude -p illisible :\n${out.slice(0, 500)}`));
      }

      if (payload.is_error) {
        // L'echec d'authentification arrive ici, pas sur stderr.
        return reject(new Error(`Claude Code a echoue : ${payload.result || 'raison inconnue'}`));
      }
      if (!payload.structured_output) {
        return reject(new Error(`Pas de structured_output. Resultat brut :\n${String(payload.result).slice(0, 500)}`));
      }

      // total_cost_usd est une estimation client, affichee meme sous
      // abonnement. Ce n'est pas une facture : c'est la jauge qui sert au
      // mode harvest pour savoir quand s'arreter.
      resolve({
        output: payload.structured_output,
        costUsd: payload.total_cost_usd ?? 0,
        sessionId: payload.session_id ?? null,
      });
    });

    child.stdin.end(stdin ?? '');
  });
}

/* ------------------------------------------------------------------ *
 * Backend 2 — API Anthropic (Haiku 4.5, ~2 EUR/mois)
 * Filet de secours si le PC ne peut plus tourner la nuit.
 * ------------------------------------------------------------------ */

async function runApi({ prompt, stdin, schema, systemPrompt, model }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => {
    throw new Error("LLM_BACKEND=api necessite : npm i @anthropic-ai/sdk (dans pipeline/)");
  });

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `${prompt}\n\n${stdin ?? ''}` }],
    output_config: { format: { type: 'json_schema', schema } },
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const usage = response.usage ?? {};
  try {
    return {
      output: JSON.parse(text),
      // Tarif Haiku 4.5 : 1 $ / MTok en entree, 5 $ en sortie.
      costUsd: ((usage.input_tokens ?? 0) * 1 + (usage.output_tokens ?? 0) * 5) / 1e6,
      sessionId: response.id ?? null,
    };
  } catch {
    throw new Error(`Reponse API non parsable :\n${text.slice(0, 500)}`);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Interface unique. Bascule entre abonnement et API via LLM_BACKEND,
 * sans que les appelants aient a le savoir.
 *
 * Retourne { output, costUsd, sessionId } : le cout est une estimation
 * client, mais c'est la seule jauge disponible pour borner un lot.
 */
export async function generateStructured({
  prompt,
  stdin,
  schema,
  systemPrompt,
  model,
  allowedTools,
  timeoutMs = 300000,
}) {
  if (config.llmBackend === 'api') {
    requireApiKey();
    return runApi({ prompt, stdin, schema, systemPrompt, model });
  }
  return runClaudeCode({ prompt, stdin, schema, systemPrompt, model, allowedTools, timeoutMs });
}

function requireApiKey() {
  if (!config.anthropicApiKey) {
    throw new Error('LLM_BACKEND=api mais ANTHROPIC_API_KEY est absent de pipeline/.env');
  }
}

export { resolveCli };
