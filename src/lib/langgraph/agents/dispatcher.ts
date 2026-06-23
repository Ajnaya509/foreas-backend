// src/lib/langgraph/agents/dispatcher.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function dispatcherAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    let isDriver = false;
    let isSubscriber = false;
    let hasStripeConnect = false;
    let daysSinceSubscription = 0;
    let prospectId = state.prospectId;
    let driverId = state.driverId;

    // Si on a un driverId, chercher le driver
    if (driverId) {
      const { data: driver } = await supabase
        .from('drivers')
        .select('id, subscription_active, stripe_account_id, subscription_start_date, is_active')
        .eq('id', driverId)
        .single();

      if (driver) {
        isDriver = true;
        isSubscriber = driver.subscription_active === true;
        hasStripeConnect = !!driver.stripe_account_id;
        if (driver.subscription_start_date) {
          const start = new Date(driver.subscription_start_date);
          daysSinceSubscription = Math.floor(
            (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24),
          );
        }
      }
    }

    // Si on a un prospectId mais pas de driverId, chercher le prospect
    if (prospectId && !driverId) {
      const { data: prospect } = await supabase
        .from('pieuvre_prospects')
        .select('id, driver_id, status')
        .eq('id', prospectId)
        .single();

      if (prospect?.driver_id) {
        driverId = prospect.driver_id;
        // Re-fetch driver info
        const { data: driver } = await supabase
          .from('drivers')
          .select('id, subscription_active, stripe_account_id, subscription_start_date')
          .eq('id', prospect.driver_id)
          .single();
        if (driver) {
          isDriver = true;
          isSubscriber = driver.subscription_active === true;
          hasStripeConnect = !!driver.stripe_account_id;
          if (driver.subscription_start_date) {
            const start = new Date(driver.subscription_start_date);
            daysSinceSubscription = Math.floor(
              (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24),
            );
          }
        }
      }
    }

    return {
      prospectId,
      driverId,
      isDriver,
      isSubscriber,
      hasStripeConnect,
      daysSinceSubscription,
    };
  } catch (error: any) {
    return {
      errors: [{ agent: 'dispatcher', error: error.message }],
    };
  }
}
