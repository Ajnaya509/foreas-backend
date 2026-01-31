/**
 * otp.ts - Génération et vérification OTP sécurisée
 *
 * Sécurité:
 * - Code aléatoire cryptographiquement sûr (crypto.randomInt)
 * - Hash SHA256 avec salt unique + pepper serveur
 * - Salt: 32 caractères aléatoires par session
 * - Pepper: secret serveur en variable d'environnement
 */

import * as crypto from 'crypto';

// Pepper serveur (DOIT être défini en env var, sinon fallback dev)
const OTP_PEPPER = process.env.OTP_PEPPER || 'foreas-dev-pepper-change-in-prod-2026';

// Configuration OTP
const OTP_LENGTH = 6;
const OTP_CHARS = '0123456789';
const SALT_LENGTH = 32;

/**
 * Génère un code OTP aléatoire à 6 chiffres
 *
 * Utilise crypto.randomInt pour une génération cryptographiquement sûre
 */
export function generateOTPCode(): string {
  let code = '';
  for (let i = 0; i < OTP_LENGTH; i++) {
    const randomIndex = crypto.randomInt(0, OTP_CHARS.length);
    code += OTP_CHARS[randomIndex];
  }
  return code;
}

/**
 * Génère un salt aléatoire pour une session OTP
 */
export function generateSalt(): string {
  return crypto.randomBytes(SALT_LENGTH / 2).toString('hex');
}

/**
 * Hash un code OTP avec salt et pepper
 *
 * @param code - Le code OTP en clair (6 chiffres)
 * @param salt - Le salt unique de la session
 * @returns Le hash SHA256 en hex
 *
 * @example
 * const salt = generateSalt();
 * const hash = hashOTP('123456', salt);
 * // → 'a1b2c3d4e5f6...' (64 caractères hex)
 */
export function hashOTP(code: string, salt: string): string {
  const data = `${code}:${salt}:${OTP_PEPPER}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Vérifie un code OTP contre son hash
 *
 * @param code - Le code entré par l'utilisateur
 * @param salt - Le salt de la session
 * @param storedHash - Le hash stocké en base
 * @returns true si le code est correct
 */
export function verifyOTP(code: string, salt: string, storedHash: string): boolean {
  const computedHash = hashOTP(code, salt);
  // Comparaison timing-safe pour éviter les timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedHash, 'hex'),
      Buffer.from(storedHash, 'hex')
    );
  } catch {
    // Les buffers ont des tailles différentes = faux
    return false;
  }
}

/**
 * Génère un OTP complet avec hash et salt
 *
 * @returns { code, salt, hash } - Code pour SMS, salt/hash pour stockage
 */
export function generateSecureOTP(): {
  code: string;      // À envoyer par SMS (puis oublier côté serveur)
  salt: string;      // À stocker en base
  hash: string;      // À stocker en base
} {
  const code = generateOTPCode();
  const salt = generateSalt();
  const hash = hashOTP(code, salt);

  return { code, salt, hash };
}

/**
 * Valide le format d'un code OTP
 */
export function isValidOTPFormat(code: string): boolean {
  return /^\d{6}$/.test(code);
}
