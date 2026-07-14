import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

let _supaSrv: SupabaseClient | null = null;

function getSupaSrv(): SupabaseClient {
  if (!_supaSrv) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.warn('[Supa] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — supa.ts disabled');
      throw new Error('Supabase not configured');
    }
    _supaSrv = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supaSrv;
}

export const supaSrv = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupaSrv() as any)[prop];
  },
});

export async function getUserIdByEmail(email: string): Promise<string> {
  try {
    const { data, error } = await supaSrv.from('users').select('id').eq('email', email).single();

    if (error || !data) {
      const userId = crypto.randomUUID();
      const { data: newUser, error: createError } = await supaSrv
        .from('users')
        .insert({ id: userId, email })
        .select('id')
        .single();

      if (createError) {
        throw new Error(`Failed to create user: ${createError.message}`);
      }
      return newUser!.id;
    }

    return data.id;
  } catch (err) {
    console.error('Error in getUserIdByEmail:', err);
    throw err;
  }
}

export async function saveAjnayaMessage(
  userId: string,
  message: string,
  response: string,
): Promise<void> {
  try {
    const { error } = await supaSrv
      .from('ajnaya_messages')
      .insert({ user_id: userId, message, response });

    if (error) {
      throw new Error(`Failed to save message: ${error.message}`);
    }
  } catch (err) {
    console.error('Error saving Ajnaya message:', err);
    throw err;
  }
}

export async function todayUserMessageCount(userId: string): Promise<number> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { count, error } = await supaSrv
      .from('ajnaya_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', `${today}T00:00:00.000Z`)
      .lte('created_at', `${today}T23:59:59.999Z`);

    if (error) {
      console.error('Error counting messages:', error);
      return 0;
    }
    return count || 0;
  } catch (err) {
    console.error('Error in todayUserMessageCount:', err);
    return 0;
  }
}

export async function savePushToken(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  try {
    const { error } = await supaSrv
      .from('push_tokens')
      .upsert({ user_id: userId, token, platform }, { onConflict: 'user_id,token' });

    if (error) {
      throw new Error(`Failed to save push token: ${error.message}`);
    }
  } catch (err) {
    console.error('Error saving push token:', err);
    throw err;
  }
}

// ── Subscription helpers (used by Stripe webhooks) ──

export async function upsertUserByEmail(email: string): Promise<{ id: string }> {
  const id = await getUserIdByEmail(email);
  return { id };
}

export async function setSubscriptionStatus(data: {
  userId: string;
  provider: string;
  status: string;
  currentPeriodEnd: string | null;
  productId?: string | null;
}): Promise<void> {
  const { error } = await supaSrv.from('user_subscriptions').upsert(
    {
      user_id: data.userId,
      provider: data.provider,
      status: data.status,
      current_period_end: data.currentPeriodEnd,
      product_id: data.productId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) {
    console.error('[Supa] setSubscriptionStatus error:', error.message);
    throw error;
  }

  console.log(`[Supa] Subscription ${data.status} for user ${data.userId}`);
}

// =============================================================================
// Phase B fil App 10/05/2026 — Tier upsert post-checkout Stripe
// =============================================================================
// Spec : PRICING_FEATURES_MASTER.md §1 (Free / Pro 19,97 / Elite 44,97)
// Source : entrée AJNAYA_CHANGELOG.md [2026-05-10 18:30] FIL SITE §5 :
//   "Webhook Stripe post-checkout (qui set tier) à câbler côté fil App
//    backend Railway. Pattern attendu : UPDATE user_profiles SET tier='pro'/'elite'
//    WHERE user_id = (SELECT user_id FROM auth.users WHERE email = stripe_customer.email)"
//
// Mapping Stripe priceId → tier via env vars Railway :
//   - STRIPE_PRICE_ID_PRO_WEEKLY    → 'pro'  (19,97 €/sem)
//   - STRIPE_PRICE_ID_PRO_ANNUAL    → 'pro'  (830,75 €/an)
//   - STRIPE_PRICE_ID_ELITE_WEEKLY  → 'elite' (44,97 €/sem)
//   - STRIPE_PRICE_ID_ELITE_ANNUAL  → 'elite' (1 870,75 €/an)
//
// Si les env vars ne sont pas encore set (Chandler n'a pas exécuté
// `bash scripts/stripe-phase-a.sh`), le helper logge un warning et skip
// le set tier sans crasher le webhook (gracefully degraded).
// =============================================================================

export type UserTier = 'free' | 'pro' | 'elite';

/**
 * Mappe un Stripe priceId vers un tier en consultant les env vars Railway.
 * Retourne `null` si le priceId ne match aucun env var connu (skip silencieux).
 */
export function getTierFromPriceId(priceId: string | null | undefined): UserTier | null {
  if (!priceId) return null;
  const proWeekly = process.env.STRIPE_PRICE_ID_PRO_WEEKLY;
  const proAnnual = process.env.STRIPE_PRICE_ID_PRO_ANNUAL;
  const proMonthly = process.env.STRIPE_PRICE_ID_PRO_MONTHLY; // Pricing 97€/mois (21/06/2026)
  const eliteWeekly = process.env.STRIPE_PRICE_ID_ELITE_WEEKLY;
  const eliteAnnual = process.env.STRIPE_PRICE_ID_ELITE_ANNUAL;
  const eliteMonthly = process.env.STRIPE_PRICE_ID_ELITE_MONTHLY; // Pricing 247€/mois (21/06/2026)

  if (priceId === proWeekly || priceId === proAnnual || priceId === proMonthly) return 'pro';
  if (priceId === eliteWeekly || priceId === eliteAnnual || priceId === eliteMonthly)
    return 'elite';

  // Pricing legacy (pre-Phase A 10/05) — reconnu pour rétrocompat audit
  // mais on ne migre pas automatiquement : ces customers restent sur leur ancien plan.
  if (!proWeekly && !proAnnual && !proMonthly && !eliteWeekly && !eliteAnnual && !eliteMonthly) {
    console.warn(
      '[Supa] getTierFromPriceId: STRIPE_PRICE_ID_* env vars not set — Phase A script not yet executed by Chandler. Returning null (tier set skipped).',
    );
  }
  return null;
}

/**
 * UPSERT le tier d'un user dans `user_profiles` (clé `user_id`).
 * - Si row existe → UPDATE tier + tier_active_until
 * - Si row n'existe pas → INSERT minimal (user_id + tier + tier_active_until)
 *
 * Utilise UNIQUE constraint `user_profiles_user_id_unique` (migration appliquée 10/05 19:15).
 *
 * @param userId UUID identique à auth.users.id (récupéré via upsertUserByEmail)
 * @param tier 'free' | 'pro' | 'elite'
 * @param tierActiveUntil ISO timestamp ou null (null = pas d'expiration suivie)
 */
export async function setUserTier(
  userId: string,
  tier: UserTier,
  tierActiveUntil: string | null = null,
): Promise<void> {
  try {
    const { error } = await supaSrv.from('user_profiles').upsert(
      {
        user_id: userId,
        tier,
        tier_active_until: tierActiveUntil,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

    if (error) {
      console.error('[Supa] setUserTier error:', error.message);
      throw error;
    }

    console.log(
      `[Supa] tier=${tier} set for user ${userId}${tierActiveUntil ? ` until ${tierActiveUntil}` : ''}`,
    );
  } catch (err: any) {
    console.error('[Supa] setUserTier exception:', err?.message || err);
    // Non-blocking : on ne bloque pas le webhook Stripe pour ce sub-step
    // (le subscription est déjà set, le tier sera re-tenté au prochain event ou via cron de reconciliation)
  }
}

/**
 * Helper combiné : depuis un email + priceId Stripe, met à jour
 * `user_profiles.tier` automatiquement. Idempotent + safe (no-throw).
 *
 * Appelé par tous les events Stripe pertinents (checkout.session.completed,
 * invoice.payment_succeeded, customer.subscription.updated).
 *
 * @param email Email Stripe customer (pour résoudre user_id via getUserIdByEmail)
 * @param priceId Stripe priceId actif sur la subscription
 * @param periodEnd ISO timestamp `current_period_end` ou null
 */
export async function setTierFromStripeEvent(
  email: string,
  priceId: string | null | undefined,
  periodEnd: string | null = null,
): Promise<void> {
  const tier = getTierFromPriceId(priceId);
  if (!tier) {
    console.log(`[Supa] setTierFromStripeEvent: priceId=${priceId} not mapped to a tier → skip`);
    return;
  }
  try {
    const userId = await getUserIdByEmail(email);
    await setUserTier(userId, tier, periodEnd);
  } catch (err: any) {
    console.error('[Supa] setTierFromStripeEvent failed:', err?.message || err);
    // Non-blocking
  }
}

/**
 * Downgrade un user à 'free' (utilisé par customer.subscription.deleted).
 * Reset tier_active_until à null pour cohérence avec frontend useTier
 * (qui lit tier_active_until pour détection expiration).
 */
export async function downgradeUserToFree(email: string): Promise<void> {
  try {
    const userId = await getUserIdByEmail(email);
    await setUserTier(userId, 'free', null);
  } catch (err: any) {
    console.error('[Supa] downgradeUserToFree failed:', err?.message || err);
  }
}

export async function logEvent(userId: string | null, type: string, payload: any): Promise<void> {
  try {
    const { error } = await supaSrv.from('event_log').insert({
      user_id: userId,
      event_type: type,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });

    if (error) {
      // Non-blocking: log but don't throw
      console.warn('[Supa] logEvent warning:', error.message);
    }
  } catch (err) {
    console.warn('[Supa] logEvent failed silently:', err);
  }
}

// =============================================================================
// PROVISION CHAUFFEUR DEPUIS WHATSAPP — post-paiement Stripe (brief 11/07)
// =============================================================================
// upsertUserByEmail() suppose qu'une fiche `drivers` existe déjà (cas app :
// inscription d'abord, paiement ensuite). Un chauffeur converti par Ajnaya sur
// WhatsApp n'a JAMAIS de fiche préalable — il faut créer le compte Auth + la
// fiche driver à partir de zéro, uniquement APRÈS confirmation du paiement.
//
// Connexion ensuite : par code SMS sur le même numéro (déjà vérifié vivant —
// il vient de l'utiliser pour parler à Ajnaya). Pas de lien magique email : ce
// mécanisme existe dans le code mais n'a aucun écran récepteur dans l'app.

export class WhatsappProvisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsappProvisionConflictError';
  }
}

export interface WhatsappDriverProvisionResult {
  driverId: string;
  authUserId: string | null;
  created: boolean;
}

export async function provisionWhatsappDriver(params: {
  email: string;
  phoneE164: string;
  stripeCustomerId: string | null;
  stripeEventId: string;
  displayName?: string | null;
}): Promise<WhatsappDriverProvisionResult> {
  const email = params.email.trim().toLowerCase();
  const phone = params.phoneE164.trim().replace(/\s+/g, '');

  if (!email || !phone) {
    throw new Error('provisionWhatsappDriver: email et phone requis');
  }

  // 1) Idempotence — une relivraison du même event Stripe (retry réseau, Stripe
  // garantit "at-least-once") ne doit jamais reprovisionner. Vérifié AVANT toute écriture.
  const { data: existingEvent } = await supaSrv
    .from('subscription_events')
    .select('driver_id')
    .eq('stripe_event_id', params.stripeEventId)
    .maybeSingle();
  if (existingEvent?.driver_id) {
    return { driverId: existingEvent.driver_id, authUserId: null, created: false };
  }

  // 2) Compte déjà existant (email OU phone) ? Ne jamais dupliquer.
  const { data: existingDriver } = await supaSrv
    .from('drivers')
    .select('id, email, phone, auth_user_id')
    .or(`phone.eq.${phone},email.eq.${email}`)
    .maybeSingle();

  if (existingDriver) {
    const phoneMatches = existingDriver.phone === phone;
    const emailMatches = (existingDriver.email || '').toLowerCase() === email;
    if (phoneMatches && emailMatches) {
      // Même personne (renouvellement, 2e achat) → réutiliser, ne pas recréer.
      return {
        driverId: existingDriver.id,
        authUserId: existingDriver.auth_user_id,
        created: false,
      };
    }
    // Match partiel = suspect (numéro déjà lié à un AUTRE email, ou inversement) —
    // ne JAMAIS fusionner silencieusement, laisser remonter pour revue manuelle.
    throw new WhatsappProvisionConflictError(
      `Conflit identité driver=${existingDriver.id} : phone_match=${phoneMatches} email_match=${emailMatches}`,
    );
  }

  // 3) Créer le compte Auth — téléphone confirmé (vient de nous écrire dessus sur
  // WhatsApp, c'est vivant) et email confirmé (collecté par Stripe pendant un vrai
  // paiement carte, risque de fraude faible à ce stade du parcours).
  //
  // Trouvé en testant en direct (signature Stripe reconstituée à la main, aucun vrai
  // paiement) : le trigger existant `on_auth_user_created` → handle_new_user() crée
  // DÉJÀ automatiquement `users(id=auth.users.id)` PUIS `drivers(id=auth.users.id,
  // last_active=now())` dès la création du compte Auth (+ behavior_models, user_karma).
  // Il ne faut donc PAS ré-INSERT une ligne drivers ensuite (ça collisionne sur la
  // clé primaire) — juste compléter par UPDATE la ligne que le trigger vient de poser.
  const { data: authData, error: authErr } = await (supaSrv as any).auth.admin.createUser({
    email,
    phone,
    email_confirm: true,
    phone_confirm: true,
    user_metadata: {
      user_type: 'driver',
      source: 'whatsapp_ajnaya',
      stripe_customer_id: params.stripeCustomerId,
      display_name: params.displayName || null,
    },
  });
  if (authErr || !authData?.user) {
    throw new Error(
      `provisionWhatsappDriver: auth.admin.createUser a échoué — ${authErr?.message}`,
    );
  }

  // 4) Compléter la fiche chauffeur auto-créée par le trigger (email/phone/statut).
  const { data: driverRow, error: driverErr } = await supaSrv
    .from('drivers')
    .update({
      auth_user_id: authData.user.id,
      email,
      phone,
      first_name: params.displayName || null,
      subscription_status: 'active',
    })
    .eq('id', authData.user.id)
    .select('id')
    .single();

  if (driverErr) {
    if ((driverErr as any).code === '23505') {
      // Course concurrente gagnée par un autre appel (double webhook quasi simultané)
      // — les index uniques drivers_phone_unique/drivers_email_unique ont bloqué le
      // doublon. Récupérer la fiche qui vient d'être créée plutôt que planter.
      const { data: raceDriver } = await supaSrv
        .from('drivers')
        .select('id, auth_user_id')
        .or(`phone.eq.${phone},email.eq.${email}`)
        .maybeSingle();
      if (raceDriver) {
        return { driverId: raceDriver.id, authUserId: raceDriver.auth_user_id, created: false };
      }
    }
    // Compte Auth créé (et la ligne drivers bare posée par le trigger) mais le
    // complément a raté — pas de rollback auto Supabase, log fort pour reprise
    // manuelle plutôt que de laisser un Auth orphelin invisible.
    console.error(
      `[WhatsappProvision] CRITIQUE: auth user ${authData.user.id} créé mais update drivers a échoué:`,
      driverErr.message,
    );
    throw new Error(`provisionWhatsappDriver: update drivers a échoué — ${driverErr.message}`);
  }
  if (!driverRow) {
    throw new Error(
      'provisionWhatsappDriver: update drivers sans erreur mais sans ligne retournée',
    );
  }

  // 5) Fusionner avec le fil d'identité WhatsApp déjà existant (toutes les
  // conversations qu'il a eues avec Ajnaya avant de payer) — best-effort, ne
  // bloque jamais la création du compte si la RPC échoue.
  try {
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    const emailHash = createHash('sha256').update(email).digest('hex');
    await supaSrv.rpc('resolve_identity_v2', {
      p_identifiers: [
        { id_type: 'phone_hash', id_value: phoneHash, confidence: 0.95 },
        { id_type: 'wa_phone_hash', id_value: phoneHash, confidence: 0.95 },
        { id_type: 'email_hash', id_value: emailHash, confidence: 0.9 },
        { id_type: 'driver_id', id_value: driverRow.id, confidence: 0.99 },
      ],
      p_context: { canal: 'stripe_whatsapp' },
    });
  } catch (identityErr: any) {
    console.warn('[WhatsappProvision] fusion identity_bridge non-bloquante:', identityErr?.message);
  }

  return { driverId: driverRow.id, authUserId: authData.user.id, created: true };
}
