/**
 * Tests intégration Webhook Stripe - FOREAS Driver Backend
 * Tests avec payload signé et vérification idempotence
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import Stripe from 'stripe';

import { handleStripeWebhook } from '@/webhooks/stripeWebhook';
import { StripeService } from '@/services/StripeService';
import { prisma } from '@/server/db';
import { env } from '@/env';
import { testUtils } from './setup';

// Mock du logger
vi.mock('@/utils/logger', () => ({
  webhookLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock de StripeService
vi.mock('@/services/StripeService');

const mockStripeService = vi.mocked(StripeService);

describe('Webhook Stripe Integration', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    // Mock StripeService.getStripeInstance
    mockStripeService.getStripeInstance.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(),
      },
    } as any);
  });

  describe('Signature Verification', () => {
    it('rejette une requête sans signature', async () => {
      mockReq = {
        headers: {},
        body: '{"test": "data"}',
      };

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Missing signature' });
    });

    it('rejette une signature invalide', async () => {
      const mockConstructEvent = vi.fn().mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      mockStripeService.getStripeInstance.mockReturnValue({
        webhooks: { constructEvent: mockConstructEvent },
      } as any);

      mockReq = {
        headers: { 'stripe-signature': 'invalid_signature' },
        body: '{"test": "data"}',
      };

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    });

    it('accepte une signature valide', async () => {
      const mockEvent = {
        id: 'evt_test123',
        type: 'account.updated',
        data: {
          object: {
            id: 'acct_test123',
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
          },
        },
        created: 1234567890,
        livemode: false,
      };

      const mockConstructEvent = vi.fn().mockReturnValue(mockEvent);

      mockStripeService.getStripeInstance.mockReturnValue({
        webhooks: { constructEvent: mockConstructEvent },
      } as any);

      mockStripeService.refreshStatus.mockResolvedValue({
        accountId: 'acct_test123',
        onboardingDone: true,
        payoutsEnabled: true,
        chargesEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        lastUpdated: new Date(),
      });

      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
        body: '{"id":"evt_test123","type":"account.updated"}',
      };

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockConstructEvent).toHaveBeenCalledWith(
        '{"id":"evt_test123","type":"account.updated"}',
        'valid_signature',
        env.STRIPE_WEBHOOK_SECRET
      );

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({ received: true, processed: true });
    });
  });

  describe('Event Type Handling', () => {
    beforeEach(() => {
      const mockConstructEvent = vi.fn().mockImplementation((payload, signature) => {
        const parsedPayload = JSON.parse(payload);
        return {
          id: parsedPayload.id,
          type: parsedPayload.type,
          data: parsedPayload.data,
          created: 1234567890,
          livemode: false,
        };
      });

      mockStripeService.getStripeInstance.mockReturnValue({
        webhooks: { constructEvent: mockConstructEvent },
      } as any);

      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
      };
    });

    it('ignore les événements non supportés', async () => {
      mockReq.body = JSON.stringify({
        id: 'evt_unsupported',
        type: 'charge.succeeded',
        data: { object: {} },
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({ 
        received: true, 
        message: 'Event type not supported' 
      });
    });

    it('traite account.updated correctement', async () => {
      mockReq.body = JSON.stringify({
        id: 'evt_account_updated',
        type: 'account.updated',
        data: {
          object: {
            id: 'acct_test123',
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
          },
        },
      });

      mockStripeService.refreshStatus.mockResolvedValue({
        accountId: 'acct_test123',
        onboardingDone: true,
        payoutsEnabled: true,
        chargesEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        lastUpdated: new Date(),
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockStripeService.refreshStatus).toHaveBeenCalledWith('acct_test123');
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('traite payout.paid correctement', async () => {
      mockReq.body = JSON.stringify({
        id: 'evt_payout_paid',
        type: 'payout.paid',
        data: {
          object: {
            id: 'po_test123',
            amount: 5000, // 50€
            currency: 'eur',
            status: 'paid',
            destination: 'acct_test123',
            arrival_date: 1234567890,
          },
        },
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('traite payout.failed correctement', async () => {
      mockReq.body = JSON.stringify({
        id: 'evt_payout_failed',
        type: 'payout.failed',
        data: {
          object: {
            id: 'po_failed123',
            amount: 3000, // 30€
            currency: 'eur',
            status: 'failed',
            destination: 'acct_test123',
            failure_code: 'account_closed',
            failure_message: 'Account is closed',
          },
        },
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });
  });

  describe('Idempotence', () => {
    beforeEach(() => {
      const mockConstructEvent = vi.fn().mockReturnValue({
        id: 'evt_idempotence_test',
        type: 'account.updated',
        data: { object: { id: 'acct_test' } },
        created: 1234567890,
        livemode: false,
      });

      mockStripeService.getStripeInstance.mockReturnValue({
        webhooks: { constructEvent: mockConstructEvent },
      } as any);

      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
        body: JSON.stringify({
          id: 'evt_idempotence_test',
          type: 'account.updated',
          data: { object: { id: 'acct_test' } },
        }),
      };
    });

    it('traite un nouvel événement', async () => {
      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      // Vérifier que l'événement a été enregistré
      const webhookEvent = await prisma.webhookEvent.findUnique({
        where: { eventId: 'evt_idempotence_test' },
      });

      expect(webhookEvent).toBeTruthy();
      expect(webhookEvent?.processed).toBe(true);
      expect(webhookEvent?.eventType).toBe('account.updated');
      expect(webhookEvent?.error).toBeNull();

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({ received: true, processed: true });
    });

    it('ignore un événement déjà traité', async () => {
      // Créer un événement déjà traité
      await prisma.webhookEvent.create({
        data: {
          eventId: 'evt_idempotence_test',
          eventType: 'account.updated',
          processed: true,
          processedAt: new Date(),
        },
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({ 
        received: true, 
        message: 'Event already processed' 
      });
    });

    it('retraite un événement en cours de traitement', async () => {
      // Créer un événement non traité (en cours)
      await prisma.webhookEvent.create({
        data: {
          eventId: 'evt_idempotence_test',
          eventType: 'account.updated',
          processed: false,
        },
      });

      mockStripeService.refreshStatus.mockResolvedValue({
        accountId: 'acct_test',
        onboardingDone: false,
        payoutsEnabled: false,
        chargesEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: ['individual.first_name'],
        requirementsPastDue: [],
        lastUpdated: new Date(),
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockStripeService.refreshStatus).toHaveBeenCalledWith('acct_test');
      expect(mockRes.status).toHaveBeenCalledWith(200);

      // Vérifier que l'événement est maintenant marqué comme traité
      const webhookEvent = await prisma.webhookEvent.findUnique({
        where: { eventId: 'evt_idempotence_test' },
      });
      expect(webhookEvent?.processed).toBe(true);
      expect(webhookEvent?.processedAt).toBeTruthy();
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      const mockConstructEvent = vi.fn().mockReturnValue({
        id: 'evt_error_test',
        type: 'account.updated',
        data: { object: { id: 'acct_error' } },
        created: 1234567890,
        livemode: false,
      });

      mockStripeService.getStripeInstance.mockReturnValue({
        webhooks: { constructEvent: mockConstructEvent },
      } as any);

      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
        body: JSON.stringify({
          id: 'evt_error_test',
          type: 'account.updated',
          data: { object: { id: 'acct_error' } },
        }),
      };
    });

    it('gère les erreurs de traitement', async () => {
      mockStripeService.refreshStatus.mockRejectedValue(
        new Error('Service unavailable')
      );

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Processing failed',
        eventId: 'evt_error_test',
        message: 'Service unavailable',
      });

      // Vérifier que l'événement est marqué avec erreur
      const webhookEvent = await prisma.webhookEvent.findUnique({
        where: { eventId: 'evt_error_test' },
      });
      expect(webhookEvent?.processed).toBe(true);
      expect(webhookEvent?.error).toBe('Service unavailable');
    });
  });

  describe('Body Formats', () => {
    beforeEach(() => {
      const mockConstructEvent = vi.fn().mockReturnValue({
        id: 'evt_body_test',
        type: 'account.updated',
        data: { object: { id: 'acct_test' } },
        created: 1234567890,
        livemode: false,
      });

      mockStripeService.getStripeInstance.mockReturnValue({
        webhooks: { constructEvent: mockConstructEvent },
      } as any);
    });

    it('gère le body en string', async () => {
      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
        body: '{"id":"evt_body_test","type":"account.updated"}',
      };

      mockStripeService.refreshStatus.mockResolvedValue({
        accountId: 'acct_test',
        onboardingDone: true,
        payoutsEnabled: true,
        chargesEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        lastUpdated: new Date(),
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('gère le body en Buffer', async () => {
      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
        body: Buffer.from('{"id":"evt_body_test","type":"account.updated"}'),
      };

      mockStripeService.refreshStatus.mockResolvedValue({
        accountId: 'acct_test',
        onboardingDone: true,
        payoutsEnabled: true,
        chargesEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        requirementsPastDue: [],
        lastUpdated: new Date(),
      });

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(200);
    });

    it('rejette un format de body invalide', async () => {
      mockReq = {
        headers: { 'stripe-signature': 'valid_signature' },
        body: { invalid: 'object' }, // Objet JS au lieu de string/Buffer
      };

      await handleStripeWebhook(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
    });
  });
});