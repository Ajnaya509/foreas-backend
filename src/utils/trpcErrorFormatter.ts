/**
 * tRPC Error Formatter - FOREAS Driver Backend
 * Formatage standardisé des erreurs tRPC avec correlation ID
 */

import { TRPCError } from '@trpc/server';
import { generateCorrelationId, logError } from './logger';
import { env } from '@/env';

// Import Sentry seulement si configuré
let Sentry: any = null;
if (env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (error) {
    console.warn('Sentry n\'est pas disponible, continuons sans monitoring');
  }
}

/**
 * Interface pour les erreurs formatées standardisées
 */
interface FormattedError {
  code: string;
  message: string;
  correlationId: string;
  timestamp: string;
  path?: string;
  details?: any;
}

/**
 * Interface pour le contexte d'erreur
 */
interface ErrorContext {
  userId?: string;
  path?: string;
  input?: any;
  correlationId?: string;
}

/**
 * Formateur d'erreur tRPC standardisé
 * Ajoute automatiquement un correlationId et log l'erreur
 */
export const formatTRPCError = (
  error: any,
  context: ErrorContext = {}
): FormattedError => {
  const correlationId = context.correlationId || generateCorrelationId();
  const timestamp = new Date().toISOString();

  // Détecter si c'est déjà une TRPCError
  let trpcError: TRPCError;
  if (error instanceof TRPCError) {
    trpcError = error;
  } else {
    // Convertir les erreurs génériques en TRPCError
    trpcError = new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: error.message || 'Une erreur interne s\'est produite',
      cause: error,
    });
  }

  // Log de l'erreur avec contexte
  logError({
    error: trpcError,
    correlationId,
    context: 'trpc',
    userId: context.userId || undefined,
    metadata: {
      path: context.path,
      input: context.input,
      code: trpcError.code,
    },
  });

  // Envoyer à Sentry si configuré
  if (Sentry && trpcError.code === 'INTERNAL_SERVER_ERROR') {
    Sentry.withScope((scope: any) => {
      scope.setTag('correlationId', correlationId);
      scope.setTag('trpcCode', trpcError.code);
      scope.setContext('trpc', {
        path: context.path,
        userId: context.userId || 'anonymous',
        input: context.input,
      });
      Sentry.captureException(trpcError);
    });
  }

  // Formater la réponse selon l'environnement
  const formattedError: FormattedError = {
    code: trpcError.code,
    message: trpcError.message,
    correlationId,
    timestamp,
  };

  // En développement, ajouter plus de détails
  if (env.NODE_ENV === 'development') {
    formattedError.path = context.path;
    formattedError.details = {
      stack: trpcError.stack,
      cause: trpcError.cause,
      input: context.input,
    };
  }

  return formattedError;
};

/**
 * Créer une TRPCError avec correlation ID automatique
 */
export const createTRPCError = (
  code: TRPCError['code'],
  message: string,
  context: ErrorContext = {}
): never => {
  const correlationId = context.correlationId || generateCorrelationId();
  
  const error = new TRPCError({
    code,
    message,
  });

  // Formater et logger l'erreur
  const formattedError = formatTRPCError(error, {
    ...context,
    correlationId,
  });

  // Relancer l'erreur formatée
  throw error;
};

/**
 * Wrapper pour formater automatiquement les erreurs dans les procédures tRPC
 */
export const withErrorHandling = <T>(
  fn: (...args: any[]) => Promise<T>,
  context: Omit<ErrorContext, 'correlationId'> = {}
) => {
  return async (...args: any[]): Promise<T> => {
    const correlationId = generateCorrelationId();
    
    try {
      return await fn(...args);
    } catch (error) {
      // Format de l'erreur pour le logging et Sentry
      formatTRPCError(error, {
        ...context,
        correlationId,
      });

      // Relancer l'erreur originale pour que tRPC la gère
      throw error;
    }
  };
};

/**
 * Middleware pour ajouter le correlation ID au contexte tRPC
 */
export const withCorrelationId = (opts: any) => {
  const correlationId = generateCorrelationId();
  
  // Ajouter le correlation ID au contexte
  opts.ctx = {
    ...opts.ctx,
    correlationId,
  };

  return opts;
};

/**
 * Types pour l'export
 */
export type { FormattedError, ErrorContext };