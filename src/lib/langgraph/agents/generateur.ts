// src/lib/langgraph/agents/generateur.ts
import Anthropic from '@anthropic-ai/sdk';
import type { AjnayaStateType } from '../state';
import {
  AJNAYA_BASE_SYSTEM_PROMPT,
  AJNAYA_STRATEGY_RULES,
} from '../../../constants/ajnayaPersonality';
import { buildVerifiableProofs, formatProofsForPrompt } from '../../../utils/verifiabilite';
import { supabase } from '../supabase';

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_KEY,
});

// v66 — ADN Ajnaya depuis la source unique de vérité (constants/ajnayaPersonality.ts)
// AJNAYA_BASE_SYSTEM_PROMPT + AJNAYA_STRATEGY_RULES importés ci-dessus

export async function generateurAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    // ==========================================
    // CONSTRUCTION DU SYSTEM PROMPT DYNAMIQUE
    // ==========================================
    const systemParts: string[] = [];

    // 1. ADN Ajnaya + Stratégie (source unique de vérité)
    systemParts.push(AJNAYA_BASE_SYSTEM_PROMPT);
    systemParts.push(`\n${AJNAYA_STRATEGY_RULES}`);

    // 2. Contexte strategique
    systemParts.push(
      `\n## Strategie pour cette reponse\n- Ton : ${state.strategy.tone}\n- Mots maximum : ${state.strategy.maxWords}\n- Emojis : ${state.strategy.includeEmoji ? 'oui, chirurgicaux' : 'non'}\n- Sujets a eviter : ${state.strategy.avoidTopics.join(', ') || 'aucun'}`,
    );

    // 3. Donnees contextuelles
    if (state.profile) {
      const p = state.profile as any;
      const name = p.first_name || p.name || '';
      systemParts.push(
        `\n## Interlocuteur\n- Prenom : ${name}\n- Statut : ${state.isSubscriber ? 'abonne' : state.isDriver ? 'inscrit non-abonne' : 'prospect'}\n- Score engagement : ${p.score || 0}/10`,
      );
    }

    // 4. Signaux temps reel
    if (state.nearbyEvents.length > 0) {
      const eventsStr = state.nearbyEvents
        .map(
          (e: any) =>
            `${e.event_name} a ${e.venue || e.city}, ${new Date(e.starts_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}, ~${e.expected_attendance || '?'} personnes`,
        )
        .join('\n');
      systemParts.push(`\n## Evenements a venir (donnees publiques verifiables)\n${eventsStr}`);
    }

    if (state.gtfsDisruptions.length > 0) {
      const disruptStr = state.gtfsDisruptions
        .map(
          (d: any) =>
            `Perturbation ${d.disruption_type} sur ${d.line} (${d.severity}), ~${d.estimated_passenger_impact} passagers impactes, surge prevu x${d.vtc_surge_prediction} dans ${d.vtc_surge_eta_minutes}min`,
        )
        .join('\n');
      systemParts.push(
        `\n## Perturbations transport actives (donnees publiques verifiables)\n${disruptStr}`,
      );
    }

    if (state.zoneIntelligence) {
      const z = state.zoneIntelligence as any;
      systemParts.push(
        `\n## Intelligence zone actuelle\n- Zone : ${z.zone_name}\n- Tarif moyen : ${z.avg_fare} euros\n- euros/heure moyen : ${z.avg_euro_per_hour} euros\n- Volume : ${z.volume} courses/creneau\n- Recommandation : ${z.recommendation || 'aucune'}`,
      );
    }

    // 5. Historique prospect pre-inscription (si converti depuis Pieuvre)
    if (state.prospectOriginChannel) {
      const daysLabel =
        state.prospectDaysToConvert !== null
          ? `${state.prospectDaysToConvert} jour(s) avant son inscription`
          : 'avant son inscription';
      systemParts.push(
        `\n## Historique avant inscription\n` +
          `- Canal d'acquisition : ${state.prospectOriginChannel}\n` +
          `- Score engagement à la conversion : ${state.prospectScoreAtConversion}/10\n` +
          `- Il t'a rencontré via ${state.prospectOriginChannel} (${daysLabel})\n` +
          `- Son historique Pieuvre est inclus dans l'historique de conversation ci-dessus\n` +
          `→ Tu connais ce chauffeur DEPUIS AVANT son inscription. Tu n'es pas en train de te présenter.`,
      );
    }

    // 7. Private Hunter (si client en attente)
    if (state.hunterResult.hasPendingClient) {
      systemParts.push(
        `\n## CLIENT PRIVE EN ATTENTE (PRIORITE)\n${state.hunterResult.clientPreview}\nMentionne-le naturellement.`,
      );
    }

    // 8. Parrainage (si bon moment)
    if (state.strategy.ctaType === 'referral') {
      systemParts.push(
        `\n## Moment parrainage\n- Filleuls actuels : ${state.referralResult.totalReferrals}\n- Gains parrainage : ${state.referralResult.monthlyEarnings} euros/mois\nGlisse naturellement l'idee du parrainage, comme une suggestion entre potes.`,
      );
    }

    // 9. Compta (si demande)
    if (state.strategy.priorityInfo.includes('financial_data') && state.comptaResult) {
      systemParts.push(
        `\n## Donnees financieres du chauffeur\n- Gains cumules : ${state.comptaResult.monthlyEarnings} euros\n- Gains aujourd'hui : ${(state.profile as any)?.earnings_today || 0} euros`,
      );
    }

    // 10. Closing script (si applicable)
    if (state.strategy.closingScript) {
      systemParts.push(`\n## Script de closing actif\n${state.strategy.closingScript}`);
    }

    // 11. RGPD response
    if (state.strategy.rgpdResponse) {
      systemParts.push(
        `\n## REPONSE RGPD OBLIGATOIRE\nLe chauffeur demande des donnees sur d'autres chauffeurs. Reponds naturellement que tu ne peux pas divulguer qui fait combien (RGPD). Propose des donnees AGREGEES de sa zone a la place. Ton naturel, pas robotique.`,
      );
    }

    // 12. VerifabiliteGuard — seuls faits chiffrés autorisés (tirés de la DB)
    const detectedZone = (state.zoneIntelligence as any)?.zone_name || null;
    const driverId = (state as any).driverId || null;
    const proofs = await buildVerifiableProofs(driverId, detectedZone, supabase);
    systemParts.push(
      `\n## PREUVES VÉRIFIABLES (seuls faits chiffrés autorisés)\n${formatProofsForPrompt(proofs)}`,
    );

    const systemPrompt = systemParts.join('\n');

    // ==========================================
    // CONSTRUCTION DES MESSAGES
    // ==========================================
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Historique (max 10 messages)
    const recentHistory = state.conversationHistory.slice(-10);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Message actuel
    messages.push({ role: 'user', content: state.rawMessage });

    // ==========================================
    // APPEL CLAUDE API
    // ==========================================
    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      temperature: 0.7,
      system: systemPrompt,
      messages,
    });

    const responseText = completion.content[0].type === 'text' ? completion.content[0].text : '';

    const tokensUsed =
      (completion.usage?.input_tokens || 0) + (completion.usage?.output_tokens || 0);
    const costUsd =
      ((completion.usage?.input_tokens || 0) * 3 + (completion.usage?.output_tokens || 0) * 15) /
      1_000_000;

    // Detection sentiment simple
    let sentiment: string | null = null;
    if (/merci|super|top|parfait|g[eé]nial/i.test(state.rawMessage)) sentiment = 'positive';
    else if (/marre|frustr[eé]|nul|arnaque|gal[eè]re|cher/i.test(state.rawMessage))
      sentiment = 'negative';
    else sentiment = 'neutral';

    return {
      response: responseText,
      llmModel: 'claude-sonnet-4-6',
      llmTokens: tokensUsed,
      llmCostUsd: costUsd,
      sentiment,
    };
  } catch (error: any) {
    console.error('❌ [GENERATEUR] Error:', error.message, error.status || '', error.code || '');
    return {
      response:
        'Court-circuit de mon côté — pas toi, moi. Redonne-moi une minute et repose ta question.',
      errors: [{ agent: 'generateur', error: error.message }],
    };
  }
}
