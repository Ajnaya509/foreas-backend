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
} from './phone.js';

// OTP generation & verification
export {
  generateOTPCode,
  generateSalt,
  hashOTP,
  verifyOTP,
  generateSecureOTP,
  isValidOTPFormat,
} from './otp.js';

// Supabase admin client
export {
  supabaseAdmin,
  checkSupabaseConnection,
  withRetry,
} from './supabase.js';

// Rate limiting
export {
  checkRateLimit,
  resetRateLimit,
  isBlocked,
} from './rateLimit.js';
export type { RateLimitResult } from './rateLimit.js';

// Consent & RGPD
export {
  logConsentEvent,
  upsertMarketingContact,
  withdrawConsent,
  exportUserData,
  deleteUserData,
} from './consent.js';
export type { ConsentEventType, ConsentType, MarketingContact } from './consent.js';
