import Stripe from "stripe";
import { env } from "@/env";

/**
 * Client Stripe sécurisé pour FOREAS
 * 
 * CONFIGURATION:
 * - API Version fixée pour éviter les breaking changes
 * - Timeout configuré pour éviter les requêtes infinies
 * - User-Agent personnalisé pour le monitoring Stripe
 */
export const stripe = new Stripe(env.STRIPE_SECRET_KEY!, {
  apiVersion: "2023-10-16", // Version stable
  typescript: true,
  timeout: 20000, // 20 secondes max
  maxNetworkRetries: 3,
  appInfo: {
    name: "FOREAS Driver",
    version: "1.0.0",
    url: "https://foreas.app",
  },
});

/**
 * Configuration Stripe Connect pour les chauffeurs
 * 
 * SÉCURITÉ:
 * - Type 'express' pour onboarding rapide
 * - Capabilities limitées aux paiements
 * - Validation automatique des documents
 */
export const STRIPE_CONNECT_CONFIG = {
  account: {
    type: "express" as const,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: "individual" as const,
    country: "FR", // France uniquement pour FOREAS
    default_currency: "eur",
    settings: {
      payouts: {
        schedule: {
          interval: "daily" as const,
        },
      },
    },
  },
  
  // URLs de redirection selon l'environnement
  urls: {
    development: {
      refresh_url: "http://localhost:8082/stripe/reauth",
      return_url: "http://localhost:8082/stripe/success",
      failure_url: "http://localhost:8082/stripe/error",
    },
    production: {
      refresh_url: "https://foreas.app/stripe/reauth",
      return_url: "https://foreas.app/stripe/success", 
      failure_url: "https://foreas.app/stripe/error",
    },
  },

  // Commission FOREAS (en pourcentage)
  platform_fee_percent: 5, // 5% de commission
} as const;

/**
 * Calcule la commission FOREAS sur un montant
 */
export function calculatePlatformFee(amount: number): number {
  return Math.round(amount * (STRIPE_CONNECT_CONFIG.platform_fee_percent / 100));
}

/**
 * Valide qu'un account ID Stripe est valide
 */
export function isValidStripeAccountId(accountId: string): boolean {
  return /^acct_[A-Za-z0-9]{16,}$/.test(accountId);
}

/**
 * Valide qu'un payment intent ID est valide
 */
export function isValidStripePaymentId(paymentId: string): boolean {
  return /^pi_[A-Za-z0-9]{16,}$/.test(paymentId);
}

/**
 * Génère les URLs de redirection selon l'environnement
 */
export function getStripeUrls() {
  const isDev = env.NODE_ENV === "development";
  return isDev 
    ? STRIPE_CONNECT_CONFIG.urls.development
    : STRIPE_CONNECT_CONFIG.urls.production;
}

/**
 * Types Stripe personnalisés pour FOREAS
 */
export interface StripeAccountCreationResult {
  accountId: string;
  onboardingUrl: string;
  expiresAt: Date;
}

export interface StripePaymentIntentData {
  id: string;
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  clientSecret: string;
  platformFee: number;
  netAmount: number;
  commission?: {
    totalAmount: number;
    commissionTier: string;
    commissionPercentage: number;
    commissionAmount: number;
    netAmount: number;
    breakdown: {
      subtotal: number;
      commission: number;
      stripeProcessingFee: number;
      driverReceives: number;
    };
  };
}