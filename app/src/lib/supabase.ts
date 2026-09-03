import { createClient, type Session } from '@supabase/supabase-js';
import type { Card, Interaction } from './types';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && anonKey);

// Cette cle part dans le bundle, donc elle est publique. Elle ne donne aucun
// acces a elle seule : RLS reserve la lecture des cartes et l'ecriture des
// interactions au compte inscrit dans app_owner (voir supabase/schema.sql).
export const supabase = configured
  ? createClient(url, anonKey, {
      auth: {
        // La session est gardee en localStorage : une connexion par appareil,
        // pas une par ouverture de l'app.
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;

export const PAGE_SIZE = 20;

/* ----------------------------------------------------------------- auth */

export async function currentSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(callback: (session: Session | null) => void): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Supabase non configuré');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

/* ---------------------------------------------------------------- donnees */

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
