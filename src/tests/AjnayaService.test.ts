/**
 * Tests unitaires AjnayaService - FOREAS Driver Backend
 * Tests des règles simples pour les insights V1
 */

import { describe, it, expect } from 'vitest';
import { AjnayaService, TripData, ZoneSnapshot } from '@/services/AjnayaService';

describe('AjnayaService', () => {
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
      expect(result.reasons).toContain('Excellent rapport distance (2.5€/km)');
      expect(result.reasons).toContain('Excellent rendement horaire (25€/h)');
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
      expect(result.reasons).toContain('Faible rapport distance (0.67€/km)');
      expect(result.reasons).toContain('Faible rendement horaire (5€/h)');
      expect(result.reasons).toContain('Commission élevée (46.7%)');
      expect(result.metrics.netPerKm).toBe(0.67);
      expect(result.metrics.netPerHour).toBe(5.33);
    });

    it('évalue correctement une course moyenne', () => {
      const averageTrip: TripData = {
        ...baseTripData,
        netEarnings: 15.00, // 15€
        distance: 8.0, // 8km = 1.88€/km (moyen)
        duration: 50, // 50min = 18€/h (limite)
        commission: 3.00,
        finalPrice: 18.00, // 16.7% commission (bon)
      };

      const result = AjnayaService.scoreTrip(averageTrip);

      expect(result.score).toBeGreaterThan(50);
      expect(result.score).toBeLessThan(80);
      expect(result.reasons).toContain('Bon rapport distance (1.88€/km)');
      expect(result.reasons).toContain('Bon rendement horaire (18€/h)');
    });

    it('pénalise les courses très courtes et très longues', () => {
      // Course très courte
      const shortTrip: TripData = {
        ...baseTripData,
        duration: 15, // 15 minutes
        netEarnings: 8.00,
        distance: 2.0,
      };

      const shortResult = AjnayaService.scoreTrip(shortTrip);
      expect(shortResult.reasons).toContain('Course très courte (15min)');

      // Course très longue  
      const longTrip: TripData = {
        ...baseTripData,
        duration: 200, // 3h20
        netEarnings: 30.00,
        distance: 15.0,
      };

      const longResult = AjnayaService.scoreTrip(longTrip);
      expect(longResult.reasons).toContain('Course très longue (200min)');
    });

    it('valorise les courses de durée optimale', () => {
      const optimalTrip: TripData = {
        ...baseTripData,
        duration: 60, // 1h (optimal)
        netEarnings: 20.00,
        distance: 8.0,
      };

      const result = AjnayaService.scoreTrip(optimalTrip);
      expect(result.reasons).toContain('Durée optimale (60min)');
    });
  });

  describe('computeInsights', () => {
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

    it('génère un insight PAUSE quand on-duty > 6h sur 24h', () => {
      // Créer des trajets simulant 7 heures de travail
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
    });

    it('génère un insight PAUSE critique quand on-duty > 8h', () => {
      // Créer des trajets simulant 9 heures de travail
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
      expect(pauseInsight?.priority).toBe('CRITICAL');
      expect(pauseInsight?.data?.totalDutyHours).toBe(9);
    });

    it('ne génère pas d\'insight PAUSE quand on-duty <= 6h', () => {
      // Créer des trajets simulant 5 heures de travail
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
      ];

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pauseInsight = insights.find(i => i.type === 'PAUSE');
      expect(pauseInsight).toBeUndefined();
    });

    it('génère un insight PRICING quand netAmount/h < 18€/h avec 3+ trajets', () => {
      // Créer des trajets avec un faible rendement horaire
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
      // Moyenne: (12 + 13.33 + 15) / 3 = 13.44€/h < 18€/h

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
      expect(pricingInsight?.message).toContain('13€/h'); // Arrondi
      expect(pricingInsight?.data?.currentNetPerHour).toBeLessThan(18);
      expect(pricingInsight?.data?.targetNetPerHour).toBe(18);
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

    it('trie les insights par priorité (CRITICAL > HIGH > MEDIUM > LOW)', () => {
      // Créer une situation qui génère plusieurs insights
      const now = new Date();
      const multipleIssuesTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 180, // 3h
          netEarnings: 20.00, // 6.67€/h (très faible)
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 240, // 4h
          netEarnings: 25.00, // 6.25€/h (très faible)
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
          duration: 180, // 3h
          netEarnings: 18.00, // 6€/h (très faible)
        },
      ];
      // Total: 10h (> 8h = CRITICAL PAUSE), moyenne: 6.3€/h (< 18€/h = MEDIUM PRICING)

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
  });
});