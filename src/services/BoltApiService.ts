/**
 * BoltApiService — Récupère les taux de commission réels depuis l'API Bolt.
 * Appelé 1x/jour par N8N. Fallback 0.80 si indispo.
 */

const BOLT_API_BASE = 'https://node.bolt.eu/partner/api/v1';

export interface BoltCommissionInfo {
  commissionRate: number;
  city: string;
  vehicleType: string;
  updatedAt: Date;
}

export async function fetchBoltCommissionRate(
  citySlug: string = 'paris',
  vehicleType: string = 'standard',
): Promise<BoltCommissionInfo | null> {
  const apiKey = process.env.BOLT_API_KEY;
  if (!apiKey) {
    console.warn('[BoltAPI] Pas de BOLT_API_KEY, fallback 0.80');
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${BOLT_API_BASE}/driver/commission-rate`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();

    return {
      commissionRate: 1 - (data.commission_percentage ?? 0.2),
      city: citySlug,
      vehicleType,
      updatedAt: new Date(),
    };
  } catch (err) {
    console.error('[BoltAPI]', (err as Error).message);
    return null;
  }
}
