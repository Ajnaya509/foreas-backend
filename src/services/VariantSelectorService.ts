/**
 * VariantSelectorService — A/B testing Thompson sampling
 * Ajnaya2026v87.1
 *
 * Choisit la meilleure variante d'email (INITIAL / FOLLOWUP / REPLY)
 * via Thompson sampling sur une distribution Beta(replies+1, (sent-replies)+1).
 *
 * Compromis explore/exploit naturel : les variantes peu testées conservent
 * une chance d'être tirées tant que leur incertitude est élevée.
 */

import { getSupabase } from '../lib/supabase.js';

export type VariantFamily = 'INITIAL' | 'FOLLOWUP_1' | 'FOLLOWUP_2' | 'REPLY';
export type VariantLanguage = 'fr' | 'en' | 'es' | 'it';

export interface EmailVariant {
  id: string;
  family: VariantFamily;
  variant_name: string;
  subject_template: string;
  body_template: string;
  language: VariantLanguage;
  times_sent: number;
  times_opened: number;
  times_replied: number;
  is_active: boolean;
}

// ── Random helpers (Marsaglia-Tsang) ──────────────────────────────
function normalSample(): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) via Marsaglia-Tsang method.
 * Valide pour shape >= 1 ; pour shape < 1 on utilise le trick x = g * u^(1/shape).
 */
function gammaSample(shape: number): number {
  if (shape < 1) {
    const g = gammaSample(shape + 1);
    const u = Math.random();
    return g * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let x = normalSample();
    let v = 1 + c * x;
    while (v <= 0) {
      x = normalSample();
      v = 1 + c * x;
    }
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Beta(alpha, beta) sample via deux tirages Gamma.
 * Beta = X / (X + Y), X ~ Gamma(alpha,1), Y ~ Gamma(beta,1).
 */
function betaSample(alpha: number, beta: number): number {
  const x = gammaSample(Math.max(alpha, 0.001));
  const y = gammaSample(Math.max(beta, 0.001));
  return x / (x + y);
}

// ── Thompson sampling selector ────────────────────────────────────
/**
 * Sélectionne la meilleure variante pour une famille + langue données.
 * Si aucune variante dispo dans la langue cible, fallback sur 'fr'.
 * Si aucune variante du tout, retourne null.
 */
export async function pickBestVariant(
  family: VariantFamily,
  language: VariantLanguage = 'fr',
): Promise<EmailVariant | null> {
  const supa = getSupabase();

  const fetchVariants = async (lang: VariantLanguage) => {
    const { data, error } = await supa
      .from('finder_email_variants')
      .select('*')
      .eq('family', family)
      .eq('language', lang)
      .eq('is_active', true);
    if (error) {
      console.warn('[VariantSelector] fetch error:', error.message);
      return [];
    }
    return (data || []) as EmailVariant[];
  };

  let variants = await fetchVariants(language);
  if (variants.length === 0 && language !== 'fr') {
    variants = await fetchVariants('fr');
  }
  if (variants.length === 0) return null;
  if (variants.length === 1) return variants[0];

  // Thompson sampling : on tire un score depuis Beta(replies+1, (sent-replies)+1)
  let best: EmailVariant | null = null;
  let bestScore = -Infinity;
  for (const v of variants) {
    const alpha = (v.times_replied || 0) + 1;
    const betaP = Math.max(0, (v.times_sent || 0) - (v.times_replied || 0)) + 1;
    const score = betaSample(alpha, betaP);
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

// ── Substitution placeholders ─────────────────────────────────────
/**
 * Remplace les placeholders {{key}} dans un template par les valeurs fournies.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    return vars[key] ?? '';
  });
}

// ── Compteurs ─────────────────────────────────────────────────────
export async function incrementVariantSent(variantId: string): Promise<void> {
  try {
    const supa = getSupabase();
    // RPC si dispo, sinon fallback update manuel
    const { error } = await supa.rpc('increment_variant_sent', { p_variant_id: variantId });
    if (error) {
      // fallback : read + write
      const { data } = await supa
        .from('finder_email_variants')
        .select('times_sent')
        .eq('id', variantId)
        .maybeSingle();
      const current = (data as any)?.times_sent ?? 0;
      await supa
        .from('finder_email_variants')
        .update({ times_sent: current + 1 })
        .eq('id', variantId);
    }
  } catch (err: any) {
    console.warn('[VariantSelector] incrementVariantSent error:', err?.message);
  }
}

export async function incrementVariantReplied(variantId: string): Promise<void> {
  try {
    const supa = getSupabase();
    const { error } = await supa.rpc('increment_variant_replied', { p_variant_id: variantId });
    if (error) {
      const { data } = await supa
        .from('finder_email_variants')
        .select('times_replied')
        .eq('id', variantId)
        .maybeSingle();
      const current = (data as any)?.times_replied ?? 0;
      await supa
        .from('finder_email_variants')
        .update({ times_replied: current + 1 })
        .eq('id', variantId);
    }
  } catch (err: any) {
    console.warn('[VariantSelector] incrementVariantReplied error:', err?.message);
  }
}
