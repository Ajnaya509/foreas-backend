/**
 * Authentication Middleware - FOREAS Driver Backend
 * Middleware tRPC pour forcer l'authentification
 */

import { TRPCError } from '@trpc/server';
import { middleware } from '../trpc';

/**
 * Middleware requireAuth
 * Lance une erreur UNAUTHORIZED si !ctx.userId
 */
export const requireAuth = middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }

  return next({
    ctx: {
      ...ctx,
      userId: ctx.userId, // TypeScript sait maintenant que userId est défini
    },
  });
});