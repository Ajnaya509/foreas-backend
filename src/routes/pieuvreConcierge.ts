/**
 * Pieuvre Concierge Routes — v104 Sprint 2 Backend
 * ============================================================
 * Endpoints additionnels pour l'atelier Concierge Commercial :
 *
 *   POST   /api/pieuvre/voice/clone        — upload 30s audio → ElevenLabs clone
 *   GET    /api/pieuvre/voice/status       — statut du clone actuel
 *   DELETE /api/pieuvre/voice              — supprime le clone vocal
 *   POST   /api/pieuvre/whatsapp/send      — envoie un message WhatsApp via Meta Cloud API
 *   POST   /api/pieuvre/plaquette          — génère la plaquette commerciale (PDF signé)
 *
 * Auth : JWT driver requis sur chaque endpoint (Bearer)
 * Tables ciblées :
 *   - pieuvre_voice_clones (voice_id, preview_url, status)
 *   - pieuvre_conversations (insertion nouveau message)
 *   - pieuvre_plaquettes (URLs PDF générées)
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { renderPlaquetteHtml } from '../services/PlaquetteRenderer.js';

const router = Router();

// ── Supabase admin (service role) ───────────────────────────────────────
let supaAdmin: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (supaAdmin) return supaAdmin;
  supaAdmin = createClient(
    process.env.SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  return supaAdmin;
}

// ── Auth helper ─────────────────────────────────────────────────────────
async function getDriverIdFromJWT(req: Request): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const supa = getSupa();
    const { data } = await supa.auth.getUser(authHeader.replace('Bearer ', ''));
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// GET /api/pieuvre/voice/status
// ════════════════════════════════════════════════════════════════════════

router.get('/voice/status', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const supa = getSupa();
    const { data, error } = await supa
      .from('pieuvre_voice_clones')
      .select('voice_id, status, preview_url, created_at, updated_at')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.json({ status: 'not_created' });
    }

    return res.json({
      status: data.status || 'ready',
      voiceId: data.voice_id,
      previewUrl: data.preview_url,
      recordedAt: data.created_at,
      updatedAt: data.updated_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Erreur serveur' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/pieuvre/voice/clone
//
// Body JSON (base64 pour simplifier — évite multipart/form-data) :
//   { audioBase64: string, mimeType: 'audio/mp4' | 'audio/wav', label?: string }
//
// Flow :
//   1. Décode le buffer audio
//   2. Appelle ElevenLabs IVC API (POST /v1/voices/add)
//   3. Récupère voice_id
//   4. Récupère preview URL (GET /v1/voices/:voice_id → `preview_url`)
//   5. Upsert dans pieuvre_voice_clones
// ════════════════════════════════════════════════════════════════════════

router.post('/voice/clone', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const { audioBase64, mimeType, label } = req.body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return res.status(400).json({ error: 'audioBase64 requis (string)' });
  }
  const mt = (mimeType || 'audio/mp4') as string;

  // Sanity : 30s mono @ 16kHz ≈ 1 MB max → on cap à 5 MB pour marges
  const MAX_BYTES = 5 * 1024 * 1024;
  const buf = Buffer.from(audioBase64, 'base64');
  if (buf.length < 8 * 1024) {
    return res.status(400).json({ error: 'Enregistrement trop court (<8 KB)' });
  }
  if (buf.length > MAX_BYTES) {
    return res.status(400).json({ error: 'Enregistrement trop lourd (>5 MB)' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'Service Voice Clone non configuré (ELEVENLABS_API_KEY manquant)',
    });
  }

  try {
    // ── Appel ElevenLabs IVC (Instant Voice Cloning) ─────────────────
    const form = new FormData();
    form.append(
      'files',
      new Blob([new Uint8Array(buf)], { type: mt }),
      `driver-${driverId}.${mt.split('/')[1] || 'mp3'}`,
    );
    form.append('name', (label || `FOREAS Driver ${driverId.slice(0, 8)}`).slice(0, 80));
    form.append('description', 'Voix clonée FOREAS — utilisée pour envois vocaux WhatsApp B2B.');
    form.append('remove_background_noise', 'true');

    const elevenRes = await fetch('https://api.elevenlabs.io/v1/voices/add', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form as unknown as BodyInit,
    });

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error('[voice/clone] ElevenLabs error', elevenRes.status, errText);
      return res.status(502).json({
        error: `ElevenLabs ${elevenRes.status}`,
        detail: errText.slice(0, 200),
      });
    }

    const cloneJson = (await elevenRes.json()) as { voice_id: string };
    const voiceId = cloneJson.voice_id;
    if (!voiceId) {
      return res.status(502).json({ error: 'ElevenLabs : voice_id manquant' });
    }

    // ── Récupère preview URL ──────────────────────────────────────────
    let previewUrl: string | null = null;
    try {
      const detailRes = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (detailRes.ok) {
        const detail = (await detailRes.json()) as { preview_url?: string };
        previewUrl = detail.preview_url ?? null;
      }
    } catch (err: any) {
      console.warn('[voice/clone] preview fetch warning:', err?.message);
    }

    // ── Upsert dans pieuvre_voice_clones ──────────────────────────────
    const supa = getSupa();
    const nowISO = new Date().toISOString();
    const { error: upsertErr } = await supa.from('pieuvre_voice_clones').upsert(
      {
        driver_id: driverId,
        voice_id: voiceId,
        status: 'ready',
        preview_url: previewUrl,
        provider: 'elevenlabs',
        provider_model: 'ivc',
        label: label || null,
        created_at: nowISO,
        updated_at: nowISO,
      },
      { onConflict: 'driver_id' },
    );

    if (upsertErr) {
      console.error('[voice/clone] Supabase upsert error', upsertErr);
      // On ne fait pas échouer la réponse : la voix est créée côté ElevenLabs
    }

    return res.json({
      status: 'ready',
      voiceId,
      previewUrl,
      recordedAt: nowISO,
    });
  } catch (err: any) {
    console.error('[voice/clone] error', err?.message);
    return res.status(500).json({ error: err?.message || 'Erreur serveur' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// DELETE /api/pieuvre/voice
// Supprime le clone vocal côté ElevenLabs + row Supabase
// ════════════════════════════════════════════════════════════════════════

router.delete('/voice', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const apiKey = process.env.ELEVENLABS_API_KEY;

  try {
    const supa = getSupa();
    const { data } = await supa
      .from('pieuvre_voice_clones')
      .select('voice_id')
      .eq('driver_id', driverId)
      .maybeSingle();

    const voiceId = data?.voice_id as string | undefined;

    if (voiceId && apiKey) {
      try {
        await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
          method: 'DELETE',
          headers: { 'xi-api-key': apiKey },
        });
      } catch (err: any) {
        console.warn('[voice/delete] ElevenLabs delete warning:', err?.message);
      }
    }

    await supa.from('pieuvre_voice_clones').delete().eq('driver_id', driverId);

    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/pieuvre/whatsapp/send
//
// Body : { prospectId: string, text?: string, audioUrl?: string, templateName?: string }
//
// Flow :
//   1. Vérifie que le prospect appartient bien au driver
//   2. Vérifie que le téléphone du prospect est renseigné
//   3. Envoie via Meta Cloud API (POST /v18.0/{PHONE_NUMBER_ID}/messages)
//   4. Log dans pieuvre_conversations (direction=outbound)
// ════════════════════════════════════════════════════════════════════════

router.post('/whatsapp/send', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  const { prospectId, text, audioUrl, templateName } = req.body || {};
  if (!prospectId) return res.status(400).json({ error: 'prospectId requis' });
  if (!text && !audioUrl && !templateName) {
    return res.status(400).json({ error: 'Au moins un de text | audioUrl | templateName requis' });
  }

  const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return res.status(503).json({
      error: 'WhatsApp non configuré (META_WHATSAPP_* manquants)',
    });
  }

  try {
    const supa = getSupa();

    // ── Vérifie le prospect ───────────────────────────────────────────
    const { data: prospect } = await supa
      .from('pieuvre_prospects')
      .select('id, driver_id, phone, first_name')
      .eq('id', prospectId)
      .maybeSingle();

    if (!prospect) return res.status(404).json({ error: 'Prospect introuvable' });
    if (prospect.driver_id !== driverId) {
      return res.status(403).json({ error: 'Prospect hors de ton pipeline' });
    }
    if (!prospect.phone) {
      return res.status(400).json({ error: 'Numéro du prospect manquant' });
    }

    // ── Construit le payload WhatsApp ─────────────────────────────────
    const toE164 = prospect.phone.replace(/\s/g, '').replace(/^00/, '+');
    const basePayload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: toE164.startsWith('+') ? toE164 : `+${toE164}`,
    };

    let messagePayload: Record<string, unknown>;
    if (templateName) {
      messagePayload = {
        ...basePayload,
        type: 'template',
        template: { name: templateName, language: { code: 'fr' } },
      };
    } else if (audioUrl) {
      messagePayload = {
        ...basePayload,
        type: 'audio',
        audio: { link: audioUrl },
      };
    } else {
      messagePayload = {
        ...basePayload,
        type: 'text',
        text: { body: String(text).slice(0, 4096), preview_url: false },
      };
    }

    // ── Appel Meta Cloud API ──────────────────────────────────────────
    const metaRes = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    });

    if (!metaRes.ok) {
      const errBody = await metaRes.text();
      console.error('[whatsapp/send] Meta error', metaRes.status, errBody);
      return res.status(502).json({
        error: `Meta ${metaRes.status}`,
        detail: errBody.slice(0, 300),
      });
    }

    const metaJson = (await metaRes.json()) as {
      messages?: { id: string }[];
    };
    const waMessageId = metaJson.messages?.[0]?.id || null;

    // ── Log dans pieuvre_conversations ────────────────────────────────
    const nowISO = new Date().toISOString();
    const contentPreview = audioUrl
      ? '🎙️ Vocal envoyé'
      : templateName
        ? `Template : ${templateName}`
        : String(text).slice(0, 140);

    await supa.from('pieuvre_conversations').insert({
      driver_id: driverId,
      prospect_id: prospectId,
      channel: 'whatsapp',
      direction: 'outbound',
      content_preview: contentPreview,
      external_message_id: waMessageId,
      payload: messagePayload,
      created_at: nowISO,
      updated_at: nowISO,
    });

    return res.json({
      ok: true,
      messageId: waMessageId,
      channel: 'whatsapp',
      sentAt: nowISO,
    });
  } catch (err: any) {
    console.error('[whatsapp/send] error', err?.message);
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/pieuvre/plaquette
//
// Body : { style?: 'elegant' | 'bold' | 'nocturne' }
//
// Génère un PDF de plaquette commerciale personnalisé :
//   - Titre + slogan driver
//   - Photo véhicule (driver_vehicle_profile.photo_url)
//   - Stats driver (rides completed, quality_score, etc.)
//   - Témoignages 3 clients top
//   - QR code renvoyant vers la page landing WhatsApp
//
// Pour Sprint 2E : on renvoie une URL statique; le rendu Slidev
// sera câblé dans l'infra VPS (microservice).
// ════════════════════════════════════════════════════════════════════════

router.post('/plaquette', async (req: Request, res: Response) => {
  const driverId = await getDriverIdFromJWT(req);
  if (!driverId) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const supa = getSupa();

    // Récupère le driver_site (source unique de vérité — aligné au site public)
    const { data: site } = await supa
      .from('driver_sites')
      .select('*')
      .eq('driver_id', driverId)
      .eq('is_active', true)
      .maybeSingle();

    if (!site) {
      return res.status(400).json({
        error: 'Active ton site FOREAS avant de générer une plaquette',
      });
    }

    // URL publique même que le site — la plaquette pointe dessus via QR
    const siteUrl = `https://foreas.xyz/${site.slug}`;

    const html = renderPlaquetteHtml(site, { siteUrl });

    // Trace dans Supabase (analytics + historique)
    const nowISO = new Date().toISOString();
    const { data: inserted } = await supa
      .from('pieuvre_plaquettes')
      .insert({
        driver_id: driverId,
        style: 'aligned-site',
        status: 'ready',
        payload: { siteSlug: site.slug, siteUrl },
        requested_at: nowISO,
      })
      .select('id')
      .maybeSingle();

    return res.json({
      status: 'ready',
      id: inserted?.id || null,
      siteUrl,
      url: siteUrl, // v1.10.51 — alias pour compat front (AtelierCommercial attend data.url)
      html,
      message:
        'Plaquette générée. Flashe le QR pour atterrir sur ton site. Envoi WhatsApp dispo après scan initial.',
    });
  } catch (err: any) {
    console.error('[plaquette] error', err?.message);
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/pieuvre/plaquette/preview/:slug
// Renvoie l'HTML de la plaquette directement (preview navigateur sans auth).
// Utile pour : preview app-side, tests, print-to-PDF côté driver.
// Le JWT driver check est conservé sur POST ; ce GET lit juste un site public.
// ════════════════════════════════════════════════════════════════════════

router.get('/plaquette/preview/:slug', async (req: Request, res: Response) => {
  const { slug } = req.params;
  try {
    const supa = getSupa();
    const { data: site } = await supa
      .from('driver_sites')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle();

    if (!site) {
      return res.status(404).send('<h1>Plaquette introuvable</h1>');
    }
    const siteUrl = `https://foreas.xyz/${site.slug}`;
    const html = renderPlaquetteHtml(site, { siteUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    return res.send(html);
  } catch (err: any) {
    return res.status(500).send(`<p>Erreur : ${err?.message}</p>`);
  }
});

export default router;
