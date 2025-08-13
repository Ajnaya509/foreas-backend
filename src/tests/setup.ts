/**
 * Configuration des tests FOREAS Driver
 * Setup global avec base de données de test et mocks
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/server/db';
import { logger } from '@/utils/logger';
import { env } from '@/env';

// Mock du logger en mode test
const originalLog = logger.info;
const originalError = logger.error;

beforeAll(async () => {
  // Disable logs in test environment
  logger.info = () => {};
  logger.error = () => {};
  logger.warn = () => {};
  logger.debug = () => {};

  // Vérifier que nous sommes en mode test
  if (env.NODE_ENV !== 'test') {
    throw new Error('Tests doivent être exécutés avec NODE_ENV=test');
  }

  // Setup base de données test
  await prisma.$connect();
  
  // Nettoyer la base au début
  await cleanDatabase();
});

afterAll(async () => {
  // Restaurer les logs
  logger.info = originalLog;
  logger.error = originalError;

  // Nettoyer et fermer la connexion
  await cleanDatabase();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Nettoyer avant chaque test
  await cleanDatabase();
});

afterEach(async () => {
  // Optionnel: nettoyer après chaque test
  // await cleanDatabase();
});

async function cleanDatabase() {
  // Ordre important à cause des clés étrangères
  const tables = [
    'AjnayaFeedback',
    'AjnayaInsight',
    'AggregatedBooking',
    'PlatformStats',
    'DriverPlatformCredentials',
    'Earning',
    'Review',
    'Availability',
    'Booking',
    'Trip', // Updated from Ride to Trip
    'StripeAccount',
    'Driver',
    'Vehicle',
    'Session',
    'User',
    'WebhookEvent', // Added for webhook idempotence
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}";`);
    } catch (error) {
      // Ignorer si la table n'existe pas encore
    }
  }
}

// Utilitaires de test
export const testUtils = {
  async createTestUser(data: Partial<any> = {}) {
    return await prisma.user.create({
      data: {
        email: data.email || `test-${Date.now()}@foreas.app`,
        name: data.name || 'Test User',
        role: data.role || 'DRIVER',
        status: data.status || 'ACTIVE',
        password: data.password || 'test_password_hash',
        ...data,
      },
    });
  },

  async createTestDriver(userId: string, data: Partial<any> = {}) {
    return await prisma.driver.create({
      data: {
        userId,
        licenseNumber: data.licenseNumber || `LIC-${Date.now()}`,
        stripeAccountId: data.stripeAccountId,
        stripeOnboarded: data.stripeOnboarded || false,
        ...data,
      },
    });
  },

  async createTestBooking(driverId: string, clientId: string, data: Partial<any> = {}) {
    return await prisma.booking.create({
      data: {
        driverId,
        clientId,
        pickupAddress: data.pickupAddress || 'Test Pickup Address',
        scheduledFor: data.scheduledFor || new Date(),
        status: data.status || 'PENDING',
        paymentMethod: data.paymentMethod || 'STRIPE',
        ...data,
      },
    });
  },

  async createTestInsight(driverId: string, data: Partial<any> = {}) {
    return await prisma.ajnayaInsight.create({
      data: {
        driverId,
        type: data.type || 'PERFORMANCE',
        priority: data.priority || 'MEDIUM',
        title: data.title || 'Test Insight',
        message: data.message || 'Test message',
        expiresAt: data.expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000),
        ...data,
      },
    });
  },

  async createTestFeedback(driverId: string, recommendationId: string, data: Partial<any> = {}) {
    return await prisma.ajnayaFeedback.create({
      data: {
        driverId,
        recommendationId,
        userAction: data.userAction || 'followed',
        actualOutcome: data.actualOutcome || 1500, // 15€
        satisfactionScore: data.satisfactionScore || 4,
        accuracyScore: data.accuracyScore || 85.5,
        ...data,
      },
    });
  },

  async createTestTrip(driverId: string, data: Partial<any> = {}) {
    return await prisma.trip.create({
      data: {
        driverId,
        platform: data['platform'] || 'UBER',
        pickupAddress: data['pickupAddress'] || 'Test Pickup Address, Paris',
        pickupLat: data['pickupLat'] || 48.8566,
        pickupLng: data['pickupLng'] || 2.3522,
        dropoffAddress: data['dropoffAddress'] || 'Test Dropoff Address, Paris',
        dropoffLat: data['dropoffLat'] || 48.8606,
        dropoffLng: data['dropoffLng'] || 2.3376,
        distance: data['distance'] || 5.0,
        duration: data['duration'] || 30,
        basePrice: data['basePrice'] || 15.00,
        surge: data['surge'] || 1.0,
        finalPrice: data['finalPrice'] || 20.00,
        commission: data['commission'] || 4.00,
        netEarnings: data['netEarnings'] || 16.00,
        status: data['status'] || 'COMPLETED',
        requestedAt: data['requestedAt'] || new Date(),
        acceptedAt: data['acceptedAt'] || new Date(),
        startedAt: data['startedAt'] || new Date(),
        completedAt: data['completedAt'] || new Date(),
        ...data,
      },
    });
  },
};

// Mocks Stripe
export const mockStripe = {
  accounts: {
    create: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
  },
  accountLinks: {
    create: vi.fn(),
  },
  paymentIntents: {
    create: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
  },
  webhooks: {
    constructEvent: vi.fn(),
  },
};

// Mock des services externes
export const mockServices = {
  weather: {
    getCurrentConditions: vi.fn(),
    getForecast: vi.fn(),
  },
  geocoding: {
    geocode: vi.fn(),
    reverseGeocode: vi.fn(),
  },
  mistral: {
    analyze: vi.fn(),
    testConnection: vi.fn(),
  },
};