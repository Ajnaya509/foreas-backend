// src/lib/langgraph/agents/hunter.ts
// Placeholder fonctionnel — activera quand pieuvre_hunter_requests existera
import type { AjnayaStateType } from '../state';

export async function hunterAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  // Condition : uniquement pour les abonnes avec Stripe Connect
  if (!state.isSubscriber || !state.hasStripeConnect) {
    return { hunterResult: { hasPendingClient: false, clientPreview: null } };
  }

  try {
    // V1 : Placeholder — retourne false tant que les tables Private Hunter V2 ne sont pas creees
    // FUTUR (quand pieuvre_hunter_requests existera) :
    // const { data: pendingRequests } = await supabase
    //   .from("pieuvre_hunter_requests")
    //   .select("*")
    //   .eq("status", "pending")
    //   .limit(1);

    return {
      hunterResult: { hasPendingClient: false, clientPreview: null },
    };
  } catch (error: any) {
    return {
      hunterResult: { hasPendingClient: false, clientPreview: null },
      errors: [{ agent: 'hunter', error: error.message }],
    };
  }
}
