import { fetchWithRetry } from './util.mjs';

/**
 * Recupere l'image de partage declaree par la page source.
 *
 * C'est exactement l'usage prevu d'og:image : une image que le site publie
 * pour etre affichee ailleurs. Le rendu est bien plus pertinent qu'une photo
 * de stock, au prix d'un ratio souvent large (1200x630) — d'ou le media_fit
 * "contain" que l'app compense avec un fond floute.
 */

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; Reel4me/1.0; +https://github.com/AlexisBERT-Work/Reel4me) personal feed reader',
  accept: 'text/html,application/xhtml+xml',
};

/** L'attribut content peut preceder ou suivre property/name selon les sites. */
function metaContent(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']${escaped}["']`, 'i'),
    ];
    for (const re of patterns) {
      const match = re.exec(html);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

export async function ogImage(pageUrl) {
  let res;
  try {
    res = await fetchWithRetry(pageUrl, { headers: HEADERS }, { retries: 1, timeoutMs: 12000 });
  } catch {
    return null;
  }

  if (!res.ok) return null;
  if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? '')) return null;

  // Les metas vivent dans le <head> : inutile de charger un article entier.
  const html = (await res.text()).slice(0, 200000);

  const raw = metaContent(html, [
    'og:image:secure_url',
    'og:image:url',
    'og:image',
    'twitter:image',
    'twitter:image:src',
  ]);
  if (!raw) return null;

  let absolute;
  try {
    absolute = new URL(raw.trim().replace(/&amp;/g, '&'), pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(absolute.protocol)) return null;

  // Un SVG de logo ou un pixel de tracking ne fait pas un fond de carte.
  if (/\.svg($|\?)/i.test(absolute.pathname)) return null;

  return {
    url: absolute.toString(),
    site: metaContent(html, ['og:site_name']),
  };
}
