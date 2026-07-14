/**
 * Pieuvre Routes — Pont entre la Pieuvre N8N et l'app FOREAS Driver
 *
 * POST /screen-reader-event — Screen Reader events (auth JWT driver)
 * POST /in-app-message — Messages in-app depuis tentacules (auth PIEUVRE_API_KEY)
 */
import { Router, Request, Response } from 'express';
import { latLngToCell } from 'h3-js';

const router = Router();

/**
 * Calcule l'hexagone H3 (res 9, ~150 m) d'une position — CARBURANT de Chronos-2 :
 * agréger la demande captée (Uber/Bolt/Heetch) par zone H3 → prédire où ça chauffe.
 * Sans ça, pickup_h3 reste NULL et la demande n'est indexable par zone.
 */
function toH3(lat: unknown, lon: unknown): string | null {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null;
  try {
    return latLngToCell(la, lo, 9);
  } catch {
    return null;
  }
}

const VALID_PLATFORMS = ['uber', 'bolt', 'heetch', 'other'];
const VALID_DECISIONS = ['accepted', 'refused', 'expired'];
const PIEUVRE_API_KEY = process.env.PIEUVRE_API_KEY || '';

let supabaseAdmin: any;
async function getSupa() {
  if (supabaseAdmin) return supabaseAdmin;
  const { createClient } = await import('@supabase/supabase-js');
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL ||
      process.env.URL_SUPABASE ||
      'https://fihvdvlhftcxhlnocqiq.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return supabaseAdmin;
}

/** Extract driver_id from JWT (same pattern as other routes) */
async function getDriverIdFromJWT(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const supa = await getSupa();
    const { data } = await supa.auth.getUser(authHeader.replace('Bearer ', ''));
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /screen-reader-event — Screen Reader capture (JWT driver)
// ═══════════════════════════════════════════════════════════════
router.post('/screen-reader-event', async (req: Request, res: Response) => {
  try {
    const driverId = await getDriverIdFromJWT(req);
    if (!driverId) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    const { platform, decision } = req.body;

    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return res
        .status(400)
        .json({ success: false, error: `platform requis: ${VALID_PLATFORMS.join(', ')}` });
    }
    if (!decision || !VALID_DECISIONS.includes(decision)) {
      return res
        .status(400)
        .json({ success: false, error: `decision requis: ${VALID_DECISIONS.join(', ')}` });
    }

    const now = new Date();
    const supa = await getSupa();

    // Fallback position : le client n'attache le GPS que si la permission est déjà
    // accordée ET qu'une position <60s existe (souvent raté en tâche de fond). Si le
    // client n'a rien envoyé, on retombe sur la dernière position connue du chauffeur
    // (déjà alimentée en continu par DriverPositionReporter/BackgroundLocationTask) —
    // une position à quelques minutes reste un proxy de zone parfaitement valable ici.
    let pickupLat = req.body.pickup_lat || null;
    let pickupLon = req.body.pickup_lon || null;
    // Provenance (audit Fable) : le filet réutilise la dernière position connue, qui peut
    // dater de quelques minutes (chauffeur en mouvement) — jamais confondue avec un fix GPS
    // frais, pour que verify_zone_predictions() puisse un jour pondérer/exclure ces lignes.
    let pickupGeoSource: 'device' | 'server_fallback' | null =
      pickupLat && pickupLon ? 'device' : null;
    if (!pickupLat || !pickupLon) {
      try {
        const { data: lastPos } = await supa
          .from('pieuvre_h3_driver_positions')
          .select('latitude, longitude, updated_at')
          .eq('driver_id', driverId)
          .gte('updated_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastPos?.latitude && lastPos?.longitude) {
          pickupLat = lastPos.latitude;
          pickupLon = lastPos.longitude;
          pickupGeoSource = 'server_fallback';
        }
      } catch (e: any) {
        console.warn('[Pieuvre] screen-reader-event: fallback position lookup failed:', e?.message);
      }
    }

    const { data, error } = await supa
      .from('pieuvre_screen_reader_events')
      .insert({
        driver_id: driverId,
        platform: req.body.platform,
        fare_proposed: req.body.fare_proposed || null,
        distance_km: req.body.distance_km || null,
        duration_estimated_min: req.body.duration_estimated_min || null,
        pickup_zone: req.body.pickup_zone || null,
        pickup_lat: pickupLat,
        pickup_lon: pickupLon,
        pickup_geo_source: pickupGeoSource,
        dropoff_zone: req.body.dropoff_zone || null,
        dropoff_lat: req.body.dropoff_lat || null,
        dropoff_lon: req.body.dropoff_lon || null,
        surge_multiplier: req.body.surge_multiplier || null,
        euro_per_hour_estimated: req.body.euro_per_hour_estimated || null,
        euro_per_km_estimated: req.body.euro_per_km_estimated || null,
        deadhead_km_estimated: req.body.deadhead_km_estimated || null,
        decision: req.body.decision,
        decision_time_seconds: req.body.decision_time_seconds || null,
        ajnaya_recommendation: req.body.ajnaya_recommendation || null,
        recommendation_followed: req.body.recommendation_followed ?? null,
        weather_condition: req.body.weather_condition || null,
        traffic_condition: req.body.traffic_condition || null,
        driver_fatigue_level: req.body.driver_fatigue_level || null,
        driver_ca_cumul_today: req.body.driver_ca_cumul_today || null,
        context: req.body.context || {},
        day_of_week: now.getDay(),
        hour_of_day: now.getHours(),
        // H3 calculé serveur (res 9) → indexe la demande par zone pour Chronos-2.
        pickup_h3: toH3(pickupLat, pickupLon),
        dropoff_h3: toH3(req.body.dropoff_lat, req.body.dropoff_lon),
      })
      .select('id')
      .single();

    if (error) {
      console.error('[Pieuvre] screen-reader-event INSERT error:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }

    // 🐙 Fire-and-forget vers webhook N8N Tentacule 0
    // Le workflow N8N "Screen Reader — Event Consumer" :
    //   - enrichit pickup_zone via fuzzy match zones_canonical
    //   - insère dans pieuvre_rides si event terminé (DEPOSE / completed)
    //   - log analytics_events
    //   - peut trigger contextual coaching
    // L'app reste rapide : on n'attend PAS la réponse.
    forwardToPieuvreScreenReaderWorkflow({
      ...req.body,
      driver_id: driverId,
      id: data.id,
      day_of_week: now.getDay(),
      hour_of_day: now.getHours(),
      created_at: now.toISOString(),
    }).catch((e) => console.warn('[Pieuvre] N8N forward warn:', e.message));

    return res.json({ success: true, event_id: data.id });
  } catch (err: any) {
    console.error('[Pieuvre] screen-reader-event error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

/**
 * Fire-and-forget vers le webhook N8N Screen Reader Event Consumer.
 * Ne bloque PAS la réponse à l'app (déjà loggé en DB).
 * Si le workflow N8N est down, on log un warn et on continue.
 */
async function forwardToPieuvreScreenReaderWorkflow(payload: any): Promise<void> {
  const url =
    process.env.PIEUVRE_SCREEN_READER_WEBHOOK_URL ||
    'https://n8n.srv1534739.hstgr.cloud/webhook/screen-reader-event';
  const secret = process.env.PIEUVRE_WEBHOOK_SECRET || process.env.PIEUVRE_RESPOND_SECRET || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000); // 3s timeout
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Foreas-Shared-Secret': secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /screen-reader-activated — Notifie Pieuvre que le chauffeur
// vient d'activer les permissions Screen Reader (Notification listener,
// Accessibility, Foreground service). Trigger un message vocal
// Laloosh de bienvenue via le workflow N8N dédié.
// ═══════════════════════════════════════════════════════════════
router.post('/screen-reader-activated', async (req: Request, res: Response) => {
  try {
    const driverId = await getDriverIdFromJWT(req);
    if (!driverId) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    // Fire-and-forget vers webhook N8N "Screen Reader — Welcome Activated"
    forwardToPieuvreWelcomeWorkflow({
      driver_id: driverId,
      activated_at: new Date().toISOString(),
      ...req.body, // optionnel : permissions activées, version app, etc.
    }).catch((e) => console.warn('[Pieuvre] welcome workflow forward warn:', e.message));

    return res.json({ success: true });
  } catch (err: any) {
    console.error('[Pieuvre] screen-reader-activated error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

async function forwardToPieuvreWelcomeWorkflow(payload: any): Promise<void> {
  const url =
    process.env.PIEUVRE_SCREEN_READER_ACTIVATED_WEBHOOK_URL ||
    'https://n8n.srv1534739.hstgr.cloud/webhook/screen-reader-activated';
  const secret = process.env.PIEUVRE_WEBHOOK_SECRET || process.env.PIEUVRE_RESPOND_SECRET || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Foreas-Shared-Secret': secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /in-app-message — Message in-app depuis Pieuvre N8N
// Auth: PIEUVRE_API_KEY (service-to-service)
// ═══════════════════════════════════════════════════════════════
router.post('/in-app-message', async (req: Request, res: Response) => {
  try {
    // Auth: PIEUVRE_API_KEY
    const authHeader = req.headers.authorization;
    if (!PIEUVRE_API_KEY || !authHeader || authHeader !== `Bearer ${PIEUVRE_API_KEY}`) {
      return res.status(401).json({ success: false, error: 'Clé API Pieuvre invalide' });
    }

    const { driver_id, message_type, content, metadata } = req.body;

    if (!driver_id || !content) {
      return res.status(400).json({ success: false, error: 'driver_id et content requis' });
    }

    const supa = await getSupa();

    // Vérifier que le driver existe
    const { data: driver } = await supa
      .from('drivers')
      .select('id, first_name')
      .eq('id', driver_id)
      .single();

    if (!driver) {
      return res.status(404).json({ success: false, error: 'Driver non trouvé' });
    }

    // 1. INSERT audit trail dans pieuvre_in_app_messages
    const { data: msg, error: msgError } = await supa
      .from('pieuvre_in_app_messages')
      .insert({
        driver_id,
        message_type: message_type || 'general',
        content,
        metadata: metadata || {},
        delivered: true,
      })
      .select('id')
      .single();

    if (msgError) {
      console.error('[Pieuvre] in-app-message INSERT error:', msgError.message);
      return res.status(500).json({ success: false, error: msgError.message });
    }

    // 2. Push notification via Expo
    let pushSent = false;
    try {
      const { data: tokens } = await supa
        .from('push_tokens')
        .select('token')
        .eq('user_id', driver_id);

      if (tokens && tokens.length > 0) {
        const truncatedContent = content.length > 100 ? content.substring(0, 97) + '...' : content;
        // 11/07 — audit notifs : `type` devait être 'pieuvre_message' (faute de
        // frappe technique : 'pieuvre_in_app_message' n'existe dans AUCUNE liste
        // reconnue par le routeur app — RootNavigator.routeFromNotification).
        // Même forme que PieuvreInboxService.present() côté client (le chemin
        // Realtime, déjà correct) : `route`/`routeParams` lus depuis metadata si
        // fournis par l'appelant N8N, sinon la notif marque juste "lu" (fallback
        // déjà sûr, inchangé).
        const pushMessages = tokens.map((t: any) => ({
          to: t.token,
          sound: 'default',
          title: "Ajnaya t'a envoyé un message",
          body: truncatedContent,
          data: {
            type: 'pieuvre_message',
            messageId: msg.id,
            messageType: message_type || 'general',
            route: metadata?.route,
            routeParams: metadata?.routeParams,
          },
        }));

        const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(pushMessages),
        });

        pushSent = pushRes.ok;
        if (pushSent) {
          await supa.from('pieuvre_in_app_messages').update({ push_sent: true }).eq('id', msg.id);
        }
      }
    } catch (pushErr: any) {
      console.warn('[Pieuvre] Push notification failed:', pushErr.message);
    }

    console.log(
      `[Pieuvre] in-app-message delivered to ${driver.first_name} (${driver_id}) — push: ${pushSent}`,
    );

    return res.status(201).json({
      message_id: msg.id,
      delivered: true,
      push_sent: pushSent,
    });
  } catch (err: any) {
    console.error('[Pieuvre] in-app-message error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

export default router;
