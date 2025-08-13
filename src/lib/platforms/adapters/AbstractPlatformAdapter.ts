/**
 * Abstract Platform Adapter - FOREAS Driver
 * 
 * Base class for all VTC platform integrations
 * Defines the common interface that all platforms must implement
 */

import { Platform } from '@prisma/client';
import { BookingRequest } from '../PlatformManager';

export interface PlatformCapabilities {
  canReceiveBookings: boolean;
  canAcceptReject: boolean;
  canTrackEarnings: boolean;
  canManageAvailability: boolean;
  hasWebhooks: boolean;
  supportsBulkOperations: boolean;
  supportsRealTimeLocation: boolean;
}

export interface PlatformConfig {
  id: Platform;
  name: string;
  apiVersion: string;
  baseUrl?: string;
  authType: 'oauth2' | 'api_key' | 'session';
  rateLimit: {
    requestsPerMinute: number;
    requestsPerHour: number;
  };
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
  };
}

export interface PlatformCredentials {
  [key: string]: string;
}

export interface BookingAcceptance {
  bookingId: string;
  success: boolean;
  message?: string;
  estimatedArrival?: Date;
  trackingUrl?: string;
}

export interface EarningsSummary {
  platform: Platform;
  period: { from: Date; to: Date };
  grossEarnings: number;
  commission: number;
  netEarnings: number;
  rideCount: number;
  averageRideValue: number;
  tips: number;
  bonuses: number;
}

export interface PlatformStatus {
  isOnline: boolean;
  lastHeartbeat: Date;
  pendingRequests: number;
  activeRides: number;
  todayStats: {
    ridesCompleted: number;
    earnings: number;
    onlineHours: number;
  };
}

export abstract class AbstractPlatformAdapter {
  protected platform: PlatformConfig;
  protected apiClient: any;
  protected isAuthenticated: boolean = false;
  protected lastSyncAt: Date | null = null;

  constructor(platform: PlatformConfig) {
    this.platform = platform;
    this.initializeApiClient();
  }

  protected abstract initializeApiClient(): void;

  /**
   * Authenticate with the platform using provided credentials
   */
  abstract authenticate(credentials: PlatformCredentials): Promise<boolean>;

  /**
   * Get list of available booking requests
   */
  abstract getAvailableBookings(): Promise<BookingRequest[]>;

  /**
   * Accept a booking request
   */
  abstract acceptBooking(bookingId: string): Promise<BookingAcceptance>;

  /**
   * Reject a booking request
   */
  abstract rejectBooking(bookingId: string, reason?: string): Promise<void>;

  /**
   * Update driver's current location
   */
  abstract updateLocation(lat: number, lng: number): Promise<void>;

  /**
   * Set driver availability status
   */
  abstract setAvailability(isAvailable: boolean): Promise<void>;

  /**
   * Get earnings for a specific time period
   */
  abstract getEarnings(period: { from: Date; to: Date }): Promise<EarningsSummary>;

  /**
   * Get current platform status
   */
  abstract getStatus(): Promise<PlatformStatus>;

  /**
   * Get today's earnings (convenience method)
   */
  async getTodayEarnings(): Promise<number> {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const earnings = await this.getEarnings({ from: startOfDay, to: endOfDay });
    return earnings.netEarnings;
  }

  /**
   * Validate if credentials are still valid
   */
  async validateCredentials(): Promise<boolean> {
    try {
      // Most platforms have a simple "me" or "profile" endpoint
      await this.makeAuthenticatedRequest('GET', '/me');
      return true;
    } catch (error) {
      console.error(`❌ Credential validation failed for ${this.platform.name}:`, error);
      return false;
    }
  }

  /**
   * Generic authenticated API request with retry logic
   */
  protected async makeAuthenticatedRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: any,
    retries = 0
  ): Promise<any> {
    if (!this.isAuthenticated) {
      throw new Error(`Not authenticated with ${this.platform.name}`);
    }

    try {
      const response = await this.apiClient.request({
        method,
        url: endpoint,
        data,
      });

      return response.data;
    } catch (error: any) {
      // Handle rate limiting
      if (error.response?.status === 429 && retries < this.platform.retryPolicy.maxRetries) {
        const delay = Math.pow(2, retries) * this.platform.retryPolicy.backoffMs;
        console.log(`⏳ Rate limited on ${this.platform.name}, retrying in ${delay}ms`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.makeAuthenticatedRequest(method, endpoint, data, retries + 1);
      }

      // Handle authentication errors
      if (error.response?.status === 401) {
        this.isAuthenticated = false;
        throw new Error(`Authentication expired for ${this.platform.name}`);
      }

      throw error;
    }
  }

  /**
   * Convert platform-specific booking format to unified format
   */
  protected abstract transformBookingData(platformBooking: any): BookingRequest;

  /**
   * Calculate urgency based on platform-specific data
   */
  protected calculateUrgency(platformData: any): 'low' | 'medium' | 'high' {
    // Default implementation - can be overridden by specific adapters
    const timeToPickup = platformData.pickup_time ? 
      new Date(platformData.pickup_time).getTime() - Date.now() : 
      30 * 60 * 1000; // Default 30 minutes

    if (timeToPickup < 5 * 60 * 1000) return 'high'; // < 5 minutes
    if (timeToPickup < 15 * 60 * 1000) return 'medium'; // < 15 minutes
    return 'low';
  }

  /**
   * Standardize address format
   */
  protected standardizeAddress(address: string): string {
    return address
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/,\s*,/g, ','); // Remove double commas
  }

  /**
   * Log platform-specific events
   */
  protected logEvent(event: string, data?: any): void {
    console.log(`📊 [${this.platform.name}] ${event}`, data ? JSON.stringify(data) : '');
  }

  /**
   * Get platform configuration
   */
  public getConfig(): PlatformConfig {
    return this.platform;
  }

  /**
   * Get platform capabilities
   */
  public abstract getCapabilities(): PlatformCapabilities;

  /**
   * Test connection to platform
   */
  async testConnection(): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const startTime = Date.now();
    
    try {
      await this.makeAuthenticatedRequest('GET', '/ping');
      const latencyMs = Date.now() - startTime;
      
      return { success: true, latencyMs };
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      
      return {
        success: false,
        latencyMs,
        error: error.message || 'Connection test failed'
      };
    }
  }

  /**
   * Handle webhook payload from platform
   */
  public abstract handleWebhook(payload: any, signature?: string): Promise<void>;

  /**
   * Cleanup resources when adapter is destroyed
   */
  public async cleanup(): Promise<void> {
    this.isAuthenticated = false;
    this.lastSyncAt = null;
    // Cleanup any active connections, timers, etc.
  }
}