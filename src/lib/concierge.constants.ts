/**
 * concierge.constants.ts — Constantes du Témoin Vivant
 * v1.10.63 (Ajnaya2026v120) — externalisation des magic numbers
 *
 * Centralise tous les TTL, timeouts et limites du flow Témoin Vivant pour
 * faciliter la maintenance, le tuning prod et les tests.
 */

// ─── Drafts cache (memoire RAM, dans conciergeAcquisition.routes.ts) ─────────

/** Durée de vie d'un draft outreach preview en cache (5 min). */
export const DRAFT_TTL_MS = 5 * 60 * 1000;

/** Cap mémoire du _draftCache (LRU eviction si dépassé). */
export const DRAFT_CACHE_MAX = 1000;

/** Période d'auto-purge des drafts expirés (1 min). */
export const DRAFT_PURGE_INTERVAL_MS = 60 * 1000;

// ─── Timeouts externes ──────────────────────────────────────────────────────

/** Timeout Anthropic Sonnet 4.6 (preview generation + draft-reply). */
export const ANTHROPIC_TIMEOUT_MS = 5_000;

/** Timeout webhook Pieuvre (POST concierge-outreach). */
export const PIEUVRE_WEBHOOK_TIMEOUT_MS = 1_500;

/** Timeout fetch Expo Push API (sendDriverPush). */
export const EXPO_PUSH_TIMEOUT_MS = 3_000;

// ─── Inputs validation ─────────────────────────────────────────────────────

/** Longueur min d'un message_text pour /reply. */
export const REPLY_MIN_LENGTH = 2;

/** Longueur max d'un message_text pour /reply. */
export const REPLY_MAX_LENGTH = 1500;

/** Limite de pieuvre_conversations remontés par /inbox. */
export const INBOX_MAX_ROWS = 500;

/** Nombre de messages remontés pour le contexte du draft-reply Anthropic. */
export const DRAFT_CONTEXT_MESSAGES = 12;

// ─── Validation regex ──────────────────────────────────────────────────────

/** UUID v4 strict (anti-injection wildcard ilike). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
