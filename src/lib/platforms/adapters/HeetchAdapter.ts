/**
 * Heetch Platform Adapter - FOREAS Driver
 * 
 * Integrates with Heetch Driver API for trip requests and management
 * Template implementation for external platform integration
 */

import axios from 'axios';
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

export interface HeetchCredentials extends PlatformCredentials {
  username: string;
  password: string;
  sessionToken?: string;
  driverId?: string;
}

export class HeetchAdapter extends AbstractPlatformAdapter {
  private sessionToken: string | null = null;
  private heetchDriverId: string | null = null;

  constructor() {
    const config: PlatformConfig = {
      id: Platform.HEETCH,
      name: 'Heetch',
      apiVersion: '1.0',
      baseUrl: 'https://api.heetch.com',
      authType: 'session',
      rateLimit: {
        requestsPerMinute: 30,
        requestsPerHour: 500,
      },
      retryPolicy: {
        maxRetries: 2,
        backoffMs: 2000,
      },
    };

    super(config);
  }

  protected initializeApiClient(): void {
    this.apiClient = axios.create({
      baseURL: this.platform.baseUrl,
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FOREAS-Driver/1.0',
        'X-Platform': 'FOREAS',
      },
    });

    // Add request interceptor for session authentication
    this.apiClient.interceptors.request.use(
      (config: any) => {
        if (this.sessionToken) {
          config.headers['X-Session-Token'] = this.sessionToken;
        }
        return config;
      },
      (error: any) => Promise.reject(error)
    );
  }

  async authenticate(credentials: HeetchCredentials): Promise<boolean> {
    try {
      const { username, password, sessionToken } = credentials;

      if (sessionToken) {
        // Use existing session token
        this.sessionToken = sessionToken;
        
        // Validate token
        const response = await this.makeAuthenticatedRequest('GET', '/v1/driver/profile');
        this.heetchDriverId = response.driver_id;
      } else {
        // Perform login
        const loginResponse = await this.apiClient.post('/v1/auth/driver/login', {
          email: username,
          password: password,
        });

        this.sessionToken = loginResponse.data.session_token;
        this.heetchDriverId = loginResponse.data.driver.id;
      }

      this.isAuthenticated = true;
      this.lastSyncAt = new Date();
      
      this.logEvent('Heetch authentication successful', { 
        driverId: this.heetchDriverId 
      });
      
      return true;
    } catch (error: any) {
      console.error('❌ Heetch authentication failed:', error);
      this.isAuthenticated = false;
      return false;
    }
  }

  async getAvailableBookings(): Promise<BookingRequest[]> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET', 
        '/v1/driver/rides/available'
      );

      return response.rides?.map((ride: any) => this.transformBookingData(ride)) || [];
    } catch (error: any) {
      console.error('❌ Failed to get Heetch bookings:', error);
      
      if (error.response?.status === 404) {
        return [];
      }
      
      throw error;
    }
  }

  async acceptBooking(bookingId: string): Promise<BookingAcceptance> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'POST',
        `/v1/driver/rides/${bookingId}/accept`
      );

      this.logEvent('Heetch booking accepted', { bookingId });

      return {
        bookingId,
        success: true,
        message: 'Ride accepted successfully',
        estimatedArrival: response.eta ? new Date(response.eta) : undefined,
      };
    } catch (error: any) {
      console.error('❌ Failed to accept Heetch booking:', error);
      throw new Error(`Failed to accept Heetch ride: ${error.response?.data?.message || error.message}`);
    }
  }

  async rejectBooking(bookingId: string, reason?: string): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
    }

    try {
      await this.makeAuthenticatedRequest(
        'POST',
        `/v1/driver/rides/${bookingId}/decline`,
        { reason: reason || 'not_available' }
      );

      this.logEvent('Heetch booking rejected', { bookingId, reason });
    } catch (error: any) {
      console.error('❌ Failed to reject Heetch booking:', error);
      throw new Error(`Failed to reject Heetch ride: ${error.response?.data?.message || error.message}`);
    }
  }

  async updateLocation(lat: number, lng: number): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
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

      this.logEvent('Heetch location updated', { lat, lng });
    } catch (error: any) {
      console.error('❌ Failed to update Heetch location:', error);
      throw error;
    }
  }

  async setAvailability(isAvailable: boolean): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
    }

    try {
      await this.makeAuthenticatedRequest(
        'PUT',
        '/v1/driver/status',
        { 
          available: isAvailable,
          timestamp: Date.now(),
        }
      );

      this.logEvent('Heetch availability updated', { isAvailable });
    } catch (error: any) {
      console.error('❌ Failed to set Heetch availability:', error);
      throw error;
    }
  }

  async getEarnings(period: { from: Date; to: Date }): Promise<EarningsSummary> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
    }

    try {
      // Heetch might have limited earnings API
      const response = await this.makeAuthenticatedRequest(
        'GET',
        '/v1/driver/earnings',
        {
          params: {
            start: period.from.toISOString().split('T')[0],
            end: period.to.toISOString().split('T')[0],
          },
        }
      );

      const earnings = response.earnings || {};

      return {
        platform: Platform.HEETCH,
        period,
        grossEarnings: earnings.total || 0,
        commission: earnings.commission || 0,
        netEarnings: earnings.net || 0,
        rideCount: earnings.ride_count || 0,
        averageRideValue: earnings.ride_count > 0 ? earnings.total / earnings.ride_count : 0,
        tips: earnings.tips || 0,
        bonuses: earnings.bonuses || 0,
      };
    } catch (error: any) {
      console.error('❌ Failed to get Heetch earnings:', error);
      
      // Return empty if not supported
      if (error.response?.status === 404) {
        return {
          platform: Platform.HEETCH,
          period,
          grossEarnings: 0,
          commission: 0,
          netEarnings: 0,
          rideCount: 0,
          averageRideValue: 0,
          tips: 0,
          bonuses: 0,
        };
      }
      
      throw error;
    }
  }

  async getStatus(): Promise<PlatformStatus> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Heetch');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET',
        '/v1/driver/status'
      );

      return {
        isOnline: response.is_online,
        lastHeartbeat: new Date(response.last_activity),
        pendingRequests: response.pending_rides || 0,
        activeRides: response.active_rides || 0,
        todayStats: {
          ridesCompleted: response.today?.completed || 0,
          earnings: response.today?.earnings || 0,
          onlineHours: response.today?.online_hours || 0,
        },
      };
    } catch (error: any) {
      console.error('❌ Failed to get Heetch status:', error);
      throw error;
    }
  }

  public getCapabilities(): PlatformCapabilities {
    return {
      canReceiveBookings: true,
      canAcceptReject: true,
      canTrackEarnings: false, // Limited earnings API
      canManageAvailability: true,
      hasWebhooks: false, // Heetch uses polling
      supportsBulkOperations: false,
      supportsRealTimeLocation: true,
    };
  }

  protected transformBookingData(heetchRide: any): BookingRequest {
    return {
      id: heetchRide.id,
      platform: Platform.HEETCH,
      pickup: {
        address: this.standardizeAddress(heetchRide.pickup.address),
        lat: heetchRide.pickup.latitude,
        lng: heetchRide.pickup.longitude,
        time: new Date(heetchRide.pickup_time),
      },
      dropoff: heetchRide.dropoff ? {
        address: this.standardizeAddress(heetchRide.dropoff.address),
        lat: heetchRide.dropoff.latitude,
        lng: heetchRide.dropoff.longitude,
      } : undefined,
      estimatedFare: Math.round(heetchRide.estimated_fare * 100), // Convert to centimes
      estimatedDuration: heetchRide.estimated_duration,
      distance: heetchRide.estimated_distance,
      clientInfo: {
        firstName: heetchRide.passenger?.first_name,
        rating: heetchRide.passenger?.rating,
        preferences: heetchRide.passenger?.preferences || [],
      },
      specialRequests: heetchRide.special_requests || [],
      urgency: this.calculateUrgency({
        pickup_time: heetchRide.pickup_time,
      }),
      expiresAt: new Date(Date.now() + 60000), // 60 seconds to accept (Heetch standard)
    };
  }

  public async handleWebhook(payload: any, signature?: string): Promise<void> {
    // Heetch typically doesn't use webhooks
    this.logEvent('Heetch webhook received (unusual)', { type: payload.type });

    switch (payload.type) {
      case 'ride_assigned':
        this.logEvent('Ride assigned', payload.data);
        break;
      case 'ride_completed':
        this.logEvent('Ride completed', payload.data);
        break;
      default:
        this.logEvent('Unknown Heetch event', { type: payload.type });
    }
  }
}