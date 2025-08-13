/**
 * Tests d'intégration tRPC - FOREAS Driver Backend
 */

import { describe, it, expect } from 'vitest';
import supertest from 'supertest';

import { app } from '@/server/index';

const request = supertest(app);

describe('tRPC Integration Tests', () => {
  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request
        .get('/health')
        .expect(200);

      expect(response.body).toMatchObject({
        status: 'healthy',
        version: '1.0.0',
      });
    });
  });

  describe('Auth Router', () => {
    it('should handle login successfully', async () => {
      const response = await request
        .post('/trpc/auth.loginWithEmail')
        .send({
          json: {
            email: 'jean.martin@foreas.app',
            password: 'MonMotDePasse123!',
          },
        })
        .expect(200);

      const result = response.body.result.data.json;
      expect(result.success).toBe(true);
      expect(result.token).toBeDefined();
    });

    it('should handle OTP flow', async () => {
      const response = await request
        .post('/trpc/auth.consumeOtp')
        .send({
          json: {
            otpSessionId: 'session_123',
            code: '123456',
          },
        })
        .expect(200);

      const result = response.body.result.data.json;
      expect(result.success).toBe(true);
    });
  });

  describe('Profile Router', () => {
    it('should get profile with auth', async () => {
      const response = await request
        .post('/trpc/profile.get')
        .set('X-Dev-User', 'test_user_123')
        .expect(200);

      const result = response.body.result.data.json;
      expect(result.id).toBe('test_user_123');
      expect(result.email).toBeDefined();
    });

    it('should reject profile access without auth', async () => {
      await request
        .post('/trpc/profile.get')
        .expect(400);
    });
  });

  describe('Other Routers', () => {
    it('should handle trips.list', async () => {
      const response = await request
        .post('/trpc/trips.list')
        .set('X-Dev-User', 'test_user_123')
        .send({ json: { page: 1, limit: 10 } })
        .expect(200);

      expect(response.body.result.data.json.trips).toBeDefined();
    });

    it('should handle insights.current', async () => {
      const response = await request
        .post('/trpc/insights.current')
        .set('X-Dev-User', 'test_user_123')
        .send({
          json: {
            location: { lat: 48.8566, lng: 2.3522 },
          },
        })
        .expect(200);

      expect(response.body.result.data.json.score).toBeDefined();
    });

    it('should handle zones.current', async () => {
      const response = await request
        .post('/trpc/zones.current')
        .set('X-Dev-User', 'test_user_123')
        .send({
          json: {
            location: { lat: 48.8566, lng: 2.3522 },
          },
        })
        .expect(200);

      expect(response.body.result.data.json.zones).toBeDefined();
    });
  });
});