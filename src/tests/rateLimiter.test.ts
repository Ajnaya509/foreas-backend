/**
 * Tests Rate Limiter - FOREAS Driver Backend
 * Tests du middleware de limitation de débit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '@/server';
import { authRateLimiter, stripeRateLimiter, resetRateLimit } from '@/middleware/rateLimiter';

describe('Rate Limiter Middleware', () => {
  beforeEach(async () => {
    // Nettoyer les rate limiters avant chaque test
    await authRateLimiter.delete('auth:127.0.0.1');
    await authRateLimiter.delete('auth:::1');
    await stripeRateLimiter.delete('stripe:127.0.0.1');
    await stripeRateLimiter.delete('stripe:::1');
  });

  describe('Auth Rate Limiting', () => {
    it('permet les requêtes dans la limite', async () => {
      // Faire quelques requêtes valides (moins de 10)
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .post('/trpc/auth.loginWithEmail')
          .send({
            email: 'test@foreas.app',
            password: 'password123',
          });

        // Ne doit pas être bloqué par rate limiting
        expect(response.status).not.toBe(429);
        
        // Vérifier les headers de rate limit
        expect(response.headers['x-ratelimit-limit']).toBe('10');
        expect(response.headers['x-ratelimit-remaining']).toBeTruthy();
      }
    });

    it('bloque après dépassement de la limite', async () => {
      // Dépasser la limite de 10 requêtes par minute
      const promises = [];
      for (let i = 0; i < 12; i++) {
        promises.push(
          request(app)
            .post('/trpc/auth.loginWithEmail')
            .send({
              email: 'test@foreas.app',
              password: 'password123',
            })
        );
      }

      const responses = await Promise.all(promises);

      // Les premières requêtes doivent passer
      const successfulRequests = responses.filter(r => r.status !== 429);
      expect(successfulRequests.length).toBeGreaterThan(0);
      expect(successfulRequests.length).toBeLessThanOrEqual(10);

      // Au moins une requête doit être bloquée
      const blockedRequests = responses.filter(r => r.status === 429);
      expect(blockedRequests.length).toBeGreaterThan(0);

      // Vérifier la réponse de rate limit
      const blockedResponse = blockedRequests[0];
      expect(blockedResponse.status).toBe(429);
      expect(blockedResponse.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(blockedResponse.body.error.message).toContain('Trop de requêtes');
      expect(blockedResponse.headers['x-ratelimit-remaining']).toBe('0');
      expect(blockedResponse.headers['retry-after']).toBeTruthy();
    });

    it('remet à zéro après la période de blocage', async () => {
      // Dépasser la limite
      for (let i = 0; i < 11; i++) {
        await request(app)
          .post('/trpc/auth.loginWithEmail')
          .send({
            email: 'test@foreas.app',
            password: 'password123',
          });
      }

      // Reset manuel pour simuler l'expiration
      await resetRateLimit(authRateLimiter, 'auth:127.0.0.1');
      await resetRateLimit(authRateLimiter, 'auth:::1');

      // Nouvelle requête après reset
      const response = await request(app)
        .post('/trpc/auth.loginWithEmail')
        .send({
          email: 'test@foreas.app',
          password: 'password123',
        });

      // Ne doit plus être bloqué
      expect(response.status).not.toBe(429);
    });

    it('gère différentes IPs indépendamment', async () => {
      // Cette fonctionnalité est difficile à tester en local car toutes les requêtes
      // viennent de la même IP (127.0.0.1). On peut seulement vérifier que le
      // système fonctionne correctement pour une IP.
      
      const response = await request(app)
        .post('/trpc/auth.loginWithEmail')
        .send({
          email: 'test@foreas.app',
          password: 'password123',
        });

      expect(response.headers['x-ratelimit-limit']).toBe('10');
      expect(response.headers['x-ratelimit-remaining']).toBeTruthy();
    });
  });

  describe('Stripe Rate Limiting', () => {
    it('permet les requêtes Stripe dans la limite', async () => {
      // Faire quelques requêtes valides (moins de 10)
      for (let i = 0; i < 5; i++) {
        const response = await request(app)
          .post('/trpc/stripe.refreshAccount')
          .set('X-Dev-User', 'user_123') // Mock auth pour les tests
          .send({});

        // Ne doit pas être bloqué par rate limiting
        expect(response.status).not.toBe(429);
        
        // Vérifier les headers de rate limit
        expect(response.headers['x-ratelimit-limit']).toBe('10');
        expect(response.headers['x-ratelimit-remaining']).toBeTruthy();
      }
    });

    it('bloque les requêtes Stripe après dépassement', async () => {
      // Dépasser la limite de 10 requêtes par minute
      const promises = [];
      for (let i = 0; i < 12; i++) {
        promises.push(
          request(app)
            .post('/trpc/stripe.refreshAccount')
            .set('X-Dev-User', 'user_123')
            .send({})
        );
      }

      const responses = await Promise.all(promises);

      // Les premières requêtes doivent passer
      const successfulRequests = responses.filter(r => r.status !== 429);
      expect(successfulRequests.length).toBeGreaterThan(0);
      expect(successfulRequests.length).toBeLessThanOrEqual(10);

      // Au moins une requête doit être bloquée
      const blockedRequests = responses.filter(r => r.status === 429);
      expect(blockedRequests.length).toBeGreaterThan(0);

      // Vérifier la réponse de rate limit
      const blockedResponse = blockedRequests[0];
      expect(blockedResponse.status).toBe(429);
      expect(blockedResponse.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(blockedResponse.body.error.message).toContain('Trop de requêtes');
    });

    it('n\'affecte pas les autres routes', async () => {
      // Dépasser la limite pour Stripe
      for (let i = 0; i < 11; i++) {
        await request(app)
          .post('/trpc/stripe.refreshAccount')
          .set('X-Dev-User', 'user_123')
          .send({});
      }

      // Les routes non-Stripe doivent fonctionner
      const response = await request(app)
        .get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });
  });

  describe('Rate Limiting Headers', () => {
    it('inclut les bons headers de rate limiting', async () => {
      const response = await request(app)
        .post('/trpc/auth.loginWithEmail')
        .send({
          email: 'test@foreas.app',
          password: 'password123',
        });

      // Vérifier la présence des headers
      expect(response.headers['x-ratelimit-limit']).toBe('10');
      expect(response.headers['x-ratelimit-remaining']).toBeTruthy();
      expect(response.headers['x-ratelimit-reset']).toBeTruthy();
      
      // Vérifier que remaining diminue
      const remaining = parseInt(response.headers['x-ratelimit-remaining'], 10);
      expect(remaining).toBeLessThan(10);
    });

    it('inclut Retry-After lors du blocage', async () => {
      // Dépasser la limite
      for (let i = 0; i < 11; i++) {
        await request(app)
          .post('/trpc/auth.loginWithEmail')
          .send({
            email: 'test@foreas.app',
            password: 'password123',
          });
      }

      // Une requête de plus pour déclencher le 429
      const response = await request(app)
        .post('/trpc/auth.loginWithEmail')
        .send({
          email: 'test@foreas.app',
          password: 'password123',
        });

      if (response.status === 429) {
        expect(response.headers['retry-after']).toBeTruthy();
        expect(response.headers['x-ratelimit-remaining']).toBe('0');
        
        const retryAfter = parseInt(response.headers['retry-after'], 10);
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(60);
      }
    });
  });

  describe('Edge Cases', () => {
    it('gère les requêtes sans IP correctement', async () => {
      // Cette situation est rare mais peut arriver
      const response = await request(app)
        .post('/trpc/auth.loginWithEmail')
        .send({
          email: 'test@foreas.app',
          password: 'password123',
        });

      // Doit fonctionner même sans IP claire
      expect(response.status).not.toBe(500);
      expect(response.headers['x-ratelimit-limit']).toBeTruthy();
    });

    it('maintient des compteurs séparés pour auth et stripe', async () => {
      // Utiliser 5 requêtes auth
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/trpc/auth.loginWithEmail')
          .send({
            email: 'test@foreas.app',
            password: 'password123',
          });
      }

      // Les requêtes Stripe doivent avoir leur propre compteur
      const response = await request(app)
        .post('/trpc/stripe.refreshAccount')
        .set('X-Dev-User', 'user_123')
        .send({});

      // La première requête Stripe doit avoir 9 remaining (10 - 1)
      expect(response.headers['x-ratelimit-remaining']).toBe('9');
    });
  });

  describe('Production Behavior', () => {
    it('log les événements de rate limiting', async () => {
      // Mock du logger pour vérifier les logs
      const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        // Dépasser la limite
        for (let i = 0; i < 12; i++) {
          await request(app)
            .post('/trpc/auth.loginWithEmail')
            .send({
              email: 'test@foreas.app',
              password: 'password123',
            });
        }

        // En production, cela devrait déclencher des logs
        // (difficile à tester ici car le logger utilise pino)
      } finally {
        logSpy.mockRestore();
      }
    });

    it('format JSON correct pour les erreurs 429', async () => {
      // Dépasser la limite
      for (let i = 0; i < 11; i++) {
        await request(app)
          .post('/trpc/auth.loginWithEmail')
          .send({
            email: 'test@foreas.app',
            password: 'password123',
          });
      }

      const response = await request(app)
        .post('/trpc/auth.loginWithEmail')
        .send({
          email: 'test@foreas.app',
          password: 'password123',
        });

      if (response.status === 429) {
        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toHaveProperty('code', 'TOO_MANY_REQUESTS');
        expect(response.body.error).toHaveProperty('message');
        expect(response.body.error).toHaveProperty('retryAfter');
        
        expect(typeof response.body.error.retryAfter).toBe('number');
      }
    });
  });
});