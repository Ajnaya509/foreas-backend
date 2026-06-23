/**
 * FOREAS — VerifabiliteGuard
 * ==========================
 * Construit les preuves vérifiables à injecter dans le system prompt Ajnaya.
 * Toutes les données chiffrées citées par Ajnaya DOIVENT provenir de ce module.
 *
 * Règle : Zéro fabrication. Zéro exemple inventé.
 * Si un chauffeur vérifie une affirmation d'Ajnaya, elle doit être vraie.
 *
 * Commit v66 — 7 avril 2026
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────

export interface VerifiableProof {
  type: 'course_reelle' | 'event_externe' | 'surge_reel' | 'disruption_gtfs';
  timestamp: string; // ISO string vérifiable par le chauffeur
  zone: string; // Zone précise (ex: "Mogador", "Gare du Nord")
  montant_eur?: number; // Montant réel de la course si disponible
  description: string; // Description courte
  source_table: string; // Nom de la table Supabase source (traçabilité)
  source_id: string; // UUID de la ligne source
}

// ──────────────────────────────────────────────
// BUILDER PRINCIPAL
// ──────────────────────────────────────────────

export async function buildVerifiableProofs(
  driverId: string | null,
  zone: string | null,
  supabase: SupabaseClient,
): Promise<VerifiableProof[]> {
  const proofs: VerifiableProof[] = [];

  // ── 1. Courses récentes dans la même zone avec recommendation_followed=true ──
  if (zone) {
    try {
      const { data: courses } = await supabase
        .from('pieuvre_screen_reader_events')
        .select(
          'id, fare_proposed, pickup_zone, created_at, euro_per_hour_estimated, recommendation_followed, ajnaya_recommendation',
        )
        .eq('pickup_zone', zone)
        .eq('recommendation_followed', true)
        .gte('fare_proposed', 20)
        .order('created_at', { ascending: false })
        .limit(3);

      if (courses && courses.length > 0) {
        for (const c of courses) {
          proofs.push({
            type: 'course_reelle',
            timestamp: c.created_at,
            zone: c.pickup_zone,
            montant_eur: c.fare_proposed,
            description: `Course ${c.fare_proposed}€ suite à recommandation Ajnaya`,
            source_table: 'pieuvre_screen_reader_events',
            source_id: c.id,
          });
        }
      }
    } catch (_) {
      // Silencieux — on dégrade gracieusement si la table n'existe pas encore
    }
  }

  // ── 2. Évènements externes dans les 2 prochaines heures ──
  try {
    const now = new Date();
    const in2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const { data: events } = await supabase
      .from('pieuvre_external_events')
      .select('*')
      .gte('event_start', now.toISOString())
      .lte('event_start', in2h.toISOString())
      .limit(2);

    if (events && events.length > 0) {
      for (const e of events) {
        proofs.push({
          type: 'event_externe',
          timestamp: e.event_start,
          zone: e.location_name || e.zone || 'Paris',
          description: e.event_name || e.description || 'Évènement',
          source_table: 'pieuvre_external_events',
          source_id: e.id,
        });
      }
    }
  } catch (_) {
    // Silencieux
  }

  // ── 3. Disruptions GTFS actives ──
  try {
    const { data: disruptions } = await supabase
      .from('pieuvre_gtfs_disruptions')
      .select('*')
      .eq('active', true)
      .limit(2);

    if (disruptions && disruptions.length > 0) {
      for (const d of disruptions) {
        proofs.push({
          type: 'disruption_gtfs',
          timestamp: d.created_at || new Date().toISOString(),
          zone: d.affected_zone || d.stop_name || 'Transport Paris',
          description: d.description || `Perturbation ${d.disruption_type || 'transport'}`,
          source_table: 'pieuvre_gtfs_disruptions',
          source_id: d.id,
        });
      }
    }
  } catch (_) {
    // Silencieux
  }

  // ── 4. Surges réels (pieuvre_surge_predictions) ──
  if (zone) {
    try {
      const { data: surges } = await supabase
        .from('pieuvre_surge_predictions')
        .select('*')
        .gte('predicted_at', new Date(Date.now() - 30 * 60 * 1000).toISOString()) // < 30min
        .limit(2);

      if (surges && surges.length > 0) {
        for (const s of surges) {
          proofs.push({
            type: 'surge_reel',
            timestamp: s.predicted_at || new Date().toISOString(),
            zone: s.zone_name || s.zone || zone,
            description: `Surge x${s.multiplier || s.surge_multiplier || '?'} prédit`,
            source_table: 'pieuvre_surge_predictions',
            source_id: s.id,
          });
        }
      }
    } catch (_) {
      // Silencieux
    }
  }

  return proofs;
}

/**
 * Formate les preuves pour injection dans le system prompt.
 * Retourne '[]' si aucune preuve disponible.
 */
export function formatProofsForPrompt(proofs: VerifiableProof[]): string {
  if (!proofs || proofs.length === 0) return '[]';
  return JSON.stringify(proofs, null, 2);
}
