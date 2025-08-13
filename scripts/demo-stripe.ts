#!/usr/bin/env tsx

/**
 * Script de démonstration Stripe Connect
 * Usage: npm run demo:stripe
 */

import { runStripeConnectDemo } from '../src/demo/stripeConnectDemo';

runStripeConnectDemo().catch((error) => {
  console.error('❌ Erreur lors de la démonstration:', error);
  process.exit(1);
});