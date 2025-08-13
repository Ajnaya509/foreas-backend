/**
 * Ajnaya Service - FOREAS Driver Backend
 * Service d'insights intelligents avec règles simples (V1 sans ML)
 */

import { z } from 'zod';

/**
 * Schémas de validation
 */
export const TripDataSchema = z.object({
  id: z.string(),
  netEarnings: z.number(),
  distance: z.number(), // en km
  duration: z.number(), // en minutes
  commission: z.number(),
  finalPrice: z.number(),
  startedAt: z.date(),
  completedAt: z.date().optional(),
  platform: z.string(),
});

export const ZoneSnapshotSchema = z.object({
  city: z.string(),
  demandScore: z.number().min(0).max(100), // Score de demande de 0 à 100
  topZones: z.array(z.object({
    name: z.string(),
    demandScore: z.number().min(0).max(100),
    estimatedWaitTime: z.number(), // en minutes
  })),
});

export const InsightSchema = z.object({
  id: z.string(),
  type: z.enum(['ZONE', 'PAUSE', 'PRICING']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  title: z.string(),
  message: z.string(),
  data: z.record(z.any()).optional(),
  expiresAt: z.date(),
});

export const TripScoreSchema = z.object({
  score: z.number().min(0).max(100),
  reasons: z.array(z.string()),
  metrics: z.object({
    netPerKm: z.number(),
    netPerHour: z.number(),
    commissionRate: z.number(),
  }),
});

export const ComputeInsightsInputSchema = z.object({
  driverId: z.string(),
  city: z.string(),
  tripsLast7d: z.array(TripDataSchema),
  zoneSnapshot: ZoneSnapshotSchema.optional(),
});

// Types TypeScript
export type TripData = z.infer<typeof TripDataSchema>;
export type ZoneSnapshot = z.infer<typeof ZoneSnapshotSchema>;
export type Insight = z.infer<typeof InsightSchema>;
export type TripScore = z.infer<typeof TripScoreSchema>;
export type ComputeInsightsInput = z.infer<typeof ComputeInsightsInputSchema>;

/**
 * Configuration des seuils
 */
const THRESHOLDS = {
  ZONE_DEMAND_MIN: 70, // Seuil de demande pour recommander des zones
  MAX_DUTY_HOURS: 6, // Heures max avant recommander une pause
  MIN_NET_PER_HOUR: 18, // € par heure minimum
  INSIGHT_EXPIRY_HOURS: 24, // Durée de validité des insights en heures
} as const;

/**
 * Service Ajnaya pour la génération d'insights
 */
export class AjnayaService {
  /**
   * Calcule le score d'une course
   */
  static scoreTrip(trip: TripData): TripScore {
    // Calculs de base
    const durationHours = trip.duration / 60;
    const netPerKm = trip.distance > 0 ? trip.netEarnings / trip.distance : 0;
    const netPerHour = durationHours > 0 ? trip.netEarnings / durationHours : 0;
    const commissionRate = trip.finalPrice > 0 ? (trip.commission / trip.finalPrice) * 100 : 0;

    const reasons: string[] = [];
    let score = 50; // Score de base

    // Évaluation du rapport net/km (poids: 40%)
    if (netPerKm >= 2.5) {
      score += 20;
      reasons.push(`Excellent rapport distance (${netPerKm.toFixed(2)}€/km)`);
    } else if (netPerKm >= 1.8) {
      score += 10;
      reasons.push(`Bon rapport distance (${netPerKm.toFixed(2)}€/km)`);
    } else if (netPerKm < 1.2) {
      score -= 15;
      reasons.push(`Faible rapport distance (${netPerKm.toFixed(2)}€/km)`);
    }

    // Évaluation du rapport net/heure (poids: 35%)
    if (netPerHour >= 25) {
      score += 18;
      reasons.push(`Excellent rendement horaire (${netPerHour.toFixed(0)}€/h)`);
    } else if (netPerHour >= 18) {
      score += 8;
      reasons.push(`Bon rendement horaire (${netPerHour.toFixed(0)}€/h)`);
    } else if (netPerHour < 12) {
      score -= 15;
      reasons.push(`Faible rendement horaire (${netPerHour.toFixed(0)}€/h)`);
    }

    // Évaluation de la commission (poids: 15%)
    if (commissionRate <= 15) {
      score += 8;
      reasons.push(`Commission faible (${commissionRate.toFixed(1)}%)`);
    } else if (commissionRate <= 20) {
      score += 3;
      reasons.push(`Commission modérée (${commissionRate.toFixed(1)}%)`);
    } else if (commissionRate > 25) {
      score -= 8;
      reasons.push(`Commission élevée (${commissionRate.toFixed(1)}%)`);
    }

    // Évaluation de la durée (poids: 10%)
    if (trip.duration >= 45 && trip.duration <= 120) {
      score += 5;
      reasons.push(`Durée optimale (${trip.duration}min)`);
    } else if (trip.duration < 20) {
      score -= 5;
      reasons.push(`Course très courte (${trip.duration}min)`);
    } else if (trip.duration > 180) {
      score -= 3;
      reasons.push(`Course très longue (${trip.duration}min)`);
    }

    // S'assurer que le score reste dans la plage 0-100
    score = Math.max(0, Math.min(100, score));

    return {
      score: Math.round(score),
      reasons,
      metrics: {
        netPerKm: Math.round(netPerKm * 100) / 100,
        netPerHour: Math.round(netPerHour * 100) / 100,
        commissionRate: Math.round(commissionRate * 10) / 10,
      },
    };
  }

  /**
   * Calcule les statistiques de travail des dernières 24h
   */
  private static calculateWorkStats(trips: TripData[]): {
    totalDutyHours: number;
    averageNetPerHour: number;
    totalTrips: number;
  } {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTrips = trips.filter(trip => trip.startedAt >= last24h);

    if (recentTrips.length === 0) {
      return { totalDutyHours: 0, averageNetPerHour: 0, totalTrips: 0 };
    }

    const totalDurationMinutes = recentTrips.reduce((sum, trip) => sum + trip.duration, 0);
    const totalDutyHours = totalDurationMinutes / 60;
    const totalNetEarnings = recentTrips.reduce((sum, trip) => sum + trip.netEarnings, 0);
    const averageNetPerHour = totalDutyHours > 0 ? totalNetEarnings / totalDutyHours : 0;

    return {
      totalDutyHours,
      averageNetPerHour,
      totalTrips: recentTrips.length,
    };
  }

  /**
   * Génère des insights basés sur les règles métier
   */
  static computeInsights(input: ComputeInsightsInput): Insight[] {
    // Validation des données d'entrée
    const validatedInput = ComputeInsightsInputSchema.parse(input);
    const { driverId, city, tripsLast7d, zoneSnapshot } = validatedInput;

    const insights: Insight[] = [];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + THRESHOLDS.INSIGHT_EXPIRY_HOURS * 60 * 60 * 1000);

    // Calcul des statistiques de travail
    const workStats = this.calculateWorkStats(tripsLast7d);

    // 1. INSIGHT ZONE : Recommander des zones si demande élevée
    if (zoneSnapshot && zoneSnapshot.demandScore > THRESHOLDS.ZONE_DEMAND_MIN) {
      const topZones = zoneSnapshot.topZones
        .filter(zone => zone.demandScore >= 75)
        .sort((a, b) => b.demandScore - a.demandScore)
        .slice(0, 3);

      if (topZones.length > 0) {
        insights.push({
          id: `zone_${driverId}_${Date.now()}`,
          type: 'ZONE',
          priority: 'HIGH',
          title: `Forte demande à ${city}`,
          message: `La demande est élevée (${zoneSnapshot.demandScore}%) ! Ces zones sont particulièrement actives : ${topZones.map(z => z.name).join(', ')}.`,
          data: {
            cityDemandScore: zoneSnapshot.demandScore,
            recommendedZones: topZones,
          },
          expiresAt,
        });
      }
    }

    // 2. INSIGHT PAUSE : Suggérer une pause si trop d'heures de service
    if (workStats.totalDutyHours > THRESHOLDS.MAX_DUTY_HOURS) {
      const priority = workStats.totalDutyHours > 8 ? 'CRITICAL' : 'HIGH';
      
      insights.push({
        id: `pause_${driverId}_${Date.now()}`,
        type: 'PAUSE',
        priority,
        title: 'Temps de pause recommandé',
        message: `Vous avez travaillé ${workStats.totalDutyHours.toFixed(1)}h ces dernières 24h. Une pause vous permettra de rester performant et en sécurité.`,
        data: {
          totalDutyHours: workStats.totalDutyHours,
          maxRecommended: THRESHOLDS.MAX_DUTY_HOURS,
          totalTrips: workStats.totalTrips,
        },
        expiresAt,
      });
    }

    // 3. INSIGHT PRICING : Conseiller un déplacement si revenus insuffisants
    if (workStats.totalTrips >= 3 && workStats.averageNetPerHour < THRESHOLDS.MIN_NET_PER_HOUR) {
      // Suggérer des zones plus rentables si disponibles
      const betterZones = zoneSnapshot?.topZones.filter(zone => zone.demandScore >= 60) || [];
      
      let message = `Vos revenus sont de ${workStats.averageNetPerHour.toFixed(0)}€/h, en dessous du seuil de ${THRESHOLDS.MIN_NET_PER_HOUR}€/h.`;
      
      if (betterZones.length > 0) {
        message += ` Considérez ces zones plus actives : ${betterZones.slice(0, 2).map(z => z.name).join(', ')}.`;
      } else {
        message += ' Peut-être est-ce le moment de changer de secteur ou de faire une pause ?';
      }

      insights.push({
        id: `pricing_${driverId}_${Date.now()}`,
        type: 'PRICING',
        priority: 'MEDIUM',
        title: 'Revenus en dessous du seuil',
        message,
        data: {
          currentNetPerHour: workStats.averageNetPerHour,
          targetNetPerHour: THRESHOLDS.MIN_NET_PER_HOUR,
          totalTrips: workStats.totalTrips,
          suggestedZones: betterZones.slice(0, 3),
        },
        expiresAt,
      });
    }

    // Trier les insights par priorité (CRITICAL > HIGH > MEDIUM > LOW)
    const priorityOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
    insights.sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority]);

    return insights;
  }

  /**
   * Génère un ZoneSnapshot de démo si aucun n'est fourni
   */
  static getMockZoneSnapshot(city: string): ZoneSnapshot {
    const baseDemand = 40 + Math.floor(Math.random() * 40); // 40-80%
    
    return {
      city,
      demandScore: baseDemand,
      topZones: [
        {
          name: 'Centre-ville',
          demandScore: Math.min(100, baseDemand + 10 + Math.floor(Math.random() * 15)),
          estimatedWaitTime: 5 + Math.floor(Math.random() * 10),
        },
        {
          name: 'Gare',
          demandScore: Math.min(100, baseDemand + 5 + Math.floor(Math.random() * 20)),
          estimatedWaitTime: 3 + Math.floor(Math.random() * 8),
        },
        {
          name: 'Aéroport',
          demandScore: Math.min(100, baseDemand + Math.floor(Math.random() * 25)),
          estimatedWaitTime: 8 + Math.floor(Math.random() * 15),
        },
        {
          name: 'Quartier d\'affaires',
          demandScore: Math.max(30, baseDemand - 5 + Math.floor(Math.random() * 20)),
          estimatedWaitTime: 4 + Math.floor(Math.random() * 12),
        },
      ].sort((a, b) => b.demandScore - a.demandScore),
    };
  }
}