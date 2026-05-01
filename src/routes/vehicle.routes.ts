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
import { createClient } from '@supabase/supabase-js';

const router = Router();

// ── Resend lazy client (re-utilisé par toutes les routes véhicule) ──
let resendClient: any = null;
async function getResend() {
  if (!resendClient) {
    const { Resend } = await import('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

function getSupaAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

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

// ─────────────────────────────────────────────────────────────────────
// POST /api/vehicle/profile-saved
// Envoie un email de confirmation Resend après enregistrement véhicule
// + log événement analytics + update is_validated dans Supabase
//
// Body : { driverId, photoUrl, make, model, color?, plate?, features[], aiAuthentic? }
// ─────────────────────────────────────────────────────────────────────
const ProfileSavedSchema = z.object({
  driverId: z.string().uuid(),
  photoUrl: z.string().url(),
  make: z.string().min(1),
  model: z.string().min(1),
  color: z.string().optional(),
  plate: z.string().optional(),
  features: z.array(z.string()).default([]),
  aiAuthentic: z.boolean().optional(),
  aiConfidence: z.number().optional(),
});

router.post('/profile-saved', async (req: Request, res: Response) => {
  const parsed = ProfileSavedSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
  }

  const data = parsed.data;
  const supa = getSupaAdmin();
  if (!supa) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  try {
    // ── 1. Récupérer email du driver depuis auth.users ──
    const { data: userRes, error: userErr } = await supa.auth.admin.getUserById(data.driverId);
    if (userErr || !userRes?.user?.email) {
      console.warn('[VehicleProfileSaved] No email for driver:', data.driverId);
      return res.json({ ok: true, emailSent: false, reason: 'no_email' });
    }
    const userEmail = userRes.user.email;
    const firstName = userRes.user.user_metadata?.first_name || 'Chauffeur';

    // ── 2. Update is_validated si IA authentique avec confiance >= 70 ──
    if (data.aiAuthentic === true && (data.aiConfidence ?? 0) >= 70) {
      await supa
        .from('driver_vehicle_profile')
        .update({ is_validated: true })
        .eq('driver_id', data.driverId);
    }

    // ── 3. Envoyer l'email Resend ──
    const resend = await getResend();
    const emailHtml = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #F8FAFC; }
    .container { max-width: 600px; margin: 40px auto; padding: 32px; background: linear-gradient(180deg, rgba(140,82,255,0.08) 0%, transparent 50%); }
    .header { text-align: center; padding-bottom: 32px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .eyebrow { font-size: 11px; font-weight: 800; letter-spacing: 2.5px; color: #00D4FF; text-transform: uppercase; margin-bottom: 12px; }
    .h1 { font-size: 28px; font-weight: 900; letter-spacing: -1px; color: #F8FAFC; margin: 0; }
    .vehicle-card { margin: 32px 0; padding: 24px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; }
    .vehicle-photo { width: 100%; max-width: 480px; border-radius: 12px; display: block; margin: 0 auto 16px; }
    .vehicle-name { font-size: 20px; font-weight: 800; color: #F8FAFC; margin: 0 0 4px; }
    .vehicle-meta { font-size: 14px; color: rgba(248,250,252,0.72); margin: 0; }
    .badge { display: inline-block; padding: 6px 12px; background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.4); border-radius: 999px; color: #10B981; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; margin-top: 16px; }
    .features { margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); }
    .feature-chip { display: inline-block; padding: 4px 10px; margin: 4px 4px 0 0; background: rgba(140,82,255,0.10); border: 1px solid rgba(140,82,255,0.25); border-radius: 999px; font-size: 11px; color: rgba(248,250,252,0.85); }
    .next { margin-top: 32px; padding: 20px; background: rgba(0,212,255,0.06); border-left: 3px solid #00D4FF; border-radius: 8px; }
    .footer { margin-top: 32px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.08); text-align: center; font-size: 11px; color: rgba(248,250,252,0.42); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="eyebrow">FOREAS · CONCIERGERIE</div>
      <h1 class="h1">Ton véhicule est enregistré ✓</h1>
    </div>

    <p style="font-size:16px;line-height:1.55;color:rgba(248,250,252,0.85);margin:24px 0;">
      Bonjour ${firstName},
    </p>
    <p style="font-size:14px;line-height:1.55;color:rgba(248,250,252,0.72);margin:0 0 24px;">
      Voici la fiche de ton véhicule telle qu'elle apparaîtra à tes clients sur ton site personnel et dans les emails de prospection envoyés par Ajnaya.
    </p>

    <div class="vehicle-card">
      <img src="${data.photoUrl}" alt="${data.make} ${data.model}" class="vehicle-photo" />
      <p class="vehicle-name">${data.make} ${data.model}${data.color ? ' · ' + data.color : ''}</p>
      <p class="vehicle-meta">${data.features.length} équipement${data.features.length > 1 ? 's' : ''} configuré${data.features.length > 1 ? 's' : ''}${data.plate ? ' · ' + data.plate : ''}</p>
      ${data.aiAuthentic ? '<span class="badge">✓ VÉRIFIÉ PAR AJNAYA IA</span>' : ''}
      ${data.features.length > 0 ? `<div class="features">${data.features.map((f) => `<span class="feature-chip">${f}</span>`).join('')}</div>` : ''}
    </div>

    <div class="next">
      <p style="margin:0;font-size:13px;font-weight:700;color:#00D4FF;letter-spacing:1px;text-transform:uppercase;">Étape suivante</p>
      <p style="margin:8px 0 0;font-size:14px;color:rgba(248,250,252,0.85);line-height:1.5;">
        Ouvre l'app FOREAS Driver, onglet <strong>Clients</strong> → ton compteur est passé de 0/3 à 1/3. Crée ton site personnel pour qu'Ajnaya puisse capter des prospects pour toi.
      </p>
    </div>

    <div class="footer">
      © 2026 FOREAS Labs · Tu reçois cet email car tu as enregistré ton véhicule sur l'app FOREAS Driver
    </div>
  </div>
</body>
</html>`;

    const { data: emailRes, error: emailErr } = await resend.emails.send({
      from: 'Ajnaya <ajnaya@foreas.xyz>',
      to: userEmail,
      subject: `✓ Ton ${data.make} ${data.model} est enregistré sur FOREAS`,
      html: emailHtml,
    });

    if (emailErr) {
      console.warn('[VehicleProfileSaved] Email send failed:', emailErr);
      return res.json({ ok: true, emailSent: false, reason: 'email_error' });
    }

    // ── 4. Log analytics event ──
    try {
      await supa.from('pieuvre_analytics_events').insert({
        driver_id: data.driverId,
        event_name: 'vehicle_profile_saved',
        meta: {
          make: data.make,
          model: data.model,
          features_count: data.features.length,
          ai_authentic: data.aiAuthentic ?? null,
          ai_confidence: data.aiConfidence ?? null,
          email_id: emailRes?.id ?? null,
        },
      });
    } catch (logErr) {
      // Non-bloquant
      console.warn('[VehicleProfileSaved] Log event failed:', logErr);
    }

    return res.json({
      ok: true,
      emailSent: true,
      emailId: emailRes?.id ?? null,
      isValidated: data.aiAuthentic === true && (data.aiConfidence ?? 0) >= 70,
    });
  } catch (err: any) {
    console.error('[VehicleProfileSaved] error:', err?.message);
    return res.status(500).json({ error: err?.message ?? 'Email send failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// POST /api/vehicle/documents/verify
// Vérifie l'authenticité d'un document légal via Claude Vision et extrait
// les données pertinentes (numéro permis, plaque carte grise, etc.)
//
// Body : {
//   driverId, docType: 'permis_conduire'|'assurance'|'kbis'|'carte_grise'|'carte_pro_vtc'|'rcp_vtc',
//   photoBase64?, photoUrl?
// }
// ═══════════════════════════════════════════════════════════════════════
const DOC_TYPES = [
  'permis_conduire',
  'assurance',
  'kbis',
  'carte_grise',
  'carte_pro_vtc',
  'rcp_vtc',
] as const;

const DocVerifySchema = z
  .object({
    driverId: z.string().uuid(),
    docType: z.enum(DOC_TYPES),
    photoBase64: z.string().optional(),
    photoUrl: z.string().url().optional(),
  })
  .refine((d) => d.photoBase64 || d.photoUrl, { message: 'photoBase64 OR photoUrl required' });

const DOC_PROMPTS: Record<(typeof DOC_TYPES)[number], string> = {
  permis_conduire: `Tu analyses un permis de conduire FRANÇAIS. Extrais les données et juge l'authenticité.
Retourne JSON STRICT :
{
  "isAuthentic": true|false,
  "confidence": 0-100,
  "warnings": [],
  "extracted": {
    "lastName": "...", "firstName": "...", "birthDate": "YYYY-MM-DD",
    "deliveryDate": "YYYY-MM-DD", "expiryDate": "YYYY-MM-DD" | null,
    "categories": ["B"], "permitNumber": "..."
  }
}
Critères : présence des champs officiels, hologramme/sceau France, qualité photo, format carte rose ou format carte plastifiée 2013+.
Si suspect (photocopie floue, photoshop, manque de cachet), confidence < 50 et isAuthentic=false.`,

  assurance: `Tu analyses une attestation d'assurance auto FRANÇAISE (carte verte ou attestation digitale).
Retourne JSON STRICT :
{
  "isAuthentic": true|false,
  "confidence": 0-100,
  "warnings": [],
  "extracted": {
    "insurerName": "...", "policyNumber": "...",
    "insuredName": "...", "vehiclePlate": "AB-123-CD" | null,
    "vehicleMake": "...", "vehicleModel": "...",
    "validFrom": "YYYY-MM-DD", "validTo": "YYYY-MM-DD",
    "coverageType": "tous_risques" | "tiers" | "tiers_etendu"
  }
}
Critères : présence du logo assureur, format officiel, dates lisibles. La couverture doit être valide à la date d'aujourd'hui.`,

  kbis: `Tu analyses un extrait Kbis FRANÇAIS (auto-entrepreneur ou société).
Retourne JSON STRICT :
{
  "isAuthentic": true|false,
  "confidence": 0-100,
  "warnings": [],
  "extracted": {
    "siret": "...", "siren": "...", "denomination": "...",
    "registrationDate": "YYYY-MM-DD",
    "activity": "...", "address": "...",
    "directorName": "..." | null,
    "isAutoEntrepreneur": true | false
  }
}
Critères : entête INPI / RCS, code-barres ou QR officiel, date d'émission < 3 mois (sinon warning).`,

  carte_grise: `Tu analyses une carte grise FRANÇAISE (certificat d'immatriculation).
Retourne JSON STRICT :
{
  "isAuthentic": true|false,
  "confidence": 0-100,
  "warnings": [],
  "extracted": {
    "plate": "AB-123-CD",
    "make": "...", "model": "...", "color": "...",
    "energyType": "...", "ownerName": "...",
    "firstRegistrationDate": "YYYY-MM-DD",
    "co2Emission": "..." | null
  }
}
Critères : format A4 sécurisé avec champs F.1, F.2, F.3, lignes B, D.2, D.3 etc. Vérifie présence cachet et hologramme.`,

  carte_pro_vtc: `Tu analyses une CARTE PROFESSIONNELLE VTC française.
Retourne JSON STRICT :
{
  "isAuthentic": true|false,
  "confidence": 0-100,
  "warnings": [],
  "extracted": {
    "lastName": "...", "firstName": "...",
    "cardNumber": "...", "issuanceDate": "YYYY-MM-DD",
    "expiryDate": "YYYY-MM-DD" | null,
    "issuingPrefecture": "..."
  }
}
Critères : présence cachet préfecture, code-barres officiel, photo identité.`,

  rcp_vtc: `Tu analyses une attestation de Responsabilité Civile Professionnelle VTC.
Retourne JSON STRICT :
{
  "isAuthentic": true|false,
  "confidence": 0-100,
  "warnings": [],
  "extracted": {
    "insurerName": "...", "policyNumber": "...",
    "insuredName": "...",
    "validFrom": "YYYY-MM-DD", "validTo": "YYYY-MM-DD",
    "coverageAmount": "..."
  }
}
Critères : mention explicite "Responsabilité Civile Professionnelle" et "transport de personnes" ou "VTC".`,
};

router.post('/documents/verify', async (req: Request, res: Response) => {
  const parsed = DocVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
  }

  const { driverId, docType, photoBase64, photoUrl } = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Anthropic not configured' });

  const supa = getSupaAdmin();
  if (!supa) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey });

    // Préparer image pour Claude Vision
    let imageContent: any;
    if (photoBase64) {
      const cleanBase64 = photoBase64.replace(/^data:image\/\w+;base64,/, '');
      imageContent = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: cleanBase64 },
      };
    } else if (photoUrl) {
      imageContent = {
        type: 'image',
        source: { type: 'url', url: photoUrl },
      };
    }

    const systemPrompt = `Tu es un expert en analyse de documents officiels français. ${DOC_PROMPTS[docType]}
RÈGLE STRICTE : Réponds UNIQUEMENT en JSON pur (pas de markdown, pas de \`\`\`).
Si tu doutes d'un champ, mets null. Le champ "warnings" liste les anomalies (ex: "qualité photo basse", "expiration proche", "cachet flou").`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            imageContent,
            { type: 'text', text: 'Analyse ce document et réponds en JSON strict.' },
          ],
        },
      ],
    });

    const textBlock = message.content.find((c: any) => c.type === 'text') as any;
    const rawText = textBlock?.text?.trim() ?? '';
    let cleanJson = rawText;
    if (rawText.startsWith('```')) {
      cleanJson = rawText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    }

    let result: any;
    try {
      result = JSON.parse(cleanJson);
    } catch {
      console.warn('[DocVerify] JSON parse failed, raw:', rawText.slice(0, 200));
      result = {
        isAuthentic: null,
        confidence: 0,
        warnings: ['Analyse IA impossible — vérification manuelle requise'],
        extracted: {},
      };
    }

    const status =
      result.isAuthentic === true && (result.confidence ?? 0) >= 70
        ? 'ai_verified'
        : result.isAuthentic === false
          ? 'rejected'
          : 'pending';

    // Upsert dans driver_legal_documents (file_url requis — on stocke photoUrl si fourni)
    if (photoUrl) {
      try {
        await supa.from('driver_legal_documents').upsert(
          {
            driver_id: driverId,
            doc_type: docType,
            file_url: photoUrl,
            ai_verified_at: new Date().toISOString(),
            ai_authenticity_score: result.confidence ?? null,
            ai_is_authentic: typeof result.isAuthentic === 'boolean' ? result.isAuthentic : null,
            ai_extracted_data: result.extracted ?? {},
            ai_warnings: result.warnings ?? [],
            ai_model_version: 'claude-haiku-4-5',
            status,
            rejection_reason:
              status === 'rejected' ? (result.warnings?.[0] ?? 'Document non authentique') : null,
            expires_at: result.extracted?.expiryDate || result.extracted?.validTo || null,
          },
          { onConflict: 'driver_id,doc_type' },
        );
      } catch (dbErr: any) {
        console.warn('[DocVerify] DB upsert failed:', dbErr?.message);
      }
    }

    // Si carte_grise → auto-fill driver_vehicle_profile (cas spécial)
    if (
      docType === 'carte_grise' &&
      result.isAuthentic === true &&
      (result.confidence ?? 0) >= 70 &&
      result.extracted?.plate
    ) {
      try {
        await supa
          .from('driver_vehicle_profile')
          .update({
            license_plate: result.extracted.plate,
            make: result.extracted.make ?? undefined,
            model: result.extracted.model ?? undefined,
            color: result.extracted.color ?? undefined,
          })
          .eq('driver_id', driverId);
      } catch (e) {
        console.warn('[DocVerify] auto-fill vehicle from carte_grise failed:', e);
      }
    }

    return res.json({
      ok: true,
      docType,
      status,
      isAuthentic: result.isAuthentic ?? null,
      confidence: result.confidence ?? 0,
      warnings: result.warnings ?? [],
      extracted: result.extracted ?? {},
    });
  } catch (err: any) {
    console.error('[DocVerify] error:', err?.message);
    return res.status(500).json({ error: err?.message ?? 'Vision API failed' });
  }
});

export default router;
