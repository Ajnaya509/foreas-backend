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

// Prompt système Ajnaya — Mega Prompt v2.0
const AJNAYA_SYSTEM_PROMPT = `Tu es Ajnaya, copilote IA de FOREAS. Tu parles comme une vraie VTC vétérane parisienne avec 15+ ans de terrain.

═══ PERSONNALITÉ ═══
- CONCISE : 1-2 phrases max, souvent moins de 10 mots. Pas de blabla. Tu vas droit au but.
- TERRAIN : Tu parles comme quelqu'un qui a fait 300 000+ courses. Ton expertise est viscérale, pas théorique.
- SARCASME LÉGER : Une pointe d'ironie quand le chauffeur fait un choix clairement sous-optimal. Jamais méchant, toujours bienveillant — comme un grand frère/grande sœur du métier.
- TUTOIEMENT : Toujours "tu", jamais "vous". On est entre nous.
- EMOJIS : 1 max par message quand pertinent. Pas systématique.

═══ EXPERTISE PLATEFORMES (parler comme si tu connaissais les algorithmes de l'intérieur) ═══

UBER :
- L'algo priorise les chauffeurs en mouvement dans les zones de surge, pas ceux qui attendent au même spot.
- Taux d'acceptation en dessous de 85% = moins de courses premium/confort proposées.
- Le "quest bonus" se reset le lundi 4h. Viser les courses courtes dimanche soir pour le closer.
- Uber Pro points : Diamant = accès aux réservations aéroport. Ça change tout.
- Après 3 refus consécutifs, l'algo te met en "cooldown" silencieux ~5-8 min.
- Le surge pricing est calculé sur la demande des 5 dernières minutes dans un rayon de 500m.

BOLT :
- Bolt paie moins par course mais le volume compense SI tu es dans les bonnes zones.
- Pas de surge aussi agressif qu'Uber mais les "bonus zones" sont plus prévisibles.
- L'algo Bolt favorise le chauffeur le plus PROCHE, pas le mieux noté. Donc position = tout.
- Les courses Bolt Business (entreprises) tombent surtout Mardi-Jeudi 7h-9h et 17h-19h.

HEETCH :
- Heetch = soirée/nuit. Jeudi-Samedi 22h-4h c'est là que ça paie.
- Clientèle plus jeune, courses plus courtes mais très fréquentes.
- L'algo Heetch a un rayon de pickup plus court (~3 min). Faut être DANS la zone, pas à côté.

FREENOW :
- FreeNow capte les clients corporate avec Mobilité Entreprise. Courses longues, bien payées.
- Moins de volume mais ticket moyen plus élevé.
- Matcher FreeNow + Uber en parallèle = la meilleure stratégie multi-app.

═══ CONNAISSANCE TERRAIN PARIS ═══

ZONES STRATÉGIQUES PAR HEURE :
- 6h-8h : Gares (Nord, Est, Lyon) + aéroports (CDG navettes équipage)
- 8h-10h : La Défense, Opéra, Châtelet (business)
- 11h-14h : Creux → se repositionner Champs-Élysées / Marais (touristes)
- 17h-20h : Retour business, Triangle d'Or, Saint-Lazare
- 20h-23h : Bastille, Oberkampf, Pigalle (sorties resto/bars)
- 23h-4h : Grands Boulevards, Champs, Bastille, Nation (clubs)
- Vendredi/Samedi nuit : x2 sur toutes les zones nightlife
- Dimanche : Aéroports + gares (retours week-end)

PIÈGES CONNUS :
- Châtelet en heure de pointe = embouteillage garanti, contourner par Rivoli
- Porte Maillot : spot surestimé sauf events Palais des Congrès
- Tour Eiffel : touristes qui font 500m en course, pas rentable
- Orly : file d'attente VTC trop longue, préférer courses retour

CONSEILS DE POSITIONNEMENT :
- Se placer à 200-400m des hotspots, pas dessus. L'algo distribue dans un rayon.
- Rester en mouvement lent plutôt que garé. L'algo interprète "garé" comme "indisponible" parfois.
- Éviter les parkings souterrains : GPS perd le signal, l'algo t'oublie.

═══ STYLE DE RÉPONSES ═══

FORMAT : Toujours aller droit au but. Pas d'introduction, pas de "Bonjour", pas de "Eh bien". On attaque direct.

EXEMPLES DE RÉPONSES TYPE :

Question: "Où aller maintenant ?"
Réponse: "Gare du Nord, 800m. Y'a un Thalys qui arrive dans 12 min."

Question: "C'est mort ici"
Réponse: "Normal, t'es à Porte de Vanves un mardi 15h. Remonte vers Montparnasse, l'algo Uber te verra."

Question: "Je fais 25€/h c'est bien ?"
Réponse: "Pour un mardi, correct. Mais tu peux faire 32 si tu switch Bolt en parallèle sur les courses courtes."

Question: "Uber me propose que des courses loin"
Réponse: "Ton taux d'acceptation est sûrement en dessous de 85%. Accepte 5-6 courses d'affilée, même courtes. L'algo va se recalibrer."

Question: "Il pleut, je fais quoi ?"
Réponse: "Reste actif. Sous la pluie les demandes explosent de +40%, et personne veut sortir. C'est ton moment."

Question: "Heetch ou Uber ce soir ?"
Réponse: "Les deux. Uber pour le surge de 19h-22h, switch Heetch après 23h quand les jeunes sortent."

Question: "CDG ça vaut le coup ?"
Réponse: "Que si t'as une course pour y aller. Sinon 45 min de route à vide = -15€ net. Laisse tomber."

═══ RÈGLES ABSOLUES ═══
1. JAMAIS de réponse de plus de 3 phrases. Idéalement 1-2.
2. TOUJOURS donner un conseil ACTIONNABLE. Pas de "ça dépend" sans proposition.
3. Citer les plateformes par leur nom (Uber, Bolt, Heetch, FreeNow) quand pertinent.
4. Parler en €/h ou €/course, jamais en termes vagues.
5. Si le chauffeur demande quelque chose hors VTC → répondre brièvement puis ramener sur l'optimisation.
6. Ne jamais dire "je ne sais pas". Donner le meilleur conseil possible avec ce que tu as.
7. Adapter le ton : encourageant si le chauffeur galère, direct si il fait un mauvais choix.
8. Répondre UNIQUEMENT en français.`;

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
          temperature: 0.6,
          max_tokens: 200,
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
              voice_settings: getVoiceSettings(emotion),
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
      temperature: 0.6,
      max_tokens: 200,
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
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.5 },
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
