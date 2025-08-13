/**
 * Booking Recommendation Engine - FOREAS Ajnaya AI
 * 
 * Moteur de recommandations intelligent pour optimiser l'acceptation des courses
 * Intègre l'analyse comportementale et les prédictions de gains
 */

import { driverBehaviorAnalyzer, DriverBehaviorAnalysis } from './DriverBehaviorAnalyzer';
import { BookingRequest, DriverContext } from '../platforms/PlatformManager';
import { Platform } from '@prisma/client';

export interface BookingRecommendation {
  booking: BookingRequest;
  shouldAccept: boolean;
  confidence: number; // 0-100
  foreacScore: number; // 0-100
  expectedCommission: number;
  profitabilityScore: number;
  reasoning: string;
  alternativeSuggestions: string[];
  ajnayaInsight: {
    type: 'OPPORTUNITY' | 'WARNING' | 'INFO';
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    title: string;
    message: string;
    actionable: boolean;
    actions?: string[];
  };
}

export class BookingRecommendationEngine {
  /**
   * Analyser une réservation et générer des recommandations
   */
  async analyzeBooking(
    booking: BookingRequest,
    driverContext: DriverContext,
    behaviorAnalysis?: DriverBehaviorAnalysis
  ): Promise<BookingRecommendation> {
    console.log(`🎯 Ajnaya analyzing booking ${booking.id} from ${booking.platform}`);

    // Si pas d'analyse comportementale fournie, en créer une basique
    if (!behaviorAnalysis) {
      behaviorAnalysis = await this.getBasicBehaviorAnalysis(driverContext);
    }

    // Calculs de base
    const profitabilityScore = this.calculateProfitability(booking, driverContext);
    const foreacScore = this.calculateForeacScore(booking, driverContext, behaviorAnalysis);
    const expectedCommission = this.calculateExpectedCommission(booking);
    
    // Décision d'acceptation
    const shouldAccept = this.shouldAcceptBooking(booking, foreacScore, profitabilityScore, behaviorAnalysis);
    const confidence = this.calculateConfidence(booking, driverContext, behaviorAnalysis);
    
    // Génération du raisonnement
    const reasoning = this.generateReasoning(booking, foreacScore, profitabilityScore, behaviorAnalysis);
    const alternativeSuggestions = this.generateAlternativeSuggestions(booking, behaviorAnalysis);
    
    // Insight Ajnaya
    const ajnayaInsight = this.generateAjnayaInsight(booking, foreacScore, shouldAccept, behaviorAnalysis);

    return {
      booking,
      shouldAccept,
      confidence,
      foreacScore,
      expectedCommission,
      profitabilityScore,
      reasoning,
      alternativeSuggestions,
      ajnayaInsight,
    };
  }

  /**
   * Calcul du score FOREAS pour une réservation
   */
  private calculateForeacScore(
    booking: BookingRequest,
    driverContext: DriverContext,
    behaviorAnalysis: DriverBehaviorAnalysis
  ): number {
    let score = 50; // Score de base

    // Bonus plateforme FOREAS Direct (commission réduite)
    if (booking.platform === Platform.FOREAS_DIRECT) {
      score += 25;
    }

    // Score basé sur la valeur de la course
    const fareEuros = booking.estimatedFare / 100;
    if (fareEuros > 30) score += 15;
    else if (fareEuros > 15) score += 10;
    else if (fareEuros < 8) score -= 10;

    // Score basé sur la distance
    if (booking.distance < 2) score -= 10; // Courses très courtes
    else if (booking.distance > 3 && booking.distance < 15) score += 10; // Distance optimale
    else if (booking.distance > 25) score -= 5; // Courses très longues

    // Score basé sur l'urgence
    switch (booking.urgency) {
      case 'high':
        score += 10;
        break;
      case 'medium':
        score += 5;
        break;
      case 'low':
        score -= 5;
        break;
    }

    // Score basé sur la note du client
    if (booking.clientInfo.rating) {
      if (booking.clientInfo.rating >= 4.8) score += 10;
      else if (booking.clientInfo.rating >= 4.5) score += 5;
      else if (booking.clientInfo.rating < 4.0) score -= 15;
    }

    // Bonus basé sur l'analyse comportementale
    if (behaviorAnalysis.currentScore > 80) {
      score += 10; // Conditions très favorables
    } else if (behaviorAnalysis.currentScore < 40) {
      score -= 10; // Conditions défavorables
    }

    // Bonus si dans une zone recommandée
    const isInRecommendedZone = behaviorAnalysis.topRecommendedZones.some(zone => {
      const distance = this.calculateDistance(
        booking.pickup.lat, booking.pickup.lng,
        zone.lat, zone.lng
      );
      return distance < 1; // Dans un rayon de 1km
    });

    if (isInRecommendedZone) {
      score += 15;
    }

    // Clamp entre 0 et 100
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Calcul de la rentabilité
   */
  private calculateProfitability(booking: BookingRequest, driverContext: DriverContext): number {
    const grossRevenue = booking.estimatedFare;
    const commission = this.calculateExpectedCommission(booking);
    const netRevenue = grossRevenue - commission;
    
    // Coûts estimés (carburant, usure)
    const fuelCost = booking.distance * 0.08 * 100; // 8 centimes par km
    const wearCost = booking.distance * 0.07 * 100; // 7 centimes par km
    const totalCosts = fuelCost + wearCost;
    
    const profit = netRevenue - totalCosts;
    const profitMargin = (profit / grossRevenue) * 100;
    
    // Score de 0 à 100
    return Math.max(0, Math.min(100, Math.round(profitMargin + 50)));
  }

  /**
   * Calcul de la commission attendue
   */
  private calculateExpectedCommission(booking: BookingRequest): number {
    const fare = booking.estimatedFare;
    
    switch (booking.platform) {
      case Platform.FOREAS_DIRECT:
        return Math.round(fare * 0.10); // 10% moyenne pour FOREAS
      case Platform.UBER:
        return Math.round(fare * 0.25); // 25% pour Uber
      case Platform.BOLT:
        return Math.round(fare * 0.20); // 20% pour Bolt
      case Platform.HEETCH:
        return Math.round(fare * 0.25); // 25% pour Heetch
      case Platform.MARCEL:
        return Math.round(fare * 0.18); // 18% pour Marcel
      default:
        return Math.round(fare * 0.22); // 22% par défaut
    }
  }

  /**
   * Décision d'acceptation
   */
  private shouldAcceptBooking(
    booking: BookingRequest,
    foreacScore: number,
    profitabilityScore: number,
    behaviorAnalysis: DriverBehaviorAnalysis
  ): boolean {
    // Seuils de décision adaptatifs
    let acceptanceThreshold = 65;

    // Ajuster selon les conditions actuelles
    if (behaviorAnalysis.currentScore > 80) {
      acceptanceThreshold = 70; // Plus sélectif en bonnes conditions
    } else if (behaviorAnalysis.currentScore < 40) {
      acceptanceThreshold = 55; // Moins sélectif en mauvaises conditions
    }

    // FOREAS Direct privilégié
    if (booking.platform === Platform.FOREAS_DIRECT) {
      acceptanceThreshold -= 10;
    }

    // Courses très rentables
    if (profitabilityScore > 85) {
      return true;
    }

    // Courses peu rentables
    if (profitabilityScore < 30) {
      return false;
    }

    return foreacScore >= acceptanceThreshold;
  }

  /**
   * Calcul de la confiance
   */
  private calculateConfidence(
    booking: BookingRequest,
    driverContext: DriverContext,
    behaviorAnalysis: DriverBehaviorAnalysis
  ): number {
    let confidence = 70; // Base

    // Plus de confiance avec plus de données historiques
    if (driverContext.stats.totalRides > 100) confidence += 10;
    if (driverContext.stats.totalRides > 500) confidence += 5;

    // Plus de confiance pour FOREAS Direct (données internes)
    if (booking.platform === Platform.FOREAS_DIRECT) confidence += 10;

    // Moins de confiance pour courses inhabituelles
    if (booking.estimatedFare > 8000) confidence -= 15; // Courses > 80€
    if (booking.distance > 30) confidence -= 10; // Courses > 30km

    // Confiance basée sur l'analyse comportementale
    if (behaviorAnalysis.optimalStrategy.confidence > 80) confidence += 10;

    return Math.max(50, Math.min(95, confidence));
  }

  /**
   * Génération du raisonnement
   */
  private generateReasoning(
    booking: BookingRequest,
    foreacScore: number,
    profitabilityScore: number,
    behaviorAnalysis: DriverBehaviorAnalysis
  ): string {
    const reasons = [];
    const fare = booking.estimatedFare / 100;

    // Raison principale
    if (foreacScore >= 80) {
      reasons.push(`Excellente opportunité (score ${foreacScore}/100)`);
    } else if (foreacScore >= 60) {
      reasons.push(`Bonne opportunité (score ${foreacScore}/100)`);
    } else {
      reasons.push(`Opportunité limitée (score ${foreacScore}/100)`);
    }

    // Plateforme
    if (booking.platform === Platform.FOREAS_DIRECT) {
      reasons.push('Réservation directe FOREAS (commission réduite 5-15%)');
    } else {
      const commissionRate = this.getCommissionRate(booking.platform);
      reasons.push(`Plateforme ${booking.platform} (commission ${commissionRate}%)`);
    }

    // Valeur
    if (fare > 25) {
      reasons.push(`Course de haute valeur (${fare.toFixed(2)}€)`);
    } else if (fare < 10) {
      reasons.push(`Course de faible valeur (${fare.toFixed(2)}€)`);
    }

    // Distance
    if (booking.distance < 3) {
      reasons.push('Course courte');
    } else if (booking.distance > 20) {
      reasons.push('Course longue');
    }

    // Rentabilité
    if (profitabilityScore > 80) {
      reasons.push('Très rentable');
    } else if (profitabilityScore < 40) {
      reasons.push('Rentabilité limitée');
    }

    // Contexte comportemental
    if (behaviorAnalysis.currentScore > 80) {
      reasons.push('Conditions très favorables actuellement');
    } else if (behaviorAnalysis.currentScore < 40) {
      reasons.push('Conditions actuelles difficiles');
    }

    return reasons.join(' • ');
  }

  /**
   * Suggestions alternatives
   */
  private generateAlternativeSuggestions(
    booking: BookingRequest,
    behaviorAnalysis: DriverBehaviorAnalysis
  ): string[] {
    const suggestions = [];

    // Suggestions basées sur l'analyse comportementale
    if (behaviorAnalysis.optimalStrategy.suggestedAction === 'move_to_zone') {
      const bestZone = behaviorAnalysis.topRecommendedZones[0];
      if (bestZone) {
        suggestions.push(`Considérez ${bestZone.name} (gains estimés: +${bestZone.estimatedEarnings.toFixed(0)}€)`);
      }
    }

    // Suggestions basées sur la réservation
    if (booking.platform !== Platform.FOREAS_DIRECT) {
      suggestions.push('Vérifiez vos réservations directes FOREAS (commission réduite)');
    }

    if (booking.estimatedFare < 1500) { // < 15€
      suggestions.push('Attendez une course plus rentable si possible');
    }

    // Suggestions météo/temporelles
    if (behaviorAnalysis.weatherImpact.demandMultiplier > 1.3) {
      suggestions.push('Profitez des conditions météo favorables à forte demande');
    }

    return suggestions.slice(0, 3); // Max 3 suggestions
  }

  /**
   * Génération de l'insight Ajnaya
   */
  private generateAjnayaInsight(
    booking: BookingRequest,
    foreacScore: number,
    shouldAccept: boolean,
    behaviorAnalysis: DriverBehaviorAnalysis
  ): any {
    const fare = booking.estimatedFare / 100;
    const commission = this.calculateExpectedCommission(booking) / 100;
    const netRevenue = fare - commission;

    if (shouldAccept && foreacScore > 85) {
      return {
        type: 'OPPORTUNITY',
        priority: 'HIGH',
        title: '🎯 Course excellente détectée !',
        message: `Score Ajnaya: ${foreacScore}/100. Revenue net estimé: ${netRevenue.toFixed(2)}€. ${booking.platform === Platform.FOREAS_DIRECT ? 'Commission FOREAS réduite !' : ''}`,
        actionable: true,
        actions: ['accept_immediately', 'prepare_route'],
      };
    }

    if (!shouldAccept && foreacScore < 40) {
      return {
        type: 'WARNING',
        priority: 'MEDIUM',
        title: '⚠️ Course peu recommandée',
        message: `Score Ajnaya faible: ${foreacScore}/100. Revenue net: ${netRevenue.toFixed(2)}€. ${behaviorAnalysis.topRecommendedZones[0] ? `Mieux: ${behaviorAnalysis.topRecommendedZones[0].name}` : 'Attendez une meilleure opportunité'}`,
        actionable: true,
        actions: ['wait_for_better', 'check_alternatives'],
      };
    }

    return {
      type: 'INFO',
      priority: 'LOW',
      title: '📊 Analyse de course',
      message: `Score Ajnaya: ${foreacScore}/100. Revenue net estimé: ${netRevenue.toFixed(2)}€. ${shouldAccept ? 'Recommandée' : 'Neutre'}`,
      actionable: false,
    };
  }

  /**
   * Analyse comportementale basique si pas fournie
   */
  private async getBasicBehaviorAnalysis(driverContext: DriverContext): Promise<DriverBehaviorAnalysis> {
    // Version simplifiée sans données météo/temps réelles
    return {
      currentScore: 60,
      predictedEarnings: {
        next1Hour: 25,
        next3Hours: 70,
        next6Hours: 130,
      },
      topRecommendedZones: [],
      strategicInsights: [],
      weatherImpact: {
        demandMultiplier: 1.0,
        safetyScore: 85,
        recommendation: 'Conditions normales',
      },
      optimalStrategy: {
        suggestedAction: 'stay_here',
        reasoning: 'Analyse basique - restez attentif aux opportunités',
        confidence: 60,
      },
    };
  }

  // Méthodes utilitaires
  private getCommissionRate(platform: Platform): number {
    switch (platform) {
      case Platform.FOREAS_DIRECT: return 10;
      case Platform.UBER: return 25;
      case Platform.BOLT: return 20;
      case Platform.HEETCH: return 25;
      case Platform.MARCEL: return 18;
      default: return 22;
    }
  }

  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}