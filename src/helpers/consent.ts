/**
 * consent.ts - Gestion du consentement RGPD
 *
 * Fonctions pour:
 * - Logger les événements de consentement
 * - Créer/mettre à jour les contacts marketing
 * - Exporter les données (droit d'accès RGPD)
 * - Supprimer les données (droit à l'oubli)
 */

import { supabaseAdmin } from './supabase.js';

// Types d'événements de consentement
export type ConsentEventType =
  | 'consent_given'
  | 'consent_withdrawn'
  | 'data_exported'
  | 'data_deleted'
  | 'phone_verified'
  | 'signup_completed'
  | 'login_success'
  | 'login_failed';

export type ConsentType = 'sms' | 'email' | 'call' | 'all';

export interface MarketingContact {
  phone: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  smsConsent?: boolean;
  source?: string;
  referralCode?: string;
}

/**
 * Log un événement de consentement (audit RGPD)
 */
export async function logConsentEvent(
  phone: string,
  eventType: ConsentEventType,
  options?: {
    consentType?: ConsentType;
    consentValue?: boolean;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, any>;
  }
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('log_consent_event', {
      p_phone: phone,
      p_event_type: eventType,
      p_consent_type: options?.consentType || null,
      p_consent_value: options?.consentValue ?? null,
      p_ip: options?.ip || null,
      p_user_agent: options?.userAgent || null,
      p_metadata: options?.metadata || null,
    });

    if (error) {
      console.error('[Consent] ❌ Log event failed:', error);
      return null;
    }

    console.log(`[Consent] ✅ Event logged: ${eventType} for ${phone.substring(0, 6)}...`);
    return data as string;
  } catch (err) {
    console.error('[Consent] ❌ Log exception:', err);
    return null;
  }
}

/**
 * Créer ou mettre à jour un contact marketing
 */
export async function upsertMarketingContact(
  contact: MarketingContact,
  ip?: string
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc('upsert_marketing_contact', {
      p_phone: contact.phone,
      p_email: contact.email || null,
      p_first_name: contact.firstName || null,
      p_last_name: contact.lastName || null,
      p_sms_consent: contact.smsConsent ?? true,
      p_source: contact.source || 'signup',
      p_referral_code: contact.referralCode || null,
      p_ip: ip || null,
    });

    if (error) {
      console.error('[Consent] ❌ Upsert contact failed:', error);
      return null;
    }

    console.log(`[Consent] ✅ Contact upserted: ${contact.phone.substring(0, 6)}...`);
    return data as string;
  } catch (err) {
    console.error('[Consent] ❌ Upsert exception:', err);
    return null;
  }
}

/**
 * Retirer le consentement marketing
 */
export async function withdrawConsent(
  phone: string,
  consentType: ConsentType,
  ip?: string
): Promise<boolean> {
  try {
    // Mettre à jour le contact
    const updateField = consentType === 'all'
      ? { sms_consent: false, email_consent: false, call_consent: false }
      : { [`${consentType}_consent`]: false };

    const { error } = await supabaseAdmin
      .from('marketing_contacts')
      .update(updateField)
      .eq('phone', phone);

    if (error) {
      console.error('[Consent] ❌ Withdraw failed:', error);
      return false;
    }

    // Logger l'événement
    await logConsentEvent(phone, 'consent_withdrawn', {
      consentType,
      consentValue: false,
      ip,
    });

    console.log(`[Consent] ✅ Consent withdrawn: ${consentType} for ${phone.substring(0, 6)}...`);
    return true;
  } catch (err) {
    console.error('[Consent] ❌ Withdraw exception:', err);
    return false;
  }
}

/**
 * Export des données personnelles (droit d'accès RGPD)
 */
export async function exportUserData(phone: string, ip?: string): Promise<{
  contact: any;
  consentEvents: any[];
  otpSessions: any[];
} | null> {
  try {
    // Récupérer le contact
    const { data: contact } = await supabaseAdmin
      .from('marketing_contacts')
      .select('*')
      .eq('phone', phone)
      .single();

    // Récupérer les événements de consentement
    const { data: events } = await supabaseAdmin
      .from('consent_events')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: false });

    // Récupérer les sessions OTP (sans les hash)
    const { data: sessions } = await supabaseAdmin
      .from('phone_otp_sessions')
      .select('id, phone, status, created_at, verified_at, ip_address')
      .eq('phone', phone)
      .order('created_at', { ascending: false });

    // Logger l'export
    await logConsentEvent(phone, 'data_exported', { ip });

    return {
      contact: contact || null,
      consentEvents: events || [],
      otpSessions: sessions || [],
    };
  } catch (err) {
    console.error('[Consent] ❌ Export exception:', err);
    return null;
  }
}

/**
 * Suppression des données personnelles (droit à l'oubli RGPD)
 *
 * Note: Les consent_events sont conservés pour audit légal (RGPD l'autorise)
 */
export async function deleteUserData(phone: string, ip?: string): Promise<boolean> {
  try {
    // Supprimer le contact marketing
    await supabaseAdmin
      .from('marketing_contacts')
      .delete()
      .eq('phone', phone);

    // Supprimer les sessions OTP
    await supabaseAdmin
      .from('phone_otp_sessions')
      .delete()
      .eq('phone', phone);

    // Supprimer les rate-limits
    await supabaseAdmin
      .from('phone_rate_limits')
      .delete()
      .eq('phone', phone);

    // Logger la suppression (consent_events conservés pour audit)
    await logConsentEvent(phone, 'data_deleted', {
      ip,
      metadata: { deleted_tables: ['marketing_contacts', 'phone_otp_sessions', 'phone_rate_limits'] },
    });

    console.log(`[Consent] ✅ Data deleted for ${phone.substring(0, 6)}...`);
    return true;
  } catch (err) {
    console.error('[Consent] ❌ Delete exception:', err);
    return false;
  }
}
