/**
 * Ajnaya AI Router - FOREAS Driver
 * 
 * API endpoints pour l'intelligence artificielle Ajnaya
 * Analyses comportementales, recommandations et insights
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  createTRPCRouter,
  driverProcedure,
  protectedProcedure,
} from '@/server/api/trpc';
import { driverBehaviorAnalyzer, WeatherData, GeoLocation, TimeContext, PlatformsData } from '@/lib/ai/DriverBehaviorAnalyzer';
import { BookingRecommendationEngine } from '@/lib/ai/BookingRecommendationEngine';
import { Platform } from '@prisma/client';
import { env } from '@/env';

// Validation schemas
const WeatherDataSchema = z.object({
  temperature: z.number().min(-50).max(60),
  humidity: z.number().min(0).max(100),
  windSpeed: z.number().min(0).max(200),
  precipitation: z.number().min(0).max(100),
  condition: z.enum(['sunny', 'cloudy', 'rainy', 'stormy', 'snowy']),
  visibility: z.number().min(0).max(50),
});

const GeoLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  city: z.string().optional(),
  district: z.string().optional(),
  country: z.string().default('FR'),
});

const TimeContextSchema = z.object({
  hour: z.number().min(0).max(23),
  dayOfWeek: z.number().min(0).max(6),
  isWeekend: z.boolean(),
  isHoliday: z.boolean(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
});

const PlatformsDataSchema = z.object({
  [Platform.UBER]: z.object({
    activeRides: z.number().min(0),
    surgeMultiplier: z.number().min(1).max(5),
    estimatedWaitTime: z.number().min(0),
    activeDrivers: z.number().min(0),
  }).optional(),
  [Platform.BOLT]: z.object({
    activeRides: z.number().min(0),
    peakPricing: z.boolean(),
    demandLevel: z.enum(['low', 'medium', 'high']),
  }).optional(),
  [Platform.HEETCH]: z.object({
    activeRides: z.number().min(0),
    isRushHour: z.boolean(),
  }).optional(),
  [Platform.FOREAS_DIRECT]: z.object({
    pendingBookings: z.number().min(0),
    averageBookingValue: z.number().min(0),
  }).optional(),
});

const BookingRequestSchema = z.object({
  id: z.string(),
  platform: z.nativeEnum(Platform),
  pickup: z.object({
    address: z.string(),
    lat: z.number(),
    lng: z.number(),
    time: z.date(),
  }),
  dropoff: z.object({
    address: z.string(),
    lat: z.number(),
    lng: z.number(),
  }).optional(),
  estimatedFare: z.number().min(0),
  estimatedDuration: z.number().min(0),
  distance: z.number().min(0),
  clientInfo: z.object({
    firstName: z.string().optional(),
    rating: z.number().min(0).max(5).optional(),
    preferences: z.array(z.string()).optional(),
  }),
  specialRequests: z.array(z.string()).optional(),
  urgency: z.enum(['low', 'medium', 'high']),
  expiresAt: z.date(),
});

export const ajnayaRouter = createTRPCRouter({
  /**
   * Analyse comportementale complète du chauffeur
   */
  analyzeBehavior: driverProcedure
    .input(
      z.object({
        weather: WeatherDataSchema,
        location: GeoLocationSchema,
        timeContext: TimeContextSchema,
        platformsData: PlatformsDataSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driverId = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driverId) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        const analysis = await driverBehaviorAnalyzer.analyzeDriverBehavior(
          driverId.id,
          input.platformsData as PlatformsData,
          input.weather as WeatherData,
          input.timeContext as TimeContext,
          input.location as GeoLocation
        );

        console.log(`🧠 Ajnaya analysis completed for driver ${driverId.id}`);

        return {
          success: true,
          analysis,
          timestamp: new Date(),
        };
      } catch (error: any) {
        console.error('❌ Ajnaya behavior analysis failed:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Échec de l'analyse Ajnaya: ${error.message}`,
        });
      }
    }),

  /**
   * Recommandation pour une réservation spécifique
   */
  analyzeBooking: driverProcedure
    .input(
      z.object({
        booking: BookingRequestSchema,
        includeFullAnalysis: z.boolean().default(false),
        contextData: z.object({
          weather: WeatherDataSchema.optional(),
          location: GeoLocationSchema.optional(),
          timeContext: TimeContextSchema.optional(),
          platformsData: PlatformsDataSchema.optional(),
        }).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        include: {
          user: true,
          _count: {
            select: { rides: true }
          }
        },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        // Construire le contexte chauffeur
        const driverContext = {
          driverId: driver.id,
          currentLocation: input.contextData?.location ? {
            lat: input.contextData.location.lat,
            lng: input.contextData.location.lng,
          } : undefined,
          isAvailable: driver.user.status === 'ACTIVE',
          activeRides: 0, // Serait calculé depuis les rides actives
          preferences: {
            minFare: 500, // 5€ minimum par défaut
            maxDistance: 25, // 25km max par défaut
          },
          stats: {
            totalRides: driver._count.rides,
            averageRating: driver.averageRating,
            acceptanceRate: 85, // Serait calculé depuis l'historique
            earningsToday: 0, // Serait calculé
          },
        };

        // Analyse comportementale complète si demandée
        let behaviorAnalysis = undefined;
        if (input.includeFullAnalysis && input.contextData?.weather && 
            input.contextData?.timeContext && input.contextData?.platformsData && 
            input.contextData?.location) {
          behaviorAnalysis = await driverBehaviorAnalyzer.analyzeDriverBehavior(
            driver.id,
            input.contextData.platformsData as PlatformsData,
            input.contextData.weather as WeatherData,
            input.contextData.timeContext as TimeContext,
            input.contextData.location as GeoLocation
          );
        }

        // Analyse de la réservation
        const recommendationEngine = new BookingRecommendationEngine();
        const recommendation = await recommendationEngine.analyzeBooking(
          input.booking as any,
          driverContext as any,
          behaviorAnalysis
        );

        console.log(`🎯 Booking recommendation generated for ${input.booking.id}: ${recommendation.shouldAccept ? 'ACCEPT' : 'REJECT'}`);

        return {
          success: true,
          recommendation,
          behaviorAnalysis: input.includeFullAnalysis ? behaviorAnalysis : undefined,
          timestamp: new Date(),
        };
      } catch (error: any) {
        console.error('❌ Booking analysis failed:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Échec de l'analyse de réservation: ${error.message}`,
        });
      }
    }),

  /**
   * Récupérer les insights Ajnaya actifs
   */
  getActiveInsights: driverProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(50).default(20),
        types: z.array(z.enum(['ZONE_ALERT', 'APP_SWITCH', 'BREAK_REMINDER', 'EARNINGS_BOOST', 'PERFORMANCE'])).optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        const whereClause: any = {
          driverId: driver.id,
          expiresAt: { gt: new Date() },
          isDismissed: false,
        };

        if (input.types && input.types.length > 0) {
          whereClause.type = { in: input.types };
        }

        if (input.priority) {
          whereClause.priority = input.priority;
        }

        const insights = await ctx.prisma.ajnayaInsight.findMany({
          where: whereClause,
          orderBy: [
            { priority: 'desc' },
            { createdAt: 'desc' },
          ],
          take: input.limit,
        });

        console.log(`📊 Retrieved ${insights.length} active Ajnaya insights for driver ${driver.id}`);

        return {
          insights,
          count: insights.length,
        };
      } catch (error: any) {
        console.error('❌ Failed to get Ajnaya insights:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Impossible de récupérer les insights Ajnaya',
        });
      }
    }),

  /**
   * Marquer un insight comme lu
   */
  markInsightAsRead: driverProcedure
    .input(
      z.object({
        insightId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        const insight = await ctx.prisma.ajnayaInsight.update({
          where: {
            id: input.insightId,
            driverId: driver.id, // Sécurité: s'assurer que l'insight appartient au chauffeur
          },
          data: {
            isRead: true,
          },
        });

        console.log(`📖 Insight ${input.insightId} marked as read for driver ${driver.id}`);

        return {
          success: true,
          insight,
        };
      } catch (error: any) {
        console.error('❌ Failed to mark insight as read:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Impossible de marquer l\'insight comme lu',
        });
      }
    }),

  /**
   * Rejeter un insight
   */
  dismissInsight: driverProcedure
    .input(
      z.object({
        insightId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        const insight = await ctx.prisma.ajnayaInsight.update({
          where: {
            id: input.insightId,
            driverId: driver.id,
          },
          data: {
            isDismissed: true,
          },
        });

        console.log(`🗑️ Insight ${input.insightId} dismissed by driver ${driver.id}`);

        return {
          success: true,
          insight,
        };
      } catch (error: any) {
        console.error('❌ Failed to dismiss insight:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Impossible de rejeter l\'insight',
        });
      }
    }),

  /**
   * Obtenir le résumé de performance Ajnaya
   */
  getPerformanceSummary: driverProcedure
    .input(
      z.object({
        period: z.enum(['today', 'week', 'month']).default('today'),
      })
    )
    .query(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        include: {
          rides: {
            where: {
              completedAt: {
                gte: getPeriodStartDate(input.period),
              },
            },
          },
          earnings: {
            where: {
              earnedAt: {
                gte: getPeriodStartDate(input.period),
              },
            },
          },
        },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        const summary = {
          period: input.period,
          stats: {
            totalRides: driver.rides.length,
            totalEarnings: driver.earnings.reduce((sum, earning) => sum + earning.amount, 0),
            averageRideValue: driver.rides.length > 0 
              ? driver.earnings.reduce((sum, earning) => sum + earning.amount, 0) / driver.rides.length 
              : 0,
            bestPerformingHour: calculateBestHour(driver.rides),
            platformBreakdown: calculatePlatformBreakdown(driver.rides),
          },
          insights: {
            totalGenerated: await ctx.prisma.ajnayaInsight.count({
              where: {
                driverId: driver.id,
                createdAt: {
                  gte: getPeriodStartDate(input.period),
                },
              },
            }),
            highPriorityCount: await ctx.prisma.ajnayaInsight.count({
              where: {
                driverId: driver.id,
                priority: 'HIGH',
                createdAt: {
                  gte: getPeriodStartDate(input.period),
                },
              },
            }),
            readCount: await ctx.prisma.ajnayaInsight.count({
              where: {
                driverId: driver.id,
                isRead: true,
                createdAt: {
                  gte: getPeriodStartDate(input.period),
                },
              },
            }),
          },
          recommendations: await generatePerformanceRecommendations(driver),
        };

        console.log(`📈 Performance summary generated for driver ${driver.id} (${input.period})`);

        return summary;
      } catch (error: any) {
        console.error('❌ Failed to get performance summary:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Impossible de récupérer le résumé de performance',
        });
      }
    }),

  /**
   * Test des fonctionnalités Ajnaya (développement)
   */
  testAjnaya: driverProcedure
    .input(
      z.object({
        testType: z.enum(['behavior', 'booking', 'insights']),
        mockData: z.any().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (env.NODE_ENV === 'production') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Test endpoint disponible uniquement en développement',
        });
      }

      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
        select: { id: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      try {
        let testResult;

        switch (input.testType) {
          case 'behavior':
            testResult = { message: 'Test behavior analysis - fonctionnalité à implémenter' };
            break;
          case 'booking':
            testResult = { message: 'Test booking recommendation - fonctionnalité à implémenter' };
            break;
          case 'insights':
            testResult = { message: 'Test insight generation - fonctionnalité à implémenter' };
            break;
          default:
            throw new Error('Type de test invalide');
        }

        return {
          success: true,
          testType: input.testType,
          result: testResult,
          timestamp: new Date(),
        };
      } catch (error: any) {
        console.error('❌ Ajnaya test failed:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Test Ajnaya échoué: ${error.message}`,
        });
      }
    }),
});

// Méthodes utilitaires privées (à déplacer dans une classe helper)
function getPeriodStartDate(period: 'today' | 'week' | 'month'): Date {
  const now = new Date();
  switch (period) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'week':
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      return weekStart;
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1);
  }
}

function calculateBestHour(rides: any[]): number {
  const hourCounts = Array.from({ length: 24 }, () => 0);
  rides.forEach(ride => {
    if (ride.completedAt) {
      hourCounts[new Date(ride.completedAt).getHours()]++;
    }
  });
  return hourCounts.indexOf(Math.max(...hourCounts));
}

function calculatePlatformBreakdown(rides: any[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  rides.forEach(ride => {
    breakdown[ride.platform] = (breakdown[ride.platform] || 0) + 1;
  });
  return breakdown;
}

async function generatePerformanceRecommendations(driver: any): Promise<string[]> {
  const recommendations = [];
  
  if (driver.averageRating < 4.5) {
    recommendations.push('Améliorez votre note moyenne pour accéder aux bonus qualité');
  }
  
  if (driver.totalRides < 100) {
    recommendations.push('Complétez 100 courses pour débloquer les analyses avancées');
  }
  
  recommendations.push('Activez les notifications Ajnaya pour ne manquer aucune opportunité');
  
  return recommendations;
}