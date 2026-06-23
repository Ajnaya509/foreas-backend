/**
 * Finder Followup Cron — Ajnaya relance automatiquement les prospects silencieux
 * Ajnaya2026v87
 *
 * Schedule recommandé : Railway Cron 1×/jour à 10h UTC
 *   → POST /api/client-finder/run/followups (avec FOREAS_SERVICE_KEY)
 *
 * Règles :
 *   J+4  sans réponse  → FOLLOWUP_1 (relance soft)
 *   J+9  sans réponse  → FOLLOWUP_2 (dernière relance)
 *   J+15 sans réponse  → statut SILENT + thread CLOSED_LOST
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const FOLLOWUP_1_DAYS = 4;
const FOLLOWUP_2_DAYS = 9;
const SILENT_DAYS = 15;

let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}

interface BatchResult {
  followup1: number;
  followup2: number;
  silent: number;
  errors: number;
  durationMs: number;
}

export async function runFollowupBatch(): Promise<BatchResult> {
  const t0 = Date.now();
  const result: BatchResult = { followup1: 0, followup2: 0, silent: 0, errors: 0, durationMs: 0 };
  const supa = getSupa();

  const now = new Date();
  const f1Cutoff = new Date(now.getTime() - FOLLOWUP_1_DAYS * 24 * 3600 * 1000).toISOString();
  const f2Cutoff = new Date(now.getTime() - FOLLOWUP_2_DAYS * 24 * 3600 * 1000).toISOString();
  const silentCutoff = new Date(now.getTime() - SILENT_DAYS * 24 * 3600 * 1000).toISOString();

  console.log('[FinderFollowupCron] 🕐 Starting daily followup batch...');

  // ── FOLLOWUP 1 : J+4 sans réponse, outreach_count = 1 ─────────
  try {
    const { data: logsF1 } = await supa
      .from('pieuvre_b2b_hunter_log')
      .select('id, driver_id, thread_id, contacted_at, target_name, contact_email, outreach_count')
      .is('replied_at', null)
      .lte('contacted_at', f1Cutoff)
      .gt('contacted_at', f2Cutoff)
      .eq('outreach_count', 1);

    for (const log of (logsF1 ?? []) as any[]) {
      try {
        await sendFollowup(log, 'FOLLOWUP_1');
        result.followup1++;
      } catch (err: any) {
        console.error('[FinderFollowupCron] F1 error:', err.message);
        result.errors++;
      }
    }
  } catch (err: any) {
    console.error('[FinderFollowupCron] F1 query error:', err.message);
    result.errors++;
  }

  // ── FOLLOWUP 2 : J+9 sans réponse, outreach_count = 2 ─────────
  try {
    const { data: logsF2 } = await supa
      .from('pieuvre_b2b_hunter_log')
      .select('id, driver_id, thread_id, contacted_at, target_name, contact_email, outreach_count')
      .is('replied_at', null)
      .lte('contacted_at', f2Cutoff)
      .gt('contacted_at', silentCutoff)
      .eq('outreach_count', 2);

    for (const log of (logsF2 ?? []) as any[]) {
      try {
        await sendFollowup(log, 'FOLLOWUP_2');
        result.followup2++;
      } catch (err: any) {
        console.error('[FinderFollowupCron] F2 error:', err.message);
        result.errors++;
      }
    }
  } catch (err: any) {
    console.error('[FinderFollowupCron] F2 query error:', err.message);
    result.errors++;
  }

  // ── SILENT : J+15 sans réponse, outreach_count ≥ 3 ───────────
  try {
    const { data: logsSilent } = await supa
      .from('pieuvre_b2b_hunter_log')
      .select('id, thread_id')
      .is('replied_at', null)
      .lte('contacted_at', silentCutoff)
      .gte('outreach_count', 3);

    for (const log of (logsSilent ?? []) as any[]) {
      try {
        await supa.from('pieuvre_b2b_hunter_log').update({ status: 'SILENT' }).eq('id', log.id);

        if (log.thread_id) {
          await supa
            .from('finder_email_threads')
            .update({ status: 'CLOSED_LOST' })
            .eq('id', log.thread_id);
        }
        result.silent++;
      } catch (err: any) {
        console.error('[FinderFollowupCron] Silent error:', err.message);
        result.errors++;
      }
    }
  } catch (err: any) {
    console.error('[FinderFollowupCron] Silent query error:', err.message);
    result.errors++;
  }

  result.durationMs = Date.now() - t0;
  console.log(
    `[FinderFollowupCron] ✅ Done — F1: ${result.followup1}, F2: ${result.followup2}, SILENT: ${result.silent}, errors: ${result.errors}, ${result.durationMs}ms`,
  );
  return result;
}

// ── Envoi d'un followup individuel ─────────────────────────────
async function sendFollowup(log: any, type: 'FOLLOWUP_1' | 'FOLLOWUP_2'): Promise<void> {
  const supa = getSupa();
  if (!log.contact_email) {
    console.log(`[FinderFollowupCron] No email for log ${log.id}, skip`);
    return;
  }

  const placeName: string = log.target_name ?? 'votre établissement';
  const subject =
    type === 'FOLLOWUP_1'
      ? `Suite — chauffeur partenaire pour ${placeName}`
      : `Dernière relance — réseau FOREAS pour ${placeName}`;

  const body =
    type === 'FOLLOWUP_1'
      ? `Bonjour,

Je me permets de revenir vers vous concernant la mise à disposition d'un chauffeur partenaire FOREAS pour ${placeName}.

Un simple oui de votre part suffit pour organiser la mise en relation.

Très bonne journée,
Ajnaya — Relations partenaires FOREAS`
      : `Bonjour,

Dernière relance de ma part, promis. Si vous avez un intérêt, même futur, un mot suffit pour que nous gardions le contact actif.

Sans retour, je laisse votre dossier en pause côté FOREAS.

Très bonne journée,
Ajnaya — Relations partenaires FOREAS`;

  const { generateOptoutToken } = await import('../services/OptoutService.js');
  const optoutToken = generateOptoutToken(log.contact_email);
  const optoutUrl = `https://foreas.xyz/optout/${optoutToken}`;
  const footer =
    '\n\n--\nAjnaya — Relations partenaires FOREAS\nforeas.xyz\n\n' +
    `Si vous ne souhaitez plus recevoir de messages : ${optoutUrl}`;

  // Envoi Resend
  let resendMsgId: string | null = null;
  // Adressage déterministe via logId (Ajnaya2026v87.3)
  const { buildFromHeader } = await import('../services/ThreadAddressing.js');
  const fromHeader = buildFromHeader(log.id);

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const res = await resend.emails.send({
      from: fromHeader,
      to: log.contact_email,
      subject,
      text: body + footer,
      headers: {
        'X-FOREAS-Source': 'finder-followup',
        'X-FOREAS-Log-Id': log.id,
      },
    });

    if (res.error) throw new Error(res.error.message);
    resendMsgId = res.data?.id ?? null;
  } catch (err: any) {
    console.error(`[FinderFollowupCron] Resend error for log ${log.id}:`, err.message);
    throw err;
  }

  // Log message
  if (log.thread_id) {
    await supa.from('finder_email_messages').insert({
      thread_id: log.thread_id,
      direction: 'OUT',
      sequence_type: type,
      from_email: fromHeader,
      to_email: log.contact_email,
      subject,
      body_text: body,
      resend_msg_id: resendMsgId,
      sent_at: new Date().toISOString(),
    });

    await supa
      .from('finder_email_threads')
      .update({
        messages_count: ((log.messages_count ?? 1) as number) + 1,
        last_message_at: new Date().toISOString(),
        last_direction: 'OUT',
      })
      .eq('id', log.thread_id);
  }

  // Update log
  await supa
    .from('pieuvre_b2b_hunter_log')
    .update({
      outreach_count: ((log.outreach_count ?? 1) as number) + 1,
      last_followup_at: new Date().toISOString(),
    })
    .eq('id', log.id);
}
