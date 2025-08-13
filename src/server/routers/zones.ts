/**
 * Zones Router - FOREAS Driver Backend
 * Gestion des snapshots de zones avec heatmap et cache DB
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, publicProcedure } from '../trpc';
import { requireAuth } from '../middleware/requireAuth';
import { 
  ZonesService,
  ZoneSnapshotSchema,
  HeatmapSchema,
  TopZoneSchema 
} from '@/services/ZonesService';

/**
 * Schémas Zod pour la validation des entrées/sorties
 */
const CurrentInput = z.object({
  city: z.string().min(1, 'Le nom de la ville ne peut pas être vide').trim(),
});

const CurrentOutput = z.object({
  id: z.string(),
  city: z.string(),
  demandScore: z.number().min(0).max(100),
  heatmap: HeatmapSchema,
  topZones: z.array(TopZoneSchema),
  validUntil: z.date(),
  createdAt: z.date(),
  cached: z.boolean(), // Indique si les données viennent du cache
});

/**
 * Router des zones avec heatmap
 */
export const zonesRouter = router({
  /**
   * Obtenir le snapshot actuel pour une ville
   * Utilise le cache DB ou génère de nouvelles données mock
   */
  current: publicProcedure
    .use(requireAuth)
    .input(CurrentInput)
    .output(CurrentOutput)
    .query(async ({ input }) => {
      const { city } = input;

      try {
        const snapshot = await ZonesService.getCurrent(city);
        const now = new Date();
        
        // Déterminer si les données viennent du cache
        const cached = snapshot.createdAt < new Date(now.getTime() - 30 * 1000); // Si créé il y a plus de 30s, c'est du cache

        return {
          ...snapshot,
          cached,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Erreur lors de la récupération des données de zone pour ${city}`,
          cause: error,
        });
      }
    }),
});