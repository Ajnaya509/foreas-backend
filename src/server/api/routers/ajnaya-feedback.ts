/**
 * Ajnaya Feedback Router - FOREAS Driver
 * 
 * Système de feedback pour améliorer les recommandations IA
 * Interface structurée pour apprentissage machine futur
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  createTRPCRouter,
  driverProcedure,
} from '@/server/api/trpc';
import { logger } from '@/lib/logger';
import { createError } from '@/lib/errors';
import { ajnayaConfig } from '@/config/environment';

// Schema de validation du feedback Ajnaya
export const AjnayaFeedbackSchema = z.object({
  recommendationId: z.string().cuid('ID recommandation invalide'),
  userAction: z.enum(['followed', 'ignored', 'partially_followed'], {
    errorMap: () => ({ message: 'Action utilisateur invalide' }),
  }),
  actualOutcome: z.number()
    .min(-1000, 'Résultat minimum: -1000')
    .max(10000, 'Résultat maximum: 10000')
    .describe('Résultat réel en centimes (gains/pertes)'),
  satisfactionScore: z.number()
    .int('Score doit être entier')
    .min(1, 'Score minimum: 1')
    .max(5, 'Score maximum: 5')
    .describe('Satisfaction de 1 (très insatisfait) à 5 (très satisfait)'),
  comments: z.string()
    .max(500, 'Commentaire trop long (max 500 caractères)')
    .optional()
    .describe('Commentaire optionnel du chauffeur'),
  contextData: z.object({
    weatherCondition: z.enum(['sunny', 'cloudy', 'rainy', 'stormy', 'snowy']).optional(),
    timeOfDay: z.enum(['morning', 'afternoon', 'evening', 'night']).optional(),
    zoneType: z.enum(['airport', 'station', 'business', 'residential', 'tourist']).optional(),
    platformUsed: z.enum(['UBER', 'BOLT', 'HEETCH', 'FOREAS_DIRECT', 'OTHER']).optional(),
  }).optional(),
});

export type AjnayaFeedback = z.infer<typeof AjnayaFeedbackSchema>;

export const ajnayaFeedbackRouter = createTRPCRouter({
  /**
   * Soumettre un feedback sur une recommandation Ajnaya
   */
  submitFeedback: driverProcedure
    .input(AjnayaFeedbackSchema)
    .mutation(async ({ ctx, input }) => {
      const driverId = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driverId) {
        throw createError.business.driverProfileIncomplete(['driver_profile']);
      }

      try {
        // Vérifier que la recommandation existe et appartient au chauffeur
        const recommendation = await ctx.prisma.ajnayaInsight.findFirst({
          where: {
            id: input.recommendationId,
            driverId: driverId.id,
          },
        });

        if (!recommendation) {
          throw createError.ajnaya.feedbackInvalid(
            input.recommendationId,
            'Recommandation introuvable ou non autorisée'
          );
        }

        // Calculer le score de précision de la recommandation
        const accuracyScore = calculateAccuracyScore(
          input.actualOutcome,
          recommendation.data?.predictedOutcome,
          input.userAction
        );

        // Enregistrer le feedback
        const feedback = await ctx.prisma.ajnayaFeedback.create({
          data: {
            id: `feedback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            driverId: driverId.id,
            recommendationId: input.recommendationId,
            userAction: input.userAction,
            actualOutcome: input.actualOutcome,
            satisfactionScore: input.satisfactionScore,
            comments: input.comments,
            accuracyScore,
            contextData: input.contextData ? JSON.stringify(input.contextData) : null,
            submittedAt: new Date(),
            
            // Métadonnées pour apprentissage ML
            metadata: JSON.stringify({
              recommendationType: recommendation.type,
              recommendationPriority: recommendation.priority,
              timeSinceRecommendation: Date.now() - recommendation.createdAt.getTime(),
              deviceType: 'mobile', // Assumé pour React Native
              appVersion: '1.0.0', // À récupérer dynamiquement
            }),
          },
        });

        // Mettre à jour les statistiques de la recommandation originale
        await ctx.prisma.ajnayaInsight.update({
          where: { id: input.recommendationId },
          data: {
            feedbackReceived: true,
            data: {
              ...(recommendation.data as object),
              feedback: {
                action: input.userAction,
                outcome: input.actualOutcome,
                satisfaction: input.satisfactionScore,
                accuracy: accuracyScore,
              },
            },
          },
        });

        // Créer une insight de remerciement si satisfaction élevée
        if (input.satisfactionScore >= 4) {
          await ctx.prisma.ajnayaInsight.create({
            data: {
              driverId: driverId.id,
              type: 'PERFORMANCE',
              priority: 'LOW',
              title: '🙏 Merci pour votre feedback !',
              message: `Votre retour nous aide à améliorer Ajnaya. Satisfaction: ${input.satisfactionScore}/5`,
              data: {
                feedbackId: feedback.id,
                source: 'feedback_thanks',
              },
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
            },
          });
        }

        logger.ajnayaAnalysis(driverId.id, 'feedback_received', {
          action: input.userAction,
          satisfaction: input.satisfactionScore,
          accuracy: accuracyScore,
        });

        return {
          success: true,
          feedbackId: feedback.id,
          accuracyScore,
          message: 'Merci pour votre retour ! Ajnaya s\'améliore grâce à vous.',
        };

      } catch (error: any) {
        logger.error('Erreur soumission feedback Ajnaya', {
          driverId: driverId.id,
          recommendationId: input.recommendationId,
        }, error);

        if (error instanceof TRPCError) {
          throw error;
        }

        throw createError.ajnaya.analysisFailed('feedback_submission', error.message);
      }
    }),

  /**
   * Récupérer l'historique des feedbacks du chauffeur
   */
  getFeedbackHistory: driverProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
        timeRange: z.enum(['week', 'month', 'quarter']).default('month'),
      })
    )
    .query(async ({ ctx, input }) => {
      const driverId = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driverId) {
        throw createError.business.driverProfileIncomplete(['driver_profile']);
      }

      try {
        const timeRanges = {
          week: 7 * 24 * 60 * 60 * 1000,
          month: 30 * 24 * 60 * 60 * 1000,
          quarter: 90 * 24 * 60 * 60 * 1000,
        };

        const since = new Date(Date.now() - timeRanges[input.timeRange]);

        const [feedbacks, totalCount, stats] = await Promise.all([
          ctx.prisma.ajnayaFeedback.findMany({
            where: {
              driverId: driverId.id,
              submittedAt: { gte: since },
            },
            orderBy: { submittedAt: 'desc' },
            take: input.limit,
            skip: input.offset,
            include: {
              recommendation: {
                select: {
                  type: true,
                  priority: true,
                  title: true,
                  createdAt: true,
                },
              },
            },
          }),

          ctx.prisma.ajnayaFeedback.count({
            where: {
              driverId: driverId.id,
              submittedAt: { gte: since },
            },
          }),

          ctx.prisma.ajnayaFeedback.aggregate({
            where: {
              driverId: driverId.id,
              submittedAt: { gte: since },
            },
            _avg: {
              satisfactionScore: true,
              accuracyScore: true,
            },
            _count: {
              userAction: true,
            },
          }),
        ]);

        return {
          feedbacks: feedbacks.map(feedback => ({
            id: feedback.id,
            recommendationId: feedback.recommendationId,
            recommendationType: feedback.recommendation?.type,
            userAction: feedback.userAction,
            actualOutcome: feedback.actualOutcome,
            satisfactionScore: feedback.satisfactionScore,
            accuracyScore: feedback.accuracyScore,
            comments: feedback.comments,
            submittedAt: feedback.submittedAt,
            recommendation: {
              title: feedback.recommendation?.title,
              priority: feedback.recommendation?.priority,
              createdAt: feedback.recommendation?.createdAt,
            },
          })),
          pagination: {
            total: totalCount,
            offset: input.offset,
            limit: input.limit,
            hasMore: input.offset + input.limit < totalCount,
          },
          stats: {
            totalFeedbacks: totalCount,
            averageSatisfaction: stats._avg.satisfactionScore || 0,
            averageAccuracy: stats._avg.accuracyScore || 0,
            feedbackRate: calculateFeedbackRate(driverId.id, input.timeRange),
          },
        };

      } catch (error: any) {
        logger.error('Erreur récupération historique feedback', {
          driverId: driverId.id,
        }, error);

        throw createError.ajnaya.analysisFailed('feedback_history', error.message);
      }
    }),

  /**
   * Statistiques globales des feedbacks (pour amélioration IA)
   */
  getFeedbackAnalytics: driverProcedure
    .query(async ({ ctx }) => {
      const driverId = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driverId) {
        throw createError.business.driverProfileIncomplete(['driver_profile']);
      }

      try {
        const [
          actionDistribution,
          satisfactionTrends,
          accuracyByType,
          improvementSuggestions
        ] = await Promise.all([
          // Distribution des actions utilisateur
          ctx.prisma.ajnayaFeedback.groupBy({
            by: ['userAction'],
            where: { driverId: driverId.id },
            _count: true,
          }),

          // Tendance de satisfaction sur 12 semaines
          getSatisfactionTrends(ctx.prisma, driverId.id),

          // Précision par type de recommandation
          getAccuracyByType(ctx.prisma, driverId.id),

          // Suggestions d'amélioration personnalisées
          generateImprovementSuggestions(ctx.prisma, driverId.id),
        ]);

        return {
          actionDistribution,
          satisfactionTrends,
          accuracyByType,
          improvementSuggestions,
          personalizedInsights: await generatePersonalizedInsights(ctx.prisma, driverId.id),
        };

      } catch (error: any) {
        logger.error('Erreur analytics feedback', {
          driverId: driverId.id,
        }, error);

        throw createError.ajnaya.analysisFailed('feedback_analytics', error.message);
      }
    }),
});

// Fonctions utilitaires
function calculateAccuracyScore(
  actualOutcome: number,
  predictedOutcome?: number,
  userAction?: string
): number {
  if (!predictedOutcome) return 50; // Score neutre si pas de prédiction

  const difference = Math.abs(actualOutcome - predictedOutcome);
  const relativeDifference = difference / Math.max(Math.abs(predictedOutcome), 100);

  // Score de 0 à 100 basé sur la précision
  let accuracyScore = Math.max(0, 100 - relativeDifference * 100);

  // Bonus si l'utilisateur a suivi la recommandation
  if (userAction === 'followed') {
    accuracyScore = Math.min(100, accuracyScore * 1.1);
  }

  return Math.round(accuracyScore);
}

async function calculateFeedbackRate(driverId: string, timeRange: string): Promise<number> {
  // Cette fonction nécessiterait l'accès au contexte Prisma
  // Implémentation simplifiée pour l'exemple
  return 0.75; // 75% des recommandations reçoivent un feedback
}

async function getSatisfactionTrends(prisma: any, driverId: string) {
  // Implémentation des tendances de satisfaction sur 12 semaines
  return [];
}

async function getAccuracyByType(prisma: any, driverId: string) {
  // Implémentation de la précision par type de recommandation
  return [];
}

async function generateImprovementSuggestions(prisma: any, driverId: string) {
  // Génération de suggestions d'amélioration basées sur les patterns
  return [
    'Augmenter la fréquence des recommandations de zones',
    'Améliorer la précision des prédictions météo',
    'Personnaliser davantage selon vos préférences horaires',
  ];
}

async function generatePersonalizedInsights(prisma: any, driverId: string) {
  // Génération d'insights personnalisés basés sur l'historique
  return {
    strengths: ['Excellente réactivité aux recommandations', 'Feedback détaillé et constructif'],
    improvements: ['Essayez de suivre plus souvent les recommandations de pause'],
    nextSteps: ['Activez les notifications push pour ne rater aucune opportunité'],
  };
}