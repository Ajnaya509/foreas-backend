/**
 * Profile Router - FOREAS Driver Backend
 * Gestion du profil utilisateur avec validation Zod
 */

import { z } from 'zod';

import { router, publicProcedure } from '../trpc';
import { requireAuth } from '../middleware/requireAuth';

/**
 * Schémas Zod pour la validation des entrées/sorties
 */
const ProfileGetOutput = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.enum(['ADMIN', 'DRIVER']),
  status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']),
});

const ProfileUpdateInput = z.object({
  name: z.string().optional(),
  phone: z.string().nullable().optional(),
});

const ProfileUpdateOutput = z.object({
  success: z.boolean(),
  profile: ProfileGetOutput,
});

const SetOnlineInput = z.object({
  isOnline: z.boolean(),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    address: z.string().optional(),
  }).optional(),
});

const SetOnlineOutput = z.object({
  success: z.boolean(),
  isOnline: z.boolean(),
  location: z.object({
    lat: z.number(),
    lng: z.number(),
    address: z.string(),
  }).nullable(),
});

/**
 * Router de profil utilisateur
 */
export const profileRouter = router({
  /**
   * Récupération du profil
   */
  get: publicProcedure
    .use(requireAuth)
    .output(ProfileGetOutput)
    .query(async ({ ctx }) => {
      return {
        id: ctx.userId,
        email: 'jean.martin@foreas.app',
        name: 'Jean Martin',
        phone: '+33123456789',
        role: 'DRIVER' as const,
        status: 'ACTIVE' as const,
      };
    }),

  /**
   * Mise à jour du profil
   */
  update: publicProcedure
    .use(requireAuth)
    .input(ProfileUpdateInput)
    .output(ProfileUpdateOutput)
    .mutation(async ({ input, ctx }) => {
      return {
        success: true,
        profile: {
          id: ctx.userId,
          email: 'jean.martin@foreas.app',
          name: input.name || 'Jean Martin',
          phone: input.phone || '+33123456789',
          role: 'DRIVER' as const,
          status: 'ACTIVE' as const,
        },
      };
    }),

  /**
   * Définir le statut en ligne/hors ligne
   */
  setOnline: publicProcedure
    .use(requireAuth)
    .input(SetOnlineInput)
    .output(SetOnlineOutput)
    .mutation(async ({ input, ctx }) => {
      const { isOnline, location } = input;

      return {
        success: true,
        isOnline,
        location: location ? {
          lat: location.lat,
          lng: location.lng,
          address: location.address || 'Localisation mise à jour',
        } : null,
      };
    }),
});