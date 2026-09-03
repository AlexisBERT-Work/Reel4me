import type { Topic } from './types';

export const TOPIC_ACCENT: Record<Topic, string> = {
  ai: '#8b9dff',
  dev: '#4ade80',
  business: '#fbbf24',
  productivity: '#f472b6',
  science: '#22d3ee',
};

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Fond de repli quand Pexels n'a rien donne. Deterministe : une carte garde
 * son fond d'une session a l'autre, ce qui aide a la reconnaitre.
 */
export function gradientFor(id: string, topic: Topic): string {
  const h = hash(id);
  const base = { ai: 250, dev: 145, business: 40, productivity: 330, science: 190 }[topic] ?? 250;
  const a = (base + (h % 40) - 20 + 360) % 360;
  const b = (a + 45 + (h % 50)) % 360;
  const angle = 145 + (h % 70);

  return (
    `radial-gradient(120% 90% at ${20 + (h % 60)}% ${10 + (h % 30)}%, hsl(${a} 62% 32%) 0%, transparent 60%),` +
    `linear-gradient(${angle}deg, hsl(${a} 55% 16%) 0%, hsl(${b} 48% 9%) 100%)`
  );
}
