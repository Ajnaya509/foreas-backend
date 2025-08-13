/**
 * Prisma Client Singleton - FOREAS Driver Backend
 * Gestion centralisée de la connexion à la base de données
 */

import { PrismaClient } from '@prisma/client';

import { env } from '@/env';

/**
 * Configuration Prisma avec logs et métriques
 */
const prismaConfig = {
  datasources: {
    db: {
      url: env.DATABASE_URL,
    },
  },
  log: [
    {
      emit: 'event',
      level: 'query',
    },
    {
      emit: 'event',
      level: 'error',
    },
    {
      emit: 'event',
      level: 'info',
    },
    {
      emit: 'event',
      level: 'warn',
    },
  ],
} as const;

/**
 * Configuration globale pour réutiliser l'instance Prisma
 * Évite les multiples connexions en développement
 */
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

/**
 * Crée ou récupère le client Prisma singleton
 */
function createPrismaClient(): PrismaClient {
  const client = new PrismaClient(prismaConfig);

  // Configuration des listeners pour les logs
  if (env.NODE_ENV === 'development') {
    // En développement, log toutes les queries pour debug
    client.$on('query', (e) => {
      console.log('Query:', e.query);
      console.log('Params:', e.params);
      console.log('Duration:', e.duration, 'ms');
    });
  }

  // Logs d'erreur en production
  client.$on('error', (e) => {
    console.error('Prisma Error:', e);
  });

  // Logs d'info
  client.$on('info', (e) => {
    console.log('Prisma Info:', e.message);
  });

  // Logs d'avertissement
  client.$on('warn', (e) => {
    console.warn('Prisma Warning:', e.message);
  });

  return client;
}

/**
 * Instance singleton du client Prisma
 * Réutilise l'instance existante en développement pour éviter les reconnexions
 */
export const prisma = globalThis.__prisma ?? createPrismaClient();

if (env.NODE_ENV === 'development') {
  globalThis.__prisma = prisma;
}

/**
 * Fermeture propre de la connexion
 * Appelée lors de l'arrêt du serveur
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  console.log('✅ Prisma disconnected gracefully');
}

/**
 * Test de la connexion à la base de données
 * Utile pour les health checks
 */
export async function testDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    return false;
  }
}

/**
 * Nettoyage automatique lors de l'arrêt du processus
 * Garantit la fermeture propre des connexions
 */
function setupGracefulShutdown(): void {
  const gracefulShutdown = async (signal: string): Promise<void> => {
    console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
    
    try {
      await disconnectPrisma();
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during graceful shutdown:', error);
      process.exit(1);
    }
  };

  // Écouter les signaux d'arrêt
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  
  // Gérer les erreurs non catchées
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    void gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    void gracefulShutdown('unhandledRejection');
  });
}

// Initialiser le graceful shutdown uniquement en production/staging
if (env.NODE_ENV !== 'test') {
  setupGracefulShutdown();
}

/**
 * Utilitaires pour les transactions
 */
export const withTransaction = async <T>(
  operation: (tx: PrismaClient) => Promise<T>,
): Promise<T> => {
  return await prisma.$transaction(operation);
};

/**
 * Health check pour les APIs de monitoring
 */
export async function getDatabaseHealth(): Promise<{
  status: 'healthy' | 'unhealthy';
  latency: number;
  timestamp: string;
}> {
  const start = Date.now();
  
  try {
    await prisma.$queryRaw`SELECT NOW()`;
    const latency = Date.now() - start;
    
    return {
      status: 'healthy',
      latency,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Statistiques de la base de données pour debug
 */
export async function getDatabaseStats(): Promise<{
  users: number;
  drivers: number;
  trips: number;
  bookings: number;
  earnings: number;
}> {
  const [users, drivers, trips, bookings, earnings] = await Promise.all([
    prisma.user.count(),
    prisma.driver.count(),
    prisma.trip.count(),
    prisma.booking.count(),
    prisma.earning.count(),
  ]);

  return {
    users,
    drivers,
    trips,
    bookings,
    earnings,
  };
}

// Export du type pour utilisation dans d'autres modules
export type { PrismaClient } from '@prisma/client';