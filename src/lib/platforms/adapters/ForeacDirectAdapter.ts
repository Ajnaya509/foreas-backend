/**
 * FOREAS Direct Platform Adapter
 * 
 * Handles direct bookings within the FOREAS ecosystem
 * This is the reference implementation for the AbstractPlatformAdapter
 */

import { Platform } from '@prisma/client';
import { prisma } from '@/lib/db';
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

export class ForeacDirectAdapter extends AbstractPlatformAdapter {
  private driverId: string | null = null;

  constructor() {
    const config: PlatformConfig = {
      id: Platform.FOREAS_DIRECT,
      name: 'FOREAS Direct',
      apiVersion: '1.0',
      authType: 'session',
      rateLimit: {
        requestsPerMinute: 1000, // No rate limiting for internal API
        requestsPerHour: 60000,
      },
      retryPolicy: {
        maxRetries: 3,
        backoffMs: 1000,
      },
    };

    super(config);
  }

  protected initializeApiClient(): void {
    // For FOREAS Direct, we use direct database access
    // No external API client needed
    this.apiClient = {
      request: async ({ method, url, data }: any) => {
        // Mock API client for consistency with other adapters
        return { data: null };
      }
    };
  }

  async authenticate(credentials: PlatformCredentials): Promise<boolean> {
    try {
      // For FOREAS Direct, credentials contain the driver session
      const { driverId, sessionToken } = credentials;
      
      // Validate session token (simplified)
      const driver = await prisma.driver.findUnique({
        where: { id: driverId },
        include: { user: true },
      });

      if (!driver) {
        return false;
      }

      this.driverId = driverId;
      this.isAuthenticated = true;
      this.lastSyncAt = new Date();
      
      this.logEvent('Authentication successful', { driverId });
      return true;
    } catch (error) {
      console.error('❌ FOREAS Direct authentication failed:', error);
      return false;
    }
  }

  async getAvailableBookings(): Promise<BookingRequest[]> {
    if (!this.isAuthenticated || !this.driverId) {
      throw new Error('Not authenticated');
    }

    try {
      // Get pending direct bookings assigned to this driver
      const bookings = await prisma.booking.findMany({
        where: {
          driverId: this.driverId,
          status: 'PENDING',
          scheduledFor: {
            gte: new Date(), // Only future bookings
            lte: new Date(Date.now() + 24 * 60 * 60 * 1000), // Within next 24 hours
          },
        },
        include: {
          client: true,
        },
        orderBy: {
          scheduledFor: 'asc',
        },
      });

      return bookings.map(booking => this.transformBookingData(booking));
    } catch (error) {
      console.error('❌ Failed to get FOREAS Direct bookings:', error);
      throw error;
    }
  }

  async acceptBooking(bookingId: string): Promise<BookingAcceptance> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated');
    }

    try {
      const booking = await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
        include: {
          client: true,
          driver: { include: { user: true } },
        },
      });

      // Create Ajnaya insight for successful booking acceptance
      await prisma.ajnayaInsight.create({
        data: {
          driverId: booking.driverId,
          type: 'EARNINGS_BOOST',
          priority: 'HIGH',
          title: '✅ Réservation confirmée',
          message: `Réservation acceptée: ${booking.pickupAddress}${booking.dropoffAddress ? ' → ' + booking.dropoffAddress : ''}. Revenue estimé: ${booking.proposedPrice?.toFixed(2) || 'N/A'}€`,
          data: {
            bookingId: booking.id,
            clientName: booking.client.name,
            scheduledFor: booking.scheduledFor,
            estimatedRevenue: booking.proposedPrice,
            source: 'foreas_direct',
          },
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
        },
      });

      this.logEvent('Booking accepted', { bookingId, clientName: booking.client.name });

      return {
        bookingId,
        success: true,
        message: 'Booking confirmed successfully',
        estimatedArrival: booking.scheduledFor,
        trackingUrl: `https://foreas.app/track/${bookingId}`,
      };
    } catch (error: any) {
      console.error('❌ Failed to accept FOREAS Direct booking:', error);
      throw new Error(`Failed to accept booking: ${error.message}`);
    }
  }

  async rejectBooking(bookingId: string, reason?: string): Promise<void> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated');
    }

    try {
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          driverNotes: reason ? `Rejected: ${reason}` : 'Rejected by driver',
        },
      });

      this.logEvent('Booking rejected', { bookingId, reason });
    } catch (error: any) {
      console.error('❌ Failed to reject FOREAS Direct booking:', error);
      throw new Error(`Failed to reject booking: ${error.message}`);
    }
  }

  async updateLocation(lat: number, lng: number): Promise<void> {
    if (!this.isAuthenticated || !this.driverId) {
      throw new Error('Not authenticated');
    }

    try {
      // For FOREAS Direct, we could store location in a separate table
      // or update the driver record with last known location
      // This is a simplified implementation
      
      await prisma.driver.update({
        where: { id: this.driverId },
        data: {
          updatedAt: new Date(), // Update timestamp to show activity
        },
      });

      this.logEvent('Location updated', { lat, lng });
    } catch (error: any) {
      console.error('❌ Failed to update location for FOREAS Direct:', error);
      throw error;
    }
  }

  async setAvailability(isAvailable: boolean): Promise<void> {
    if (!this.isAuthenticated || !this.driverId) {
      throw new Error('Not authenticated');
    }

    try {
      // For FOREAS Direct, we could use a separate availability tracking system
      // This is a simplified implementation using user status
      
      await prisma.user.update({
        where: { 
          id: await this.getUserIdFromDriverId(this.driverId) 
        },
        data: {
          status: isAvailable ? 'ACTIVE' : 'PENDING',
          lastLoginAt: isAvailable ? new Date() : undefined,
        },
      });

      this.logEvent('Availability updated', { isAvailable });
    } catch (error: any) {
      console.error('❌ Failed to set availability for FOREAS Direct:', error);
      throw error;
    }
  }

  async getEarnings(period: { from: Date; to: Date }): Promise<EarningsSummary> {
    if (!this.isAuthenticated || !this.driverId) {
      throw new Error('Not authenticated');
    }

    try {
      const earnings = await prisma.earning.findMany({
        where: {
          driverId: this.driverId,
          earnedAt: {
            gte: period.from,
            lte: period.to,
          },
          type: 'BOOKING', // Only direct bookings
        },
      });

      const totalAmount = earnings.reduce((sum, earning) => sum + earning.amount, 0);
      const rideCount = earnings.length;

      // For FOREAS Direct, commission is lower (5-15%)
      const avgCommissionRate = 0.10; // 10% average
      const commission = totalAmount * avgCommissionRate;
      const netEarnings = totalAmount - commission;

      return {
        platform: Platform.FOREAS_DIRECT,
        period,
        grossEarnings: totalAmount,
        commission,
        netEarnings,
        rideCount,
        averageRideValue: rideCount > 0 ? totalAmount / rideCount : 0,
        tips: 0, // Tips are tracked separately
        bonuses: 0,
      };
    } catch (error: any) {
      console.error('❌ Failed to get FOREAS Direct earnings:', error);
      throw error;
    }
  }

  async getStatus(): Promise<PlatformStatus> {
    if (!this.isAuthenticated || !this.driverId) {
      throw new Error('Not authenticated');
    }

    try {
      const driver = await prisma.driver.findUnique({
        where: { id: this.driverId },
        include: {
          user: true,
          bookings: {
            where: {
              status: 'IN_PROGRESS',
            },
          },
        },
      });

      if (!driver) {
        throw new Error('Driver not found');
      }

      const todayEarnings = await this.getTodayEarnings();

      return {
        isOnline: driver.user.status === 'ACTIVE',
        lastHeartbeat: driver.updatedAt,
        pendingRequests: 0, // Would require separate tracking
        activeRides: driver.bookings.length,
        todayStats: {
          ridesCompleted: 0, // Would require calculation
          earnings: todayEarnings,
          onlineHours: 0, // Would require tracking
        },
      };
    } catch (error: any) {
      console.error('❌ Failed to get FOREAS Direct status:', error);
      throw error;
    }
  }

  public getCapabilities(): PlatformCapabilities {
    return {
      canReceiveBookings: true,
      canAcceptReject: true,
      canTrackEarnings: true,
      canManageAvailability: true,
      hasWebhooks: true, // Internal webhooks
      supportsBulkOperations: true,
      supportsRealTimeLocation: true,
    };
  }

  protected transformBookingData(booking: any): BookingRequest {
    return {
      id: booking.id,
      platform: Platform.FOREAS_DIRECT,
      pickup: {
        address: this.standardizeAddress(booking.pickupAddress),
        lat: booking.pickupLat || 0,
        lng: booking.pickupLng || 0,
        time: booking.scheduledFor,
      },
      dropoff: booking.dropoffAddress ? {
        address: this.standardizeAddress(booking.dropoffAddress),
        lat: booking.dropoffLat || 0,
        lng: booking.dropoffLng || 0,
      } : undefined,
      estimatedFare: (booking.proposedPrice || 0) * 100, // Convert to centimes
      estimatedDuration: booking.estimatedDuration || 30,
      distance: 0, // Would be calculated
      clientInfo: {
        firstName: booking.client?.name?.split(' ')[0],
        rating: undefined, // Could be tracked
        preferences: [],
      },
      specialRequests: booking.clientNotes ? [booking.clientNotes] : [],
      urgency: this.calculateUrgency({
        pickup_time: booking.scheduledFor,
      }),
      expiresAt: new Date(booking.scheduledFor.getTime() - 15 * 60 * 1000), // 15 min before pickup
    };
  }

  public async handleWebhook(payload: any, signature?: string): Promise<void> {
    // For FOREAS Direct, webhooks are internal events
    // This could handle payment confirmations, booking updates, etc.
    
    this.logEvent('Webhook received', { type: payload.type });
    
    switch (payload.type) {
      case 'booking.updated':
        await this.handleBookingUpdate(payload.data);
        break;
      case 'payment.completed':
        await this.handlePaymentCompleted(payload.data);
        break;
      default:
        this.logEvent('Unknown webhook type', { type: payload.type });
    }
  }

  private async handleBookingUpdate(data: any): Promise<void> {
    // Handle booking status updates
    this.logEvent('Booking updated', data);
  }

  private async handlePaymentCompleted(data: any): Promise<void> {
    // Handle payment completion
    this.logEvent('Payment completed', data);
  }

  private async getUserIdFromDriverId(driverId: string): Promise<string> {
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
    
    if (!driver) {
      throw new Error('Driver not found');
    }
    
    return driver.userId;
  }
}