/**
 * Logger - FOREAS Driver Backend
 * Configuration Pino optimisée pour production avec protection des secrets
 */

import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { env } from '@/env';

/**
 * Liste des clés sensibles à masquer dans les logs
 */
const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'stripe_secret_key',
  'webhook_secret',
  'api_key',
  'private_key',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SENTRY_DSN',
  'session',
  'auth',
  'jwt',
];

/**
 * Configuration du logger Pino
 */
const loggerConfig: pino.LoggerOptions = {
  level: env.NODE_ENV === 'test' ? 'silent' : 'info',
  
  // Développement : Format pretty pour lisibilité
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{context} - {msg}',
        singleLine: false,
        levelFirst: true,
      },
    },
  }),

  // Production : JSON structuré pour parsing par les outils
  ...(env.NODE_ENV === 'production' && {
    formatters: {
      level: (label) => ({ level: label.toUpperCase() }),
      bindings: (bindings) => ({
        pid: bindings.pid,
        hostname: bindings.hostname,
        environment: env.NODE_ENV,
        service: 'foreas-driver-backend',
      }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
  }),

  // Redaction automatique des données sensibles
  redact: {
    paths: SENSITIVE_KEYS.flatMap(key => [
      key,
      `*.${key}`,
      `req.body.${key}`,
      `req.query.${key}`,
    ]),
    remove: false,
    censor: '***REDACTED***',
  },

  // Sérializers personnalisés
  serializers: {
    err: pino.stdSerializers.err,
    req: (req: any) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query,
      params: req.params,
      headers: {
        'user-agent': req.headers?.['user-agent'],
        'content-type': req.headers?.['content-type'],
        'x-forwarded-for': req.headers?.['x-forwarded-for'],
        // Supprimer automatiquement les headers sensibles
      },
      remoteAddress: req.remoteAddress || req.ip,
      remotePort: req.remotePort,
    }),
    res: (res: any) => ({
      statusCode: res.statusCode,
      headers: {
        'content-type': res.headers?.['content-type'],
        'content-length': res.headers?.['content-length'],
      },
      responseTime: res.responseTime,
    }),
  },
};

/**
 * Logger principal
 */
export const logger = pino(loggerConfig);

/**
 * Créer un logger avec contexte spécifique et correlationId
 */
export const createContextLogger = (context: string, correlationId?: string) => {
  return logger.child({
    context,
    ...(correlationId && { correlationId }),
  });
};

/**
 * Loggers spécialisés par contexte
 */
export const appLogger = createContextLogger('app');
export const authLogger = createContextLogger('auth');
export const stripeLogger = createContextLogger('stripe');
export const webhookLogger = createContextLogger('webhook');
export const trpcLogger = createContextLogger('trpc');
export const rateLimitLogger = createContextLogger('rate-limit');

/**
 * Interface pour les logs d'erreur avec correlation ID
 */
interface LogErrorOptions {
  error: Error;
  correlationId?: string;
  context?: string;
  userId?: string;
  metadata?: Record<string, any>;
}

/**
 * Log d'erreur avec information complète
 */
export const logError = ({
  error,
  correlationId = uuidv4(),
  context = 'app',
  userId,
  metadata = {},
}: LogErrorOptions) => {
  const contextLogger = createContextLogger(context, correlationId);
  
  contextLogger.error(
    {
      err: error,
      userId,
      correlationId,
      metadata,
      stack: error.stack,
    },
    `Error occurred: ${error.message}`
  );
};

/**
 * Log de requête HTTP avec timing
 */
export const logRequest = (
  method: string,
  url: string,
  statusCode: number,
  responseTime: number,
  correlationId?: string,
  userId?: string
) => {
  const requestLogger = createContextLogger('http', correlationId);
  
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  
  requestLogger[level](
    {
      method,
      url,
      statusCode,
      responseTime: `${responseTime}ms`,
      userId,
    },
    `${method} ${url} - ${statusCode} - ${responseTime}ms`
  );
};

/**
 * Génère un correlation ID unique
 */
export const generateCorrelationId = (): string => {
  return uuidv4();
};

/**
 * Log sécurisé qui redacte automatiquement les données sensibles
 */
export const logSafely = (
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  data?: Record<string, any>,
  context = 'app'
) => {
  const contextLogger = createContextLogger(context);
  contextLogger[level](data, message);
};

/**
 * Logger de performance pour mesurer les temps d'exécution
 */
export const createPerformanceLogger = (operation: string, correlationId?: string) => {
  const startTime = process.hrtime.bigint();
  const perfLogger = createContextLogger('performance', correlationId);
  
  return {
    finish: (metadata?: Record<string, any>) => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
      
      perfLogger.info(
        {
          operation,
          duration: `${duration.toFixed(2)}ms`,
          ...metadata,
        },
        `Operation ${operation} completed in ${duration.toFixed(2)}ms`
      );
    },
  };
};

/**
 * Export par défaut du logger principal
 */
export default logger;