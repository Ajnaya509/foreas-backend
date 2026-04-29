/**
 * HTTP Server - FOREAS Driver Backend
 * Serveur Express minimal exposant l'API tRPC
 */

import cors from 'cors';
import express from 'express';
import type { Request, Response } from 'express';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';

import { env } from '@/env';
import { appLogger } from '@/utils/logger';
import { authRateLimit, stripeRateLimit } from '@/middleware/rateLimiter';
import { createContext } from './context';
import { appRouter } from './routers';
import { aiProxyRouter } from './api/ai-proxy';
import communityRoutes from '../routes/community.routes';

// Initialiser Sentry si configuré
if (env.SENTRY_DSN) {
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
      integrations: [
        Sentry.httpIntegration(),
        Sentry.expressIntegration({
          app: express(),
        }),
      ],
    });
    appLogger.info('Sentry initialized successfully');
  } catch (error) {
    appLogger.warn('Failed to initialize Sentry', { error });
  }
}

/**
 * Configuration du serveur Express
 */
const app = express();

// Middlewares de base
app.use(cors());
app.use(express.json());

/**
 * AI Proxy routes - Forwarde vers AI Backend
 * App Mobile → /api/ai/* → AI Backend /api/ajnaya/*
 */
app.use('/api/ai', aiProxyRouter);

/**
 * Community routes — Moderation IA + Alertes trending
 */
app.use('/api/community', communityRoutes);

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

/**
 * Configuration du handler tRPC
 */
const trpcHandler = createHTTPHandler({
  router: appRouter,
  createContext,
});

/**
 * Appliquer le rate limiting sur les routes sensibles
 */
app.use('/trpc/auth.*', authRateLimit);
app.use('/trpc/stripe.*', stripeRateLimit);

/**
 * Montage du handler tRPC sur /trpc
 */
app.use('/trpc', trpcHandler);

/**
 * Export du serveur pour les tests
 */
export { app };

/**
 * Démarrage du serveur si ce fichier est exécuté directement
 */
const PORT = env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`🔗 tRPC endpoint: http://localhost:${PORT}/trpc`);
  });
}
