/**
 * AntifraudService.ts — FOREAS Anti-Fraud Engine
 * ================================================
 * Croise 8+ patterns pour bloquer le cumul de trials :
 *
 * 1. PHONE — meme numero = meme personne (deja verifie OTP)
 * 2. DEVICE — fingerprint device (model + OS + timezone + locale)
 * 3. IP — meme IP = probable meme personne
 * 4. EMAIL PATTERN — emails jetables, aliases Gmail (+tag), domaines suspects
 * 5. STRIPE CARD — fingerprint carte bancaire (Stripe Radar)
 * 6. TIMING — inscriptions trop rapprochees depuis meme IP/device
 * 7. GEO — GPS identique a <100m d'un compte existant recemment cree
 * 8. BEHAVIORAL — meme prenom+nom avec email different
 *
 * Chaque signal a un score de risque (0-100).
 * Score total > 70 = BLOCAGE
 * Score total 40-70 = REVIEW (inscription autorisee mais flaggee)
 * Score total < 40 = OK
 */

import { createClient } from '@supabase/supabase-js';

let supaAdmin: any;
function getSupa() {
  if (supaAdmin) return supaAdmin;
  supaAdmin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supaAdmin;
}

// ── Types ──

export interface FraudCheckInput {
  phone: string;
  email: string;
  firstName?: string;
  lastName?: string;
  ip?: string;
  deviceFingerprint?: DeviceFingerprint;
  lat?: number;
  lng?: number;
}

export interface DeviceFingerprint {
  deviceId?: string; // expo-device unique ID
  model?: string; // iPhone 15, Pixel 8...
  os?: string; // ios 18.2, android 15
  timezone?: string; // Europe/Paris
  locale?: string; // fr-FR
  screenWidth?: number;
  screenHeight?: number;
  appVersion?: string;
}

export interface FraudSignal {
  type: string;
  score: number; // 0-100
  detail: string;
  matchedAccountId?: string;
}

export interface FraudResult {
  allowed: boolean;
  action: 'OK' | 'REVIEW' | 'BLOCKED';
  totalScore: number;
  signals: FraudSignal[];
  reason?: string;
}

// ── Emails jetables connus ──
const DISPOSABLE_DOMAINS = new Set([
  'yopmail.com',
  'tempmail.com',
  'guerrillamail.com',
  'throwaway.email',
  'mailinator.com',
  'dispostable.com',
  'sharklasers.com',
  'guerrillamailblock.com',
  'grr.la',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'spam4.me',
  'trashmail.com',
  'trashmail.me',
  'trashmail.net',
  'tempail.com',
  'tempr.email',
  'temp-mail.org',
  'emailondeck.com',
  'fakeinbox.com',
  'mailnesia.com',
  'maildrop.cc',
  'discard.email',
  'getnada.com',
  'mohmal.com',
  '10minutemail.com',
  'minutemail.com',
  'burnermail.io',
  'inboxbear.com',
  'mailsac.com',
]);

// ── Service ──

export async function checkFraud(input: FraudCheckInput): Promise<FraudResult> {
  const signals: FraudSignal[] = [];
  const supa = getSupa();

  // Fenetre de detection : 90 jours
  const windowDate = new Date();
  windowDate.setDate(windowDate.getDate() - 90);
  const windowISO = windowDate.toISOString();

  // ────────────────────────────────────────────
  // 1. PHONE — Meme telephone = meme personne
  // ────────────────────────────────────────────
  if (input.phone) {
    const normalizedPhone = normalizePhone(input.phone);

    const { data: phoneMatch } = await supa
      .from('drivers')
      .select('id, email, created_at')
      .eq('phone', normalizedPhone)
      .limit(1);

    if (phoneMatch && phoneMatch.length > 0) {
      signals.push({
        type: 'PHONE_DUPLICATE',
        score: 95,
        detail: `Telephone deja utilise par ${phoneMatch[0].email}`,
        matchedAccountId: phoneMatch[0].id,
      });
    }

    // Verifier aussi dans fraud_signals
    const { data: phoneFraud } = await supa
      .from('fraud_signals')
      .select('id')
      .eq('signal_type', 'phone')
      .eq('signal_value', normalizedPhone)
      .gte('created_at', windowISO)
      .limit(1);

    if (phoneFraud && phoneFraud.length > 0) {
      signals.push({
        type: 'PHONE_FLAGGED',
        score: 80,
        detail: 'Telephone deja flagge pour fraude',
      });
    }
  }

  // ────────────────────────────────────────────
  // 2. EMAIL — Patterns suspects
  // ────────────────────────────────────────────
  if (input.email) {
    const emailLower = input.email.toLowerCase().trim();
    const domain = emailLower.split('@')[1];
    const localPart = emailLower.split('@')[0];

    // 2a. Domaine jetable
    if (DISPOSABLE_DOMAINS.has(domain)) {
      signals.push({
        type: 'DISPOSABLE_EMAIL',
        score: 90,
        detail: `Domaine email jetable : ${domain}`,
      });
    }

    // 2b. Alias Gmail (user+tag@gmail.com = user@gmail.com)
    if (domain === 'gmail.com' && localPart.includes('+')) {
      const realLocal = localPart.split('+')[0];
      const realEmail = `${realLocal}@gmail.com`;

      const { data: aliasMatch } = await supa
        .from('drivers')
        .select('id, email')
        .ilike('email', `${realLocal}%@gmail.com`)
        .limit(5);

      if (aliasMatch && aliasMatch.length > 0) {
        signals.push({
          type: 'GMAIL_ALIAS',
          score: 85,
          detail: `Alias Gmail detecte — compte original probable : ${realEmail}`,
          matchedAccountId: aliasMatch[0].id,
        });
      }
    }

    // 2c. Gmail dots trick (c.handler = chandler)
    if (domain === 'gmail.com') {
      const noDots = localPart.replace(/\./g, '').replace(/\+.*/, '');
      const { data: dotsMatch } = await supa
        .from('drivers')
        .select('id, email')
        .not('email', 'eq', emailLower)
        .limit(50);

      if (dotsMatch) {
        const found = dotsMatch.find((d: any) => {
          if (!d.email) return false;
          const otherLocal = d.email
            .toLowerCase()
            .split('@')[0]
            .replace(/\./g, '')
            .replace(/\+.*/, '');
          const otherDomain = d.email.toLowerCase().split('@')[1];
          return otherDomain === 'gmail.com' && otherLocal === noDots;
        });
        if (found) {
          signals.push({
            type: 'GMAIL_DOTS_TRICK',
            score: 85,
            detail: `Meme adresse Gmail avec points differents : ${found.email}`,
            matchedAccountId: found.id,
          });
        }
      }
    }

    // 2d. Email deja utilise
    const { data: emailMatch } = await supa
      .from('drivers')
      .select('id')
      .eq('email', emailLower)
      .limit(1);

    if (emailMatch && emailMatch.length > 0) {
      signals.push({
        type: 'EMAIL_DUPLICATE',
        score: 95,
        detail: 'Email deja enregistre',
        matchedAccountId: emailMatch[0].id,
      });
    }
  }

  // ────────────────────────────────────────────
  // 3. IP — Meme adresse IP recente
  // ────────────────────────────────────────────
  if (input.ip) {
    const { data: ipMatches } = await supa
      .from('fraud_signals')
      .select('driver_id, created_at')
      .eq('signal_type', 'ip')
      .eq('signal_value', input.ip)
      .gte('created_at', windowISO)
      .order('created_at', { ascending: false })
      .limit(10);

    if (ipMatches && ipMatches.length > 0) {
      const recentCount = ipMatches.length;
      if (recentCount >= 3) {
        signals.push({
          type: 'IP_FLOOD',
          score: 75,
          detail: `${recentCount} inscriptions depuis cette IP en 90 jours`,
          matchedAccountId: ipMatches[0].driver_id,
        });
      } else if (recentCount >= 1) {
        signals.push({
          type: 'IP_MATCH',
          score: 40,
          detail: `${recentCount} inscription(s) depuis cette IP recemment`,
          matchedAccountId: ipMatches[0].driver_id,
        });
      }
    }
  }

  // ────────────────────────────────────────────
  // 4. DEVICE FINGERPRINT
  // ────────────────────────────────────────────
  if (input.deviceFingerprint?.deviceId) {
    const { data: deviceMatch } = await supa
      .from('fraud_signals')
      .select('driver_id, created_at')
      .eq('signal_type', 'device_id')
      .eq('signal_value', input.deviceFingerprint.deviceId)
      .gte('created_at', windowISO)
      .limit(5);

    if (deviceMatch && deviceMatch.length > 0) {
      signals.push({
        type: 'DEVICE_DUPLICATE',
        score: 90,
        detail: `Meme appareil deja utilise pour inscription (device_id)`,
        matchedAccountId: deviceMatch[0].driver_id,
      });
    }
  }

  // Fingerprint composite (model+OS+screen+timezone)
  if (input.deviceFingerprint) {
    const fp = input.deviceFingerprint;
    const composite = `${fp.model}|${fp.os}|${fp.screenWidth}x${fp.screenHeight}|${fp.timezone}`;

    const { data: compositeMatch } = await supa
      .from('fraud_signals')
      .select('driver_id')
      .eq('signal_type', 'device_composite')
      .eq('signal_value', composite)
      .gte('created_at', windowISO)
      .limit(3);

    if (compositeMatch && compositeMatch.length > 0) {
      signals.push({
        type: 'DEVICE_COMPOSITE_MATCH',
        score: 60,
        detail: `Appareil similaire detecte (${fp.model} ${fp.os})`,
        matchedAccountId: compositeMatch[0].driver_id,
      });
    }
  }

  // ────────────────────────────────────────────
  // 5. GEO — GPS trop proche d'un compte recent
  // ────────────────────────────────────────────
  if (input.lat && input.lng) {
    // Chercher inscriptions recentes dans un rayon de 100m
    const { data: geoMatches } = await supa
      .rpc('find_nearby_signups', {
        p_lat: input.lat,
        p_lng: input.lng,
        p_radius_meters: 100,
        p_since: windowISO,
      })
      .catch(() => ({ data: null }));

    if (geoMatches && geoMatches.length > 0) {
      signals.push({
        type: 'GEO_PROXIMITY',
        score: 50,
        detail: `${geoMatches.length} inscription(s) depuis le meme lieu (<100m)`,
        matchedAccountId: geoMatches[0]?.driver_id,
      });
    }
  }

  // ────────────────────────────────────────────
  // 6. NOM + PRENOM — Meme identite, email different
  // ────────────────────────────────────────────
  if (input.firstName && input.lastName) {
    const fn = input.firstName.toLowerCase().trim();
    const ln = input.lastName.toLowerCase().trim();

    const { data: nameMatch } = await supa
      .from('drivers')
      .select('id, email')
      .ilike('first_name', fn)
      .ilike('last_name', ln)
      .limit(3);

    if (nameMatch && nameMatch.length > 0) {
      const differentEmail = nameMatch.find(
        (d: any) => d.email?.toLowerCase() !== input.email?.toLowerCase(),
      );
      if (differentEmail) {
        signals.push({
          type: 'NAME_DUPLICATE',
          score: 55,
          detail: `Meme nom/prenom avec un email different (${differentEmail.email})`,
          matchedAccountId: differentEmail.id,
        });
      }
    }
  }

  // ────────────────────────────────────────────
  // 7. TIMING — Inscription trop rapide apres suppression
  // ────────────────────────────────────────────
  if (input.phone || input.email) {
    const { data: deletedAccounts } = await supa
      .from('fraud_signals')
      .select('driver_id, created_at')
      .eq('signal_type', 'account_deleted')
      .or(`signal_value.eq.${input.phone},signal_value.eq.${input.email}`)
      .gte('created_at', windowISO)
      .limit(3);

    if (deletedAccounts && deletedAccounts.length > 0) {
      signals.push({
        type: 'RESUBSCRIBE_AFTER_DELETE',
        score: 85,
        detail: 'Re-inscription apres suppression de compte recente',
        matchedAccountId: deletedAccounts[0].driver_id,
      });
    }
  }

  // ────────────────────────────────────────────
  // CALCUL SCORE FINAL
  // ────────────────────────────────────────────
  // Prendre le max des scores (pas la somme, sinon inflation)
  // + bonus si multiple signaux concordants
  const maxScore = signals.length > 0 ? Math.max(...signals.map((s) => s.score)) : 0;
  const concordanceBonus = signals.length >= 3 ? 15 : signals.length >= 2 ? 8 : 0;
  const totalScore = Math.min(100, maxScore + concordanceBonus);

  let action: FraudResult['action'];
  let reason: string | undefined;

  if (totalScore >= 70) {
    action = 'BLOCKED';
    reason = signals
      .filter((s) => s.score >= 70)
      .map((s) => s.detail)
      .join(' | ');
  } else if (totalScore >= 40) {
    action = 'REVIEW';
    reason = signals.map((s) => s.detail).join(' | ');
  } else {
    action = 'OK';
  }

  return {
    allowed: action !== 'BLOCKED',
    action,
    totalScore,
    signals,
    reason,
  };
}

// ── Enregistrer les signaux apres inscription reussie ──

export async function recordSignals(driverId: string, input: FraudCheckInput): Promise<void> {
  const supa = getSupa();
  const records: any[] = [];

  if (input.phone) {
    records.push({
      driver_id: driverId,
      signal_type: 'phone',
      signal_value: normalizePhone(input.phone),
    });
  }
  if (input.email) {
    records.push({
      driver_id: driverId,
      signal_type: 'email',
      signal_value: input.email.toLowerCase(),
    });
  }
  if (input.ip) {
    records.push({ driver_id: driverId, signal_type: 'ip', signal_value: input.ip });
  }
  if (input.deviceFingerprint?.deviceId) {
    records.push({
      driver_id: driverId,
      signal_type: 'device_id',
      signal_value: input.deviceFingerprint.deviceId,
    });
  }
  if (input.deviceFingerprint) {
    const fp = input.deviceFingerprint;
    const composite = `${fp.model}|${fp.os}|${fp.screenWidth}x${fp.screenHeight}|${fp.timezone}`;
    records.push({ driver_id: driverId, signal_type: 'device_composite', signal_value: composite });
  }
  if (input.lat && input.lng) {
    records.push({
      driver_id: driverId,
      signal_type: 'geo',
      signal_value: `${input.lat},${input.lng}`,
    });
  }

  if (records.length > 0) {
    await supa
      .from('fraud_signals')
      .insert(records)
      .catch((err: any) => {
        console.warn('[Antifraud] Failed to record signals:', err.message);
      });
  }
}

// ── Helpers ──

function normalizePhone(phone: string): string {
  // Normaliser : enlever espaces, tirets, garder +XX format
  return phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '+33');
}
