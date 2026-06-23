/**
 * Resend Webhooks — Suivi des livraisons d'emails Private Hunter
 * Ajnaya2026v85
 *
 * POST /api/webhooks/resend
 * Événements traités :
 *   - email.delivered  → confirme livraison
 *   - email.bounced    → marque prospect BOUNCED
 *   - email.complained → blacklist email
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const router = Router();

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient | null {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

// ── Vérification signature Resend ─────────────────────────────────
// v1.10.62 (Ajnaya2026v118) :
// - W11 : compare bytes hex décodés au lieu de strings.
// - W4 : Resend 2026 utilise SVIX format `v1,base64sig` ou hex selon config.
//   On supporte les 2 : si le header commence par "v1,", on parse base64,
//   sinon on suppose hex direct (ancien format).
function verifyResendSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedHex = hmac.digest('hex');
    const expectedBytes = Buffer.from(expectedHex, 'hex');

    // Format SVIX (Resend 2026) : "v1,base64sig v1,base64sig2 ..."
    if (signature.startsWith('v1,')) {
      const sigsB64 = signature
        .split(' ')
        .filter((s) => s.startsWith('v1,'))
        .map((s) => s.slice(3));
      for (const sigB64 of sigsB64) {
        try {
          const provided = Buffer.from(sigB64, 'base64');
          if (
            provided.length === expectedBytes.length &&
            crypto.timingSafeEqual(expectedBytes, provided)
          ) {
            return true;
          }
        } catch {
          /* try next */
        }
      }
      return false;
    }

    // Format hex legacy : compare bytes hex décodés
    const provided = Buffer.from(signature, 'hex');
    if (provided.length !== expectedBytes.length) return false;
    return crypto.timingSafeEqual(expectedBytes, provided);
  } catch {
    return false;
  }
}

// ── Handler principal ─────────────────────────────────────────────
// v1.10.62 (Ajnaya2026v118) — Fix B1 : vérification HMAC OBLIGATOIRE en prod.
// Avant : `if (secret && signature)` → si l'un manquait, on laissait passer.
// Maintenant : prod sans secret = 503, prod avec signature manquante = 401.
router.post('/', async (req: Request, res: Response) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const signature = req.headers['resend-signature'] as string | undefined;
  const isProd = process.env.NODE_ENV === 'production';
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (isProd) {
    if (!secret) {
      console.error('[ResendWebhook] PROD: RESEND_WEBHOOK_SECRET not set — rejecting all webhooks');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    if (!signature || !rawBody) {
      console.warn('[ResendWebhook] Missing signature or rawBody — rejected');
      return res.status(401).json({ error: 'Signature required' });
    }
    if (!verifyResendSignature(rawBody, signature, secret)) {
      console.warn('[ResendWebhook] Invalid signature — rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else if (secret && signature && rawBody) {
    // Dev : vérif si tout est présent (test cohérent)
    if (!verifyResendSignature(rawBody, signature, secret)) {
      console.warn('[ResendWebhook] DEV: Invalid signature — rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.body;
  const eventType = event?.type as string | undefined;
  const emailId = event?.data?.email_id as string | undefined;

  console.log(`[ResendWebhook] ${eventType} | emailId=${emailId}`);

  const supa = getSupa();
  if (!supa) return res.status(200).json({ received: true }); // Graceful if no DB

  try {
    // v87.1 — Bounce : marquer lieu invalide + log DECLINED (hard bounces only)
    if (eventType === 'email.bounced') {
      const toEmail = event?.data?.to?.[0] as string | undefined;
      const bounceType = (event?.data?.bounce?.type ?? event?.data?.bounce_type) as
        | string
        | undefined;

      if (toEmail && bounceType === 'hard') {
        await supa
          .from('places_directory')
          .update({
            contact_email: null,
            updated_at: new Date().toISOString(),
          })
          .eq('contact_email', toEmail);
        console.log(`[ResendWebhook] Hard bounce — cleared: ${toEmail}`);
      }

      // Marquer le log correspondant comme DECLINED
      if (emailId) {
        await supa
          .from('pieuvre_b2b_hunter_log')
          .update({ status: 'DECLINED' })
          .eq('resend_msg_id', emailId);
      }
    }

    // v87.1 — Complaint : blacklist à vie + opt-out list + alerte admin
    if (eventType === 'email.complained') {
      const toEmail = event?.data?.to?.[0] as string | undefined;

      if (toEmail) {
        // 1. Ajouter à la finder_optout_list
        await supa.from('finder_optout_list').upsert(
          {
            email: toEmail.toLowerCase().trim(),
            source: 'complaint',
            reason: 'SPAM complaint via Resend webhook',
            optout_at: new Date().toISOString(),
          },
          { onConflict: 'email' },
        );

        // 2. Nettoyer places_directory
        await supa
          .from('places_directory')
          .update({
            contact_email: null,
            enrichment_source: 'MANUAL',
            updated_at: new Date().toISOString(),
          })
          .eq('contact_email', toEmail);

        console.log(`[ResendWebhook] ⚠️ SPAM complaint — blacklisted: ${toEmail}`);
      }

      // 3. Alerter admin via analytics event (best-effort)
      if (emailId) {
        const { data: log } = await supa
          .from('pieuvre_b2b_hunter_log')
          .select('driver_id, contact_address')
          .eq('resend_msg_id', emailId)
          .maybeSingle();

        if (log) {
          await supa
            .from('pieuvre_analytics_events')
            .insert({
              event_type: 'spam_complaint',
              payload: {
                driver_id: (log as any).driver_id,
                email: (log as any).contact_address ?? toEmail,
                resend_msg_id: emailId,
              },
            })
            .then(
              () => undefined,
              () => undefined,
            );
        }
      }
    }

    // v1.10.61 (Ajnaya2026v1 · Témoin Vivant Sprint 1)
    // v1.10.62 (Ajnaya2026v118) — Fix B3+B4+B5
    // Update pieuvre_conversations avec delivery_status pour la timeline driver.
    // Soft-fail si colonnes pas créées (cross-fil Pieuvre ALTER TABLE pending).
    const deliveryStatusMap: Record<string, { status: string; column: string }> = {
      'email.delivered': { status: 'delivered', column: 'delivered_at' },
      'email.opened': { status: 'read', column: 'read_at' },
      'email.clicked': { status: 'clicked', column: 'clicked_at' },
      'email.bounced': { status: 'bounced', column: 'delivered_at' },
    };
    const mapping = eventType ? deliveryStatusMap[eventType] : null;
    if (mapping && emailId) {
      try {
        const updatePayload: Record<string, any> = {
          delivery_status: mapping.status,
          provider_event_id: emailId,
        };
        updatePayload[mapping.column] = new Date().toISOString();
        // Fix B3+B4 : `eq` au lieu de `ilike` (UUID/email_id = match exact)
        const { error: updErr, count } = await supa
          .from('pieuvre_conversations')
          .update(updatePayload, { count: 'exact' })
          .eq('metadata->>resend_msg_id', emailId);
        // Fix B5 : log alert si Pieuvre n'a pas câblé resend_msg_id en metadata
        if (!updErr && (count ?? 0) === 0) {
          console.warn(
            `[ResendWebhook] 0 rows updated for emailId=${emailId.slice(0, 16)}… — Pieuvre n'a pas (encore) inséré resend_msg_id en metadata. Cross-fil action required.`,
          );
        }
      } catch (e: any) {
        // Colonnes optionnelles peuvent ne pas exister — ne bloque pas le webhook
        console.warn('[ResendWebhook] pieuvre_conversations update soft-fail:', e?.message);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('[ResendWebhook] Error:', err.message);
    // Toujours répondre 200 pour éviter les retry Resend
    return res.status(200).json({ received: true });
  }
});

export default router;
