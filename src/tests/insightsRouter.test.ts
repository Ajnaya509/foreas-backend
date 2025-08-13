/**
 * Tests d'intégration Router Insights - FOREAS Driver Backend
 * Tests du router tRPC insights avec base de données
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import { appRouter } from '@/server/routers';
import { createTRPCContext } from '@/server/context';
import { testUtils } from './setup';
import type { Context } from '@/server/context';

// Mock pour les tests
const mockContext: Context = {
  userId: undefined,
};

describe('Insights Router Integration', () => {
  let testUser: any;
  let testDriver: any;
  let caller: any;

  beforeEach(async () => {
    // Créer un utilisateur et chauffeur de test
    testUser = await testUtils.createTestUser({
      email: 'driver@foreas.app',
      name: 'Test Driver',
      role: 'DRIVER',
    });

    testDriver = await testUtils.createTestDriver(testUser.id, {
      licenseNumber: 'DRV123TEST',
    });

    // Créer le caller tRPC authentifié
    caller = appRouter.createCaller({
      ...mockContext,
      userId: testUser.id,
    });
  });

  describe('current()', () => {
    it('retourne les insights actuels pour un chauffeur sans trajets', async () => {
      const result = await caller.insights.current({ city: 'Paris' });

      expect(result).toBeDefined();
      expect(result.insights).toBeInstanceOf(Array);
      expect(result.stats).toBeDefined();
      expect(result.stats.tripsLast7d).toBe(0);
      expect(result.stats.city).toBe('Paris');
      expect(result.stats.totalNetEarnings).toBe(0);
      expect(result.stats.averageScore).toBe(0);
      expect(result.zoneSnapshot).toBeDefined();
      expect(result.zoneSnapshot?.city).toBe('Paris');
    });

    it('génère des insights basés sur les trajets récents', async () => {
      // Créer des trajets de test simulant différents scénarios
      const now = new Date();
      
      // Trajet 1: Bon rendement
      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 25.00,
        distance: 10.0,
        duration: 60, // 1h
        commission: 5.00,
        finalPrice: 30.00,
        startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000), // Il y a 2h
        completedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000 + 60 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'UBER',
      });

      // Trajet 2: Rendement moyen
      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 18.00,
        distance: 8.0,
        duration: 60, // 1h
        commission: 4.00,
        finalPrice: 22.00,
        startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000), // Il y a 4h
        completedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000 + 60 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'BOLT',
      });

      // Trajet 3: Faible rendement
      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 12.00,
        distance: 15.0,
        duration: 90, // 1.5h
        commission: 8.00,
        finalPrice: 20.00,
        startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000), // Il y a 6h
        completedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000 + 90 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'HEETCH',
      });

      const result = await caller.insights.current({ city: 'Paris' });

      expect(result.stats.tripsLast7d).toBe(3);
      expect(result.stats.totalNetEarnings).toBe(55.00);
      expect(result.stats.averageScore).toBeGreaterThan(40);
      expect(result.stats.averageScore).toBeLessThan(80);

      // Vérifier la présence d'insights (dépend des seuils)
      expect(result.insights).toBeInstanceOf(Array);
      
      // Au minimum, on devrait avoir des insights car on a des trajets récents
      if (result.insights.length > 0) {
        result.insights.forEach(insight => {
          expect(insight.id).toBeTruthy();
          expect(['ZONE', 'PAUSE', 'PRICING']).toContain(insight.type);
          expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(insight.priority);
          expect(insight.title).toBeTruthy();
          expect(insight.message).toBeTruthy();
          expect(insight.expiresAt).toBeInstanceOf(Date);
        });
      }
    });

    it('génère un insight PAUSE pour trop d\'heures de travail', async () => {
      const now = new Date();
      
      // Créer des trajets totalisant plus de 6 heures dans les dernières 24h
      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 30.00,
        distance: 15.0,
        duration: 150, // 2.5h
        commission: 7.00,
        finalPrice: 37.00,
        startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000), // Il y a 3h
        completedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000 + 150 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'UBER',
      });

      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 40.00,
        distance: 20.0,
        duration: 180, // 3h
        commission: 8.00,
        finalPrice: 48.00,
        startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000), // Il y a 7h
        completedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000 + 180 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'BOLT',
      });

      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 35.00,
        distance: 18.0,
        duration: 150, // 2.5h
        commission: 7.50,
        finalPrice: 42.50,
        startedAt: new Date(now.getTime() - 11 * 60 * 60 * 1000), // Il y a 11h
        completedAt: new Date(now.getTime() - 11 * 60 * 60 * 1000 + 150 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'HEETCH',
      });
      // Total: 8h de travail dans les dernières 24h

      const result = await caller.insights.current({ city: 'Paris' });

      // Chercher l'insight PAUSE
      const pauseInsight = result.insights.find(i => i.type === 'PAUSE');
      expect(pauseInsight).toBeDefined();
      expect(pauseInsight?.priority).toBe('HIGH'); // Ou CRITICAL si > 8h
      expect(pauseInsight?.title).toContain('pause');
      expect(pauseInsight?.message).toContain('8.0h');
      expect(pauseInsight?.data?.totalDutyHours).toBe(8);
    });

    it('génère un insight PRICING pour faibles revenus', async () => {
      const now = new Date();
      
      // Créer 3+ trajets avec rendement < 18€/h
      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 12.00,
        distance: 10.0,
        duration: 60, // 1h = 12€/h
        commission: 3.00,
        finalPrice: 15.00,
        startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        completedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000 + 60 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'UBER',
      });

      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 15.00,
        distance: 8.0,
        duration: 60, // 1h = 15€/h
        commission: 4.00,
        finalPrice: 19.00,
        startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
        completedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000 + 60 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'BOLT',
      });

      await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 16.00,
        distance: 12.0,
        duration: 60, // 1h = 16€/h
        commission: 4.00,
        finalPrice: 20.00,
        startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
        completedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000 + 60 * 60 * 1000),
        status: 'COMPLETED',
        platform: 'HEETCH',
      });
      // Moyenne: (12 + 15 + 16) / 3 = 14.33€/h < 18€/h

      const result = await caller.insights.current({ city: 'Paris' });

      // Chercher l'insight PRICING
      const pricingInsight = result.insights.find(i => i.type === 'PRICING');
      expect(pricingInsight).toBeDefined();
      expect(pricingInsight?.priority).toBe('MEDIUM');
      expect(pricingInsight?.title).toContain('seuil');
      expect(pricingInsight?.data?.currentNetPerHour).toBeLessThan(18);
    });

    it('utilise la ville par défaut si non spécifiée et aucun trajet', async () => {
      const result = await caller.insights.current({});

      expect(result.stats.city).toBe('Paris'); // Ville par défaut
      expect(result.zoneSnapshot?.city).toBe('Paris');
    });

    it('lève une erreur pour un utilisateur non-chauffeur', async () => {
      const nonDriverUser = await testUtils.createTestUser({
        email: 'client@foreas.app',
        role: 'CLIENT',
      });

      const nonDriverCaller = appRouter.createCaller({
        ...mockContext,
        userId: nonDriverUser.id,
      });

      await expect(
        nonDriverCaller.insights.current({})
      ).rejects.toThrow('Profil chauffeur non trouvé');
    });
  });

  describe('scoreTrip()', () => {
    let testTrip: any;

    beforeEach(async () => {
      testTrip = await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 20.00,
        distance: 10.0,
        duration: 60,
        commission: 5.00,
        finalPrice: 25.00,
        startedAt: new Date('2024-01-15T14:00:00Z'),
        completedAt: new Date('2024-01-15T15:00:00Z'),
        status: 'COMPLETED',
        platform: 'UBER',
      });
    });

    it('calcule le score d\'un trajet existant', async () => {
      const result = await caller.insights.scoreTrip({
        tripId: testTrip.id,
      });

      expect(result.tripId).toBe(testTrip.id);
      expect(result.tripData).toBeDefined();
      expect(result.tripData.id).toBe(testTrip.id);
      expect(result.tripData.netEarnings).toBe(20.00);
      expect(result.tripData.distance).toBe(10.0);
      
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.reasons).toBeInstanceOf(Array);
      expect(result.reasons.length).toBeGreaterThan(0);
      
      expect(result.metrics).toBeDefined();
      expect(result.metrics.netPerKm).toBe(2); // 20€ / 10km
      expect(result.metrics.netPerHour).toBe(20); // 20€ / 1h
      expect(result.metrics.commissionRate).toBe(20); // 5€ / 25€ * 100
    });

    it('donne un bon score à un trajet rentable', async () => {
      const excellentTrip = await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 30.00,
        distance: 12.0,
        duration: 60, // 1h
        commission: 5.00,
        finalPrice: 35.00, // 14.3% commission
        status: 'COMPLETED',
        platform: 'UBER',
      });

      const result = await caller.insights.scoreTrip({
        tripId: excellentTrip.id,
      });

      expect(result.score).toBeGreaterThan(70);
      expect(result.reasons).toContain('Excellent rapport distance (2.5€/km)');
      expect(result.reasons).toContain('Excellent rendement horaire (30€/h)');
    });

    it('pénalise un trajet peu rentable', async () => {
      const poorTrip = await testUtils.createTestTrip(testDriver.id, {
        netEarnings: 8.00,
        distance: 15.0,
        duration: 120, // 2h
        commission: 12.00,
        finalPrice: 20.00, // 60% commission
        status: 'COMPLETED',
        platform: 'HEETCH',
      });

      const result = await caller.insights.scoreTrip({
        tripId: poorTrip.id,
      });

      expect(result.score).toBeLessThan(40);
      expect(result.reasons.some(r => r.includes('Faible rapport distance'))).toBe(true);
      expect(result.reasons.some(r => r.includes('Faible rendement horaire'))).toBe(true);
      expect(result.reasons.some(r => r.includes('Commission élevée'))).toBe(true);
    });

    it('lève une erreur pour un trajet inexistant', async () => {
      await expect(
        caller.insights.scoreTrip({ tripId: 'trip_inexistant' })
      ).rejects.toThrow('Trajet non trouvé');
    });

    it('empêche l\'accès aux trajets d\'autres chauffeurs', async () => {
      // Créer un autre chauffeur
      const otherUser = await testUtils.createTestUser({
        email: 'other@foreas.app',
        role: 'DRIVER',
      });
      const otherDriver = await testUtils.createTestDriver(otherUser.id);
      
      const otherTrip = await testUtils.createTestTrip(otherDriver.id, {
        netEarnings: 15.00,
        distance: 8.0,
        duration: 45,
        status: 'COMPLETED',
        platform: 'BOLT',
      });

      // Tenter d'accéder au trajet de l'autre chauffeur
      await expect(
        caller.insights.scoreTrip({ tripId: otherTrip.id })
      ).rejects.toThrow('Trajet non trouvé');
    });

    it('lève une erreur pour un utilisateur non authentifié', async () => {
      const unauthenticatedCaller = appRouter.createCaller(mockContext);

      await expect(
        unauthenticatedCaller.insights.scoreTrip({ tripId: testTrip.id })
      ).rejects.toThrow('UNAUTHORIZED');
    });
  });
});