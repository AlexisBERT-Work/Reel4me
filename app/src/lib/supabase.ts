import { createClient } from '@supabase/supabase-js';
import type { Card, Interaction } from './types';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && anonKey);

// Cette cle est publique par construction (elle part dans le bundle). C'est
// sans risque parce que RLS la limite a : select sur cards, insert sur
// interactions. Voir supabase/schema.sql.
export const supabase = configured
  ? createClient(url, anonKey, { auth: { persistSession: false } })
  : null;

export const PAGE_SIZE = 20;

export async function fetchCards(before?: string): Promise<Card[]> {
  if (!supabase) return [];

  let query = supabase
    .from('cards')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Card[];
}

export async function sendInteractions(rows: Interaction[]): Promise<void> {
  if (!supabase || !rows.length) return;
  const { error } = await supabase.from('interactions').insert(rows);
  if (error) throw new Error(error.message);
}
