/**
 * Voice Routes v88 — ElevenLabs Agent webhooks
 * Ajnaya2026v88
 *
 * POST /elevenlabs/post-call    — Webhook post-call (transcript + analysis)
 * POST /elevenlabs/server-tool  — Server Tools (transfer_to_driver, schedule_callback)
 * POST /trigger/:logId          — Trigger a call manually (admin)
 * GET  /calls/:driverId         — List calls for a driver
 */
import { Router, Request, Response } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { initiateElevenLabsCall } from '../services/ElevenLabsCallService.js';

const router = Router();

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (!_supa) {
    _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _supa;
}

// ── POST /elevenlabs/post-call — Webhook from ElevenLabs after call ends ──
router.post('/elevenlabs/post-call', async (req: Request, res: Response) => {
  try {
    const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sig = req.headers['x-elevenlabs-signature'] || req.headers['x-webhook-secret'];
      if (sig !== webhookSecret) {
        console.warn('[VoiceRoutes] Post-call: invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { conversation_id, status, transcript, analysis, call_duration_secs, call_successful } =
      req.body;

    if (!conversation_id) {
      return res.status(400).json({ error: 'Missing conversation_id' });
    }

    const supa = getSupa();

    // Idempotence check
    const { data: existingCall } = await supa
      .from('finder_voice_calls')
      .select('id, status')
      .eq('elevenlabs_conversation_id', conversation_id)
      .maybeSingle();

    if (
      existingCall &&
      ['COMPLETED', 'FAILED', 'TRANSFERRED'].includes((existingCall as any).status)
    ) {
      return res.status(200).json({ ok: true, already_processed: true });
    }

    const { data: call } = await supa
      .from('finder_voice_calls')
      .select('id, driver_id, thread_id, log_id')
      .eq('elevenlabs_conversation_id', conversation_id)
      .maybeSingle();

    if (!call) {
      console.warn(`[VoiceRoutes] Post-call: no call found for ${conversation_id}`);
      return res.status(200).json({ ok: true, matched: false });
    }

    const outcome = mapElevenLabsOutcome(analysis);
    const summary = await generateCallSummary(transcript);

    await supa
      .from('finder_voice_calls')
      .update({
        status: call_successful ? 'COMPLETED' : 'FAILED',
        ended_at: new Date().toISOString(),
        duration_seconds: call_duration_secs || null,
        outcome,
        call_summary: summary,
        full_transcript: transcript || null,
        analysis_data: analysis || null,
        cost_estimate_eur: estimateCallCost(call_duration_secs || 0),
      })
      .eq('id', (call as any).id);

    // Update hunter log
    if ((call as any).log_id && outcome) {
      const logStatus =
        outcome === 'CONVERTED'
          ? 'CONVERTED'
          : outcome === 'INTERESTED'
            ? 'CALL_INTERESTED'
            : outcome === 'CALLBACK_REQUESTED'
              ? 'CALL_CALLBACK'
              : 'CALL_DECLINED';

      await supa
        .from('pieuvre_b2b_hunter_log')
        .update({
          status: logStatus,
          call_summary: summary,
        })
        .eq('id', (call as any).log_id);
    }

    // Insert summary message in thread for UI display
    if ((call as any).thread_id) {
      await supa.from('finder_email_messages').insert({
        thread_id: (call as any).thread_id,
        direction: 'OUT',
        sequence_type: 'VOICE_SUMMARY',
        body_text: `📞 Appel Ajnaya (${call_duration_secs || 0}s) — ${summary}`,
        sent_at: new Date().toISOString(),
      });
    }

    console.log(
      `[VoiceRoutes] Post-call OK: ${conversation_id} → ${outcome} (${call_duration_secs}s)`,
    );
    return res.status(200).json({ ok: true, outcome });
  } catch (err: any) {
    console.error('[VoiceRoutes] Post-call error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /elevenlabs/server-tool — Server Tools ──
router.post('/elevenlabs/server-tool', async (req: Request, res: Response) => {
  try {
    const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sig = req.headers['x-elevenlabs-signature'] || req.headers['x-webhook-secret'];
      if (sig !== webhookSecret) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { tool_name, tool_params, conversation_id } = req.body;
    const supa = getSupa();

    if (tool_name === 'transfer_to_driver') {
      const { data: call } = await supa
        .from('finder_voice_calls')
        .select('id, driver_id, log_id, thread_id')
        .eq('elevenlabs_conversation_id', conversation_id)
        .maybeSingle();

      if (!call) return res.json({ success: false, message: 'Call not found' });

      // Use exported prepareHandoff from FinderConversationService
      const { prepareHandoff } = await import('../services/FinderConversationService.js');
      await prepareHandoff((call as any).thread_id, (call as any).driver_id, (call as any).log_id, {
        prospectEmail: tool_params?.prospect_email,
      });

      await supa
        .from('finder_voice_calls')
        .update({
          transferred_to_driver: true,
          status: 'TRANSFERRED',
        })
        .eq('id', (call as any).id);

      return res.json({
        success: true,
        message: 'Le chauffeur a été notifié. Il vous appellera dans les prochaines minutes.',
      });
    }

    if (tool_name === 'schedule_callback') {
      const callbackDate = tool_params?.callback_date || 'dans 1 mois';

      const { data: callForCb } = await supa
        .from('finder_voice_calls')
        .select('log_id')
        .eq('elevenlabs_conversation_id', conversation_id)
        .maybeSingle();

      if ((callForCb as any)?.log_id) {
        await supa
          .from('pieuvre_b2b_hunter_log')
          .update({
            status: 'CALL_CALLBACK',
            callback_requested_at: new Date().toISOString(),
            callback_note: callbackDate,
          })
          .eq('id', (callForCb as any).log_id);
      }

      console.log(`[VoiceRoutes] Callback scheduled: ${callbackDate}`);
      return res.json({
        success: true,
        message: `Rappel noté pour ${callbackDate}. Merci et bonne journée.`,
      });
    }

    return res.json({ success: false, message: `Unknown tool: ${tool_name}` });
  } catch (err: any) {
    console.error('[VoiceRoutes] Server tool error:', err.message);
    return res.json({ success: false, message: err.message });
  }
});

// ── POST /trigger/:logId — Admin trigger ─────────────────────────
router.post('/trigger/:logId', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (
    authHeader !== `Bearer ${process.env.FOREAS_SERVICE_KEY}` &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supa = getSupa();
  const { data: log } = await supa
    .from('pieuvre_b2b_hunter_log')
    .select('id, driver_id, place_directory_id')
    .eq('id', req.params.logId)
    .single();

  if (!log) return res.status(404).json({ error: 'Log not found' });

  const { data: thread } = await supa
    .from('finder_email_threads')
    .select('id')
    .eq('log_id', req.params.logId)
    .maybeSingle();

  const { data: place } = await supa
    .from('places_directory')
    .select('phone')
    .eq('id', (log as any).place_directory_id)
    .maybeSingle();

  const phone = (place as any)?.phone || req.body?.phone;
  if (!phone) return res.status(400).json({ error: 'No phone number for this prospect' });

  const result = await initiateElevenLabsCall({
    driverId: (log as any).driver_id,
    threadId: (thread as any)?.id || '',
    logId: req.params.logId,
    placeId: (log as any).place_directory_id,
    toNumber: phone,
  });

  return res.json(result);
});

// ── GET /calls/:driverId — List calls ────────────────────────────
router.get('/calls/:driverId', async (req: Request, res: Response) => {
  const supa = getSupa();
  const { data, error } = await supa
    .from('finder_voice_calls')
    .select(
      'id, status, outcome, started_at, duration_seconds, call_summary, to_number, cost_estimate_eur',
    )
    .eq('driver_id', req.params.driverId)
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ calls: data || [] });
});

// ── Helpers ──────────────────────────────────────────────────────
function mapElevenLabsOutcome(analysis: any): string {
  if (!analysis) return 'TECH_FAILURE';
  const data = analysis?.data || analysis;
  const outcome = data?.outcome || data?.call_outcome || '';
  const o = outcome.toLowerCase();
  if (o.includes('convert') || o.includes('accept') || o.includes('yes')) return 'CONVERTED';
  if (o.includes('interest') || o.includes('maybe')) return 'INTERESTED';
  if (o.includes('callback') || o.includes('later') || o.includes('rappel'))
    return 'CALLBACK_REQUESTED';
  if (o.includes('decline') || o.includes('no') || o.includes('refus')) return 'DECLINED';
  if (o.includes('unreach') || o.includes('no_answer')) return 'UNREACHABLE';
  return 'TECH_FAILURE';
}

function estimateCallCost(durationSecs: number): number {
  const minutes = Math.ceil(durationSecs / 60);
  return Math.round(minutes * 0.14 * 100) / 100; // ~€0.14/min
}

async function generateCallSummary(transcript: any): Promise<string> {
  if (!transcript) return 'Appel terminé — pas de transcript disponible.';
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const text =
      typeof transcript === 'string' ? transcript : JSON.stringify(transcript).slice(0, 3000);
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Résume cet appel téléphonique commercial en EXACTEMENT 2 phrases courtes en français. Indique le résultat.\n\nTranscript:\n${text}`,
        },
      ],
    });
    return ((msg.content[0] as any).text as string).trim();
  } catch {
    return 'Appel terminé — résumé indisponible.';
  }
}

export default router;
