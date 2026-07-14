/**
 * PrintfulService — commande réelle du sticker QR imprimé (rond adhésif Ø80mm
 * ou carte 55×85mm) via l'API Printful v2, produit "Kiss-Cut Stickers" (id 358,
 * variant 10164 = 4″×4″, seul fournisseur du chantier qui imprime en adhésif —
 * Gelato ne fait aucun produit adhésif, vérifié sur son catalogue complet le 12/07).
 * Printful découpe automatiquement autour de la silhouette (canal alpha) du PNG/SVG
 * fourni — même variant pour le rond (Ø80mm) et la carte (55×85mm), tous deux
 * tenant dans le carré 4″×4″ (101,6mm).
 *
 * Gated sur PRINTFUL_API_KEY + PRINTFUL_STORE_ID + PRINTFUL_VARIANT_ROND /
 * PRINTFUL_VARIANT_CARTE : tant qu'ils ne sont pas configurés, createStickerOrder()
 * renvoie un échec explicite — jamais un faux succès qui laisserait un chauffeur
 * payé sans sticker en route.
 *
 * Contrat vérifié le 12/07 avec un vrai token (boutique "Boutique de Ajnaya",
 * store_id 18459118) : commande brouillon créée puis supprimée (order 166625745,
 * jamais confirmée, jamais facturée/expédiée). Le point piégeux : chaque order_item
 * prend `placements[].layers[].url`, PAS `files[].url` (première tentative rejetée
 * par l'API avec "Property `placements` is required").
 */

const PRINTFUL_API_BASE = 'https://api.printful.com/v2';

export interface PrintfulShippingAddress {
  name: string;
  address1: string;
  address2?: string | null;
  city: string;
  zip: string;
  countryCode: string;
  phone?: string | null;
  email?: string | null;
}

export interface PrintfulOrderResult {
  ok: boolean;
  printfulOrderId?: string;
  status?: string;
  error?: string;
}

export function isPrintfulConfigured(): boolean {
  return Boolean(process.env.PRINTFUL_API_KEY && process.env.PRINTFUL_STORE_ID);
}

function variantIdFor(format: 'rond' | 'carte'): string | null {
  return format === 'rond'
    ? process.env.PRINTFUL_VARIANT_ROND || null
    : process.env.PRINTFUL_VARIANT_CARTE || null;
}

async function printfulFetch(
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${PRINTFUL_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}`,
      'X-PF-Store-Id': process.env.PRINTFUL_STORE_ID as string,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/**
 * Crée puis confirme une commande Printful (draft → confirmation, jamais
 * confirmée directement — l'API v2 impose ce 2-temps). Un échec à N'IMPORTE
 * quelle étape est renvoyé explicitement à l'appelant, jamais avalé.
 */
export async function createStickerOrder(params: {
  format: 'rond' | 'carte';
  designFileUrl: string;
  address: PrintfulShippingAddress;
  externalId: string;
}): Promise<PrintfulOrderResult> {
  if (!isPrintfulConfigured()) {
    return { ok: false, error: 'printful_not_configured' };
  }
  const variantId = variantIdFor(params.format);
  if (!variantId) {
    return { ok: false, error: `printful_variant_missing_${params.format}` };
  }

  const draft = await printfulFetch('/orders', {
    method: 'POST',
    body: JSON.stringify({
      external_id: params.externalId,
      shipping: 'STANDARD',
      recipient: {
        name: params.address.name,
        address1: params.address.address1,
        address2: params.address.address2 || undefined,
        city: params.address.city,
        zip: params.address.zip,
        country_code: params.address.countryCode,
        phone: params.address.phone || undefined,
        email: params.address.email || undefined,
      },
      order_items: [
        {
          source: 'catalog',
          catalog_variant_id: Number(variantId),
          quantity: 1,
          placements: [
            {
              placement: 'default',
              technique: 'digital',
              layers: [{ type: 'file', url: params.designFileUrl }],
            },
          ],
        },
      ],
    }),
  });

  if (!draft.ok) {
    return {
      ok: false,
      error: draft.body?.error?.message || `printful_draft_failed_${draft.status}`,
    };
  }

  const orderId = draft.body?.data?.id ?? draft.body?.result?.id ?? draft.body?.id;
  if (!orderId) {
    return { ok: false, error: 'printful_draft_no_id' };
  }

  const confirm = await printfulFetch(`/orders/${orderId}/confirmation`, { method: 'POST' });
  if (!confirm.ok) {
    return {
      ok: false,
      printfulOrderId: String(orderId),
      error: confirm.body?.error?.message || `printful_confirm_failed_${confirm.status}`,
    };
  }

  return { ok: true, printfulOrderId: String(orderId), status: 'confirmed' };
}
