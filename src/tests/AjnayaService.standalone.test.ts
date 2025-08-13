/**
 * Tests autonomes AjnayaService - FOREAS Driver Backend
 * Tests unitaires sans dépendances externes (DB, setup)
 */

import { describe, it, expect } from 'vitest';

// Import direct sans alias path
import { AjnayaService } from '../services/AjnayaService';
import type { TripData, ZoneSnapshot } from '../services/AjnayaService';

describe('AjnayaService - Tests Autonomes', () => {
  // Données de test communes
  const baseTripData: TripData = {
    id: 'trip_test_123',
    netEarnings: 15.50,
    distance: 8.2,
    duration: 45,
    commission: 3.50,
    finalPrice: 19.00,
    startedAt: new Date('2024-01-15T14:30:00Z'),
    completedAt: new Date('2024-01-15T15:15:00Z'),
    platform: 'UBER',
  };

  const mockZoneSnapshot: ZoneSnapshot = {
    city: 'Paris',
    demandScore: 75,
    topZones: [
      { name: 'Centre-ville', demandScore: 85, estimatedWaitTime: 5 },
      { name: 'Gare du Nord', demandScore: 78, estimatedWaitTime: 8 },
      { name: 'Châtelet', demandScore: 82, estimatedWaitTime: 6 },
    ],
  };

  describe('scoreTrip', () => {
    it('donne un bon score à un trajet rentable', () => {
      const excellentTrip: TripData = {
        ...baseTripData,
        netEarnings: 25.00, // 25€
        distance: 10.0, // 10km = 2.5€/km (excellent)
        duration: 60, // 1h = 25€/h (excellent)
        commission: 5.00,
        finalPrice: 30.00, // 16.7% commission (bon)
      };

      const result = AjnayaService.scoreTrip(excellentTrip);

      expect(result.score).toBeGreaterThan(80); // Bon score attendu
      expect(result.reasons.some(r => r.includes('Excellent rapport distance (2.5€/km)'))).toBe(true);
      expect(result.reasons.some(r => r.includes('Excellent rendement horaire (25€/h)'))).toBe(true);
      expect(result.metrics.netPerKm).toBe(2.5);
      expect(result.metrics.netPerHour).toBe(25);
    });

    it('pénalise un trajet peu rentable', () => {
      const poorTrip: TripData = {
        ...baseTripData,
        netEarnings: 8.00, // 8€
        distance: 12.0, // 12km = 0.67€/km (faible)
        duration: 90, // 1.5h = 5.33€/h (très faible)
        commission: 7.00,
        finalPrice: 15.00, // 46.7% commission (élevée)
      };

      const result = AjnayaService.scoreTrip(poorTrip);

      expect(result.score).toBeLessThan(40); // Mauvais score attendu
      expect(result.reasons.some(r => r.includes('Faible rapport distance (0.67€/km)'))).toBe(true);
      expect(result.reasons.some(r => r.includes('Faible rendement horaire (5€/h)'))).toBe(true);
      expect(result.reasons.some(r => r.includes('Commission élevée (46.7%)'))).toBe(true);
      expect(result.metrics.netPerKm).toBe(0.67);
      expect(result.metrics.netPerHour).toBe(5.33);
    });

    it('évalue correctement une course moyenne', () => {
      const averageTrip: TripData = {
        ...baseTripData,
        netEarnings: 15.00, // 15€
        distance: 8.0, // 8km = 1.88€/km (bon)
        duration: 50, // 50min = 18€/h (limite)
        commission: 3.00,
        finalPrice: 18.00, // 16.7% commission (bon)
      };

      const result = AjnayaService.scoreTrip(averageTrip);

      expect(result.score).toBeGreaterThan(50);
      expect(result.score).toBeLessThan(80);
      expect(result.reasons.some(r => r.includes('Bon rapport distance (1.88€/km)'))).toBe(true);
      expect(result.reasons.some(r => r.includes('Bon rendement horaire (18€/h)'))).toBe(true);
    });

    it('gère les divisions par zéro', () => {
      const zeroDistanceTrip: TripData = {
        ...baseTripData,
        distance: 0, // Distance nulle
        duration: 60,
        netEarnings: 15.00,
      };

      const result = AjnayaService.scoreTrip(zeroDistanceTrip);

      expect(result.metrics.netPerKm).toBe(0);
      expect(result.metrics.netPerHour).toBe(15);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });

  describe('computeInsights - Cas ZONE > 70', () => {
    it('génère un insight ZONE quand demandScore > 70', () => {
      const highDemandZone: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 80, // > 70
      };

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: [],
        zoneSnapshot: highDemandZone,
      });

      const zoneInsight = insights.find(i => i.type === 'ZONE');
      expect(zoneInsight).toBeDefined();
      expect(zoneInsight?.priority).toBe('HIGH');
      expect(zoneInsight?.title).toContain('Forte demande');
      expect(zoneInsight?.message).toContain('80%');
      expect(zoneInsight?.data?.cityDemandScore).toBe(80);
      expect(zoneInsight?.data?.recommendedZones).toBeDefined();
      expect(Array.isArray(zoneInsight?.data?.recommendedZones)).toBe(true);
    });

    it('ne génère pas d\'insight ZONE quand demandScore <= 70', () => {
      const lowDemandZone: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 65, // <= 70
      };

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: [],
        zoneSnapshot: lowDemandZone,
      });

      const zoneInsight = insights.find(i => i.type === 'ZONE');
      expect(zoneInsight).toBeUndefined();
    });

    it('filtre les zones avec demandScore < 75', () => {
      const mixedDemandZone: ZoneSnapshot = {
        city: 'Paris',
        demandScore: 80,
        topZones: [
          { name: 'Zone A', demandScore: 90, estimatedWaitTime: 5 }, // Incluse
          { name: 'Zone B', demandScore: 70, estimatedWaitTime: 8 }, // Exclue < 75
          { name: 'Zone C', demandScore: 80, estimatedWaitTime: 6 }, // Incluse
        ],
      };

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: [],
        zoneSnapshot: mixedDemandZone,
      });

      const zoneInsight = insights.find(i => i.type === 'ZONE');
      expect(zoneInsight).toBeDefined();
      expect(zoneInsight?.data?.recommendedZones).toHaveLength(2); // Seulement Zone A et C
      expect(zoneInsight?.message).toContain('Zone A, Zone C');
    });
  });

  describe('computeInsights - Cas PAUSE > 6h', () => {
    it('génère un insight PAUSE quand on-duty > 6h sur 24h', () => {
      // Créer des trajets simulant 7 heures de travail dans les dernières 24h
      const now = new Date();
      const tripsLast7d: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000), // Il y a 2h
          duration: 120, // 2h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000), // Il y a 5h
          duration: 180, // 3h
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 8 * 60 * 60 * 1000), // Il y a 8h
          duration: 120, // 2h
        },
      ];

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pauseInsight = insights.find(i => i.type === 'PAUSE');
      expect(pauseInsight).toBeDefined();
      expect(pauseInsight?.priority).toBe('HIGH');
      expect(pauseInsight?.title).toContain('pause');
      expect(pauseInsight?.message).toContain('7.0h');
      expect(pauseInsight?.data?.totalDutyHours).toBe(7);
      expect(pauseInsight?.data?.maxRecommended).toBe(6);
    });

    it('génère un insight PAUSE critique quand on-duty > 8h', () => {
      const now = new Date();
      const tripsLast7d: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 180, // 3h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 240, // 4h
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
          duration: 180, // 3h
        },
      ];

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pauseInsight = insights.find(i => i.type === 'PAUSE');
      expect(pauseInsight).toBeDefined();
      expect(pauseInsight?.priority).toBe('CRITICAL');
      expect(pauseInsight?.data?.totalDutyHours).toBe(10); // 3+4+3 = 10h
    });

    it('ne génère pas d\'insight PAUSE quand on-duty <= 6h', () => {
      const now = new Date();
      const tripsLast7d: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 120, // 2h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 180, // 3h
        },
      ]; // Total: 5h <= 6h

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pauseInsight = insights.find(i => i.type === 'PAUSE');
      expect(pauseInsight).toBeUndefined();
    });

    it('filtre correctement les trajets des dernières 24h', () => {
      const now = new Date();
      const tripsLast7d: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_recent',
          startedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000), // Il y a 12h (inclus)
          duration: 300, // 5h
        },
        {
          ...baseTripData,
          id: 'trip_old',
          startedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000), // Il y a 30h (exclu)
          duration: 600, // 10h (ne devrait pas compter)
        },
      ];

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pauseInsight = insights.find(i => i.type === 'PAUSE');
      // Seulement 5h dans les dernières 24h, pas d'insight
      expect(pauseInsight).toBeUndefined();
    });
  });

  describe('computeInsights - Cas PRICING < 18€/h', () => {
    it('génère un insight PRICING quand netAmount/h < 18€/h avec 3+ trajets', () => {
      const now = new Date();
      const lowEarningsTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 60, // 1h
          netEarnings: 12.00, // 12€/h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
          duration: 90, // 1.5h
          netEarnings: 20.00, // 13.33€/h
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 120, // 2h
          netEarnings: 30.00, // 15€/h
        },
      ];
      // Moyenne: (12 + 13.33 + 15) / 3 ≈ 13.44€/h < 18€/h

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: lowEarningsTrips,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pricingInsight = insights.find(i => i.type === 'PRICING');
      expect(pricingInsight).toBeDefined();
      expect(pricingInsight?.priority).toBe('MEDIUM');
      expect(pricingInsight?.title).toContain('seuil');
      expect(pricingInsight?.data?.currentNetPerHour).toBeLessThan(18);
      expect(pricingInsight?.data?.targetNetPerHour).toBe(18);
      expect(pricingInsight?.data?.totalTrips).toBe(3);
    });

    it('ne génère pas d\'insight PRICING avec moins de 3 trajets', () => {
      const now = new Date();
      const fewTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 10.00, // Très faible
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 10.00, // Très faible
        },
      ]; // Seulement 2 trajets

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: fewTrips,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pricingInsight = insights.find(i => i.type === 'PRICING');
      expect(pricingInsight).toBeUndefined();
    });

    it('ne génère pas d\'insight PRICING quand netAmount/h >= 18€/h', () => {
      const now = new Date();
      const goodEarningsTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 20.00, // 20€/h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 22.00, // 22€/h
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 25.00, // 25€/h
        },
      ];
      // Moyenne: (20 + 22 + 25) / 3 = 22.33€/h > 18€/h

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: goodEarningsTrips,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pricingInsight = insights.find(i => i.type === 'PRICING');
      expect(pricingInsight).toBeUndefined();
    });

    it('suggère des zones alternatives quand disponibles', () => {
      const now = new Date();
      const lowEarningsTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 10.00, // 10€/h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 12.00, // 12€/h
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 14.00, // 14€/h
        },
      ];

      const zoneWithGoodAreas: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 50, // Pas assez pour ZONE insight
        topZones: [
          { name: 'Zone Active A', demandScore: 70, estimatedWaitTime: 5 },
          { name: 'Zone Active B', demandScore: 65, estimatedWaitTime: 8 },
          { name: 'Zone Calme', demandScore: 40, estimatedWaitTime: 15 },
        ],
      };

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: lowEarningsTrips,
        zoneSnapshot: zoneWithGoodAreas,
      });

      const pricingInsight = insights.find(i => i.type === 'PRICING');
      expect(pricingInsight).toBeDefined();
      expect(pricingInsight?.message).toContain('Zone Active A, Zone Active B');
      expect(pricingInsight?.data?.suggestedZones).toHaveLength(2);
      expect(pricingInsight?.data?.suggestedZones[0].demandScore).toBeGreaterThanOrEqual(60);
    });
  });

  describe('tri des insights par priorité', () => {
    it('trie les insights par priorité (CRITICAL > HIGH > MEDIUM > LOW)', () => {
      const now = new Date();
      const multipleIssuesTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 180, // 3h
          netEarnings: 20.00, // 6.67€/h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 240, // 4h
          netEarnings: 25.00, // 6.25€/h
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
          duration: 300, // 5h
          netEarnings: 30.00, // 6€/h
        },
      ];
      // Total: 12h (> 8h = CRITICAL PAUSE), moyenne: 6.3€/h (< 18€/h = MEDIUM PRICING)

      const highDemandZone: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 85, // > 70 = HIGH ZONE
      };

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: multipleIssuesTrips,
        zoneSnapshot: highDemandZone,
      });

      expect(insights.length).toBe(3);
      
      // Vérifier l'ordre de priorité
      expect(insights[0].priority).toBe('CRITICAL'); // PAUSE en premier
      expect(insights[1].priority).toBe('HIGH');     // ZONE en second
      expect(insights[2].priority).toBe('MEDIUM');   // PRICING en troisième
      
      expect(insights[0].type).toBe('PAUSE');
      expect(insights[1].type).toBe('ZONE');
      expect(insights[2].type).toBe('PRICING');
    });
  });

  describe('getMockZoneSnapshot', () => {
    it('génère un snapshot de zone cohérent', () => {
      const snapshot = AjnayaService.getMockZoneSnapshot('Lyon');

      expect(snapshot.city).toBe('Lyon');
      expect(snapshot.demandScore).toBeGreaterThanOrEqual(40);
      expect(snapshot.demandScore).toBeLessThanOrEqual(80);
      expect(snapshot.topZones).toHaveLength(4);
      
      // Vérifier que les zones sont triées par demande décroissante
      for (let i = 0; i < snapshot.topZones.length - 1; i++) {
        expect(snapshot.topZones[i].demandScore).toBeGreaterThanOrEqual(
          snapshot.topZones[i + 1].demandScore
        );
      }

      // Vérifier la structure des zones
      snapshot.topZones.forEach(zone => {
        expect(zone.name).toBeTruthy();
        expect(zone.demandScore).toBeGreaterThanOrEqual(0);
        expect(zone.demandScore).toBeLessThanOrEqual(100);
        expect(zone.estimatedWaitTime).toBeGreaterThan(0);
      });
    });

    it('génère des données différentes à chaque appel', () => {
      const snapshot1 = AjnayaService.getMockZoneSnapshot('Marseille');
      const snapshot2 = AjnayaService.getMockZoneSnapshot('Marseille');

      // Les données sont aléatoires, donc peuvent être différentes
      expect(snapshot1.city).toBe(snapshot2.city);
      expect(snapshot1.topZones).toHaveLength(4);
      expect(snapshot2.topZones).toHaveLength(4);
    });
  });
});