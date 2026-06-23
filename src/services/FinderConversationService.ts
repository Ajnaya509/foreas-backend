/**
 * FinderConversationService — Ajnaya gère la conversation email de bout en bout
 * Ajnaya2026v87
 *
 * Flux :
 *   1. handleInboundEmail()  — webhook Resend Inbound reçoit un reply
 *   2. detectIntent()         — Claude Sonnet catégorise le message
 *   3. Router selon intention :
 *      - INTERESTED / HANDOFF_REQUEST → prepareHandoff() (brief + numéro dédié + push)
 *      - NOT_INTERESTED              → closeThread(CLOSED_LOST)
 *      - QUESTION_* / OBJECTION_*    → sendAjnayaResponse() (auto-reply)
 *   4. Max 4 aller-retours, au-delà → escalade humaine (SILENT)
 *
 * Règles Ajnaya :
 *   - Vouvoiement absolu
 *   - Jamais de prénom chauffeur avant handoff
 *   - Aucune invention (pas de chiffres non validés)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EmailIntent } from '../types/clientFinder.js';
import { ALL_EMAIL_INTENTS } from '../types/clientFinder.js';
import { isEmailOptedOut, generateOptoutToken } from './OptoutService.js';
import { buildFromHeader, parseLogIdFromAddress } from './ThreadAddressing.js';

export type SupportedLang = 'fr' | 'en' | 'es' | 'it';

const MAX_EXCHANGES_BEFORE_CLOSE = 4;

// ── Lazy Supabase service role ────────────────────────────────────
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  _supa = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _supa;
}

// ── Entry point : webhook Resend Inbound ─────────────────────────
export async function handleInboundEmail(params: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  inReplyTo?: string;
  inboundMessageId?: string; // RFC 5322 Message-ID du prospect → pour threading
  svixId?: string;
  rawPayload?: any;
}): Promise<void> {
  const supa = getSupa();

  // ═══════════════════════════════════════════════════════════════
  // STRATÉGIE DÉTERMINISTE : le `to` contient le logId (log-{id}@reply.foreas.xyz)
  // On le parse → on retrouve le thread directement via log_id.
  // ═══════════════════════════════════════════════════════════════
  const logIdFromAddress = parseLogIdFromAddress(params.to);

  let thread: any = null;

  if (logIdFromAddress) {
    const { data } = await supa
      .from('finder_email_threads')
      .select('*')
      .eq('log_id', logIdFromAddress)
      .maybeSingle();
    thread = data;

    if (thread) {
      console.log(
        `[FinderConversation] ✅ Thread résolu via logId=${logIdFromAddress} → thread=${thread.id}`,
      );
    } else {
      console.warn(
        `[FinderConversation] ⚠️ logId=${logIdFromAddress} extrait de l'adresse mais aucun thread trouvé`,
      );
    }
  }

  // Rétro-compat : legacy threads envoyés sans adressage unique (avant v87.3)
  if (!thread && params.inReplyTo) {
    const { data: legacyMsg } = await supa
      .from('finder_email_messages')
      .select('thread_id')
      .eq('resend_msg_id', params.inReplyTo)
      .maybeSingle();

    if (legacyMsg) {
      const { data: legacyThread } = await supa
        .from('finder_email_threads')
        .select('*')
        .eq('id', (legacyMsg as any).thread_id)
        .maybeSingle();
      thread = legacyThread;
      if (thread) {
        console.log(
          `[FinderConversation] 📦 Legacy thread résolu via inReplyTo → thread=${thread.id}`,
        );
      }
    }
  }

  // ── Orphan DLQ : aucun match → on stocke dans finder_inbound_orphans ──
  if (!thread) {
    console.warn(
      `[FinderConversation] 📪 Orphan inbound email (to=${params.to}, from=${params.from}, subject="${params.subject}") → stocké dans DLQ`,
    );
    try {
      await supa.from('finder_inbound_orphans').insert({
        from_email: params.from,
        to_email: params.to,
        subject: params.subject,
        body_text: params.bodyText,
        in_reply_to: params.inReplyTo ?? null,
        svix_id: params.svixId ?? null,
        raw_payload: params.rawPayload ?? null,
      });
    } catch (err: any) {
      console.error('[FinderConversation] Failed to insert orphan DLQ:', err?.message ?? err);
    }
    return;
  }

  // Thread pas OPEN → log + ignore (sauf HANDOFF_PENDING où on veut juste tracker)
  if (thread.status !== 'OPEN') {
    console.log(
      `[FinderConversation] Thread ${thread.id} status=${thread.status} — reply loggée sans traitement`,
    );
    // On logue quand même le message entrant pour traçabilité
    await supa.from('finder_email_messages').insert({
      thread_id: thread.id,
      direction: 'IN',
      sequence_type: 'REPLY',
      from_email: params.from,
      to_email: params.to,
      subject: params.subject,
      body_text: params.bodyText,
      resend_msg_id: params.inboundMessageId ?? null,
      received_at: new Date().toISOString(),
    });
    return;
  }

  // Logger le message entrant — on stocke le Message-ID RFC 5322 du prospect
  // pour pouvoir l'utiliser dans le header In-Reply-To de notre réponse
  await supa.from('finder_email_messages').insert({
    thread_id: thread.id,
    direction: 'IN',
    sequence_type: 'REPLY',
    from_email: params.from,
    to_email: params.to,
    subject: params.subject,
    body_text: params.bodyText,
    resend_msg_id: params.inboundMessageId ?? null,
    received_at: new Date().toISOString(),
  });

  await supa
    .from('finder_email_threads')
    .update({
      messages_count: (thread.messages_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_direction: 'IN',
    })
    .eq('id', thread.id);

  await supa
    .from('pieuvre_b2b_hunter_log')
    .update({
      status: 'REPLIED',
      replied_at: new Date().toISOString(),
    })
    .eq('id', thread.log_id);

  // Intent detection (Claude Sonnet)
  const intent = await detectIntent(params.bodyText);
  console.log(`[FinderConversation] Thread ${thread.id} — intent: ${intent}`);

  // Routing
  if (intent === 'HANDOFF_REQUEST' || intent === 'INTERESTED') {
    await prepareHandoff(thread.id, thread.driver_id, thread.log_id, {
      inboundMessageId: params.inboundMessageId,
      prospectEmail: params.from,
    });
    return;
  }

  if (intent === 'NOT_INTERESTED') {
    await closeThread(thread.id, 'CLOSED_LOST');
    return;
  }

  // Anti-boucle : >4 échanges → escalade humaine
  if ((thread.messages_count ?? 0) >= MAX_EXCHANGES_BEFORE_CLOSE * 2) {
    await flagForHumanEscalation(thread.id);
    return;
  }

  // Auto-response de Ajnaya
  await sendAjnayaResponse(thread.id, intent, {
    from: params.from,
    to: params.to,
    subject: params.subject,
    inboundMessageId: params.inboundMessageId,
  });
}

// ── Intent detection via Claude Sonnet ───────────────────────────
// Cette fonction est UNIQUEMENT utilisée pour le routing (handoff vs auto-response vs close).
// La génération de la réponse elle-même est conversationnelle (voir buildResponsePrompt).
export async function detectIntent(bodyText: string): Promise<EmailIntent> {
  if (!bodyText || bodyText.trim().length === 0) {
    console.warn('[FinderConversation] detectIntent called with empty bodyText');
    return 'UNCLEAR';
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 20,
      messages: [
        {
          role: 'user',
          content: `Tu analyses UN message reçu d'un prospect B2B (conciergerie / direction d'hôtel) en réponse à une prise de contact d'Ajnaya (commerciale FOREAS, réseau de chauffeurs VTC).

Retourne EXACTEMENT UN mot parmi cette liste :

HANDOFF_REQUEST — le prospect demande explicitement à parler au chauffeur, à recevoir un contact, un numéro, un RDV téléphonique, ou à être mis en relation
INTERESTED — le prospect montre un signal clair d'intérêt ("oui", "ça m'intéresse", "pourquoi pas", "dites m'en plus", "quand pouvez-vous", "ok", "volontiers"...)
QUESTION_PRICE — question directe sur prix / tarifs / coût / commission
QUESTION_AVAILABILITY — question sur disponibilités / horaires / jours
QUESTION_VEHICLE — question sur véhicule / modèle / équipements / capacité
OBJECTION_ALREADY_PARTNER — déclare avoir déjà un chauffeur / prestataire
OBJECTION_PRICE — dit que c'est trop cher ou craint un coût élevé
OBJECTION_NOT_NOW — reporte, dit "pas maintenant", "on verra plus tard", "je reviens vers vous"
NOT_INTERESTED — refus explicite, "pas intéressé", "merci mais non", "on ne souhaite pas"
UNCLEAR — aucun des précédents ne colle (à utiliser le moins possible)

RÈGLES IMPORTANTES :
- Un simple "oui pourquoi pas ?" ou "oui ok" ou "allez-y" = INTERESTED (pas UNCLEAR).
- Une question qui commence par "combien" / "quel prix" = QUESTION_PRICE.
- "Envoyez-moi ses coordonnées" / "dites-lui de m'appeler" = HANDOFF_REQUEST.
- En cas de doute entre INTERESTED et UNCLEAR → choisis INTERESTED.
- En cas de doute entre HANDOFF_REQUEST et INTERESTED → choisis HANDOFF_REQUEST.

Message à classer :
"""
${bodyText.slice(0, 2000)}
"""

Réponds par UN SEUL mot (aucune explication, aucune ponctuation) :`,
        },
      ],
    });

    const text = ((response.content[0] as any).text as string)
      .trim()
      .split(/\s/)[0]
      .replace(/[^A-Z_]/g, '');
    return ALL_EMAIL_INTENTS.includes(text as EmailIntent) ? (text as EmailIntent) : 'UNCLEAR';
  } catch (err: any) {
    console.error('[FinderConversation] detectIntent error:', err.message);
    return 'UNCLEAR';
  }
}

// ── Détection langue (Claude Haiku, peu cher) ────────────────────
export async function detectLanguage(text: string): Promise<SupportedLang> {
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: `Quelle langue ? Réponds en 2 lettres exactement parmi : fr, en, es, it.\nSi autre langue, réponds fr.\n\nTexte :\n"${text.slice(0, 200)}"`,
        },
      ],
    });

    const lang = ((response.content[0] as any).text as string).trim().toLowerCase().slice(0, 2);

    return (['fr', 'en', 'es', 'it'].includes(lang) ? lang : 'fr') as SupportedLang;
  } catch (err: any) {
    console.error('[FinderConversation] detectLanguage error:', err.message);
    return 'fr';
  }
}

// ── Ajnaya répond automatiquement ───────────────────────────────────
async function sendAjnayaResponse(
  threadId: string,
  intent: EmailIntent,
  original: { from: string; to: string; subject: string; inboundMessageId?: string },
): Promise<void> {
  const supa = getSupa();

  // v87.1 — Respect opt-out list avant toute chose
  if (await isEmailOptedOut(original.from)) {
    console.log(`[FinderConversation] Skip opted-out: ${original.from}`);
    await closeThread(threadId, 'CLOSED_LOST');
    return;
  }

  const { data: thread } = await supa
    .from('finder_email_threads')
    .select('*')
    .eq('id', threadId)
    .single();
  if (!thread) return;

  const { data: vehicle } = await supa
    .from('driver_vehicle_profile')
    .select('*')
    .eq('driver_id', (thread as any).driver_id)
    .maybeSingle();

  // Contexte du prospect : hunter_log (business name, type, adresse, contact)
  const { data: log } = await supa
    .from('pieuvre_b2b_hunter_log')
    .select('business_name,business_type,business_address,contact_name,target_name')
    .eq('id', (thread as any).log_id)
    .maybeSingle();

  // Historique complet du thread — les 10 derniers messages dans l'ordre chrono
  const { data: history } = await supa
    .from('finder_email_messages')
    .select('direction,body_text,subject,created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(20);

  const historyMessages = (history ?? []) as any[];
  const lastInboundBody =
    [...historyMessages].reverse().find((m) => m.direction === 'IN')?.body_text ?? '';

  // v87.1 — Détection langue du prospect (basée sur le dernier message entrant)
  const lang = await detectLanguage(lastInboundBody);

  const prompt = buildResponsePrompt(intent, thread, log, vehicle, historyMessages, lang);

  let parsed: { subject: string; body: string };
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = ((response.content[0] as any).text as string)
      .replace(/```json\n?|```\n?/g, '')
      .trim();
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error('[FinderConversation] sendAjnayaResponse LLM error:', err.message);
    // Fallback minimal — on garde le subject cohérent avec le thread
    const threadSubj = ((thread as any).thread_subject ?? '').replace(/^(Re:\s*)+/i, '');
    parsed = {
      subject: `Re: ${threadSubj}`,
      body: 'Merci de votre retour. Je vous mets en relation avec notre équipe pour une réponse plus précise dans la journée.\n\nAjnaya',
    };
  }

  // Envoi via Resend — adressage déterministe via log_id
  const logId = (thread as any).log_id as string;
  const fromHeader = buildFromHeader(logId);

  // ─────────────────────────────────────────────────────────────
  // 1. SUBJECT FORCÉ : toujours "Re: <thread_subject>" (cohérence threading)
  // ─────────────────────────────────────────────────────────────
  const rawThreadSubject = ((thread as any).thread_subject ?? '').replace(/^(re:\s*)+/i, '').trim();
  const forcedSubject = rawThreadSubject ? `Re: ${rawThreadSubject}` : parsed.subject;

  // ─────────────────────────────────────────────────────────────
  // 2. NOTRE PROPRE MESSAGE-ID RFC 5322 (contrôle total du threading)
  // ─────────────────────────────────────────────────────────────
  const crypto = await import('crypto');
  const ourMessageId = `<foreas-${crypto.randomUUID()}@reply.foreas.xyz>`;

  // ─────────────────────────────────────────────────────────────
  // 3. Threading headers : References = tous les Message-ID précédents + In-Reply-To
  // ─────────────────────────────────────────────────────────────
  const { data: threadMsgs } = await supa
    .from('finder_email_messages')
    .select('resend_msg_id')
    .eq('thread_id', threadId)
    .not('resend_msg_id', 'is', null)
    .order('created_at', { ascending: true });

  // On ne garde QUE les IDs au format RFC 5322 (entre chevrons)
  const allPreviousIds = (threadMsgs ?? [])
    .map((m: any) => m.resend_msg_id as string)
    .filter((id: string | null) => id && id.startsWith('<'));

  const inReplyToHeader = original.inboundMessageId ?? allPreviousIds[allPreviousIds.length - 1];

  // Le prospect doit voir nos anciens Message-IDs dans References pour grouper
  const referencesHeader = allPreviousIds.join(' ');

  const threadingHeaders: Record<string, string> = {
    'Message-ID': ourMessageId,
    'X-FOREAS-Thread-Id': threadId,
  };
  if (inReplyToHeader) threadingHeaders['In-Reply-To'] = inReplyToHeader;
  if (referencesHeader) threadingHeaders['References'] = referencesHeader;

  let sendFailed = false;
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const optoutToken = generateOptoutToken(original.from);
    const optoutUrl = `https://foreas.xyz/optout/${optoutToken}`;
    const footer =
      '\n\n--\nAjnaya — Relations partenaires FOREAS\nforeas.xyz\n\n' +
      `Si vous ne souhaitez plus recevoir de messages : ${optoutUrl}`;

    const result = await resend.emails.send({
      from: fromHeader,
      to: original.from,
      subject: forcedSubject,
      text: parsed.body + footer,
      headers: threadingHeaders,
    });

    if (result.error) throw new Error(result.error.message);
  } catch (err: any) {
    console.error('[FinderConversation] Resend send error:', err.message);
    sendFailed = true;
  }

  // Logger le message sortant — on stocke NOTRE Message-ID (pas l'id interne Resend)
  // pour que les futurs References soient correctement chaînés
  await supa.from('finder_email_messages').insert({
    thread_id: threadId,
    direction: 'OUT',
    sequence_type: sendFailed ? 'REPLY_FAILED' : 'REPLY',
    from_email: fromHeader,
    to_email: original.from,
    subject: forcedSubject,
    body_text: parsed.body,
    resend_msg_id: ourMessageId, // <-- RFC 5322, alimente References chain
    intent_detected: intent,
    sent_at: new Date().toISOString(),
  });

  await supa
    .from('finder_email_threads')
    .update({
      messages_count: ((thread as any).messages_count ?? 0) + 1,
      last_message_at: new Date().toISOString(),
      last_direction: 'OUT',
    })
    .eq('id', threadId);
}

// ── Prompt builder ────────────────────────────────────────────────
function buildResponsePrompt(
  intent: EmailIntent,
  thread: any,
  log: any,
  vehicle: any,
  history: any[],
  lang: SupportedLang = 'fr',
): string {
  const langName: Record<SupportedLang, string> = {
    fr: 'français',
    en: 'anglais',
    es: 'espagnol',
    it: 'italien',
  };
  const signature: Record<SupportedLang, string> = {
    fr: 'Ajnaya',
    en: 'Ajnaya',
    es: 'Ajnaya',
    it: 'Ajnaya',
  };

  // ── Contexte chauffeur / véhicule ──
  const vehicleDesc = vehicle
    ? `${vehicle.make ?? ''} ${vehicle.model ?? ''} ${vehicle.year ?? ''}, ${vehicle.color ?? 'récente'}`.trim()
    : 'véhicule récent';
  const featuresDesc: string = Array.isArray(vehicle?.features) ? vehicle.features.join(', ') : '';
  const commercialNameLine = vehicle?.commercial_name
    ? `Nom commercial du chauffeur : ${vehicle.commercial_name}`
    : '';

  // ── Contexte prospect (business) ──
  const businessName = log?.business_name ?? log?.target_name ?? 'cet établissement';
  const businessType = log?.business_type ?? '';
  const businessAddress = log?.business_address ?? '';
  const contactName = log?.contact_name ?? '';

  // ── Historique de la conversation : les 15 derniers messages chronologiquement ──
  const lastMsgs = (history ?? []).slice(-15);
  const conversationLog = lastMsgs
    .map((m: any) => {
      const who = m.direction === 'OUT' ? 'Ajnaya (toi)' : 'Prospect';
      const body = (m.body_text ?? '').replace(/\n{3,}/g, '\n\n').slice(0, 800);
      return `── ${who} ──\n${body}`;
    })
    .join('\n\n');

  // ── Classification d'intent : juste un signal, pas une instruction rigide ──
  const intentSignals: Record<EmailIntent, string> = {
    INTERESTED: 'le prospect semble intéressé',
    QUESTION_PRICE: 'le prospect interroge sur les tarifs',
    QUESTION_AVAILABILITY: 'le prospect interroge sur les disponibilités',
    QUESTION_VEHICLE: 'le prospect interroge sur le véhicule',
    OBJECTION_ALREADY_PARTNER: 'le prospect a déjà un prestataire',
    OBJECTION_PRICE: 'le prospect exprime une objection prix',
    OBJECTION_NOT_NOW: 'le prospect repousse le sujet',
    NOT_INTERESTED: 'le prospect refuse',
    HANDOFF_REQUEST: 'le prospect demande un contact direct',
    UNCLEAR: "l'intention n'est pas évidente",
  };

  return `Tu es AJNAYA, assistante commerciale du réseau FOREAS — une communauté de chauffeurs VTC professionnels parisiens.
Tu écris à une conciergerie/direction d'établissement B2B qui reçoit régulièrement des clients ayant besoin de transport.

TON RÔLE :
Tu n'es pas un bot de catégorisation. Tu es une commerciale qui fait avancer une vente. À chaque message, ton job est de :
1. Répondre PRÉCISÉMENT à ce que le prospect vient de dire — pas avec une réponse-type.
2. Maintenir un rapport humain et chaleureux (sans être mielleuse).
3. Pousser DOUCEMENT vers la seule action qui compte : la mise en relation directe avec le chauffeur partenaire.
4. Si le prospect pose une question, tu y réponds. S'il objecte, tu traites l'objection. S'il est ambigu, tu clarifies AVEC une question ouverte.
5. Si la conversation tourne en rond depuis 2-3 échanges sans progresser, propose un appel direct ou la mise en relation immédiate pour débloquer.

PROSPECT CIBLE :
- Établissement : ${businessName}${businessType ? ` (${businessType})` : ''}
- Adresse : ${businessAddress || 'Paris'}
- Contact : ${contactName || 'Direction / conciergerie'}

CHAUFFEUR PARTENAIRE DISPONIBLE POUR CE PROSPECT :
- Véhicule : ${vehicleDesc}
${featuresDesc ? `- Équipements : ${featuresDesc}` : ''}
${commercialNameLine}

HISTORIQUE DE LA CONVERSATION (chronologique) :
${conversationLog || '(première réponse)'}

SIGNAL D'INTENT DU DERNIER MESSAGE :
${intentSignals[intent] ?? 'intention non identifiée'}
(Ce n'est qu'un signal, pas une directive rigide. Tu restes maîtresse du ton et de l'angle.)

RÈGLES DE LANGUE (PRIORITAIRE) :
- Réponds EXCLUSIVEMENT en ${langName[lang]}, sujet + corps.

RÈGLES ABSOLUES (non négociables) :
- Vouvoiement strict (aucun tutoiement).
- Tu représentes FOREAS, pas un chauffeur nommé. NE RÉVÈLE JAMAIS le prénom du chauffeur avant le handoff officiel.
- 3-6 phrases MAX. Court, dense, naturel.
- JAMAIS inventer de chiffres (tarifs, années d'expérience, nombre de courses, distances). Si on t'en demande, oriente vers "à discuter directement avec le chauffeur partenaire".
- Pas de formules mortes ("N'hésitez pas", "Cordialement", "Bien à vous"...). Tu signes juste "${signature[lang]}".
- Ne réponds JAMAIS avec un subject vide ou "Re: Votre demande" — reformule un subject qui reflète le sujet du fil.
- Si le prospect demande un contact direct, confirme-le et dis que le chauffeur partenaire les contacte dans l'heure.

SORTIE :
Retourne UNIQUEMENT ce JSON (pas de markdown, pas de commentaire) :
{"subject": "Re: <sujet du fil reformulé>", "body": "<ta réponse>"}`;
}

// ── Handoff : prépare brief + numéro dédié + push ────────────────
export async function prepareHandoff(
  threadId: string,
  driverId: string,
  logId: string,
  context?: { inboundMessageId?: string; prospectEmail?: string },
): Promise<void> {
  const supa = getSupa();

  const { data: log } = await supa
    .from('pieuvre_b2b_hunter_log')
    .select('*')
    .eq('id', logId)
    .maybeSingle();
  if (!log) {
    console.error(`[FinderConversation] ❌ Handoff impossible : log ${logId} introuvable`);
    return;
  }

  // 1. Générer le brief enrichi
  const brief = await generateHandoffBrief(log as any, threadId);

  // 2. Provisionner un numéro dédié (Twilio — stub si pas configuré)
  const dedicatedNumber = await provisionDedicatedNumber(
    driverId,
    (log as any).place_directory_id ?? null,
  );

  // 3. Marquer le log comme BRIEFED
  await supa
    .from('pieuvre_b2b_hunter_log')
    .update({
      status: 'BRIEFED',
      brief_content: brief,
      briefed_at: new Date().toISOString(),
      dedicated_number: dedicatedNumber,
      driver_notified_at: new Date().toISOString(),
    })
    .eq('id', logId);

  // 4. Passer le thread en HANDOFF_PENDING (plus de réponses auto d'Ajnaya)
  await supa
    .from('finder_email_threads')
    .update({
      status: 'HANDOFF_PENDING',
      last_direction: 'OUT',
      last_message_at: new Date().toISOString(),
    })
    .eq('id', threadId);

  // 5. Notifier le chauffeur (push → fallback email → fallback ops alert)
  const placeName = (log as any).business_name ?? (log as any).target_name ?? 'Un nouveau prospect';
  const notifResult = await notifyDriverHandoff(driverId, {
    placeName,
    brief,
    threadId,
    logId,
    prospectEmail: context?.prospectEmail ?? (log as any).contact_email ?? '',
  });

  // 6. Envoyer un email de confirmation au prospect
  if (context?.prospectEmail) {
    await sendProspectHandoffConfirmation({
      threadId,
      logId,
      prospectEmail: context.prospectEmail,
      inboundMessageId: context.inboundMessageId,
      placeName,
    });
  }

  console.log(
    `[FinderConversation] ✅ Handoff terminé — driver=${driverId} thread=${threadId} notif=${notifResult.channel} status=HANDOFF_PENDING`,
  );
}

// ── Notifier le chauffeur du handoff (chaîne de fallbacks) ────────
async function notifyDriverHandoff(
  driverId: string,
  details: {
    placeName: string;
    brief: any;
    threadId: string;
    logId: string;
    prospectEmail: string;
  },
): Promise<{ channel: 'push' | 'email' | 'ops_alert' | 'none'; success: boolean }> {
  const supa = getSupa();

  // Récupérer l'email du chauffeur via auth.admin.getUserById (nécessite service role)
  let driverEmail: string | undefined;
  try {
    const { data: authUser } = await supa.auth.admin.getUserById(driverId);
    driverEmail = authUser?.user?.email;
  } catch (err: any) {
    console.error(
      `[FinderConversation] auth.admin.getUserById failed for ${driverId}:`,
      err?.message ?? err,
    );
  }

  // Tentative 1 : push notification (TODO v88 — Expo push)
  // Pour l'instant, on passe direct à l'email

  // Tentative 2 : email au chauffeur via Resend (fallback robuste)
  if (driverEmail) {
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);

      const briefText = [
        `🎯 Nouveau prospect CHAUD — ${details.placeName}`,
        '',
        `Prospect : ${details.prospectEmail}`,
        '',
        "── Ce qu'il faut savoir ──",
        details.brief.what_ajnaya_said || '',
        '',
        '── Ce que le prospect attend ──',
        details.brief.contact_expects || '',
        '',
        '── Ouverture suggérée ──',
        details.brief.suggested_opening || '',
        '',
        details.brief.contact_phone ? `📞 Téléphone : ${details.brief.contact_phone}` : '',
        '',
        '── Action ──',
        'Contacte le prospect dans les 30 prochaines minutes (taux de conversion ÷2 après 1h).',
        'Réponds directement à cet email pour faire un retour à Ajnaya.',
        '',
        `Thread ID : ${details.threadId}`,
      ]
        .filter(Boolean)
        .join('\n');

      const result = await resend.emails.send({
        from: 'Ajnaya FOREAS <ajnaya@reply.foreas.xyz>',
        to: driverEmail,
        subject: `🔥 Lead chaud : ${details.placeName}`,
        text: briefText,
        headers: {
          'X-FOREAS-Source': 'handoff-driver-notif',
          'X-FOREAS-Thread-Id': details.threadId,
          'X-FOREAS-Log-Id': details.logId,
        },
      });

      if (result.error) throw new Error(result.error.message);

      console.log(
        `[FinderConversation] 📧 Handoff email envoyé au driver ${driverId} (${driverEmail})`,
      );
      return { channel: 'email', success: true };
    } catch (err: any) {
      console.error('[FinderConversation] Driver email notif failed:', err?.message ?? err);
    }
  } else {
    console.warn(`[FinderConversation] Aucun email trouvé pour driver ${driverId}`);
  }

  // Tentative 3 : alerte ops via Telegram/email admin (fallback ultime)
  const opsAlertEmail = process.env.FOREAS_OPS_ALERT_EMAIL;
  if (opsAlertEmail) {
    try {
      const { Resend } = await import('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Ajnaya FOREAS <ajnaya@reply.foreas.xyz>',
        to: opsAlertEmail,
        subject: `⚠️ Handoff impossible à livrer au driver ${driverId}`,
        text: `Prospect: ${details.prospectEmail}\nPlace: ${details.placeName}\nThread: ${details.threadId}\nLog: ${details.logId}\n\nLe chauffeur n'a ni email ni push token. Action manuelle requise.`,
      });
      return { channel: 'ops_alert', success: true };
    } catch (err: any) {
      console.error('[FinderConversation] Ops alert failed:', err?.message ?? err);
    }
  }

  return { channel: 'none', success: false };
}

// ── Envoyer un email de confirmation au prospect après handoff ─────
async function sendProspectHandoffConfirmation(params: {
  threadId: string;
  logId: string;
  prospectEmail: string;
  inboundMessageId?: string;
  placeName: string;
}): Promise<void> {
  const supa = getSupa();

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const crypto = await import('crypto');

    const fromHeader = buildFromHeader(params.logId);
    const ourMessageId = `<foreas-${crypto.randomUUID()}@reply.foreas.xyz>`;

    // Récupérer le subject du thread pour cohérence
    const { data: threadRow } = await supa
      .from('finder_email_threads')
      .select('thread_subject')
      .eq('id', params.threadId)
      .maybeSingle();
    const rawSubj = ((threadRow as any)?.thread_subject ?? '').replace(/^(re:\s*)+/i, '').trim();
    const forcedSubject = rawSubj
      ? `Re: ${rawSubj}`
      : `Re: Chauffeur partenaire pour ${params.placeName}`;

    // Construire les headers threading
    const { data: threadMsgs } = await supa
      .from('finder_email_messages')
      .select('resend_msg_id')
      .eq('thread_id', params.threadId)
      .not('resend_msg_id', 'is', null)
      .order('created_at', { ascending: true });

    const allIds = (threadMsgs ?? [])
      .map((m: any) => m.resend_msg_id as string)
      .filter((id: string | null) => id && id.startsWith('<'));

    const headers: Record<string, string> = {
      'Message-ID': ourMessageId,
      'X-FOREAS-Thread-Id': params.threadId,
    };
    if (params.inboundMessageId) headers['In-Reply-To'] = params.inboundMessageId;
    if (allIds.length > 0) headers['References'] = allIds.join(' ');

    const confirmationText = [
      'Parfait, merci pour votre retour.',
      '',
      'Je transmets immédiatement votre demande au chauffeur partenaire FOREAS concerné.',
      'Il prendra contact avec vous dans les 30 prochaines minutes.',
      '',
      'À très vite,',
      'Ajnaya — Relations partenaires FOREAS',
    ].join('\n');

    const result = await resend.emails.send({
      from: fromHeader,
      to: params.prospectEmail,
      subject: forcedSubject,
      text: confirmationText,
      headers,
    });

    if (result.error) throw new Error(result.error.message);

    // Logger avec NOTRE Message-ID
    await supa.from('finder_email_messages').insert({
      thread_id: params.threadId,
      direction: 'OUT',
      sequence_type: 'HANDOFF_CONFIRMATION',
      from_email: fromHeader,
      to_email: params.prospectEmail,
      subject: forcedSubject,
      body_text: confirmationText,
      resend_msg_id: ourMessageId,
      sent_at: new Date().toISOString(),
    });

    console.log(`[FinderConversation] 📧 Confirmation envoyée au prospect ${params.prospectEmail}`);
  } catch (err: any) {
    console.error(
      '[FinderConversation] sendProspectHandoffConfirmation error:',
      err?.message ?? err,
    );
  }
}

async function closeThread(threadId: string, status: 'CLOSED_WON' | 'CLOSED_LOST'): Promise<void> {
  const supa = getSupa();
  await supa.from('finder_email_threads').update({ status }).eq('id', threadId);
  console.log(`[FinderConversation] Thread ${threadId} closed → ${status}`);
}

async function flagForHumanEscalation(threadId: string): Promise<void> {
  const supa = getSupa();
  await supa.from('finder_email_threads').update({ status: 'SILENT' }).eq('id', threadId);
  // TODO v88 : ping Telegram DG pour escalade humaine
  console.log(`[FinderConversation] Thread ${threadId} flagged for human escalation`);
}

// ── Helpers (stubs à enrichir) ───────────────────────────────────
async function generateHandoffBrief(
  log: any,
  threadId: string,
): Promise<{
  what_ajnaya_said: string;
  contact_expects: string;
  suggested_opening: string;
  contact_phone: string | null;
}> {
  const supa = getSupa();

  // Récupérer les 5 derniers messages du thread pour contexte
  const { data: messages } = await supa
    .from('finder_email_messages')
    .select('direction, body_text, sent_at, received_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
    .limit(10);

  const conversation = (messages ?? [])
    .map(
      (m: any) =>
        `${m.direction === 'OUT' ? 'Ajnaya' : 'Prospect'}: ${(m.body_text ?? '').slice(0, 300)}`,
    )
    .join('\n');

  return {
    what_ajnaya_said: 'Un chauffeur partenaire FOREAS disponible pour votre établissement.',
    contact_expects: conversation.slice(0, 500),
    suggested_opening: `Bonjour, je suis le chauffeur partenaire FOREAS, Ajnaya m'a prévenu pour ${log?.business_name ?? log?.target_name ?? 'votre demande'}.`,
    contact_phone: log?.contact_phone ?? null,
  };
}

async function provisionDedicatedNumber(
  _driverId: string,
  _placeId: string | null,
): Promise<string | null> {
  // TODO v87.x : Appel Twilio API pour louer un numéro FR, forwarding vers driver
  // Requiert TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN dans env Railway
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log('[FinderConversation] Twilio not configured, skipping dedicated number');
    return null;
  }
  // Implementation Twilio à brancher ici
  return null;
}

async function sendDriverPushNotification(
  driverId: string,
  placeName: string,
  _suggestedOpening: string,
): Promise<void> {
  // TODO v87.x : Expo Push Notifications via expo_push_tokens
  console.log(`[FinderConversation] TODO push to driver ${driverId} for place ${placeName}`);
}
