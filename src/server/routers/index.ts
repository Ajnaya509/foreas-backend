/**
 * Main tRPC Router - FOREAS Driver Backend
 * Agrégation de tous les routers
 */

import { router } from '../trpc';
import { authRouter } from './auth';
import { insightsRouter } from './insights';
import { profileRouter } from './profile';
import { stripeRouter } from './stripe';
import { tripsRouter } from './trips';
import { zonesRouter } from './zones';

/**
 * Router principal avec tous les sous-routers
 */
export const appRouter = router({
  auth: authRouter,
  profile: profileRouter,
  trips: tripsRouter,
  insights: insightsRouter,
  stripe: stripeRouter,
  zones: zonesRouter,
});

/**
 * Type du router pour l'inférence côté client
 */
export type AppRouter = typeof appRouter;