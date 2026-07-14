/**
 * position.routes.ts — Le GARDIEN du cahier des positions (H3).
 * ═══════════════════════════════════════════════════════════════════════════
 * POST /api/driver/position
 *   Header  Authorization: Bearer <supabase access_token du chauffeur>
 *   Body    { lat: number, lng: number, status?: 'online'|'idle'|'driving', heading?: number, speed_kmh?: number }
 *   Effet   calcule les cellules H3 (rés 9 + rés 7) et upsert la position du chauffeur
 *           dans pieuvre_h3_driver_positions (1 ligne par chauffeur, UNIQUE(driver_id)).
 *
 * Pourquoi ici et pas l'app directement : la table est verrouillée RLS
 * `service_role_only` (voulu — personne ne peut écrire n'importe quoi dans le
 * cahier). L'app envoie sa position avec SON badge (token), le gardien vérifie
 * et écrit avec SA clé (service_role).
 *
 * C'est CE flux qui nourrit : le push proximité (signalements à ≤1,5 km),
 * la heatmap en vraies données, et l'apprentissage de la Pieuvre (zones × heures).
 */
import { Router, Request, Response } from 'express';
import { latLngToCell } from 'h3-js';

const router = Router();

let admin: any = null;
async function getAdmin() {
  if (!admin) {
    const { createClient } = await import('@supabase/supabase-js');
    admin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return admin;
}

const VALID_STATUS = new Set(['online', 'idle', 'driving']);
// Anti-spam : 1 écriture max / 20 s / chauffeur (mémoire process — suffisant, Railway mono-instance).
const lastWriteByDriver = new Map<string, number>();
const MIN_INTERVAL_MS = 20_000;

// ─── "Toujours là ?" — confirmation communautaire au passage ────────────────
// 11/07 — demande de Chandler : au lieu d'une expiration automatique par
// délai (aucune n'existait réellement dans le code malgré expires_at=2h par
// défaut sur community_alerts), on demande au chauffeur qui passe PILE à
// l'endroit d'un signalement encore actif s'il y est toujours. Réutilise le
// flux de position qu'on vient de solidifier (foreground + arrière-plan) —
// chaque écriture de position est une occasion de vérifier, gratuitement.
const PASS_RADIUS_KM = 0.08; // 80 m — "pile à l'endroit", pas juste "dans le coin" (1,5 km = notify-nearby-drivers)
const ALERT_LABELS: Record<string, string> = {
  police: 'Contrôle police',
  radar: 'Radar',
  bouchon: 'Bouchon',
  accident: 'Accident',
  manifestation: 'Manifestation',
  autre: 'Signalement',
};

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371,
    toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat),
    dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Best-effort, jamais bloquant : une erreur ici ne doit JAMAIS faire échouer
 * l'écriture de position (le cœur de la route). Demande UNE FOIS par
 * chauffeur par alerte (alert_pass_prompts, PK composite) — jamais de spam
 * même si le chauffeur reste garé pile à l'endroit pendant des heures.
 */
async function maybeAskAlertStillThere(
  sb: any,
  driverId: string,
  lat: number,
  lng: number,
): Promise<void> {
  try {
    const dLat = 0.01,
      dLng = 0.015; // marge large (~1-1.5km), affinée par haversine ensuite
    const { data: candidates } = await sb
      .from('community_alerts')
      .select('id, alert_type, lat, lng, created_by')
      .eq('is_expired', false)
      .gt('expires_at', new Date().toISOString())
      .gte('lat', lat - dLat)
      .lte('lat', lat + dLat)
      .gte('lng', lng - dLng)
      .lte('lng', lng + dLng);

    if (!candidates || candidates.length === 0) return;

    let closest: any = null;
    let closestDist = Infinity;
    for (const a of candidates) {
      if (a.created_by === driverId) continue; // jamais se demander à soi-même
      if (a.lat == null || a.lng == null) continue;
      const d = haversineKm(lat, lng, Number(a.lat), Number(a.lng));
      if (d <= PASS_RADIUS_KM && d < closestDist) {
        closest = a;
        closestDist = d;
      }
    }
    if (!closest) return;

    // Déjà voté (fil Communauté) → inutile de redemander.
    const { data: voted } = await sb
      .from('alert_validations')
      .select('alert_id')
      .eq('alert_id', closest.id)
      .eq('user_id', driverId)
      .maybeSingle();
    if (voted) return;

    // Marque "demandé" AVANT d'envoyer (PK composite alert_id+driver_id) : si
    // deux positions arrivent coup sur coup avant que le push parte, le 2e
    // insert échoue proprement (déjà marqué) → jamais deux pushs pour la même paire.
    const { error: markErr } = await sb
      .from('alert_pass_prompts')
      .insert({ alert_id: closest.id, driver_id: driverId });
    if (markErr) return; // déjà marqué (race) → pas de 2e envoi

    // 11/07 (retour Chandler) — TOUS les appareils du chauffeur, pas le premier
    // au hasard. Un chauffeur avec 2 téléphones (ancien+nouveau, perso+pro) ne
    // doit pas dépendre du hasard pour recevoir la question. Sûr par construction
    // : cast_alert_vote fait un UPSERT par (alert_id, user_id) — répondre depuis
    // 2 appareils ne crée jamais de double-comptage, juste la dernière réponse gagne.
    const { data: tokens } = await sb
      .from('user_push_tokens')
      .select('token')
      .eq('user_id', driverId);
    const validTokens = (tokens ?? [])
      .map((t: any) => t.token)
      .filter((t: any) => t && String(t).startsWith('ExponentPushToken'));
    if (validTokens.length === 0) return;

    const label = ALERT_LABELS[closest.alert_type] ?? 'Signalement';
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(
        validTokens.map((to: string) => ({
          to,
          title: 'Toujours là ?',
          body: `${label} · touche pour dire si c'est encore le cas`,
          data: { screen: 'AlertPassConfirm', screenParams: { alertId: closest.id } },
          sound: 'default',
          priority: 'high',
          channelId: 'foreas-community',
        })),
      ),
    }).catch(() => {});
  } catch {
    /* best-effort : ne doit jamais perturber l'écriture de position */
  }
}

// POST /api/driver/position
router.post('/', async (req: Request, res: Response) => {
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'lat/lng invalides' });
  }

  try {
    const sb = await getAdmin();

    // 1. Le badge : le token prouve QUI envoie — on n'écrit QUE pour ce chauffeur.
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user?.id) return res.status(401).json({ error: 'Session invalide' });
    const driverId: string = userData.user.id;

    // 2. Anti-spam (l'app envoie ~1 position/45s ; on tolère jusqu'à 1/20s).
    const last = lastWriteByDriver.get(driverId) ?? 0;
    if (Date.now() - last < MIN_INTERVAL_MS) {
      return res.json({ ok: true, throttled: true });
    }

    // 3. Les cellules H3 : rés 9 (~150 m, précise) + rés 7 (~1,2 km, quartier).
    const h3_index = latLngToCell(lat, lng, 9);
    const h3_index_r7 = latLngToCell(lat, lng, 7);

    const statusRaw = String(req.body?.status ?? 'online').toLowerCase();
    const status = VALID_STATUS.has(statusRaw) ? statusRaw : 'online';
    const heading = Number.isFinite(Number(req.body?.heading)) ? Number(req.body.heading) : null;
    const speed = Number.isFinite(Number(req.body?.speed_kmh)) ? Number(req.body.speed_kmh) : null;

    // 4. Écriture dans le cahier (1 ligne par chauffeur, la plus fraîche gagne).
    const { error: upErr } = await sb.from('pieuvre_h3_driver_positions').upsert(
      {
        driver_id: driverId,
        h3_index,
        h3_index_r7,
        latitude: lat,
        longitude: lng,
        status,
        heading,
        speed_kmh: speed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'driver_id' },
    );
    if (upErr) {
      console.error('[Position] upsert KO:', upErr.message);
      return res.status(500).json({ error: 'Écriture impossible' });
    }

    lastWriteByDriver.set(driverId, Date.now());
    // Fire-and-forget : ne JAMAIS attendre/bloquer la réponse position pour ça.
    maybeAskAlertStillThere(sb, driverId, lat, lng).catch(() => {});
    return res.json({ ok: true, h3: h3_index, h3_r7: h3_index_r7 });
  } catch (err: any) {
    console.error('[Position] error:', err?.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

export const positionRouter = router;
