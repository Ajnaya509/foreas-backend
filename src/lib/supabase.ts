/**
 * Lazy Supabase service-role client pour le backend
 * Ajnaya2026v87.1
 *
 * Utilise SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * Le client est créé à la première utilisation et réutilisé.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supa: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase env missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  _supa = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}
