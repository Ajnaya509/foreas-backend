/**
 * supabase.ts - Client Supabase Backend (service_role)
 *
 * ATTENTION: Ce client utilise la clé service_role qui bypass RLS.
 * À utiliser UNIQUEMENT côté serveur, JAMAIS exposé au client.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Variables d'environnement requises
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) {
  console.error('[Supabase] ❌ SUPABASE_URL non configurée');
}

if (!SUPABASE_SERVICE_KEY) {
  console.error('[Supabase] ❌ SUPABASE_SERVICE_ROLE_KEY non configurée');
}

/**
 * Client Supabase avec service_role key
 * Bypass RLS pour les opérations backend
 */
export const supabaseAdmin: SupabaseClient = createClient(
  SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
  SUPABASE_SERVICE_KEY || 'missing-service-key',
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

/**
 * Vérifie que la connexion Supabase fonctionne
 */
export async function checkSupabaseConnection(): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from('drivers').select('count').limit(1);
    if (error) {
      console.error('[Supabase] ❌ Connection test failed:', error.message);
      return false;
    }
    console.log('[Supabase] ✅ Connected successfully');
    return true;
  } catch (err) {
    console.error('[Supabase] ❌ Connection exception:', err);
    return false;
  }
}

/**
 * Helper pour les transactions avec retry
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err as Error;
      console.warn(`[Supabase] Attempt ${attempt}/${maxRetries} failed:`, lastError.message);

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  throw lastError;
}
