/**
 * Resend Inbound Webhook — reçoit les replies des prospects
 * Ajnaya2026v87.3
 *
 * Endpoint : POST /api/webhooks/resend-inbound
 * Signature : Svix headers (svix-id, svix-timestamp, svix-signature)
 *
 * Garanties :
 *   - Signature Svix vérifiée (401 si invalide)
 *   - Idempotent : chaque svix-id n'est traité qu'une fois (via table finder_webhook_events)
 *   - Anti-boucle : drop les emails qui viennent de nos propres domaines
 *   - Fire-and-forget : on répond 200 avant de traiter (évite les retries)
 *
 * Règle : TOUJOURS retourner 200 sauf signature invalide → évite les retries en boucle.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { handleInboundEmail } from '../services/FinderConversationService.js';
import { parseLogIdFromAddress } from '../services/ThreadAddressing.js';

const router = Router();

// Domaines système FOREAS — emails ENVOYÉS par notre infra.
// On drop uniquement les emails qui reviennent depuis ces sous-domaines, pour
// éviter les boucles (bounces, auto-responders, Ajnaya → Ajnaya).
// Important : PAS `foreas.xyz` (domaine principal) car il héberge des boîtes
// humaines réelles (contact@foreas.xyz, etc.) qui peuvent légitimement
// dialoguer avec Ajnaya en tant que prospect.
const SELF_DOMAINS = ['reply.foreas.xyz'];

// Lazy Supabase service role
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}

function verifySvixSignature(
  rawBody: string,
  svixId: string | undefined,
  svixTimestamp: string | undefined,
  svixSignature: string | undefined,
  secret: string,
): boolean {
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretBytes = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice(6), 'base64')
    : Buffer.from(secret, 'utf8');

  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');

  const signatures = svixSignature
    .split(' ')
    .map((s) => s.split(',')[1])
    .filter(Boolean);
  return signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'base64'), Buffer.from(expected, 'base64'));
    } catch {
      return false;
    }
  });
}

function extractEmailAddress(raw: string): string {
  return (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim();
}

function isSelfReference(fromEmail: string): boolean {
  const domain = fromEmail.split('@')[1]?.toLowerCase() ?? '';
  return SELF_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Enregistre un svix-id dans la table de dédup.
 * Retourne `true` si c'était nouveau, `false` si déjà vu (= on skip).
 */
async function recordWebhookEvent(
  svixId: string,
  eventType: string,
  outcome: string,
  meta?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { error } = await getSupa()
      .from('finder_webhook_events')
      .insert({
        svix_id: svixId,
        event_type: eventType,
        outcome,
        meta: meta ?? {},
      });

    if (error) {
      // 23505 = unique_violation → déjà vu
      if ((error as any).code === '23505') {
        return false;
      }
      console.error('[ResendInbound] Failed to insert webhook_event:', error.message);
      // On ne bloque pas le traitement si l'insert échoue (fail-open)
      return true;
    }
    return true;
  } catch (err: any) {
    console.error('[ResendInbound] recordWebhookEvent threw:', err?.message ?? err);
    return true; // fail-open
  }
}

/**
 * Pré-check idempotence : déjà traité ?
 */
async function isAlreadyProcessed(svixId: string): Promise<boolean> {
  try {
    const { data } = await getSupa()
      .from('finder_webhook_events')
      .select('svix_id')
      .eq('svix_id', svixId)
      .maybeSingle();
    return data !== null;
  } catch {
    return false; // fail-open
  }
}

router.post('/resend-inbound', async (req: Request, res: Response) => {
  const svixId = req.header('svix-id');
  console.log('[ResendInbound] 📨 Webhook hit', {
    headers: {
      'svix-id': svixId,
      'svix-timestamp': req.header('svix-timestamp'),
      'has-signature': !!req.header('svix-signature'),
    },
    body_type: (req.body as any)?.type,
    body_to: (req.body as any)?.data?.to,
  });

  try {
    const secret = process.env.RESEND_INBOUND_SECRET;

    // ── 1. Vérif signature ──
    if (secret) {
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      const ok = verifySvixSignature(
        rawBody,
        svixId ?? undefined,
        req.header('svix-timestamp') ?? undefined,
        req.header('svix-signature') ?? undefined,
        secret,
      );
      if (!ok) {
        console.warn('[ResendInbound] ❌ Invalid signature');
        return res.status(401).json({ ok: false, error: 'invalid_signature' });
      }
    } else {
      console.warn('[ResendInbound] ⚠️ RESEND_INBOUND_SECRET not set — signature check SKIPPED');
    }

    const payload = req.body as any;

    // Ping ou autre event non-inbound → silence ok
    if (payload?.type !== 'email.received' || !payload?.data) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // ── 2. Idempotence : déjà traité ? ──
    if (svixId && (await isAlreadyProcessed(svixId))) {
      console.log(`[ResendInbound] 🔁 Already processed svix-id=${svixId} — skip`);
      return res.status(200).json({ ok: true, idempotent: true });
    }

    // ── 3. Parsing du payload ──
    const data = payload.data;
    const fromRaw: string = typeof data.from === 'string' ? data.from : (data.from?.email ?? '');
    const fromEmail = extractEmailAddress(fromRaw);
    const toRaw = Array.isArray(data.to) ? data.to[0] : data.to;
    const toString = typeof toRaw === 'string' ? toRaw : (toRaw?.email ?? '');
    const toEmail = extractEmailAddress(toString);
    const subject: string = data.subject ?? '';
    let bodyText: string = data.text ?? data.plain ?? '';
    let inReplyTo: string | undefined =
      data.headers?.['in-reply-to'] ?? data.headers?.['In-Reply-To'] ?? undefined;
    let inboundMessageId: string | undefined =
      data.headers?.['message-id'] ?? data.headers?.['Message-ID'] ?? data.message_id ?? undefined;

    // ── 3b. Hydrate depuis l'API Resend avec retry exponentiel ──
    // Le webhook payload de Resend Inbound ne contient PAS le body ni les headers
    // complets — il faut appeler GET /emails/receiving/{id} pour les récupérer.
    // L'API a une indexation en delta : elle peut retourner 404 au moment où le
    // webhook fire. On retry 3 fois avec backoff exponentiel.
    const hydrationTargetId: string | undefined =
      data.id ?? data.email_id ?? data.message_id ?? undefined;

    console.log(
      `[ResendInbound] debug payload keys=${Object.keys(data).join(',')} hasId=${!!hydrationTargetId} bodyLen=${bodyText.length}`,
    );

    const needsHydration = !bodyText || !inboundMessageId;
    if (needsHydration && hydrationTargetId && process.env.RESEND_API_KEY) {
      const resendApiKey = process.env.RESEND_API_KEY;
      const delays = [300, 700, 1500]; // ms, exponentiel
      for (let attempt = 0; attempt < delays.length; attempt++) {
        try {
          const hydrateRes = await fetch(
            `https://api.resend.com/emails/receiving/${hydrationTargetId}`,
            { headers: { Authorization: `Bearer ${resendApiKey}` } },
          );

          if (hydrateRes.ok) {
            const full: any = await hydrateRes.json();
            if (!bodyText && full.text) bodyText = full.text as string;
            if (!inboundMessageId && full.message_id) {
              inboundMessageId = full.message_id as string;
            }
            if (!inboundMessageId && full.headers?.['message-id']) {
              inboundMessageId = full.headers['message-id'];
            }
            if (!inReplyTo && full.headers?.['in-reply-to']) {
              inReplyTo = full.headers['in-reply-to'];
            }
            console.log(
              `[ResendInbound] 🔄 Hydrated (attempt ${attempt + 1}) — bodyLen=${bodyText.length} msgId=${inboundMessageId ?? 'n/a'}`,
            );
            break;
          } else if (hydrateRes.status === 404 && attempt < delays.length - 1) {
            console.log(
              `[ResendInbound] hydrate attempt ${attempt + 1} got 404, retrying in ${delays[attempt]}ms`,
            );
            await new Promise((r) => setTimeout(r, delays[attempt]));
            continue;
          } else {
            console.warn(
              `[ResendInbound] ⚠️ Failed to hydrate — HTTP ${hydrateRes.status} (attempt ${attempt + 1})`,
            );
            break;
          }
        } catch (err: any) {
          console.error(
            `[ResendInbound] Hydrate error (attempt ${attempt + 1}):`,
            err?.message ?? err,
          );
          if (attempt === delays.length - 1) break;
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
    }

    if (!fromEmail) {
      if (svixId) await recordWebhookEvent(svixId, payload.type, 'no_from');
      return res.status(200).json({ ok: true, ignored: true, reason: 'no_from' });
    }

    // ── 4. Anti-boucle self-reference ──
    if (isSelfReference(fromEmail)) {
      console.warn(`[ResendInbound] 🚫 Self-reference from=${fromEmail} — drop to avoid loop`);
      if (svixId) {
        await recordWebhookEvent(svixId, payload.type, 'self_reference', {
          from: fromEmail,
          to: toEmail,
          subject,
        });
      }
      return res.status(200).json({ ok: true, ignored: true, reason: 'self_reference' });
    }

    const logId = parseLogIdFromAddress(toEmail);
    console.log(
      `[ResendInbound] ✅ valid signature — from=${fromEmail} to=${toEmail} logId=${logId ?? 'n/a'} inboundMsgId=${inboundMessageId ?? 'n/a'} subject="${subject}"`,
    );

    // ── 5. Enregistrement idempotence (AVANT le traitement async) ──
    if (svixId) {
      await recordWebhookEvent(svixId, payload.type, 'processing', {
        from: fromEmail,
        to: toEmail,
        subject,
      });
    }

    // ── 6. Traitement async (fire-and-forget, sinon Resend retry sur timeout) ──
    handleInboundEmail({
      from: fromEmail,
      to: toEmail,
      subject,
      bodyText,
      inReplyTo,
      inboundMessageId,
      svixId: svixId ?? undefined,
      rawPayload: data,
    }).catch((err: any) => {
      console.error('[ResendInbound] handleInboundEmail error:', err?.message ?? err);
    });

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('[ResendInbound] Route error:', err?.message ?? err);
    return res.status(200).json({ ok: false, error: 'internal_error' });
  }
});

export default router;
