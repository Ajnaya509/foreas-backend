/**
 * Configuration environnement FOREAS Driver
 * Validation stricte des variables d'environnement avec Zod
 */

import { z } from 'zod';

const environmentSchema = z.object({
  // Base
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default(3001),
  
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL requis'),
  
  // Auth
  NEXTAUTH_SECRET: z.string().min(32, 'NEXTAUTH_SECRET trop court'),
  NEXTAUTH_URL: z.string().url('NEXTAUTH_URL invalide'),
  
  // Stripe
  STRIPE_SECRET_KEY: z.string().startsWith('sk_', 'Clé Stripe invalide'),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith('pk_', 'Clé publique Stripe invalide'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'STRIPE_WEBHOOK_SECRET requis'),
  
  // Ajnaya IA
  AJNAYA_ENABLED: z.string().transform(Boolean).default(true),
  MISTRAL_API_KEY: z.string().optional(),
  WEATHER_API_KEY: z.string().optional(),
  
  // Monitoring
  SENTRY_DSN: z.string().url().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  
  // Features flags
  STRIPE_CONNECT_ENABLED: z.string().transform(Boolean).default(true),
  MULTI_PLATFORM_ENABLED: z.string().transform(Boolean).default(false),
});

export type Environment = z.infer<typeof environmentSchema>;

let env: Environment;

try {
  env = environmentSchema.parse(process.env);
} catch (error) {
  console.error('❌ Configuration environnement invalide:', error);
  process.exit(1);
}

export { env };

export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';
export const isTesting = env.NODE_ENV === 'test';

// Configurations dérivées
export const corsConfig = {
  origin: isDevelopment 
    ? ['http://localhost:8081', 'http://localhost:19006', 'exp://192.168.1.*:19000']
    : ['https://foreas.app', 'https://app.foreas.xyz'],
  credentials: true,
};

export const stripeConfig = {
  apiVersion: '2023-10-16' as const,
  typescript: true,
  timeout: 20000,
  maxNetworkRetries: 3,
  appInfo: {
    name: 'FOREAS Driver',
    version: '1.0.0',
    url: 'https://foreas.app',
  },
};

export const ajnayaConfig = {
  enabled: env.AJNAYA_ENABLED,
  feedbackRetentionDays: 90,
  recommendationTtlHours: 4,
  maxInsightsPerUser: 20,
};

export const logConfig = {
  level: env.LOG_LEVEL,
  format: isProduction ? 'json' : 'pretty',
  redactSensitiveData: isProduction,
};