/**
 * Community Routes — FOREAS Driver
 * ════════════════════════════════
 *
 * POST /api/community/moderate     → IA moderation (GPT-4o-mini)
 * POST /api/community/check-alert  → Check trending post for push alert
 */

import { Router, Request, Response } from 'express';

const router = Router();

// ─── Lazy-loaded dependencies ────────────────────────────────────────────────

let supabaseAdmin: any = null;

async function getSupa() {
  if (!supabaseAdmin) {
    const { createClient } = await import('@supabase/supabase-js');
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL || 'https://fihvdvlhftcxhlnocqiq.supabase.co',
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return supabaseAdmin;
}

function getOpenAIKey(): string {
  return process.env.OPENAI_API_KEY || process.env.CLÉ_API_OPENAI || '';
}

// ─── MODERATION IA — Analyse sémantique par GPT ─────────────────────────────

const MODERATION_SYSTEM_PROMPT = `Tu es le système de modération FOREAS Shield.
Analyse le message d'un chauffeur VTC dans un fil communautaire.

RÈGLES STRICTES :
1. INSULTES : Tout mot vulgaire, insultant, dégradant — même déguisé (conar=connard, mrd=merde, etc.) → BLOCK
2. DONNÉES PERSONNELLES : Tout numéro, email, pseudo réseau social, lien → BLOCK
3. ANTI-FOREAS : Critique de FOREAS, promotion de concurrents → BLOCK
4. SPAM : Répétition, majuscules excessives, contenu vide → BLOCK
5. CONTACT : Toute tentative de partager un moyen de contact (mon insta, ajoute-moi, etc.) → BLOCK

RÉPONDS UNIQUEMENT en JSON :
{"allowed": true/false, "reason": "explication courte si bloqué", "confidence": 0.0-1.0}

Exemples :
- "C oooooooo nar" → {"allowed": false, "reason": "Insulte déguisée (connard)", "confidence": 0.98}
- "Contrôle Place d'Italie faites gaffe" → {"allowed": true, "confidence": 0.95}
- "mon snap c lebosskiller" → {"allowed": false, "reason": "Partage de contact interdit", "confidence": 0.99}`;

router.post('/moderate', async (req: Request, res: Response) => {
  try {
    const { content } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Content required' });
    }

    const apiKey = getOpenAIKey();
    if (!apiKey) {
      // Fallback: allow if no API key configured
      console.warn('[Community] No OpenAI key — skipping AI moderation');
      return res.json({ allowed: true, confidence: 0, reason: 'no_ai_key' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: MODERATION_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        max_tokens: 100,
        temperature: 0,
      }),
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '{"allowed": true, "confidence": 0}';

    // Parse JSON response
    try {
      const result = JSON.parse(reply);
      console.log(
        `[Community Moderation] "${content.substring(0, 40)}..." → ${result.allowed ? '✅' : '❌'} (${result.confidence})`,
      );
      return res.json(result);
    } catch {
      console.warn('[Community] Failed to parse AI moderation response:', reply);
      return res.json({ allowed: true, confidence: 0, reason: 'parse_error' });
    }
  } catch (error: any) {
    console.error('[Community] Moderation error:', error.message);
    return res.json({ allowed: true, confidence: 0, reason: 'error' });
  }
});

// ─── ALERT TRENDING — Analyse post viral + push notification ─────────────────

const ALERT_ANALYSIS_PROMPT = `Tu es Ajnaya, IA copilote pour chauffeurs VTC à Paris.
Un message communautaire a reçu plusieurs likes. Analyse-le pour déterminer s'il contient une ALERTE TERRAIN importante.

TYPES D'ALERTES VALIDES :
- 🚔 Contrôle police/VTC (lieu + type)
- 🚧 Route bloquée / travaux / accident
- ⚡ Surge/majoration exceptionnelle (lieu + plateforme)
- 🎪 Événement majeur (concert, match, manif)
- ⚠️ Danger / arnaque / problème client connu

RÉPONDS EN JSON :
{
  "is_alert": true/false,
  "alert_type": "CONTROLE" | "ROUTE" | "SURGE" | "EVENT" | "DANGER" | "NONE",
  "confidence": 0.0-1.0,
  "location": "lieu mentionné ou null",
  "push_title": "titre court pour notification push (max 50 chars)",
  "push_body": "corps de la notification (max 120 chars)",
  "urgency": "HIGH" | "MEDIUM" | "LOW"
}

Si le message n'est PAS une alerte terrain (simple opinion, blague, conseil générique) → is_alert: false.`;

router.post('/check-alert', async (req: Request, res: Response) => {
  try {
    const { postId, content, likesCount } = req.body;
    if (!postId || !content) {
      return res.status(400).json({ error: 'postId and content required' });
    }

    // Minimum 5 likes
    if ((likesCount || 0) < 5) {
      return res.json({ is_alert: false, reason: 'insufficient_likes' });
    }

    const apiKey = getOpenAIKey();
    if (!apiKey) {
      return res.json({ is_alert: false, reason: 'no_ai_key' });
    }

    // Step 1: AI analysis
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: ALERT_ANALYSIS_PROMPT },
          { role: 'user', content: `Message (${likesCount} likes) : "${content}"` },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '{"is_alert": false}';

    let analysis;
    try {
      analysis = JSON.parse(reply);
    } catch {
      console.warn('[Community Alert] Failed to parse analysis:', reply);
      return res.json({ is_alert: false, reason: 'parse_error' });
    }

    console.log(
      `[Community Alert] Post ${postId}: ${analysis.is_alert ? '🚨' : '—'} type=${analysis.alert_type} conf=${analysis.confidence}`,
    );

    // Step 2: Check confidence threshold (60%)
    if (!analysis.is_alert || (analysis.confidence || 0) < 0.6) {
      return res.json({ ...analysis, pushed: false, reason: 'below_threshold' });
    }

    // Step 3: Send push notification to ALL active drivers
    const supa = await getSupa();

    // Check if we already sent an alert for this post
    const { data: existingAlert } = await supa
      .from('community_alerts')
      .select('id')
      .eq('post_id', postId)
      .limit(1);

    if (existingAlert && existingAlert.length > 0) {
      return res.json({ ...analysis, pushed: false, reason: 'already_sent' });
    }

    // Get all active push tokens
    const { data: tokens } = await supa.from('push_tokens').select('token').eq('is_active', true);

    if (!tokens || tokens.length === 0) {
      console.warn('[Community Alert] No active push tokens found');
      return res.json({ ...analysis, pushed: false, reason: 'no_tokens' });
    }

    // Send via Expo Push API (batch of 100)
    const pushTitle = analysis.push_title || `⚠️ Alerte communauté`;
    const pushBody = analysis.push_body || content.substring(0, 120);

    const messages = tokens.map((t: any) => ({
      to: t.token,
      sound: analysis.urgency === 'HIGH' ? 'default' : undefined,
      title: pushTitle,
      body: pushBody,
      data: {
        type: 'community_alert',
        postId,
        alertType: analysis.alert_type,
        location: analysis.location,
      },
      priority: analysis.urgency === 'HIGH' ? 'high' : 'default',
    }));

    // Expo push API accepts batches of 100
    const chunks: any[][] = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }

    let totalSent = 0;
    for (const chunk of chunks) {
      try {
        const pushRes = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
          },
          body: JSON.stringify(chunk),
        });
        if (pushRes.ok) totalSent += chunk.length;
      } catch (err) {
        console.error('[Community Alert] Push batch failed:', err);
      }
    }

    // Record the alert to avoid duplicates
    await supa
      .from('community_alerts')
      .insert({
        post_id: postId,
        alert_type: analysis.alert_type,
        confidence: analysis.confidence,
        location: analysis.location,
        push_title: pushTitle,
        push_body: pushBody,
        tokens_sent: totalSent,
      })
      .catch(() => {}); // Non-blocking

    console.log(
      `[Community Alert] 🚨 Push sent to ${totalSent}/${tokens.length} drivers — ${pushTitle}`,
    );

    return res.json({
      ...analysis,
      pushed: true,
      tokens_sent: totalSent,
      total_tokens: tokens.length,
    });
  } catch (error: any) {
    console.error('[Community Alert] Error:', error.message);
    return res.json({ is_alert: false, reason: 'error', error: error.message });
  }
});

export default router;
