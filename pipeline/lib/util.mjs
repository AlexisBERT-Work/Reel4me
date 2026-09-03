import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Vrai si le module est lance directement (et pas importe par run.mjs).
 * pathToFileURL gere les lettres de lecteur Windows, contrairement a une
 * concatenation 'file://' + argv[1].
 */
export function isMain(importMetaUrl) {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === importMetaUrl;
}

/** Identifiant stable et deterministe : la re-ingestion d'une meme URL ne cree rien. */
export function sha1(input) {
  return createHash('sha1').update(input).digest('hex');
}

const TRACKING = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref_?src|igshid|si$)/i;

/**
 * Normalise une URL pour que trois liens vers le meme article donnent le meme id.
 * Retourne l'entree brute si elle n'est pas parsable.
 */
export function canonical(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING.test(key)) u.searchParams.delete(key);
    }
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    return u.toString();
  } catch {
    return url;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch avec timeout et retry sur erreur reseau ou 5xx. */
export async function fetchWithRetry(url, options = {}, { retries = 2, timeoutMs = 20000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${url} : ${lastError.message}`);
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Coupe proprement sur un mot plutot qu'au milieu. */
export function clamp(text, max) {
  const t = (text || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\-\s]+$/, '') + '…';
}

/** Retire les balises d'un resume RSS/Atom. */
export function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
