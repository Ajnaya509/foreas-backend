/**
 * Stripe Webhook Handler - FOREAS Driver Backend
 * Gestion des webhooks Stripe avec vérification de signature et idempotence
 */

import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';

import { env } from '@/env';
import { prisma } from '@/server/db';
import { StripeService } from '@/services/StripeService';
import { webhookLogger } from '@/utils/logger';

/**
 * Types des événements Stripe supportés
 */
const SUPPORTED_EVENTS = [
  'account.updated',
  'payout.paid',
  'payout.failed',
  'payout.updated',
] as const;

type SupportedEvent = typeof SUPPORTED_EVENTS[number];

/**
 * Schéma pour l'événement webhook
 */
const WebhookEventSchema = z.object({
  id: z.string(),
  type: z.enum(SUPPORTED_EVENTS),
  data: z.object({
    object: z.any(),
  }),
  created: z.number(),
  livemode: z.boolean(),
  api_version: z.string().optional(),
});

/**
 * Modèle pour l'idempotence
 */
const WebhookEventIdempotenceSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  processed: z.boolean(),
  processedAt: z.date().optional(),
  error: z.string().optional(),
});

/**
 * Vérifie la signature du webhook Stripe
 */
function verifyStripeSignature(payload: string, signature: string): Stripe.Event {
  const stripe = StripeService.getStripeInstance();
  
  try {
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
    
    webhookLogger.info(`Stripe signature verified for event: ${event.id}`);
    return event;
  } catch (error) {
    webhookLogger.error({ error, signature: signature.substring(0, 10) + '...' }, 'Stripe signature verification failed');
    throw new Error('Invalid signature');
  }
}

/**
 * Vérifie et marque l'idempotence d'un événement
 */
async function ensureEventIdempotence(eventId: string, eventType: string): Promise<boolean> {
  try {
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (existingEvent) {
      if (existingEvent.processed) {
        webhookLogger.info(`Event ${eventId} already processed, skipping`);
        return false; // Déjà traité
      } else {
        webhookLogger.warn(`Event ${eventId} exists but not processed, continuing`);
        return true; // Pas encore traité
      }
    }

    // Créer l'enregistrement pour marquer le début du traitement
    await prisma.webhookEvent.create({
      data: {
        eventId,
        eventType,
        processed: false,
      },
    });

    webhookLogger.info(`Event ${eventId} marked for processing`);
    return true; // Nouveau événement
  } catch (error) {
    webhookLogger.error({ error, eventId }, 'Failed to check event idempotence');
    // En cas d'erreur, on continue le traitement pour éviter les blocages
    return true;
  }
}

/**
 * Marque un événement comme traité
 */
async function markEventProcessed(eventId: string, error?: string): Promise<void> {
  try {
    await prisma.webhookEvent.update({
      where: { eventId },
      data: {
        processed: true,
        processedAt: new Date(),
        error,
      },
    });

    webhookLogger.info(`Event ${eventId} marked as processed`);
  } catch (updateError) {
    webhookLogger.error({ error: updateError, eventId }, 'Failed to mark event as processed');
  }
}

/**
 * Gère l'événement account.updated
 */
async function handleAccountUpdated(event: Stripe.Event): Promise<void> {
  const account = event.data.object as Stripe.Account;
  
  webhookLogger.info(`Processing account.updated for account: ${account.id}`);

  try {
    // Récupérer le statut actuel
    const status = await StripeService.refreshStatus(account.id);
    
    webhookLogger.info(`Account status updated: ${account.id}`, {
      onboardingDone: status.onboardingDone,
      payoutsEnabled: status.payoutsEnabled,
      chargesEnabled: status.chargesEnabled,
      requirementsCurrentlyDue: status.requirementsCurrentlyDue,
    });

    // Si l'onboarding est terminé, on peut notifier l'utilisateur
    if (status.onboardingDone) {
      webhookLogger.info(`Onboarding completed for account: ${account.id}`);
      // TODO: Envoyer une notification à l'utilisateur
      // await NotificationService.sendOnboardingComplete(userId);
    }

    // Si des exigences sont en attente
    if (status.requirementsCurrentlyDue.length > 0 || status.requirementsPastDue.length > 0) {
      webhookLogger.warn(`Account ${account.id} has pending requirements`, {
        currentlyDue: status.requirementsCurrentlyDue,
        pastDue: status.requirementsPastDue,
      });
      // TODO: Notifier l'utilisateur des exigences manquantes
    }
  } catch (error) {
    webhookLogger.error({ error, accountId: account.id }, 'Failed to handle account.updated');
    throw error;
  }
}

/**
 * Gère les événements payout.*
 */
async function handlePayoutUpdated(event: Stripe.Event): Promise<void> {
  const payout = event.data.object as Stripe.Payout;
  
  webhookLogger.info(`Processing ${event.type} for payout: ${payout.id}`, {
    amount: payout.amount,
    currency: payout.currency,
    status: payout.status,
    arrival_date: payout.arrival_date,
  });

  try {
    // Log détaillé pour le suivi des paiements
    if (event.type === 'payout.paid') {
      webhookLogger.info(`Payout completed successfully: ${payout.id}`, {
        account: payout.destination,
        amount: `${payout.amount / 100} ${payout.currency.toUpperCase()}`,
        arrival_date: new Date(payout.arrival_date * 1000).toISOString(),
      });
      
      // TODO: Mettre à jour les statistiques de revenus
      // await StatsService.recordPayout(payout);
    }

    if (event.type === 'payout.failed') {
      webhookLogger.error(`Payout failed: ${payout.id}`, {
        account: payout.destination,
        amount: `${payout.amount / 100} ${payout.currency.toUpperCase()}`,
        failure_code: (payout as any).failure_code,
        failure_message: (payout as any).failure_message,
      });
      
      // TODO: Notifier l'utilisateur de l'échec du paiement
      // await NotificationService.sendPayoutFailed(userId, payout);
    }
  } catch (error) {
    webhookLogger.error({ error, payoutId: payout.id }, `Failed to handle ${event.type}`);
    throw error;
  }
}

/**
 * Gestionnaire principal des webhooks Stripe
 */
export async function handleStripeWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['stripe-signature'] as string;
  
  if (!signature) {
    webhookLogger.warn('Missing Stripe signature');
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  let event: Stripe.Event;
  let rawBody: string;

  try {
    // Récupérer le body brut
    if (req.body && typeof req.body === 'string') {
      rawBody = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString();
    } else {
      throw new Error('Invalid body format');
    }

    // Vérifier la signature
    event = verifyStripeSignature(rawBody, signature);
  } catch (error) {
    webhookLogger.error({ error }, 'Webhook signature verification failed');
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  // Vérifier si c'est un événement supporté
  if (!SUPPORTED_EVENTS.includes(event.type as SupportedEvent)) {
    webhookLogger.info(`Unsupported event type: ${event.type}`);
    res.status(200).json({ received: true, message: 'Event type not supported' });
    return;
  }

  // Vérifier l'idempotence
  const shouldProcess = await ensureEventIdempotence(event.id, event.type);
  if (!shouldProcess) {
    res.status(200).json({ received: true, message: 'Event already processed' });
    return;
  }

  // Traiter l'événement
  try {
    webhookLogger.info(`Processing webhook event: ${event.type} (${event.id})`);

    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event);
        break;
      
      case 'payout.paid':
      case 'payout.failed':
      case 'payout.updated':
        await handlePayoutUpdated(event);
        break;

      default:
        webhookLogger.warn(`No handler for event type: ${event.type}`);
        break;
    }

    // Marquer comme traité avec succès
    await markEventProcessed(event.id);
    
    webhookLogger.info(`Successfully processed webhook event: ${event.id}`);
    res.status(200).json({ received: true, processed: true });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    webhookLogger.error({ error, eventId: event.id }, 'Failed to process webhook event');
    
    // Marquer comme traité avec erreur
    await markEventProcessed(event.id, errorMessage);
    
    // Retourner une erreur pour que Stripe puisse réessayer
    res.status(500).json({ 
      error: 'Processing failed', 
      eventId: event.id,
      message: errorMessage 
    });
  }
}

/**
 * Middleware pour le raw body (nécessaire pour la vérification de signature)
 */
export function stripeWebhookMiddleware(req: Request, res: Response, next: any): void {
  if (req.originalUrl === '/webhooks/stripe') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      req.body = data;
      next();
    });
  } else {
    next();
  }
}