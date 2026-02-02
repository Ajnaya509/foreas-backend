#!/usr/bin/env node
/**
 * FOREAS Outcomes Timeout Job Runner
 * ===================================
 * Standalone script to run outcomes timeout job.
 *
 * Usage:
 *   npm run job:outcomes
 *   node dist/jobs/runOutcomes.js
 */

import { runOutcomesTimeoutJob } from './outcomesTimeout';

async function main() {
  console.log('[Job:Outcomes] Starting outcomes timeout job...');
  console.log('[Job:Outcomes] Time:', new Date().toISOString());

  try {
    const result = await runOutcomesTimeoutJob();

    console.log('[Job:Outcomes] Completed successfully');
    console.log('[Job:Outcomes] Results:', JSON.stringify(result, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('[Job:Outcomes] FAILED:', error);
    process.exit(1);
  }
}

main();
