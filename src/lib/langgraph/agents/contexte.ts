// src/lib/langgraph/agents/contexte.ts
// v68 — Prospect ↔ Driver bridge intégré
// Charge l'historique cross-canal : app + historique prospect pre-inscription

import { supabase } from '../supabase';
import type { AjnayaStateType } from '../state';
import { loadFullProspectContext } from '../../../helpers/prospectBridge';

export async function contexteAgent(state: AjnayaStateType): Promise<Partial<AjnayaStateType>> {
  try {
    const messages: Array<{ role: string; content: string; channel: string; created_at: string }> =
      [];
    let prospectOriginChannel: string | null = null;
    let prospectScoreAtConversion = 0;
    let prospectDaysToConvert: number | null = null;
    let resolvedProspectId: string | null = state.prospectId;

    // ──────────────────────────────────────────────
    // A. PONT PROSPECT ↔ DRIVER (in-app uniquement)
    // ──────────────────────────────────────────────
    // Si on est in_app et qu'on a un driverId mais pas de prospectId :
    // → chercher dans foreas_identity_bridge si ce driver vient d'un prospect Pieuvre
    if (state.channel === 'in_app' && state.driverId && !state.prospectId) {
      try {
        const prospectCtx = await loadFullProspectContext(state.driverId);

        if (prospectCtx) {
          resolvedProspectId = prospectCtx.prospectId;
          prospectOriginChannel = prospectCtx.acquisitionChannel;
          prospectScoreAtConversion = prospectCtx.scoreAtConversion;
          prospectDaysToConvert = prospectCtx.daysToConvert;

          // Injecter l'historique prospect dans les messages (canal d'origine visible)
          for (const msg of prospectCtx.conversationHistory) {
            messages.push({
              role: msg.role,
              content: msg.content,
              channel: msg.channel, // whatsapp, widget_site, etc.
              created_at: msg.created_at,
            });
          }

          console.log(
            `[Contexte] 🔗 Prospect history loaded: ${prospectCtx.conversationHistory.length} msgs ` +
              `(canal: ${prospectCtx.acquisitionChannel}, score: ${prospectCtx.scoreAtConversion}, ` +
              `j+${prospectCtx.daysToConvert ?? '?'} avant inscription)`,
          );
        }
      } catch (bridgeErr: any) {
        // Non-fatal : si le bridge échoue, on continue sans historique prospect
        console.warn('[Contexte] ⚠️ Prospect bridge lookup failed (non-fatal):', bridgeErr.message);
      }
    }

    // ──────────────────────────────────────────────
    // B. HISTORIQUE APP (pieuvre_conversations)
    // ──────────────────────────────────────────────
    // Charge les conversations app-side du chauffeur (ou du prospect si widget/WhatsApp)
    const effectiveProspectId = resolvedProspectId;
    const effectiveDriverId = state.driverId;

    if (effectiveProspectId || effectiveDriverId) {
      const query = supabase
        .from('pieuvre_conversations')
        .select('direction, content, channel, created_at')
        .order('created_at', { ascending: false })
        .limit(15);

      if (effectiveDriverId) {
        // Driver prioritaire (in_app) : charge ses conversations app
        query.eq('driver_id', effectiveDriverId);
      } else if (effectiveProspectId) {
        // Prospect only (widget/WhatsApp) : charge ses conversations acquisition
        query.eq('prospect_id', effectiveProspectId);
      }

      const { data } = await query;
      if (data) {
        for (const msg of data) {
          // Éviter les doublons avec l'historique prospect déjà chargé
          const isDuplicate = messages.some(
            (m) => m.created_at === msg.created_at && m.content === (msg.content || ''),
          );
          if (!isDuplicate) {
            messages.push({
              role: msg.direction === 'inbound' ? 'user' : 'assistant',
              content: msg.content || '',
              channel: msg.channel || 'unknown',
              created_at: msg.created_at,
            });
          }
        }
      }
    }

    // Trier tous les messages par date croissante (prospect history → app history)
    messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    return {
      conversationHistory: messages,
      prospectOriginChannel,
      prospectScoreAtConversion,
      prospectDaysToConvert,
    };
  } catch (error: any) {
    return {
      conversationHistory: [],
      prospectOriginChannel: null,
      prospectScoreAtConversion: 0,
      prospectDaysToConvert: null,
      errors: [{ agent: 'contexte', error: error.message }],
    };
  }
}
