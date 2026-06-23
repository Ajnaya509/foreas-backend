/**
 * Bolt Fleet Integration Service
 * ================================
 * OAuth2 Client Credentials + auto-refresh token (8 min cycle)
 * Scrape automatique des courses, chauffeurs, véhicules depuis Bolt Fleet API
 *
 * Données récupérées :
 * - Courses (pickup/dropoff, prix, distance, statut, timestamps)
 * - Chauffeurs (nom, score, rating, catégories, véhicule)
 * - Véhicules (modèle, plaque, état)
 * - Logs d'état (online/offline, activité)
 *
 * Usage dans FOREAS :
 * - Feed Ajnaya avec données réelles Bolt
 * - Stats chauffeur automatiques (CA, courses, zones)
 * - Détection patterns (annulations, no-shows, heures mortes)
 * - Scraping passif sans action du chauffeur
 */

import fetch from 'node-fetch';

// ── Config ──
const BOLT_OIDC_URL = 'https://oidc.bolt.eu/token';
const BOLT_API_BASE = 'https://node.bolt.eu/fleet-integration-gateway';
const TOKEN_REFRESH_MS = 8 * 60 * 1000; // 8 min (token expire à 10 min)

// ── Types ──
export interface BoltToken {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  obtained_at: number;
}

export interface BoltOrder {
  order_reference: string;
  driver_name: string;
  driver_uuid: string;
  driver_phone: string;
  payment_method: string;
  order_status: string;
  driver_cancelled_reason: string | null;
  vehicle_model: string;
  vehicle_license_plate: string;
  pickup_address: string;
  destination_address: string;
  ride_distance: number | null;
  road_distance_at_matching: number | null;
  order_created_timestamp: number;
  order_accepted_timestamp: number | null;
  order_pickup_timestamp: number | null;
  order_drop_off_timestamp: number | null;
  order_finished_timestamp: number | null;
  order_stops: Array<{
    lat: number;
    lng: number;
    address: string;
    real_lat: number | null;
    real_lng: number | null;
    type: 'pickup' | 'dropoff';
  }>;
  order_price: {
    booking_fee: number | null;
    cancellation_fee: number | null;
    net_earnings: number | null;
    tip: number | null;
    commission: number | null;
    ride_price: number | null;
    toll_fee: number | null;
    in_app_discount: number | null;
    cash_discount: number | null;
  };
  is_scheduled: boolean;
  category_info: {
    name: string;
    seats: number;
    vehicle_type: string;
  };
}

export interface BoltDriver {
  driver_uuid: string;
  partner_uuid: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  state: string;
  driver_score: number;
  driver_rating: number | null;
  active_categories: string[];
  active_vehicle: {
    id: number;
    model: string;
    year: number;
    reg_number: string;
    uuid: string;
    state: string;
  } | null;
  eligible_for_scheduled_ride: boolean;
}

export interface BoltFleetStats {
  company_id: number;
  company_name: string;
  total_orders: number;
  completed_orders: number;
  cancelled_orders: number;
  no_show_orders: number;
  total_revenue: number;
  total_commission: number;
  net_earnings: number;
  avg_ride_price: number;
  avg_distance_km: number;
  busiest_hours: Array<{ hour: number; count: number }>;
  top_pickup_zones: Array<{ address: string; count: number }>;
  drivers_active: number;
  drivers_total: number;
}

// ── Service ──
class BoltFleetService {
  private token: BoltToken | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private companyIds: number[] = [];

  private get clientId(): string {
    return process.env.BOLT_CLIENT_ID || '';
  }

  private get clientSecret(): string {
    return process.env.BOLT_CLIENT_SECRET || '';
  }

  get isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  // ── OAuth2 Token Management ──

  async getToken(): Promise<string | null> {
    // Token valide en cache ?
    if (this.token && Date.now() - this.token.obtained_at < TOKEN_REFRESH_MS) {
      return this.token.access_token;
    }

    return this.refreshToken();
  }

  async refreshToken(): Promise<string | null> {
    if (!this.isConfigured) {
      console.warn('[BoltFleet] Non configuré — BOLT_CLIENT_ID/SECRET manquants');
      return null;
    }

    try {
      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
        scope: 'fleet-integration:api',
      });

      const response = await fetch(BOLT_OIDC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        console.error(`[BoltFleet] Token refresh failed: HTTP ${response.status}`);
        return null;
      }

      const data: any = await response.json();

      this.token = {
        access_token: data.access_token,
        expires_in: data.expires_in,
        token_type: data.token_type,
        scope: data.scope,
        obtained_at: Date.now(),
      };

      console.log(`[BoltFleet] ✅ Token obtenu (expire dans ${data.expires_in}s)`);
      return this.token.access_token;
    } catch (err: any) {
      console.error('[BoltFleet] Token error:', err.message);
      return null;
    }
  }

  /**
   * Démarrer le cycle d'auto-refresh (appeler au boot du serveur)
   */
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    if (!this.isConfigured) return;

    // Premier token
    this.refreshToken().then((token) => {
      if (token) {
        // Charger les company IDs
        this.loadCompanyIds();
      }
    });

    // Refresh automatique toutes les 8 minutes
    this.refreshTimer = setInterval(() => {
      this.refreshToken();
    }, TOKEN_REFRESH_MS);

    console.log('[BoltFleet] 🔄 Auto-refresh démarré (cycle 8 min)');
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ── API Calls ──

  private async apiCall(
    endpoint: string,
    method: 'GET' | 'POST' = 'POST',
    body?: any,
  ): Promise<any> {
    const token = await this.getToken();
    if (!token) return null;

    try {
      const url = `${BOLT_API_BASE}${endpoint}`;
      const options: any = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      };

      if (body && method === 'POST') {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const text = await response.text();
        console.warn(
          `[BoltFleet] API ${endpoint} → HTTP ${response.status}: ${text.substring(0, 200)}`,
        );
        return null;
      }

      const data: any = await response.json();

      if (data.code !== 0) {
        console.warn(`[BoltFleet] API ${endpoint} → code ${data.code}: ${data.message}`);
        return null;
      }

      return data.data;
    } catch (err: any) {
      console.error(`[BoltFleet] API ${endpoint} error:`, err.message);
      return null;
    }
  }

  /**
   * Charger les company IDs
   */
  async loadCompanyIds(): Promise<number[]> {
    const data = await this.apiCall('/fleetIntegration/v1/getCompanies', 'GET');
    if (data?.company_ids) {
      this.companyIds = data.company_ids;
      console.log(
        `[BoltFleet] 📊 ${this.companyIds.length} company(s): ${this.companyIds.join(', ')}`,
      );
    }
    return this.companyIds;
  }

  /**
   * Récupérer les courses d'une company sur une période
   * Max 31 jours par requête
   */
  async getOrders(
    companyId?: number,
    daysBack: number = 7,
    limit: number = 100,
  ): Promise<BoltOrder[]> {
    const cid = companyId || this.companyIds[0];
    if (!cid) {
      await this.loadCompanyIds();
      if (!this.companyIds.length) return [];
    }

    const targetCompanyId = companyId || this.companyIds[0];
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - Math.min(daysBack, 30) * 86400;

    const data = await this.apiCall('/fleetIntegration/v1/getFleetOrders', 'POST', {
      offset: 0,
      limit,
      company_ids: [targetCompanyId],
      start_ts: startTs,
      end_ts: endTs,
    });

    return data?.orders || [];
  }

  /**
   * Récupérer les courses de TOUTES les companies
   */
  async getAllOrders(
    daysBack: number = 7,
    limit: number = 100,
  ): Promise<{ company_name: string; company_id: number; orders: BoltOrder[] }[]> {
    if (!this.companyIds.length) await this.loadCompanyIds();

    const results = [];
    for (const cid of this.companyIds) {
      const endTs = Math.floor(Date.now() / 1000);
      const startTs = endTs - Math.min(daysBack, 30) * 86400;

      const data = await this.apiCall('/fleetIntegration/v1/getFleetOrders', 'POST', {
        offset: 0,
        limit,
        company_ids: [cid],
        start_ts: startTs,
        end_ts: endTs,
      });

      if (data) {
        results.push({
          company_name: data.company_name || `Company ${cid}`,
          company_id: cid,
          orders: data.orders || [],
        });
      }
    }

    return results;
  }

  /**
   * Récupérer les chauffeurs d'une company
   */
  async getDrivers(companyId?: number): Promise<BoltDriver[]> {
    if (!this.companyIds.length) await this.loadCompanyIds();
    const targetCompanyId = companyId || this.companyIds[0];
    if (!targetCompanyId) return [];

    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - 30 * 86400;

    const data = await this.apiCall('/fleetIntegration/v1/getDrivers', 'POST', {
      offset: 0,
      limit: 100,
      company_id: targetCompanyId,
      start_ts: startTs,
      end_ts: endTs,
    });

    return data?.drivers || [];
  }

  /**
   * Récupérer les véhicules d'une company
   */
  async getVehicles(companyId?: number): Promise<any[]> {
    if (!this.companyIds.length) await this.loadCompanyIds();
    const targetCompanyId = companyId || this.companyIds[0];
    if (!targetCompanyId) return [];

    const data = await this.apiCall('/fleetIntegration/v1/getVehicles', 'POST', {
      offset: 0,
      limit: 100,
      company_id: targetCompanyId,
    });

    return data?.vehicles || [];
  }

  /**
   * Récupérer les logs d'état (online/offline)
   */
  async getStateLogs(companyId?: number, daysBack: number = 7): Promise<any[]> {
    if (!this.companyIds.length) await this.loadCompanyIds();
    const targetCompanyId = companyId || this.companyIds[0];
    if (!targetCompanyId) return [];

    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - Math.min(daysBack, 30) * 86400;

    const data = await this.apiCall('/fleetIntegration/v1/getFleetStateLogs', 'POST', {
      offset: 0,
      limit: 100,
      company_id: targetCompanyId,
      start_ts: startTs,
      end_ts: endTs,
    });

    return data?.state_logs || [];
  }

  // ── Analytics ──

  /**
   * Calculer les stats agrégées d'une company
   */
  async computeStats(companyId?: number, daysBack: number = 7): Promise<BoltFleetStats | null> {
    const orders = await this.getOrders(companyId, daysBack, 1000);
    const drivers = await this.getDrivers(companyId);

    if (!orders.length && !drivers.length) return null;

    const completed = orders.filter(
      (o) => o.order_status === 'finished' || o.order_status === 'completed',
    );
    const cancelled = orders.filter((o) => o.order_status.includes('cancel'));
    const noShow = orders.filter((o) => o.order_status === 'client_did_not_show');

    const totalRevenue = completed.reduce((sum, o) => sum + (o.order_price.ride_price || 0), 0);
    const totalCommission = completed.reduce((sum, o) => sum + (o.order_price.commission || 0), 0);
    const netEarnings = completed.reduce((sum, o) => sum + (o.order_price.net_earnings || 0), 0);

    // Heures les plus actives
    const hourCounts: Record<number, number> = {};
    orders.forEach((o) => {
      const hour = new Date(o.order_created_timestamp * 1000).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });
    const busiestHours = Object.entries(hourCounts)
      .map(([h, c]) => ({ hour: parseInt(h), count: c }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Zones de pickup les plus fréquentes
    const pickupCounts: Record<string, number> = {};
    orders.forEach((o) => {
      if (o.pickup_address) {
        // Simplifier l'adresse (garder ville)
        const parts = o.pickup_address.split(',');
        const zone = parts.length > 1 ? parts[parts.length - 1].trim() : parts[0].trim();
        pickupCounts[zone] = (pickupCounts[zone] || 0) + 1;
      }
    });
    const topPickupZones = Object.entries(pickupCounts)
      .map(([address, count]) => ({ address, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const activeDrivers = drivers.filter((d) => d.state === 'active').length;

    return {
      company_id: companyId || this.companyIds[0] || 0,
      company_name: '',
      total_orders: orders.length,
      completed_orders: completed.length,
      cancelled_orders: cancelled.length,
      no_show_orders: noShow.length,
      total_revenue: totalRevenue,
      total_commission: totalCommission,
      net_earnings: netEarnings,
      avg_ride_price: completed.length > 0 ? totalRevenue / completed.length : 0,
      avg_distance_km: 0,
      busiest_hours: busiestHours,
      top_pickup_zones: topPickupZones,
      drivers_active: activeDrivers,
      drivers_total: drivers.length,
    };
  }

  /**
   * Résumé compact pour injection dans Ajnaya
   */
  async getAjnayaContext(companyId?: number): Promise<string | null> {
    try {
      const stats = await this.computeStats(companyId, 7);
      if (!stats) return null;

      const lines = [
        `📊 BOLT FLEET (7 derniers jours):`,
        `• ${stats.total_orders} courses (${stats.completed_orders} terminées, ${stats.cancelled_orders} annulées, ${stats.no_show_orders} no-show)`,
        `• ${stats.drivers_active}/${stats.drivers_total} chauffeurs actifs`,
      ];

      if (stats.total_revenue > 0) {
        lines.push(
          `• CA: ${stats.total_revenue.toFixed(2)}€ | Net: ${stats.net_earnings.toFixed(2)}€ | Commission Bolt: ${stats.total_commission.toFixed(2)}€`,
        );
        lines.push(`• Prix moyen course: ${stats.avg_ride_price.toFixed(2)}€`);
      }

      if (stats.busiest_hours.length > 0) {
        const hours = stats.busiest_hours
          .slice(0, 3)
          .map((h) => `${h.hour}h(${h.count})`)
          .join(', ');
        lines.push(`• Heures fortes: ${hours}`);
      }

      if (stats.top_pickup_zones.length > 0) {
        const zones = stats.top_pickup_zones
          .slice(0, 3)
          .map((z) => `${z.address}(${z.count})`)
          .join(', ');
        lines.push(`• Zones pickup: ${zones}`);
      }

      return lines.join('\n');
    } catch (err: any) {
      console.warn('[BoltFleet] Ajnaya context error:', err.message);
      return null;
    }
  }
}

export const boltFleet = new BoltFleetService();
export default boltFleet;
