/**
 * FOREAS Data Platform V1 - Audit Log
 * ====================================
 * Security-sensitive action logging.
 * Tables: public.audit_logs
 *
 * RÈGLES:
 * - Log toutes les actions admin/support
 * - Append-only (pas de modification)
 * - PII redactée dans details
 */

import { getSupabaseAdmin } from '../helpers/supabase';
import type { LogAuditInput, AuditLog, ActorRole } from './types';

// ============================================
// AUDIT LOGGING
// ============================================

/**
 * Log an audit event
 */
export async function logAudit(input: LogAuditInput): Promise<string> {
  const supabase = getSupabaseAdmin();

  const auditData = {
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType || null,
    target_id: input.targetId || null,
    details: redactAuditDetails(input.details || {}),
    ip_hash: input.ipHash || null,
    user_agent: input.userAgent || null,
  };

  const { data, error } = await supabase
    .from('audit_logs')
    .insert(auditData)
    .select('id')
    .single();

  if (error) {
    console.error('[AuditLog] Insert failed:', error.message);
    throw new Error(`Failed to log audit: ${error.message}`);
  }

  console.log(`[AuditLog] ${input.actorRole}:${input.actorId} - ${input.action}`);
  return data.id;
}

/**
 * Log audit without waiting (async)
 */
export function logAuditAsync(input: LogAuditInput): void {
  logAudit(input).catch((err) => {
    console.error('[AuditLog] Async log failed:', err);
  });
}

// ============================================
// PII REDACTION FOR AUDIT
// ============================================

const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'credit_card',
  'card_number',
  'cvv',
  'ssn',
  'phone',
  'email',
  'address',
];

function redactAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();

    // Check if key contains sensitive terms
    const isSensitive = SENSITIVE_KEYS.some((s) => lowerKey.includes(s));

    if (isSensitive) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactAuditDetails(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

// ============================================
// AUDIT QUERIES (Admin only)
// ============================================

export interface AuditQueryOptions {
  actorId?: string;
  actorRole?: ActorRole;
  action?: string;
  targetType?: string;
  targetId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Query audit logs (admin only)
 */
export async function queryAuditLogs(options: AuditQueryOptions): Promise<AuditLog[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('audit_logs')
    .select()
    .order('created_at', { ascending: false });

  if (options.actorId) {
    query = query.eq('actor_id', options.actorId);
  }

  if (options.actorRole) {
    query = query.eq('actor_role', options.actorRole);
  }

  if (options.action) {
    query = query.ilike('action', `%${options.action}%`);
  }

  if (options.targetType) {
    query = query.eq('target_type', options.targetType);
  }

  if (options.targetId) {
    query = query.eq('target_id', options.targetId);
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
    console.error('[AuditLog] Query failed:', error.message);
    throw new Error(`Failed to query audit logs: ${error.message}`);
  }

  return data as AuditLog[];
}

/**
 * Get audit logs for a specific target
 */
export async function getTargetAuditLogs(
  targetType: string,
  targetId: string,
  limit = 50
): Promise<AuditLog[]> {
  return queryAuditLogs({ targetType, targetId, limit });
}

/**
 * Get audit logs for a specific actor
 */
export async function getActorAuditLogs(
  actorId: string,
  limit = 50
): Promise<AuditLog[]> {
  return queryAuditLogs({ actorId, limit });
}

// ============================================
// COMMON AUDIT HELPERS
// ============================================

/**
 * Log user action
 */
export function logUserAction(
  actorId: string,
  actorRole: ActorRole,
  action: string,
  details?: Record<string, unknown>
): void {
  logAuditAsync({
    actorId,
    actorRole,
    action,
    details,
  });
}

/**
 * Log admin action on a user
 */
export function logAdminUserAction(
  adminId: string,
  action: string,
  targetUserId: string,
  details?: Record<string, unknown>,
  ipHash?: string
): void {
  logAuditAsync({
    actorId: adminId,
    actorRole: 'admin',
    action,
    targetType: 'user',
    targetId: targetUserId,
    details,
    ipHash,
  });
}

/**
 * Log support action
 */
export function logSupportAction(
  supportId: string,
  action: string,
  targetType: string,
  targetId: string,
  details?: Record<string, unknown>
): void {
  logAuditAsync({
    actorId: supportId,
    actorRole: 'support',
    action,
    targetType,
    targetId,
    details,
  });
}

/**
 * Log system action
 */
export function logSystemAction(
  action: string,
  targetType?: string,
  targetId?: string,
  details?: Record<string, unknown>
): void {
  logAuditAsync({
    actorId: 'system',
    actorRole: 'system',
    action,
    targetType,
    targetId,
    details,
  });
}

// ============================================
// PREDEFINED AUDIT ACTIONS
// ============================================

export const AUDIT_ACTIONS = {
  // User management
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',
  USER_DELETED: 'user.deleted',

  // Authentication
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',
  AUTH_PASSWORD_RESET: 'auth.password_reset',
  AUTH_MFA_ENABLED: 'auth.mfa_enabled',
  AUTH_MFA_DISABLED: 'auth.mfa_disabled',

  // Subscription
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_UPGRADED: 'subscription.upgraded',
  SUBSCRIPTION_DOWNGRADED: 'subscription.downgraded',

  // Payments
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_ISSUED: 'refund.issued',

  // Support
  SUPPORT_TICKET_CREATED: 'support.ticket_created',
  SUPPORT_TICKET_RESOLVED: 'support.ticket_resolved',
  SUPPORT_REFUND_ISSUED: 'support.refund_issued',

  // Data
  DATA_EXPORTED: 'data.exported',
  DATA_DELETED: 'data.deleted',
  CONSENT_GRANTED: 'consent.granted',
  CONSENT_REVOKED: 'consent.revoked',

  // Role management
  ROLE_GRANTED: 'role.granted',
  ROLE_REVOKED: 'role.revoked',

  // System
  SYSTEM_CONFIG_CHANGED: 'system.config_changed',
  SYSTEM_MAINTENANCE_STARTED: 'system.maintenance_started',
  SYSTEM_MAINTENANCE_ENDED: 'system.maintenance_ended',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
