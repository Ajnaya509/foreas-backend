import { z } from 'zod';

/**
 * Centralized environment variable validation using Zod
 * This ensures type safety and runtime validation of all env vars
 */

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

/**
 * Define the schema for environment variables
 * All required variables must be defined here
 */
const envSchema = z.object({
  // Database
  DATABASE_URL: z
    .string({
      required_error: 'DATABASE_URL is required',
      invalid_type_error: 'DATABASE_URL must be a string',
    })
    .url({
      message: 'DATABASE_URL must be a valid URL (e.g., postgresql://...)',
    })
    .min(1, 'DATABASE_URL cannot be empty'),

  // Stripe
  STRIPE_SECRET_KEY: z
    .string({
      required_error: 'STRIPE_SECRET_KEY is required',
      invalid_type_error: 'STRIPE_SECRET_KEY must be a string',
    })
    .min(1, 'STRIPE_SECRET_KEY cannot be empty')
    .regex(/^sk_(test|live)_/, 'STRIPE_SECRET_KEY must start with sk_test_ or sk_live_'),

  STRIPE_WEBHOOK_SECRET: z
    .string({
      required_error: 'STRIPE_WEBHOOK_SECRET is required',
      invalid_type_error: 'STRIPE_WEBHOOK_SECRET must be a string',
    })
    .min(1, 'STRIPE_WEBHOOK_SECRET cannot be empty')
    .regex(/^whsec_/, 'STRIPE_WEBHOOK_SECRET must start with whsec_'),

  // Application URLs
  APP_ORIGIN: z
    .string({
      required_error: 'APP_ORIGIN is required',
      invalid_type_error: 'APP_ORIGIN must be a string',
    })
    .url({
      message: 'APP_ORIGIN must be a valid URL (e.g., https://app.foreas.com)',
    })
    .min(1, 'APP_ORIGIN cannot be empty'),

  RETURN_URL: z
    .string({
      required_error: 'RETURN_URL is required',
      invalid_type_error: 'RETURN_URL must be a string',
    })
    .url({
      message: 'RETURN_URL must be a valid URL',
    })
    .min(1, 'RETURN_URL cannot be empty'),

  REFRESH_URL: z
    .string({
      required_error: 'REFRESH_URL is required',
      invalid_type_error: 'REFRESH_URL must be a string',
    })
    .url({
      message: 'REFRESH_URL must be a valid URL',
    })
    .min(1, 'REFRESH_URL cannot be empty'),

  // Optional - Monitoring
  SENTRY_DSN: z
    .string()
    .url({
      message: 'SENTRY_DSN must be a valid URL if provided',
    })
    .optional(),

  // AI Backend Proxy
  FOREAS_SERVICE_KEY: z
    .string({
      required_error: 'FOREAS_SERVICE_KEY is required for AI proxy',
    })
    .min(1, 'FOREAS_SERVICE_KEY cannot be empty')
    .regex(/^foreas-/, 'FOREAS_SERVICE_KEY must start with foreas-'),

  AI_BACKEND_URL: z
    .string()
    .url({
      message: 'AI_BACKEND_URL must be a valid URL',
    })
    .default('https://foreas-ai-backend-production.up.railway.app'),

  // Node environment
  NODE_ENV: z
    .enum(['development', 'test', 'production'], {
      errorMap: () => ({
        message: 'NODE_ENV must be either development, test, or production',
      }),
    })
    .default('development'),

  // Port (with default)
  PORT: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive().max(65535))
    .default('3000')
    .optional(),
});

/**
 * Type inference for the validated environment
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Validate and parse environment variables
 * This will throw an error if validation fails
 */
function validateEnv(): Env {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors
        .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n');

      console.error('❌ Environment validation failed:\n');
      console.error(missingVars);
      console.error('\n📝 Please check your .env file and ensure all required variables are set.');
      console.error('   See .env.example for reference.\n');

      // Never log sensitive values
      const safeVars = Object.keys(process.env)
        .filter((key) => !key.includes('SECRET') && !key.includes('KEY') && !key.includes('TOKEN'))
        .reduce(
          (acc, key) => ({
            ...acc,
            [key]: process.env[key],
          }),
          {},
        );

      console.error('Current safe environment variables:', safeVars);

      process.exit(1);
    }
    throw error;
  }
}

/**
 * Validated environment variables
 * Use this throughout the application instead of process.env
 */
export const env = validateEnv();

/**
 * Type-safe environment variable access
 * @example
 * import { env } from '@/env';
 * 
 * // Use env variables with full type safety
 * const dbUrl = env.DATABASE_URL; // string
 * const sentryDsn = env.SENTRY_DSN; // string | undefined
 * const port = env.PORT; // number | undefined
 */

// Prevent accidental logging of secrets
if (env.NODE_ENV !== 'production') {
  const safeEnv = {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    APP_ORIGIN: env.APP_ORIGIN,
    DATABASE_URL: env.DATABASE_URL.replace(/\/\/[^@]+@/, '//***:***@'), // Hide credentials
  };
  console.log('✅ Environment variables loaded and validated:', safeEnv);
}