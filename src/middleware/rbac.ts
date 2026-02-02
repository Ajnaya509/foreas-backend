/**
 * FOREAS Data Platform V1 - RBAC Middleware
 * ==========================================
 * Role-Based Access Control for API endpoints.
 */

import { Request, Response, NextFunction } from 'express';
import { getSupabaseAdmin } from '../helpers/supabase';
import { logAuditAsync, AUDIT_ACTIONS } from '../data/auditLog';
import type { ActorRole } from '../data/types';

// ============================================
// TYPES
// ============================================

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userRole?: ActorRole;
  userRoles?: ActorRole[];
  sessionId?: string;
}

// ============================================
// ROLE HIERARCHY
// ============================================

const ROLE_HIERARCHY: Record<ActorRole, number> = {
  anonymous: 0,
  driver: 10,
  partner: 20,
  support: 30,
  admin: 100,
  system: 100,
};

function hasMinimumRole(userRole: ActorRole, requiredRole: ActorRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

// ============================================
// AUTH MIDDLEWARE
// ============================================

/**
 * Extract user from Supabase JWT token
 */
export async function authenticateUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.userId = undefined;
    req.userRole = 'anonymous';
    return next();
  }

  const token = authHeader.substring(7);

  try {
    const supabase = getSupabaseAdmin();

    // Verify JWT and get user
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.warn('[RBAC] Invalid token:', error?.message);
      req.userId = undefined;
      req.userRole = 'anonymous';
      return next();
    }

    req.userId = user.id;
    req.sessionId = req.headers['x-session-id'] as string | undefined;

    // Get user roles from database
    const { data: roles } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('is_active', true);

    const userRoles = (roles || []).map((r: any) => r.role as ActorRole);

    if (userRoles.length === 0) {
      // Default to driver role if no roles assigned
      req.userRole = 'driver';
      req.userRoles = ['driver'];
    } else {
      // Use highest privilege role as primary
      const sortedRoles = userRoles.sort(
        (a, b) => ROLE_HIERARCHY[b] - ROLE_HIERARCHY[a]
      );
      req.userRole = sortedRoles[0];
      req.userRoles = sortedRoles;
    }

    return next();
  } catch (err) {
    console.error('[RBAC] Auth error:', err);
    req.userId = undefined;
    req.userRole = 'anonymous';
    return next();
  }
}

// ============================================
// ROLE CHECK MIDDLEWARE
// ============================================

/**
 * Require authenticated user
 */
export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Require specific role(s)
 */
export function requireRole(...allowedRoles: ActorRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRoles = req.userRoles || [req.userRole || 'anonymous'];

    // Check if user has any of the allowed roles
    const hasRole = allowedRoles.some((role) =>
      userRoles.some((userRole) => hasMinimumRole(userRole, role))
    );

    if (!hasRole) {
      logAuditAsync({
        actorId: req.userId,
        actorRole: req.userRole || 'anonymous',
        action: 'auth.access_denied',
        details: {
          required_roles: allowedRoles,
          user_roles: userRoles,
          endpoint: req.originalUrl,
          method: req.method,
        },
        ipHash: hashIP(req.ip),
      });

      res.status(403).json({
        error: 'Access denied',
        required: allowedRoles,
      });
      return;
    }

    next();
  };
}

/**
 * Require admin role
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  return requireRole('admin')(req, res, next);
}

/**
 * Require support or admin role
 */
export function requireSupport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  return requireRole('support', 'admin')(req, res, next);
}

/**
 * Require partner or higher role
 */
export function requirePartner(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  return requireRole('partner', 'admin')(req, res, next);
}

// ============================================
// RESOURCE OWNERSHIP
// ============================================

/**
 * Require user owns the resource (or is admin/support)
 */
export function requireOwnership(resourceUserIdParam: string = 'userId') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const resourceUserId =
      req.params[resourceUserIdParam] ||
      req.body[resourceUserIdParam] ||
      req.query[resourceUserIdParam];

    // Admins and support can access any resource
    if (req.userRole === 'admin' || req.userRole === 'support') {
      return next();
    }

    // Check ownership
    if (resourceUserId && resourceUserId !== req.userId) {
      logAuditAsync({
        actorId: req.userId,
        actorRole: req.userRole || 'anonymous',
        action: 'auth.ownership_denied',
        targetType: 'user',
        targetId: resourceUserId,
        details: {
          endpoint: req.originalUrl,
          method: req.method,
        },
        ipHash: hashIP(req.ip),
      });

      res.status(403).json({ error: 'Access denied: not resource owner' });
      return;
    }

    next();
  };
}

// ============================================
// CONSENT CHECK
// ============================================

/**
 * Require specific data consent
 */
export function requireConsent(consentType: string) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    try {
      const supabase = getSupabaseAdmin();

      const { data } = await supabase
        .from('data_consents')
        .select('granted')
        .eq('user_id', req.userId)
        .eq('consent_type', consentType)
        .maybeSingle();

      if (!data?.granted) {
        res.status(403).json({
          error: 'Consent required',
          consent_type: consentType,
        });
        return;
      }

      next();
    } catch (err) {
      console.error('[RBAC] Consent check error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ============================================
// RATE LIMITING BY ROLE
// ============================================

const ROLE_RATE_LIMITS: Record<ActorRole, { requests: number; windowMs: number }> = {
  anonymous: { requests: 10, windowMs: 60000 }, // 10/min
  driver: { requests: 100, windowMs: 60000 }, // 100/min
  partner: { requests: 200, windowMs: 60000 }, // 200/min
  support: { requests: 500, windowMs: 60000 }, // 500/min
  admin: { requests: 1000, windowMs: 60000 }, // 1000/min
  system: { requests: 10000, windowMs: 60000 }, // 10000/min
};

// Simple in-memory rate limit store (use Redis in production)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export function roleLimitedRateLimit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const role = req.userRole || 'anonymous';
  const limits = ROLE_RATE_LIMITS[role];
  const key = `${req.userId || req.ip}:${role}`;
  const now = Date.now();

  let record = rateLimitStore.get(key);

  if (!record || record.resetTime < now) {
    record = { count: 0, resetTime: now + limits.windowMs };
    rateLimitStore.set(key, record);
  }

  record.count++;

  if (record.count > limits.requests) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      retry_after_ms: record.resetTime - now,
    });
    return;
  }

  // Add rate limit headers
  res.set('X-RateLimit-Limit', String(limits.requests));
  res.set('X-RateLimit-Remaining', String(limits.requests - record.count));
  res.set('X-RateLimit-Reset', String(Math.ceil(record.resetTime / 1000)));

  next();
}

// ============================================
// HELPERS
// ============================================

function hashIP(ip: string | undefined): string | undefined {
  if (!ip) return undefined;

  // Simple hash for privacy
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
}

// ============================================
// EXPORTS
// ============================================

export { ROLE_HIERARCHY };
