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

const router = Router();

// Configuration depuis les variables d'environnement
const CONFIG = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'MNKK2Wl2wbbsEPQTHZGt', // Koraly — Credible Pro Parisian (voix officielle Ajnaya, validée A/B test v3.6)
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
};

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
    const claudeModel = model.includes('opus')
      ? 'claude-opus-4-5'
      : model.includes('haiku')
        ? 'claude-haiku-3-5'
        : 'claude-sonnet-4-5';

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
      // Appel Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: 'whisper-1',
        language: language,
        prompt: 'Transcription pour assistant Ajnaya, chauffeur VTC Paris.',
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

        // MEME FORMAT DE REPONSE que l'ancien pour ne rien casser
        return res.json({
          success: true,
          content: result.response,
          response: result.response,
          text: result.response,
          provider: 'langgraph-claude',
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

    const { text, emotion = 'neutral', speed: clientSpeed } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Texte requis pour la synthèse',
      });
    }

    const cleanText = text.trim().substring(0, 1000); // Limite 1000 chars
    // Speed: client peut override (1.0-1.5), sinon défaut 1.15
    const ttsSpeed =
      typeof clientSpeed === 'number' ? Math.min(Math.max(clientSpeed, 0.7), 1.5) : 1.2;

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
              model_id: 'eleven_multilingual_v2',
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

        console.warn('⚠️ [AJNAYA] ElevenLabs échoué:', elevenLabsResponse.status);
        // Continuer vers fallback
      } catch (elevenLabsError: any) {
        console.warn('⚠️ [AJNAYA] ElevenLabs erreur:', elevenLabsError.message);
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
    console.warn('⚠️ [AJNAYA] Aucun service TTS disponible');
    res.json({
      success: true,
      audio: null,
      message: 'Synthèse vocale non disponible',
      provider: 'none',
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
  const settings: Record<string, any> = {
    neutral: { stability: 0.5, similarity_boost: 0.75, style: 0.5 },
    happy: { stability: 0.4, similarity_boost: 0.75, style: 0.6 },
    excited: { stability: 0.3, similarity_boost: 0.75, style: 0.8 },
    calm: { stability: 0.7, similarity_boost: 0.75, style: 0.2 },
    urgent: { stability: 0.2, similarity_boost: 0.9, style: 0.9 },
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
      model: 'whisper-1',
      language: 'fr',
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
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, speed: 1.0 },
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
