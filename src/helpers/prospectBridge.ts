/**
 * FOREAS — Prospect ↔ Driver Bridge
 * ====================================
 * Pont entre les prospects (acquisition VPS Pieuvre) et les chauffeurs
 * inscrits (Railway App / Prisma). Utilise le téléphone comme clé universelle.
 *
 * Usage :
 *   - linkProspectOnRegistration(phone, driverId, userId)  → à l'inscription
 *   - resolveProspectForDriver(driverId)                   → pour Ajnaya in-app
 *   - loadProspectConversationHistory(prospectId, limit)   → historique prospect
 *
 * Commit v68 — 7 avril 2026
 */

import { getSupabaseAdmin } from './supabase';

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

export interface ProspectBridgeRecord {
  id: string;
  phone: string;
  prospect_id: string | null;
  prospect_channel: string | null; // whatsapp | widget_site | call | sms | instagram
  prospect_score: number;
  prospect_first_seen_at: string | null;
  driver_id: string;
  driver_user_id: string;
  converted_at: string;
}

export interface ProspectConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  channel: string;
  created_at: string;
}

export interface ProspectContext {
  prospectId: string;
  acquisitionChannel: string;
  scoreAtConversion: number;
  firstSeenAt: string | null;
  daysToConvert: number | null;
  conversationHistory: ProspectConversationMessage[];
}

// ──────────────────────────────────────────────
// 1. LIER UN PROSPECT À UN CHAUFFEUR (inscription)
// ──────────────────────────────────────────────

/**
 * À appeler immédiatement après la création du driver dans Prisma.
 * - Cherche un prospect dans pieuvre_prospects par téléphone
 * - Si trouvé : écrit dans foreas_identity_bridge + met à jour pieuvre_prospects
 * - Si non trouvé : crée quand même une entrée bridge (pour tracking futur)
 * - Silencieux en cas d'erreur (ne bloque JAMAIS l'inscription)
 */
export async function linkProspectOnRegistration(
  phone: string | null | undefined,
  driverId: string,
  driverUserId: string,
): Promise<{ linked: boolean; prospectId: string | null; channel: string | null }> {
  if (!phone) {
    console.log('[Bridge] No phone provided, skipping prospect lookup');
    return { linked: false, prospectId: null, channel: null };
  }

  const supabase = getSupabaseAdmin();
  const normalizedPhone = normalizePhone(phone);

  try {
    // ── Chercher le prospect par téléphone ──
    const { data: prospect } = await supabase
      .from('pieuvre_prospects')
      .select('id, phone, channel, score, created_at, status, first_name')
      .or(`phone.eq.${normalizedPhone},phone.eq.${phone}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // ── Écrire le pont (qu'on ait trouvé un prospect ou non) ──
    const bridgeData: any = {
      phone: normalizedPhone || phone,
      driver_id: driverId,
      driver_user_id: driverUserId,
      converted_at: new Date().toISOString(),
    };

    if (prospect) {
      bridgeData.prospect_id = prospect.id;
      bridgeData.prospect_channel = prospect.channel || null;
      bridgeData.prospect_score = prospect.score || 0;
      bridgeData.prospect_first_seen_at = prospect.created_at;
    }

    // Upsert sur driver_id (idempotent si appelé plusieurs fois)
    const { error: bridgeError } = await supabase
      .from('foreas_identity_bridge')
      .upsert(bridgeData, { onConflict: 'driver_id', ignoreDuplicates: false });

    if (bridgeError) {
      console.warn('[Bridge] ⚠️ Bridge upsert error (non-fatal):', bridgeError.message);
    }

    // ── Mettre à jour pieuvre_prospects si prospect trouvé ──
    if (prospect) {
      const { error: prospectUpdateError } = await supabase
        .from('pieuvre_prospects')
        .update({
          driver_id: driverId,
          converted_at: new Date().toISOString(),
          converted_channel: prospect.channel || null,
          status: 'converted',
        })
        .eq('id', prospect.id);

      if (prospectUpdateError) {
        console.warn('[Bridge] ⚠️ Prospect update error (non-fatal):', prospectUpdateError.message);
      }

      console.log(
        `[Bridge] ✅ Linked prospect ${prospect.id} (${prospect.channel || 'unknown'}, score=${prospect.score || 0}) → driver ${driverId}`,
      );

      return {
        linked: true,
        prospectId: prospect.id,
        channel: prospect.channel || null,
      };
    }

    console.log(
      `[Bridge] ℹ️ No prospect found for phone ${normalizedPhone} — bridge created without prospect`,
    );
    return { linked: false, prospectId: null, channel: null };
  } catch (err: any) {
    // JAMAIS bloquer l'inscription pour une erreur de bridge
    console.error('[Bridge] ❌ linkProspectOnRegistration failed (non-fatal):', err.message);
    return { linked: false, prospectId: null, channel: null };
  }
}

// ──────────────────────────────────────────────
// 2. RÉSOUDRE LE PROSPECT POUR UN DRIVER (in-app)
// ──────────────────────────────────────────────

/**
 * Pour Ajnaya in-app : récupère le contexte prospect d'un chauffeur.
 * Utilisé par le LangGraph contexte agent.
 * Cache implicite : toujours la même réponse si le bridge est stable.
 */
export async function resolveProspectForDriver(
  driverId: string,
): Promise<ProspectBridgeRecord | null> {
  if (!driverId) return null;

  const supabase = getSupabaseAdmin();

  try {
    const { data, error } = await supabase
      .from('foreas_identity_bridge')
      .select('*')
      .eq('driver_id', driverId)
      .single();

    if (error || !data) return null;
    return data as ProspectBridgeRecord;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────
// 3. CHARGER L'HISTORIQUE PROSPECT (pour LangGraph)
// ──────────────────────────────────────────────

/**
 * Charge les conversations du prospect AVANT l'inscription.
 * Retourne max `limit` messages triés par date croissante.
 */
export async function loadProspectConversationHistory(
  prospectId: string,
  limit = 10,
): Promise<ProspectConversationMessage[]> {
  if (!prospectId) return [];

  const supabase = getSupabaseAdmin();

  try {
    const { data, error } = await supabase
      .from('pieuvre_conversations')
      .select('direction, content, channel, created_at')
      .eq('prospect_id', prospectId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data
      .map(
        (msg: any): ProspectConversationMessage => ({
          role: msg.direction === 'inbound' ? 'user' : 'assistant',
          content: msg.content || '',
          channel: msg.channel || 'unknown',
          created_at: msg.created_at,
        }),
      )
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// 4. CONTEXTE COMPLET (tout en un, pour LangGraph)
// ──────────────────────────────────────────────

/**
 * Charge le contexte prospect complet pour un driver.
 * Utilisé par contexte.ts : un seul appel, tout arrive.
 */
export async function loadFullProspectContext(driverId: string): Promise<ProspectContext | null> {
  const bridge = await resolveProspectForDriver(driverId);
  if (!bridge || !bridge.prospect_id) return null;

  const history = await loadProspectConversationHistory(bridge.prospect_id, 10);

  const daysToConvert =
    bridge.prospect_first_seen_at && bridge.converted_at
      ? Math.round(
          (new Date(bridge.converted_at).getTime() -
            new Date(bridge.prospect_first_seen_at).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : null;

  return {
    prospectId: bridge.prospect_id,
    acquisitionChannel: bridge.prospect_channel || 'unknown',
    scoreAtConversion: bridge.prospect_score || 0,
    firstSeenAt: bridge.prospect_first_seen_at,
    daysToConvert,
    conversationHistory: history,
  };
}

// ──────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────

/**
 * Normalise un numéro de téléphone en format E.164.
 * Ex: "0612345678" → "+33612345678"
 *     "+33612345678" → "+33612345678"
 */
function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-\.\(\)]/g, '');

  if (cleaned.startsWith('+')) return cleaned;

  // France : 06/07 → +336/+337
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return '+33' + cleaned.slice(1);
  }

  // Déjà sans 0 initial (ex: 612345678)
  if (cleaned.length === 9) {
    return '+33' + cleaned;
  }

  return cleaned; // retourner tel quel si format inconnu
}
