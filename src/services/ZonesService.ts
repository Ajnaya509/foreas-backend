/**
 * Zones Service - FOREAS Driver Backend
 * Service de gestion des zones avec heatmap et cache en base
 */

import { z } from 'zod';
import { prisma } from '@/server/db';

/**
 * Schémas de validation
 */
export const TopZoneSchema = z.object({
  name: z.string(),
  demandScore: z.number().min(0).max(100),
  estimatedWaitTime: z.number().min(0), // en minutes
  bounds: z.object({
    north: z.number(),
    south: z.number(),
    east: z.number(),
    west: z.number(),
  }),
});

export const HeatmapPointSchema = z.object({
  type: z.literal('Feature'),
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]), // [lng, lat]
  }),
  properties: z.object({
    demandScore: z.number().min(0).max(100),
    intensity: z.number().min(0).max(1), // 0.0 à 1.0 pour l'affichage
    zoneName: z.string().optional(),
  }),
});

export const HeatmapRectangleSchema = z.object({
  type: z.literal('Feature'),
  geometry: z.object({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))), // Array of [lng, lat] arrays
  }),
  properties: z.object({
    demandScore: z.number().min(0).max(100),
    intensity: z.number().min(0).max(1),
    zoneName: z.string(),
  }),
});

export const HeatmapSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.union([HeatmapPointSchema, HeatmapRectangleSchema])),
});

export const ZoneSnapshotSchema = z.object({
  id: z.string(),
  city: z.string(),
  demandScore: z.number().min(0).max(100),
  heatmap: HeatmapSchema,
  topZones: z.array(TopZoneSchema),
  validUntil: z.date(),
  createdAt: z.date(),
});

// Types TypeScript
export type TopZone = z.infer<typeof TopZoneSchema>;
export type HeatmapPoint = z.infer<typeof HeatmapPointSchema>;
export type HeatmapRectangle = z.infer<typeof HeatmapRectangleSchema>;
export type Heatmap = z.infer<typeof HeatmapSchema>;
export type ZoneSnapshot = z.infer<typeof ZoneSnapshotSchema>;

/**
 * Configuration
 */
const CACHE_DURATION_MINUTES = 10;

/**
 * Données des villes pour générer des mocks cohérents
 */
const CITY_DATA: Record<string, {
  center: [number, number]; // [lng, lat]
  bounds: { north: number; south: number; east: number; west: number };
  zones: string[];
}> = {
  'Paris': {
    center: [2.3522, 48.8566],
    bounds: { north: 48.9021, south: 48.8155, east: 2.4699, west: 2.2243 },
    zones: ['Centre-ville', 'Gare du Nord', 'Châtelet', 'Montparnasse', 'République', 'Bastille'],
  },
  'Lyon': {
    center: [4.8357, 45.7640],
    bounds: { north: 45.8167, south: 45.7113, east: 4.9357, west: 4.7357 },
    zones: ['Presqu\'île', 'Vieux Lyon', 'Part-Dieu', 'Bellecour', 'Croix-Rousse', 'Perrache'],
  },
  'Marseille': {
    center: [5.3698, 43.2965],
    bounds: { north: 43.3565, south: 43.2365, east: 5.4698, west: 5.2698 },
    zones: ['Vieux-Port', 'Canebière', 'République', 'Castellane', 'Saint-Charles', 'Joliette'],
  },
  'Toulouse': {
    center: [1.4442, 43.6047],
    bounds: { north: 43.6547, south: 43.5547, east: 1.5442, west: 1.3442 },
    zones: ['Capitole', 'Matabiau', 'Jean-Jaurès', 'Compans', 'Wilson', 'Esquirol'],
  },
  'Nice': {
    center: [7.2619, 43.7102],
    bounds: { north: 43.7602, south: 43.6602, east: 7.3619, west: 7.1619 },
    zones: ['Vieux-Nice', 'Promenade', 'Libération', 'Gare', 'Port', 'Acropolis'],
  },
};

/**
 * Service de gestion des zones
 */
export class ZonesService {
  /**
   * Récupère le snapshot actuel pour une ville
   * Utilise le cache DB ou crée un nouveau mock si nécessaire
   */
  static async getCurrent(city: string): Promise<ZoneSnapshot> {
    const now = new Date();

    // Vérifier si un snapshot valide existe en cache
    const existingSnapshot = await prisma.zoneSnapshot.findUnique({
      where: { city },
    });

    if (existingSnapshot && existingSnapshot.validUntil > now) {
      // Cache encore valide, retourner le snapshot existant
      return {
        id: existingSnapshot.id,
        city: existingSnapshot.city,
        demandScore: existingSnapshot.demandScore,
        heatmap: existingSnapshot.heatmapData as Heatmap,
        topZones: existingSnapshot.topZones as TopZone[],
        validUntil: existingSnapshot.validUntil,
        createdAt: existingSnapshot.createdAt,
      };
    }

    // Cache expiré ou inexistant, créer un nouveau snapshot
    const newSnapshot = this.generateMockSnapshot(city);
    const validUntil = new Date(now.getTime() + CACHE_DURATION_MINUTES * 60 * 1000);

    // Persister en base de données
    const savedSnapshot = await prisma.zoneSnapshot.upsert({
      where: { city },
      update: {
        demandScore: newSnapshot.demandScore,
        heatmapData: newSnapshot.heatmap,
        topZones: newSnapshot.topZones,
        validUntil,
        updatedAt: now,
      },
      create: {
        city,
        demandScore: newSnapshot.demandScore,
        heatmapData: newSnapshot.heatmap,
        topZones: newSnapshot.topZones,
        validUntil,
      },
    });

    return {
      id: savedSnapshot.id,
      city: savedSnapshot.city,
      demandScore: savedSnapshot.demandScore,
      heatmap: savedSnapshot.heatmapData as Heatmap,
      topZones: savedSnapshot.topZones as TopZone[],
      validUntil: savedSnapshot.validUntil,
      createdAt: savedSnapshot.createdAt,
    };
  }

  /**
   * Génère un mock cohérent de snapshot pour une ville
   */
  private static generateMockSnapshot(city: string): {
    demandScore: number;
    heatmap: Heatmap;
    topZones: TopZone[];
  } {
    const cityData = CITY_DATA[city] || CITY_DATA['Paris']; // Fallback sur Paris
    const baseDemandScore = 30 + Math.floor(Math.random() * 60); // 30-90

    // Générer les top zones
    const topZones: TopZone[] = cityData.zones
      .slice(0, 3) // Prendre les 3 premières zones
      .map((zoneName, index) => {
        const variance = Math.floor(Math.random() * 20) - 10; // -10 à +10
        const zoneScore = Math.max(0, Math.min(100, baseDemandScore + variance + (3 - index) * 5));
        
        return {
          name: zoneName,
          demandScore: zoneScore,
          estimatedWaitTime: 3 + Math.floor(Math.random() * 15), // 3-18 minutes
          bounds: this.generateZoneBounds(cityData.bounds, index),
        };
      })
      .sort((a, b) => b.demandScore - a.demandScore); // Trier par score décroissant

    // Générer la heatmap avec rectangles et points
    const heatmapFeatures: (HeatmapPoint | HeatmapRectangle)[] = [];

    // Ajouter des rectangles pour les zones principales
    topZones.forEach(zone => {
      const rectangle: HeatmapRectangle = {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [this.boundsToPolygon(zone.bounds)],
        },
        properties: {
          demandScore: zone.demandScore,
          intensity: zone.demandScore / 100,
          zoneName: zone.name,
        },
      };
      heatmapFeatures.push(rectangle);
    });

    // Ajouter des points aléatoires pour plus de détail
    for (let i = 0; i < 15; i++) {
      const lng = cityData.bounds.west + Math.random() * (cityData.bounds.east - cityData.bounds.west);
      const lat = cityData.bounds.south + Math.random() * (cityData.bounds.north - cityData.bounds.south);
      const pointScore = Math.max(10, Math.min(100, baseDemandScore + Math.floor(Math.random() * 40) - 20));

      const point: HeatmapPoint = {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lng, lat],
        },
        properties: {
          demandScore: pointScore,
          intensity: pointScore / 100,
        },
      };
      heatmapFeatures.push(point);
    }

    const heatmap: Heatmap = {
      type: 'FeatureCollection',
      features: heatmapFeatures,
    };

    return {
      demandScore: baseDemandScore,
      heatmap,
      topZones,
    };
  }

  /**
   * Génère des bounds pour une zone dans les limites de la ville
   */
  private static generateZoneBounds(cityBounds: typeof CITY_DATA['Paris']['bounds'], index: number): {
    north: number;
    south: number;
    east: number;
    west: number;
  } {
    const width = (cityBounds.east - cityBounds.west) / 3;
    const height = (cityBounds.north - cityBounds.south) / 3;
    
    const startLng = cityBounds.west + (index % 3) * width;
    const startLat = cityBounds.south + Math.floor(index / 3) * height;
    
    return {
      west: startLng,
      east: startLng + width * 0.8, // Légèrement plus petit pour éviter les chevauchements
      south: startLat,
      north: startLat + height * 0.8,
    };
  }

  /**
   * Convertit des bounds en polygon GeoJSON
   */
  private static boundsToPolygon(bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }): [number, number][] {
    return [
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
      [bounds.east, bounds.north],
      [bounds.west, bounds.north],
      [bounds.west, bounds.south], // Fermer le polygon
    ];
  }

  /**
   * Force l'expiration du cache pour une ville (utile pour les tests)
   */
  static async expireCache(city: string): Promise<void> {
    await prisma.zoneSnapshot.updateMany({
      where: { city },
      data: { validUntil: new Date(Date.now() - 1000) }, // Expire il y a 1 seconde
    });
  }

  /**
   * Nettoie les snapshots expirés (peut être appelé par un cron job)
   */
  static async cleanupExpiredSnapshots(): Promise<number> {
    const result = await prisma.zoneSnapshot.deleteMany({
      where: {
        validUntil: {
          lt: new Date(),
        },
      },
    });
    return result.count;
  }
}