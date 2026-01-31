/**
 * supabase.ts - Client Supabase Backend (service_role)
 *
 * ATTENTION: Ce client utilise la clé service_role qui bypass RLS.
 * À utiliser UNIQUEMENT côté serveur, JAMAIS exposé au client.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Variables d'environnement requises (support multiple naming conventions)
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.URL_SUPABASE ||
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  'https://fihvdvlhftcxhlnocqiq.supabase.co';

const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.CLÉ_DE_RÔLE_DU_SERVICE_SUPABASE ||
  '';

// Log config at startup
console.log('[Supabase] Initializing with URL:', SUPABASE_URL);
console.log('[Supabase] Service key configured:', SUPABASE_SERVICE_KEY ? 'YES' : 'NO');

if (!SUPABASE_SERVICE_KEY) {
  console.warn('[Supabase] ⚠️ SUPABASE_SERVICE_ROLE_KEY non configurée - OTP features will fail');
}

/**
 * Client Supabase avec service_role key
 * Bypass RLS pour les opérations backend
 */
export const supabaseAdmin: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY || 'placeholder-key-will-fail',
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
