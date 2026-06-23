// src/lib/langgraph/agents/compta.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function comptaAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  if (!state.isSubscriber || !state.driverId) {
    return { comptaResult: null };
  }

  try {
    const { data: driver } = await supabase
      .from('drivers')
      .select('total_earnings, earnings_today')
      .eq('id', state.driverId)
      .single();

    if (!driver) return { comptaResult: null };

    return {
      comptaResult: {
        monthlyEarnings: driver.total_earnings || 0,
        projection: null,
        vsLastMonth: null,
        bestDay: null,
        bestZone: null,
      },
    };
  } catch (error: any) {
    return {
      comptaResult: null,
      errors: [{ agent: 'compta', error: error.message }],
    };
  }
}
