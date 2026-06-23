// src/lib/langgraph/agents/strategiste.ts
import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';

export async function strategisteAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    // ==========================================
    // FILTRE RGPD DUR — NON NEGOCIABLE
    // ==========================================
    const userAskedIndividualData =
      /combien .+ (gagne|fait|touche)|qui .+ (gagn[eé]|meilleur)/i.test(state.rawMessage);

    // ==========================================
    // LOGIQUE STRATEGIQUE
    // ==========================================
    const heatScore = (state.profile as any)?.score || 0;
    const isNewProspect = !state.isDriver && !state.isSubscriber;
    const lastMsg =
      state.conversationHistory.length > 0
        ? state.conversationHistory[state.conversationHistory.length - 1]?.content || ''
        : '';
    const isFrustrated =
      /gal[eè]re|frustr[eé]|marre|nul|arnaque|cher/i.test(lastMsg) ||
      /gal[eè]re|frustr[eé]|marre|nul|arnaque|cher/i.test(state.rawMessage);

    let tone = 'complice';
    let priorityInfo: string[] = [];
    let ctaType: string | null = null;
    let avoidTopics: string[] = [];
    let maxWords = 50;
    let closingScript: string | null = null;

    // Regle 1 : Prospect froid (heat_score < 3)
    if (isNewProspect && heatScore < 3) {
      tone = 'ecoute';
      maxWords = 30;
      avoidTopics = ['prix', 'abonnement', 'fonctionnalites'];
    }
    // Regle 2 : Prospect chaud (heat_score >= 5)
    else if (isNewProspect && heatScore >= 5) {
      tone = 'demonstration';
      ctaType = 'soft_scenario';
      if (state.nearbyEvents.length > 0) {
        priorityInfo.push('event_nearby');
      }
    }
    // Regle 3 : Chauffeur frustre
    else if (isFrustrated) {
      tone = 'soutien';
      avoidTopics = ['parrainage', 'client_finder', 'upsell'];
      maxWords = 30;
    }
    // Regle 4 : Client Private Hunter en attente
    else if (state.hunterResult.hasPendingClient) {
      tone = 'opportunite';
      priorityInfo = ['hunter_client'];
      maxWords = 60;
    }
    // Regle 5 : Bon moment parrainage
    else if (state.referralResult.isGoodMoment && !isFrustrated) {
      ctaType = 'referral';
      priorityInfo.push('referral_opportunity');
    }
    // Regle 6 : Question compta
    else if (
      /compta|gain|combien|chiffre|revenu|euros?|€/i.test(state.rawMessage) &&
      state.comptaResult
    ) {
      priorityInfo.push('financial_data');
    }

    // Charger le script de closing si necessaire
    if (ctaType === 'soft_scenario') {
      const { data: script } = await supabase
        .from('pieuvre_scripts')
        .select('prompt_system')
        .eq('tentacle', state.channel === 'whatsapp' ? 'closer_whatsapp' : 'widget_site')
        .eq('is_active', true)
        .order('conversion_rate', { ascending: false })
        .limit(1)
        .maybeSingle();

      closingScript = script?.prompt_system || null;
    }

    return {
      strategy: {
        tone,
        priorityInfo,
        ctaType,
        avoidTopics,
        maxWords,
        includeEmoji: true,
        rgpdResponse: userAskedIndividualData,
        closingScript,
      },
    };
  } catch (error: any) {
    return {
      strategy: {
        tone: 'empathique',
        priorityInfo: [],
        ctaType: null,
        avoidTopics: [],
        maxWords: 50,
        includeEmoji: true,
        rgpdResponse: false,
        closingScript: null,
      },
      errors: [{ agent: 'strategiste', error: error.message }],
    };
  }
}
