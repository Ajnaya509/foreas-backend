/**
 * CommunauteModerationService — v104 Communauté v3
 * ============================================================
 * Modération intelligente des posts de la Communauté via Claude Opus 4.7.
 *
 * Règles absolues (gravées dans le prompt système) :
 *   ACCEPTÉ : infos terrain (contrôles, pièges, surge, zones, météo),
 *             entraide (questions, réponses, anecdotes), astuces pratiques.
 *   REJETÉ  : publicité directe, publicité indirecte, promotion groupes
 *             concurrents, vente matériel/service, codes promo externes,
 *             attaques personnelles, propos haineux, appel à fraude.
 *
 * Multi-langues : français, anglais, arabe littéraire, darija marocaine,
 * arabe algérien/tunisien, verlan, argot, wolof, bambara, portugais,
 * roumain, turc, urdu, franglais, francarabe.
 *
 * Si publicité détectée → retour avec `redirect_to_ajnaya: true` + contexte
 * pour que le frontend ouvre Ajnaya chat avec un message cross-sell
 * "deviens Partenaire FOREAS".
 */
import Anthropic from '@anthropic-ai/sdk';

const OPUS_MODEL = 'claude-opus-4-5-20251101'; // Opus 4.7 (dernier disponible en prod)
const MAX_TOKENS = 400;

// ─── Types ──────────────────────────────────────────────────────────────

export type Categorie = 'alerte' | 'entraide' | 'astuce';
export type PromotionType =
  | 'service_commercial'
  | 'concurrent_group'
  | 'recruiting'
  | 'referral_scheme'
  | 'product_sale';

export interface ModerationInput {
  content: string;
  hasMedia: boolean;
  hasAudio: boolean;
  authorId: string;
  authorDisplayName?: string;
  geoLabel?: string;
}

export interface ModerationVerdict {
  verdict: 'accept' | 'reject';
  category: Categorie | null;
  sousType: string | null;
  reason: string | null;
  confidence: number; // 0-1
  redirectToAjnaya: boolean;
  promotionType: PromotionType | null;
  cleanContent: string | null; // contenu normalisé (orthographe, etc.) si accept
}

// ─── Client Anthropic singleton ─────────────────────────────────────────

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY non configuré — modération Communauté indisponible');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

// ─── System prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es modérateur de la Communauté FOREAS, un hub VTC Paris pour chauffeurs professionnels.

RÈGLES STRICTES :

ACCEPTER (classer dans une catégorie) :
- Alerte : contrôle police/BOER/URSSAF/DGCCRF/Municipal/DREAL, piège client, zone chaude (surge), arnaque, problème ponctuel (manif, embouteillage grave, accident).
- Entraide : question (panne, conseil, recommandation), demande d'aide, anecdote bienveillante, remerciement à un autre chauffeur.
- Astuce : station de charge, parking, bon plan carburant, tip métier durable (gérer client ivre, éviter erreur fiscale, etc.).

Sous-types possibles :
- alerte : boer, urssaf, dgccrf, municipal, dreal, bac, piege, zone_chaude, surge, manif, accident
- entraide : panne, question, conseil, anecdote, remerciement
- astuce : station_charge, parking, carburant, fiscal, materiel, tip_metier

REJETER (avec raison claire) :
- Publicité directe : "Commande mon service X", "Voici mon site", "Je vends", promo de soi.
- Publicité indirecte : "Rejoins mon groupe Telegram/WhatsApp", "Je recrute des chauffeurs", parrainage vers plateforme externe.
- Promotion de service concurrent à FOREAS : bonus referral Uber/Bolt/Heetch, formations payantes, coachings.
- Vente matériel/voiture/service.
- Codes promo externes.
- Attaques personnelles, propos haineux, discriminations.
- Appel à fraude, triche, comportements illégaux.
- Contenu sexuel, violent, choquant.
- Spam, posts répétés, tests vides.

IMPORTANT :
- Tu comprends toutes les langues : français, anglais, arabe littéraire, darija (marocain/algérien/tunisien), verlan, argot VTC, wolof, bambara, portugais, roumain, urdu, turc, mélanges (francarabe, franglais).
- Les fautes d'orthographe, émojis, abréviations (T2E, BOER, RAS, A86, jumelles, bobo, dab) sont NORMALES — jamais une raison de rejet.
- Les messages courts (3-5 mots) sont NORMAUX et souvent les plus utiles.
- Les photos/vidéos de contrôles sont acceptées si elles servent l'info terrain.

RÉPONSE : STRICTEMENT un JSON valide, rien d'autre. Pas de markdown, pas de prose avant/après.

Format exact :
{
  "verdict": "accept" | "reject",
  "category": "alerte" | "entraide" | "astuce" | null,
  "sousType": "boer" | "urssaf" | ... | null,
  "reason": "Phrase courte, neutre, respectueuse si rejet. Sinon null.",
  "confidence": 0.0 à 1.0,
  "redirectToAjnaya": true si le post est de la pub (directe ou indirecte) → le frontend va ouvrir Ajnaya chat pour proposer le programme Partenaire FOREAS,
  "promotionType": "service_commercial" | "concurrent_group" | "recruiting" | "referral_scheme" | "product_sale" | null,
  "cleanContent": "Version normalisée (orthographe corrigée, accents rétablis) SI verdict=accept. Préserve l'argot, les abréviations métier, les émojis. Sinon null."
}`;

// ─── Appel API ──────────────────────────────────────────────────────────

export async function moderatePost(input: ModerationInput): Promise<ModerationVerdict> {
  const client = getClient();

  const userMessage = [
    `Poste à modérer (par chauffeur ${input.authorDisplayName || 'anonyme'}, id=${input.authorId}):`,
    `---`,
    input.content,
    `---`,
    input.geoLabel ? `Géo : ${input.geoLabel}` : '',
    input.hasMedia ? 'Post avec photo/vidéo attachée.' : '',
    input.hasAudio ? 'Post avec audio PTT attaché.' : '',
    '',
    'Réponds en JSON strict selon le format demandé.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await client.messages.create({
      model: OPUS_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Opus sans réponse texte');
    }

    // Extraction JSON (Opus peut parfois encadrer de ```json ... ```)
    let raw = textBlock.text.trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) raw = fenced[1].trim();

    const parsed = JSON.parse(raw);

    // Validation stricte
    const verdict: 'accept' | 'reject' = parsed.verdict === 'accept' ? 'accept' : 'reject';
    const category =
      verdict === 'accept' && ['alerte', 'entraide', 'astuce'].includes(parsed.category)
        ? (parsed.category as Categorie)
        : null;

    return {
      verdict,
      category,
      sousType: parsed.sousType || null,
      reason: parsed.reason || null,
      confidence:
        typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
      redirectToAjnaya: Boolean(parsed.redirectToAjnaya),
      promotionType: parsed.promotionType || null,
      cleanContent: parsed.cleanContent || null,
    };
  } catch (err: any) {
    console.error('[CommunauteModerationService] Opus error:', err?.message);
    // Fallback sûr : on rejette plutôt que de laisser passer
    return {
      verdict: 'reject',
      category: null,
      sousType: null,
      reason: 'Modération indisponible, réessaie dans quelques instants.',
      confidence: 0,
      redirectToAjnaya: false,
      promotionType: null,
      cleanContent: null,
    };
  }
}

// ─── Message Ajnaya quand pub détectée (cross-sell Partenaire) ──────────

export function buildAjnayaSponsorshipMessage(
  firstName: string,
  rejectedContent: string,
  promotionType: PromotionType | null,
): string {
  const typeHint =
    promotionType === 'service_commercial'
      ? 'ton service'
      : promotionType === 'concurrent_group'
        ? 'ton groupe'
        : promotionType === 'recruiting'
          ? 'ton recrutement'
          : promotionType === 'referral_scheme'
            ? 'ton programme de parrainage'
            : promotionType === 'product_sale'
              ? 'ta vente'
              : 'ton annonce';

  return [
    `Salut ${firstName}, j'ai vu que tu voulais partager ${typeHint} avec les chauffeurs.`,
    ``,
    `On n'autorise pas les annonces commerciales dans la Communauté — c'est la règle pour que les infos terrain (contrôles, pièges, astuces) restent nettes et utiles à tout le monde.`,
    ``,
    `Par contre, tu peux devenir **Partenaire FOREAS** : tu soumets ton annonce dans le Dashboard Partenaire, elle passe en validation rapide côté admin, puis elle s'affiche aux chauffeurs de ta zone avec ton badge Partenaire vérifié. Audience ciblée VTC Paris, zéro fraude.`,
    ``,
    `Budget : tu définis le tien directement dans le Dashboard Partenaire — paiement CB sécurisé via Stripe, tu peux arrêter à tout moment.`,
    ``,
    `Dis-moi si tu veux que je t'ouvre le Dashboard Partenaire directement.`,
  ].join('\n');
}
