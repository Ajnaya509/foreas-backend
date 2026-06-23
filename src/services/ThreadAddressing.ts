/**
 * ThreadAddressing — Adressage déterministe des emails Ajnaya
 * Ajnaya2026v87.3
 *
 * Principe : chaque log B2B a son adresse de réponse unique.
 *   Outbound:  from = "Ajnaya FOREAS <log-{logIdNoDashes}@reply.foreas.xyz>"
 *   Inbound :  to   = "log-{logIdNoDashes}@reply.foreas.xyz" → on extrait le logId
 *
 * Garantit un match 100% déterministe entre chaque reply et son thread,
 * SANS dépendre du header In-Reply-To (qui est réécrit par SES/mail clients).
 */

const REPLY_DOMAIN = 'reply.foreas.xyz';

/** Construit l'adresse de réponse unique pour un log B2B. */
export function buildReplyAddress(logId: string): string {
  // On strip les dashes pour rester compatible avec la plupart des validations d'email
  const localPart = `log-${logId.replace(/-/g, '')}`;
  return `${localPart}@${REPLY_DOMAIN}`;
}

/** Construit le champ `from` complet pour un envoi Ajnaya. */
export function buildFromHeader(logId: string, displayName = 'Ajnaya FOREAS'): string {
  return `${displayName} <${buildReplyAddress(logId)}>`;
}

/**
 * Parse une adresse email inbound pour en extraire le logId (UUID avec dashes).
 * Retourne `null` si ce n'est pas une adresse de réponse Ajnaya valide.
 *
 * Formats acceptés (robustes aux variations) :
 *   log-{32hex}@reply.foreas.xyz            → "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *   log-{8hex}-{4hex}-{4hex}-{4hex}-{12hex}@reply.foreas.xyz
 */
export function parseLogIdFromAddress(rawAddress: string): string | null {
  if (!rawAddress) return null;

  // Strip display name : "Foo <email>" → "email"
  const m = rawAddress.match(/<([^>]+)>/);
  const address = (m?.[1] ?? rawAddress).trim().toLowerCase();

  // Ne matche que notre domaine
  if (!address.endsWith(`@${REPLY_DOMAIN}`)) return null;

  const localPart = address.slice(0, -`@${REPLY_DOMAIN}`.length);

  // Format strippé : log-{32hex}
  const stripped = localPart.match(/^log-([0-9a-f]{32})$/i);
  if (stripped) {
    const h = stripped[1];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  // Format avec dashes : log-{uuid}
  const dashed = localPart.match(
    /^log-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (dashed) {
    return dashed[1].toLowerCase();
  }

  return null;
}
