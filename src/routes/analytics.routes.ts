/**
 * FOREAS Data Platform V1 - Analytics Routes
 * ==========================================
 * PUBLIC endpoint for event tracking from mobile/web.
 *
 * SÉCURITÉ V1:
 * - Whitelist stricte des 20 events V1
 * - Denylist PII (phone, email, card, etc.)
 * - Rate-limit par IP (100 req/min)
 * - actor_id accepté (pas de JWT requis)
 *
 * ENDPOINTS:
 * - POST /api/analytics/track → Track single event
 * - POST /api/analytics/batch → Track multiple events
 */

import { Router, Request, Response } from 'express';
import { trackEvent, trackEventAsync } from '../data/eventStore';
import type { EventCategory, ActorRole } from '../data/types';
import crypto from 'crypto';

const router = Router();

// ============================================
// V1 EVENT WHITELIST (20 events)
// ============================================

const EVENT_WHITELIST_V1: Set<string> = new Set([
  // Session
  'session.started',
  'session.ended',
  'session.resumed',

  // Navigation
  'navigation.started',
  'navigation.completed',
  'navigation.cancelled',

  // Recommendation
  'reco.shown',
  'reco.accepted',
  'reco.rejected',
  'reco.ignored',

  // Earnings
  'earnings.trip_completed',
  'earnings.daily_summary',

  // Support
  'support.chat_started',
  'support.issue_resolved',

  // Subscription
  'subscription.started',
  'subscription.cancelled',
  'subscription.renewed',

  // Features
  'features.refreshed',

  // Feedback
  'outcome.feedback',

  // App
  'app.error',
]);

// ============================================
// PII DENYLIST PATTERNS
// ============================================

const PII_PATTERNS = [
  // Phone numbers
  /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{2,4}[-.\s]?\d{0,4}/g,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // French SSN (NIR)
  /[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}/g,
  // Credit card numbers
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  // CVV
  /\b\d{3,4}\b/g,
  // IBAN
  /[A-Z]{2}\d{2}[A-Z0-9]{4,30}/g,
];

const PII_FIELD_DENYLIST = new Set([
  'phone', 'telephone', 'mobile', 'cell',
  'email', 'mail', 'courriel',
  'password', 'pwd', 'pass', 'secret',
  'ssn', 'nir', 'social_security',
  'card', 'credit_card', 'cc', 'cvv', 'cvc',
  'iban', 'bic', 'swift',
  'token', 'api_key', 'apikey', 'secret_key',
  'address', 'adresse', 'rue', 'street',
  'full_name', 'nom_complet',
]);

// ============================================
// RATE LIMITING (In-Memory V1)
// ============================================

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // 100 requests per minute per IP

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const key = ip;

  const entry = rateLimitMap.get(key);

  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (entry.resetAt < now) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// SANITIZATION
// ============================================

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    // Skip denied fields entirely
    if (PII_FIELD_DENYLIST.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    if (typeof value === 'string') {
      let sanitizedValue = value;
      for (const pattern of PII_PATTERNS) {
        sanitizedValue = sanitizedValue.replace(pattern, '[REDACTED]');
      }
      sanitized[key] = sanitizedValue;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizePayload(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? sanitizePayload(item as Record<string, unknown>)
          : item
      );
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function hashIP(ip: string): string {
  return crypto.createHash('sha256').update(ip + process.env.FOREAS_SERVICE_KEY).digest('hex').substring(0, 16);
}

// ============================================
// UUID VALIDATION (V1 POLICY: strict UUID or null)
// ============================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(value: string): boolean {
  return UUID_REGEX.test(value);
}

// ============================================
// VALIDATION
// ============================================

interface TrackEventBody {
  event_name: string;
  actor_id?: string;
  session_id?: string;
  payload?: Record<string, unknown>;
  source?: 'mobile' | 'web';
}

function validateEventBody(body: unknown): { valid: boolean; error?: string; data?: TrackEventBody } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be an object' };
  }

  const { event_name, actor_id, session_id, payload, source } = body as Record<string, unknown>;

  if (!event_name || typeof event_name !== 'string') {
    return { valid: false, error: 'event_name is required and must be a string' };
  }

  if (!EVENT_WHITELIST_V1.has(event_name)) {
    return { valid: false, error: `Unknown event: ${event_name}. Allowed: ${Array.from(EVENT_WHITELIST_V1).join(', ')}` };
  }

  if (actor_id && typeof actor_id !== 'string') {
    return { valid: false, error: 'actor_id must be a string' };
  }

  // V1 POLICY: actor_id must be a valid UUID or null/undefined
  if (actor_id && typeof actor_id === 'string' && !isValidUUID(actor_id)) {
    return { valid: false, error: 'actor_id must be a valid UUID (e.g., 550e8400-e29b-41d4-a716-446655440000) or omitted for anonymous events' };
  }

  if (session_id && typeof session_id !== 'string') {
    return { valid: false, error: 'session_id must be a string' };
  }

  if (payload && typeof payload !== 'object') {
    return { valid: false, error: 'payload must be an object' };
  }

  if (source && !['mobile', 'web'].includes(source as string)) {
    return { valid: false, error: 'source must be "mobile" or "web"' };
  }

  return {
    valid: true,
    data: {
      event_name: event_name as string,
      actor_id: actor_id as string | undefined,
      session_id: session_id as string | undefined,
      payload: payload as Record<string, unknown> | undefined,
      source: (source as 'mobile' | 'web') || 'mobile',
    },
  };
}

// ============================================
// CATEGORY INFERENCE
// ============================================

function inferCategory(eventName: string): EventCategory {
  if (eventName.startsWith('session.')) return 'session';
  if (eventName.startsWith('navigation.')) return 'navigation';
  if (eventName.startsWith('reco.') || eventName.startsWith('outcome.')) return 'recommendation';
  if (eventName.startsWith('earnings.')) return 'earnings';
  if (eventName.startsWith('support.')) return 'support';
  if (eventName.startsWith('subscription.')) return 'subscription';
  return 'general';
}

// ============================================
// ROUTES
// ============================================

/**
 * POST /api/analytics/track
 * Track a single event (public, no auth required)
 */
router.post('/track', async (req: Request, res: Response) => {
  const ip = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';

  // Rate limit check
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      success: false,
      error: 'RATE_LIMITED',
      message: 'Too many requests. Try again later.',
    });
  }

  // Validate body
  const validation = validateEventBody(req.body);
  if (!validation.valid || !validation.data) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: validation.error,
    });
  }

  const { event_name, actor_id, session_id, payload, source } = validation.data;

  // Sanitize payload
  const sanitizedPayload = payload ? sanitizePayload(payload) : {};

  // Track event
  const eventId = await trackEvent({
    eventName: event_name,
    eventCategory: inferCategory(event_name),
    actorId: actor_id,
    actorRole: actor_id ? 'driver' : 'anonymous',
    payload: sanitizedPayload,
    source,
    sessionId: session_id,
    ipHash: hashIP(ip),
  });

  if (!eventId) {
    return res.status(500).json({
      success: false,
      error: 'TRACKING_FAILED',
      message: 'Failed to track event',
    });
  }

  console.log(`[Analytics] Tracked: ${event_name} (${eventId}) from ${source}`);

  return res.status(201).json({
    success: true,
    event_id: eventId,
  });
});

/**
 * POST /api/analytics/batch
 * Track multiple events (public, no auth required)
 */
router.post('/batch', async (req: Request, res: Response) => {
  const ip = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';

  // Rate limit check
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      success: false,
      error: 'RATE_LIMITED',
      message: 'Too many requests. Try again later.',
    });
  }

  const { events } = req.body;

  if (!Array.isArray(events)) {
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: 'events must be an array',
    });
  }

  if (events.length > 50) {
    return res.status(400).json({
      success: false,
      error: 'BATCH_TOO_LARGE',
      message: 'Maximum 50 events per batch',
    });
  }

  const results: Array<{ event_name: string; success: boolean; event_id?: string; error?: string }> = [];
  const ipHash = hashIP(ip);

  for (const event of events) {
    const validation = validateEventBody(event);

    if (!validation.valid || !validation.data) {
      results.push({
        event_name: (event as any)?.event_name || 'unknown',
        success: false,
        error: validation.error,
      });
      continue;
    }

    const { event_name, actor_id, session_id, payload, source } = validation.data;
    const sanitizedPayload = payload ? sanitizePayload(payload) : {};

    // Use async tracking for batch (fire-and-forget)
    trackEventAsync({
      eventName: event_name,
      eventCategory: inferCategory(event_name),
      actorId: actor_id,
      actorRole: actor_id ? 'driver' : 'anonymous',
      payload: sanitizedPayload,
      source,
      sessionId: session_id,
      ipHash,
    });

    results.push({
      event_name,
      success: true,
    });
  }

  const successCount = results.filter(r => r.success).length;
  console.log(`[Analytics] Batch: ${successCount}/${events.length} events tracked`);

  return res.status(201).json({
    success: true,
    total: events.length,
    tracked: successCount,
    results,
  });
});

/**
 * GET /api/analytics/events
 * List allowed events (public, for SDK reference)
 */
router.get('/events', (_req: Request, res: Response) => {
  res.json({
    version: 'v1',
    events: Array.from(EVENT_WHITELIST_V1).map(name => ({
      name,
      category: inferCategory(name),
    })),
  });
});

/**
 * GET /api/analytics/health
 * Health check for analytics service
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'analytics',
    version: 'v1',
    events_allowed: EVENT_WHITELIST_V1.size,
    timestamp: new Date().toISOString(),
  });
});

export { router as analyticsRouter };
