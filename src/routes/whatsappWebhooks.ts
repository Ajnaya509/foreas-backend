/**
 * Meta WhatsApp Webhooks — Suivi delivery status outreach prospects
 * v1.10.61 (Ajnaya2026v1 · Témoin Vivant Sprint 1)
 *
 *   GET  /api/webhooks/whatsapp/status   — Verification challenge Meta (handshake)
 *   POST /api/webhooks/whatsapp/status   — Events delivery (sent/delivered/read/failed)
 *
 * Configurer côté Meta Business Suite → WhatsApp → Configuration →
 * Webhooks : URL = https://foreas-stripe-backend-production.up.railway.app/api/webhooks/whatsapp/status
 * Verify Token = process.env.META_WHATSAPP_VERIFY_TOKEN
 * App Secret  = process.env.META_APP_SECRET (pour HMAC X-Hub-Signature-256)
 *
 * Format event Meta WhatsApp Cloud API (statuses) :
 * {
 *   entry: [{
 *     changes: [{
 *       value: {
 *         statuses: [{
 *           id: "wamid.HBgL...",
 *           status: "sent" | "delivered" | "read" | "failed",
 *           timestamp: "1734567890",
 *           recipient_id: "33745550874",
 *           ...
 *         }]
 *       }
 *     }]
 *   }]
 * }
 */

import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { sendDriverPush } from '../lib/expoPush.js';

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

// ── Forward payload brut vers N8N Bridge WhatsApp Inbound (fire-and-forget) ──
// N8N workflow Y47TmiaYWHs0n6Kv "Bridge — WhatsApp Inbound Handler" gère
// tout : anti-spam → Haiku classifier → _utils_ajnaya_respond → WA reply.
// URL stable du Bridge N8N — override possible via PIEUVRE_N8N_WA_INBOUND_URL
const N8N_WA_INBOUND_URL =
  process.env.PIEUVRE_N8N_WA_INBOUND_URL ||
  'https://n8n.srv1534739.hstgr.cloud/webhook/whatsapp-inbound';

function forwardToN8N(rawBody: Buffer): void {
  const secret = process.env.PIEUVRE_WEBHOOK_SECRET;
  const bodyStr = rawBody.toString('utf8');
  fetch(N8N_WA_INBOUND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Foreas-Shared-Secret': secret } : {}),
    },
    body: bodyStr,
  })
    .then(async (r) => {
      if (!r.ok) {
        const err = await r.text().catch(() => '');
        console.warn(`[WhatsAppWebhook] N8N forward ${r.status}: ${err.slice(0, 200)}`);
      } else {
        console.log('[WhatsAppWebhook] N8N forward OK');
      }
    })
    .catch((err) => console.warn('[WhatsAppWebhook] N8N forward error:', err?.message));
}

// ── Verification challenge Meta (handshake) ────────────────────────────
// Meta envoie GET /webhook?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
// On répond avec le challenge si le token correspond.
router.get('/status', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedToken = process.env.META_WHATSAPP_VERIFY_TOKEN;
  if (!expectedToken) {
    console.warn('[WhatsAppWebhook] META_WHATSAPP_VERIFY_TOKEN not set');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  if (mode === 'subscribe' && token === expectedToken) {
    console.log('[WhatsAppWebhook] Verification handshake OK');
    return res.status(200).send(challenge);
  }
  console.warn('[WhatsAppWebhook] Verification failed (mode/token mismatch)');
  return res.status(403).json({ error: 'Verification failed' });
});

// ── Verification HMAC X-Hub-Signature-256 ──────────────────────────────
// v1.10.62 — Fix W11 : compare en bytes hex décodés au lieu de strings hex.
function verifyMetaSignature(rawBody: Buffer, signatureHeader: string, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expectedHex = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice(7); // strip "sha256="
  // Compare bytes (32 bytes) — plus rigoureux et timing-safe sur la bonne taille.
  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const providedBuf = Buffer.from(providedHex, 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

// ── Handler events delivery ────────────────────────────────────────────
router.post('/status', async (req: Request, res: Response) => {
  // v1.10.62 — Fix B1 critique : vérification HMAC OBLIGATOIRE en prod.
  // En DEV (NODE_ENV !== 'production'), on tolère pas de secret pour faciliter
  // les tests locaux. En prod, sans META_APP_SECRET configuré, on refuse tout.
  const appSecret = process.env.META_APP_SECRET;
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const isProd = process.env.NODE_ENV === 'production';
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (isProd) {
    if (!appSecret) {
      console.error('[WhatsAppWebhook] PROD: META_APP_SECRET not set — rejecting all webhooks');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    if (!signature || !rawBody) {
      console.warn('[WhatsAppWebhook] Missing signature or rawBody — rejected');
      return res.status(401).json({ error: 'Signature required' });
    }
    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      console.warn('[WhatsAppWebhook] Invalid signature — rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else if (appSecret && signature && rawBody) {
    // Dev : si secret + signature présents, on vérifie quand même (test cohérent)
    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      console.warn('[WhatsAppWebhook] DEV: Invalid signature — rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Toujours répondre 200 OK rapidement (Meta retry agressif sinon)
  res.status(200).json({ received: true });

  // Forward immédiat vers N8N Bridge (avant tout traitement local)
  // N8N gère : normalisation → anti-spam → Haiku classifier → Ajnaya → WA reply
  if (rawBody) {
    forwardToN8N(rawBody);
  }

  // Process en arrière-plan (Meta a déjà reçu son ACK)
  setImmediate(async () => {
    try {
      const supa = getSupa();
      if (!supa) return;

      const entries = req.body?.entry || [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const statuses = change?.value?.statuses || [];
          for (const st of statuses) {
            const wamid = st.id as string | undefined;
            const metaStatus = st.status as string | undefined;
            const timestamp = st.timestamp
              ? new Date(parseInt(st.timestamp) * 1000).toISOString()
              : new Date().toISOString();

            if (!wamid || !metaStatus) continue;

            console.log(`[WhatsAppWebhook] ${metaStatus} | wamid=${wamid}`);

            // Mapping Meta status → FOREAS delivery_status
            // Meta : sent → delivered → read (pas de "clicked" natif WhatsApp)
            const statusMap: Record<string, { status: string; column: string }> = {
              sent: { status: 'sent', column: 'created_at' /* déjà set */ },
              delivered: { status: 'delivered', column: 'delivered_at' },
              read: { status: 'read', column: 'read_at' },
              failed: { status: 'failed', column: 'delivered_at' },
            };
            const mapping = statusMap[metaStatus];
            if (!mapping || mapping.column === 'created_at') continue;

            try {
              const updatePayload: Record<string, any> = {
                delivery_status: mapping.status,
                provider_event_id: wamid,
              };
              updatePayload[mapping.column] = timestamp;
              // v1.10.62 — Fix B3+B4 : `eq` au lieu de `ilike` (UUIDs/wamids =
              // match exact, pas de wildcard, plus rapide et plus sûr).
              const { error, count } = await supa
                .from('pieuvre_conversations')
                .update(updatePayload, { count: 'exact' })
                .eq('metadata->>whatsapp_wamid', wamid);
              // v1.10.62 — Fix B5 : log alerte si Pieuvre n'a pas câblé le wamid
              // dans metadata (cross-fil pending). Permet de détecter no-op.
              if (!error && (count ?? 0) === 0) {
                console.warn(
                  `[WhatsAppWebhook] 0 rows updated for wamid=${wamid.slice(0, 16)}… — Pieuvre n'a pas (encore) inséré whatsapp_wamid en metadata. Cross-fil action required.`,
                );
              }
            } catch (e: any) {
              // Colonnes optionnelles peuvent ne pas exister (ALTER TABLE pending Pieuvre)
              console.warn('[WhatsAppWebhook] pieuvre_conversations update soft-fail:', e?.message);
            }
          }

          // Messages entrants (réponses prospects)
          const messages = change?.value?.messages || [];
          for (const msg of messages) {
            const wamid = msg.id as string | undefined;
            const fromPhone = msg.from as string | undefined;
            const textBody = msg.text?.body as string | undefined;
            const timestamp = msg.timestamp
              ? new Date(parseInt(msg.timestamp) * 1000).toISOString()
              : new Date().toISOString();

            if (!wamid || !fromPhone) continue;

            // v1.10.62 — Fix W7 : tronque le phone pour le log (PII RGPD)
            const truncPhone = fromPhone.length > 4 ? `***${fromPhone.slice(-4)}` : '***';
            console.log(`[WhatsAppWebhook] inbound message from ${truncPhone}`);

            // v1.10.62 — Fix B6 : Cross-driver leak prevention.
            // AVANT : UPDATE outbound match juste par recipient_phone → si 2
            // chauffeurs avaient contacté ce numéro, replied_at allait sur le
            // mauvais. APRÈS : on cherche d'abord LE prospect outbound le plus
            // récent qui matche ce phone ET on récupère son driver_id explicite,
            // puis UPDATE filtré sur driver_id + id pour rester scoped.
            try {
              // Étape 1 : trouve l'outbound matching le plus récent (avec driver_id)
              const { data: matchingOutbound } = await supa
                .from('pieuvre_conversations')
                .select('id, driver_id')
                .eq('direction', 'outbound')
                .eq('channel', 'whatsapp')
                .eq('metadata->>recipient_phone', fromPhone)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              const resolvedDriverId = matchingOutbound?.driver_id ?? null;

              // Étape 2 : INSERT inbound avec driver_id résolu (ou null si pas de match)
              await supa.from('pieuvre_conversations').insert({
                tentacle: 'whatsapp_inbound',
                channel: 'whatsapp',
                direction: 'inbound',
                content: textBody || '',
                created_at: timestamp,
                driver_id: resolvedDriverId,
                metadata: {
                  whatsapp_wamid: wamid,
                  from_phone: fromPhone,
                  source: 'meta_webhook_inbound',
                  matched_outbound_id: matchingOutbound?.id ?? null,
                },
              });

              // Étape 3 : UPDATE le bon record outbound par ID exact + driver_id
              // (pas de match phone-only à risque cross-driver)
              if (matchingOutbound?.id && matchingOutbound?.driver_id) {
                await supa
                  .from('pieuvre_conversations')
                  .update({
                    delivery_status: 'replied',
                    replied_at: timestamp,
                  })
                  .eq('id', matchingOutbound.id)
                  .eq('driver_id', matchingOutbound.driver_id);

                // v1.10.62 (Ajnaya2026v119) — Sprint 2.1.1 Pont Réponses
                // Push notif au chauffeur "📨 Maître X t'a répondu" avec
                // deep-link vers la conversation thread.
                try {
                  // Lookup prospect_id depuis le record outbound (metadata)
                  const { data: outboundFull } = await supa
                    .from('pieuvre_conversations')
                    .select('metadata')
                    .eq('id', matchingOutbound.id)
                    .maybeSingle();
                  const prospectId = (outboundFull?.metadata as any)?.prospect_id ?? null;

                  // Lookup le nom du prospect pour personnaliser la notif
                  let prospectLabel = 'Un prospect';
                  if (prospectId) {
                    const { data: prospect } = await supa
                      .from('concierge_acquired_prospects')
                      .select('contact_name, company_name')
                      .eq('id', prospectId)
                      .eq('driver_id', matchingOutbound.driver_id)
                      .maybeSingle();
                    if (prospect) {
                      prospectLabel =
                        prospect.contact_name || prospect.company_name || 'Un prospect';
                    }
                  }

                  // v1.10.63 (Ajnaya2026v120) — Payload push minimal :
                  // {type, prospect_id, channel} suffit pour le deep link.
                  // conversation_id retiré (économie ~30 bytes × N notifs/mois).
                  await sendDriverPush(matchingOutbound.driver_id, {
                    title: `📨 ${prospectLabel} t'a répondu`,
                    body: textBody
                      ? textBody.length > 80
                        ? textBody.slice(0, 77) + '…'
                        : textBody
                      : 'Touche pour ouvrir la conversation',
                    data: {
                      type: 'prospect_reply',
                      prospect_id: prospectId,
                      channel: 'whatsapp',
                    },
                    categoryId: 'prospect_reply',
                  });
                } catch (pushErr: any) {
                  // Push non-bloquant : on log et on continue
                  console.warn('[WhatsAppWebhook] push notif soft-fail:', pushErr?.message);
                }
              } else {
                console.warn(
                  `[WhatsAppWebhook] No matching outbound for ${truncPhone} — inbound saved without thread link`,
                );
              }
            } catch (e: any) {
              console.warn('[WhatsAppWebhook] inbound insert soft-fail:', e?.message);
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[WhatsAppWebhook] Background error:', err?.message);
    }
  });
});

export default router;
