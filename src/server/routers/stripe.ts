/**
 * Stripe Router - FOREAS Driver Backend
 * Gestion Stripe Connect avec validation Zod
 */

import { z } from 'zod';

import { router, publicProcedure } from '../trpc';
import { requireAuth } from '../middleware/requireAuth';
import { StripeService } from '@/services/StripeService';
import { env } from '@/env';

/**
 * Schémas Zod pour la validation des entrées/sorties
 */
const CreateOnboardingLinkInput = z.object({
  returnUrl: z.string().url().optional(),
  refreshUrl: z.string().url().optional(),
});

const CreateOnboardingLinkOutput = z.object({
  onboardingUrl: z.string().url(),
  accountId: z.string(),
  expiresAt: z.number(),
  isNewAccount: z.boolean(),
});

const RefreshAccountInput = z.object({});

const RefreshAccountOutput = z.object({
  accountId: z.string(),
  onboardingDone: z.boolean(),
  payoutsEnabled: z.boolean(),
  chargesEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  requirementsCurrentlyDue: z.array(z.string()),
  requirementsPastDue: z.array(z.string()),
  lastUpdated: z.date(),
});

/**
 * Router des paiements Stripe
 */
export const stripeRouter = router({
  /**
   * Créer un lien d'onboarding Stripe Connect
   */
  createOnboardingLink: publicProcedure
    .use(requireAuth)
    .input(CreateOnboardingLinkInput)
    .output(CreateOnboardingLinkOutput)
    .mutation(async ({ input, ctx }) => {
      // S'assurer que le compte Stripe existe
      const accountInfo = await StripeService.ensureAccount(ctx.userId);

      // Utiliser les URLs par défaut si non spécifiées
      const returnUrl = input.returnUrl || env.RETURN_URL;
      const refreshUrl = input.refreshUrl || env.REFRESH_URL;

      // Créer le lien d'onboarding
      const onboardingLink = await StripeService.createOnboardingLink(
        accountInfo.accountId,
        refreshUrl,
        returnUrl
      );

      return {
        onboardingUrl: onboardingLink.url,
        accountId: accountInfo.accountId,
        expiresAt: onboardingLink.expiresAt,
        isNewAccount: accountInfo.isNewAccount,
      };
    }),

  /**
   * Rafraîchir le statut du compte Stripe
   */
  refreshAccount: publicProcedure
    .use(requireAuth)
    .input(RefreshAccountInput)
    .output(RefreshAccountOutput)
    .mutation(async ({ ctx }) => {
      // S'assurer que le compte existe
      const accountInfo = await StripeService.ensureAccount(ctx.userId);

      // Rafraîchir le statut
      const status = await StripeService.refreshStatus(accountInfo.accountId);

      return status;
    }),
});