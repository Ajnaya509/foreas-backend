/**
 * finderMLCron — ML weights computation (weekly)
 * Ajnaya2026v88
 *
 * For each active driver, computes conversion weights by dimension:
 * TYPE:HOTEL, TYPE:RESTAURANT_GASTRO, DAY:MONDAY, HOUR:09, etc.
 * Formula: weight = (conversions + 0.1) / (sends + 1) — Laplace smoothing
 */
import { createClient } from '@supabase/supabase-js';

let supa: any = null;
function getDb() {
  if (!supa) supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return supa;
}

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

export async function runMLBatch(): Promise<{ driversProcessed: number; weightsUpserted: number }> {
  const db = getDb();
  console.log('[ML] Starting weekly ML batch...');

  // Get all active drivers with finder enabled
  const { data: drivers } = await db
    .from('client_finder_settings')
    .select('driver_id')
    .eq('enabled', true);

  if (!drivers || drivers.length === 0) {
    console.log('[ML] No active drivers found');
    return { driversProcessed: 0, weightsUpserted: 0 };
  }

  let totalWeights = 0;
  const fourWeeksAgo = new Date();
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

  for (const driver of drivers) {
    const driverId = driver.driver_id;

    // Get all outreach logs for last 4 weeks
    const { data: logs } = await db
      .from('pieuvre_b2b_hunter_log')
      .select('place_type_family, outreach_sent_at, response_received_at')
      .eq('driver_id', driverId)
      .gte('outreach_sent_at', fourWeeksAgo.toISOString())
      .not('outreach_sent_at', 'is', null);

    if (!logs || logs.length === 0) continue;

    // Get performance data
    const { data: perfs } = await db
      .from('client_finder_performance')
      .select('place_type_family, outreach_sent_at, converted_at')
      .eq('driver_id', driverId)
      .gte('outreach_sent_at', fourWeeksAgo.toISOString());

    // Compute dimension weights
    const dimensions: Record<string, { sends: number; conversions: number }> = {};

    for (const log of logs) {
      // Type dimension
      if (log.place_type_family) {
        const typeKey = `TYPE:${log.place_type_family}`;
        if (!dimensions[typeKey]) dimensions[typeKey] = { sends: 0, conversions: 0 };
        dimensions[typeKey].sends++;
      }

      // Day dimension
      if (log.outreach_sent_at) {
        const date = new Date(log.outreach_sent_at);
        const dayKey = `DAY:${DAYS[date.getDay()]}`;
        if (!dimensions[dayKey]) dimensions[dayKey] = { sends: 0, conversions: 0 };
        dimensions[dayKey].sends++;

        // Hour dimension
        const hour = date.getHours().toString().padStart(2, '0');
        const hourKey = `HOUR:${hour}`;
        if (!dimensions[hourKey]) dimensions[hourKey] = { sends: 0, conversions: 0 };
        dimensions[hourKey].sends++;
      }
    }

    // Count conversions from performance data
    for (const perf of perfs || []) {
      if (!perf.converted_at) continue;

      if (perf.place_type_family) {
        const typeKey = `TYPE:${perf.place_type_family}`;
        if (dimensions[typeKey]) dimensions[typeKey].conversions++;
      }

      if (perf.outreach_sent_at) {
        const date = new Date(perf.outreach_sent_at);
        const dayKey = `DAY:${DAYS[date.getDay()]}`;
        if (dimensions[dayKey]) dimensions[dayKey].conversions++;

        const hour = date.getHours().toString().padStart(2, '0');
        const hourKey = `HOUR:${hour}`;
        if (dimensions[hourKey]) dimensions[hourKey].conversions++;
      }
    }

    // Upsert weights
    const upserts = Object.entries(dimensions).map(([dimension, { sends, conversions }]) => ({
      driver_id: driverId,
      dimension,
      weight: Math.round(((conversions + 0.1) / (sends + 1)) * 1000) / 1000,
      samples_count: sends,
      last_updated: new Date().toISOString(),
    }));

    if (upserts.length > 0) {
      const { error } = await db
        .from('finder_ml_weights')
        .upsert(upserts, { onConflict: 'driver_id,dimension' });

      if (error) {
        console.error(`[ML] Error upserting weights for ${driverId}: ${error.message}`);
      } else {
        totalWeights += upserts.length;
      }
    }
  }

  console.log(`[ML] Batch complete: ${drivers.length} drivers, ${totalWeights} weights`);
  return { driversProcessed: drivers.length, weightsUpserted: totalWeights };
}
