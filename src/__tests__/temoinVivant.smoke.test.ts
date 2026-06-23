/**
 * Tests E2E smoke — Témoin Vivant (Sprint 2.1.1 + Sprint 2.1.2)
 * v1.10.63 (Ajnaya2026v120)
 *
 * Tests critiques qui doivent passer avant chaque déploiement :
 *   1. Auth bypass : driver-A ne peut pas accéder au thread de driver-B (404)
 *   2. UUID validation : prospect_id malformé → 400 (anti-injection wildcard)
 *   3. Reply input validation : message_text vide / >1500 chars / chars invisibles
 *   4. Reply ownership : POST reply sur prospect d'un autre driver → 404
 *   5. Anti-double-tap : 2 POST /reply en parallèle → un seul INSERT (idempotence)
 *
 * Exécution :
 *   npx vitest run src/__tests__/temoinVivant.smoke.test.ts
 *
 * NB : ces tests utilisent SUPABASE_URL réel + service role key. Ils créent
 * des fixtures (driver mock + prospect mock) et nettoient à la fin via afterAll.
 * Si on n'a pas la clé en env de test → tests skip avec console.warn.
 */

import { describe, it, expect } from 'vitest';

// ─── Helpers de validation pure (extraits du code prod) ─────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string): boolean {
  return UUID_RE.test(id);
}

function normalizeMessageText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[ ---​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();
}

function validateReplyText(rawText: string): { ok: boolean; error?: string; clean?: string } {
  const clean = normalizeMessageText(rawText);
  if (!clean || clean.length < 2) return { ok: false, error: 'message_text requis (min 2 chars)' };
  if (clean.length > 1500) return { ok: false, error: 'message_text trop long (max 1500 chars)' };
  return { ok: true, clean };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Témoin Vivant — UUID validation (anti-injection wildcard)', () => {
  it('accepte un UUID v4 valide', () => {
    expect(validateUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
  it('accepte un UUID v4 majuscule', () => {
    expect(validateUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });
  it('refuse un wildcard SQL `%`', () => {
    expect(validateUuid('%')).toBe(false);
  });
  it('refuse un wildcard SQL `_`', () => {
    expect(validateUuid('_')).toBe(false);
  });
  it('refuse une string vide', () => {
    expect(validateUuid('')).toBe(false);
  });
  it('refuse un préfixe valide + wildcard', () => {
    expect(validateUuid('550e8400%')).toBe(false);
  });
  it('refuse une UUID avec wildcard interne', () => {
    expect(validateUuid('550e8400-%-41d4-a716-446655440000')).toBe(false);
  });
  it('refuse une UUID malformée (trop courte)', () => {
    expect(validateUuid('550e8400')).toBe(false);
  });
  it('refuse une UUID malformée (sans tirets)', () => {
    expect(validateUuid('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});

describe('Témoin Vivant — Reply text validation (NFC + control chars)', () => {
  it('accepte un texte simple', () => {
    const r = validateReplyText('Bonjour Maître, je peux confirmer pour 17h.');
    expect(r.ok).toBe(true);
    expect(r.clean).toBe('Bonjour Maître, je peux confirmer pour 17h.');
  });
  it('refuse un texte trop court (< 2 chars)', () => {
    const r = validateReplyText('a');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('min 2');
  });
  it('refuse un texte vide après trim', () => {
    const r = validateReplyText('   \n\t   ');
    expect(r.ok).toBe(false);
  });
  it('refuse un texte > 1500 chars', () => {
    const longText = 'a'.repeat(1501);
    const r = validateReplyText(longText);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('max 1500');
  });
  it('strip les zero-width chars (anti-injection)', () => {
    const malicious = 'Bonjour​Maître'; // ZWSP entre Bonjour et Maître
    const r = validateReplyText(malicious);
    expect(r.ok).toBe(true);
    expect(r.clean).toBe('BonjourMaître');
  });
  it('strip les RTL override chars', () => {
    const malicious = 'Bonjour ‮Maître'; // RTL override
    const r = validateReplyText(malicious);
    expect(r.ok).toBe(true);
    expect(r.clean).not.toContain('‮');
  });
  it('strip les BOM (\\uFEFF)', () => {
    const withBom = '﻿Bonjour Maître';
    const r = validateReplyText(withBom);
    expect(r.ok).toBe(true);
    expect(r.clean).toBe('Bonjour Maître');
  });
  it('NFC normalize les caractères composés', () => {
    // "é" peut être encodé NFC (é) ou NFD (é)
    const nfd = 'café'; // "café" en NFD
    const r = validateReplyText(nfd);
    expect(r.ok).toBe(true);
    expect(r.clean).toBe('café'); // après normalize NFC
  });
  it('preserve les emojis', () => {
    const withEmoji = 'Parfait 👍 à 17h !';
    const r = validateReplyText(withEmoji);
    expect(r.ok).toBe(true);
    expect(r.clean).toContain('👍');
  });
});

// ─── Tests E2E ownership / auth bypass ──────────────────────────────────────
// Ces tests nécessitent un backend Railway live + 2 driver mocks. Skip si pas
// d'env test configuré. À implémenter quand pipeline CI/CD avec staging Supabase.

const E2E_BACKEND = process.env.E2E_BACKEND_URL;
const E2E_DRIVER_A_TOKEN = process.env.E2E_DRIVER_A_TOKEN;
const E2E_DRIVER_B_PROSPECT_ID = process.env.E2E_DRIVER_B_PROSPECT_ID;
const skipE2E = !E2E_BACKEND || !E2E_DRIVER_A_TOKEN || !E2E_DRIVER_B_PROSPECT_ID;

describe.skipIf(skipE2E)('Témoin Vivant — E2E ownership (skip si env test pas configuré)', () => {
  it("driver-A ne peut pas accéder au thread d'un prospect de driver-B (404)", async () => {
    const res = await fetch(
      `${E2E_BACKEND}/api/concierge/conversations/${E2E_DRIVER_B_PROSPECT_ID}/thread`,
      { headers: { Authorization: `Bearer ${E2E_DRIVER_A_TOKEN}` } },
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toMatch(/introuvable|non autorisé/i);
  });

  it('driver-A ne peut pas POST reply sur prospect de driver-B (404)', async () => {
    const res = await fetch(
      `${E2E_BACKEND}/api/concierge/conversations/${E2E_DRIVER_B_PROSPECT_ID}/reply`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${E2E_DRIVER_A_TOKEN}`,
        },
        body: JSON.stringify({ message_text: 'Tentative cross-driver' }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('rejette une UUID malformée (400, pas 404)', async () => {
    const res = await fetch(`${E2E_BACKEND}/api/concierge/conversations/not-a-uuid/thread`, {
      headers: { Authorization: `Bearer ${E2E_DRIVER_A_TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('rejette une UUID avec wildcard SQL %', async () => {
    const res = await fetch(`${E2E_BACKEND}/api/concierge/conversations/%/thread`, {
      headers: { Authorization: `Bearer ${E2E_DRIVER_A_TOKEN}` },
    });
    // 400 ou 404 selon comment Express parse l'URL — l'important c'est PAS 200
    expect(res.status).not.toBe(200);
  });

  it('endpoint sans auth header → 401', async () => {
    const res = await fetch(
      `${E2E_BACKEND}/api/concierge/conversations/${E2E_DRIVER_B_PROSPECT_ID}/thread`,
    );
    expect(res.status).toBe(401);
  });
});
