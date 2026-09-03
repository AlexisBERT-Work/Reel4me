import { createClient } from '@supabase/supabase-js';
import { config, requireEnv } from './config.mjs';

let client = null;

/**
 * Client Supabase en service_role : contourne RLS, ecrit items et cards.
 * Reserve au PC. La PWA utilise la cle anon et n'a que select/insert.
 */
export function db() {
  if (!client) {
    requireEnv('supabaseUrl', 'supabaseServiceKey');
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Leve sur erreur Supabase au lieu de laisser passer un `data` null silencieux. */
export function unwrap({ data, error }, context) {
  if (error) throw new Error(`${context} : ${error.message}`);
  return data;
}
