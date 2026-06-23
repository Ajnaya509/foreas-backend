/**
 * voicePurgeCron — Purge expired voice recordings (RGPD compliance)
 * Ajnaya2026v88
 * Runs daily. Deletes Twilio recordings where recording_expires_at < NOW().
 */
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

let supa: any = null;
function getDb() {
  if (!supa) supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  return supa;
}

export async function runVoicePurge(): Promise<{ purged: number; errors: number }> {
  const db = getDb();
  console.log('[VoicePurge] Starting recording purge...');

  const { data: expired } = await db
    .from('finder_voice_calls')
    .select('id, twilio_call_sid, recording_url')
    .lt('recording_expires_at', new Date().toISOString())
    .not('recording_url', 'is', null);

  if (!expired || expired.length === 0) {
    console.log('[VoicePurge] No expired recordings');
    return { purged: 0, errors: 0 };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  let twilioClient: any = null;
  if (sid && token) {
    twilioClient = twilio(sid, token);
  }

  let purged = 0;
  let errors = 0;

  for (const call of expired) {
    try {
      // Delete from Twilio if possible
      if (twilioClient && call.twilio_call_sid) {
        try {
          const recordings = await twilioClient.recordings.list({
            callSid: call.twilio_call_sid,
            limit: 10,
          });
          await Promise.all(recordings.map((r: any) => r.remove()));
        } catch (twilioErr: any) {
          // Recording might already be deleted
          console.warn(`[VoicePurge] Twilio delete warning for ${call.id}: ${twilioErr.message}`);
        }
      }

      // Clear URL in DB
      await db
        .from('finder_voice_calls')
        .update({
          recording_url: null,
          recording_expires_at: null,
        })
        .eq('id', call.id);

      purged++;
    } catch (err: any) {
      console.error(`[VoicePurge] Error purging ${call.id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[VoicePurge] Complete: ${purged} purged, ${errors} errors`);
  return { purged, errors };
}
