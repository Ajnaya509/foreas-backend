// Shared Supabase client for LangGraph agents
// Uses service_role key (RLS disabled on pieuvre_ tables)
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = (
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  'https://fihvdvlhftcxhlnocqiq.supabase.co'
).trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
