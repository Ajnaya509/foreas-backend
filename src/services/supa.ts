import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supaSrv: SupabaseClient | null = null;

function getSupaSrv(): SupabaseClient {
  if (!_supaSrv) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.warn('[Supa] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — supa.ts disabled');
      throw new Error('Supabase not configured');
    }
    _supaSrv = createClient(url, key, { auth: { persistSession: false } });
  }
  return _supaSrv;
}

export const supaSrv = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupaSrv() as any)[prop];
  },
});

export async function getUserIdByEmail(email: string): Promise<string> {
  try {
    const { data, error } = await supaSrv.from('users').select('id').eq('email', email).single();

    if (error || !data) {
      const userId = crypto.randomUUID();
      const { data: newUser, error: createError } = await supaSrv
        .from('users')
        .insert({ id: userId, email })
        .select('id')
        .single();

      if (createError) {
        throw new Error(`Failed to create user: ${createError.message}`);
      }
      return newUser!.id;
    }

    return data.id;
  } catch (err) {
    console.error('Error in getUserIdByEmail:', err);
    throw err;
  }
}

export async function saveAjnayaMessage(
  userId: string,
  message: string,
  response: string,
): Promise<void> {
  try {
    const { error } = await supaSrv
      .from('ajnaya_messages')
      .insert({ user_id: userId, message, response });

    if (error) {
      throw new Error(`Failed to save message: ${error.message}`);
    }
  } catch (err) {
    console.error('Error saving Ajnaya message:', err);
    throw err;
  }
}

export async function todayUserMessageCount(userId: string): Promise<number> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { count, error } = await supaSrv
      .from('ajnaya_messages')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', `${today}T00:00:00.000Z`)
      .lte('created_at', `${today}T23:59:59.999Z`);

    if (error) {
      console.error('Error counting messages:', error);
      return 0;
    }
    return count || 0;
  } catch (err) {
    console.error('Error in todayUserMessageCount:', err);
    return 0;
  }
}

export async function savePushToken(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  try {
    const { error } = await supaSrv
      .from('push_tokens')
      .upsert({ user_id: userId, token, platform }, { onConflict: 'user_id,token' });

    if (error) {
      throw new Error(`Failed to save push token: ${error.message}`);
    }
  } catch (err) {
    console.error('Error saving push token:', err);
    throw err;
  }
}

// ── Subscription helpers (used by Stripe webhooks) ──

export async function upsertUserByEmail(email: string): Promise<{ id: string }> {
  const id = await getUserIdByEmail(email);
  return { id };
}

export async function setSubscriptionStatus(data: {
  userId: string;
  provider: string;
  status: string;
  currentPeriodEnd: string | null;
  productId?: string | null;
}): Promise<void> {
  const { error } = await supaSrv.from('user_subscriptions').upsert(
    {
      user_id: data.userId,
      provider: data.provider,
      status: data.status,
      current_period_end: data.currentPeriodEnd,
      product_id: data.productId || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );

  if (error) {
    console.error('[Supa] setSubscriptionStatus error:', error.message);
    throw error;
  }

  console.log(`[Supa] Subscription ${data.status} for user ${data.userId}`);
}

export async function logEvent(userId: string | null, type: string, payload: any): Promise<void> {
  try {
    const { error } = await supaSrv.from('event_log').insert({
      user_id: userId,
      event_type: type,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });

    if (error) {
      // Non-blocking: log but don't throw
      console.warn('[Supa] logEvent warning:', error.message);
    }
  } catch (err) {
    console.warn('[Supa] logEvent failed silently:', err);
  }
}
