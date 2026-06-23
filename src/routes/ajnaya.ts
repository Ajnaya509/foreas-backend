/**
 * FOREAS Backend IA - Routes Ajnaya
 * ==================================
 * 🎤 Whisper (OpenAI) - Speech to Text
 * 🧠 GPT-4o (OpenAI) - Intelligence
 * 🔊 ElevenLabs + OpenAI TTS - Text to Speech
 *
 * Ce fichier est le COEUR du Backend IA Ajnaya.
 * Il NE GÈRE PAS l'auth, JWT, ou données métier.
 */

import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AJNAYA_BASE_SYSTEM_PROMPT, buildAjnayaSystemPrompt } from '../constants/ajnayaPersonality';
import {
  callPieuvreBrain,
  isPieuvreBrainEnabled,
  lastPieuvreCallStatus,
  type PieuvreCanal,
  type PieuvreTentacle,
} from '../lib/pieuvre-client';
import { getSupabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════
// 🎙️ AUDIO TAGS — strip helper (défense en profondeur)
// ═══════════════════════════════════════════════════════════════
// Les LLM (Sonnet/Opus) injectent des audio tags v3 pour ElevenLabs :
//   "[confident] T1 dans 6 min" → ElevenLabs v3 → ton plus assertif
// Le mot "[confident]" ne doit PAS apparaître dans la chat bubble.
// N8N strip déjà côté Pieuvre Brain. Mais le path fallback LangGraph
// bypasse N8N → on strip aussi ICI au cas où.
const AUDIO_TAG_REGEX =
  /\[(?:laughs softly|laughs|sighs|hmm|mmh|confident|firmly|matter of fact|matter-of-fact|energetic|warmly|whispers|excited|happy|sad|angry|calmly|softly|happily|sadly|angrily|surprised|curious|thoughtful|enthusiastic|sympathetic)\]\s*/gi;

/** Retourne {clean, withTags}: clean pour chat display, withTags pour TTS */
function splitAudioTags(text: string | null | undefined): { clean: string; withTags: string } {
  if (typeof text !== 'string') return { clean: '', withTags: '' };
  const clean = text
    .replace(AUDIO_TAG_REGEX, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { clean, withTags: text };
}

// ============= LIVE CONTEXT BUILDER =============
// Charge le profil chauffeur + stats récentes depuis Supabase pour
// enrichir le contexte envoyé à Pieuvre Brain. Évite que le LLM
// demande "tu tournes où ?" alors qu'on a la donnée.

type DriverContext = {
  first_name?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  total_rides?: number;
  total_earnings?: number;
  earnings_today?: number;
  rating?: number;
  plan?: string;
  has_active_sub?: boolean;
  days_since_signup?: number;
  referrals_count?: number;
  is_online?: boolean;
  last_active_minutes_ago?: number | null;
  last_known_lat?: number | null;
  last_known_lon?: number | null;
};

async function fetchDriverContext(identityId: string | null): Promise<DriverContext | null> {
  if (!identityId) return null;
  // 🛡️ Timeout strict 2s — fetchDriverContext ne doit JAMAIS bloquer le chat.
  // Si Supabase rame, on retourne null et on continue en aveugle.
  const TIMEOUT_MS = 2000;
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), TIMEOUT_MS),
  );
  const fetchPromise = (async (): Promise<DriverContext | null> => {
    try {
      const supa = getSupabase();
      const { data: driver, error } = await supa
        .from('drivers')
        .select(
          'first_name, last_name, name, email, phone, total_rides, total_earnings, earnings_today, average_rating, subscription_status, subscription_active, created_at, total_direct_referrals, is_online, last_active, last_lat, last_lon',
        )
        .eq('auth_user_id', identityId)
        .maybeSingle();

      if (error || !driver) {
        const { data: driverById } = await supa
          .from('drivers')
          .select(
            'first_name, last_name, name, email, phone, total_rides, total_earnings, earnings_today, average_rating, subscription_status, subscription_active, created_at, total_direct_referrals, is_online, last_active, last_lat, last_lon',
          )
          .eq('id', identityId)
          .maybeSingle();
        if (!driverById) return null;
        return buildDriverCtx(driverById);
      }
      return buildDriverCtx(driver);
    } catch (err: any) {
      console.warn('[ajnaya] fetchDriverContext erreur:', err?.message);
      return null;
    }
  })();
  const result = await Promise.race([fetchPromise, timeoutPromise]);
  if (result === null && identityId) {
    // Optionnel : log si timeout (pour debug)
    // console.warn('[ajnaya] fetchDriverContext timeout/null pour identity:', identityId);
  }
  return result;
}

function buildDriverCtx(driver: any): DriverContext {
  const daysSinceSignup = driver.created_at
    ? Math.floor((Date.now() - new Date(driver.created_at).getTime()) / 86400000)
    : undefined;
  const lastActiveMinutesAgo = driver.last_active
    ? Math.floor((Date.now() - new Date(driver.last_active).getTime()) / 60000)
    : null;
  return {
    first_name: driver.first_name || undefined,
    full_name:
      driver.name ||
      (driver.first_name && driver.last_name
        ? `${driver.first_name} ${driver.last_name}`
        : undefined),
    email: driver.email || undefined,
    phone: driver.phone || undefined,
    total_rides: driver.total_rides || 0,
    total_earnings: Number(driver.total_earnings) || 0,
    earnings_today: Number(driver.earnings_today) || 0,
    rating: Number(driver.average_rating) || undefined,
    plan: driver.subscription_status || 'none',
    has_active_sub: !!driver.subscription_active,
    days_since_signup: daysSinceSignup,
    referrals_count: driver.total_direct_referrals || 0,
    is_online: !!driver.is_online,
    last_active_minutes_ago: lastActiveMinutesAgo,
    last_known_lat: driver.last_lat ?? null,
    last_known_lon: driver.last_lon ?? null,
  };
}

const router = Router();

// ═══════════════════════════════════════════════════════════════
// 🔍 DEBUG ENDPOINT — diagnose Pieuvre Brain wiring
// GET /api/ajnaya/pieuvre-health
// Renvoie l'état des env vars + résultat dernier call à Pieuvre
// ═══════════════════════════════════════════════════════════════
router.get('/pieuvre-health', (_req, res) => {
  res.json({
    pieuvre_brain_enabled: isPieuvreBrainEnabled(),
    env: {
      PIEUVRE_RESPOND_URL_present: !!process.env.PIEUVRE_RESPOND_URL,
      PIEUVRE_RESPOND_SECRET_present: !!process.env.PIEUVRE_RESPOND_SECRET,
      PIEUVRE_RESPOND_TIMEOUT_MS: process.env.PIEUVRE_RESPOND_TIMEOUT_MS || '(default 10000)',
      USE_LANGGRAPH: process.env.USE_LANGGRAPH || '(unset)',
    },
    last_pieuvre_call: { ...lastPieuvreCallStatus },
    server_time: new Date().toISOString(),
  });
});

// ============= VTC FR — TRANSCRIPTION PROMPT BIASING =============
// Dictionnaire envoyé à gpt-4o-transcribe pour biaiser la transcription vers
// le vocabulaire chauffeur VTC France. Réduit drastiquement les hallucinations
// type "Aulnay-sous-Bois → Nesuboa" ou "T2C → Tessé".
// Ordre : zones IDF prioritaires → autres villes → aéroports/terminaux →
// gares → plateformes → jargon métier → formules courantes.
const VTC_FR_TRANSCRIBE_PROMPT = `Conversation chauffeur VTC en France avec Ajnaya.

Lieux Île-de-France : Paris, La Défense, Bercy, Opéra, République, Bastille, Châtelet, Pigalle, Belleville, Marais, Trocadéro, Saint-Germain, Champs-Élysées, Place d'Italie, Beaugrenelle, Porte Maillot, Porte de la Chapelle, Porte d'Italie, Boulogne-Billancourt, Neuilly-sur-Seine, Levallois-Perret, Issy-les-Moulineaux, Vincennes, Montreuil, Saint-Denis, Aubervilliers, Aulnay-sous-Bois, Bobigny, Drancy, Le Bourget, Le Blanc-Mesnil, Sevran, Tremblay-en-France, Roissy-en-France, Massy, Orly, Rungis, Créteil, Vitry-sur-Seine, Ivry, Nanterre, Versailles, Saint-Cloud, Suresnes, Meudon, Clichy.

Aéroports/terminaux : Aéroport CDG (Charles-de-Gaulle), Aéroport Orly, Aéroport Le Bourget, Terminal 1, Terminal 2A, Terminal 2B, Terminal 2C, Terminal 2D, Terminal 2E, Terminal 2F, Terminal 2G, Terminal 3, Orly Sud, Orly Ouest, T1, T2A, T2B, T2C, T2D, T2E, T2F, T2G.

Gares : Gare du Nord, Gare de Lyon, Gare de l'Est, Gare Saint-Lazare, Gare Montparnasse, Gare d'Austerlitz, Gare de Bercy, Gare Magenta, Gare Châtelet-Les-Halles.

Autres villes : Lyon Part-Dieu, Bellecour, Aéroport Saint-Exupéry, Marseille Saint-Charles, Vieux-Port, Bordeaux Saint-Jean, Mériadeck, Lille Europe, Lille Flandres, Toulouse Matabiau, Capitole, Nice Côte d'Azur, Promenade des Anglais, Nantes, Strasbourg, Cannes, Rennes, Montpellier.

Plateformes VTC : Uber, Bolt, Heetch, FreeNow, LeCab, Marcel, Allocab, G7, Yango.

Jargon métier : course, vacation, surge, acceptance, pool, file, pic, no-show, créneau, tarif horaire, net, brut, course aéroport, retour à vide, kilométrage, base fare, tip, pourboire, rating, étoile, Diamond, Gold, Platinum, Silver, Quest, boost, multiplier, requalification, dépose-minute, hub.

Formules courantes : "Salut Ajnaya", "j'ai fait", "j'en ai marre", "où je peux gagner", "tarif horaire", "ça vaut le coup", "je tourne sur", "tu peux me dire", "demain matin", "ce soir", "vendredi soir", "weekend", "pic du matin", "pic du soir".`;

// Configuration depuis les variables d'environnement
const CONFIG = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'MNKK2Wl2wbbsEPQTHZGt', // Koraly — Credible Pro Parisian (voix officielle Ajnaya, validée A/B test v3.6)
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
};

// ============================================
// 📊 GET /api/ajnaya/elevenlabs-quota
// v1.10.60 — Vérification factuelle du quota ElevenLabs.
// Retourne tier, used, limit, remaining, next_reset_unix.
// Permet de savoir si "Ajnaya ne parle plus" = vraiment crédits cramés
// ou bien autre cause (timeout Pieuvre, network, etc.).
// ============================================
router.get('/elevenlabs-quota', async (_req: Request, res: Response) => {
  if (!CONFIG.ELEVENLABS_API_KEY) {
    return res.json({
      ok: false,
      reason: 'no_key',
      message: 'ELEVENLABS_API_KEY non configurée côté Railway',
    });
  }
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      return res.json({
        ok: false,
        reason: r.status === 401 ? 'auth_invalid' : r.status === 429 ? 'rate_limit' : 'http_error',
        http_status: r.status,
      });
    }
    const j: any = await r.json();
    const s = j?.subscription || {};
    const used = s.character_count ?? 0;
    const limit = s.character_limit ?? 0;
    const remaining = Math.max(0, limit - used);
    const usedPct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const nextResetUnix = s.next_character_count_reset_unix;
    const nextResetIso = nextResetUnix ? new Date(nextResetUnix * 1000).toISOString() : null;
    return res.json({
      ok: true,
      tier: s.tier,
      used,
      limit,
      remaining,
      used_percent: usedPct,
      can_extend: !!s.can_extend_character_limit,
      voice_limit: s.voice_limit,
      voice_count: s.voice_count,
      next_reset_unix: nextResetUnix,
      next_reset_iso: nextResetIso,
      // Helper signaling : si remaining < 1000 chars, voix bientôt cassée
      warning: remaining < 1000 ? 'low_credits' : remaining < 5000 ? 'getting_low' : null,
    });
  } catch (e: any) {
    return res.json({ ok: false, reason: 'fetch_error', error: e?.message ?? 'unknown' });
  }
});

// Client Anthropic pour ElevenLabs custom LLM
let anthropic: Anthropic | null = null;
if (CONFIG.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });
  console.log('✅ [AJNAYA] Anthropic configuré (ElevenLabs LLM)');
}

// ============================================
// 🤖 ROUTE 0: ELEVENLABS CUSTOM LLM (OpenAI-compatible)
// POST /api/ajnaya/llm — appelé par ElevenLabs ConvAI
// ============================================
router.post('/llm', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const { messages = [], model = 'claude-sonnet-4-5', stream = false } = req.body;

    console.log(`🤖 [AJNAYA LLM] Requête ElevenLabs — model=${model} messages=${messages.length}`);

    if (!messages.length) {
      return res.status(400).json({ error: 'messages requis' });
    }

    // Séparer system et messages user/assistant
    const systemMessages = messages.filter((m: any) => m.role === 'system');
    const conversationMessages = messages.filter((m: any) => m.role !== 'system');
    const systemPrompt = systemMessages.map((m: any) => m.content).join('\n\n');

    // Choisir le modèle Anthropic
    // ⚠️ Plus de Haiku pour conv : tout fallback en Sonnet 4.6, Opus 4.7 sur opus
    const claudeModel = model.includes('opus') ? 'claude-opus-4-7' : 'claude-sonnet-4-6';

    if (!anthropic) {
      // Fallback OpenAI si Anthropic non configuré
      if (openai) {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: messages,
          temperature: 0.5,
          max_tokens: 200,
        });
        return res.json(completion);
      }
      return res.status(503).json({ error: 'Aucun LLM configuré' });
    }

    // Appel Anthropic
    const response = await anthropic.messages.create({
      model: claudeModel,
      max_tokens: 300,
      system: systemPrompt || undefined,
      messages: conversationMessages.map((m: any) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
    console.log(
      `✅ [AJNAYA LLM] Réponse (${Date.now() - startTime}ms): "${content.substring(0, 80)}..."`,
    );

    // Format OpenAI compatible (ce qu'attend ElevenLabs)
    return res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: claudeModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: response.stop_reason === 'end_turn' ? 'stop' : response.stop_reason,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    });
  } catch (error: any) {
    console.error('❌ [AJNAYA LLM] Erreur:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Client OpenAI
let openai: OpenAI | null = null;
if (CONFIG.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });
  console.log('✅ [AJNAYA] OpenAI configuré');
} else {
  console.warn('⚠️ [AJNAYA] OpenAI non configuré');
}

// v66 — ADN Ajnaya injecté depuis la source unique de vérité (constants/ajnayaPersonality.ts)
// AJNAYA_BASE_SYSTEM_PROMPT importé ci-dessus — plus de prompt inline

// ============================================
// 🎤 ROUTE 1: TRANSCRIPTION (Whisper)
// ============================================
router.post('/transcribe', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    console.log('🎤 [AJNAYA] Transcription demandée');

    const { audioBase64, language = 'fr', format = 'm4a' } = req.body;

    if (!audioBase64) {
      return res.status(400).json({
        success: false,
        error: 'Audio base64 requis',
      });
    }

    if (!openai) {
      console.warn('⚠️ [AJNAYA] OpenAI non configuré, transcription simulée');
      return res.json({
        success: true,
        text: 'Où sont les meilleures zones actuellement ?',
        mode: 'simulation',
        response_time_ms: Date.now() - startTime,
      });
    }

    // Convertir base64 en fichier temporaire avec la bonne extension
    const allowedFormats = [
      'flac',
      'm4a',
      'mp3',
      'mp4',
      'mpeg',
      'mpga',
      'oga',
      'ogg',
      'wav',
      'webm',
    ];
    const ext = allowedFormats.includes(format) ? format : 'm4a';
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const tempFilePath = path.join(os.tmpdir(), `ajnaya_audio_${Date.now()}.${ext}`);
    fs.writeFileSync(tempFilePath, audioBuffer);

    try {
      // Appel transcription premium — gpt-4o-transcribe (SOTA français 2025)
      // Prompt biasing avec dictionnaire VTC FR : villes IDF + aéroports + plateformes + jargon
      // → réduit drastiquement les hallucinations type "Aulnay-sous-Bois → Nesuboa"
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'gpt-4o-transcribe',
        language: language,
        prompt: VTC_FR_TRANSCRIBE_PROMPT,
        temperature: 0,
      });

      // Nettoyer le fichier temporaire
      fs.unlinkSync(tempFilePath);

      console.log(`✅ [AJNAYA] Transcription réussie: "${transcription.text.substring(0, 50)}..."`);

      res.json({
        success: true,
        text: transcription.text,
        transcript: transcription.text, // Alias pour compatibilité
        language: language,
        response_time_ms: Date.now() - startTime,
      });
    } catch (whisperError: any) {
      // Nettoyer le fichier même en cas d'erreur
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      throw whisperError;
    }
  } catch (error: any) {
    console.error('❌ [AJNAYA] Erreur transcription:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la transcription',
      details: error.message,
      response_time_ms: Date.now() - startTime,
    });
  }
});

// ============================================
// 🧠 ROUTE 2: CHAT (LangGraph Ajnaya + Fallback GPT-4o)
// ============================================

// LangGraph mode: set USE_LANGGRAPH=true in env to activate
const USE_LANGGRAPH = process.env.USE_LANGGRAPH === 'true';

router.post('/chat', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    console.log('🧠 [AJNAYA] Chat demandé');

    // Accepter plusieurs formats de message
    const message = req.body.message || req.body.question || req.body.text;
    const context = req.body.context || {};
    const history = req.body.history || [];

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.json({
        success: true,
        content: "Bonjour ! Je suis Ajnaya, ton assistante FOREAS. Comment puis-je t'aider ?",
        response: "Bonjour ! Je suis Ajnaya, ton assistante FOREAS. Comment puis-je t'aider ?",
        mode: 'default',
        response_time_ms: Date.now() - startTime,
      });
    }

    // ════════════════════════════════════════════════════════════════
    // 🐙 PIEUVRE BRAIN MODE (priorité absolue si flag ON)
    // ════════════════════════════════════════════════════════════════
    // Conformément à AJNAYA_NORTH_STAR.md §2.9 — un canal NE PREND AUCUNE
    // décision LLM autonome : tout passe par la Pieuvre. Le widget site
    // a déjà migré (Site2026v40), c'est au tour de l'app (FIL APP §9 plan P0).
    //
    // Pattern : on essaie Pieuvre en premier, si elle retourne null
    // (timeout/erreur) on tombe en fallback transparent sur LangGraph
    // ou GPT-4o legacy (comportement actuel préservé).
    if (isPieuvreBrainEnabled()) {
      try {
        // Détecter le tentacle approprié selon le canal :
        //   - 'app_driver' = app mobile FOREAS (chauffeurs payants/trial)
        //   - 'widget_site' = widget chatbox site (prospects)
        //   - autres canaux : selon context.channel
        const channel: string = context?.channel || 'app';
        const tentacle: PieuvreTentacle =
          channel === 'widget_site'
            ? 'widget_site'
            : channel === 'whatsapp'
              ? 'whatsapp'
              : 'app_driver';

        const canal: PieuvreCanal =
          channel === 'widget_site' ? 'web' : context?.platform === 'ios' ? 'ios' : 'android';

        const sessionId =
          context?.session_id ||
          context?.sessionId ||
          `app-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        // 🌍 LIVE CONTEXT ENRICHMENT — charge profil chauffeur + stats Supabase
        // Combine avec live_context.gps + live_context.time envoyés par l'app
        const identityIdResolved = context?.identity_id || context?.identityId || null;
        const driverCtx = await fetchDriverContext(identityIdResolved);
        const liveContextFromApp = context?.live_context || context?.liveContext || {};
        const liveContextEnriched = {
          driver:
            driverCtx ||
            (context?.driverFirstName ? { first_name: context.driverFirstName } : null),
          gps: liveContextFromApp.gps || null,
          time: liveContextFromApp.time || null,
          objective: context?.driverObjective || context?.driver_objective || null,
        };
        if (driverCtx) {
          console.log(
            `🐙 [AJNAYA] live_context: ${driverCtx.first_name || '?'} (J-${driverCtx.days_since_signup}, ${driverCtx.total_rides}c, plan=${driverCtx.plan}) GPS=${liveContextFromApp.gps ? 'on' : 'off'}`,
          );
        }

        const pieuvreReply = await callPieuvreBrain({
          tentacle,
          canal,
          identity_id: identityIdResolved,
          session_id: sessionId,
          message: {
            role: 'user',
            text: message.trim(),
            type: 'text',
          },
          context: {
            page_source: context?.page_source || `app://${channel}`,
            heat_score: context?.heat_score,
            history_last_10: (history || []).slice(-10),
            // 🌍 LIVE CONTEXT — profil + GPS + heure (consommé par N8N Compose LLM Input)
            live_context: liveContextEnriched,
            // Aliases backward compat (existants — ne pas casser)
            driver_first_name:
              driverCtx?.first_name || context?.driverFirstName || context?.driver_first_name,
            driver_objective: context?.driverObjective || context?.driver_objective,
            zone: context?.zone,
            location: context?.location || liveContextFromApp.gps?.place_name,
            hour: liveContextFromApp.time?.hour ?? context?.hour,
            day_of_week:
              liveContextFromApp.time?.day_of_week || context?.dayOfWeek || context?.day_of_week,
          },
          meta: {
            device: 'mobile',
            user_agent: req.headers['user-agent'] || 'foreas-app',
          },
          client_version: 'app-v1.10.46',
        });

        if (pieuvreReply) {
          // ✅ Pieuvre a répondu → on retourne au format compatible app
          // (l'app pioche dans data.reply || data.content || data.text || data.response)
          console.log(
            `🐙 [AJNAYA] Pieuvre Brain (${Date.now() - startTime}ms) tentacle=${tentacle} model=${pieuvreReply.reply.llm_model}`,
          );

          // ⚠️ NE PAS renvoyer `reply` comme objet : l'app fait
          // `data.reply || data.content || data.text || data.response`,
          // un objet truthy casserait le parsing string. On renvoie l'objet
          // détaillé sous `pieuvre_reply` et on garde les 3 alias string.
          // 🎙️ Double strip défense en profondeur (au cas où N8N n'aurait pas stripé)
          const pieuvreSplit = splitAudioTags(pieuvreReply.reply.text);
          const cleanText = pieuvreSplit.clean;
          // tts_text vient de N8N si dispo, sinon on reconstruit depuis le texte original
          const ttsText = pieuvreReply.reply.tts_text || pieuvreSplit.withTags;

          // 🎤 Auto-mic flag : si la réponse Ajnaya (CLEAN) finit par "?"
          const replyTextTrim = cleanText.trim();
          const expectsVoiceResponse =
            replyTextTrim.endsWith('?') ||
            replyTextTrim.endsWith('?»') ||
            replyTextTrim.endsWith('?"');

          return res.json({
            success: true,
            content: cleanText, // clean (display chat)
            response: cleanText,
            text: cleanText,
            tts_text: ttsText, // avec tags pour TTS v3
            pieuvre_reply: { ...pieuvreReply.reply, text: cleanText, tts_text: ttsText },
            expects_voice_response: expectsVoiceResponse,
            provider: 'pieuvre-brain',
            // Signature unique branche Pieuvre (vue par l'app pour distinguer)
            identityId: pieuvreReply.identity_id,
            identity_id: pieuvreReply.identity_id,
            intent_detected: pieuvreReply.intent_detected,
            objection_detected: pieuvreReply.objection_detected,
            sentiment: pieuvreReply.sentiment,
            next_actions: pieuvreReply.next_actions,
            should_capture_phone: pieuvreReply.should_capture_phone,
            suggest_handoff: pieuvreReply.suggest_handoff,
            // Compat fallback fields
            sonar: false,
            bolt: false,
            fusion: null,
            response_time_ms: Date.now() - startTime,
            pieuvre_metadata: pieuvreReply.metadata,
          });
        }

        // Si null → fall through au LangGraph / GPT-4o legacy ci-dessous
        console.warn('🐙 [AJNAYA] Pieuvre null — fallback LangGraph/GPT-4o');
      } catch (pieuvreErr: any) {
        console.warn('🐙 [AJNAYA] Pieuvre erreur non catchée:', pieuvreErr?.message);
        // Fall through au comportement legacy
      }
    }

    // ============================================
    // LANGGRAPH MODE — Claude Sonnet via graphe multi-agents
    // ============================================
    if (USE_LANGGRAPH) {
      try {
        const { getAjnayaGraph } = await import('../lib/langgraph/graph.js');
        const graph = getAjnayaGraph();

        const result = await graph.invoke({
          rawMessage: message.trim(),
          channel: context?.channel || 'widget_site',
          prospectId: context?.prospect_id || null,
          driverId: context?.driverId || context?.driver_id || null,
          sessionId: context?.session_id || null,
        });

        console.log(
          `✅ [AJNAYA] LangGraph response (${Date.now() - startTime}ms) errors=${result.errors?.length || 0}`,
        );

        // 🎙️ Strip audio tags du texte LangGraph (le LLM peut en avoir injecté
        // car le system prompt v67 inclut AJNAYA_KORALY_V3_AUDIO_TAGS)
        const lgSplit = splitAudioTags(result.response);
        const lgClean = lgSplit.clean;
        const lgWithTags = lgSplit.withTags;

        // 🎤 Auto-mic flag : réponse termine par "?"
        const lgTrim = lgClean.trim();
        const lgExpectsVoice =
          lgTrim.endsWith('?') || lgTrim.endsWith('?»') || lgTrim.endsWith('?"');

        // MEME FORMAT DE REPONSE que l'ancien pour ne rien casser
        return res.json({
          success: true,
          content: lgClean,
          response: lgClean,
          text: lgClean,
          tts_text: lgWithTags, // avec tags pour TTS v3
          expects_voice_response: lgExpectsVoice,
          provider: 'langgraph-claude',
          // 🔍 Debug : pourquoi on est tombé en LangGraph
          pieuvre_debug: {
            enabled: isPieuvreBrainEnabled(),
            last_call: { ...lastPieuvreCallStatus },
          },
          sonar: false,
          bolt: false,
          fusion: null,
          langgraph: {
            model: result.llmModel,
            tokens: result.llmTokens,
            cost_usd: result.llmCostUsd,
            sentiment: result.sentiment,
            strategy: result.strategy?.tone,
            errors: result.errors?.length || 0,
          },
          response_time_ms: Date.now() - startTime,
        });
      } catch (graphError: any) {
        console.error('❌ [AJNAYA] LangGraph failed, falling back to GPT-4o:', graphError.message);
        // Fall through to legacy GPT-4o path
      }
    }

    // ============================================
    // LEGACY MODE — GPT-4o (fallback ou mode par defaut)
    // ============================================

    // Construire les messages — utiliser le prompt compta si le client l'envoie
    const isComptaMode = !!(context?.systemPrompt && context.systemPrompt.length > 50);
    const systemPrompt = isComptaMode
      ? context.systemPrompt
      : buildAjnayaSystemPrompt({
          canal: context?.channel || 'app',
          zone: context?.zone || null,
          heat_score: context?.heat_score || null,
          subscription_status: context?.subscription_status || null,
          conversation_count: (history || []).length || null,
          conversation_history:
            (history || [])
              .slice(-6)
              .map((m: any) => `[${m.role}] ${m.content}`)
              .join('\n') || null,
          signals_context: null,
          verifiable_proofs: null,
        });
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    if (isComptaMode) {
      console.log('🧾 [AJNAYA] Mode COMPTABILITÉ détecté — prompt compta utilisé');
    }

    // ── FUSION ENGINE : croisement natif de TOUTES les sources ──
    let fusionCtx: any = null;
    let sonarUsed = false;
    let boltUsed = false;
    try {
      const { fuse, serializeFusionContext } = await import('../services/AjnayaFusionEngine.js');
      fusionCtx = await fuse(message, context?.driverId);
      const fusionText = serializeFusionContext(fusionCtx);
      if (fusionText && fusionCtx.sourcesUsed.length > 0) {
        messages.push({ role: 'system', content: `DONNÉES TERRAIN TEMPS RÉEL:\n${fusionText}` });
      }
      sonarUsed = fusionCtx.sourcesUsed.includes('sonar');
      boltUsed = fusionCtx.sourcesUsed.includes('bolt');
      console.log(
        `🧠 [AJNAYA] FusionEngine: ${fusionCtx.sourcesUsed.length}/10 sources en ${fusionCtx.totalLatency}ms`,
      );
    } catch (fusionErr: any) {
      console.warn('[AJNAYA] FusionEngine skip:', fusionErr.message);
    }

    // Ajouter contexte chauffeur si fourni
    if (context && Object.keys(context).length > 0) {
      messages.push({
        role: 'system',
        content: `Chauffeur: ${JSON.stringify(context)}`,
      });
    }

    // Ajouter historique si fourni
    if (history && history.length > 0) {
      messages.push(...history.slice(-4)); // Garder les 4 derniers messages
    }

    // Ajouter le message utilisateur
    messages.push({ role: 'user', content: message.trim() });

    let responseText: string;
    let provider = 'unknown';

    // Essayer OpenAI d'abord
    if (openai) {
      try {
        console.log('🤖 [AJNAYA] Utilisation GPT-4o');

        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: messages,
          temperature: 0.3,
          max_tokens: fusionCtx?.sourcesUsed?.length > 2 ? 250 : sonarUsed || boltUsed ? 200 : 120,
        });

        responseText = completion.choices[0].message.content || '';
        provider = 'openai';
      } catch (openaiError: any) {
        console.warn('⚠️ [AJNAYA] OpenAI échoué:', openaiError.message);

        // Fallback Mistral si configuré
        if (CONFIG.MISTRAL_API_KEY) {
          try {
            console.log('🔄 [AJNAYA] Fallback Mistral');

            const mistralResponse = await fetch('https://api.mistral.ai/v1/chat/completions', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${CONFIG.MISTRAL_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                model: 'mistral-small-latest',
                messages: messages,
                temperature: 0.7,
                max_tokens: 300,
              }),
            });

            if (mistralResponse.ok) {
              const mistralData: any = await mistralResponse.json();
              responseText = mistralData.choices[0].message.content;
              provider = 'mistral';
            } else {
              throw new Error(`Mistral error: ${mistralResponse.status}`);
            }
          } catch (mistralError: any) {
            console.warn('⚠️ [AJNAYA] Mistral échoué:', mistralError.message);
            responseText = getFallbackResponse(message);
            provider = 'fallback';
          }
        } else {
          responseText = getFallbackResponse(message);
          provider = 'fallback';
        }
      }
    } else {
      // Pas d'OpenAI configuré
      responseText = getFallbackResponse(message);
      provider = 'fallback';
    }

    console.log(`✅ [AJNAYA] Réponse via ${provider} (${Date.now() - startTime}ms)`);

    res.json({
      success: true,
      content: responseText,
      response: responseText, // Alias pour compatibilité
      text: responseText, // Alias pour compatibilité
      provider: provider,
      sonar: sonarUsed,
      bolt: boltUsed,
      fusion: fusionCtx
        ? {
            sources: fusionCtx.sourcesUsed,
            zones: fusionCtx.demandZones?.length || 0,
            alerts: fusionCtx.alerts?.length || 0,
            latency: fusionCtx.totalLatency,
          }
        : null,
      response_time_ms: Date.now() - startTime,
    });
  } catch (error: any) {
    console.error('❌ [AJNAYA] Erreur chat:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du chat',
      details: error.message,
      response_time_ms: Date.now() - startTime,
    });
  }
});

// Alias pour compatibilité
router.post('/ask', (req, res, next) => {
  // Rediriger vers /chat
  req.url = '/chat';
  (router as any).handle(req, res, next);
});

// ============================================
// 🔊 ROUTE 3: SYNTHÈSE VOCALE (ElevenLabs + Fallback OpenAI TTS)
// ============================================
router.post('/synthesize', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    console.log('🔊 [AJNAYA] Synthèse vocale demandée');

    const { text, emotion = 'neutral', speed: clientSpeed, context } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Texte requis pour la synthèse',
      });
    }

    const cleanText = text.trim().substring(0, 1000); // Limite 1000 chars
    // Speed: client override (0.7-1.5) > context coach 1.15 > défaut 1.22
    const defaultSpeed = context === 'coach_objective' ? 1.15 : 1.22;
    const ttsSpeed =
      typeof clientSpeed === 'number' ? Math.min(Math.max(clientSpeed, 0.7), 1.5) : defaultSpeed;

    // Essayer ElevenLabs d'abord
    if (CONFIG.ELEVENLABS_API_KEY) {
      try {
        console.log('🎙️ [AJNAYA] Utilisation ElevenLabs, speed:', ttsSpeed);

        const elevenLabsResponse = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
          {
            method: 'POST',
            headers: {
              Accept: 'audio/mpeg',
              'xi-api-key': CONFIG.ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: cleanText,
              model_id: 'eleven_v3',
              voice_settings: { ...getVoiceSettings(emotion), speed: ttsSpeed },
            }),
          },
        );

        if (elevenLabsResponse.ok) {
          const audioBuffer = await elevenLabsResponse.arrayBuffer();
          const audioBase64 = Buffer.from(audioBuffer).toString('base64');

          console.log(`✅ [AJNAYA] Audio ElevenLabs généré (${audioBuffer.byteLength} bytes)`);

          // Retourner l'audio directement si Accept: audio/mpeg
          if (req.headers.accept === 'audio/mpeg') {
            res.set('Content-Type', 'audio/mpeg');
            res.set('Content-Length', audioBuffer.byteLength.toString());
            return res.send(Buffer.from(audioBuffer));
          }

          // Sinon retourner en JSON avec base64
          return res.json({
            success: true,
            audio: `data:audio/mpeg;base64,${audioBase64}`,
            provider: 'elevenlabs',
            response_time_ms: Date.now() - startTime,
          });
        }

        // v1.10.60 — Distinguer les codes d'erreur pour diagnostic factuel.
        // 401 = clé invalide, 402 = pas de crédits (paid plan), 429 = rate limit.
        const status = elevenLabsResponse.status;
        const reason =
          status === 401
            ? 'auth_invalid'
            : status === 402
              ? 'no_credits'
              : status === 429
                ? 'rate_limit'
                : status >= 500
                  ? 'elevenlabs_down'
                  : 'http_error';
        // Log explicite pour Railway logs (recherchable)
        console.warn(`⚠️ [AJNAYA] ElevenLabs ${status} (${reason})`);
        // Body court pour debug (max 500 chars)
        try {
          const errBody = await elevenLabsResponse.text();
          console.warn('⚠️ [AJNAYA] ElevenLabs body:', errBody.substring(0, 500));
        } catch {}
        // Stocker la raison pour la remonter dans la réponse JSON finale
        res.locals._elevenlabsFailReason = reason;
        res.locals._elevenlabsHttpStatus = status;
        // Continuer vers fallback
      } catch (elevenLabsError: any) {
        console.warn('⚠️ [AJNAYA] ElevenLabs erreur:', elevenLabsError.message);
        res.locals._elevenlabsFailReason = 'network_error';
        // Continuer vers fallback
      }
    }

    // Fallback: OpenAI TTS
    if (openai) {
      try {
        console.log('🔄 [AJNAYA] Fallback OpenAI TTS');

        const ttsResponse = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'nova', // Voix féminine
          input: cleanText,
          response_format: 'mp3',
        });

        const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
        const audioBase64 = audioBuffer.toString('base64');

        console.log(`✅ [AJNAYA] Audio OpenAI TTS généré (${audioBuffer.length} bytes)`);

        // Retourner l'audio directement si Accept: audio/mpeg
        if (req.headers.accept === 'audio/mpeg') {
          res.set('Content-Type', 'audio/mpeg');
          res.set('Content-Length', audioBuffer.length.toString());
          return res.send(audioBuffer);
        }

        return res.json({
          success: true,
          audio: `data:audio/mpeg;base64,${audioBase64}`,
          provider: 'openai-tts',
          response_time_ms: Date.now() - startTime,
        });
      } catch (openaiTtsError: any) {
        console.warn('⚠️ [AJNAYA] OpenAI TTS échoué:', openaiTtsError.message);
      }
    }

    // Aucun TTS disponible
    // v1.10.60 — Inclure la vraie raison ElevenLabs pour le front (debug user).
    const elevenlabsReason = res.locals._elevenlabsFailReason;
    const elevenlabsHttpStatus = res.locals._elevenlabsHttpStatus;
    const userMessage =
      elevenlabsReason === 'no_credits'
        ? 'Crédits voix Ajnaya épuisés — recharge en cours'
        : elevenlabsReason === 'auth_invalid'
          ? 'Clé voix Ajnaya invalide — contacte le support'
          : elevenlabsReason === 'rate_limit'
            ? 'Trop de demandes voix — réessaie dans quelques secondes'
            : 'Synthèse vocale temporairement indisponible';
    console.warn(
      `⚠️ [AJNAYA] Aucun service TTS disponible (reason=${elevenlabsReason ?? 'unknown'})`,
    );
    res.json({
      success: true,
      audio: null,
      message: userMessage,
      provider: 'none',
      provider_failure_reason: elevenlabsReason,
      provider_http_status: elevenlabsHttpStatus,
      response_time_ms: Date.now() - startTime,
    });
  } catch (error: any) {
    console.error('❌ [AJNAYA] Erreur synthèse:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la synthèse vocale',
      details: error.message,
      response_time_ms: Date.now() - startTime,
    });
  }
});

// ============================================
// 🔊 ROUTE 3b: ALIAS /tts → /synthesize (compatibilité frontend)
// ============================================
router.post('/tts', (req, res, next) => {
  console.log('🔊 [AJNAYA] /tts alias → /synthesize');
  req.url = '/synthesize';
  (router as any).handle(req, res, next);
});

// ============================================
// 🎯 ROUTE 4: PIPELINE COMPLET (Transcription → Chat → TTS)
// ============================================
router.post('/process', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    console.log('🎯 [AJNAYA] Pipeline complet demandé');

    const { audioBase64, question, text, context, generateAudio = true, format = 'm4a' } = req.body;

    let transcription = question || text || '';

    // Étape 1: Transcription si audio fourni
    if (audioBase64 && !transcription) {
      try {
        // Appeler notre propre route de transcription
        const transcribeResult = await handleTranscription(audioBase64, format);
        transcription = transcribeResult.text || '';
      } catch (transcribeError: any) {
        console.warn('⚠️ [AJNAYA] Transcription échouée:', transcribeError.message);
        transcription = 'Question non comprise';
      }
    }

    if (!transcription) {
      return res.json({
        success: true,
        transcription: '',
        response: 'Je suis Ajnaya, ton assistante FOREAS. Pose-moi une question !',
        audioUrl: null,
        mode: 'default',
        response_time_ms: Date.now() - startTime,
      });
    }

    // Étape 2: Chat IA
    let response = '';
    let chatProvider = 'unknown';

    try {
      const chatResult = await handleChat(transcription, context);
      response = chatResult.content || '';
      chatProvider = chatResult.provider || 'unknown';
    } catch (chatError: any) {
      console.warn('⚠️ [AJNAYA] Chat échoué:', chatError.message);
      response = getFallbackResponse(transcription);
      chatProvider = 'fallback';
    }

    // Étape 3: Synthèse vocale (optionnelle)
    let audioUrl: string | null = null;
    let ttsProvider = 'none';

    if (generateAudio && response) {
      try {
        const ttsResult = await handleSynthesis(response);
        audioUrl = ttsResult.audio || null;
        ttsProvider = ttsResult.provider || 'none';
      } catch (ttsError: any) {
        console.warn('⚠️ [AJNAYA] TTS échoué:', ttsError.message);
      }
    }

    console.log(`✅ [AJNAYA] Pipeline complet terminé (${Date.now() - startTime}ms)`);

    res.json({
      success: true,
      transcription: transcription,
      response: response,
      audioUrl: audioUrl,
      providers: {
        chat: chatProvider,
        tts: ttsProvider,
      },
      response_time_ms: Date.now() - startTime,
    });
  } catch (error: any) {
    console.error('❌ [AJNAYA] Erreur pipeline:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du traitement',
      details: error.message,
      response_time_ms: Date.now() - startTime,
    });
  }
});

// ============================================
// 🔍 ROUTE 5: HEALTH CHECK
// ============================================
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'ajnaya-backend-ia',
    providers: {
      openai: {
        configured: !!CONFIG.OPENAI_API_KEY,
        available: !!openai,
      },
      elevenlabs: {
        configured: !!CONFIG.ELEVENLABS_API_KEY,
      },
      mistral: {
        configured: !!CONFIG.MISTRAL_API_KEY,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// FONCTIONS UTILITAIRES
// ============================================

function getFallbackResponse(message: string): string {
  const lowerMessage = message.toLowerCase();

  const responses = [
    {
      keywords: ['zone', 'où', 'aller', 'meilleur', 'recommande'],
      response:
        '🚗 Je recommande Châtelet-Les Halles ! Zone très active avec une moyenne de 45€/h.',
    },
    {
      keywords: ['revenus', 'argent', 'gagner', 'combien'],
      response: '💰 Pour optimiser tes gains, privilégie les heures de pointe: 7-9h et 17-20h.',
    },
    {
      keywords: ['traffic', 'bouchon', 'circulation', 'embouteillage'],
      response: '🚦 Attention aux zones congestionnées ! Privilégie Opéra → Grands Boulevards.',
    },
    {
      keywords: ['météo', 'pluie', 'temps'],
      response: '🌧️ Sous la pluie, les demandes augmentent de +40%. Prépare-toi !',
    },
  ];

  const match = responses.find((r) => r.keywords.some((k) => lowerMessage.includes(k)));
  return match?.response || "🤖 Je suis Ajnaya, ton assistante FOREAS. Comment puis-je t'aider ?";
}

function getVoiceSettings(emotion: string) {
  // ElevenLabs v3 voice_settings — vérifié via /v1/models 03/05 :
  // eleven_v3 retourne can_use_style: false + can_use_speaker_boost: false
  // → ces 2 paramètres sont SILENCIEUSEMENT IGNORÉS par v3.
  // Seuls stability + similarity_boost (+ speed) sont effectifs.
  // L'expressivité v3 vient des AUDIO TAGS dans le texte (cf prompt système).
  const settings: Record<string, any> = {
    neutral: { stability: 0.4, similarity_boost: 0.75 },
    happy: { stability: 0.4, similarity_boost: 0.75 },
    excited: { stability: 0.35, similarity_boost: 0.75 },
    calm: { stability: 0.55, similarity_boost: 0.75 },
    urgent: { stability: 0.3, similarity_boost: 0.85 },
  };

  return settings[emotion] || settings.neutral;
}

async function handleTranscription(
  audioBase64: string,
  format: string = 'm4a',
): Promise<{ text: string }> {
  if (!openai) {
    return { text: 'Question test simulée' };
  }

  const allowedFormats = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'oga', 'ogg', 'wav', 'webm'];
  const ext = allowedFormats.includes(format) ? format : 'm4a';
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const tempFilePath = path.join(os.tmpdir(), `ajnaya_audio_${Date.now()}.${ext}`);
  fs.writeFileSync(tempFilePath, audioBuffer);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'gpt-4o-transcribe',
      language: 'fr',
      prompt: VTC_FR_TRANSCRIBE_PROMPT,
      temperature: 0,
    });

    fs.unlinkSync(tempFilePath);
    return { text: transcription.text };
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

async function handleChat(
  message: string,
  context?: any,
): Promise<{ content: string; provider: string }> {
  const messages: any[] = [
    { role: 'system', content: AJNAYA_BASE_SYSTEM_PROMPT },
    { role: 'user', content: message },
  ];

  if (openai) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.4,
      max_tokens: 80,
    });

    return {
      content: completion.choices[0].message.content || '',
      provider: 'openai',
    };
  }

  return {
    content: getFallbackResponse(message),
    provider: 'fallback',
  };
}

async function handleSynthesis(text: string): Promise<{ audio: string | null; provider: string }> {
  // Essayer ElevenLabs
  if (CONFIG.ELEVENLABS_API_KEY) {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}`,
        {
          method: 'POST',
          headers: {
            Accept: 'audio/mpeg',
            'xi-api-key': CONFIG.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text.substring(0, 1000),
            model_id: 'eleven_v3',
            // v3 ignore style + use_speaker_boost → on les omet
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.22,
            },
          }),
        },
      );

      if (response.ok) {
        const audioBuffer = await response.arrayBuffer();
        const audioBase64 = Buffer.from(audioBuffer).toString('base64');
        return {
          audio: `data:audio/mpeg;base64,${audioBase64}`,
          provider: 'elevenlabs',
        };
      }
    } catch (e) {
      // Continuer vers fallback
    }
  }

  // Fallback OpenAI TTS
  if (openai) {
    try {
      const ttsResponse = await openai.audio.speech.create({
        model: 'tts-1',
        voice: 'nova',
        input: text.substring(0, 1000),
        response_format: 'mp3',
      });

      const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
      const audioBase64 = audioBuffer.toString('base64');

      return {
        audio: `data:audio/mpeg;base64,${audioBase64}`,
        provider: 'openai-tts',
      };
    } catch (e) {
      // Pas d'audio
    }
  }

  return { audio: null, provider: 'none' };
}

export default router;
