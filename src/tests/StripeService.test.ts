/**
 * Tests unitaires StripeService - FOREAS Driver Backend
 * Tests avec mocks Stripe pour isoler la logique métier
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Stripe from 'stripe';
import { TRPCError } from '@trpc/server';

import { StripeService } from '@/services/StripeService';
import { prisma } from '@/server/db';
import { testUtils } from './setup';

// Mock Stripe
vi.mock('stripe', () => ({
  default: vi.fn(() => ({
    accounts: {
      create: vi.fn(),
      retrieve: vi.fn(),
    },
    accountLinks: {
      create: vi.fn(),
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  })),
}));

// Mock du logger
vi.mock('@/utils/logger', () => ({
  stripeLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const mockStripe = {
  accounts: {
    create: vi.fn(),
    retrieve: vi.fn(),
  },
  accountLinks: {
    create: vi.fn(),
  },
  webhooks: {
    constructEvent: vi.fn(),
  },
};

// Mock getStripeInstance pour retourner notre mock
vi.spyOn(StripeService, 'getStripeInstance').mockReturnValue(mockStripe as any);

describe('StripeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureAccount', () => {
    it('retourne un compte existant s\'il existe déjà', async () => {
      const user = await testUtils.createTestUser({
        email: 'test@foreas.app',
        name: 'Test Driver',
      });

      // Créer un compte Stripe existant
      await prisma.stripeAccount.create({
        data: {
          userId: user.id,
          accountId: 'acct_existing123',
          chargesEnabled: true,
          payoutsEnabled: false,
          detailsSubmitted: false,
        },
      });

      const result = await StripeService.ensureAccount(user.id);

      expect(result).toEqual({
        accountId: 'acct_existing123',
        isNewAccount: false,
      });

      // Vérifier que Stripe n'a pas été appelé
      expect(mockStripe.accounts.create).not.toHaveBeenCalled();
    });

    it('crée un nouveau compte si aucun n\'existe', async () => {
      const user = await testUtils.createTestUser({
        email: 'newuser@foreas.app',
        name: 'New Driver',
      });

      // Mock de la création Stripe
      mockStripe.accounts.create.mockResolvedValueOnce({
        id: 'acct_new123',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        business_type: 'individual',
        country: 'FR',
        default_currency: 'eur',
      });

      const result = await StripeService.ensureAccount(user.id);

      expect(result).toEqual({
        accountId: 'acct_new123',
        isNewAccount: true,
      });

      // Vérifier l'appel Stripe
      expect(mockStripe.accounts.create).toHaveBeenCalledWith({
        type: 'express',
        country: 'FR',
        email: 'newuser@foreas.app',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
      });

      // Vérifier que le compte a été sauvé en DB
      const savedAccount = await prisma.stripeAccount.findUnique({
        where: { userId: user.id },
      });

      expect(savedAccount).toBeTruthy();
      expect(savedAccount?.accountId).toBe('acct_new123');
    });

    it('lève une erreur si l\'utilisateur n\'existe pas', async () => {
      await expect(StripeService.ensureAccount('user_inexistant')).rejects.toThrow(TRPCError);
      await expect(StripeService.ensureAccount('user_inexistant')).rejects.toThrow('Utilisateur non trouvé');
    });

    it('gère les erreurs Stripe correctement', async () => {
      const user = await testUtils.createTestUser({
        email: 'error@foreas.app',
      });

      mockStripe.accounts.create.mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          message: 'Invalid email',
          param: 'email',
          type: 'invalid_request_error',
        } as any)
      );

      await expect(StripeService.ensureAccount(user.id)).rejects.toThrow(TRPCError);
      await expect(StripeService.ensureAccount(user.id)).rejects.toThrow('Erreur Stripe');
    });
  });

  describe('createOnboardingLink', () => {
    it('crée un lien d\'onboarding avec succès', async () => {
      const accountId = 'acct_test123';
      const refreshUrl = 'https://app.foreas.fr/stripe/refresh';
      const returnUrl = 'https://app.foreas.fr/stripe/return';

      // Mock retrieve account
      mockStripe.accounts.retrieve.mockResolvedValueOnce({
        id: accountId,
        details_submitted: false,
      });

      // Mock create account link
      mockStripe.accountLinks.create.mockResolvedValueOnce({
        url: 'https://connect.stripe.com/express/onboarding/abc123',
        expires_at: 1234567890,
      });

      const result = await StripeService.createOnboardingLink(accountId, refreshUrl, returnUrl);

      expect(result).toEqual({
        url: 'https://connect.stripe.com/express/onboarding/abc123',
        expiresAt: 1234567890,
      });

      expect(mockStripe.accounts.retrieve).toHaveBeenCalledWith(accountId);
      expect(mockStripe.accountLinks.create).toHaveBeenCalledWith({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding',
      });
    });

    it('lève une erreur si le compte n\'existe pas', async () => {
      mockStripe.accounts.retrieve.mockResolvedValueOnce(null);

      await expect(
        StripeService.createOnboardingLink('acct_inexistant', 'refresh', 'return')
      ).rejects.toThrow(TRPCError);
      await expect(
        StripeService.createOnboardingLink('acct_inexistant', 'refresh', 'return')
      ).rejects.toThrow('Compte Stripe non trouvé');
    });

    it('gère les erreurs Stripe pour la création de lien', async () => {
      mockStripe.accounts.retrieve.mockResolvedValueOnce({ id: 'acct_test' });
      mockStripe.accountLinks.create.mockRejectedValueOnce(
        new Stripe.errors.StripeInvalidRequestError({
          message: 'Account not eligible for onboarding',
          type: 'invalid_request_error',
        } as any)
      );

      await expect(
        StripeService.createOnboardingLink('acct_test', 'refresh', 'return')
      ).rejects.toThrow(TRPCError);
    });
  });

  describe('refreshStatus', () => {
    it('rafraîchit le statut et met à jour la DB', async () => {
      const accountId = 'acct_test123';

      // Mock retrieve account avec statut complet
      mockStripe.accounts.retrieve.mockResolvedValueOnce({
        id: accountId,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        business_type: 'individual',
        country: 'FR',
        default_currency: 'eur',
        requirements: {
          currently_due: [],
          past_due: [],
        },
      });

      const result = await StripeService.refreshStatus(accountId);

      expect(result.accountId).toBe(accountId);
      expect(result.onboardingDone).toBe(true);
      expect(result.payoutsEnabled).toBe(true);
      expect(result.chargesEnabled).toBe(true);
      expect(result.detailsSubmitted).toBe(true);
      expect(result.requirementsCurrentlyDue).toEqual([]);
      expect(result.requirementsPastDue).toEqual([]);
      expect(result.lastUpdated).toBeInstanceOf(Date);

      // Vérifier que l'account a été upserted en DB
      const savedAccount = await prisma.stripeAccount.findUnique({
        where: { accountId },
      });
      expect(savedAccount?.chargesEnabled).toBe(true);
      expect(savedAccount?.payoutsEnabled).toBe(true);
      expect(savedAccount?.detailsSubmitted).toBe(true);
    });

    it('détecte un onboarding incomplet', async () => {
      const accountId = 'acct_incomplete';

      mockStripe.accounts.retrieve.mockResolvedValueOnce({
        id: accountId,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: {
          currently_due: ['individual.first_name', 'individual.last_name'],
          past_due: [],
        },
      });

      const result = await StripeService.refreshStatus(accountId);

      expect(result.onboardingDone).toBe(false);
      expect(result.requirementsCurrentlyDue).toEqual(['individual.first_name', 'individual.last_name']);
    });

    it('détecte des exigences en retard', async () => {
      const accountId = 'acct_pastdue';

      mockStripe.accounts.retrieve.mockResolvedValueOnce({
        id: accountId,
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements: {
          currently_due: [],
          past_due: ['individual.ssn_last_4'],
        },
      });

      const result = await StripeService.refreshStatus(accountId);

      expect(result.onboardingDone).toBe(false); // past_due empêche completion
      expect(result.requirementsPastDue).toEqual(['individual.ssn_last_4']);
    });

    it('lève une erreur si le compte n\'existe pas', async () => {
      mockStripe.accounts.retrieve.mockResolvedValueOnce(null);

      await expect(StripeService.refreshStatus('acct_inexistant')).rejects.toThrow(TRPCError);
      await expect(StripeService.refreshStatus('acct_inexistant')).rejects.toThrow('Compte Stripe non trouvé');
    });

    it('gère les erreurs Stripe pour le refresh', async () => {
      mockStripe.accounts.retrieve.mockRejectedValueOnce(
        new Stripe.errors.StripeAPIError({
          message: 'Service temporarily unavailable',
          type: 'api_error',
        } as any)
      );

      await expect(StripeService.refreshStatus('acct_test')).rejects.toThrow(TRPCError);
    });
  });

  describe('getStripeInstance', () => {
    it('retourne une instance Stripe', () => {
      // Restorer le mock temporairement
      vi.mocked(StripeService.getStripeInstance).mockRestore();
      
      const instance = StripeService.getStripeInstance();
      expect(instance).toBeDefined();
      
      // Remettre le mock
      vi.spyOn(StripeService, 'getStripeInstance').mockReturnValue(mockStripe as any);
    });
  });
});