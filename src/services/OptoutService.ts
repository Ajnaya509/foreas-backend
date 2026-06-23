/**
 * OptoutService — RGPD opt-out avec HMAC token
 * Ajnaya2026v87.1
 *
 * Token format : base64url(email).hmac(first16hex)
 * Permet d'éviter qu'un tiers puisse désabonner n'importe qui.
 *
 * Stocké dans la table finder_optout_list.
 */

import crypto from 'crypto';
import { getSupabase } from '../lib/supabase.js';

function getSecret(): string {
  return process.env.OPTOUT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'foreas-dev-optout';
}

export function generateOptoutToken(email: string): string {
  const b64 = Buffer.from(email).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(b64).digest('hex').slice(0, 16);
  return `${b64}.${sig}`;
}

export function decodeOptoutToken(token: string): string | null {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const expected = crypto
      .createHmac('sha256', getSecret())
      .update(b64)
      .digest('hex')
      .slice(0, 16);
    if (sig !== expected) return null;
    return Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export async function isEmailOptedOut(email: string): Promise<boolean> {
  try {
    const supa = getSupabase();
    const { data } = await supa
      .from('finder_optout_list')
      .select('email')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();
    return !!data;
  } catch (err: any) {
    console.warn('[Optout] isEmailOptedOut error:', err?.message);
    return false;
  }
}

export async function addToOptoutList(
  email: string,
  source: 'link' | 'reply' | 'complaint' | 'manual',
  reason?: string,
): Promise<void> {
  const supa = getSupabase();
  await supa.from('finder_optout_list').upsert(
    {
      email: email.toLowerCase().trim(),
      source,
      reason: reason ?? null,
      optout_at: new Date().toISOString(),
    },
    { onConflict: 'email' },
  );
}
