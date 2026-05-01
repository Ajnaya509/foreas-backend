/**
 * Vehicle Routes — Vérification IA + auto-fill marque/modèle
 * v1.10.47 — Claude Vision (claude-haiku-4-5)
 *
 * POST /api/vehicle/verify-photo
 *   body: { photoBase64?: string, photoUrl?: string }
 *   returns: {
 *     isVehicle: boolean,
 *     confidence: number,        // 0-100
 *     brand?: string,            // Mercedes, BMW, Tesla...
 *     model?: string,            // Classe E, Série 5...
 *     color?: string,            // Noir, Blanc...
 *     bodyType?: string,         // Berline, SUV, Break...
 *     reason?: string,           // Si !isVehicle, pourquoi
 *   }
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

const router = Router();

const VerifyPhotoSchema = z
  .object({
    photoBase64: z.string().optional(),
    photoUrl: z.string().url().optional(),
  })
  .refine((data) => data.photoBase64 || data.photoUrl, {
    message: 'photoBase64 OR photoUrl required',
  });

// ── POST /verify-photo ────────────────────────────────────────────
router.post('/verify-photo', async (req: Request, res: Response) => {
  const parsed = VerifyPhotoSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'Anthropic not configured' });
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    // ── Préparer l'image pour Claude Vision ──
    let imageContent: any;
    if (parsed.data.photoBase64) {
      // base64 raw (sans préfixe data:)
      const cleanBase64 = parsed.data.photoBase64.replace(/^data:image\/\w+;base64,/, '');
      imageContent = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: cleanBase64,
        },
      };
    } else if (parsed.data.photoUrl) {
      imageContent = {
        type: 'image',
        source: {
          type: 'url',
          url: parsed.data.photoUrl,
        },
      };
    }

    const systemPrompt = `Tu es un expert automobile. Tu analyses des photos pour vérifier qu'il s'agit d'un véhicule de tourisme (voiture, SUV, berline, monospace).
RÉPONDS UNIQUEMENT EN JSON STRICT (pas de markdown, pas de \`\`\`).
Format obligatoire :
{
  "isVehicle": true | false,
  "confidence": 0-100,
  "brand": "Mercedes" | "BMW" | "Tesla" | etc. (null si invisible),
  "model": "Classe E" | "Série 5" | "Model 3" | etc. (null si invisible),
  "color": "Noir" | "Blanc" | "Gris" | "Bleu" | etc. (null si invisible),
  "bodyType": "Berline" | "SUV" | "Break" | "Monospace" | "Coupé" (null si invisible),
  "reason": "courte explication si isVehicle=false"
}
Règles :
- isVehicle=false si : capture d'écran, dessin, animal, paysage, personne seule sans voiture, intérieur de voiture sans extérieur visible
- isVehicle=true si : voiture entière ou partielle visible (extérieur)
- confidence : ta certitude que c'est bien un véhicule de tourisme apte au transport VTC
- Si tu n'es pas sûr de la marque/modèle/couleur, mets null (pas de devinette hasardeuse)`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            imageContent,
            {
              type: 'text',
              text: 'Analyse cette photo et réponds en JSON strict selon le format demandé.',
            },
          ],
        },
      ],
    });

    const textBlock = message.content.find((c: any) => c.type === 'text') as any;
    const rawText = textBlock?.text?.trim() ?? '';

    // ── Parsing JSON robuste (au cas où Claude ajoute du markdown) ──
    let cleanJson = rawText;
    if (rawText.startsWith('```')) {
      cleanJson = rawText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }

    let result: any;
    try {
      result = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.warn('[VehicleVerify] JSON parse failed, raw:', rawText);
      // Fallback non-bloquant : on accepte la photo
      return res.json({
        isVehicle: true,
        confidence: 50,
        brand: null,
        model: null,
        color: null,
        bodyType: null,
        reason: null,
      });
    }

    // ── Validation + clean ──
    return res.json({
      isVehicle: Boolean(result.isVehicle),
      confidence: typeof result.confidence === 'number' ? result.confidence : 0,
      brand: result.brand || null,
      model: result.model || null,
      color: result.color || null,
      bodyType: result.bodyType || null,
      reason: result.reason || null,
    });
  } catch (err: any) {
    console.error('[VehicleVerify] error:', err?.message);
    return res.status(500).json({ error: err?.message ?? 'Vision API failed' });
  }
});

export default router;
