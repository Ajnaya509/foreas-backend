/**
 * OTP Routes - Système de vérification téléphone production-grade
 *
 * Endpoints:
 * - POST /api/auth/send-otp     → Envoie SMS OTP (rate-limited)
 * - POST /api/auth/verify-otp   → Vérifie le code OTP
 * - POST /api/auth/finalize-signup → Finalise l'inscription après vérification
 *
 * Sécurité:
 * - OTP hashé (SHA256 + salt + pepper serveur)
 * - Rate-limiting Postgres (5 req/15min, lockout 30min)
 * - Session token UUID retourné au client
 * - Pas de secrets côté mobile
 */

import { Router, Request, Response } from 'express';

const router = Router();

// Lazy load helpers to avoid startup delay
let helpersLoaded = false;
let normalizePhone: any;
let isValidFrenchMobile: any;
let generateSecureOTP: any;
let hashOTP: any;
let isValidOTPFormat: any;
let checkRateLimit: any;
let logConsentEvent: any;
let upsertMarketingContact: any;
let supabaseAdmin: any;

async function loadHelpers() {
  if (helpersLoaded) return;
  const helpers = await import('../helpers/index.js');
  normalizePhone = helpers.normalizePhone;
  isValidFrenchMobile = helpers.isValidFrenchMobile;
  generateSecureOTP = helpers.generateSecureOTP;
  hashOTP = helpers.hashOTP;
  isValidOTPFormat = helpers.isValidOTPFormat;
  checkRateLimit = helpers.checkRateLimit;
  logConsentEvent = helpers.logConsentEvent;
  upsertMarketingContact = helpers.upsertMarketingContact;
  supabaseAdmin = helpers.supabaseAdmin;
  helpersLoaded = true;
  console.log('[OTP] Helpers loaded');
}

// Bird API configuration
const BIRD_API_KEY = process.env.BIRD_API_KEY || process.env.CLÉ_API_BIRD || process.env.MESSAGEBIRD_API_KEY;
const BIRD_WORKSPACE_ID = process.env.BIRD_WORKSPACE_ID || 'default';
const BIRD_CHANNEL_ID = process.env.BIRD_CHANNEL_ID || '';
const BIRD_API_URL = 'https://api.bird.com/workspaces';

// Types
interface SendOTPRequest {
  phone: string;
  signupData?: {
    firstName: string;
    lastName: string;
    email: string;
    referralCode?: string;
  };
}

interface VerifyOTPRequest {
  sessionToken: string;
  code: string;
}

interface FinalizeSignupRequest {
  sessionToken: string;
  password: string;
}

/**
 * POST /api/auth/send-otp
 */
router.post('/send-otp', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    await loadHelpers();

    const { phone, signupData } = req.body as SendOTPRequest;
    const ip = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // === VALIDATION ===
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'PHONE_REQUIRED',
        message: 'Le numéro de téléphone est requis',
      });
    }

    const normalizedPhone = normalizePhone(phone);

    if (!isValidFrenchMobile(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PHONE',
        message: 'Numéro de téléphone mobile français invalide',
      });
    }

    // === RATE-LIMIT ===
    const rateLimit = await checkRateLimit(normalizedPhone, ip);

    if (!rateLimit.allowed) {
      console.log(`[OTP] ⛔ Rate-limited: ${normalizedPhone.substring(0, 6)}... (${rateLimit.reason})`);

      return res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Trop de tentatives. Réessayez plus tard.',
        retryAfter: rateLimit.retryAfter,
      });
    }

    // === GÉNÉRATION OTP SÉCURISÉ ===
    const { code, salt, hash } = generateSecureOTP();

    console.log(`[OTP] 🔐 Generated OTP for ${normalizedPhone.substring(0, 6)}...`);

    // === CRÉATION SESSION ===
    const { data: session, error: sessionError } = await supabaseAdmin.rpc('create_otp_session', {
      p_phone: normalizedPhone,
      p_otp_hash: hash,
      p_otp_salt: salt,
      p_signup_data: signupData || null,
      p_ip: ip,
      p_user_agent: userAgent,
    });

    if (sessionError) {
      console.error('[OTP] ❌ Session creation failed:', sessionError);
      return res.status(500).json({
        success: false,
        error: 'SESSION_ERROR',
        message: 'Erreur lors de la création de la session',
      });
    }

    const sessionToken = session as string;

    // === ENVOI SMS ===
    let smsSent = false;
    let smsProvider = 'none';

    if (BIRD_API_KEY && BIRD_CHANNEL_ID) {
      try {
        const message = `Votre code de vérification FOREAS est: ${code}. Valable 10 minutes.`;

        const response = await fetch(`${BIRD_API_URL}/${BIRD_WORKSPACE_ID}/channels/${BIRD_CHANNEL_ID}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BIRD_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            receiver: {
              contacts: [{
                identifierValue: normalizedPhone,
                identifierKey: 'phonenumber',
              }],
            },
            body: {
              type: 'text',
              text: { text: message },
            },
          }),
        });

        if (response.ok) {
          smsSent = true;
          smsProvider = 'bird';
          console.log(`[OTP] ✅ SMS sent via Bird to ${normalizedPhone.substring(0, 6)}...`);
        } else {
          // Fallback MessageBird
          const mbResponse = await fetch('https://rest.messagebird.com/messages', {
            method: 'POST',
            headers: {
              'Authorization': `AccessKey ${BIRD_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              originator: 'FOREAS',
              recipients: [normalizedPhone.replace('+', '')],
              body: `Votre code FOREAS: ${code}`,
            }),
          });

          if (mbResponse.ok) {
            smsSent = true;
            smsProvider = 'messagebird';
            console.log(`[OTP] ✅ SMS sent via MessageBird fallback`);
          }
        }
      } catch (smsErr) {
        console.error('[OTP] ❌ SMS send error:', smsErr);
      }
    }

    // DEV MODE: Log le code si SMS non envoyé
    const isDev = process.env.NODE_ENV === 'development' || process.env.DEV_MODE === 'true';
    if (!smsSent && isDev) {
      console.log(`[OTP] 🔧 DEV MODE - Code: ${code} for ${normalizedPhone}`);
    }

    // === RÉPONSE ===
    const duration = Date.now() - startTime;
    console.log(`[OTP] ✅ send-otp completed in ${duration}ms`);

    return res.json({
      success: true,
      sessionToken,
      expiresIn: 600, // 10 minutes
      rateLimitRemaining: rateLimit.remaining,
      ...(isDev && !smsSent ? { devCode: code } : {}),
    });

  } catch (error: any) {
    console.error('[OTP] ❌ send-otp exception:', error.message);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur interne du serveur',
    });
  }
});

/**
 * POST /api/auth/verify-otp
 */
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    await loadHelpers();

    const { sessionToken, code } = req.body as VerifyOTPRequest;

    // === VALIDATION ===
    if (!sessionToken || !code) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_PARAMS',
        message: 'sessionToken et code sont requis',
      });
    }

    if (!isValidOTPFormat(code)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_CODE_FORMAT',
        message: 'Le code doit contenir 6 chiffres',
      });
    }

    // === RÉCUPÉRATION SESSION ===
    const { data: session, error: fetchError } = await supabaseAdmin
      .from('phone_otp_sessions')
      .select('*')
      .eq('session_token', sessionToken)
      .single();

    if (fetchError || !session) {
      return res.status(404).json({
        success: false,
        error: 'SESSION_NOT_FOUND',
        message: 'Session invalide ou expirée',
      });
    }

    // === HASH DU CODE ENTRÉ ===
    const computedHash = hashOTP(code, session.otp_salt);

    // === VÉRIFICATION VIA RPC ===
    const { data: result, error: verifyError } = await supabaseAdmin.rpc('verify_otp_session', {
      p_session_token: sessionToken,
      p_otp_hash: computedHash,
    });

    if (verifyError) {
      console.error('[OTP] ❌ verify_otp_session error:', verifyError);
      return res.status(500).json({
        success: false,
        error: 'VERIFY_ERROR',
        message: 'Erreur lors de la vérification',
      });
    }

    const verifyResult = Array.isArray(result) ? result[0] : result;

    if (verifyResult.success) {
      console.log(`[OTP] ✅ Code verified for session ${sessionToken.substring(0, 8)}...`);

      await logConsentEvent(session.phone, 'phone_verified', { ip: req.ip });

      return res.json({
        success: true,
        verified: true,
        signupData: verifyResult.signup_data,
      });
    }

    console.log(`[OTP] ❌ Invalid code for session ${sessionToken.substring(0, 8)}... (${verifyResult.error_code})`);

    return res.status(400).json({
      success: false,
      error: verifyResult.error_code,
      message: getErrorMessage(verifyResult.error_code),
      remainingAttempts: verifyResult.remaining_attempts,
    });

  } catch (error: any) {
    console.error('[OTP] ❌ verify-otp exception:', error.message);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur interne du serveur',
    });
  }
});

/**
 * POST /api/auth/finalize-signup
 */
router.post('/finalize-signup', async (req: Request, res: Response) => {
  try {
    await loadHelpers();

    const { sessionToken, password } = req.body as FinalizeSignupRequest;
    const ip = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';

    // === VALIDATION ===
    if (!sessionToken || !password) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_PARAMS',
        message: 'sessionToken et password sont requis',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: 'WEAK_PASSWORD',
        message: 'Le mot de passe doit contenir au moins 8 caractères',
      });
    }

    // === RÉCUPÉRATION SESSION VÉRIFIÉE ===
    const { data: session, error: fetchError } = await supabaseAdmin
      .from('phone_otp_sessions')
      .select('*')
      .eq('session_token', sessionToken)
      .eq('status', 'verified')
      .single();

    if (fetchError || !session) {
      return res.status(400).json({
        success: false,
        error: 'SESSION_NOT_VERIFIED',
        message: 'Session non vérifiée ou expirée. Recommencez la vérification.',
      });
    }

    const signupData = session.signup_data as {
      firstName?: string;
      lastName?: string;
      email?: string;
      referralCode?: string;
    } | null;

    if (!signupData?.email) {
      return res.status(400).json({
        success: false,
        error: 'MISSING_EMAIL',
        message: 'Email manquant dans les données d\'inscription',
      });
    }

    // === CRÉATION UTILISATEUR SUPABASE AUTH ===
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: signupData.email,
      password: password,
      phone: session.phone,
      email_confirm: true,
      phone_confirm: true,
      user_metadata: {
        first_name: signupData.firstName,
        last_name: signupData.lastName,
        referral_code: signupData.referralCode,
      },
    });

    if (authError) {
      console.error('[OTP] ❌ Auth user creation failed:', authError);

      if (authError.message.includes('already registered')) {
        return res.status(409).json({
          success: false,
          error: 'EMAIL_EXISTS',
          message: 'Cet email est déjà utilisé',
        });
      }

      return res.status(500).json({
        success: false,
        error: 'AUTH_ERROR',
        message: 'Erreur lors de la création du compte',
      });
    }

    const userId = authData.user.id;

    // === CRÉATION PROFIL DRIVER ===
    const { error: driverError } = await supabaseAdmin
      .from('drivers')
      .insert({
        id: userId,
        email: signupData.email,
        phone: session.phone,
        first_name: signupData.firstName,
        last_name: signupData.lastName,
        auth_user_id: userId,
        is_verified: true,
        is_active: true,
      });

    if (driverError) {
      console.error('[OTP] ⚠️ Driver profile creation failed:', driverError);
    }

    // === CONTACT MARKETING ===
    await upsertMarketingContact({
      phone: session.phone,
      email: signupData.email,
      firstName: signupData.firstName,
      lastName: signupData.lastName,
      smsConsent: true,
      source: 'signup',
      referralCode: signupData.referralCode,
    }, ip);

    // === LOGGER ÉVÉNEMENT ===
    await logConsentEvent(session.phone, 'signup_completed', {
      ip,
      metadata: { userId, email: signupData.email },
    });

    // === NETTOYER SESSION ===
    await supabaseAdmin
      .from('phone_otp_sessions')
      .update({ status: 'expired' })
      .eq('session_token', sessionToken);

    console.log(`[OTP] ✅ Signup completed for ${signupData.email}`);

    return res.json({
      success: true,
      userId,
      email: signupData.email,
      message: 'Compte créé avec succès',
    });

  } catch (error: any) {
    console.error('[OTP] ❌ finalize-signup exception:', error.message);
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: 'Erreur interne du serveur',
    });
  }
});

/**
 * GET /api/auth/otp/status
 */
router.get('/otp/status', (req: Request, res: Response) => {
  res.json({
    service: 'otp',
    version: '2.0.0',
    provider: BIRD_API_KEY ? 'bird' : 'none',
    configured: !!BIRD_API_KEY && !!BIRD_CHANNEL_ID,
    devMode: process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development',
  });
});

// Helper: messages d'erreur
function getErrorMessage(errorCode: string): string {
  const messages: Record<string, string> = {
    'session_not_found': 'Session invalide ou expirée',
    'session_expired': 'Le code a expiré. Demandez un nouveau code.',
    'already_verified': 'Ce code a déjà été utilisé',
    'session_blocked': 'Trop de tentatives. Session bloquée.',
    'invalid_code': 'Code incorrect',
    'max_attempts_reached': 'Trop de tentatives. Demandez un nouveau code.',
  };
  return messages[errorCode] || 'Erreur de vérification';
}

export default router;
export { router as otpRouter };
