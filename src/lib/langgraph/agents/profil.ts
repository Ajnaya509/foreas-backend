// src/lib/langgraph/agents/profil.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function profilAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    let profile: Record<string, unknown> | null = null;

    if (state.driverId) {
      // Essayer la fonction get_driver_full_context
      const { data, error } = await supabase.rpc('get_driver_full_context', {
        p_driver_id: state.driverId,
      });

      if (data && !error) {
        profile = data;
      } else {
        // Fallback : requete manuelle
        const { data: driver } = await supabase
          .from('drivers')
          .select(
            'id, first_name, last_name, name, phone, email, total_rides, total_earnings, earnings_today, average_rating, status, is_online, last_active, subscription_status, subscription_active, subscription_price, subscription_start_date, created_at',
          )
          .eq('id', state.driverId)
          .single();

        if (driver) {
          profile = { ...driver, source: 'driver' };
        }
      }
    } else if (state.prospectId) {
      const { data: prospect } = await supabase
        .from('pieuvre_prospects')
        .select('*')
        .eq('id', state.prospectId)
        .single();

      if (prospect) {
        profile = { ...prospect, source: 'prospect' };
      }
    }

    return { profile };
  } catch (error: any) {
    return {
      profile: null,
      errors: [{ agent: 'profil', error: error.message }],
    };
  }
}
