/**
 * Tests Ajnaya Feedback System - FOREAS Driver
 * 
 * Tests d'intégration pour le système de feedback IA
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createCallerFactory } from '@trpc/server';
import { appRouter } from '@/server/api/root';
import { createTRPCMsw } from 'msw-trpc';
import { testUtils } from './setup';

// Setup tRPC caller pour les tests
const createCaller = createCallerFactory(appRouter);

describe('Ajnaya Feedback System', () => {
  let testUser: any;
  let testDriver: any;
  let testInsight: any;
  let caller: any;

  beforeEach(async () => {
    // Créer un utilisateur et chauffeur de test
    testUser = await testUtils.createTestUser({
      email: 'driver-test@foreas.app',
      name: 'Test Driver',
      role: 'DRIVER',
    });

    testDriver = await testUtils.createTestDriver(testUser.id, {
      licenseNumber: 'TEST-LICENSE-123',
    });

    testInsight = await testUtils.createTestInsight(testDriver.id, {
      type: 'ZONE_ALERT',
      priority: 'HIGH',
      title: 'Zone recommandée: Châtelet',
      message: 'Forte demande attendue',
      data: {
        predictedOutcome: 2000, // 20€ prédit
        zoneName: 'Châtelet',
        confidence: 85,
      },
    });

    // Mock de la session utilisateur
    caller = createCaller({
      session: {
        user: {
          id: testUser.id,
          email: testUser.email,
          role: 'DRIVER',
        },
      },
      prisma: global.prisma,
    });
  });

  describe('submitFeedback', () => {
    it('devrait créer un feedback valide', async () => {
      const feedbackData = {
        recommendationId: testInsight.id,
        userAction: 'followed' as const,
        actualOutcome: 1800, // 18€ réel vs 20€ prédit
        satisfactionScore: 4,
        comments: 'Bonne recommandation, gains corrects',
        contextData: {
          weatherCondition: 'rainy' as const,
          timeOfDay: 'evening' as const,
          zoneType: 'business' as const,
          platformUsed: 'UBER' as const,
        },
      };

      const result = await caller.ajnayaFeedback.submitFeedback(feedbackData);

      expect(result.success).toBe(true);
      expect(result.feedbackId).toMatch(/^feedback_/);
      expect(result.accuracyScore).toBeGreaterThan(0);
      expect(result.message).toContain('Merci pour votre retour');
    });

    it('devrait calculer un score de précision correct', async () => {
      const feedbackData = {
        recommendationId: testInsight.id,
        userAction: 'followed' as const,
        actualOutcome: 2000, // Exactement ce qui était prédit
        satisfactionScore: 5,
      };

      const result = await caller.ajnayaFeedback.submitFeedback(feedbackData);

      // Score parfait pour une prédiction exacte suivie
      expect(result.accuracyScore).toBeGreaterThan(95);
    });

    it('devrait créer un insight de remerciement pour satisfaction élevée', async () => {
      const feedbackData = {
        recommendationId: testInsight.id,
        userAction: 'followed' as const,
        actualOutcome: 1500,
        satisfactionScore: 5, // Satisfaction très élevée
      };

      await caller.ajnayaFeedback.submitFeedback(feedbackData);

      // Vérifier qu'un insight de remerciement a été créé
      const thanksInsight = await global.prisma.ajnayaInsight.findFirst({
        where: {
          driverId: testDriver.id,
          title: { contains: 'Merci pour votre feedback' },
        },
      });

      expect(thanksInsight).toBeTruthy();
      expect(thanksInsight?.priority).toBe('LOW');
    });

    it('devrait rejeter un feedback avec recommendationId invalide', async () => {
      const feedbackData = {
        recommendationId: 'invalid-id',
        userAction: 'followed' as const,
        actualOutcome: 1500,
        satisfactionScore: 4,
      };

      await expect(
        caller.ajnayaFeedback.submitFeedback(feedbackData)
      ).rejects.toThrow();
    });

    it('devrait valider les contraintes de données', async () => {
      const invalidFeedback = {
        recommendationId: testInsight.id,
        userAction: 'followed' as const,
        actualOutcome: -2000, // Trop négatif
        satisfactionScore: 6, // Hors limites (max 5)
      };

      await expect(
        caller.ajnayaFeedback.submitFeedback(invalidFeedback)
      ).rejects.toThrow();
    });
  });

  describe('getFeedbackHistory', () => {
    beforeEach(async () => {
      // Créer plusieurs feedbacks de test
      await testUtils.createTestFeedback(testDriver.id, testInsight.id, {
        userAction: 'followed',
        satisfactionScore: 5,
        submittedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 jour
      });

      await testUtils.createTestFeedback(testDriver.id, testInsight.id, {
        userAction: 'ignored',
        satisfactionScore: 2,
        submittedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 jours
      });

      await testUtils.createTestFeedback(testDriver.id, testInsight.id, {
        userAction: 'partially_followed',
        satisfactionScore: 3,
        submittedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000), // 35 jours
      });
    });

    it('devrait récupérer l\'historique avec pagination', async () => {
      const result = await caller.ajnayaFeedback.getFeedbackHistory({
        limit: 2,
        offset: 0,
        timeRange: 'month',
      });

      expect(result.feedbacks).toHaveLength(2);
      expect(result.pagination.total).toBe(2); // 2 dans le mois
      expect(result.pagination.hasMore).toBe(false);
    });

    it('devrait filtrer par période de temps', async () => {
      const weekResult = await caller.ajnayaFeedback.getFeedbackHistory({
        timeRange: 'week',
      });

      const monthResult = await caller.ajnayaFeedback.getFeedbackHistory({
        timeRange: 'month',
      });

      expect(weekResult.feedbacks).toHaveLength(1); // 1 dans la semaine
      expect(monthResult.feedbacks).toHaveLength(2); // 2 dans le mois
    });

    it('devrait calculer les statistiques correctement', async () => {
      const result = await caller.ajnayaFeedback.getFeedbackHistory({
        timeRange: 'month',
      });

      expect(result.stats.totalFeedbacks).toBe(2);
      expect(result.stats.averageSatisfaction).toBeGreaterThan(0);
      expect(result.stats.averageAccuracy).toBeGreaterThan(0);
    });
  });

  describe('getFeedbackAnalytics', () => {
    beforeEach(async () => {
      // Créer plusieurs feedbacks avec différentes actions
      await testUtils.createTestFeedback(testDriver.id, testInsight.id, {
        userAction: 'followed',
        satisfactionScore: 5,
      });

      await testUtils.createTestFeedback(testDriver.id, testInsight.id, {
        userAction: 'followed',
        satisfactionScore: 4,
      });

      await testUtils.createTestFeedback(testDriver.id, testInsight.id, {
        userAction: 'ignored',
        satisfactionScore: 2,
      });
    });

    it('devrait calculer la distribution des actions', async () => {
      const result = await caller.ajnayaFeedback.getFeedbackAnalytics();

      expect(result.actionDistribution).toHaveLength(2);
      
      const followedCount = result.actionDistribution.find(
        (item: any) => item.userAction === 'followed'
      )?._count;
      
      const ignoredCount = result.actionDistribution.find(
        (item: any) => item.userAction === 'ignored'
      )?._count;

      expect(followedCount).toBe(2);
      expect(ignoredCount).toBe(1);
    });

    it('devrait fournir des insights personnalisés', async () => {
      const result = await caller.ajnayaFeedback.getFeedbackAnalytics();

      expect(result.personalizedInsights).toBeDefined();
      expect(result.personalizedInsights.strengths).toBeInstanceOf(Array);
      expect(result.personalizedInsights.improvements).toBeInstanceOf(Array);
      expect(result.personalizedInsights.nextSteps).toBeInstanceOf(Array);
    });

    it('devrait fournir des suggestions d\'amélioration', async () => {
      const result = await caller.ajnayaFeedback.getFeedbackAnalytics();

      expect(result.improvementSuggestions).toBeInstanceOf(Array);
      expect(result.improvementSuggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Sécurité', () => {
    it('ne devrait pas permettre feedback sur recommandation d\'un autre chauffeur', async () => {
      // Créer un autre chauffeur
      const otherUser = await testUtils.createTestUser({
        email: 'other-driver@foreas.app',
      });
      const otherDriver = await testUtils.createTestDriver(otherUser.id);
      const otherInsight = await testUtils.createTestInsight(otherDriver.id);

      const feedbackData = {
        recommendationId: otherInsight.id,
        userAction: 'followed' as const,
        actualOutcome: 1500,
        satisfactionScore: 4,
      };

      await expect(
        caller.ajnayaFeedback.submitFeedback(feedbackData)
      ).rejects.toThrow();
    });

    it('devrait valider le profil chauffeur complet', async () => {
      // Créer un caller sans driver
      const userOnlyCaller = createCaller({
        session: {
          user: {
            id: 'user-without-driver',
            email: 'no-driver@foreas.app',
            role: 'DRIVER',
          },
        },
        prisma: global.prisma,
      });

      await expect(
        userOnlyCaller.ajnayaFeedback.getFeedbackHistory({})
      ).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    it('devrait gérer de gros volumes de feedbacks', async () => {
      // Créer 100 feedbacks
      const promises = Array.from({ length: 100 }, async (_, i) => {
        const insight = await testUtils.createTestInsight(testDriver.id, {
          title: `Insight ${i}`,
        });
        
        return testUtils.createTestFeedback(testDriver.id, insight.id, {
          satisfactionScore: (i % 5) + 1,
          submittedAt: new Date(Date.now() - i * 60 * 60 * 1000), // Étalé sur 100h
        });
      });

      await Promise.all(promises);

      const start = Date.now();
      const result = await caller.ajnayaFeedback.getFeedbackHistory({
        limit: 50,
        timeRange: 'quarter',
      });
      const duration = Date.now() - start;

      expect(result.feedbacks).toHaveLength(50);
      expect(duration).toBeLessThan(1000); // Moins d'1 seconde
    });
  });
});