/**
 * AjnayaFusionEngine — Cerveau natif de croisement de données
 *
 * Collecte, croise et fusionne TOUTES les sources de données
 * en parallèle AVANT d'envoyer quoi que ce soit à GPT-4o.
 *
 * Le LLM reçoit un contexte unifié pré-digéré, pas des blocs disparates.
 *
 * Sources : Sonar, PredictHQ, Bolt, Weather, SNCF, TomTom, IDFM, Twitter, RAG, Supabase
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface FusionSignal {
  source: string;
  confidence: number; // 0-100
  data: any;
  timestamp: number;
  ttl_ms: number;
}

export interface DemandZone {
  zone: string;
  score: number; // 0-100
  reasons: string[];
  sources: string[];
}

export interface FusionContext {
  // Contexte unifié pour le LLM
  demandZones: DemandZone[];
  alerts: string[];
  opportunities: string[];
  driverContext: {
    todayEarnings: number;
    todayRides: number;
    isSubscriptionActive: boolean;
    platforms: string[];
  };
  weather: {
    condition: string;
    impact: 'positive' | 'negative' | 'neutral';
    detail: string;
  } | null;
  events: { name: string; venue: string; start: string; attendees: number; impact: string }[];
  traffic: { congestion: string; hotspots: string[] } | null;
  trains: { gare: string; arrivals: number; nextBigWave: string }[];
  transport: { perturbations: string[] } | null;
  trends: string[];
  sonarInsights: string | null;
  ragKnowledge: string | null;
  // Meta
  sourcesUsed: string[];
  fusionTimestamp: number;
  totalLatency: number;
}

// ── Cache mémoire ────────────────────────────────────────────────────────────

const signalCache = new Map<string, FusionSignal>();

function getCachedSignal(key: string): any | null {
  const cached = signalCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > cached.ttl_ms) {
    signalCache.delete(key);
    return null;
  }
  return cached.data;
}

function setCachedSignal(
  key: string,
  data: any,
  ttl_ms: number,
  source: string,
  confidence: number,
): void {
  signalCache.set(key, { source, confidence, data, timestamp: Date.now(), ttl_ms });
}

// ── Collecteurs individuels ──────────────────────────────────────────────────

async function collectWeather(): Promise<any> {
  const cached = getCachedSignal('weather');
  if (cached) return cached;
  try {
    const { getWeatherContext } = await import('./realtimeAdapters/WeatherAdapter.js');
    const data = await getWeatherContext();
    if (data) setCachedSignal('weather', data, 15 * 60 * 1000, 'openweather', 90);
    return data;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectEvents(): Promise<any> {
  const cached = getCachedSignal('events');
  if (cached) return cached;
  try {
    const { getEventsContext } = await import('./realtimeAdapters/PredictHQAdapter.js');
    const data = await getEventsContext();
    if (data) setCachedSignal('events', data, 30 * 60 * 1000, 'predicthq', 85);
    return data;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectTrains(): Promise<any> {
  const cached = getCachedSignal('trains');
  if (cached) return cached;
  try {
    const { getTrainContext } = await import('./realtimeAdapters/SNCFAdapter.js');
    const data = await getTrainContext();
    if (data) setCachedSignal('trains', data, 5 * 60 * 1000, 'sncf', 80);
    return data;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectTraffic(): Promise<any> {
  const cached = getCachedSignal('traffic');
  if (cached) return cached;
  try {
    const { getTrafficContext } = await import('./realtimeAdapters/TomTomTrafficAdapter.js');
    const data = await getTrafficContext();
    if (data) setCachedSignal('traffic', data, 3 * 60 * 1000, 'tomtom', 85);
    return data;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectTransport(): Promise<any> {
  const cached = getCachedSignal('transport');
  if (cached) return cached;
  try {
    const { getTransportContext } = await import('./realtimeAdapters/IDFMAdapter.js');
    const data = await getTransportContext();
    if (data) setCachedSignal('transport', data, 10 * 60 * 1000, 'idfm', 75);
    return data;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectTrends(): Promise<any> {
  const cached = getCachedSignal('trends');
  if (cached) return cached;
  try {
    const { getSocialContext } = await import('./realtimeAdapters/XTwitterAdapter.js');
    const data = await getSocialContext();
    if (data) setCachedSignal('trends', data, 10 * 60 * 1000, 'twitter', 50);
    return data;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectBolt(): Promise<any> {
  const cached = getCachedSignal('bolt');
  if (cached) return cached;
  try {
    const boltModule = await import('./boltFleet.js');
    const boltFleet = boltModule.default || boltModule.boltFleet;
    if (!boltFleet?.isConfigured) return null;
    const context = await boltFleet.getAjnayaContext();
    if (context) setCachedSignal('bolt', context, 2 * 60 * 1000, 'bolt', 95);
    return context;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectSonar(message: string): Promise<string | null> {
  try {
    const { needsSonarSearch, querySonar, formatSonarContext } =
      await import('./perplexitySonar.js');
    if (!needsSonarSearch(message)) return null;
    const result = await querySonar(message);
    if (!result) return null;
    return formatSonarContext(result);
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

async function collectRAG(message: string): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;
  try {
    // 1. Generate query embedding directly via OpenAI API
    const embResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: message }),
    });
    if (!embResponse.ok) return null;
    const embData = (await embResponse.json()) as any;
    const queryEmbedding = embData?.data?.[0]?.embedding;
    if (!queryEmbedding) return null;

    // 2. Search pgvector via Supabase RPC — pass embedding as pgvector string format
    const { getSupabaseAdmin } = await import('../helpers/supabase.js');
    const supa = await getSupabaseAdmin();
    const embString = `[${queryEmbedding.join(',')}]`;
    const { data, error } = await supa.rpc('search_documents', {
      query_embedding: embString,
      match_threshold: 0.35,
      match_count: 5,
    });
    if (error) {
      console.warn('[FusionEngine] RAG RPC error:', error.message);
      return null;
    }
    if (!data?.length) return null;

    // 3. Format results
    const context = data
      .map((r: any, i: number) => `[Source ${i + 1}]\n${(r.chunk_text || '').substring(0, 800)}`)
      .join('\n\n');
    console.log(
      `[FusionEngine] RAG: ${data.length} résultats (sim: ${data[0]?.similarity?.toFixed(3)})`,
    );
    return context;
  } catch (err: any) {
    console.error('[FusionEngine] RAG FAILED:', err.message, err.stack?.split('\n')[1]?.trim());
    return null;
  }
}

async function collectDriverData(driverId?: string): Promise<any> {
  if (!driverId) return null;
  const cached = getCachedSignal(`driver_${driverId}`);
  if (cached) return cached;
  try {
    const { getSupabaseAdmin } = await import('../helpers/supabase.js');
    const supa = await getSupabaseAdmin();
    const { data: driver } = await supa
      .from('drivers')
      .select('id, first_name, is_active, referral_code, stripe_account_id, created_at')
      .eq('id', driverId)
      .single();
    if (driver) setCachedSignal(`driver_${driverId}`, driver, 5 * 60 * 1000, 'supabase', 100);
    return driver;
  } catch (e: any) {
    console.warn('[FusionEngine] Source failed:', e.message?.substring(0, 80));
    return null;
  }
}

// ── Analyse croisée : DEMAND SCORING ─────────────────────────────────────────

function crossAnalyzeDemand(
  weather: any,
  events: any,
  trains: any,
  traffic: any,
  transport: any,
  trends: any,
  learningBonuses?: Map<string, number>,
): DemandZone[] {
  const zones: Map<string, DemandZone> = new Map();

  function addScore(zone: string, points: number, reason: string, source: string) {
    const existing = zones.get(zone) || { zone, score: 0, reasons: [], sources: [] };
    existing.score += points;
    existing.reasons.push(reason);
    if (!existing.sources.includes(source)) existing.sources.push(source);
    zones.set(zone, existing);
  }

  // ── Events impact
  if (events?.events) {
    for (const evt of events.events.slice(0, 10)) {
      const venue = evt.venue || evt.location || 'Paris';
      addScore(
        venue,
        25,
        `${evt.title || evt.category} (${evt.attendees || '?'} pers.)`,
        'predicthq',
      );
    }
  }

  // ── Train arrivals → gares = demand
  if (trains?.gares) {
    for (const gare of trains.gares) {
      if (gare.prochaines_arrivees > 3) {
        addScore(gare.nom, 20, `${gare.prochaines_arrivees} trains arrivent`, 'sncf');
      }
    }
  }

  // ── Weather impact
  if (weather) {
    const condition = weather.condition || weather.weather;
    if (condition && /pluie|rain|neige|snow|orage|storm/i.test(condition)) {
      // Mauvais temps = plus de demande VTC partout
      for (const [zone, data] of zones) {
        data.score += 10;
        data.reasons.push('Météo défavorable → +demande VTC');
        if (!data.sources.includes('openweather')) data.sources.push('openweather');
      }
      // Zones couvertes premium
      addScore('Gares couvertes', 15, 'Pluie → passagers cherchent VTC aux gares', 'openweather');
      addScore('Centres commerciaux', 10, 'Pluie → sorties centres commerciaux', 'openweather');
    }
  }

  // ── Traffic → zones congestionnées = opportunités
  if (traffic?.segments) {
    for (const seg of traffic.segments.slice(0, 5)) {
      if (seg.congestion > 0.7) {
        addScore(seg.name || seg.road, 5, 'Trafic dense → surge probable', 'tomtom');
      }
    }
  }

  // ── Transport perturbations → report sur VTC
  if (transport?.perturbations) {
    for (const p of transport.perturbations.slice(0, 5)) {
      const line = p.line || p.ligne || '';
      addScore(`Stations ${line}`, 15, `Perturbation ${line} → report VTC`, 'idfm');
    }
  }

  // ── Time-based patterns (inné, pas besoin d'API)
  const hour = new Date().getHours();
  const dayOfWeek = new Date().getDay();

  if (hour >= 6 && hour <= 9) {
    addScore('Gare du Nord', 15, 'Rush matin gares', 'pattern');
    addScore('Gare de Lyon', 15, 'Rush matin gares', 'pattern');
    addScore('La Défense', 12, 'Début journée business', 'pattern');
  } else if (hour >= 11 && hour <= 14) {
    addScore('Champs-Élysées', 10, 'Pause déjeuner tourisme', 'pattern');
    addScore('Opéra', 10, 'Déjeuners business', 'pattern');
  } else if (hour >= 17 && hour <= 20) {
    addScore('La Défense', 18, 'Sortie bureaux', 'pattern');
    addScore('Opéra', 12, 'Sortie bureaux', 'pattern');
    addScore('Gares', 15, 'Retours domicile', 'pattern');
  } else if (hour >= 22 || hour <= 4) {
    addScore('Bastille', 20, 'Vie nocturne', 'pattern');
    addScore('Pigalle', 18, 'Vie nocturne', 'pattern');
    addScore('Oberkampf', 15, 'Vie nocturne', 'pattern');
    if (dayOfWeek === 5 || dayOfWeek === 6) {
      addScore('Champs-Élysées', 15, 'Weekend nuit', 'pattern');
    }
  }

  // ── Learning bonuses : personnalisation par chauffeur
  if (learningBonuses && learningBonuses.size > 0) {
    for (const [zone, data] of zones) {
      const zoneLower = zone.toLowerCase();
      for (const [learnedZone, bonus] of learningBonuses) {
        if (zoneLower.includes(learnedZone) || learnedZone.includes(zoneLower)) {
          data.score += bonus;
          data.reasons.push(`Préférence perso ${bonus > 0 ? '+' : ''}${bonus}`);
          if (!data.sources.includes('learning')) data.sources.push('learning');
        }
      }
    }
  }

  // Trier par score décroissant
  return Array.from(zones.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// ── Détection d'alertes ──────────────────────────────────────────────────────

function detectAlerts(weather: any, traffic: any, transport: any, events: any): string[] {
  const alerts: string[] = [];

  if (weather) {
    const cond = weather.condition || weather.weather || '';
    if (/verglas|gel|ice/i.test(cond)) alerts.push('VERGLAS — conduite prudente, demande forte');
    if (/orage|storm|tempete/i.test(cond)) alerts.push('ORAGE — pics de demande, attention routes');
    if (/neige|snow/i.test(cond)) alerts.push('NEIGE — trafic ralenti, tarifs élevés');
  }

  if (transport?.perturbations?.length > 3) {
    alerts.push(`${transport.perturbations.length} perturbations transports → forte demande VTC`);
  }

  if (events?.events?.length > 5) {
    alerts.push(`${events.events.length} événements en cours → zones à forte affluence`);
  }

  return alerts;
}

// ── Détection d'opportunités ─────────────────────────────────────────────────

function detectOpportunities(demandZones: DemandZone[], driverData: any, events: any): string[] {
  const opps: string[] = [];

  // Top 3 zones
  const top3 = demandZones.slice(0, 3);
  if (top3.length > 0) {
    opps.push(`Zones premium : ${top3.map((z) => `${z.zone} (${z.score}pts)`).join(', ')}`);
  }

  // Gros événement imminent
  if (events?.events) {
    const bigEvent = events.events.find((e: any) => (e.attendees || 0) > 5000);
    if (bigEvent) {
      opps.push(
        `Gros événement : ${bigEvent.title || bigEvent.category} (${bigEvent.attendees} pers.) → positionne-toi 30min avant`,
      );
    }
  }

  return opps;
}

// ── ENGINE PRINCIPAL ─────────────────────────────────────────────────────────

export async function fuse(message: string, driverId?: string): Promise<FusionContext> {
  const start = Date.now();
  const sourcesUsed: string[] = [];

  // ── Collecte PARALLÈLE de toutes les sources ──
  const [weather, events, trains, traffic, transport, trends, bolt, sonar, rag, driverData] =
    await Promise.allSettled([
      collectWeather(),
      collectEvents(),
      collectTrains(),
      collectTraffic(),
      collectTransport(),
      collectTrends(),
      collectBolt(),
      collectSonar(message),
      collectRAG(message),
      collectDriverData(driverId),
    ]).then((results) =>
      results.map((r, i) => {
        const sources = [
          'openweather',
          'predicthq',
          'sncf',
          'tomtom',
          'idfm',
          'twitter',
          'bolt',
          'sonar',
          'rag',
          'supabase',
        ];
        if (r.status === 'fulfilled' && r.value) {
          sourcesUsed.push(sources[i]);
          return r.value;
        }
        return null;
      }),
    );

  // ── Learning Loop : personnalisation par chauffeur ──
  let learningBonuses: Map<string, number> | undefined;
  if (driverId) {
    try {
      const { getZoneBonuses } = await import('./AjnayaLearningLoop.js');
      learningBonuses = await getZoneBonuses(driverId);
      if (learningBonuses.size > 0) {
        sourcesUsed.push('learning');
        console.log(`[FusionEngine] Learning: ${learningBonuses.size} zone preferences loaded`);
      }
    } catch (e: any) {
      console.warn('[FusionEngine] LearningLoop skip:', e.message?.substring(0, 60));
    }
  }

  // ── Croisement des données ──
  const demandZones = crossAnalyzeDemand(
    weather,
    events,
    trains,
    traffic,
    transport,
    trends,
    learningBonuses,
  );
  const alerts = detectAlerts(weather, traffic, transport, events);
  const opportunities = detectOpportunities(demandZones, driverData, events);

  // ── Construction du contexte unifié ──
  const context: FusionContext = {
    demandZones,
    alerts,
    opportunities,
    driverContext: {
      todayEarnings: 0,
      todayRides: 0,
      isSubscriptionActive: driverData?.is_active || false,
      platforms: bolt ? ['bolt'] : [],
    },
    weather: weather
      ? {
          condition: weather.condition || weather.weather || 'inconnu',
          impact: /pluie|rain|neige|snow|orage/i.test(weather.condition || '')
            ? 'positive'
            : 'neutral',
          detail: weather.summary || weather.description || '',
        }
      : null,
    events: (events?.events || []).slice(0, 5).map((e: any) => ({
      name: e.title || e.category || 'Événement',
      venue: e.venue || e.location || '',
      start: e.start || '',
      attendees: e.attendees || 0,
      impact: (e.attendees || 0) > 5000 ? 'fort' : (e.attendees || 0) > 1000 ? 'moyen' : 'faible',
    })),
    traffic: traffic
      ? {
          congestion: traffic.global_congestion || traffic.level || 'normal',
          hotspots: (traffic.segments || []).slice(0, 3).map((s: any) => s.name || s.road || ''),
        }
      : null,
    trains: (trains?.gares || [])
      .filter((g: any) => g.prochaines_arrivees > 0)
      .map((g: any) => ({
        gare: g.nom,
        arrivals: g.prochaines_arrivees,
        nextBigWave: g.prochaine_vague || '',
      })),
    transport:
      transport?.perturbations?.length > 0
        ? {
            perturbations: transport.perturbations
              .slice(0, 5)
              .map((p: any) => p.message || p.summary || `${p.line || p.ligne} perturbée`),
          }
        : null,
    trends: (trends?.trending || []).slice(0, 3).map((t: any) => t.name || t.text || String(t)),
    sonarInsights: sonar || null,
    ragKnowledge: rag || null,
    sourcesUsed,
    fusionTimestamp: Date.now(),
    totalLatency: Date.now() - start,
  };

  console.log(
    `[FusionEngine] ${sourcesUsed.length}/10 sources (${context.totalLatency}ms) | ${demandZones.length} zones | ${alerts.length} alertes | ${opportunities.length} opps`,
  );

  return context;
}

// ── Serializer : transforme FusionContext en texte structuré pour le LLM ─────

export function serializeFusionContext(ctx: FusionContext): string {
  const parts: string[] = [];

  // Alertes en premier (prioritaire)
  if (ctx.alerts.length > 0) {
    parts.push(`⚠️ ALERTES: ${ctx.alerts.join(' | ')}`);
  }

  // Zones de demande
  if (ctx.demandZones.length > 0) {
    const zonesStr = ctx.demandZones
      .slice(0, 5)
      .map((z) => `${z.zone} (${z.score}pts: ${z.reasons.slice(0, 2).join(', ')})`)
      .join(' | ');
    parts.push(`📍 ZONES CHAUDES: ${zonesStr}`);
  }

  // Opportunités
  if (ctx.opportunities.length > 0) {
    parts.push(`💰 OPPORTUNITÉS: ${ctx.opportunities.join(' | ')}`);
  }

  // Météo
  if (ctx.weather) {
    const impact = ctx.weather.impact === 'positive' ? '→ +demande VTC' : '';
    parts.push(`🌦️ MÉTÉO: ${ctx.weather.condition} ${impact}`);
  }

  // Événements
  if (ctx.events.length > 0) {
    const evts = ctx.events
      .slice(0, 3)
      .map((e) => `${e.name} à ${e.venue} (${e.attendees} pers., impact ${e.impact})`)
      .join(' | ');
    parts.push(`🎭 ÉVÉNEMENTS: ${evts}`);
  }

  // Trains
  if (ctx.trains.length > 0) {
    const trns = ctx.trains.map((t) => `${t.gare}: ${t.arrivals} trains`).join(', ');
    parts.push(`🚆 GARES: ${trns}`);
  }

  // Trafic
  if (ctx.traffic) {
    parts.push(
      `🚗 TRAFIC: ${ctx.traffic.congestion}${ctx.traffic.hotspots.length > 0 ? ` (${ctx.traffic.hotspots.join(', ')})` : ''}`,
    );
  }

  // Perturbations transports
  if (ctx.transport) {
    parts.push(`🚇 PERTURBATIONS: ${ctx.transport.perturbations.slice(0, 3).join(' | ')}`);
  }

  // Sonar (recherche web)
  if (ctx.sonarInsights) {
    parts.push(`🔍 WEB: ${ctx.sonarInsights}`);
  }

  // RAG (base de connaissances)
  if (ctx.ragKnowledge) {
    // Tronquer le RAG pour ne pas noyer le contexte
    const truncated =
      ctx.ragKnowledge.length > 500 ? ctx.ragKnowledge.substring(0, 500) + '...' : ctx.ragKnowledge;
    parts.push(`📚 RÉFÉRENCE: ${truncated}`);
  }

  // Bolt
  if (ctx.driverContext.platforms.includes('bolt')) {
    parts.push(`🟢 BOLT: Connecté`);
  }

  // Meta
  parts.push(`[${ctx.sourcesUsed.length}/10 sources | ${ctx.totalLatency}ms]`);

  return parts.join('\n');
}
