/**
 * EmailWarmupManager — Protection domaine (réputation sender)
 * Ajnaya2026v87.1
 *
 * Warmup strategy : on ne balance pas 500 emails/jour d'un domaine neuf.
 * Montée progressive pour construire la réputation Resend/SPF/DKIM.
 *
 *   Semaine 1 (J0-J6)   : 20 emails/jour total (tous drivers confondus)
 *   Semaine 2 (J7-J13)  : 50/jour
 *   Semaine 3 (J14-J20) : 100/jour
 *   Semaine 4+ (J21+)   : 300/jour (plafond)
 */

import { getSupabase } from '../lib/supabase.js';

export interface WarmupStatus {
  days_since_first_send: number;
  daily_cap: number;
  sent_today: number;
  remaining_today: number;
  can_send: boolean;
}

export async function checkWarmupStatus(): Promise<WarmupStatus> {
  const supa = getSupabase();

  // Date du premier envoi jamais (finder_email_messages direction OUT + sequence INITIAL)
  const { data: firstMsg } = await supa
    .from('finder_email_messages')
    .select('sent_at')
    .eq('direction', 'OUT')
    .eq('sequence_type', 'INITIAL')
    .not('sent_at', 'is', null)
    .order('sent_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const firstSentAt = (firstMsg as any)?.sent_at as string | null;
  const daysSinceFirst = firstSentAt
    ? Math.floor((Date.now() - new Date(firstSentAt).getTime()) / 86400000)
    : 0;

  let dailyCap: number;
  if (daysSinceFirst < 7) dailyCap = 20;
  else if (daysSinceFirst < 14) dailyCap = 50;
  else if (daysSinceFirst < 21) dailyCap = 100;
  else dailyCap = 300;

  // Envois INITIAL aujourd'hui
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { count } = await supa
    .from('finder_email_messages')
    .select('*', { count: 'exact', head: true })
    .eq('direction', 'OUT')
    .eq('sequence_type', 'INITIAL')
    .gte('sent_at', todayStart.toISOString());

  const sentToday = count ?? 0;

  return {
    days_since_first_send: daysSinceFirst,
    daily_cap: dailyCap,
    sent_today: sentToday,
    remaining_today: Math.max(0, dailyCap - sentToday),
    can_send: sentToday < dailyCap,
  };
}
