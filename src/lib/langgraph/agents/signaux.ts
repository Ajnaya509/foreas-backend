// src/lib/langgraph/agents/signaux.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function signauxAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    let recentEvents: Record<string, unknown>[] = [];
    let currentZone: string | null = null;
    let surgeActive = false;
    let lastFare: number | null = null;
    let nearbyEvents: Record<string, unknown>[] = [];
    let gtfsDisruptions: Record<string, unknown>[] = [];
    let zoneIntelligence: Record<string, unknown> | null = null;

    if (state.driverId) {
      // 1. Screen reader events (dernieres courses/offres)
      const { data: events } = await supabase
        .from('pieuvre_screen_reader_events')
        .select('*')
        .eq('driver_id', state.driverId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (events && events.length > 0) {
        recentEvents = events;
        currentZone = events[0].pickup_zone || null;
        surgeActive = (events[0].surge_multiplier || 1) > 1.2;
        lastFare = events[0].fare_proposed || null;
      }
    }

    // 2. Evenements locaux a venir (pour tous)
    const now = new Date().toISOString();
    const in6hours = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const { data: localEvents } = await supabase
      .from('pieuvre_external_events')
      .select(
        'event_name, event_type, venue, city, starts_at, ends_at, expected_attendance, demand_multiplier',
      )
      .gte('starts_at', now)
      .lte('starts_at', in6hours)
      .order('starts_at', { ascending: true })
      .limit(5);

    if (localEvents) nearbyEvents = localEvents;

    // 3. Perturbations GTFS actives
    const { data: disruptions } = await supabase
      .from('pieuvre_gtfs_disruptions')
      .select(
        'line, disruption_type, severity, affected_stations, estimated_passenger_impact, vtc_surge_prediction, vtc_surge_eta_minutes',
      )
      .eq('is_active', true)
      .order('detected_at', { ascending: false })
      .limit(3);

    if (disruptions) gtfsDisruptions = disruptions;

    // 4. Zone intelligence (si zone connue)
    if (currentZone) {
      const currentHour = new Date().getHours();
      const currentDay = new Date().getDay();
      const { data: zoneData } = await supabase
        .from('pieuvre_zone_intelligence')
        .select('*')
        .eq('zone_name', currentZone)
        .eq('hour_of_day', currentHour)
        .eq('day_of_week', currentDay)
        .limit(1)
        .maybeSingle();

      if (zoneData) zoneIntelligence = zoneData;
    }

    return {
      recentEvents,
      currentZone,
      surgeActive,
      lastFare,
      nearbyEvents,
      gtfsDisruptions,
      zoneIntelligence,
    };
  } catch (error: any) {
    return {
      recentEvents: [],
      nearbyEvents: [],
      gtfsDisruptions: [],
      errors: [{ agent: 'signaux', error: error.message }],
    };
  }
}
