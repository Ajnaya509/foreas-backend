/**
 * OTP Routes - Système de vérification téléphone production-grade
 *
 * Endpoints:
 * - POST /api/auth/send-otp     → Envoie SMS OTP (rate-limited)
 * - POST /api/auth/verify-otp   → Vérifie le code OTP
 * - POST /api/auth/finalize-signup → Finalise l'inscription après vérification
 *
 * 13/07 — MIGRATION Bird Verify → Twilio Verify. Root cause trouvée : le canal
 * Bird ("FOREAS") était un SENDER ALPHANUMÉRIQUE (NUMBER_TYPE=alpha), pas un
 * numéro/short code dédié — cause connue de délais de plusieurs heures sur les
 * opérateurs FR pour du trafic OTP (dépriorisé par rapport aux routes
 * transactionnelles enregistrées). Confirmé concrètement : un SMS envoyé la
 * veille n'est arrivé QUE le lendemain matin. Twilio Verify (Service SID déjà
 * provisionné sur Railway, jamais câblé) gère nativement la route/le sender
 * OTP par pays — plus de génération/hash de code local, Twilio gère tout.
 *
 * Sécurité:
 * - Code géré entièrement par Twilio Verify (aucun secret OTP côté nous)
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
let checkRateLimit: any;
let logConsentEvent: any;
let upsertMarketingContact: any;
let supabaseAdmin: any;

async function loadHelpers() {
  if (helpersLoaded) return;
  const helpers = await import('../helpers/index.js');
  normalizePhone = helpers.normalizePhone;
  isValidFrenchMobile = helpers.isValidFrenchMobile;
  checkRateLimit = helpers.checkRateLimit;
  logConsentEvent = helpers.logConsentEvent;
  upsertMarketingContact = helpers.upsertMarketingContact;
  supabaseAdmin = helpers.supabaseAdmin;
  helpersLoaded = true;
  console.log('[OTP] Helpers loaded');
}

// Twilio Verify configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const TWILIO_VERIFY_URL = TWILIO_VERIFY_SERVICE_SID
  ? `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}`
  : null;

function twilioAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
}

// Log config at module load
console.log(
  `[OTP] Config: TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID ? `...${TWILIO_ACCOUNT_SID.slice(-6)}` : 'MISSING'}, VERIFY_SERVICE=${TWILIO_VERIFY_SERVICE_SID ? `...${TWILIO_VERIFY_SERVICE_SID.slice(-6)}` : 'MISSING'}`,
);

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
      console.log(
        `[OTP] ⛔ Rate-limited: ${normalizedPhone.substring(0, 6)}... (${rateLimit.reason})`,
      );

      return res.status(429).json({
        success: false,
        error: 'RATE_LIMITED',
        message: 'Trop de tentatives. Réessayez plus tard.',
        retryAfter: rateLimit.retryAfter,
      });
    }

    // === ENVOI SMS VIA TWILIO VERIFY ===
    // Twilio génère, envoie ET vérifiera le code lui-même — aucun code/hash local.
    let smsSent = false;
    let smsProvider = 'none';
    let twilioVerificationMarker: string | null = null;

    if (TWILIO_VERIFY_URL && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      try {
        const twilioRes = await fetch(`${TWILIO_VERIFY_URL}/Verifications`, {
          method: 'POST',
          headers: {
            Authorization: twilioAuthHeader(),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: normalizedPhone, Channel: 'sms' }).toString(),
        });

        const twilioBody = await twilioRes.text();
        console.log(
          `[OTP] Twilio Verify create response: ${twilioRes.status} ${twilioBody.substring(0, 500)}`,
        );

        if (twilioRes.ok) {
          try {
            const parsed = JSON.parse(twilioBody);
            if (parsed?.sid && (parsed?.status === 'pending' || parsed?.status === 'approved')) {
              smsSent = true;
              smsProvider = 'twilio-verify';
              twilioVerificationMarker = `twilio:${parsed.sid}`;
              console.log(
                `[OTP] ✅ Verification created via Twilio Verify (sid=${parsed.sid}) for ${normalizedPhone.substring(0, 6)}...`,
              );
            } else {
              console.log('[OTP] Twilio Verify: réponse OK mais forme inattendue.');
            }
          } catch {
            console.log('[OTP] Twilio Verify: JSON invalide.');
          }
        }

        if (!smsSent) {
          console.log('[OTP] ❌ Twilio Verify a échoué. SMS NOT sent.');
        }
      } catch (smsErr) {
        console.error('[OTP] ❌ SMS send error:', smsErr);
      }
    } else {
      console.warn(
        '[OTP] Twilio non configuré (TWILIO_ACCOUNT_SID/AUTH_TOKEN/VERIFY_SERVICE_SID manquant)',
      );
    }

    // === CRÉATION SESSION ===
    // otp_hash/otp_salt restent NULL : Twilio seul connaît le code. Le champ
    // bird_verification_id (nom legacy, conservé pour ne pas migrer le schéma)
    // stocke désormais le marqueur "twilio:<verification sid>".
    const { data: session, error: sessionError } = await supabaseAdmin.rpc('create_otp_session', {
      p_phone: normalizedPhone,
      p_otp_hash: null,
      p_otp_salt: null,
      p_signup_data: signupData || null,
      p_ip: ip,
      p_user_agent: userAgent,
      p_bird_verification_id: twilioVerificationMarker,
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
    const duration = Date.now() - startTime;

    // HONNÊTETÉ (audit Fable) : si l'envoi a échoué, NE PAS mentir « success:true ».
    if (!smsSent) {
      console.log(`[OTP] ❌ send-otp: SMS NON envoyé → 502 SMS_SEND_FAILED (in ${duration}ms)`);
      return res.status(502).json({
        success: false,
        error: 'SMS_SEND_FAILED',
        message: "L'envoi du SMS a échoué. Réessaie dans un instant.",
        smsSent: false,
      });
    }

    console.log(`[OTP] ✅ send-otp completed in ${duration}ms (smsSent=${smsSent})`);
    return res.json({
      success: true,
      sessionToken,
      expiresIn: 600, // 10 minutes
      rateLimitRemaining: rateLimit.remaining,
      smsSent,
      smsProvider,
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

    // === VÉRIFICATION DU CODE VIA TWILIO VERIFY ===
    // Twilio Verify Check est keyé par NUMÉRO (To), pas par verification sid —
    // le marqueur bird_verification_id sert juste à savoir qu'on est sur ce chemin.
    if (!session.bird_verification_id?.startsWith('twilio:')) {
      return res.status(502).json({
        success: false,
        error: 'VERIFY_PROVIDER_UNAVAILABLE',
        message: "Session créée avec un fournisseur SMS non reconnu. Recommence l'inscription.",
      });
    }

    let twilioVerified = false;
    try {
      const checkRes = await fetch(`${TWILIO_VERIFY_URL}/VerificationCheck`, {
        method: 'POST',
        headers: {
          Authorization: twilioAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: session.phone, Code: code }).toString(),
      });
      const checkBody = await checkRes.text();
      console.log(
        `[OTP] Twilio Verify check response: ${checkRes.status} ${checkBody.substring(0, 300)}`,
      );

      // 404 = vérification expirée/déjà consommée côté Twilio → session_expired,
      // pas "code faux". Tout autre statut hors 200 = panne service, jamais
      // imputé au chauffeur comme une tentative ratée (même garde que l'ancien
      // chemin Bird, validée par Fable 5).
      if (checkRes.status === 404) {
        return res.status(400).json({
          success: false,
          error: 'session_expired',
          message: 'Le code a expiré. Demandez un nouveau code.',
        });
      }
      if (checkRes.status !== 200) {
        console.error(
          `[OTP] ❌ Twilio Verify check: statut inattendu ${checkRes.status}, traité comme panne`,
        );
        return res.status(502).json({
          success: false,
          error: 'TWILIO_VERIFY_UNAVAILABLE',
          message: 'Impossible de vérifier le code pour le moment. Réessaie.',
        });
      }

      const parsed = JSON.parse(checkBody);
      twilioVerified = parsed?.status === 'approved';
    } catch (twilioErr: any) {
      console.error('[OTP] ❌ Twilio Verify check error:', twilioErr?.message || twilioErr);
      return res.status(502).json({
        success: false,
        error: 'TWILIO_VERIFY_UNAVAILABLE',
        message: 'Impossible de vérifier le code pour le moment. Réessaie.',
      });
    }

    const { data: result, error: verifyError } = await supabaseAdmin.rpc(
      'verify_otp_session_bird',
      {
        p_session_token: sessionToken,
        p_bird_verified: twilioVerified,
      },
    );

    if (verifyError) {
      console.error('[OTP] ❌ verify_otp_session_bird error:', verifyError);
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

    console.log(
      `[OTP] ❌ Invalid code for session ${sessionToken.substring(0, 8)}... (${verifyResult.error_code})`,
    );

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
        message: "Email manquant dans les données d'inscription",
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
    const { error: driverError } = await supabaseAdmin.from('drivers').insert({
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
    await upsertMarketingContact(
      {
        phone: session.phone,
        email: signupData.email,
        firstName: signupData.firstName,
        lastName: signupData.lastName,
        smsConsent: true,
        source: 'signup',
        referralCode: signupData.referralCode,
      },
      ip,
    );

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
    version: '3.0.0',
    provider: TWILIO_VERIFY_URL ? 'twilio' : 'none',
    configured: !!TWILIO_ACCOUNT_SID && !!TWILIO_AUTH_TOKEN && !!TWILIO_VERIFY_SERVICE_SID,
    devMode: process.env.DEV_MODE === 'true' || process.env.NODE_ENV === 'development',
  });
});

// Helper: messages d'erreur
function getErrorMessage(errorCode: string): string {
  const messages: Record<string, string> = {
    session_not_found: 'Session invalide ou expirée',
    session_expired: 'Le code a expiré. Demandez un nouveau code.',
    already_verified: 'Ce code a déjà été utilisé',
    session_blocked: 'Trop de tentatives. Session bloquée.',
    invalid_code: 'Code incorrect',
    max_attempts_reached: 'Trop de tentatives. Demandez un nouveau code.',
  };
  return messages[errorCode] || 'Erreur de vérification';
}

export default router;
export { router as otpRouter };
