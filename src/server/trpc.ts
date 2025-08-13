/**
 * tRPC Configuration - FOREAS Driver Backend
 * Configuration centralisée avec superjson et gestion d'erreurs standardisée
 */

import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';

import { env } from '@/env';
import { formatTRPCError } from '@/utils/trpcErrorFormatter';
import type { Context } from './context';

/**
 * Initialize tRPC with context
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  
  /**
   * Format d'erreur standardisé avec correlation ID
   */
  errorFormatter: ({ shape, error, ctx }) => {
    // Formater l'erreur avec correlation ID et logging
    const formattedError = formatTRPCError(error, {
      userId: ctx?.userId,
      path: shape.path,
      correlationId: ctx?.correlationId,
    });

    return {
      ...shape,
      data: {
        ...shape.data,
        correlationId: formattedError.correlationId,
        timestamp: formattedError.timestamp,
        zodError:
          error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
        // Données additionnelles pour debugging en développement
        ...(env.NODE_ENV === 'development' && formattedError.details),
      },
    };
  },
});

/**
 * Export des éléments de base tRPC
 */
export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;