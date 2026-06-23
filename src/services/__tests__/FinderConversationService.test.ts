/**
 * Unit tests — detectIntent (Vitest)
 * Ajnaya2026v87.1
 *
 * Ces tests mockent le SDK Anthropic pour vérifier que la fonction
 * `detectIntent` parse correctement la réponse modèle en EmailIntent.
 *
 * Exécution :
 *   npm install -D vitest
 *   npx vitest run src/services/__tests__/FinderConversationService.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dynamique du SDK Anthropic : detectIntent fait `await import('@anthropic-ai/sdk')`
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class Anthropic {
      messages = { create: mockCreate };
      constructor(_: any) {}
    },
  };
});

// Stub lib/supabase pour éviter l'erreur de env dans les tests
vi.mock('../../lib/supabase.js', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { detectIntent } from '../FinderConversationService.js';

function mockAnthropicReply(text: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text }],
  });
}

describe('detectIntent', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('detects INTERESTED from enthusiastic reply', async () => {
    mockAnthropicReply('INTERESTED');
    const result = await detectIntent(
      "Oui ça m'intéresse beaucoup, pouvez-vous m'envoyer plus d'infos ?",
    );
    expect(result).toBe('INTERESTED');
  });

  it('detects OBJECTION_ALREADY_PARTNER when prospect has a provider', async () => {
    mockAnthropicReply('OBJECTION_ALREADY_PARTNER');
    const result = await detectIntent(
      'Merci mais nous travaillons déjà avec un autre chauffeur depuis 2 ans.',
    );
    expect(result).toBe('OBJECTION_ALREADY_PARTNER');
  });

  it('detects NOT_INTERESTED from explicit refusal', async () => {
    mockAnthropicReply('NOT_INTERESTED');
    const result = await detectIntent(
      'Non merci, pas intéressé. Merci de ne plus nous recontacter.',
    );
    expect(result).toBe('NOT_INTERESTED');
  });

  it('detects HANDOFF_REQUEST when prospect wants direct driver contact', async () => {
    mockAnthropicReply('HANDOFF_REQUEST');
    const result = await detectIntent(
      "Pouvez-vous me transmettre le numéro du chauffeur pour qu'il me rappelle ?",
    );
    expect(result).toBe('HANDOFF_REQUEST');
  });

  it('falls back to UNCLEAR on unknown model output', async () => {
    mockAnthropicReply('WEIRD_OUTPUT');
    const result = await detectIntent('???');
    expect(result).toBe('UNCLEAR');
  });

  it('falls back to UNCLEAR on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('network down'));
    const result = await detectIntent('anything');
    expect(result).toBe('UNCLEAR');
  });

  it('strips whitespace and extra tokens, keeps first word', async () => {
    mockAnthropicReply('INTERESTED\n(suite de texte inutile)');
    const result = await detectIntent('Oui');
    expect(result).toBe('INTERESTED');
  });
});
