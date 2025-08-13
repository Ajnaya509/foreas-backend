/**
 * Tests minimaux AjnayaService - FOREAS Driver Backend
 * Tests purs sans setup ni dépendances DB
 */

import { describe, it, expect } from 'vitest';
import { AjnayaService } from '../services/AjnayaService';

// Types minimaux pour éviter les imports complexes
interface TripData {
  id: string;
  netEarnings: number;
  distance: number;
  duration: number;
  commission: number;
  finalPrice: number;
  startedAt: Date;
  completedAt?: Date;
  platform: string;
}

interface ZoneSnapshot {
  city: string;
  demandScore: number;
  topZones: Array<{
    name: string;
    demandScore: number;
    estimatedWaitTime: number;
  }>;
}

describe('AjnayaService - Tests Minimaux', () => {
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
    it('calcule un score valide', () => {
      const result = AjnayaService.scoreTrip(baseTripData);
      
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(result.reasons)).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.metrics).toBeDefined();
      expect(result.metrics.netPerKm).toBeGreaterThanOrEqual(0);
      expect(result.metrics.netPerHour).toBeGreaterThanOrEqual(0);
    });

    it('donne un bon score à un trajet excellent', () => {
      const excellentTrip: TripData = {
        ...baseTripData,
        netEarnings: 30.00,
        distance: 10.0,
        duration: 60,
        commission: 5.00,
        finalPrice: 35.00,
      };

      const result = AjnayaService.scoreTrip(excellentTrip);
      expect(result.score).toBeGreaterThan(70);
      expect(result.metrics.netPerKm).toBe(3.0);
      expect(result.metrics.netPerHour).toBe(30);
    });

    it('pénalise un trajet peu rentable', () => {
      const poorTrip: TripData = {
        ...baseTripData,
        netEarnings: 8.00,
        distance: 15.0,
        duration: 120,
        commission: 12.00,
        finalPrice: 20.00,
      };

      const result = AjnayaService.scoreTrip(poorTrip);
      expect(result.score).toBeLessThan(50);
      expect(result.metrics.netPerKm).toBe(0.53);
      expect(result.metrics.netPerHour).toBe(4);
    });
  });

  describe('computeInsights', () => {
    it('génère un insight ZONE pour forte demande', () => {
      const highDemandZone: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 80,
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
      expect(zoneInsight?.message).toContain('80%');
    });

    it('génère un insight PAUSE pour trop d\'heures', () => {
      const now = new Date();
      const longTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 240, // 4h
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 8 * 60 * 60 * 1000),
          duration: 300, // 5h
        },
      ];

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: longTrips,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pauseInsight = insights.find(i => i.type === 'PAUSE');
      expect(pauseInsight).toBeDefined();
      expect(pauseInsight?.priority).toBe('CRITICAL');
    });

    it('génère un insight PRICING pour faibles revenus', () => {
      const now = new Date();
      const lowEarningTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 10.00,
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 12.00,
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 6 * 60 * 60 * 1000),
          duration: 60,
          netEarnings: 14.00,
        },
      ];

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: lowEarningTrips,
        zoneSnapshot: mockZoneSnapshot,
      });

      const pricingInsight = insights.find(i => i.type === 'PRICING');
      expect(pricingInsight).toBeDefined();
      expect(pricingInsight?.priority).toBe('MEDIUM');
      expect(pricingInsight?.data?.currentNetPerHour).toBeLessThan(18);
    });

    it('ne génère pas d\'insights sans conditions', () => {
      const lowDemandZone: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 50, // <= 70
      };

      const goodTrips: TripData[] = [
        {
          ...baseTripData,
          id: 'trip_1',
          duration: 60,
          netEarnings: 25.00, // 25€/h > 18€/h
        },
      ]; // < 3 trajets et < 6h de travail

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: goodTrips,
        zoneSnapshot: lowDemandZone,
      });

      expect(insights).toHaveLength(0);
    });

    it('trie les insights par priorité', () => {
      const now = new Date();
      const multiIssueTrips: TripData[] = [
        // 12h de travail (CRITICAL) + revenus faibles (MEDIUM)
        {
          ...baseTripData,
          id: 'trip_1',
          startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          duration: 240, // 4h
          netEarnings: 20.00,
        },
        {
          ...baseTripData,
          id: 'trip_2',
          startedAt: new Date(now.getTime() - 8 * 60 * 60 * 1000),
          duration: 300, // 5h
          netEarnings: 25.00,
        },
        {
          ...baseTripData,
          id: 'trip_3',
          startedAt: new Date(now.getTime() - 14 * 60 * 60 * 1000),
          duration: 180, // 3h
          netEarnings: 15.00,
        },
      ];

      const highDemandZone: ZoneSnapshot = {
        ...mockZoneSnapshot,
        demandScore: 85, // HIGH ZONE
      };

      const insights = AjnayaService.computeInsights({
        driverId: 'driver_123',
        city: 'Paris',
        tripsLast7d: multiIssueTrips,
        zoneSnapshot: highDemandZone,
      });

      expect(insights.length).toBe(3);
      expect(insights[0].priority).toBe('CRITICAL'); // PAUSE
      expect(insights[1].priority).toBe('HIGH');     // ZONE
      expect(insights[2].priority).toBe('MEDIUM');   // PRICING
    });
  });

  describe('getMockZoneSnapshot', () => {
    it('génère un snapshot valide', () => {
      const snapshot = AjnayaService.getMockZoneSnapshot('Lyon');

      expect(snapshot.city).toBe('Lyon');
      expect(snapshot.demandScore).toBeGreaterThanOrEqual(40);
      expect(snapshot.demandScore).toBeLessThanOrEqual(80);
      expect(snapshot.topZones).toHaveLength(4);

      snapshot.topZones.forEach((zone, index) => {
        expect(zone.name).toBeTruthy();
        expect(zone.demandScore).toBeGreaterThanOrEqual(0);
        expect(zone.demandScore).toBeLessThanOrEqual(100);
        expect(zone.estimatedWaitTime).toBeGreaterThan(0);

        // Vérifier tri par demande décroissante
        if (index > 0) {
          expect(zone.demandScore).toBeLessThanOrEqual(snapshot.topZones[index - 1].demandScore);
        }
      });
    });
  });
});