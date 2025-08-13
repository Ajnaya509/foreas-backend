/**
 * Uber Platform Adapter - FOREAS Driver
 * 
 * Integrates with Uber Driver API for trip requests and management
 * This is a template/skeleton for external platform integration
 */

import axios, { AxiosInstance } from 'axios';
import { Platform } from '@prisma/client';
import { 
  AbstractPlatformAdapter, 
  PlatformCapabilities, 
  PlatformConfig,
  PlatformCredentials,
  BookingAcceptance,
  EarningsSummary,
  PlatformStatus
} from './AbstractPlatformAdapter';
import { BookingRequest } from '../PlatformManager';

export interface UberCredentials extends PlatformCredentials {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  driverId?: string;
}

export class UberAdapter extends AbstractPlatformAdapter {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private uberDriverId: string | null = null;

  constructor() {
    const config: PlatformConfig = {
      id: Platform.UBER,
      name: 'Uber',
      apiVersion: '1.2',
      baseUrl: 'https://api.uber.com',
      authType: 'oauth2',
      rateLimit: {
        requestsPerMinute: 50,
        requestsPerHour: 1000,
      },
      retryPolicy: {
        maxRetries: 3,
        backoffMs: 1000,
      },
    };

    super(config);
  }

  protected initializeApiClient(): void {
    this.apiClient = axios.create({
      baseURL: this.platform.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FOREAS-Driver/1.0',
      },
    });

    // Add request interceptor for authentication
    this.apiClient.interceptors.request.use(
      (config: any) => {
        if (this.accessToken) {
          config.headers.Authorization = `Bearer ${this.accessToken}`;
        }
        return config;
      },
      (error: any) => Promise.reject(error)
    );

    // Add response interceptor for error handling
    this.apiClient.interceptors.response.use(
      (response: any) => response,
      async (error: any) => {
        if (error.response?.status === 401 && this.refreshToken) {
          try {
            await this.refreshAccessToken();
            // Retry the original request
            return this.apiClient.request(error.config);
          } catch (refreshError) {
            this.isAuthenticated = false;
            throw refreshError;
          }
        }
        return Promise.reject(error);
      }
    );
  }

  async authenticate(credentials: UberCredentials): Promise<boolean> {
    try {
      const { clientId, clientSecret, accessToken, refreshToken } = credentials;

      if (accessToken && refreshToken) {
        // Use existing tokens
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
      } else {
        // Perform OAuth2 flow (would typically require user interaction)
        // This is a simplified version - real implementation would use OAuth2 flow
        const tokenResponse = await this.apiClient.post('/oauth/v2/token', {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          scope: 'driver',
        });

        this.accessToken = tokenResponse.data.access_token;
        this.refreshToken = tokenResponse.data.refresh_token;
      }

      // Test the token by getting driver profile
      const profileResponse = await this.makeAuthenticatedRequest('GET', '/v1/me');
      this.uberDriverId = profileResponse.driver_id;

      this.isAuthenticated = true;
      this.lastSyncAt = new Date();
      
      this.logEvent('Uber authentication successful', { 
        driverId: this.uberDriverId 
      });
      
      return true;
    } catch (error: any) {
      console.error('❌ Uber authentication failed:', error);
      this.isAuthenticated = false;
      return false;
    }
  }

  async getAvailableBookings(): Promise<BookingRequest[]> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      // Note: This endpoint is fictional - real Uber API structure may differ
      const response = await this.makeAuthenticatedRequest(
        'GET', 
        '/v1/driver/trips/available'
      );

      return response.trips?.map((trip: any) => this.transformBookingData(trip)) || [];
    } catch (error: any) {
      console.error('❌ Failed to get Uber bookings:', error);
      
      // Return empty array if no trips available
      if (error.response?.status === 404) {
        return [];
      }
      
      throw error;
    }
  }

  async acceptBooking(bookingId: string): Promise<BookingAcceptance> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'POST',
        `/v1/driver/trips/${bookingId}/accept`
      );

      this.logEvent('Uber booking accepted', { bookingId });

      return {
        bookingId,
        success: true,
        message: 'Trip accepted successfully',
        estimatedArrival: response.estimated_arrival ? new Date(response.estimated_arrival) : undefined,
        trackingUrl: response.tracking_url,
      };
    } catch (error: any) {
      console.error('❌ Failed to accept Uber booking:', error);
      throw new Error(`Failed to accept Uber trip: ${error.response?.data?.message || error.message}`);
    }
  }

  async rejectBooking(bookingId: string, reason?: string): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      await this.makeAuthenticatedRequest(
        'POST',
        `/v1/driver/trips/${bookingId}/decline`,
        { reason: reason || 'driver_declined' }
      );

      this.logEvent('Uber booking rejected', { bookingId, reason });
    } catch (error: any) {
      console.error('❌ Failed to reject Uber booking:', error);
      throw new Error(`Failed to reject Uber trip: ${error.response?.data?.message || error.message}`);
    }
  }

  async updateLocation(lat: number, lng: number): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      await this.makeAuthenticatedRequest(
        'PUT',
        '/v1/driver/location',
        {
          latitude: lat,
          longitude: lng,
          timestamp: Date.now(),
        }
      );

      this.logEvent('Uber location updated', { lat, lng });
    } catch (error: any) {
      console.error('❌ Failed to update Uber location:', error);
      throw error;
    }
  }

  async setAvailability(isAvailable: boolean): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      await this.makeAuthenticatedRequest(
        'PUT',
        '/v1/driver/availability',
        { 
          is_available: isAvailable,
          timestamp: Date.now(),
        }
      );

      this.logEvent('Uber availability updated', { isAvailable });
    } catch (error: any) {
      console.error('❌ Failed to set Uber availability:', error);
      throw error;
    }
  }

  async getEarnings(period: { from: Date; to: Date }): Promise<EarningsSummary> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET',
        '/v1/driver/earnings',
        {
          params: {
            start_date: period.from.toISOString().split('T')[0],
            end_date: period.to.toISOString().split('T')[0],
          },
        }
      );

      const { trips, earnings } = response;

      return {
        platform: Platform.UBER,
        period,
        grossEarnings: earnings.total_earnings,
        commission: earnings.uber_fee,
        netEarnings: earnings.driver_earnings,
        rideCount: trips.length,
        averageRideValue: trips.length > 0 ? earnings.total_earnings / trips.length : 0,
        tips: earnings.tips || 0,
        bonuses: earnings.bonuses || 0,
      };
    } catch (error: any) {
      console.error('❌ Failed to get Uber earnings:', error);
      throw error;
    }
  }

  async getStatus(): Promise<PlatformStatus> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Uber');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET',
        '/v1/driver/status'
      );

      return {
        isOnline: response.is_online,
        lastHeartbeat: new Date(response.last_heartbeat),
        pendingRequests: response.pending_requests || 0,
        activeRides: response.active_trips || 0,
        todayStats: {
          ridesCompleted: response.today_stats?.rides_completed || 0,
          earnings: response.today_stats?.earnings || 0,
          onlineHours: response.today_stats?.online_hours || 0,
        },
      };
    } catch (error: any) {
      console.error('❌ Failed to get Uber status:', error);
      throw error;
    }
  }

  public getCapabilities(): PlatformCapabilities {
    return {
      canReceiveBookings: true,
      canAcceptReject: true,
      canTrackEarnings: true,
      canManageAvailability: true,
      hasWebhooks: true,
      supportsBulkOperations: false,
      supportsRealTimeLocation: true,
    };
  }

  protected transformBookingData(uberTrip: any): BookingRequest {
    return {
      id: uberTrip.trip_id,
      platform: Platform.UBER,
      pickup: {
        address: this.standardizeAddress(uberTrip.pickup.address),
        lat: uberTrip.pickup.latitude,
        lng: uberTrip.pickup.longitude,
        time: new Date(uberTrip.pickup_time),
      },
      dropoff: uberTrip.destination ? {
        address: this.standardizeAddress(uberTrip.destination.address),
        lat: uberTrip.destination.latitude,
        lng: uberTrip.destination.longitude,
      } : undefined,
      estimatedFare: Math.round(uberTrip.fare_estimate * 100), // Convert to centimes
      estimatedDuration: uberTrip.duration_estimate,
      distance: uberTrip.distance_estimate,
      clientInfo: {
        firstName: uberTrip.rider?.first_name,
        rating: uberTrip.rider?.rating,
        preferences: uberTrip.rider?.preferences || [],
      },
      specialRequests: uberTrip.special_requests || [],
      urgency: this.calculateUrgency(uberTrip),
      expiresAt: new Date(Date.now() + 30000), // 30 seconds to accept (Uber standard)
    };
  }

  public async handleWebhook(payload: any, signature?: string): Promise<void> {
    // Verify webhook signature (Uber provides signature validation)
    if (signature && !this.verifyWebhookSignature(payload, signature)) {
      throw new Error('Invalid webhook signature');
    }

    this.logEvent('Uber webhook received', { type: payload.event_type });

    switch (payload.event_type) {
      case 'trip_request':
        await this.handleTripRequest(payload.data);
        break;
      case 'trip_accepted':
        await this.handleTripAccepted(payload.data);
        break;
      case 'trip_completed':
        await this.handleTripCompleted(payload.data);
        break;
      case 'trip_cancelled':
        await this.handleTripCancelled(payload.data);
        break;
      default:
        this.logEvent('Unknown Uber webhook type', { type: payload.event_type });
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await this.apiClient.post('/oauth/v2/token', {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      });

      this.accessToken = response.data.access_token;
      if (response.data.refresh_token) {
        this.refreshToken = response.data.refresh_token;
      }

      this.logEvent('Access token refreshed');
    } catch (error) {
      console.error('❌ Failed to refresh Uber access token:', error);
      throw error;
    }
  }

  private verifyWebhookSignature(payload: any, signature: string): boolean {
    // Implement Uber's webhook signature verification
    // This would use the webhook secret provided by Uber
    return true; // Simplified for now
  }

  private async handleTripRequest(data: any): Promise<void> {
    this.logEvent('Trip request received', data);
    // Notify FOREAS system of new trip request
  }

  private async handleTripAccepted(data: any): Promise<void> {
    this.logEvent('Trip accepted', data);
    // Update local booking status
  }

  private async handleTripCompleted(data: any): Promise<void> {
    this.logEvent('Trip completed', data);
    // Process earnings and update stats
  }

  private async handleTripCancelled(data: any): Promise<void> {
    this.logEvent('Trip cancelled', data);
    // Handle cancellation logic
  }
}