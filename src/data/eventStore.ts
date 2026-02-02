/**
 * FOREAS Data Platform V1 - Event Store
 * ======================================
 * Append-only analytics event tracking.
 * Tables: public.events
 *
 * RÈGLES:
 * - INSERT ONLY (pas de UPDATE/DELETE)
 * - Async fire-and-forget (ne bloque pas le flow)
 * - Payload sanitized (pas de PII brut)
 */

import { getSupabaseAdmin } from '../helpers/supabase';
import type { TrackEventInput, Event, EventCategory, ActorRole } from './types';

// ============================================
// PII SANITIZATION
// ============================================

const PII_PATTERNS = [
  // Phone numbers (FR, international)
  /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}/g,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // French SSN (NIR)
  /[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}/g,
  // Credit card numbers
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  // IP addresses
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
];

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      let sanitizedValue = value;
      for (const pattern of PII_PATTERNS) {
        sanitizedValue = sanitizedValue.replace(pattern, '[REDACTED]');
      }
      sanitized[key] = sanitizedValue;
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizePayload(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ============================================
// EVENT TRACKING
// ============================================

/**
 * Track an analytics event (append-only, async).
 * Fire-and-forget: errors are logged but don't throw.
 */
export async function trackEvent(input: TrackEventInput): Promise<string | null> {
  const supabase = getSupabaseAdmin();

  const sanitizedPayload = input.payload ? sanitizePayload(input.payload) : {};

  const eventData = {
    event_name: input.eventName,
    event_category: input.eventCategory || 'general',
    actor_id: input.actorId || null,
    actor_role: input.actorRole || null,
    payload: sanitizedPayload,
    source: input.source || 'backend',
    session_id: input.sessionId || null,
    ip_hash: input.ipHash || null,
  };

  try {
    const { data, error } = await supabase
      .from('events')
      .insert(eventData)
      .select('id')
      .single();

    if (error) {
      console.error('[EventStore] Insert failed:', error.message);
      return null;
    }

    console.log(`[EventStore] Tracked: ${input.eventName} (${data.id})`);
    return data.id;
  } catch (err) {
    console.error('[EventStore] Exception:', err);
    return null;
  }
}

/**
 * Track event without waiting (true fire-and-forget)
 */
export function trackEventAsync(input: TrackEventInput): void {
  trackEvent(input).catch((err) => {
    console.error('[EventStore] Async track failed:', err);
  });
}

// ============================================
// QUERY HELPERS (Admin only)
// ============================================

export interface EventQueryOptions {
  actorId?: string;
  eventName?: string;
  eventCategory?: EventCategory;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Query events (admin use only, via service_role)
 */
export async function queryEvents(options: EventQueryOptions): Promise<Event[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('events')
    .select('*')
    .order('created_at', { ascending: false });

  if (options.actorId) {
    query = query.eq('actor_id', options.actorId);
  }

  if (options.eventName) {
    query = query.eq('event_name', options.eventName);
  }

  if (options.eventCategory) {
    query = query.eq('event_category', options.eventCategory);
  }

  if (options.startDate) {
    query = query.gte('created_at', options.startDate.toISOString());
  }

  if (options.endDate) {
    query = query.lte('created_at', options.endDate.toISOString());
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[EventStore] Query failed:', error.message);
    throw new Error(`Event query failed: ${error.message}`);
  }

  return data as Event[];
}

/**
 * Count events by criteria
 */
export async function countEvents(options: Omit<EventQueryOptions, 'limit' | 'offset'>): Promise<number> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('events')
    .select('id', { count: 'exact', head: true });

  if (options.actorId) {
    query = query.eq('actor_id', options.actorId);
  }

  if (options.eventName) {
    query = query.eq('event_name', options.eventName);
  }

  if (options.eventCategory) {
    query = query.eq('event_category', options.eventCategory);
  }

  if (options.startDate) {
    query = query.gte('created_at', options.startDate.toISOString());
  }

  if (options.endDate) {
    query = query.lte('created_at', options.endDate.toISOString());
  }

  const { count, error } = await query;

  if (error) {
    console.error('[EventStore] Count failed:', error.message);
    throw new Error(`Event count failed: ${error.message}`);
  }

  return count || 0;
}

// ============================================
// COMMON EVENT HELPERS
// ============================================

/**
 * Track navigation event
 */
export function trackNavigation(
  driverId: string,
  destination: { lat: number; lng: number; label: string },
  source: 'voice' | 'tap' | 'auto'
): void {
  trackEventAsync({
    eventName: 'navigation.started',
    eventCategory: 'navigation',
    actorId: driverId,
    actorRole: 'driver',
    payload: {
      destination_label: destination.label,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      trigger_source: source,
    },
  });
}

/**
 * Track recommendation shown
 */
export function trackRecommendationShown(
  driverId: string,
  recommendationType: string,
  confidence: number
): void {
  trackEventAsync({
    eventName: 'recommendation.shown',
    eventCategory: 'recommendation',
    actorId: driverId,
    actorRole: 'driver',
    payload: {
      type: recommendationType,
      confidence,
    },
  });
}

/**
 * Track session start
 */
export function trackSessionStart(
  driverId: string | undefined,
  sessionId: string,
  source: 'mobile' | 'web'
): void {
  trackEventAsync({
    eventName: 'session.started',
    eventCategory: 'session',
    actorId: driverId,
    actorRole: driverId ? 'driver' : 'anonymous',
    sessionId,
    source,
    payload: {
      started_at: new Date().toISOString(),
    },
  });
}

/**
 * Track session end
 */
export function trackSessionEnd(
  driverId: string | undefined,
  sessionId: string,
  durationMs: number
): void {
  trackEventAsync({
    eventName: 'session.ended',
    eventCategory: 'session',
    actorId: driverId,
    actorRole: driverId ? 'driver' : 'anonymous',
    sessionId,
    payload: {
      duration_ms: durationMs,
      ended_at: new Date().toISOString(),
    },
  });
}

/**
 * Track AI interaction
 */
export function trackAIInteraction(
  driverId: string,
  interactionType: 'voice_input' | 'text_input' | 'tts_playback',
  metadata?: Record<string, unknown>
): void {
  trackEventAsync({
    eventName: `ai.${interactionType}`,
    eventCategory: 'recommendation',
    actorId: driverId,
    actorRole: 'driver',
    payload: metadata || {},
  });
}
