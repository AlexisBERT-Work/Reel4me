export type Topic = 'ai' | 'dev' | 'business' | 'productivity' | 'science';

export type MediaType = 'photo' | 'video' | 'youtube' | 'gradient';

/**
 * Les photos Pexels sont verticales : "cover" les recadre sans rien perdre.
 * Les og:image d'articles sont larges : "contain" les affiche entieres sur
 * un fond floute plutot que de couper un graphique en deux.
 */
export type MediaFit = 'cover' | 'contain';

export interface Card {
  id: string;
  topic: Topic;
  title: string;
  body: string;
  takeaway: string | null;
  source_url: string | null;
  source_name: string | null;
  media_type: MediaType;
  media_fit: MediaFit;
  /** URL du media, ou l'identifiant de la video quand media_type vaut youtube. */
  media_url: string | null;
  media_poster: string | null;
  media_credit: string | null;
  media_credit_url: string | null;
  created_at: string;
}

export type Action = 'seen' | 'kept' | 'skipped' | 'opened' | 'more' | 'less';

export interface Interaction {
  card_id: string;
  action: Action;
  dwell_ms: number | null;
}

export const TOPIC_LABEL: Record<Topic, string> = {
  ai: 'IA',
  dev: 'Dev',
  business: 'Business',
  productivity: 'Productivité',
  science: 'Science',
};
