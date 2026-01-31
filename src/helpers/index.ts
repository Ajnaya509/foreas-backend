/**
 * Backend Helpers - Export centralisé
 */

// Phone utilities
export {
  normalizePhone,
  isValidE164,
  isValidFrenchMobile,
  maskPhone,
  getCountryCode,
} from './phone';

// OTP generation & verification
export {
  generateOTPCode,
  generateSalt,
  hashOTP,
  verifyOTP,
  generateSecureOTP,
  isValidOTPFormat,
} from './otp';

// Supabase admin client
export {
  supabaseAdmin,
  checkSupabaseConnection,
  withRetry,
} from './supabase';

// Rate limiting
export {
  checkRateLimit,
  resetRateLimit,
  isBlocked,
} from './rateLimit';
export type { RateLimitResult } from './rateLimit';

// Consent & RGPD
export {
  logConsentEvent,
  upsertMarketingContact,
  withdrawConsent,
  exportUserData,
  deleteUserData,
} from './consent';
export type { ConsentEventType, ConsentType, MarketingContact } from './consent';
