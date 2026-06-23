// src/lib/langgraph/agents/persistance.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function persistanceAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    // 1. Sauver le message inbound
    await supabase.from('pieuvre_conversations').insert({
      prospect_id: state.prospectId || null,
      driver_id: state.driverId || null,
      tentacle: 'brain',
      channel: state.channel,
      direction: 'inbound',
      message_type: 'chat',
      content: state.rawMessage,
      sentiment: state.sentiment,
      metadata: {},
    });

    // 2. Sauver le message outbound (reponse Ajnaya)
    await supabase.from('pieuvre_conversations').insert({
      prospect_id: state.prospectId || null,
      driver_id: state.driverId || null,
      tentacle: 'brain',
      channel: state.channel,
      direction: 'outbound',
      message_type: 'chat',
      content: state.response,
      llm_model: state.llmModel,
      llm_tokens: state.llmTokens,
      llm_cost_usd: state.llmCostUsd,
      sentiment: state.sentiment,
      conversion_event: state.strategy.ctaType !== null,
      metadata: {
        strategy: state.strategy.tone,
        errors: state.errors.length > 0 ? state.errors : undefined,
      },
    });

    // 3. Mettre a jour pieuvre_prospects (si prospect)
    if (state.prospectId) {
      await supabase
        .from('pieuvre_prospects')
        .update({
          conversations_count: Math.floor(state.conversationHistory.length / 2) + 1,
          last_conversation_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', state.prospectId);
    }

    return {};
  } catch (error: any) {
    // La persistance qui echoue ne doit PAS bloquer la reponse
    return {
      errors: [{ agent: 'persistance', error: error.message }],
    };
  }
}
