/**
 * phone.ts - Utilitaires de normalisation et validation téléphone
 *
 * Format cible: E.164 (+33612345678)
 * Pays supportés: France (+33), Belgique (+32), Suisse (+41)
 */

// Codes pays supportés
const COUNTRY_CODES: Record<string, { prefix: string; length: number }> = {
  FR: { prefix: '+33', length: 9 },  // 06 12 34 56 78 → +33612345678
  BE: { prefix: '+32', length: 9 },  // 04 xx xx xx xx → +32xxxxxxxxx
  CH: { prefix: '+41', length: 9 },  // 07x xxx xx xx → +41xxxxxxxxx
};

/**
 * Normalise un numéro de téléphone au format E.164
 *
 * @example
 * normalizePhone('06 12 34 56 78') // → '+33612345678'
 * normalizePhone('+33 6 12 34 56 78') // → '+33612345678'
 * normalizePhone('0033612345678') // → '+33612345678'
 */
export function normalizePhone(phone: string, defaultCountry: keyof typeof COUNTRY_CODES = 'FR'): string {
  // Retirer tous les caractères non numériques sauf le +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Cas: commence par 00 (format international alternatif)
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.substring(2);
  }

  // Cas: déjà au format E.164 (+XX...)
  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  // Cas: commence par 0 (format local)
  if (cleaned.startsWith('0')) {
    const country = COUNTRY_CODES[defaultCountry];
    return country.prefix + cleaned.substring(1);
  }

  // Cas: numéro sans préfixe
  const country = COUNTRY_CODES[defaultCountry];
  return country.prefix + cleaned;
}

/**
 * Valide un numéro de téléphone E.164
 *
 * @returns true si le format est valide
 */
export function isValidE164(phone: string): boolean {
  // Format E.164: + suivi de 8 à 15 chiffres
  const e164Regex = /^\+[1-9]\d{7,14}$/;
  return e164Regex.test(phone);
}

/**
 * Valide un numéro français (mobile)
 */
export function isValidFrenchMobile(phone: string): boolean {
  const normalized = normalizePhone(phone, 'FR');
  // Mobile français: +336 ou +337
  return /^\+33[67]\d{8}$/.test(normalized);
}

/**
 * Masque un numéro pour affichage
 *
 * @example
 * maskPhone('+33612345678') // → '+33 6•• ••• •78'
 */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;

  const prefix = phone.substring(0, 4);
  const suffix = phone.substring(phone.length - 2);
  const middle = '•'.repeat(phone.length - 6);

  return `${prefix} ${middle} ${suffix}`;
}

/**
 * Extrait le code pays d'un numéro E.164
 */
export function getCountryCode(phone: string): string | null {
  if (!phone.startsWith('+')) return null;

  for (const [country, { prefix }] of Object.entries(COUNTRY_CODES)) {
    if (phone.startsWith(prefix)) {
      return country;
    }
  }

  // Autres codes pays courants
  if (phone.startsWith('+1')) return 'US';
  if (phone.startsWith('+44')) return 'UK';

  return null;
}
