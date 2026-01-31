/**
 * rateLimit.ts - Rate-limiting Postgres (sans Redis)
 *
 * Utilise les fonctions Postgres définies dans la migration:
 * - check_rate_limit() - Vérifie et incrémente le compteur
 *
 * Limites par défaut:
 * - 5 requêtes par 15 minutes par téléphone
 * - Lockout de 30 minutes si dépassé
 */

import { supabaseAdmin } from './supabase';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;   // Secondes avant retry (0 si allowed)
  reason: string;       // 'ok', 'rate_limit_exceeded', 'locked: ...'
}

// Configuration par défaut
const DEFAULT_MAX_REQUESTS = 5;
const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_LOCKOUT_MINUTES = 30;

/**
 * Vérifie le rate-limit pour un téléphone/IP
 *
 * @param phone - Numéro E.164
 * @param ip - Adresse IP optionnelle
 * @param options - Configuration custom
 * @returns RateLimitResult
 */
export async function checkRateLimit(
  phone: string,
  ip?: string,
  options?: {
    maxRequests?: number;
    windowMinutes?: number;
    lockoutMinutes?: number;
  }
): Promise<RateLimitResult> {
  const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMinutes = options?.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const lockoutMinutes = options?.lockoutMinutes ?? DEFAULT_LOCKOUT_MINUTES;

  try {
    const { data, error } = await supabaseAdmin.rpc('check_rate_limit', {
      p_phone: phone,
      p_ip: ip || null,
      p_max_requests: maxRequests,
      p_window_minutes: windowMinutes,
      p_lockout_minutes: lockoutMinutes,
    });

    if (error) {
      console.error('[RateLimit] ❌ Erreur check_rate_limit:', error);
      // En cas d'erreur, on autorise (fail-open) pour ne pas bloquer les users
      return {
        allowed: true,
        remaining: maxRequests,
        retryAfter: 0,
        reason: 'error_fallback',
      };
    }

    // La fonction retourne un tableau avec une seule ligne
    const result = Array.isArray(data) ? data[0] : data;

    return {
      allowed: result.allowed,
      remaining: result.remaining,
      retryAfter: result.retry_after,
      reason: result.reason,
    };
  } catch (err) {
    console.error('[RateLimit] ❌ Exception:', err);
    // Fail-open
    return {
      allowed: true,
      remaining: maxRequests,
      retryAfter: 0,
      reason: 'exception_fallback',
    };
  }
}

/**
 * Reset manuel du rate-limit (pour admin)
 */
export async function resetRateLimit(phone: string): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin
      .from('phone_rate_limits')
      .update({
        request_count: 0,
        is_locked: false,
        locked_until: null,
        window_start: new Date().toISOString(),
      })
      .eq('phone', phone);

    if (error) {
      console.error('[RateLimit] ❌ Reset failed:', error);
      return false;
    }

    console.log(`[RateLimit] ✅ Reset for ${phone}`);
    return true;
  } catch (err) {
    console.error('[RateLimit] ❌ Reset exception:', err);
    return false;
  }
}

/**
 * Vérifie si un téléphone est actuellement bloqué
 */
export async function isBlocked(phone: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('phone_rate_limits')
      .select('is_locked, locked_until')
      .eq('phone', phone)
      .single();

    if (error || !data) return false;

    if (data.is_locked && data.locked_until) {
      return new Date(data.locked_until) > new Date();
    }

    return false;
  } catch {
    return false;
  }
}
