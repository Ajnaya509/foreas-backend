/**
 * Rate Limiter Middleware - FOREAS Driver Backend
 * Limitation de débit pour protéger les endpoints sensibles
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { rateLimitLogger } from '@/utils/logger';
import { env } from '@/env';

/**
 * Configuration du rate limiter
 * 10 requêtes par minute par IP pour les routes sensibles
 */
const authRateLimiter = new RateLimiterMemory({
  points: 10, // Nombre de requêtes autorisées
  duration: 60, // Par période de 60 secondes
  blockDuration: 60, // Bloquer pendant 60 secondes après dépassement
});

const stripeRateLimiter = new RateLimiterMemory({
  points: 10, // Nombre de requêtes autorisées
  duration: 60, // Par période de 60 secondes
  blockDuration: 60, // Bloquer pendant 60 secondes après dépassement
});

/**
 * Interface pour les options du rate limiter
 */
interface RateLimiterOptions {
  keyPrefix?: string;
  points?: number;
  duration?: number;
  blockDuration?: number;
}

/**
 * Créer un middleware de rate limiting
 */
const createRateLimitMiddleware = (
  limiter: RateLimiterMemory,
  name: string
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Obtenir l'adresse IP du client
    const clientIP = req.ip || 
                     req.connection.remoteAddress || 
                     req.headers['x-forwarded-for'] as string || 
                     'unknown';

    const key = `${name}:${clientIP}`;

    try {
      // Vérifier la limite
      await limiter.consume(key);
      
      // Ajouter des headers informatifs
      const resRateLimiter = await limiter.get(key);
      if (resRateLimiter) {
        res.set({
          'X-RateLimit-Limit': limiter.points.toString(),
          'X-RateLimit-Remaining': resRateLimiter.remainingPoints?.toString() || '0',
          'X-RateLimit-Reset': new Date(Date.now() + resRateLimiter.msBeforeNext).toISOString(),
        });
      }

      // Permettre la continuation
      next();
    } catch (rateLimiterRes) {
      // Limite dépassée
      rateLimitLogger.warn('Rate limit exceeded', {
        clientIP,
        route: name,
        path: req.path,
        userAgent: req.get('User-Agent'),
        remainingPoints: (rateLimiterRes as any).remainingPoints,
        msBeforeNext: (rateLimiterRes as any).msBeforeNext,
      });

      // Ajouter des headers de rate limiting
      const resetTime = new Date(Date.now() + ((rateLimiterRes as any).msBeforeNext || 60000));
      res.set({
        'X-RateLimit-Limit': limiter.points.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': resetTime.toISOString(),
        'Retry-After': Math.round(((rateLimiterRes as any).msBeforeNext || 60000) / 1000).toString(),
      });

      // Retourner une erreur 429
      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Trop de requêtes. Veuillez réessayer plus tard.',
          retryAfter: Math.round(((rateLimiterRes as any).msBeforeNext || 60000) / 1000),
        }
      });
    }
  };
};

/**
 * Middleware de rate limiting pour les routes d'authentification
 */
export const authRateLimit = createRateLimitMiddleware(authRateLimiter, 'auth');

/**
 * Middleware de rate limiting pour les routes Stripe
 */
export const stripeRateLimit = createRateLimitMiddleware(stripeRateLimiter, 'stripe');

/**
 * Middleware de rate limiting générique
 */
export const createCustomRateLimit = (options: RateLimiterOptions & { name: string }) => {
  const limiter = new RateLimiterMemory({
    points: options.points || 10,
    duration: options.duration || 60,
    blockDuration: options.blockDuration || 60,
  });

  return createRateLimitMiddleware(limiter, options.name);
};

/**
 * Middleware pour les requêtes en burst (pic de trafic)
 */
const burstRateLimiter = new RateLimiterMemory({
  points: 50, // 50 requêtes
  duration: 10, // en 10 secondes
  blockDuration: 30, // bloquer 30 secondes
});

export const burstRateLimit = createRateLimitMiddleware(burstRateLimiter, 'burst');

/**
 * Utilitaire pour vérifier manuellement les limites
 */
export const checkRateLimit = async (
  limiter: RateLimiterMemory,
  key: string
): Promise<{ allowed: boolean; remainingPoints: number; msBeforeNext: number }> => {
  try {
    const resRateLimiter = await limiter.get(key);
    return {
      allowed: true,
      remainingPoints: resRateLimiter?.remainingPoints || limiter.points,
      msBeforeNext: resRateLimiter?.msBeforeNext || 0,
    };
  } catch (rateLimiterRes) {
    return {
      allowed: false,
      remainingPoints: 0,
      msBeforeNext: (rateLimiterRes as any).msBeforeNext || 60000,
    };
  }
};

/**
 * Reset manuel d'un rate limiter pour une clé donnée
 */
export const resetRateLimit = async (
  limiter: RateLimiterMemory,
  key: string
): Promise<void> => {
  await limiter.delete(key);
  rateLimitLogger.info('Rate limit reset', { key });
};

/**
 * Export des limiters pour les tests
 */
export { authRateLimiter, stripeRateLimiter };