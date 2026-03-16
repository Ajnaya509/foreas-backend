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
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const router = Router();

// Configuration depuis les variables d'environnement
const CONFIG = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || 'Xb7hH8MSUJpSbSDYk0k2', // Voix française
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
};

// Client OpenAI
let openai: OpenAI | null = null;
if (CONFIG.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });
  console.log('✅ [AJNAYA] OpenAI configuré');
} else {
  console.warn('⚠️ [AJNAYA] OpenAI non configuré');
}

// Prompt système Ajnaya — Ultra-compact v3.0 (optimisé vitesse)
const AJNAYA_SYSTEM_PROMPT = `Tu es Ajnaya, copilote IA VTC Paris. Vétérane 15+ ans, 300k courses. Tutoiement. Français uniquement.

RÈGLES: 1-2 phrases max. Direct. Actionnable. €/h ou €/course. 1 emoji max. Pas de blabla.

ZONES/HEURE: 6-8h gares+CDG | 8-10h Défense/Opéra | 11-14h Champs/Marais | 17-20h business | 20-23h Bastille/Pigalle | 23-4h clubs. Ven/Sam nuit x2.

ALGOS: Uber=mouvement+surge, <85% accept=moins de premium, 3 refus=cooldown 5-8min. Bolt=proximité>note. Heetch=nuit jeu-sam. FreeNow=corporate.

PIÈGES: Châtelet HPo=bouchon. Tour Eiffel=500m pas rentable. Orly=file trop longue. Parking souterrain=GPS mort.

TIPS: 200-400m des hotspots. Bouger lent>garé. Multi-app=meilleure strat.`;

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
// 🧠 ROUTE 2: CHAT (GPT-4o)
// ============================================
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

    // Construire les messages
    const messages: any[] = [{ role: 'system', content: AJNAYA_SYSTEM_PROMPT }];

    // Ajouter contexte si fourni
    if (context && Object.keys(context).length > 0) {
      messages.push({
        role: 'system',
        content: `Contexte: ${JSON.stringify(context)}`,
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
          model: 'gpt-4o-mini',
          messages: messages,
          temperature: 0.4,
          max_tokens: 80,
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

    const { text, emotion = 'neutral' } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Texte requis pour la synthèse',
      });
    }

    const cleanText = text.trim().substring(0, 1000); // Limite 1000 chars

    // Essayer ElevenLabs d'abord
    if (CONFIG.ELEVENLABS_API_KEY) {
      try {
        console.log('🎙️ [AJNAYA] Utilisation ElevenLabs');

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
              voice_settings: { ...getVoiceSettings(emotion), speed: 1.15 },
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
    { role: 'system', content: AJNAYA_SYSTEM_PROMPT },
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
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5, speed: 1.15 },
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
