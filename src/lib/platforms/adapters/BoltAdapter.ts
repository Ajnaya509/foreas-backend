/**
 * Bolt Platform Adapter - FOREAS Driver
 * 
 * Integrates with Bolt Driver API for trip requests and management
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

export interface BoltCredentials extends PlatformCredentials {
  apiKey: string;
  driverId: string;
}

export class BoltAdapter extends AbstractPlatformAdapter {
  private apiKey: string | null = null;
  private boltDriverId: string | null = null;

  constructor() {
    const config: PlatformConfig = {
      id: Platform.BOLT,
      name: 'Bolt',
      apiVersion: '2.0',
      baseUrl: 'https://api.bolt.eu',
      authType: 'api_key',
      rateLimit: {
        requestsPerMinute: 60,
        requestsPerHour: 1500,
      },
      retryPolicy: {
        maxRetries: 3,
        backoffMs: 1500,
      },
    };

    super(config);
  }

  protected initializeApiClient(): void {
    this.apiClient = axios.create({
      baseURL: this.platform.baseUrl,
      timeout: 25000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FOREAS-Driver/1.0',
      },
    });

    // Add request interceptor for API key authentication
    this.apiClient.interceptors.request.use(
      (config: any) => {
        if (this.apiKey) {
          config.headers['X-API-Key'] = this.apiKey;
        }
        return config;
      },
      (error: any) => Promise.reject(error)
    );
  }

  async authenticate(credentials: BoltCredentials): Promise<boolean> {
    try {
      this.apiKey = credentials.apiKey;
      this.boltDriverId = credentials.driverId;

      // Test the API key by getting driver info
      const response = await this.makeAuthenticatedRequest(
        'GET', 
        `/driver/v2/profile/${this.boltDriverId}`
      );

      if (response.driver_id !== this.boltDriverId) {
        throw new Error('Driver ID mismatch');
      }

      this.isAuthenticated = true;
      this.lastSyncAt = new Date();
      
      this.logEvent('Bolt authentication successful', { 
        driverId: this.boltDriverId 
      });
      
      return true;
    } catch (error: any) {
      console.error('❌ Bolt authentication failed:', error);
      this.isAuthenticated = false;
      return false;
    }
  }

  async getAvailableBookings(): Promise<BookingRequest[]> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET', 
        `/driver/v2/orders/available?driver_id=${this.boltDriverId}`
      );

      return response.orders?.map((order: any) => this.transformBookingData(order)) || [];
    } catch (error: any) {
      console.error('❌ Failed to get Bolt bookings:', error);
      
      if (error.response?.status === 404) {
        return [];
      }
      
      throw error;
    }
  }

  async acceptBooking(bookingId: string): Promise<BookingAcceptance> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'POST',
        `/driver/v2/orders/${bookingId}/accept`,
        { driver_id: this.boltDriverId }
      );

      this.logEvent('Bolt booking accepted', { bookingId });

      return {
        bookingId,
        success: true,
        message: 'Order accepted successfully',
        estimatedArrival: response.estimated_arrival ? new Date(response.estimated_arrival) : undefined,
      };
    } catch (error: any) {
      console.error('❌ Failed to accept Bolt booking:', error);
      throw new Error(`Failed to accept Bolt order: ${error.response?.data?.error || error.message}`);
    }
  }

  async rejectBooking(bookingId: string, reason?: string): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      await this.makeAuthenticatedRequest(
        'POST',
        `/driver/v2/orders/${bookingId}/decline`,
        { 
          driver_id: this.boltDriverId,
          reason: reason || 'driver_unavailable' 
        }
      );

      this.logEvent('Bolt booking rejected', { bookingId, reason });
    } catch (error: any) {
      console.error('❌ Failed to reject Bolt booking:', error);
      throw new Error(`Failed to reject Bolt order: ${error.response?.data?.error || error.message}`);
    }
  }

  async updateLocation(lat: number, lng: number): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      await this.makeAuthenticatedRequest(
        'PUT',
        `/driver/v2/location`,
        {
          driver_id: this.boltDriverId,
          latitude: lat,
          longitude: lng,
          timestamp: Math.floor(Date.now() / 1000),
        }
      );

      this.logEvent('Bolt location updated', { lat, lng });
    } catch (error: any) {
      console.error('❌ Failed to update Bolt location:', error);
      throw error;
    }
  }

  async setAvailability(isAvailable: boolean): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      await this.makeAuthenticatedRequest(
        'PUT',
        `/driver/v2/status`,
        { 
          driver_id: this.boltDriverId,
          status: isAvailable ? 'online' : 'offline',
        }
      );

      this.logEvent('Bolt availability updated', { isAvailable });
    } catch (error: any) {
      console.error('❌ Failed to set Bolt availability:', error);
      throw error;
    }
  }

  async getEarnings(period: { from: Date; to: Date }): Promise<EarningsSummary> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET',
        `/driver/v2/earnings`,
        {
          params: {
            driver_id: this.boltDriverId,
            from: period.from.toISOString().split('T')[0],
            to: period.to.toISOString().split('T')[0],
          },
        }
      );

      const { summary, trips } = response;

      return {
        platform: Platform.BOLT,
        period,
        grossEarnings: summary.gross_earnings,
        commission: summary.bolt_commission,
        netEarnings: summary.net_earnings,
        rideCount: trips.length,
        averageRideValue: trips.length > 0 ? summary.gross_earnings / trips.length : 0,
        tips: summary.tips || 0,
        bonuses: summary.bonuses || 0,
      };
    } catch (error: any) {
      console.error('❌ Failed to get Bolt earnings:', error);
      throw error;
    }
  }

  async getStatus(): Promise<PlatformStatus> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated with Bolt');
    }

    try {
      const response = await this.makeAuthenticatedRequest(
        'GET',
        `/driver/v2/status/${this.boltDriverId}`
      );

      return {
        isOnline: response.status === 'online',
        lastHeartbeat: new Date(response.last_active * 1000),
        pendingRequests: response.pending_orders || 0,
        activeRides: response.active_orders || 0,
        todayStats: {
          ridesCompleted: response.today?.completed_orders || 0,
          earnings: response.today?.earnings || 0,
          onlineHours: response.today?.online_minutes ? response.today.online_minutes / 60 : 0,
        },
      };
    } catch (error: any) {
      console.error('❌ Failed to get Bolt status:', error);
      throw error;
    }
  }

  public getCapabilities(): PlatformCapabilities {
    return {
      canReceiveBookings: true,
      canAcceptReject: true,
      canTrackEarnings: true,
      canManageAvailability: true,
      hasWebhooks: false, // Bolt typically uses polling
      supportsBulkOperations: true,
      supportsRealTimeLocation: true,
    };
  }

  protected transformBookingData(boltOrder: any): BookingRequest {
    return {
      id: boltOrder.order_id,
      platform: Platform.BOLT,
      pickup: {
        address: this.standardizeAddress(boltOrder.pickup.address),
        lat: boltOrder.pickup.lat,
        lng: boltOrder.pickup.lng,
        time: new Date(boltOrder.pickup_time * 1000),
      },
      dropoff: boltOrder.destination ? {
        address: this.standardizeAddress(boltOrder.destination.address),
        lat: boltOrder.destination.lat,
        lng: boltOrder.destination.lng,
      } : undefined,
      estimatedFare: Math.round(boltOrder.price * 100), // Convert to centimes
      estimatedDuration: boltOrder.estimated_duration_minutes,
      distance: boltOrder.estimated_distance_km,
      clientInfo: {
        firstName: boltOrder.passenger?.name,
        rating: boltOrder.passenger?.rating,
        preferences: [],
      },
      specialRequests: boltOrder.notes ? [boltOrder.notes] : [],
      urgency: this.calculateUrgency({
        pickup_time: boltOrder.pickup_time * 1000,
      }),
      expiresAt: new Date(Date.now() + 45000), // 45 seconds to accept (Bolt standard)
    };
  }

  public async handleWebhook(payload: any, signature?: string): Promise<void> {
    // Bolt typically doesn't use webhooks - they prefer polling
    // But if they did, it would look like this:
    
    this.logEvent('Bolt webhook received (unusual)', { type: payload.event });

    switch (payload.event) {
      case 'order_assigned':
        this.logEvent('Order assigned', payload.data);
        break;
      case 'order_completed':
        this.logEvent('Order completed', payload.data);
        break;
      default:
        this.logEvent('Unknown Bolt event', { event: payload.event });
    }
  }
}