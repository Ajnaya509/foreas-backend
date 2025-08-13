/**
 * Stripe Service - FOREAS Driver Backend
 * Service isolé pour gérer Stripe Connect
 */

import Stripe from 'stripe';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { env } from '@/env';
import { prisma } from '@/server/db';
import { stripeLogger } from '@/utils/logger';

/**
 * Configuration Stripe
 */
const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  typescript: true,
});

/**
 * Schémas de validation
 */
export const EnsureAccountResponse = z.object({
  accountId: z.string(),
  isNewAccount: z.boolean(),
});

export const OnboardingLinkResponse = z.object({
  url: z.string().url(),
  expiresAt: z.number(),
});

export const RefreshStatusResponse = z.object({
  accountId: z.string(),
  onboardingDone: z.boolean(),
  payoutsEnabled: z.boolean(),
  chargesEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  requirementsCurrentlyDue: z.array(z.string()),
  requirementsPastDue: z.array(z.string()),
  lastUpdated: z.date(),
});

export type EnsureAccountResponse = z.infer<typeof EnsureAccountResponse>;
export type OnboardingLinkResponse = z.infer<typeof OnboardingLinkResponse>;
export type RefreshStatusResponse = z.infer<typeof RefreshStatusResponse>;

/**
 * Service Stripe Connect
 */
export class StripeService {
  /**
   * Assure l'existence d'un compte Stripe Connect pour l'utilisateur
   * Créé le compte s'il n'existe pas et le persiste en DB
   */
  static async ensureAccount(userId: string): Promise<EnsureAccountResponse> {
    stripeLogger.info(`Ensuring Stripe account for user: ${userId}`);

    try {
      // Vérifier si un compte existe déjà
      const existingStripeAccount = await prisma.stripeAccount.findUnique({
        where: { userId },
        include: { user: { select: { email: true } } },
      });

      if (existingStripeAccount?.accountId) {
        stripeLogger.info(`Existing account found: ${existingStripeAccount.accountId}`);
        return {
          accountId: existingStripeAccount.accountId,
          isNewAccount: false,
        };
      }

      // Récupérer les informations utilisateur
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });

      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Utilisateur non trouvé',
        });
      }

      // Créer le compte Stripe Express
      stripeLogger.info('Creating new Stripe Express account');
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
      });

      stripeLogger.info(`New Stripe account created: ${account.id}`);

      // Persister en base de données
      await prisma.stripeAccount.upsert({
        where: { userId },
        update: {
          accountId: account.id,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          lastSync: new Date(),
          updatedAt: new Date(),
        },
        create: {
          userId,
          accountId: account.id,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          lastSync: new Date(),
        },
      });

      return {
        accountId: account.id,
        isNewAccount: true,
      };
    } catch (error) {
      stripeLogger.error({ error, userId }, 'Failed to ensure Stripe account');
      
      if (error instanceof TRPCError) {
        throw error;
      }
      
      if (error instanceof Stripe.errors.StripeError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Erreur Stripe: ${error.message}`,
          cause: error,
        });
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Erreur lors de la création du compte Stripe',
        cause: error,
      });
    }
  }

  /**
   * Crée un lien d'onboarding Stripe Connect
   */
  static async createOnboardingLink(
    accountId: string,
    refreshUrl: string,
    returnUrl: string
  ): Promise<OnboardingLinkResponse> {
    stripeLogger.info(`Creating onboarding link for account: ${accountId}`);

    try {
      // Vérifier que le compte existe
      const account = await stripe.accounts.retrieve(accountId);
      if (!account) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Compte Stripe non trouvé',
        });
      }

      // Créer le lien d'onboarding
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });

      stripeLogger.info(`Onboarding link created: ${accountLink.url}`);

      return {
        url: accountLink.url,
        expiresAt: accountLink.expires_at,
      };
    } catch (error) {
      stripeLogger.error({ error, accountId }, 'Failed to create onboarding link');
      
      if (error instanceof Stripe.errors.StripeError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Erreur Stripe: ${error.message}`,
          cause: error,
        });
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Erreur lors de la création du lien d\'onboarding',
        cause: error,
      });
    }
  }

  /**
   * Rafraîchit le statut d'un compte Stripe et met à jour la DB
   */
  static async refreshStatus(accountId: string): Promise<RefreshStatusResponse> {
    stripeLogger.info(`Refreshing status for account: ${accountId}`);

    try {
      // Récupérer les informations depuis Stripe
      const account = await stripe.accounts.retrieve(accountId);

      if (!account) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Compte Stripe non trouvé',
        });
      }

      const now = new Date();

      // Déterminer le statut d'onboarding
      const onboardingDone = account.details_submitted && 
                            account.charges_enabled && 
                            account.payouts_enabled &&
                            (account.requirements?.currently_due?.length || 0) === 0;

      // Mettre à jour en base de données
      await prisma.stripeAccount.upsert({
        where: { accountId },
        update: {
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          businessType: account.business_type,
          country: account.country,
          defaultCurrency: account.default_currency,
          lastSync: now,
          updatedAt: now,
        },
        create: {
          userId: 'unknown', // Sera mis à jour lors du prochain ensureAccount
          accountId,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          businessType: account.business_type,
          country: account.country,
          defaultCurrency: account.default_currency,
          lastSync: now,
        },
      });

      stripeLogger.info(`Status refreshed for account: ${accountId}`, {
        onboardingDone,
        payoutsEnabled: account.payouts_enabled,
        chargesEnabled: account.charges_enabled,
      });

      return {
        accountId,
        onboardingDone,
        payoutsEnabled: account.payouts_enabled,
        chargesEnabled: account.charges_enabled,
        detailsSubmitted: account.details_submitted,
        requirementsCurrentlyDue: account.requirements?.currently_due || [],
        requirementsPastDue: account.requirements?.past_due || [],
        lastUpdated: now,
      };
    } catch (error) {
      stripeLogger.error({ error, accountId }, 'Failed to refresh account status');
      
      if (error instanceof TRPCError) {
        throw error;
      }
      
      if (error instanceof Stripe.errors.StripeError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Erreur Stripe: ${error.message}`,
          cause: error,
        });
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Erreur lors du rafraîchissement du statut',
        cause: error,
      });
    }
  }

  /**
   * Récupère l'instance Stripe (pour les webhooks)
   */
  static getStripeInstance(): Stripe {
    return stripe;
  }
}