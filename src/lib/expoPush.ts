/**
 * expoPush.ts — Helper mutualisé pour push notifications Expo aux chauffeurs.
 *
 * v1.10.62 (Ajnaya2026v119) — Sprint 2.1.1 Pont Réponses Témoin Vivant
 *
 * Lookup les push_tokens du driver dans la table `devices` (cf booking.routes.ts:670)
 * et envoie via Expo Push Notifications API. Fire-and-forget — un échec n'empêche
 * pas le webhook de répondre 200 OK.
 *
 * Usage typique :
 *   import { sendDriverPush } from '../lib/expoPush.js';
 *   await sendDriverPush(driverId, {
 *     title: '📨 Maître Jeantet t\'a répondu',
 *     body: 'Touche pour voir le message',
 *     data: { type: 'prospect_reply', prospect_id, channel: 'whatsapp' },
 *   });
 *
 * Le `data` est consommé côté app par le handler Notifee qui deep-link vers
 * `foreas://conversation/:prospect_id`.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

export interface DriverPushPayload {
  title: string;
  body: string;
  /** data deep-linkable côté app (ex: { type: 'prospect_reply', prospect_id, channel }) */
  data?: Record<string, any>;
  sound?: 'default' | null;
  /** badge count (iOS) */
  badge?: number;
  /** category for actionable notifications */
  categoryId?: string;
  /** android channel */
  channelId?: string;
  priority?: 'default' | 'high';
  /** Si true, supprime la notif si l'app est foreground (handler local prend le relais) */
  _displayInForeground?: boolean;
}

/**
 * Envoie une push notif au chauffeur via tous ses devices enregistrés.
 *
 * @param driverId UUID du chauffeur (auth.users.id)
 * @param payload  contenu de la notif
 * @returns nombre de devices ciblés (0 si pas de push_token enregistré, -1 si erreur)
 */
export async function sendDriverPush(
  driverId: string,
  payload: DriverPushPayload,
): Promise<number> {
  if (!driverId) return -1;
  const supa = getSupa();
  if (!supa) return -1;

  try {
    // Pieuvre2026(v12) — lookup user_push_tokens (table récente alimentée par PushTokenService côté app)
    // ET devices.push_token (legacy) — union sans doublon
    const [{ data: newTokens }, { data: legacyDevices }] = await Promise.all([
      supa.from('user_push_tokens').select('token').eq('user_id', driverId),
      supa
        .from('devices')
        .select('push_token')
        .eq('user_id', driverId)
        .not('push_token', 'is', null),
    ]);

    const allTokens = [
      ...(newTokens || []).map((r: any) => r.token as string),
      ...(legacyDevices || []).map((d: any) => d.push_token as string),
    ];

    if (allTokens.length === 0) {
      console.log(
        `[expoPush] No tokens (user_push_tokens + devices) for driver ${driverId.slice(0, 8)}…`,
      );
      return 0;
    }

    const pushTokens = Array.from(
      new Set(allTokens.filter((t) => t && t.startsWith('ExponentPushToken'))),
    );

    if (pushTokens.length === 0) {
      return 0;
    }

    // Construire le batch Expo Push (1 message par token)
    const messages = pushTokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: payload.sound ?? 'default',
      priority: payload.priority ?? 'high',
      ...(payload.badge !== undefined && { badge: payload.badge }),
      ...(payload.categoryId && { categoryId: payload.categoryId }),
      ...(payload.channelId && { channelId: payload.channelId }),
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
      },
      body: JSON.stringify(messages),
      // Timeout court — ne bloque pas le webhook
      signal: AbortSignal.timeout
        ? AbortSignal.timeout(3000)
        : (() => {
            const c = new AbortController();
            setTimeout(() => c.abort(), 3000);
            return c.signal;
          })(),
    });

    if (!res.ok) {
      console.warn(`[expoPush] Expo API ${res.status} for driver ${driverId.slice(0, 8)}…`);
      return -1;
    }

    return pushTokens.length;
  } catch (err: any) {
    console.warn('[expoPush] error:', err?.message ?? err);
    return -1;
  }
}
