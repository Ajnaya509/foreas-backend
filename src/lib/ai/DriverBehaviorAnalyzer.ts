/**
 * Driver Behavior Analyzer - FOREAS Ajnaya AI
 * 
 * Analyses comportementales avancées pour optimiser les gains des chauffeurs
 * Corrélation météo + heure + lieu + historique pour prédictions intelligentes
 */

import { Platform } from '@prisma/client';
import { prisma } from '@/lib/db';

export interface WeatherData {
  temperature: number;
  humidity: number;
  windSpeed: number;
  precipitation: number;
  condition: 'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'snowy';
  visibility: number;
}

export interface GeoLocation {
  lat: number;
  lng: number;
  city?: string;
  district?: string;
  country: string;
}

export interface TimeContext {
  hour: number;
  dayOfWeek: number; // 0 = Sunday
  isWeekend: boolean;
  isHoliday: boolean;
  season: 'spring' | 'summer' | 'autumn' | 'winter';
}

export interface PlatformsData {
  [Platform.UBER]: {
    activeRides: number;
    surgeMultiplier: number;
    estimatedWaitTime: number;
    activeDrivers: number;
  };
  [Platform.BOLT]: {
    activeRides: number;
    peakPricing: boolean;
    demandLevel: 'low' | 'medium' | 'high';
  };
  [Platform.HEETCH]: {
    activeRides: number;
    isRushHour: boolean;
  };
  [Platform.FOREAS_DIRECT]: {
    pendingBookings: number;
    averageBookingValue: number;
  };
}

export interface DriverBehaviorAnalysis {
  currentScore: number; // 0-100
  predictedEarnings: {
    next1Hour: number;
    next3Hours: number;
    next6Hours: number;
  };
  topRecommendedZones: Array<{
    name: string;
    lat: number;
    lng: number;
    reason: string;
    confidence: number;
    estimatedEarnings: number;
    travelTime: number;
    rideFrequency: number;
  }>;
  strategicInsights: Array<{
    type: 'opportunity' | 'warning' | 'optimization' | 'trend';
    priority: 'low' | 'medium' | 'high' | 'critical';
    title: string;
    message: string;
    actionable: boolean;
    data?: any;
  }>;
  weatherImpact: {
    demandMultiplier: number;
    safetyScore: number;
    recommendation: string;
  };
  optimalStrategy: {
    suggestedAction: 'stay_here' | 'move_to_zone' | 'go_offline' | 'switch_platform';
    reasoning: string;
    confidence: number;
  };
}

export class DriverBehaviorAnalyzer {
  private readonly WEATHER_DEMAND_CORRELATION = {
    'rainy': 1.4,    // +40% demande sous la pluie
    'stormy': 1.6,   // +60% demande lors d'orages
    'snowy': 1.8,    // +80% demande sous la neige
    'sunny': 1.0,    // Demande normale
    'cloudy': 1.1,   // +10% demande temps nuageux
  };

  private readonly PARIS_HOTSPOTS = [
    { name: 'Champs-Élysées', lat: 48.8738, lng: 2.2950, baseMultiplier: 1.3 },
    { name: 'Gare du Nord', lat: 48.8809, lng: 2.3553, baseMultiplier: 1.5 },
    { name: 'CDG Airport', lat: 49.0097, lng: 2.5479, baseMultiplier: 1.8 },
    { name: 'La Défense', lat: 48.8922, lng: 2.2358, baseMultiplier: 1.2 },
    { name: 'Châtelet', lat: 48.8583, lng: 2.3472, baseMultiplier: 1.4 },
    { name: 'République', lat: 48.8676, lng: 2.3631, baseMultiplier: 1.1 },
    { name: 'Bastille', lat: 48.8532, lng: 2.3692, baseMultiplier: 1.2 },
    { name: 'Opéra', lat: 48.8721, lng: 2.3318, baseMultiplier: 1.3 },
    { name: 'Tour Eiffel', lat: 48.8584, lng: 2.2945, baseMultiplier: 1.4 },
    { name: 'Montparnasse', lat: 48.8420, lng: 2.3219, baseMultiplier: 1.2 },
  ];

  /**
   * Analyse comportementale principale
   */
  async analyzeDriverBehavior(
    driverId: string,
    platformsData: PlatformsData,
    weatherData: WeatherData,
    timeContext: TimeContext,
    currentLocation: GeoLocation
  ): Promise<DriverBehaviorAnalysis> {
    console.log(`🧠 Ajnaya analyzing behavior for driver ${driverId}`);
    
    // 1. Analyse des tendances passées
    const historicalData = await this.getDriverHistoricalData(driverId);
    const behaviorPatterns = this.analyzeBehaviorPatterns(historicalData, timeContext);
    
    // 2. Corrélation météo + heure + lieu
    const demandPrediction = this.predictDemand(weatherData, timeContext, currentLocation, platformsData);
    
    // 3. Recommandation "Top endroit" + prédiction de gains
    const zoneRecommendations = await this.calculateOptimalZones(
      currentLocation,
      weatherData,
      timeContext,
      platformsData,
      historicalData
    );
    
    // 4. Stratégie optimale
    const optimalStrategy = this.calculateOptimalStrategy(
      behaviorPatterns,
      demandPrediction,
      zoneRecommendations,
      platformsData
    );

    const analysis: DriverBehaviorAnalysis = {
      currentScore: this.calculateCurrentScore(demandPrediction, weatherData, timeContext),
      predictedEarnings: this.predictEarnings(demandPrediction, historicalData, behaviorPatterns),
      topRecommendedZones: zoneRecommendations,
      strategicInsights: await this.generateStrategicInsights(
        driverId,
        behaviorPatterns,
        demandPrediction,
        weatherData,
        timeContext
      ),
      weatherImpact: this.analyzeWeatherImpact(weatherData, timeContext),
      optimalStrategy,
    };

    // 5. Créer notification ou mise à jour dashboard
    await this.createAjnayaInsights(driverId, analysis);

    return analysis;
  }

  /**
   * Récupération des données historiques du chauffeur
   */
  private async getDriverHistoricalData(driverId: string): Promise<any> {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 jours

    const [rides, earnings, platformStats] = await Promise.all([
      // Courses des 30 derniers jours
      prisma.ride.findMany({
        where: {
          driverId,
          completedAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { completedAt: 'desc' },
      }),
      
      // Revenus par jour
      prisma.earning.findMany({
        where: {
          driverId,
          earnedAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { earnedAt: 'desc' },
      }),
      
      // Stats par plateforme
      prisma.platformStats.findMany({
        where: {
          driverId,
          date: {
            gte: startDate,
            lte: endDate,
          },
        },
        orderBy: { date: 'desc' },
      }),
    ]);

    return { rides, earnings, platformStats };
  }

  /**
   * Analyse des patterns comportementaux
   */
  private analyzeBehaviorPatterns(historicalData: any, timeContext: TimeContext): any {
    const { rides, earnings } = historicalData;
    
    // Analyse par heure de la journée
    const hourlyPerformance = Array.from({ length: 24 }, (_, hour) => {
      const hourRides = rides.filter((ride: any) => 
        new Date(ride.completedAt).getHours() === hour
      );
      
      return {
        hour,
        rideCount: hourRides.length,
        avgEarnings: hourRides.length > 0 
          ? hourRides.reduce((sum: number, ride: any) => sum + ride.netEarnings, 0) / hourRides.length
          : 0,
        efficiency: hourRides.length > 0 ? hourRides.length / 1 : 0, // rides per hour
      };
    });

    // Analyse par jour de la semaine
    const weeklyPerformance = Array.from({ length: 7 }, (_, dayOfWeek) => {
      const dayRides = rides.filter((ride: any) => 
        new Date(ride.completedAt).getDay() === dayOfWeek
      );
      
      return {
        dayOfWeek,
        rideCount: dayRides.length,
        avgEarnings: dayRides.length > 0 
          ? dayRides.reduce((sum: number, ride: any) => sum + ride.netEarnings, 0) / dayRides.length
          : 0,
      };
    });

    // Détection des zones fréquentes
    const frequentZones = this.analyzeFrequentPickupZones(rides);

    return {
      hourlyPerformance,
      weeklyPerformance,
      frequentZones,
      totalRides: rides.length,
      avgDailyEarnings: earnings.reduce((sum: number, earning: any) => sum + earning.amount, 0) / 30,
      bestPerformingHour: hourlyPerformance.reduce((best, current) => 
        current.avgEarnings > best.avgEarnings ? current : best
      ),
      bestPerformingDay: weeklyPerformance.reduce((best, current) => 
        current.avgEarnings > best.avgEarnings ? current : best
      ),
    };
  }

  /**
   * Prédiction de la demande basée sur les corrélations
   */
  private predictDemand(
    weather: WeatherData,
    time: TimeContext,
    location: GeoLocation,
    platforms: PlatformsData
  ): any {
    let demandMultiplier = 1.0;

    // Impact météo
    demandMultiplier *= this.WEATHER_DEMAND_CORRELATION[weather.condition];

    // Impact horaire
    if (time.hour >= 7 && time.hour <= 9) demandMultiplier *= 1.3; // Rush matinal
    if (time.hour >= 17 && time.hour <= 19) demandMultiplier *= 1.4; // Rush soir
    if (time.hour >= 22 || time.hour <= 4) demandMultiplier *= 1.2; // Sorties nocturnes

    // Impact weekend
    if (time.isWeekend) {
      if (time.hour >= 10 && time.hour <= 14) demandMultiplier *= 1.1; // Loisirs weekend
      if (time.hour >= 21 && time.hour <= 3) demandMultiplier *= 1.5; // Sorties weekend
    }

    // Impact plateforme (surge/peak pricing)
    const uberSurge = platforms[Platform.UBER]?.surgeMultiplier || 1;
    const boltPeak = platforms[Platform.BOLT]?.peakPricing ? 1.2 : 1;
    const avgPlatformMultiplier = (uberSurge + boltPeak) / 2;
    
    demandMultiplier *= avgPlatformMultiplier;

    return {
      overallDemandMultiplier: Math.min(demandMultiplier, 3.0), // Cap à 3x
      weatherContribution: this.WEATHER_DEMAND_CORRELATION[weather.condition],
      timeContribution: this.getTimeContribution(time),
      platformContribution: avgPlatformMultiplier,
      confidence: this.calculatePredictionConfidence(weather, time, platforms),
    };
  }

  /**
   * Calcul des zones optimales
   */
  private async calculateOptimalZones(
    currentLocation: GeoLocation,
    weather: WeatherData,
    time: TimeContext,
    platforms: PlatformsData,
    historicalData: any
  ): Promise<any[]> {
    const zones = [];

    for (const hotspot of this.PARIS_HOTSPOTS) {
      const distance = this.calculateDistance(
        currentLocation.lat, currentLocation.lng,
        hotspot.lat, hotspot.lng
      );

      const travelTime = Math.max(distance / 30, 5); // 30km/h avg, min 5min
      const travelCost = distance * 0.15; // 0.15€/km

      // Score basé sur distance, météo, heure, et données historiques
      let zoneScore = hotspot.baseMultiplier;
      
      // Bonus météo pour certaines zones
      if (weather.condition === 'rainy' && hotspot.name.includes('Gare')) {
        zoneScore *= 1.3; // Gares plus demandées sous la pluie
      }
      
      // Bonus heure de pointe pour business districts
      if ((time.hour >= 7 && time.hour <= 9) || (time.hour >= 17 && time.hour <= 19)) {
        if (['La Défense', 'Opéra', 'Châtelet'].includes(hotspot.name)) {
          zoneScore *= 1.2;
        }
      }

      // Bonus weekend pour zones touristiques
      if (time.isWeekend && ['Tour Eiffel', 'Champs-Élysées', 'Opéra'].includes(hotspot.name)) {
        zoneScore *= 1.15;
      }

      const estimatedEarnings = Math.max(0, (zoneScore * 25) - travelCost); // 25€ base per ride
      const rideFrequency = zoneScore * 2; // rides per hour

      zones.push({
        name: hotspot.name,
        lat: hotspot.lat,
        lng: hotspot.lng,
        reason: this.generateZoneReason(hotspot, weather, time, zoneScore),
        confidence: Math.min(95, Math.max(60, zoneScore * 60)), // 60-95% confidence
        estimatedEarnings,
        travelTime,
        rideFrequency,
        distance,
      });
    }

    // Trier par potentiel de gains
    return zones
      .sort((a, b) => b.estimatedEarnings - a.estimatedEarnings)
      .slice(0, 5); // Top 5 zones
  }

  /**
   * Génération d'insights stratégiques
   */
  private async generateStrategicInsights(
    driverId: string,
    behaviorPatterns: any,
    demandPrediction: any,
    weather: WeatherData,
    time: TimeContext
  ): Promise<any[]> {
    const insights = [];

    // Insight météo critique
    if (weather.condition === 'stormy' || (weather.condition === 'rainy' && weather.precipitation > 10)) {
      insights.push({
        type: 'opportunity',
        priority: 'high',
        title: '🌧️ Forte demande détectée',
        message: `Conditions météo favorables à une augmentation de +${Math.round((demandPrediction.weatherContribution - 1) * 100)}% de la demande. C'est le moment idéal pour maximiser vos gains !`,
        actionable: true,
        data: { weatherMultiplier: demandPrediction.weatherContribution }
      });
    }

    // Insight heure de pointe
    if (demandPrediction.timeContribution > 1.3) {
      insights.push({
        type: 'opportunity',
        priority: 'medium',
        title: '⏰ Période de forte demande',
        message: `Vous êtes en pleine heure de pointe ! Demande +${Math.round((demandPrediction.timeContribution - 1) * 100)}% par rapport à la normale.`,
        actionable: true,
      });
    }

    // Insight performance vs moyenne
    const currentHourPerformance = behaviorPatterns.hourlyPerformance[time.hour];
    if (currentHourPerformance.avgEarnings > behaviorPatterns.avgDailyEarnings * 0.1) {
      insights.push({
        type: 'trend',
        priority: 'medium',
        title: '📈 Créneau historiquement rentable',
        message: `D'après vos données, cette heure vous rapporte en moyenne ${currentHourPerformance.avgEarnings.toFixed(2)}€ par course. Restez actif !`,
        actionable: false,
      });
    }

    // Insight plateforme optimale
    const foreаsDirectBookings = await this.getForeаsDirectPendingBookings(driverId);
    if (foreаsDirectBookings > 0) {
      insights.push({
        type: 'optimization',
        priority: 'high',
        title: '💰 Réservations directes disponibles',
        message: `${foreаsDirectBookings} réservation(s) directe(s) FOREAS en attente. Commission réduite de 5-15% au lieu de 25% !`,
        actionable: true,
        data: { pendingBookings: foreаsDirectBookings }
      });
    }

    return insights;
  }

  /**
   * Calcul de la stratégie optimale
   */
  private calculateOptimalStrategy(
    behaviorPatterns: any,
    demandPrediction: any,
    zoneRecommendations: any[],
    platforms: PlatformsData
  ): any {
    const currentScore = demandPrediction.overallDemandMultiplier;
    const bestZone = zoneRecommendations[0];

    // Si score actuel > 1.5 et pas de zone nettement meilleure
    if (currentScore > 1.5 && (!bestZone || bestZone.estimatedEarnings < 20)) {
      return {
        suggestedAction: 'stay_here',
        reasoning: `Excellentes conditions actuelles (score ${currentScore.toFixed(1)}x). Restez dans votre zone !`,
        confidence: 85,
      };
    }

    // Si une zone est nettement meilleure
    if (bestZone && bestZone.estimatedEarnings > 25 && bestZone.travelTime < 20) {
      return {
        suggestedAction: 'move_to_zone',
        reasoning: `Direction ${bestZone.name} : gains estimés +${bestZone.estimatedEarnings.toFixed(0)}€ (${bestZone.travelTime}min de trajet)`,
        confidence: Math.round(bestZone.confidence),
      };
    }

    // Si conditions faibles
    if (currentScore < 0.8) {
      return {
        suggestedAction: 'go_offline',
        reasoning: `Conditions défavorables (score ${currentScore.toFixed(1)}x). Considérez une pause ou changez de zone.`,
        confidence: 70,
      };
    }

    // Stratégie par défaut
    return {
      suggestedAction: 'stay_here',
      reasoning: 'Conditions normales. Restez attentif aux opportunités.',
      confidence: 60,
    };
  }

  // Méthodes utilitaires
  private calculateCurrentScore(demandPrediction: any, weather: WeatherData, time: TimeContext): number {
    return Math.round(demandPrediction.overallDemandMultiplier * 50); // 0-100 scale
  }

  private predictEarnings(demandPrediction: any, historicalData: any, behaviorPatterns: any): any {
    const baseHourlyEarning = behaviorPatterns.avgDailyEarnings / 8; // 8h work day
    const multiplier = demandPrediction.overallDemandMultiplier;

    return {
      next1Hour: Math.round(baseHourlyEarning * multiplier),
      next3Hours: Math.round(baseHourlyEarning * 3 * multiplier * 0.9), // Slight decrease
      next6Hours: Math.round(baseHourlyEarning * 6 * multiplier * 0.8), // More decrease
    };
  }

  private analyzeWeatherImpact(weather: WeatherData, time: TimeContext): any {
    const demandMultiplier = this.WEATHER_DEMAND_CORRELATION[weather.condition];
    let safetyScore = 100;
    
    if (weather.condition === 'stormy') safetyScore = 60;
    if (weather.condition === 'snowy') safetyScore = 70;
    if (weather.condition === 'rainy' && weather.precipitation > 15) safetyScore = 80;

    return {
      demandMultiplier,
      safetyScore,
      recommendation: this.generateWeatherRecommendation(weather, safetyScore),
    };
  }

  private generateWeatherRecommendation(weather: WeatherData, safetyScore: number): string {
    if (safetyScore < 70) {
      return `Conditions difficiles (${weather.condition}). Conduisez prudemment et considérez des pauses fréquentes.`;
    }
    if (weather.condition === 'rainy') {
      return 'Temps pluvieux = forte demande ! Profitez-en tout en restant vigilant.';
    }
    return 'Conditions météo favorables à la conduite.';
  }

  private generateZoneReason(hotspot: any, weather: WeatherData, time: TimeContext, score: number): string {
    const reasons = [];
    
    if (score > 1.3) reasons.push('Forte demande attendue');
    if (weather.condition === 'rainy' && hotspot.name.includes('Gare')) reasons.push('Transport public limité');
    if (time.isWeekend && ['Tour Eiffel', 'Champs-Élysées'].includes(hotspot.name)) reasons.push('Zone touristique active');
    if ((time.hour >= 17 && time.hour <= 19) && hotspot.name === 'La Défense') reasons.push('Sortie des bureaux');
    
    return reasons.join(' • ') || 'Zone régulièrement active';
  }

  private async createAjnayaInsights(driverId: string, analysis: DriverBehaviorAnalysis): Promise<void> {
    try {
      // Créer une insight principale avec l'analyse complète
      await prisma.ajnayaInsight.create({
        data: {
          driverId,
          type: 'PERFORMANCE',
          priority: analysis.strategicInsights.some(i => i.priority === 'critical') ? 'CRITICAL' : 'HIGH',
          title: `🧠 Analyse Ajnaya - Score ${analysis.currentScore}/100`,
          message: `Gains prédits: ${analysis.predictedEarnings.next1Hour}€ (1h), ${analysis.predictedEarnings.next3Hours}€ (3h). ${analysis.optimalStrategy.reasoning}`,
          data: {
            analysis,
            timestamp: new Date().toISOString(),
            source: 'ajnaya_behavior_analyzer',
          },
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4h
        },
      });

      // Créer des insights spécifiques pour chaque recommandation stratégique
      for (const insight of analysis.strategicInsights.slice(0, 3)) { // Max 3 insights
        await prisma.ajnayaInsight.create({
          data: {
            driverId,
            type: insight.type.toUpperCase() as any,
            priority: insight.priority.toUpperCase() as any,
            title: insight.title,
            message: insight.message,
            data: insight.data || {},
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h
          },
        });
      }

      console.log(`✅ Created Ajnaya insights for driver ${driverId}`);
    } catch (error) {
      console.error('❌ Failed to create Ajnaya insights:', error);
    }
  }

  // Méthodes utilitaires supplémentaires
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

  private getTimeContribution(time: TimeContext): number {
    let multiplier = 1.0;
    
    if (time.hour >= 7 && time.hour <= 9) multiplier = 1.3;
    if (time.hour >= 17 && time.hour <= 19) multiplier = 1.4;
    if (time.hour >= 22 || time.hour <= 4) multiplier = 1.2;
    
    if (time.isWeekend) {
      if (time.hour >= 21 && time.hour <= 3) multiplier = 1.5;
    }
    
    return multiplier;
  }

  private calculatePredictionConfidence(weather: WeatherData, time: TimeContext, platforms: PlatformsData): number {
    let confidence = 70; // Base confidence
    
    if (weather.condition === 'rainy' || weather.condition === 'stormy') confidence += 15;
    if (time.hour >= 17 && time.hour <= 19) confidence += 10; // Rush hour well documented
    if (platforms[Platform.UBER]?.surgeMultiplier > 1.2) confidence += 10;
    
    return Math.min(95, confidence);
  }

  private analyzeFrequentPickupZones(rides: any[]): any[] {
    const zoneMap = new Map();
    
    rides.forEach(ride => {
      const key = `${Math.round(ride.pickupLat * 100)},${Math.round(ride.pickupLng * 100)}`;
      const count = zoneMap.get(key) || 0;
      zoneMap.set(key, count + 1);
    });

    return Array.from(zoneMap.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([key, count]) => {
        const [lat, lng] = key.split(',').map(n => parseFloat(n) / 100);
        return { lat, lng, rideCount: count };
      });
  }

  private async getForeаsDirectPendingBookings(driverId: string): Promise<number> {
    try {
      const count = await prisma.booking.count({
        where: {
          driverId,
          status: 'PENDING',
          scheduledFor: {
            gte: new Date(),
            lte: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      });
      return count;
    } catch (error) {
      return 0;
    }
  }
}

// Singleton export
export const driverBehaviorAnalyzer = new DriverBehaviorAnalyzer();