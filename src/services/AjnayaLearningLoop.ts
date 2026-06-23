/**
 * AjnayaLearningLoop — Auto-apprentissage agressif continu
 *
 * Analyse les outcomes (accepted/rejected/ignored) pour personnaliser
 * les recommandations par chauffeur. Le FusionEngine consulte ces scores
 * pour ajuster le demand scoring par zone.
 *
 * Cycle : outcomes → zone_scores → FusionEngine bonus/malus → meilleures recos
 */

import { getSupabaseAdmin } from '../helpers/supabase';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ZonePreference {
  zone: string;
  score: number; // positif = le chauffeur aime, négatif = il évite
  accepted: number;
  rejected: number;
  ignored: number;
  lastUpdated: number;
}

export interface DriverLearningProfile {
  driverId: string;
  zones: Map<string, ZonePreference>;
  preferredHours: number[]; // heures où le chauffeur est le plus actif
  avgSessionDuration: number; // durée moyenne session en minutes
  topPlatforms: string[]; // plateformes préférées
  lastComputed: number;
}

// ── Cache mémoire des profils ────────────────────────────────────────────────

const profileCache = new Map<string, DriverLearningProfile>();
const CACHE_TTL = 60 * 60 * 1000; // 1 heure

// ── Extraction de zones depuis les messages ──────────────────────────────────

const KNOWN_ZONES = [
  'gare du nord',
  'gare de lyon',
  'gare montparnasse',
  'gare saint-lazare',
  "gare de l'est",
  'cdg',
  'orly',
  'roissy',
  'aéroport',
  'bastille',
  'république',
  'nation',
  'châtelet',
  'les halles',
  'opéra',
  'madeleine',
  'concorde',
  'champs-élysées',
  'étoile',
  'la défense',
  'neuilly',
  'levallois',
  'pigalle',
  'montmartre',
  'oberkampf',
  'ménilmontant',
  'belleville',
  'stalingrad',
  'jaurès',
  'bercy',
  'bibliothèque',
  "place d'italie",
  'trocadéro',
  'tour eiffel',
  'invalides',
  'saint-germain',
  'odéon',
  'luxembourg',
  'marais',
  'hôtel de ville',
  'bastille',
  'porte maillot',
  'porte de versailles',
  'porte de la chapelle',
  'stade de france',
  'parc des princes',
  'accor arena',
  'zénith',
  'olympia',
  'bercy arena',
];

function extractZonesFromMessage(message: string): string[] {
  const lower = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return KNOWN_ZONES.filter((zone) => {
    const normalizedZone = zone.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return lower.includes(normalizedZone);
  });
}

// ── Calcul des scores d'apprentissage ────────────────────────────────────────

export async function computeDriverProfile(driverId: string): Promise<DriverLearningProfile> {
  // Check cache
  const cached = profileCache.get(driverId);
  if (cached && Date.now() - cached.lastComputed < CACHE_TTL) {
    return cached;
  }

  const supa = await getSupabaseAdmin();
  const zones = new Map<string, ZonePreference>();

  try {
    // 1. Récupérer les conversations des 14 derniers jours
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const { data: messages } = await supa
      .from('ai_messages')
      .select('role, content_redacted, created_at')
      .eq('role', 'user')
      .gte('created_at', twoWeeksAgo)
      .order('created_at', { ascending: false })
      .limit(200);

    // 2. Extraire les zones mentionnées et les patterns
    const zoneInteractions: { zone: string; timestamp: number; type: 'mention' | 'navigation' }[] =
      [];

    for (const msg of messages || []) {
      const content = msg.content_redacted || '';
      const mentionedZones = extractZonesFromMessage(content);

      for (const zone of mentionedZones) {
        zoneInteractions.push({
          zone,
          timestamp: new Date(msg.created_at).getTime(),
          type:
            content.toLowerCase().includes('va à') || content.toLowerCase().includes('y aller')
              ? 'navigation'
              : 'mention',
        });
      }
    }

    // 3. Calculer les scores par zone
    for (const interaction of zoneInteractions) {
      const existing = zones.get(interaction.zone) || {
        zone: interaction.zone,
        score: 0,
        accepted: 0,
        rejected: 0,
        ignored: 0,
        lastUpdated: Date.now(),
      };

      if (interaction.type === 'navigation') {
        existing.accepted++;
        existing.score += 3; // Navigation = forte intention
      } else {
        existing.accepted++;
        existing.score += 1; // Mention = intérêt léger
      }

      zones.set(interaction.zone, existing);
    }

    // 4. Récupérer les outcomes explicites (si table existe)
    try {
      const { data: outcomes } = await supa
        .from('ai_outcomes')
        .select('action_recommended, outcome_type, created_at')
        .eq('driver_id', driverId)
        .gte('created_at', twoWeeksAgo)
        .limit(100);

      for (const outcome of outcomes || []) {
        const action = outcome.action_recommended || '';
        const zonesInAction = extractZonesFromMessage(action);

        for (const zone of zonesInAction) {
          const existing = zones.get(zone) || {
            zone,
            score: 0,
            accepted: 0,
            rejected: 0,
            ignored: 0,
            lastUpdated: Date.now(),
          };

          switch (outcome.outcome_type) {
            case 'accepted':
              existing.accepted++;
              existing.score += 5; // Outcome explicite = très fort signal
              break;
            case 'rejected':
              existing.rejected++;
              existing.score -= 3;
              break;
            case 'ignored':
              existing.ignored++;
              existing.score -= 1;
              break;
          }

          zones.set(zone, existing);
        }
      }
    } catch {
      // Table ai_outcomes might not exist yet — that's fine
    }

    // 5. Calculer heures préférées
    const hourCounts = new Array(24).fill(0);
    for (const msg of messages || []) {
      const hour = new Date(msg.created_at).getHours();
      hourCounts[hour]++;
    }
    const preferredHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((h) => h.hour);

    const profile: DriverLearningProfile = {
      driverId,
      zones,
      preferredHours,
      avgSessionDuration: 0,
      topPlatforms: [],
      lastComputed: Date.now(),
    };

    profileCache.set(driverId, profile);

    const zonesSummary = Array.from(zones.entries())
      .sort(([, a], [, b]) => b.score - a.score)
      .slice(0, 5)
      .map(([z, p]) => `${z}(${p.score > 0 ? '+' : ''}${p.score})`)
      .join(', ');

    console.log(
      `[LearningLoop] Driver ${driverId.substring(0, 8)}: ${zones.size} zones profiled | Top: ${zonesSummary} | Hours: ${preferredHours.slice(0, 3).join('h, ')}h`,
    );

    return profile;
  } catch (err: any) {
    console.warn('[LearningLoop] computeProfile failed:', err.message);
    return {
      driverId,
      zones: new Map(),
      preferredHours: [],
      avgSessionDuration: 0,
      topPlatforms: [],
      lastComputed: Date.now(),
    };
  }
}

// ── Interface pour le FusionEngine ───────────────────────────────────────────

/**
 * Retourne les bonus/malus de scoring par zone pour un chauffeur.
 * Le FusionEngine appelle cette fonction pour personnaliser les recommendations.
 */
export async function getZoneBonuses(driverId: string): Promise<Map<string, number>> {
  const profile = await computeDriverProfile(driverId);
  const bonuses = new Map<string, number>();

  for (const [zone, pref] of profile.zones) {
    // Normaliser le score entre -10 et +10
    const normalized = Math.max(-10, Math.min(10, pref.score));
    if (normalized !== 0) {
      bonuses.set(zone, normalized);
    }
  }

  return bonuses;
}

/**
 * Enregistre une interaction pour l'apprentissage.
 * Appelé automatiquement après chaque réponse Ajnaya.
 */
export async function trackInteraction(
  driverId: string,
  message: string,
  response: string,
  zones: string[],
): Promise<void> {
  try {
    const profile = profileCache.get(driverId);
    if (!profile) return;

    // Les zones mentionnées dans la réponse d'Ajnaya
    const recommendedZones = extractZonesFromMessage(response);

    // Si le message suivant mentionne une zone recommandée = accepted
    const userZones = extractZonesFromMessage(message);
    for (const zone of userZones) {
      const existing = profile.zones.get(zone) || {
        zone,
        score: 0,
        accepted: 0,
        rejected: 0,
        ignored: 0,
        lastUpdated: Date.now(),
      };
      existing.accepted++;
      existing.score += 2;
      existing.lastUpdated = Date.now();
      profile.zones.set(zone, existing);
    }

    profileCache.set(driverId, profile);
  } catch {
    // Fire and forget — ne jamais bloquer le flow principal
  }
}

/**
 * Retourne un résumé lisible du profil d'apprentissage.
 * Pour l'endpoint admin.
 */
export async function getLearningStats(driverId: string): Promise<{
  zones: { zone: string; score: number; accepted: number; rejected: number }[];
  preferredHours: number[];
  profileAge: string;
}> {
  const profile = await computeDriverProfile(driverId);

  return {
    zones: Array.from(profile.zones.values())
      .sort((a, b) => b.score - a.score)
      .map((z) => ({ zone: z.zone, score: z.score, accepted: z.accepted, rejected: z.rejected })),
    preferredHours: profile.preferredHours,
    profileAge: `${Math.round((Date.now() - profile.lastComputed) / 60000)}min`,
  };
}
