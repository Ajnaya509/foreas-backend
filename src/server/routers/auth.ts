/**
 * Auth Router - FOREAS Driver Backend
 * Endpoints d'authentification avec validation Zod
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { router, publicProcedure } from '../trpc';

/**
 * Schémas Zod pour la validation des entrées/sorties
 */
const LoginWithEmailInput = z.object({
  email: z.string().email('Format email invalide'),
  password: z.string().min(8, 'Mot de passe minimum 8 caractères'),
});

const LoginWithEmailOutput = z.union([
  z.object({
    success: z.literal(true),
    token: z.string(),
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string().nullable(),
      role: z.enum(['ADMIN', 'DRIVER']),
      status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']),
    }),
  }),
  z.object({
    success: z.literal(true),
    otpRequired: z.literal(true),
    otpSessionId: z.string(),
  }),
]);

const ConsumeOtpInput = z.object({
  otpSessionId: z.string(),
  code: z.string().regex(/^\d{6}$/, 'Code OTP à 6 chiffres requis'),
});

const ConsumeOtpOutput = z.object({
  success: z.boolean(),
  token: z.string().optional(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: z.enum(['ADMIN', 'DRIVER']),
    status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']),
  }).optional(),
});

/**
 * Router d'authentification
 */
export const authRouter = router({
  /**
   * Connexion avec email/mot de passe
   */
  loginWithEmail: publicProcedure
    .input(LoginWithEmailInput)
    .output(LoginWithEmailOutput)
    .mutation(async ({ input }) => {
      const { email, password } = input;

      // Mock: cas avec token direct
      if (email === 'jean.martin@foreas.app' && password === 'MonMotDePasse123!') {
        return {
          success: true as const,
          token: `mock_jwt_token_${Date.now()}`,
          user: {
            id: 'user_123',
            email,
            name: 'Jean Martin',
            role: 'DRIVER' as const,
            status: 'ACTIVE' as const,
          },
        };
      }

      // Mock: cas nécessitant OTP
      if (email === 'driver.with.otp@foreas.app' && password === 'MotDePasseSecure456!') {
        return {
          success: true as const,
          otpRequired: true as const,
          otpSessionId: `otp_session_${Date.now()}`,
        };
      }

      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Identifiants incorrects',
      });
    }),

  /**
   * Validation du code OTP
   */
  consumeOtp: publicProcedure
    .input(ConsumeOtpInput)
    .output(ConsumeOtpOutput)
    .mutation(async ({ input }) => {
      const { code } = input;

      if (code === '123456') {
        return {
          success: true,
          token: `mock_jwt_token_otp_${Date.now()}`,
          user: {
            id: 'user_456',
            email: 'driver.with.otp@foreas.app',
            name: 'Chauffeur avec OTP',
            role: 'DRIVER' as const,
            status: 'ACTIVE' as const,
          },
        };
      }

      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Code OTP invalide',
      });
    }),
});