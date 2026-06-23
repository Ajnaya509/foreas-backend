/**
 * Client Finder Cron Job
 * Ajnaya2026v86
 *
 * Appelé par Railway Cron ou N8N :
 *   POST /api/client-finder/run/:driverId (avec FOREAS_SERVICE_KEY)
 */

import { createClient } from '@supabase/supabase-js';
import { runFinderForDriver } from '../services/ClientFinderService.js';

function getSupa() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function runClientFinderBatch(): Promise<void> {
  const startTime = Date.now();
  console.log('[ClientFinderCron] 🕐 Starting daily run...');

  const supa = getSupa();

  const { data: settings, error } = await supa
    .from('client_finder_settings')
    .select('driver_id, driver_presentation, city_slug')
    .eq('enabled', true)
    .or(`pause_until.is.null,pause_until.lt.${new Date().toISOString()}`);

  if (error) {
    console.error('[ClientFinderCron] ❌ Failed to load settings:', error.message);
    return;
  }

  if (!settings || settings.length === 0) {
    console.log('[ClientFinderCron] No active finders found');
    return;
  }

  console.log(`[ClientFinderCron] Found ${settings.length} active finders`);

  // v88 — Enrichir les places_directory AVANT d'envoyer les emails
  try {
    const { runEnrichmentBeforeFinder } = await import('../services/ApolloEnrichmentService.js');
    const activeCities = [...new Set(settings.map((s: any) => s.city_slug || 'paris'))];
    for (const city of activeCities) {
      await runEnrichmentBeforeFinder(city);
    }
  } catch (err: any) {
    console.error('[ClientFinderCron] Apollo enrichment error (non-blocking):', err.message);
  }

  const driverIds = settings.map((s: any) => s.driver_id);
  const { data: profiles } = await supa
    .from('user_profiles')
    .select('id, first_name, last_name')
    .in('id', driverIds);

  const nameMap: Record<string, string> = {};
  (profiles || []).forEach((p: any) => {
    nameMap[p.id] = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Chauffeur';
  });

  let totalSent = 0;
  let totalErrors = 0;

  for (const setting of settings as any[]) {
    const driverName = nameMap[setting.driver_id] || 'Chauffeur';
    try {
      const result = await runFinderForDriver(setting.driver_id, driverName);
      totalSent += result.emailsSent;
      totalErrors += result.errors;
    } catch (err: any) {
      console.error(`[ClientFinderCron] Driver ${setting.driver_id} failed:`, err.message);
      totalErrors++;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[ClientFinderCron] ✅ Done: ${totalSent} emails sent, ${totalErrors} errors, ${durationSec}s total`,
  );
}
