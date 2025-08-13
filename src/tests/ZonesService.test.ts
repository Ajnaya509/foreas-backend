/**
 * Tests d'intégration ZonesService - FOREAS Driver Backend
 * Tests du service avec cache DB et validation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ZonesService } from '@/services/ZonesService';
import { prisma } from '@/server/db';
import { testUtils } from './setup';

describe('ZonesService Integration', () => {
  beforeEach(async () => {
    // Nettoyer les snapshots de zones avant chaque test
    await prisma.zoneSnapshot.deleteMany();
  });

  describe('getCurrent', () => {
    it('crée un nouveau snapshot pour une ville inconnue', async () => {
      const city = 'Paris';
      const snapshot = await ZonesService.getCurrent(city);

      expect(snapshot.id).toBeTruthy();
      expect(snapshot.city).toBe(city);
      expect(snapshot.demandScore).toBeGreaterThanOrEqual(30);
      expect(snapshot.demandScore).toBeLessThanOrEqual(90);

      // Vérifier la structure heatmap
      expect(snapshot.heatmap.type).toBe('FeatureCollection');
      expect(Array.isArray(snapshot.heatmap.features)).toBe(true);
      expect(snapshot.heatmap.features.length).toBeGreaterThan(0);

      // Vérifier les features de la heatmap
      snapshot.heatmap.features.forEach(feature => {
        expect(feature.type).toBe('Feature');
        expect(['Point', 'Polygon']).toContain(feature.geometry.type);
        expect(feature.properties.demandScore).toBeGreaterThanOrEqual(0);
        expect(feature.properties.demandScore).toBeLessThanOrEqual(100);
        expect(feature.properties.intensity).toBeGreaterThanOrEqual(0);
        expect(feature.properties.intensity).toBeLessThanOrEqual(1);
      });

      // Vérifier les top zones
      expect(snapshot.topZones).toHaveLength(3);
      snapshot.topZones.forEach((zone, index) => {
        expect(zone.name).toBeTruthy();
        expect(zone.demandScore).toBeGreaterThanOrEqual(0);
        expect(zone.demandScore).toBeLessThanOrEqual(100);
        expect(zone.estimatedWaitTime).toBeGreaterThan(0);
        expect(zone.bounds).toBeDefined();
        expect(zone.bounds.north).toBeGreaterThan(zone.bounds.south);
        expect(zone.bounds.east).toBeGreaterThan(zone.bounds.west);

        // Vérifier le tri par score décroissant
        if (index > 0) {
          expect(zone.demandScore).toBeLessThanOrEqual(snapshot.topZones[index - 1].demandScore);
        }
      });

      // Vérifier les dates
      expect(snapshot.validUntil).toBeInstanceOf(Date);
      expect(snapshot.createdAt).toBeInstanceOf(Date);
      expect(snapshot.validUntil.getTime()).toBeGreaterThan(Date.now());

      // Vérifier que le snapshot a été persisté en DB
      const dbSnapshot = await prisma.zoneSnapshot.findUnique({
        where: { city },
      });
      expect(dbSnapshot).toBeTruthy();
      expect(dbSnapshot?.id).toBe(snapshot.id);
    });

    it('retourne le même snapshot si le cache est valide', async () => {
      const city = 'Lyon';

      // Premier appel - crée le snapshot
      const firstSnapshot = await ZonesService.getCurrent(city);
      const firstId = firstSnapshot.id;

      // Attendre un moment pour s'assurer qu'un nouveau snapshot aurait un timestamp différent
      await new Promise(resolve => setTimeout(resolve, 100));

      // Deuxième appel - doit retourner le même snapshot du cache
      const secondSnapshot = await ZonesService.getCurrent(city);

      expect(secondSnapshot.id).toBe(firstId);
      expect(secondSnapshot.city).toBe(city);
      expect(secondSnapshot.demandScore).toBe(firstSnapshot.demandScore);
      expect(secondSnapshot.createdAt.getTime()).toBe(firstSnapshot.createdAt.getTime());
      expect(secondSnapshot.validUntil.getTime()).toBe(firstSnapshot.validUntil.getTime());

      // Vérifier que les données sont identiques
      expect(JSON.stringify(secondSnapshot.heatmap)).toBe(JSON.stringify(firstSnapshot.heatmap));
      expect(JSON.stringify(secondSnapshot.topZones)).toBe(JSON.stringify(firstSnapshot.topZones));
    });

    it('crée un nouveau snapshot si le cache a expiré', async () => {
      const city = 'Marseille';

      // Premier appel - crée le snapshot
      const firstSnapshot = await ZonesService.getCurrent(city);
      const firstId = firstSnapshot.id;

      // Forcer l'expiration du cache
      await ZonesService.expireCache(city);

      // Deuxième appel - doit créer un nouveau snapshot
      const secondSnapshot = await ZonesService.getCurrent(city);

      expect(secondSnapshot.id).not.toBe(firstId);
      expect(secondSnapshot.city).toBe(city);
      expect(secondSnapshot.createdAt.getTime()).toBeGreaterThan(firstSnapshot.createdAt.getTime());

      // Les données peuvent être différentes (génération aléatoire)
      // Mais la structure doit être cohérente
      expect(secondSnapshot.heatmap.type).toBe('FeatureCollection');
      expect(secondSnapshot.topZones).toHaveLength(3);
    });

    it('génère des données cohérentes pour différentes villes', async () => {
      const cities = ['Paris', 'Lyon', 'Toulouse', 'Nice', 'Marseille'];
      const snapshots = [];

      for (const city of cities) {
        const snapshot = await ZonesService.getCurrent(city);
        snapshots.push(snapshot);

        expect(snapshot.city).toBe(city);
        expect(snapshot.topZones).toHaveLength(3);
        expect(snapshot.heatmap.features.length).toBeGreaterThan(10); // Au moins rectangles + points
      }

      // Vérifier que chaque ville a des données uniques
      const cities_data = snapshots.map(s => s.city);
      const unique_cities = [...new Set(cities_data)];
      expect(unique_cities).toHaveLength(cities.length);

      // Vérifier que les IDs sont uniques
      const ids = snapshots.map(s => s.id);
      const unique_ids = [...new Set(ids)];
      expect(unique_ids).toHaveLength(snapshots.length);
    });

    it('gère les villes inconnues avec des données par défaut', async () => {
      const unknownCity = 'VilleInconnue';
      const snapshot = await ZonesService.getCurrent(unknownCity);

      expect(snapshot.city).toBe(unknownCity);
      expect(snapshot.demandScore).toBeGreaterThanOrEqual(30);
      expect(snapshot.demandScore).toBeLessThanOrEqual(90);
      expect(snapshot.topZones).toHaveLength(3);
      expect(snapshot.heatmap.features.length).toBeGreaterThan(0);

      // Doit utiliser les données par défaut de Paris
      // Les noms de zones devraient être ceux de Paris
      const expectedParisZones = ['Centre-ville', 'Gare du Nord', 'Châtelet'];
      const actualZoneNames = snapshot.topZones.map(z => z.name);
      expectedParisZones.forEach(expectedZone => {
        expect(actualZoneNames).toContain(expectedZone);
      });
    });

    it('maintient la cohérence des bounds pour les zones', async () => {
      const snapshot = await ZonesService.getCurrent('Paris');

      snapshot.topZones.forEach(zone => {
        // Vérifier que les bounds sont cohérents
        expect(zone.bounds.north).toBeGreaterThan(zone.bounds.south);
        expect(zone.bounds.east).toBeGreaterThan(zone.bounds.west);

        // Vérifier que les bounds sont dans une plage raisonnable pour Paris
        expect(zone.bounds.north).toBeGreaterThan(48.8);
        expect(zone.bounds.north).toBeLessThan(48.91);
        expect(zone.bounds.south).toBeGreaterThan(48.81);
        expect(zone.bounds.south).toBeLessThan(48.9);
        expect(zone.bounds.east).toBeGreaterThan(2.2);
        expect(zone.bounds.east).toBeLessThan(2.5);
        expect(zone.bounds.west).toBeGreaterThan(2.2);
        expect(zone.bounds.west).toBeLessThan(2.5);
      });
    });

    it('génère des features heatmap valides', async () => {
      const snapshot = await ZonesService.getCurrent('Toulouse');

      // Vérifier les rectangles (zones)
      const rectangles = snapshot.heatmap.features.filter(f => f.geometry.type === 'Polygon');
      expect(rectangles.length).toBe(3); // Une pour chaque top zone

      rectangles.forEach(rect => {
        expect(rect.properties.zoneName).toBeTruthy();
        expect(rect.geometry.coordinates).toHaveLength(1); // Un seul ring
        expect(rect.geometry.coordinates[0]).toHaveLength(5); // 4 coins + fermeture
        
        // Vérifier que le polygon est fermé
        const coords = rect.geometry.coordinates[0];
        expect(coords[0]).toEqual(coords[4]);
      });

      // Vérifier les points
      const points = snapshot.heatmap.features.filter(f => f.geometry.type === 'Point');
      expect(points.length).toBe(15); // 15 points aléatoires

      points.forEach(point => {
        expect(point.geometry.coordinates).toHaveLength(2); // [lng, lat]
        const [lng, lat] = point.geometry.coordinates;
        expect(typeof lng).toBe('number');
        expect(typeof lat).toBe('number');
        expect(lng).toBeGreaterThan(-180);
        expect(lng).toBeLessThan(180);
        expect(lat).toBeGreaterThan(-90);
        expect(lat).toBeLessThan(90);
      });
    });
  });

  describe('expireCache', () => {
    it('force l\'expiration d\'un snapshot existant', async () => {
      const city = 'Nice';

      // Créer un snapshot
      const snapshot = await ZonesService.getCurrent(city);
      expect(snapshot.validUntil.getTime()).toBeGreaterThan(Date.now());

      // Forcer l'expiration
      await ZonesService.expireCache(city);

      // Vérifier que le snapshot est expiré en DB
      const expiredSnapshot = await prisma.zoneSnapshot.findUnique({
        where: { city },
      });
      expect(expiredSnapshot?.validUntil.getTime()).toBeLessThan(Date.now());

      // Un nouvel appel doit créer un nouveau snapshot
      const newSnapshot = await ZonesService.getCurrent(city);
      expect(newSnapshot.id).not.toBe(snapshot.id);
    });

    it('ne fait rien pour une ville sans snapshot', async () => {
      // Expirer le cache d'une ville qui n'existe pas
      await expect(ZonesService.expireCache('VilleInexistante')).resolves.not.toThrow();

      // Vérifier qu'aucun snapshot n'a été créé
      const snapshot = await prisma.zoneSnapshot.findUnique({
        where: { city: 'VilleInexistante' },
      });
      expect(snapshot).toBeNull();
    });
  });

  describe('cleanupExpiredSnapshots', () => {
    it('supprime les snapshots expirés', async () => {
      // Créer plusieurs snapshots
      await ZonesService.getCurrent('Paris');
      await ZonesService.getCurrent('Lyon');
      await ZonesService.getCurrent('Marseille');

      // Vérifier qu'ils existent
      let count = await prisma.zoneSnapshot.count();
      expect(count).toBe(3);

      // Forcer l'expiration de 2 snapshots
      await ZonesService.expireCache('Paris');
      await ZonesService.expireCache('Lyon');

      // Nettoyer les snapshots expirés
      const deletedCount = await ZonesService.cleanupExpiredSnapshots();
      expect(deletedCount).toBe(2);

      // Vérifier qu'il ne reste que 1 snapshot
      count = await prisma.zoneSnapshot.count();
      expect(count).toBe(1);

      const remaining = await prisma.zoneSnapshot.findFirst();
      expect(remaining?.city).toBe('Marseille');
    });

    it('ne supprime rien si aucun snapshot n\'est expiré', async () => {
      // Créer des snapshots valides
      await ZonesService.getCurrent('Paris');
      await ZonesService.getCurrent('Lyon');

      const deletedCount = await ZonesService.cleanupExpiredSnapshots();
      expect(deletedCount).toBe(0);

      // Vérifier que tous les snapshots sont toujours là
      const count = await prisma.zoneSnapshot.count();
      expect(count).toBe(2);
    });
  });
});