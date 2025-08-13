/**
 * Trips Router - FOREAS Driver Backend
 * Gestion des courses avec validation Zod
 */

import { z } from 'zod';

import { router, publicProcedure } from '../trpc';
import { requireAuth } from '../middleware/requireAuth';

/**
 * Schémas Zod pour la validation des entrées/sorties
 */
const TripsListInput = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
});

const TripsListOutput = z.object({
  trips: z.array(z.object({
    id: z.string(),
    platform: z.enum(['UBER', 'BOLT', 'HEETCH', 'FOREAS_DIRECT']),
    status: z.enum(['COMPLETED', 'CANCELLED']),
    finalPrice: z.number(),
    netEarnings: z.number(),
  })),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
  }),
});

const CreateManualInput = z.object({
  platform: z.literal('FOREAS_DIRECT'),
  pickupAddress: z.string(),
  dropoffAddress: z.string(),
  finalPrice: z.number().min(0),
});

const CreateManualOutput = z.object({
  success: z.boolean(),
  tripId: z.string(),
});

const StatsInput = z.object({
  period: z.enum(['day', 'week', 'month']).default('month'),
});

const StatsOutput = z.object({
  period: z.string(),
  totalTrips: z.number(),
  totalRevenue: z.number(),
  netEarnings: z.number(),
});

/**
 * Router de gestion des courses
 */
export const tripsRouter = router({
  /**
   * Liste des courses
   */
  list: publicProcedure
    .use(requireAuth)
    .input(TripsListInput)
    .output(TripsListOutput)
    .query(async ({ input }) => {
      return {
        trips: [
          {
            id: 'trip_001',
            platform: 'UBER' as const,
            status: 'COMPLETED' as const,
            finalPrice: 22.80,
            netEarnings: 18.24,
          },
        ],
        pagination: {
          page: input.page,
          limit: input.limit,
          total: 1,
        },
      };
    }),

  /**
   * Création d'une course manuelle
   */
  createManual: publicProcedure
    .use(requireAuth)
    .input(CreateManualInput)
    .output(CreateManualOutput)
    .mutation(async ({ input }) => {
      return {
        success: true,
        tripId: `trip_manual_${Date.now()}`,
      };
    }),

  /**
   * Statistiques des courses
   */
  stats: publicProcedure
    .use(requireAuth)
    .input(StatsInput)
    .output(StatsOutput)
    .query(async ({ input }) => {
      return {
        period: input.period,
        totalTrips: 45,
        totalRevenue: 1280.50,
        netEarnings: 1024.40,
      };
    }),
});