/**
 * Platform Manager - FOREAS Driver
 * 
 * Central orchestrator for multi-platform VTC integration
 * Handles aggregation, credential management, and unified booking flow
 */

import { Platform } from '@prisma/client';
import { AbstractPlatformAdapter } from './adapters/AbstractPlatformAdapter';
import { UberAdapter } from './adapters/UberAdapter';
import { BoltAdapter } from './adapters/BoltAdapter';
import { HeetchAdapter } from './adapters/HeetchAdapter';
import { ForeacDirectAdapter } from './adapters/ForeacDirectAdapter';
import { BookingAggregator } from '../aggregation/BookingAggregator';
import { BookingRecommendationEngine } from '../ai/BookingRecommendationEngine';
import { PlatformAnalytics } from '../analytics/PlatformAnalytics';

export interface PlatformCredentials {
  [key: string]: string;
  // Platform-specific credential structure
}

export interface BookingRequest {
  id: string;
  platform: Platform;
  pickup: {
    address: string;
    lat: number;
    lng: number;
    time: Date;
  };
  dropoff?: {
    address: string;
    lat: number;
    lng: number;
  };
  estimatedFare: number; // in centimes
  estimatedDuration: number; // in minutes
  distance: number; // in km
  clientInfo: {
    firstName?: string;
    rating?: number;
    preferences?: string[];
  };
  specialRequests?: string[];
  urgency: 'low' | 'medium' | 'high';
  expiresAt: Date;
}

export interface AggregatedBooking extends BookingRequest {
  foreacScore: number; // 0-100
  expectedCommission: number;
  profitability: number;
  recommendation: 'accept' | 'reject' | 'neutral' | 'wait_for_better';
  reasoning: string;
}

export interface DriverContext {
  driverId: string;
  currentLocation?: { lat: number; lng: number };
  isAvailable: boolean;
  activeRides: number;
  preferences: {
    minFare?: number;
    maxDistance?: number;
    preferredAreas?: string[];
    avoidAreas?: string[];
  };
  stats: {
    totalRides: number;
    averageRating: number;
    acceptanceRate: number;
    earningsToday: number;
  };
}

export class PlatformManager {
  private adapters: Map<Platform, AbstractPlatformAdapter> = new Map();
  private aggregator: BookingAggregator;
  private recommendationEngine: BookingRecommendationEngine;
  private analytics: PlatformAnalytics;

  constructor() {
    this.initializeAdapters();
    this.aggregator = new BookingAggregator(this.adapters);
    this.recommendationEngine = new BookingRecommendationEngine();
    this.analytics = new PlatformAnalytics();
  }

  private initializeAdapters(): void {
    this.adapters.set(Platform.UBER, new UberAdapter());
    this.adapters.set(Platform.BOLT, new BoltAdapter());
    this.adapters.set(Platform.HEETCH, new HeetchAdapter());
    this.adapters.set(Platform.FOREAS_DIRECT, new ForeacDirectAdapter());
  }

  /**
   * Get all available bookings from all platforms
   */
  async getAvailableBookings(driverId: string): Promise<AggregatedBooking[]> {
    const driverContext = await this.getDriverContext(driverId);
    const rawBookings = await this.aggregator.getAllAvailableBookings(driverId);
    
    // Apply AI recommendations
    const enrichedBookings = await Promise.all(
      rawBookings.map(async booking => {
        const recommendation = await this.recommendationEngine.analyzeBooking(
          booking,
          driverContext
        );
        
        return {
          ...booking,
          foreacScore: recommendation.foreacScore,
          expectedCommission: recommendation.expectedCommission,
          profitability: recommendation.profitabilityScore,
          recommendation: recommendation.shouldAccept ? 'accept' : 'reject',
          reasoning: recommendation.reasoning,
        };
      })
    );

    // Sort by FOREAS score (highest first)
    return enrichedBookings.sort((a, b) => b.foreacScore - a.foreacScore);
  }

  /**
   * Accept a booking on the appropriate platform
   */
  async acceptBooking(
    bookingId: string,
    platform: Platform,
    driverId: string
  ): Promise<{ success: boolean; message: string }> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return { success: false, message: 'Platform not supported' };
    }

    try {
      await adapter.acceptBooking(bookingId);
      
      // Record the acceptance in analytics
      await this.analytics.recordBookingAcceptance(driverId, platform, bookingId);
      
      // Create Ajnaya insight
      await this.createBookingAcceptedInsight(driverId, bookingId, platform);
      
      return { success: true, message: 'Booking accepted successfully' };
    } catch (error: any) {
      console.error(`❌ Failed to accept booking ${bookingId} on ${platform}:`, error);
      return { success: false, message: error.message || 'Failed to accept booking' };
    }
  }

  /**
   * Reject a booking on the appropriate platform
   */
  async rejectBooking(
    bookingId: string,
    platform: Platform,
    driverId: string,
    reason?: string
  ): Promise<{ success: boolean; message: string }> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return { success: false, message: 'Platform not supported' };
    }

    try {
      await adapter.rejectBooking(bookingId, reason);
      
      // Record the rejection in analytics
      await this.analytics.recordBookingRejection(driverId, platform, bookingId, reason);
      
      return { success: true, message: 'Booking rejected successfully' };
    } catch (error: any) {
      console.error(`❌ Failed to reject booking ${bookingId} on ${platform}:`, error);
      return { success: false, message: error.message || 'Failed to reject booking' };
    }
  }

  /**
   * Set availability across all active platforms
   */
  async setAvailability(
    driverId: string,
    isAvailable: boolean,
    platforms?: Platform[]
  ): Promise<{ success: boolean; platformResults: Record<string, boolean> }> {
    const targetPlatforms = platforms || Array.from(this.adapters.keys());
    const results: Record<string, boolean> = {};

    for (const platform of targetPlatforms) {
      const adapter = this.adapters.get(platform);
      if (!adapter) continue;

      try {
        await adapter.setAvailability(isAvailable);
        results[platform] = true;
      } catch (error) {
        console.error(`❌ Failed to set availability on ${platform}:`, error);
        results[platform] = false;
      }
    }

    const success = Object.values(results).some(result => result);
    
    // Create Ajnaya insight for availability change
    await this.createAvailabilityChangeInsight(driverId, isAvailable, results);

    return { success, platformResults: results };
  }

  /**
   * Update location across all platforms
   */
  async updateLocation(
    driverId: string,
    lat: number,
    lng: number
  ): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    for (const [platform, adapter] of this.adapters.entries()) {
      try {
        await adapter.updateLocation(lat, lng);
      } catch (error: any) {
        console.error(`❌ Failed to update location on ${platform}:`, error);
        errors.push(`${platform}: ${error.message}`);
      }
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Get comprehensive earnings from all platforms
   */
  async getComprehensiveEarnings(
    driverId: string,
    period: { from: Date; to: Date }
  ): Promise<{
    total: number;
    breakdown: Record<Platform, number>;
    foreacAdvantage: {
      commissionSaved: number;
      percentageSaved: number;
      message: string;
    };
  }> {
    return await this.analytics.getComprehensiveEarnings(driverId, period);
  }

  /**
   * Sync driver credentials with platform
   */
  async syncPlatformCredentials(
    driverId: string,
    platform: Platform,
    credentials: PlatformCredentials
  ): Promise<{ success: boolean; message: string }> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return { success: false, message: 'Platform not supported' };
    }

    try {
      const isAuthenticated = await adapter.authenticate(credentials);
      
      if (!isAuthenticated) {
        return { success: false, message: 'Invalid credentials' };
      }

      // Store encrypted credentials in database
      // This will be handled by the CredentialManager
      
      return { success: true, message: 'Credentials synced successfully' };
    } catch (error: any) {
      console.error(`❌ Failed to sync credentials for ${platform}:`, error);
      return { success: false, message: error.message || 'Failed to sync credentials' };
    }
  }

  private async getDriverContext(driverId: string): Promise<DriverContext> {
    // This will fetch driver context from database
    // Including current stats, preferences, and active rides
    return {
      driverId,
      isAvailable: true,
      activeRides: 0,
      preferences: {},
      stats: {
        totalRides: 0,
        averageRating: 0,
        acceptanceRate: 0,
        earningsToday: 0,
      },
    };
  }

  private async createBookingAcceptedInsight(
    driverId: string,
    bookingId: string,
    platform: Platform
  ): Promise<void> {
    // Create Ajnaya insight for booking acceptance
    // This will be handled by the AjnayaInsight service
  }

  private async createAvailabilityChangeInsight(
    driverId: string,
    isAvailable: boolean,
    platformResults: Record<string, boolean>
  ): Promise<void> {
    // Create Ajnaya insight for availability change
    // This will be handled by the AjnayaInsight service
  }

  /**
   * Get platform status for dashboard
   */
  async getPlatformStatus(driverId: string): Promise<{
    platforms: Array<{
      id: Platform;
      name: string;
      isActive: boolean;
      isAuthenticated: boolean;
      availableBookings: number;
      todayEarnings: number;
      status: 'online' | 'offline' | 'error';
    }>;
    summary: {
      totalAvailableBookings: number;
      totalTodayEarnings: number;
      activePlatforms: number;
    };
  }> {
    const platformStatuses = [];
    let totalBookings = 0;
    let totalEarnings = 0;
    let activePlatforms = 0;

    for (const [platformId, adapter] of this.adapters.entries()) {
      try {
        const bookings = await adapter.getAvailableBookings();
        const earnings = await adapter.getTodayEarnings();
        
        platformStatuses.push({
          id: platformId,
          name: this.getPlatformDisplayName(platformId),
          isActive: true,
          isAuthenticated: true,
          availableBookings: bookings.length,
          todayEarnings: earnings,
          status: 'online' as const,
        });

        totalBookings += bookings.length;
        totalEarnings += earnings;
        activePlatforms++;
      } catch (error) {
        platformStatuses.push({
          id: platformId,
          name: this.getPlatformDisplayName(platformId),
          isActive: false,
          isAuthenticated: false,
          availableBookings: 0,
          todayEarnings: 0,
          status: 'error' as const,
        });
      }
    }

    return {
      platforms: platformStatuses,
      summary: {
        totalAvailableBookings: totalBookings,
        totalTodayEarnings: totalEarnings,
        activePlatforms,
      },
    };
  }

  private getPlatformDisplayName(platform: Platform): string {
    switch (platform) {
      case Platform.UBER:
        return 'Uber';
      case Platform.BOLT:
        return 'Bolt';
      case Platform.HEETCH:
        return 'Heetch';
      case Platform.MARCEL:
        return 'Marcel';
      case Platform.FOREAS_DIRECT:
        return 'FOREAS Direct';
      default:
        return 'Unknown';
    }
  }
}

// Singleton instance
export const platformManager = new PlatformManager();