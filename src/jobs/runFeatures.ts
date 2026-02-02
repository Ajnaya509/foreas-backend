#!/usr/bin/env node
/**
 * FOREAS Daily Features Job Runner
 * ================================
 * Standalone script to run daily features computation.
 *
 * Usage:
 *   npm run job:features
 *   node dist/jobs/runFeatures.js
 */

import { runDailyFeaturesJob } from './dailyFeatures';

async function main() {
  console.log('[Job:Features] Starting daily features job...');
  console.log('[Job:Features] Time:', new Date().toISOString());

  try {
    const result = await runDailyFeaturesJob();

    console.log('[Job:Features] Completed successfully');
    console.log('[Job:Features] Results:', JSON.stringify(result, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('[Job:Features] FAILED:', error);
    process.exit(1);
  }
}

main();
