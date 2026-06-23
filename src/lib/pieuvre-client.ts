// backend/src/lib/pieuvre-client.ts
//
// Client HTTP pour brancher l'app FOREAS sur le cerveau Pieuvre (workflow N8N
// `entry_widget_site` aka `_utils_ajnaya_respond`, ID U9oQycTltqhDHyWm).
//
// Pattern repris du fil site (Site2026v34/v40) — POST vers
// `${PIEUVRE_RESPOND_URL}` avec header `X-Foreas-Shared-Secret`. En cas de
// timeout ou d'erreur, retourne `null` pour permettre le fallback transparent
// vers le LLM direct (LangGraph Claude / GPT-4o legacy).
//
// Conforme à AJNAYA_CONTRACTS.md §8 (payload + réponse).
//
// Env vars requises (Railway) :
//   - PIEUVRE_BRAIN_ENABLED       — 'true' pour activer le routage
//   - PIEUVRE_RESPOND_URL         — URL complète du webhook N8N
//   - PIEUVRE_RESPOND_SECRET      — secret partagé (header X-Foreas-Shared-Secret)
//   - PIEUVRE_RESPOND_TIMEOUT_MS  — timeout (défaut 10000ms, latence observée 3-5s)

import { randomUUID } from 'node:crypto';

// Tentacules connus (cf. AJNAYA_CONTRACTS.md §3 et pieuvre_scripts)
export type PieuvreTentacle =
  | 'widget_site'
  | 'app_driver' // ✨ ajouté 30/04 pour FOREAS-Clean app mobile
  | 'concierge_personnel' // ✨ ajouté 30/04 pour widget sites perso chauffeurs
  | 'whatsapp'
  | 'app'
  | 'instagram_dm'
  | 'facebook_dm'
  | 'sms'
  | 'voice'
  | 'email'
  | 'telegram_dg';

export type PieuvreCanal =
  | 'web'
  | 'wa_bot'
  | 'ios'
  | 'android'
  | 'meta_graph'
  | 'twilio'
  | 'resend';

export interface PieuvreMessage {
  role: 'user' | 'assistant';
  text: string;
  type?: 'text' | 'voice' | 'image';
}

export interface PieuvrePayload {
  tentacle: PieuvreTentacle;
  canal: PieuvreCanal;
  identity_id: string | null;
  session_id: string;
  message: PieuvreMessage;
  context: {
    page_source?: string;
    scroll_section?: string;
    heat_score?: number;
    history_last_10?: Array<{ role: string; content: string }>;
    [key: string]: unknown;
  };
  meta?: {
    device?: 'mobile' | 'desktop';
    utm?: Record<string, string>;
    user_agent?: string;
    [key: string]: unknown;
  };
  client_version?: string;
}

export interface PieuvreReply {
  ok: boolean;
  reply: {
    text: string; // texte CLEAN sans audio tags (display chat bubble)
    tts_text?: string; // texte AVEC audio tags v3 (envoyé à /synthesize)
    audio_url: string | null;
    llm_model: string;
  };
  identity_id?: string;
  prospect_id?: string;
  intent_detected?: string;
  objection_detected?: string | null;
  sentiment?: string;
  next_actions?: Array<{ type: string; label?: string; url?: string; [k: string]: unknown }>;
  should_capture_phone?: boolean;
  suggest_handoff?: { target_canal: string; reason: string } | null;
  metadata?: {
    latency_ms?: number;
    cost_usd?: number;
    [k: string]: unknown;
  };
}

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Indique si la Pieuvre Brain est activée via env var.
 * Le caller doit checker ça AVANT d'appeler `callPieuvreBrain` pour économiser
 * la construction du payload quand le flag est off.
 */
export function isPieuvreBrainEnabled(): boolean {
  return process.env.PIEUVRE_BRAIN_ENABLED === 'true';
}

/**
 * Appelle le webhook Pieuvre Brain N8N et retourne la réponse parsée, ou
 * `null` en cas de timeout / erreur HTTP / payload invalide.
 *
 * **Le fallback silencieux est volontaire** : si Pieuvre est down, l'app doit
 * continuer à servir le chauffeur via le LLM direct sans crash visible.
 *
 * Idempotency-Key UUID v4 généré à chaque appel pour la dédup côté N8N
 * (cache pas encore implémenté côté Pieuvre — Sprint P0.5).
 */
/** Reason last call to Pieuvre returned null (or succeeded). Read for debug only. */
export let lastPieuvreCallStatus: {
  status: 'ok' | 'no_url_or_secret' | 'http_error' | 'no_reply_text' | 'timeout' | 'exception';
  http_code?: number;
  duration_ms?: number;
  error?: string;
  url_present?: boolean;
  secret_present?: boolean;
  body_preview?: string;
  ts?: number;
} = { status: 'ok' };

export async function callPieuvreBrain(payload: PieuvrePayload): Promise<PieuvreReply | null> {
  const url = process.env.PIEUVRE_RESPOND_URL;
  const secret = process.env.PIEUVRE_RESPOND_SECRET;
  const timeoutMs = Number(process.env.PIEUVRE_RESPOND_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!url || !secret) {
    console.warn('[PieuvreClient] PIEUVRE_RESPOND_URL ou PIEUVRE_RESPOND_SECRET manquant — skip');
    lastPieuvreCallStatus = {
      status: 'no_url_or_secret',
      url_present: !!url,
      secret_present: !!secret,
      ts: Date.now(),
    };
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Foreas-Shared-Secret': secret,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.warn(
        `[PieuvreClient] HTTP ${response.status} (${Date.now() - startedAt}ms): ${errBody.substring(0, 200)}`,
      );
      lastPieuvreCallStatus = {
        status: 'http_error',
        http_code: response.status,
        duration_ms: Date.now() - startedAt,
        body_preview: errBody.substring(0, 200),
        ts: Date.now(),
      };
      return null;
    }

    const data = (await response.json()) as PieuvreReply;

    // Garde-fou : on exige un texte de réponse non vide
    if (!data?.reply?.text || data.reply.text.trim().length === 0) {
      console.warn('[PieuvreClient] Réponse Pieuvre sans reply.text — fallback');
      lastPieuvreCallStatus = {
        status: 'no_reply_text',
        duration_ms: Date.now() - startedAt,
        body_preview: JSON.stringify(data).substring(0, 200),
        ts: Date.now(),
      };
      return null;
    }

    console.log(
      `[PieuvreClient] ✅ ${payload.tentacle} (${Date.now() - startedAt}ms) intent=${data.intent_detected} model=${data.reply.llm_model}`,
    );
    lastPieuvreCallStatus = {
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      ts: Date.now(),
    };

    return data;
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    console.warn(
      `[PieuvreClient] ${isTimeout ? '⏱️ Timeout' : '❌ Erreur'} après ${Date.now() - startedAt}ms: ${err?.message || err}`,
    );
    lastPieuvreCallStatus = {
      status: isTimeout ? 'timeout' : 'exception',
      duration_ms: Date.now() - startedAt,
      error: err?.message || String(err),
      ts: Date.now(),
    };
    return null;
  } finally {
    clearTimeout(timer);
  }
}
