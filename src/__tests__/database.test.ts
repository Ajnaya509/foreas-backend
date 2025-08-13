/**
 * Test minimal de la base de données
 * Vérifie les opérations CRUD de base pour User et Driver
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Role, UserStatus } from '@prisma/client';

import { env } from '@/env';

// Client de test dédié
const testPrisma = new PrismaClient({
  datasources: {
    db: {
      url: env.DATABASE_URL,
    },
  },
});

describe('Database Operations', () => {
  beforeAll(async () => {
    // S'assurer que nous sommes en mode test
    expect(env.NODE_ENV).toBe('test');
    
    // Nettoyer les données de test avant de commencer
    await cleanupTestData();
  });

  afterAll(async () => {
    // Nettoyer après les tests
    await cleanupTestData();
    await testPrisma.$disconnect();
  });

  describe('User Operations', () => {
    it('should create a user successfully', async () => {
      const userData = {
        email: 'test.driver@foreas.test',
        phone: '+33666666666',
        name: 'Test Driver',
        role: Role.DRIVER,
        status: UserStatus.ACTIVE,
      };

      const user = await testPrisma.user.create({
        data: userData,
      });

      expect(user).toMatchObject({
        email: userData.email,
        phone: userData.phone,
        name: userData.name,
        role: userData.role,
        status: userData.status,
      });
      expect(user.id).toBeDefined();
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
    });

    it('should find user by email', async () => {
      const email = 'test.driver@foreas.test';
      
      const user = await testPrisma.user.findUnique({
        where: { email },
      });

      expect(user).not.toBeNull();
      expect(user?.email).toBe(email);
    });

    it('should enforce unique email constraint', async () => {
      const duplicateUserData = {
        email: 'test.driver@foreas.test', // Email déjà utilisé
        phone: '+33777777777',
        name: 'Another Driver',
        role: Role.DRIVER,
        status: UserStatus.ACTIVE,
      };

      await expect(
        testPrisma.user.create({
          data: duplicateUserData,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Driver Profile Operations', () => {
    it('should create driver profile linked to user', async () => {
      // Récupérer l'utilisateur créé précédemment
      const user = await testPrisma.user.findUnique({
        where: { email: 'test.driver@foreas.test' },
      });

      expect(user).not.toBeNull();

      const driverData = {
        userId: user!.id,
        licenseNumber: 'VTC-TEST-001',
        companyName: 'Test VTC Company',
        siret: '12345678901234',
        stripeOnboarded: false,
        totalRides: 0,
        totalEarnings: 0.0,
        averageRating: 0.0,
      };

      const driver = await testPrisma.driver.create({
        data: driverData,
      });

      expect(driver).toMatchObject({
        userId: user!.id,
        licenseNumber: driverData.licenseNumber,
        companyName: driverData.companyName,
        siret: driverData.siret,
        stripeOnboarded: false,
        totalRides: 0,
        totalEarnings: 0.0,
        averageRating: 0.0,
      });
      expect(driver.id).toBeDefined();
    });

    it('should fetch user with driver profile', async () => {
      const userWithDriver = await testPrisma.user.findUnique({
        where: { email: 'test.driver@foreas.test' },
        include: {
          driver: true,
        },
      });

      expect(userWithDriver).not.toBeNull();
      expect(userWithDriver?.driver).not.toBeNull();
      expect(userWithDriver?.driver?.licenseNumber).toBe('VTC-TEST-001');
      expect(userWithDriver?.driver?.userId).toBe(userWithDriver?.id);
    });

    it('should enforce unique license number constraint', async () => {
      // Créer un autre utilisateur
      const anotherUser = await testPrisma.user.create({
        data: {
          email: 'another.driver@foreas.test',
          phone: '+33888888888',
          name: 'Another Test Driver',
          role: Role.DRIVER,
          status: UserStatus.ACTIVE,
        },
      });

      // Essayer de créer un driver avec le même license number
      const duplicateDriverData = {
        userId: anotherUser.id,
        licenseNumber: 'VTC-TEST-001', // License déjà utilisé
      };

      await expect(
        testPrisma.driver.create({
          data: duplicateDriverData,
        }),
      ).rejects.toThrow();
    });

    it('should enforce one driver per user constraint', async () => {
      const user = await testPrisma.user.findUnique({
        where: { email: 'test.driver@foreas.test' },
      });

      expect(user).not.toBeNull();

      // Essayer de créer un second profil driver pour le même user
      const duplicateDriverData = {
        userId: user!.id, // User déjà lié à un driver
        licenseNumber: 'VTC-TEST-002',
      };

      await expect(
        testPrisma.driver.create({
          data: duplicateDriverData,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Database Connection', () => {
    it('should connect to database successfully', async () => {
      await expect(testPrisma.$queryRaw`SELECT 1`).resolves.not.toThrow();
    });

    it('should handle transactions', async () => {
      const result = await testPrisma.$transaction(async (tx) => {
        const userCount = await tx.user.count();
        return userCount;
      });

      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
    });
  });
});

/**
 * Nettoie les données de test
 */
async function cleanupTestData(): Promise<void> {
  try {
    // Supprimer dans l'ordre correct (relations)
    await testPrisma.driver.deleteMany({
      where: {
        user: {
          email: {
            endsWith: '@foreas.test',
          },
        },
      },
    });

    await testPrisma.user.deleteMany({
      where: {
        email: {
          endsWith: '@foreas.test',
        },
      },
    });
  } catch (error) {
    console.warn('Warning: Could not clean test data:', error);
  }
}