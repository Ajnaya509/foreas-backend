/**
 * Tests d'intégration Router Zones - FOREAS Driver Backend
 * Tests du router tRPC zones avec validation du cache
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

import { appRouter } from '@/server/routers';
import { prisma } from '@/server/db';
import { ZonesService } from '@/services/ZonesService';
import { testUtils } from './setup';
import type { Context } from '@/server/context';

// Mock pour les tests
const mockContext: Context = {
  userId: undefined,
};

describe('Zones Router Integration', () => {
  let testUser: any;
  let caller: any;

  beforeEach(async () => {
    // Nettoyer les snapshots avant chaque test
    await prisma.zoneSnapshot.deleteMany();

    // Créer un utilisateur de test
    testUser = await testUtils.createTestUser({
      email: 'driver@foreas.app',
      name: 'Test Driver',
      role: 'DRIVER',
    });

    // Créer le caller tRPC authentifié
    caller = appRouter.createCaller({
      ...mockContext,
      userId: testUser.id,
    });
  });

  describe('current()', () => {
    it('crée et retourne un nouveau snapshot pour une ville', async () => {
      const city = 'Paris';
      const result = await caller.zones.current({ city });

      expect(result.id).toBeTruthy();
      expect(result.city).toBe(city);
      expect(result.demandScore).toBeGreaterThanOrEqual(30);
      expect(result.demandScore).toBeLessThanOrEqual(90);
      expect(result.cached).toBe(false); // Premier appel = nouveau snapshot

      // Vérifier la structure heatmap
      expect(result.heatmap.type).toBe('FeatureCollection');
      expect(Array.isArray(result.heatmap.features)).toBe(true);
      expect(result.heatmap.features.length).toBeGreaterThan(0);

      // Vérifier les top zones
      expect(result.topZones).toHaveLength(3);
      result.topZones.forEach((zone, index) => {
        expect(zone.name).toBeTruthy();
        expect(zone.demandScore).toBeGreaterThanOrEqual(0);
        expect(zone.demandScore).toBeLessThanOrEqual(100);
        expect(zone.estimatedWaitTime).toBeGreaterThan(0);
        expect(zone.bounds).toBeDefined();

        // Vérifier le tri par score décroissant
        if (index > 0) {
          expect(zone.demandScore).toBeLessThanOrEqual(result.topZones[index - 1].demandScore);
        }
      });

      // Vérifier les timestamps
      expect(result.validUntil).toBeInstanceOf(Date);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.validUntil.getTime()).toBeGreaterThan(Date.now());
    });

    it('retourne le même snapshot du cache lors d\'appels successifs', async () => {
      const city = 'Lyon';

      // Premier appel
      const firstResult = await caller.zones.current({ city });
      expect(firstResult.cached).toBe(false);

      // Attendre un moment pour s'assurer du timestamp
      await new Promise(resolve => setTimeout(resolve, 1100)); // 1.1 secondes

      // Deuxième appel dans la fenêtre de cache
      const secondResult = await caller.zones.current({ city });

      // Doit retourner le même snapshot
      expect(secondResult.id).toBe(firstResult.id);
      expect(secondResult.city).toBe(city);
      expect(secondResult.demandScore).toBe(firstResult.demandScore);
      expect(secondResult.cached).toBe(true); // Maintenant c'est du cache
      expect(secondResult.createdAt.getTime()).toBe(firstResult.createdAt.getTime());
      expect(secondResult.validUntil.getTime()).toBe(firstResult.validUntil.getTime());

      // Les données doivent être identiques
      expect(JSON.stringify(secondResult.heatmap)).toBe(JSON.stringify(firstResult.heatmap));
      expect(JSON.stringify(secondResult.topZones)).toBe(JSON.stringify(firstResult.topZones));
    });

    it('crée un nouveau snapshot après expiration du cache', async () => {
      const city = 'Marseille';

      // Premier appel
      const firstResult = await caller.zones.current({ city });
      const firstId = firstResult.id;

      // Forcer l'expiration du cache
      await ZonesService.expireCache(city);

      // Deuxième appel après expiration
      const secondResult = await caller.zones.current({ city });

      // Doit être un nouveau snapshot
      expect(secondResult.id).not.toBe(firstId);
      expect(secondResult.city).toBe(city);
      expect(secondResult.cached).toBe(false); // Nouveau snapshot
      expect(secondResult.createdAt.getTime()).toBeGreaterThan(firstResult.createdAt.getTime());

      // Structure doit être cohérente mais données peuvent différer
      expect(secondResult.heatmap.type).toBe('FeatureCollection');
      expect(secondResult.topZones).toHaveLength(3);
    });

    it('gère plusieurs villes simultanément', async () => {
      const cities = ['Paris', 'Lyon', 'Toulouse'];
      const results: any[] = [];

      // Appels parallèles pour différentes villes
      const promises = cities.map(city => 
        caller.zones.current({ city })
      );
      const snapshots = await Promise.all(promises);

      snapshots.forEach((result, index) => {
        expect(result.city).toBe(cities[index]);
        expect(result.cached).toBe(false); // Premier appel pour chaque ville
        results.push(result);
      });

      // Vérifier que chaque ville a des données uniques
      const ids = results.map(r => r.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds).toHaveLength(cities.length);

      // Vérifier en DB
      const dbCount = await prisma.zoneSnapshot.count();
      expect(dbCount).toBe(cities.length);
    });

    it('valide l\'entrée city', async () => {
      // Test avec city vide
      await expect(
        caller.zones.current({ city: '' })
      ).rejects.toThrow('Le nom de la ville ne peut pas être vide');

      // Test avec city null/undefined (sera rejeté par Zod)
      await expect(
        caller.zones.current({})
      ).rejects.toThrow();

      // Test avec espaces seulement
      await expect(
        caller.zones.current({ city: '   ' })
      ).rejects.toThrow('Le nom de la ville ne peut pas être vide');
    });

    it('trim les espaces dans le nom de ville', async () => {
      const cityWithSpaces = '  Nice  ';
      const expectedCity = 'Nice';

      const result = await caller.zones.current({ city: cityWithSpaces });

      expect(result.city).toBe(expectedCity);

      // Vérifier en DB que c'est sauvé sans espaces
      const dbSnapshot = await prisma.zoneSnapshot.findUnique({
        where: { city: expectedCity },
      });
      expect(dbSnapshot).toBeTruthy();
      expect(dbSnapshot?.city).toBe(expectedCity);
    });

    it('génère des features heatmap GeoJSON valides', async () => {
      const result = await caller.zones.current({ city: 'Bordeaux' });

      // Vérifier la structure GeoJSON
      expect(result.heatmap.type).toBe('FeatureCollection');
      expect(Array.isArray(result.heatmap.features)).toBe(true);

      result.heatmap.features.forEach(feature => {
        expect(feature.type).toBe('Feature');
        expect(feature.geometry).toBeDefined();
        expect(feature.properties).toBeDefined();

        // Vérifier les propriétés communes
        expect(feature.properties.demandScore).toBeGreaterThanOrEqual(0);
        expect(feature.properties.demandScore).toBeLessThanOrEqual(100);
        expect(feature.properties.intensity).toBeGreaterThanOrEqual(0);
        expect(feature.properties.intensity).toBeLessThanOrEqual(1);

        if (feature.geometry.type === 'Point') {
          expect(feature.geometry.coordinates).toHaveLength(2);
          const [lng, lat] = feature.geometry.coordinates;
          expect(typeof lng).toBe('number');
          expect(typeof lat).toBe('number');
        } else if (feature.geometry.type === 'Polygon') {
          expect(feature.properties.zoneName).toBeTruthy();
          expect(Array.isArray(feature.geometry.coordinates)).toBe(true);
          expect(feature.geometry.coordinates[0]).toHaveLength(5); // Rectangle fermé
        }
      });
    });

    it('respecte la durée de cache de 10 minutes', async () => {
      const city = 'Nantes';

      // Premier appel
      const firstResult = await caller.zones.current({ city });
      const validUntil = new Date(firstResult.validUntil);
      const createdAt = new Date(firstResult.createdAt);

      // Vérifier que validUntil est environ 10 minutes après createdAt
      const diffMinutes = (validUntil.getTime() - createdAt.getTime()) / (1000 * 60);
      expect(diffMinutes).toBeGreaterThan(9.5);
      expect(diffMinutes).toBeLessThan(10.5);
    });

    it('lève une erreur pour un utilisateur non authentifié', async () => {
      const unauthenticatedCaller = appRouter.createCaller(mockContext);

      await expect(
        unauthenticatedCaller.zones.current({ city: 'Paris' })
      ).rejects.toThrow('UNAUTHORIZED');
    });

    it('gère les erreurs de service gracieusement', async () => {
      // Mock temporaire pour forcer une erreur
      const originalGetCurrent = ZonesService.getCurrent;
      ZonesService.getCurrent = vi.fn().mockRejectedValue(new Error('Service error'));

      await expect(
        caller.zones.current({ city: 'Paris' })
      ).rejects.toThrow('Erreur lors de la récupération des données de zone pour Paris');

      // Restaurer la méthode originale
      ZonesService.getCurrent = originalGetCurrent;
    });

    it('génère des bounds cohérents pour les zones de Paris', async () => {
      const result = await caller.zones.current({ city: 'Paris' });

      result.topZones.forEach(zone => {
        // Vérifier que les bounds sont dans Paris (approximativement)
        expect(zone.bounds.north).toBeGreaterThan(48.8);
        expect(zone.bounds.north).toBeLessThan(48.91);
        expect(zone.bounds.south).toBeGreaterThan(48.81);
        expect(zone.bounds.south).toBeLessThan(48.9);
        expect(zone.bounds.east).toBeGreaterThan(2.2);
        expect(zone.bounds.east).toBeLessThan(2.5);
        expect(zone.bounds.west).toBeGreaterThan(2.2);
        expect(zone.bounds.west).toBeLessThan(2.5);

        // Vérifier la cohérence des bounds
        expect(zone.bounds.north).toBeGreaterThan(zone.bounds.south);
        expect(zone.bounds.east).toBeGreaterThan(zone.bounds.west);
      });
    });

    it('produit des données JSON sérialisables', async () => {
      const result = await caller.zones.current({ city: 'Montpellier' });

      // Vérifier que tout peut être sérialisé en JSON
      expect(() => JSON.stringify(result)).not.toThrow();

      const jsonString = JSON.stringify(result);
      const parsed = JSON.parse(jsonString);

      expect(parsed.id).toBe(result.id);
      expect(parsed.city).toBe(result.city);
      expect(parsed.demandScore).toBe(result.demandScore);
      expect(parsed.heatmap.type).toBe('FeatureCollection');
      expect(parsed.topZones).toHaveLength(3);
    });
  });
});