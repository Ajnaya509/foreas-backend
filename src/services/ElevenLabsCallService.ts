/**
 * ElevenLabsCallService — Appels sortants via ElevenLabs Conversational AI Agent
 * Ajnaya2026v88
 *
 * UN SEUL APPEL API pour déclencher une conversation complète.
 * L'agent ElevenLabs gère : STT, LLM, TTS, barge-in, silence, turn-taking.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}

const ELEVENLABS_API_KEY = () => process.env.ELEVENLABS_API_KEY!;
const ELEVENLABS_AGENT_ID = () =>
  process.env.ELEVENLABS_AGENT_ID || 'agent_3101kmr2mje5fgzrpbtsa8sf23qz';
const ELEVENLABS_PHONE_NUMBER_ID = () => process.env.ELEVENLABS_PHONE_NUMBER_ID!;
const BACKEND_URL = () =>
  process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';

// ── Pre-call checks ──────────────────────────────────────────────
async function preCallChecks(driverId: string): Promise<{ ok: boolean; reason?: string }> {
  const supa = getSupa();

  // 1. Paris hours 9h-19h
  const parisHour = parseInt(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  );
  if (parisHour < 9 || parisHour >= 19) {
    return { ok: false, reason: `OUTSIDE_HOURS (Paris: ${parisHour}h)` };
  }

  // 2. voice_calls_enabled
  const { data: settings } = await supa
    .from('client_finder_settings')
    .select('voice_calls_enabled, max_voice_calls_per_week')
    .eq('driver_id', driverId)
    .single();

  if (!settings?.voice_calls_enabled) {
    return { ok: false, reason: 'VOICE_NOT_ENABLED' };
  }

  // 3. Weekly quota
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { count } = await supa
    .from('finder_voice_calls')
    .select('*', { count: 'exact', head: true })
    .eq('driver_id', driverId)
    .gte('started_at', weekAgo)
    .not('status', 'eq', 'FAILED');

  const maxPerWeek = settings.max_voice_calls_per_week ?? 5;
  if ((count ?? 0) >= maxPerWeek) {
    return { ok: false, reason: `WEEKLY_QUOTA_REACHED (${count}/${maxPerWeek})` };
  }

  // 4. Budget circuit breaker 300€/week
  const { data: weekCosts } = await supa
    .from('finder_voice_calls')
    .select('cost_estimate_eur')
    .gte('started_at', weekAgo);

  const totalCost = (weekCosts ?? []).reduce(
    (sum: number, c: any) => sum + (parseFloat(c.cost_estimate_eur) || 0),
    0,
  );
  if (totalCost >= 300) {
    return { ok: false, reason: `BUDGET_CIRCUIT_BREAKER (${totalCost.toFixed(2)}€/week)` };
  }

  return { ok: true };
}

// ── Build call context ───────────────────────────────────────────
async function buildCallContext(
  threadId: string,
  logId: string,
): Promise<{
  placeName: string;
  placeType: string;
  emailHistory: string;
  driverPresentation: string;
  objectionPlaybook: string;
}> {
  const supa = getSupa();

  const { data: log } = await supa
    .from('pieuvre_b2b_hunter_log')
    .select('business_name, business_type, driver_id')
    .eq('id', logId)
    .single();

  const { data: messages } = await supa
    .from('finder_email_messages')
    .select('direction, body_text, sequence_type')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(6);

  const emailHistory = (messages ?? [])
    .map(
      (m: any) =>
        `${m.direction === 'OUT' ? 'Ajnaya' : 'Prospect'}: ${(m.body_text ?? '').slice(0, 200)}`,
    )
    .join('\n');

  const { data: settings } = await supa
    .from('client_finder_settings')
    .select('driver_presentation')
    .eq('driver_id', (log as any)?.driver_id)
    .single();

  const { data: playbook } = await supa
    .from('finder_objection_playbook')
    .select('objection_category, response_template')
    .eq('is_active', true)
    .eq('language', 'fr')
    .in('channel', ['VOICE', 'BOTH']);

  const playbookText = (playbook ?? [])
    .map((p: any) => `[${p.objection_category}] ${p.response_template}`)
    .join('\n');

  return {
    placeName: (log as any)?.business_name ?? 'Établissement',
    placeType: (log as any)?.business_type ?? 'inconnu',
    emailHistory,
    driverPresentation: (settings as any)?.driver_presentation ?? 'chauffeur VTC professionnel',
    objectionPlaybook: playbookText,
  };
}

// ── Main: initiate call ──────────────────────────────────────────
export async function initiateElevenLabsCall(params: {
  driverId: string;
  threadId: string;
  logId: string;
  placeId: string | null;
  toNumber: string;
}): Promise<{ success: boolean; callId?: string; reason?: string }> {
  const check = await preCallChecks(params.driverId);
  if (!check.ok) {
    console.log(`[ElevenLabsCall] Pre-check failed: ${check.reason}`);
    return { success: false, reason: check.reason };
  }

  const ctx = await buildCallContext(params.threadId, params.logId);
  const supa = getSupa();

  // Create DB record BEFORE call
  const { data: callRow, error: insertErr } = await supa
    .from('finder_voice_calls')
    .insert({
      driver_id: params.driverId,
      thread_id: params.threadId,
      log_id: params.logId,
      place_id: params.placeId,
      from_number: 'ELEVENLABS_MANAGED',
      to_number: params.toNumber,
      status: 'INITIATED',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (insertErr || !callRow) {
    return { success: false, reason: `DB insert failed: ${insertErr?.message}` };
  }

  const callId = (callRow as any).id;

  // Dynamic prompt for this specific call
  const dynamicPrompt = `Tu es Ajnaya, l'assistante commerciale du réseau FOREAS. Tu appelles ${ctx.placeName} (${ctx.placeType}) suite à un échange email positif.

CONTEXTE EMAIL :
${ctx.emailHistory}

CHAUFFEUR PARTENAIRE :
${ctx.driverPresentation}

RÈGLES ABSOLUES :
- Vouvoiement systématique
- Tu représentes le réseau FOREAS, jamais un chauffeur spécifique
- Ne jamais donner le nom ou numéro du chauffeur directement
- Si le prospect est intéressé → propose la mise en relation (appelle le tool "transfer_to_driver")
- Si "vous êtes une IA ?" → "Je suis Ajnaya, l'assistante du réseau FOREAS."
- Si 3ème insistance robot → "Je vous recontacte par email." et fin de conversation
- Pas de commission plateforme, 15-20% moins cher qu'Uber Black
- Si objection, utilise le playbook :
${ctx.objectionPlaybook}

OBJECTIF : obtenir un "oui" pour la mise en relation avec le chauffeur partenaire.
Si oui → appelle le tool "transfer_to_driver".
Si "pas maintenant" → propose un rappel via "schedule_callback", note la date, termine poliment.
Si non → remercie et termine.

Ton : chaleureux, professionnel, direct. Phrases courtes (1-2 max).`;

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY(),
      },
      body: JSON.stringify({
        agent_id: ELEVENLABS_AGENT_ID(),
        agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID(),
        to_number: params.toNumber,
        conversation_config_override: {
          agent: {
            prompt: { prompt: dynamicPrompt },
            first_message: `Bonjour, ici Ajnaya du réseau FOREAS. Cet appel peut être enregistré à des fins d'amélioration du service. Je vous appelle suite à notre échange par email concernant un chauffeur partenaire pour ${ctx.placeName}. Avez-vous deux minutes ?`,
          },
        },
        custom_llm_extra_body: {
          foreas_call_id: callId,
          driver_id: params.driverId,
          log_id: params.logId,
          thread_id: params.threadId,
          place_name: ctx.placeName,
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[ElevenLabsCall] API error ${res.status}: ${errText}`);
      await supa.from('finder_voice_calls').update({ status: 'FAILED' }).eq('id', callId);
      return { success: false, reason: `ElevenLabs API ${res.status}: ${errText.slice(0, 200)}` };
    }

    const resData = await res.json();
    const conversationId = resData?.conversation_id || resData?.call_sid || null;

    await supa
      .from('finder_voice_calls')
      .update({
        elevenlabs_conversation_id: conversationId,
        status: 'RINGING',
      })
      .eq('id', callId);

    await supa
      .from('finder_email_threads')
      .update({
        status: 'HANDOFF_PENDING',
        last_message_at: new Date().toISOString(),
      })
      .eq('id', params.threadId);

    console.log(
      `[ElevenLabsCall] ✅ Call launched → ${params.toNumber} (conversation: ${conversationId})`,
    );
    return { success: true, callId };
  } catch (err: any) {
    console.error(`[ElevenLabsCall] ❌ ${err.message}`);
    await supa.from('finder_voice_calls').update({ status: 'FAILED' }).eq('id', callId);
    return { success: false, reason: err.message };
  }
}
