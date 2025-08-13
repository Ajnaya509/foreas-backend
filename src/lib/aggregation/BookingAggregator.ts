/**
 * Booking Aggregator - FOREAS Driver
 * 
 * Aggregates bookings from multiple VTC platforms and applies
 * intelligent filtering, deduplication, and prioritization
 */

import { Platform } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AbstractPlatformAdapter } from '../platforms/adapters/AbstractPlatformAdapter';
import { BookingRequest, AggregatedBooking, DriverContext } from '../platforms/PlatformManager';

export interface AggregationConfig {
  maxBookingsPerPlatform: number;
  maxTotalBookings: number;
  deduplicationRadius: number; // meters
  priorityWeights: {
    distance: number;
    fare: number;
    rating: number;
    platform: number;
    urgency: number;
  };
}

export class BookingAggregator {
  private adapters: Map<Platform, AbstractPlatformAdapter>;
  private config: AggregationConfig;

  constructor(adapters: Map<Platform, AbstractPlatformAdapter>) {
    this.adapters = adapters;
    this.config = {
      maxBookingsPerPlatform: 10,
      maxTotalBookings: 25,
      deduplicationRadius: 200, // 200 meters
      priorityWeights: {
        distance: 0.20, // 20% - prefer nearby pickups
        fare: 0.30,     // 30% - prefer higher fares
        rating: 0.15,   // 15% - prefer higher-rated clients
        platform: 0.20, // 20% - prefer FOREAS Direct
        urgency: 0.15,  // 15% - consider time sensitivity
      },
    };
  }

  /**
   * Aggregate all available bookings from active platforms
   */
  async getAllAvailableBookings(driverId: string): Promise<AggregatedBooking[]> {
    const startTime = Date.now();
    
    try {
      // Get active platforms for this driver
      const activePlatforms = await this.getActivePlatformsForDriver(driverId);
      
      // Fetch bookings from all platforms in parallel
      const platformBookings = await Promise.allSettled(
        activePlatforms.map(async (platform) => {
          const adapter = this.adapters.get(platform);
          if (!adapter) return [];
          
          try {
            const bookings = await adapter.getAvailableBookings();
            return bookings.slice(0, this.config.maxBookingsPerPlatform);
          } catch (error) {
            console.error(`❌ Failed to get bookings from ${platform}:`, error);
            return [];
          }
        })
      );

      // Flatten successful results
      const allBookings = platformBookings
        .filter(result => result.status === 'fulfilled')
        .flatMap(result => result.value);

      console.log(`📊 Aggregated ${allBookings.length} bookings from ${activePlatforms.length} platforms in ${Date.now() - startTime}ms`);

      if (allBookings.length === 0) {
        return [];
      }

      // Apply aggregation pipeline
      const processedBookings = await this.processBookings(allBookings, driverId);

      // Store aggregated bookings in database for analytics
      await this.storeAggregatedBookings(driverId, processedBookings);

      return processedBookings.slice(0, this.config.maxTotalBookings);
    } catch (error) {
      console.error('❌ Failed to aggregate bookings:', error);
      return [];
    }
  }

  /**
   * Process bookings through the aggregation pipeline
   */
  private async processBookings(
    bookings: BookingRequest[], 
    driverId: string
  ): Promise<AggregatedBooking[]> {
    // Step 1: Deduplicate similar bookings
    const deduplicatedBookings = this.deduplicateBookings(bookings);
    
    // Step 2: Filter out inappropriate bookings
    const filteredBookings = await this.filterBookings(deduplicatedBookings, driverId);
    
    // Step 3: Calculate FOREAS scores
    const scoredBookings = await this.calculateForeacScores(filteredBookings, driverId);
    
    // Step 4: Sort by priority
    const prioritizedBookings = this.prioritizeBookings(scoredBookings);
    
    return prioritizedBookings;
  }

  /**
   * Remove duplicate or very similar bookings
   */
  private deduplicateBookings(bookings: BookingRequest[]): BookingRequest[] {
    const uniqueBookings: BookingRequest[] = [];
    
    for (const booking of bookings) {
      const isDuplicate = uniqueBookings.some(existing => 
        this.areBookingsSimilar(booking, existing)
      );
      
      if (!isDuplicate) {
        uniqueBookings.push(booking);
      } else {
        // Keep the booking from the preferred platform
        const existingIndex = uniqueBookings.findIndex(existing => 
          this.areBookingsSimilar(booking, existing)
        );
        
        if (this.getPlatformPriority(booking.platform) > 
            this.getPlatformPriority(uniqueBookings[existingIndex].platform)) {
          uniqueBookings[existingIndex] = booking;
        }
      }
    }

    console.log(`🔍 Deduplicated ${bookings.length} → ${uniqueBookings.length} bookings`);
    return uniqueBookings;
  }

  /**
   * Check if two bookings are similar (likely duplicates)
   */
  private areBookingsSimilar(booking1: BookingRequest, booking2: BookingRequest): boolean {
    const distance = this.calculateDistance(
      booking1.pickup.lat, booking1.pickup.lng,
      booking2.pickup.lat, booking2.pickup.lng
    );
    
    const timeDiff = Math.abs(
      booking1.pickup.time.getTime() - booking2.pickup.time.getTime()
    );
    
    return distance < this.config.deduplicationRadius && // Within 200m
           timeDiff < 10 * 60 * 1000; // Within 10 minutes
  }

  /**
   * Filter bookings based on driver preferences and constraints
   */
  private async filterBookings(
    bookings: BookingRequest[], 
    driverId: string
  ): Promise<BookingRequest[]> {
    // Get driver preferences
    const driverPrefs = await this.getDriverPreferences(driverId);
    
    return bookings.filter(booking => {
      // Filter by minimum fare
      if (driverPrefs.minFare && booking.estimatedFare < driverPrefs.minFare) {
        return false;
      }
      
      // Filter by maximum distance
      if (driverPrefs.maxDistance && booking.distance > driverPrefs.maxDistance) {
        return false;
      }
      
      // Filter by preferred areas (if specified)
      if (driverPrefs.preferredAreas?.length > 0) {
        const isInPreferredArea = driverPrefs.preferredAreas.some(area => 
          this.isLocationInArea(booking.pickup, area)
        );
        if (!isInPreferredArea) return false;
      }
      
      // Filter out avoided areas
      if (driverPrefs.avoidAreas?.length > 0) {
        const isInAvoidedArea = driverPrefs.avoidAreas.some(area => 
          this.isLocationInArea(booking.pickup, area)
        );
        if (isInAvoidedArea) return false;
      }
      
      return true;
    });
  }

  /**
   * Calculate FOREAS scores for bookings
   */
  private async calculateForeacScores(
    bookings: BookingRequest[], 
    driverId: string
  ): Promise<AggregatedBooking[]> {
    const driverLocation = await this.getDriverLocation(driverId);
    const driverStats = await this.getDriverStats(driverId);

    return bookings.map(booking => {
      const distanceScore = this.calculateDistanceScore(booking, driverLocation);
      const fareScore = this.calculateFareScore(booking);
      const ratingScore = this.calculateRatingScore(booking);
      const platformScore = this.calculatePlatformScore(booking.platform);
      const urgencyScore = this.calculateUrgencyScore(booking);

      const foreacScore = Math.round(
        distanceScore * this.config.priorityWeights.distance +
        fareScore * this.config.priorityWeights.fare +
        ratingScore * this.config.priorityWeights.rating +
        platformScore * this.config.priorityWeights.platform +
        urgencyScore * this.config.priorityWeights.urgency
      );

      return {
        ...booking,
        foreacScore: Math.max(0, Math.min(100, foreacScore)), // Clamp to 0-100
        expectedCommission: this.calculateExpectedCommission(booking),
        profitability: this.calculateProfitability(booking, driverStats),
        recommendation: this.generateRecommendation(booking, foreacScore),
        reasoning: this.generateReasoning(booking, foreacScore, {
          distanceScore,
          fareScore,
          ratingScore,
          platformScore,
          urgencyScore,
        }),
      } as AggregatedBooking;
    });
  }

  /**
   * Sort bookings by priority (highest FOREAS score first)
   */
  private prioritizeBookings(bookings: AggregatedBooking[]): AggregatedBooking[] {
    return bookings.sort((a, b) => {
      // Primary sort: FOREAS score
      if (b.foreacScore !== a.foreacScore) {
        return b.foreacScore - a.foreacScore;
      }
      
      // Secondary sort: Platform preference
      const aPlatformPriority = this.getPlatformPriority(a.platform);
      const bPlatformPriority = this.getPlatformPriority(b.platform);
      
      if (bPlatformPriority !== aPlatformPriority) {
        return bPlatformPriority - aPlatformPriority;
      }
      
      // Tertiary sort: Estimated fare
      return b.estimatedFare - a.estimatedFare;
    });
  }

  /**
   * Calculate distance score (0-100, higher = closer)
   */
  private calculateDistanceScore(booking: BookingRequest, driverLocation?: { lat: number; lng: number }): number {
    if (!driverLocation) return 50; // Neutral score if location unknown
    
    const distance = this.calculateDistance(
      booking.pickup.lat, booking.pickup.lng,
      driverLocation.lat, driverLocation.lng
    );
    
    // Score decreases with distance (max 100 for < 1km, 0 for > 20km)
    if (distance < 1000) return 100;
    if (distance > 20000) return 0;
    
    return Math.round(100 - (distance - 1000) / 19000 * 100);
  }

  /**
   * Calculate fare score (0-100, higher = better fare)
   */
  private calculateFareScore(booking: BookingRequest): number {
    const fare = booking.estimatedFare / 100; // Convert to euros
    
    // Score increases with fare (max 100 for > 50€, min 20 for < 5€)
    if (fare < 5) return 20;
    if (fare > 50) return 100;
    
    return Math.round(20 + (fare - 5) / 45 * 80);
  }

  /**
   * Calculate client rating score (0-100)
   */
  private calculateRatingScore(booking: BookingRequest): number {
    const rating = booking.clientInfo.rating;
    if (!rating) return 50; // Neutral if no rating
    
    // Convert 5-star rating to 100-point scale
    return Math.round((rating / 5) * 100);
  }

  /**
   * Calculate platform preference score (0-100)
   */
  private calculatePlatformScore(platform: Platform): number {
    switch (platform) {
      case Platform.FOREAS_DIRECT:
        return 100; // Highest preference for direct bookings
      case Platform.UBER:
        return 60;  // Good platform with stable API
      case Platform.BOLT:
        return 70;  // Good platform, slightly better than Uber
      case Platform.HEETCH:
        return 50;  // OK platform but limited features
      case Platform.MARCEL:
        return 40;  // Smaller platform
      default:
        return 30;  // Unknown platforms get low score
    }
  }

  /**
   * Calculate urgency score (0-100, higher = more urgent)
   */
  private calculateUrgencyScore(booking: BookingRequest): number {
    switch (booking.urgency) {
      case 'high':
        return 100;
      case 'medium':
        return 70;
      case 'low':
        return 40;
      default:
        return 50;
    }
  }

  /**
   * Calculate expected commission for a booking
   */
  private calculateExpectedCommission(booking: BookingRequest): number {
    const fare = booking.estimatedFare;
    
    switch (booking.platform) {
      case Platform.FOREAS_DIRECT:
        return fare * 0.10; // 10% average for FOREAS Direct
      case Platform.UBER:
        return fare * 0.25; // 25% for Uber
      case Platform.BOLT:
        return fare * 0.20; // 20% for Bolt
      case Platform.HEETCH:
        return fare * 0.25; // 25% for Heetch
      default:
        return fare * 0.20; // 20% default
    }
  }

  /**
   * Calculate profitability score
   */
  private calculateProfitability(booking: BookingRequest, driverStats?: any): number {
    const grossRevenue = booking.estimatedFare;
    const commission = this.calculateExpectedCommission(booking);
    const netRevenue = grossRevenue - commission;
    const estimatedCosts = booking.distance * 0.15 * 100; // 15 cents per km
    
    const profit = netRevenue - estimatedCosts;
    const profitMargin = profit / grossRevenue * 100;
    
    return Math.max(0, Math.min(100, profitMargin + 50)); // Normalize to 0-100
  }

  /**
   * Generate recommendation based on score
   */
  private generateRecommendation(booking: BookingRequest, score: number): 'accept' | 'reject' | 'neutral' | 'wait_for_better' {
    if (score >= 80) return 'accept';
    if (score >= 60) return 'neutral';
    if (score >= 40) return 'wait_for_better';
    return 'reject';
  }

  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(booking: BookingRequest, score: number, scores: any): string {
    const reasons: string[] = [];
    
    if (booking.platform === Platform.FOREAS_DIRECT) {
      reasons.push('Réservation directe FOREAS (commission réduite)');
    }
    
    if (scores.fareScore > 80) {
      reasons.push(`Course très rentable (${(booking.estimatedFare / 100).toFixed(2)}€)`);
    }
    
    if (scores.distanceScore > 80) {
      reasons.push('Prise en charge très proche');
    } else if (scores.distanceScore < 40) {
      reasons.push('Prise en charge éloignée');
    }
    
    if (booking.clientInfo.rating && booking.clientInfo.rating >= 4.5) {
      reasons.push(`Client bien noté (${booking.clientInfo.rating.toFixed(1)}⭐)`);
    }
    
    if (booking.urgency === 'high') {
      reasons.push('Course urgente');
    }
    
    return reasons.join(' • ') || 'Analyse standard';
  }

  // Helper methods
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private getPlatformPriority(platform: Platform): number {
    return this.calculatePlatformScore(platform);
  }

  private async getActivePlatformsForDriver(driverId: string): Promise<Platform[]> {
    try {
      const credentials = await prisma.driverPlatformCredentials.findMany({
        where: { driverId, isActive: true },
        select: { platform: true },
      });
      
      const platforms = credentials.map(cred => cred.platform);
      
      // Always include FOREAS Direct
      if (!platforms.includes(Platform.FOREAS_DIRECT)) {
        platforms.push(Platform.FOREAS_DIRECT);
      }
      
      return platforms;
    } catch (error) {
      console.error('❌ Failed to get active platforms:', error);
      return [Platform.FOREAS_DIRECT]; // Fallback to FOREAS Direct only
    }
  }

  private async getDriverPreferences(driverId: string): Promise<any> {
    // This would fetch driver preferences from database
    return {
      minFare: 500, // 5€ minimum
      maxDistance: 25, // 25km max
      preferredAreas: [],
      avoidAreas: [],
    };
  }

  private async getDriverLocation(driverId: string): Promise<{ lat: number; lng: number } | undefined> {
    // This would get current driver location
    return undefined; // Simplified for now
  }

  private async getDriverStats(driverId: string): Promise<any> {
    try {
      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        select: {
          totalRides: true,
          totalEarnings: true,
          averageRating: true,
        },
      });
      
      return driver;
    } catch (error) {
      return null;
    }
  }

  private isLocationInArea(location: { lat: number; lng: number }, area: string): boolean {
    // Simplified area checking - would use proper geofencing
    return false;
  }

  private async storeAggregatedBookings(driverId: string, bookings: AggregatedBooking[]): Promise<void> {
    try {
      // Store in database for analytics and caching
      await prisma.aggregatedBooking.deleteMany({
        where: { driverId },
      });

      if (bookings.length > 0) {
        await prisma.aggregatedBooking.createMany({
          data: bookings.map(booking => ({
            id: `${booking.platform}_${booking.id}_${Date.now()}`,
            driverId,
            platform: booking.platform,
            platformBookingId: booking.id,
            pickupAddress: booking.pickup.address,
            pickupLat: booking.pickup.lat,
            pickupLng: booking.pickup.lng,
            dropoffAddress: booking.dropoff?.address,
            dropoffLat: booking.dropoff?.lat,
            dropoffLng: booking.dropoff?.lng,
            scheduledFor: booking.pickup.time,
            estimatedDuration: booking.estimatedDuration,
            distance: booking.distance,
            estimatedFare: booking.estimatedFare / 100, // Convert to euros
            clientFirstName: booking.clientInfo.firstName,
            clientRating: booking.clientInfo.rating,
            foreacScore: booking.foreacScore,
            profitabilityScore: booking.profitability,
            recommendation: booking.recommendation.toUpperCase() as any,
            expiresAt: booking.expiresAt,
          })),
        });
      }
    } catch (error) {
      console.error('❌ Failed to store aggregated bookings:', error);
    }
  }
}