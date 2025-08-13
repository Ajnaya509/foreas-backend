/**
 * Insights Router - FOREAS Driver Backend
 * Router tRPC pour les insights Ajnaya avec règles simples
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, publicProcedure } from '../trpc';
import { requireAuth } from '../middleware/requireAuth';
import { prisma } from '@/server/db';
import { 
  AjnayaService, 
  InsightSchema, 
  TripScoreSchema,
  TripDataSchema,
  ZoneSnapshotSchema 
} from '@/services/AjnayaService';

/**
 * Schémas de validation pour les entrées/sorties
 */
const GetCurrentInsightsInput = z.object({
  city: z.string().optional(), // Si non fourni, utilise la dernière ville connue
});

const GetCurrentInsightsOutput = z.object({
  insights: z.array(InsightSchema),
  stats: z.object({
    tripsLast7d: z.number(),
    averageScore: z.number(),
    totalNetEarnings: z.number(),
    city: z.string(),
  }),
  zoneSnapshot: ZoneSnapshotSchema.optional(),
});

const ScoreTripInput = z.object({
  tripId: z.string(),
});

const ScoreTripOutput = TripScoreSchema.extend({
  tripId: z.string(),
  tripData: TripDataSchema,
});

/**
 * Utilitaire pour convertir les données Prisma en TripData
 */
function convertPrismaTripToTripData(prismaTrip: any): any {
  return {
    id: prismaTrip.id,
    netEarnings: prismaTrip.netEarnings,
    distance: prismaTrip.distance,
    duration: prismaTrip.duration,
    commission: prismaTrip.commission,
    finalPrice: prismaTrip.finalPrice,
    startedAt: prismaTrip.startedAt,
    completedAt: prismaTrip.completedAt,
    platform: prismaTrip.platform,
  };
}

/**
 * Détermine la ville principale du chauffeur
 */
async function getDriverMainCity(driverId: string, providedCity?: string): Promise<string> {
  if (providedCity) {
    return providedCity;
  }

  // Chercher la ville la plus fréquente dans les derniers trajets
  const recentTrips = await prisma.trip.findMany({
    where: {
      driverId,
      startedAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 derniers jours
      },
    },
    select: {
      pickupAddress: true,
    },
    orderBy: {
      startedAt: 'desc',
    },
    take: 50,
  });

  // Extraction simple de ville (basée sur les virgules dans l'adresse)
  const cities = recentTrips
    .map(trip => {
      const parts = trip.pickupAddress.split(',');
      return parts[parts.length - 1]?.trim() || 'Paris'; // Fallback sur Paris
    })
    .filter(city => city.length > 2);

  if (cities.length === 0) {
    return 'Paris'; // Ville par défaut
  }

  // Compter les occurrences et prendre la plus fréquente
  const cityCount = cities.reduce((acc, city) => {
    acc[city] = (acc[city] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const mostFrequentCity = Object.entries(cityCount)
    .sort(([,a], [,b]) => b - a)[0][0];

  return mostFrequentCity;
}

/**
 * Router pour les insights
 */
export const insightsRouter = router({
  /**
   * Obtenir les insights actuels pour le chauffeur connecté
   */
  current: publicProcedure
    .use(requireAuth)
    .input(GetCurrentInsightsInput)
    .output(GetCurrentInsightsOutput)
    .query(async ({ input, ctx }) => {
      const { userId } = ctx;
      
      // Récupérer les informations du chauffeur
      const driver = await prisma.driver.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      // Récupérer les trajets des 7 derniers jours
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const tripsLast7d = await prisma.trip.findMany({
        where: {
          driverId: driver.id,
          startedAt: {
            gte: sevenDaysAgo,
          },
          status: 'COMPLETED',
        },
        orderBy: {
          startedAt: 'desc',
        },
      });

      // Déterminer la ville principale
      const city = await getDriverMainCity(driver.id, input.city);

      // Convertir les données Prisma en format TripData
      const convertedTrips = tripsLast7d.map(convertPrismaTripToTripData);

      // Générer ou récupérer un snapshot de zone (pour l'instant, utiliser un mock)
      const zoneSnapshot = AjnayaService.getMockZoneSnapshot(city);

      // Calculer les insights
      const insights = AjnayaService.computeInsights({
        driverId: userId,
        city,
        tripsLast7d: convertedTrips,
        zoneSnapshot,
      });

      // Calculer les statistiques générales
      const totalNetEarnings = convertedTrips.reduce((sum, trip) => sum + trip.netEarnings, 0);
      const scores = convertedTrips.map(trip => AjnayaService.scoreTrip(trip).score);
      const averageScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

      return {
        insights,
        stats: {
          tripsLast7d: convertedTrips.length,
          averageScore: Math.round(averageScore),
          totalNetEarnings: Math.round(totalNetEarnings * 100) / 100,
          city,
        },
        zoneSnapshot,
      };
    }),

  /**
   * Calculer le score d'un trajet spécifique
   */
  scoreTrip: publicProcedure
    .use(requireAuth)
    .input(ScoreTripInput)
    .output(ScoreTripOutput)
    .query(async ({ input, ctx }) => {
      const { userId } = ctx;
      const { tripId } = input;

      // Récupérer les informations du chauffeur
      const driver = await prisma.driver.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Profil chauffeur non trouvé',
        });
      }

      // Récupérer le trajet
      const trip = await prisma.trip.findFirst({
        where: {
          id: tripId,
          driverId: driver.id, // S'assurer que le trajet appartient au chauffeur
        },
      });

      if (!trip) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Trajet non trouvé',
        });
      }

      // Convertir les données Prisma
      const convertedTrip = convertPrismaTripToTripData(trip);

      // Calculer le score
      const tripScore = AjnayaService.scoreTrip(convertedTrip);

      return {
        tripId,
        tripData: convertedTrip,
        ...tripScore,
      };
    }),
});