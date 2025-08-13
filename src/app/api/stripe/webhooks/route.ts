/**
 * Stripe Webhooks Handler - FOREAS Driver
 * 
 * Gestion centralisée de tous les événements Stripe
 * KYC, paiements, comptes Connect, etc.
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { logger } from '@/lib/logger';
import { createError } from '@/lib/errors';
import { env } from '@/config/environment';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = headers().get('stripe-signature');

  if (!signature) {
    logger.securityEvent('Missing Stripe webhook signature', {
      action: 'webhook_validation',
    }, 'high');
    
    return NextResponse.json(
      { error: 'Missing signature' },
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );

    logger.info(`Stripe webhook reçu: ${event.type}`, {
      action: 'stripe_webhook',
      metadata: {
        eventId: event.id,
        eventType: event.type,
        created: new Date(event.created * 1000),
      },
    });

  } catch (error: any) {
    logger.securityEvent('Invalid Stripe webhook signature', {
      action: 'webhook_validation',
      metadata: { error: error.message },
    }, 'high');

    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 400 }
    );
  }

  try {
    await handleStripeEvent(event);
    
    return NextResponse.json({ received: true });
    
  } catch (error: any) {
    logger.error('Erreur traitement webhook Stripe', {
      action: 'stripe_webhook_processing',
      metadata: { eventType: event.type, eventId: event.id },
    }, error);

    // Retourner 200 pour éviter les retry Stripe sur erreurs temporaires
    return NextResponse.json(
      { error: 'Webhook processing failed', eventId: event.id },
      { status: 200 }
    );
  }
}

async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    // ========== ACCOUNT EVENTS ==========
    case 'account.updated':
      await handleAccountUpdated(event.data.object as Stripe.Account);
      break;

    case 'account.application.deauthorized':
      await handleAccountDeauthorized(event.data.object as Stripe.Account);
      break;

    // ========== PAYMENT EVENTS ==========
    case 'payment_intent.succeeded':
      await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;

    case 'payment_intent.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;

    case 'payment_intent.requires_action':
      await handlePaymentRequiresAction(event.data.object as Stripe.PaymentIntent);
      break;

    // ========== TRANSFER EVENTS ==========
    case 'transfer.created':
      await handleTransferCreated(event.data.object as Stripe.Transfer);
      break;

    case 'transfer.updated':
      await handleTransferUpdated(event.data.object as Stripe.Transfer);
      break;

    // ========== PAYOUT EVENTS ==========
    case 'payout.created':
      await handlePayoutCreated(event.data.object as Stripe.Payout);
      break;

    case 'payout.updated':
      await handlePayoutUpdated(event.data.object as Stripe.Payout);
      break;

    case 'payout.failed':
      await handlePayoutFailed(event.data.object as Stripe.Payout);
      break;

    // ========== CAPABILITY EVENTS (KYC) ==========
    case 'capability.updated':
      await handleCapabilityUpdated(event.data.object as Stripe.Capability);
      break;

    // ========== PERSON EVENTS (KYC) ==========
    case 'person.updated':
      await handlePersonUpdated(event.data.object as Stripe.Person);
      break;

    default:
      logger.info(`Stripe webhook non géré: ${event.type}`, {
        action: 'stripe_webhook_unhandled',
        metadata: { eventType: event.type },
      });
  }
}

// ========== ACCOUNT HANDLERS ==========
async function handleAccountUpdated(account: Stripe.Account) {
  const driver = await findDriverByStripeAccount(account.id);
  if (!driver) return;

  const wasOnboarded = driver.stripeOnboarded;
  const isNowOnboarded = account.details_submitted && 
                        account.charges_enabled && 
                        account.payouts_enabled;

  // Mettre à jour le statut d'onboarding
  await prisma.driver.update({
    where: { id: driver.id },
    data: {
      stripeOnboarded: isNowOnboarded,
      updatedAt: new Date(),
    },
  });

  // Créer une notification si le statut a changé
  if (!wasOnboarded && isNowOnboarded) {
    await createAjnayaInsight(driver.id, {
      type: 'PERFORMANCE',
      priority: 'HIGH',
      title: '🎉 Paiements Stripe activés !',
      message: 'Félicitations ! Votre compte Stripe est maintenant entièrement configuré. Vous pouvez recevoir des paiements directs avec une commission de seulement 5-15%.',
      data: {
        accountId: account.id,
        capabilities: account.capabilities,
        requirements: account.requirements?.currently_due || [],
        source: 'stripe_webhook_account_updated',
      },
    });
  } else if (wasOnboarded && !isNowOnboarded) {
    // Compte désactivé - créer une alerte
    await createAjnayaInsight(driver.id, {
      type: 'PERFORMANCE',
      priority: 'CRITICAL',
      title: '⚠️ Compte Stripe désactivé',
      message: 'Votre compte Stripe nécessite une action de votre part. Vérifiez vos documents d\'identité.',
      data: {
        accountId: account.id,
        requirements: account.requirements?.currently_due || [],
        source: 'stripe_webhook_account_deactivated',
      },
    });
  }

  logger.stripeEvent('account_updated', account.id, true);
}

async function handleAccountDeauthorized(account: Stripe.Account) {
  const driver = await findDriverByStripeAccount(account.id);
  if (!driver) return;

  // Désactiver le compte Stripe
  await prisma.driver.update({
    where: { id: driver.id },
    data: {
      stripeAccountId: null,
      stripeOnboarded: false,
      updatedAt: new Date(),
    },
  });

  // Créer une alerte critique
  await createAjnayaInsight(driver.id, {
    type: 'PERFORMANCE',
    priority: 'CRITICAL',
    title: '🚨 Compte Stripe déconnecté',
    message: 'Votre compte Stripe a été déconnecté. Reconnectez-vous pour continuer à recevoir des paiements.',
    data: {
      accountId: account.id,
      reason: 'account_deauthorized',
      source: 'stripe_webhook_deauthorized',
    },
  });

  logger.stripeEvent('account_deauthorized', account.id, false);
}

// ========== PAYMENT HANDLERS ==========
async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) return;

  // Mettre à jour le statut de la réservation
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      paymentStatus: 'COMPLETED',
      updatedAt: new Date(),
    },
    include: { driver: true },
  });

  // Créer un gain dans les earnings
  const netAmount = paymentIntent.amount - (paymentIntent.application_fee_amount || 0);
  
  await prisma.earning.create({
    data: {
      driverId: booking.driverId,
      type: 'BOOKING',
      platform: 'FOREAS_DIRECT',
      amount: netAmount / 100, // Convertir centimes en euros
      currency: paymentIntent.currency.toUpperCase(),
      bookingId: booking.id,
      earnedAt: new Date(),
    },
  });

  // Notification de succès pour le chauffeur
  await createAjnayaInsight(booking.driverId, {
    type: 'EARNINGS_BOOST',
    priority: 'HIGH',
    title: '💰 Paiement reçu !',
    message: `Paiement de ${(netAmount / 100).toFixed(2)}€ confirmé pour votre course. Montant net après commission FOREAS.`,
    data: {
      paymentIntentId: paymentIntent.id,
      amount: netAmount,
      bookingId: booking.id,
      commission: paymentIntent.application_fee_amount || 0,
      source: 'stripe_webhook_payment_succeeded',
    },
  });

  logger.stripeEvent('payment_succeeded', paymentIntent.id, true);
}

async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) return;

  // Mettre à jour le statut de la réservation
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      paymentStatus: 'FAILED',
      updatedAt: new Date(),
    },
  });

  // Notification d'échec pour le chauffeur
  await createAjnayaInsight(booking.driverId, {
    type: 'PERFORMANCE',
    priority: 'MEDIUM',
    title: '❌ Paiement échoué',
    message: 'Le paiement de votre client a échoué. La réservation reste active, le client peut réessayer.',
    data: {
      paymentIntentId: paymentIntent.id,
      bookingId: booking.id,
      failureReason: paymentIntent.last_payment_error?.message,
      source: 'stripe_webhook_payment_failed',
    },
  });

  logger.stripeEvent('payment_failed', paymentIntent.id, false);
}

async function handlePaymentRequiresAction(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  if (!bookingId) return;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
  });

  if (!booking) return;

  // Notification d'action requise
  await createAjnayaInsight(booking.driverId, {
    type: 'PERFORMANCE',
    priority: 'MEDIUM',
    title: '🔐 Action client requise',
    message: 'Le client doit confirmer son paiement (authentification 3D Secure). Le montant sera crédité une fois confirmé.',
    data: {
      paymentIntentId: paymentIntent.id,
      bookingId: booking.id,
      nextAction: paymentIntent.next_action?.type,
      source: 'stripe_webhook_payment_requires_action',
    },
  });

  logger.stripeEvent('payment_requires_action', paymentIntent.id, true);
}

// ========== KYC HANDLERS ==========
async function handleCapabilityUpdated(capability: Stripe.Capability) {
  const driver = await findDriverByStripeAccount(capability.account as string);
  if (!driver) return;

  const isActive = capability.status === 'active';
  const capabilityType = capability.id;

  // Notifier selon le type de capability
  if (capabilityType === 'card_payments' && isActive) {
    await createAjnayaInsight(driver.id, {
      type: 'PERFORMANCE',
      priority: 'HIGH',
      title: '✅ Paiements par carte activés',
      message: 'Vous pouvez maintenant recevoir des paiements par carte bancaire.',
      data: {
        capability: capabilityType,
        status: capability.status,
        source: 'stripe_webhook_capability_updated',
      },
    });
  }

  if (capabilityType === 'transfers' && isActive) {
    await createAjnayaInsight(driver.id, {
      type: 'PERFORMANCE',
      priority: 'HIGH',
      title: '💸 Virements activés',
      message: 'Vous pouvez maintenant recevoir des virements automatiques.',
      data: {
        capability: capabilityType,
        status: capability.status,
        source: 'stripe_webhook_capability_updated',
      },
    });
  }

  logger.stripeEvent('capability_updated', capability.account as string, isActive);
}

async function handlePersonUpdated(person: Stripe.Person) {
  const driver = await findDriverByStripeAccount(person.account as string);
  if (!driver) return;

  const hasRequirements = person.requirements?.currently_due?.length > 0;

  if (hasRequirements) {
    await createAjnayaInsight(driver.id, {
      type: 'PERFORMANCE',
      priority: 'HIGH',
      title: '📋 Documents requis',
      message: `Stripe demande des informations supplémentaires: ${person.requirements?.currently_due?.join(', ')}`,
      data: {
        requirements: person.requirements?.currently_due || [],
        personId: person.id,
        source: 'stripe_webhook_person_updated',
      },
    });
  }

  logger.stripeEvent('person_updated', person.account as string, !hasRequirements);
}

// ========== PAYOUT HANDLERS ==========
async function handlePayoutCreated(payout: Stripe.Payout) {
  const driver = await findDriverByStripeAccount(payout.destination as string);
  if (!driver) return;

  await createAjnayaInsight(driver.id, {
    type: 'EARNINGS_BOOST',
    priority: 'MEDIUM',
    title: '💳 Virement en cours',
    message: `Virement de ${(payout.amount / 100).toFixed(2)}€ en cours vers votre compte bancaire.`,
    data: {
      payoutId: payout.id,
      amount: payout.amount,
      arrivalDate: new Date(payout.arrival_date * 1000),
      source: 'stripe_webhook_payout_created',
    },
  });

  logger.stripeEvent('payout_created', payout.destination as string, true);
}

async function handlePayoutUpdated(payout: Stripe.Payout) {
  const driver = await findDriverByStripeAccount(payout.destination as string);
  if (!driver) return;

  if (payout.status === 'paid') {
    await createAjnayaInsight(driver.id, {
      type: 'EARNINGS_BOOST',
      priority: 'HIGH',
      title: '✅ Virement reçu !',
      message: `Virement de ${(payout.amount / 100).toFixed(2)}€ crédité sur votre compte bancaire.`,
      data: {
        payoutId: payout.id,
        amount: payout.amount,
        status: payout.status,
        source: 'stripe_webhook_payout_updated',
      },
    });
  }

  logger.stripeEvent('payout_updated', payout.destination as string, payout.status === 'paid');
}

async function handlePayoutFailed(payout: Stripe.Payout) {
  const driver = await findDriverByStripeAccount(payout.destination as string);
  if (!driver) return;

  await createAjnayaInsight(driver.id, {
    type: 'PERFORMANCE',
    priority: 'CRITICAL',
    title: '❌ Virement échoué',
    message: `Le virement de ${(payout.amount / 100).toFixed(2)}€ a échoué. Vérifiez vos informations bancaires.`,
    data: {
      payoutId: payout.id,
      amount: payout.amount,
      failureCode: payout.failure_code,
      failureMessage: payout.failure_message,
      source: 'stripe_webhook_payout_failed',
    },
  });

  logger.stripeEvent('payout_failed', payout.destination as string, false);
}

// ========== TRANSFER HANDLERS ==========
async function handleTransferCreated(transfer: Stripe.Transfer) {
  // Gérer les transferts vers les comptes chauffeurs
  logger.stripeEvent('transfer_created', transfer.destination as string, true);
}

async function handleTransferUpdated(transfer: Stripe.Transfer) {
  // Gérer les mises à jour de transfert
  logger.stripeEvent('transfer_updated', transfer.destination as string, true);
}

// ========== UTILITY FUNCTIONS ==========
async function findDriverByStripeAccount(accountId: string) {
  return await prisma.driver.findUnique({
    where: { stripeAccountId: accountId },
  });
}

async function createAjnayaInsight(driverId: string, insight: {
  type: 'ZONE_ALERT' | 'APP_SWITCH' | 'BREAK_REMINDER' | 'EARNINGS_BOOST' | 'PERFORMANCE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  message: string;
  data: any;
}) {
  try {
    await prisma.ajnayaInsight.create({
      data: {
        driverId,
        type: insight.type,
        priority: insight.priority,
        title: insight.title,
        message: insight.message,
        data: insight.data,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      },
    });
  } catch (error) {
    logger.error('Erreur création insight Ajnaya', {
      driverId,
      insightType: insight.type,
    }, error as Error);
  }
}