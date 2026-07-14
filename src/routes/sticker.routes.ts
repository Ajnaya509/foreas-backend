/**
 * sticker.routes.ts — Autocollant / carte QR du chauffeur, prêt à imprimer.
 * ═══════════════════════════════════════════════════════════════════════════
 * GET /api/driver-site/sticker/:slug            → carte 55×85 mm (SVG print)
 * GET /api/driver-site/sticker/:slug?format=rond → sticker Ø 80 mm appuie-tête
 *
 * Design validé Chandler 2026-07-02 (maquette v2 conversion) :
 *   - vouvoiement client, bénéfice AVANT le QR, réassurance 3 mots
 *   - carte  : « Gardez votre chauffeur. »
 *   - rond   : « Gardez-moi pour la prochaine fois » (lu PENDANT la course)
 *   - TRUTHFUL : la pastille promo n'apparaît QUE si promo_discount_percent > 0 ;
 *     la note ★ n'apparaît QUE si rating > 0. Jamais de faux chiffre.
 *
 * Le QR pointe vers {site}/c/{slug}?src=qr (même tracking que qr_data existant).
 * SVG vectoriel = source d'impression parfaite (Gelato : conversion PDF au moment
 * de l'intégration commande — étape suivante du chantier E).
 */
import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';

const router = Router();

let supabaseAdmin: any = null;
async function getSupa() {
  if (!supabaseAdmin) {
    const { createClient } = await import('@supabase/supabase-js');
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return supabaseAdmin;
}

const OBSIDIAN = '#0B0F1E';
const VIOLET = '#8C52FF';
const CYAN = '#00D4FF';
const CYAN_ICE = '#6DEAFF';
const TEXT_HERO = '#F8FAFC';
const TEXT_SUB = '#8A9BB5';
const QR_BG = '#F5F7FB';

/** QR en <svg> imbriqué, positionné/dimensionné dans le canvas parent. */
async function qrSvg(url: string, x: number, y: number, size: number): Promise<string> {
  const raw = await QRCode.toString(url, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: OBSIDIAN, light: QR_BG },
  });
  // Le SVG généré porte xmlns+viewBox ; on l'imbrique avec position + taille.
  return raw.replace('<svg ', `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Carte 55×85 mm portrait (unités = 1/10 mm → viewBox 550×850). */
async function renderCarte(site: any, qrUrl: string): Promise<string> {
  const name = esc(site.display_name || 'Votre chauffeur');
  const rating =
    site.rating && Number(site.rating) > 0
      ? ` · ★ ${Number(site.rating).toFixed(1).replace('.', ',')}`
      : '';
  const promo =
    site.promo_discount_percent && Number(site.promo_discount_percent) > 0
      ? `−${Number(site.promo_discount_percent)} % sur votre 1re réservation`
      : '';
  const qr = await qrSvg(qrUrl, 165, 380, 220);
  const initial = esc((site.display_name || 'F').trim().charAt(0).toUpperCase());

  return `<svg xmlns="http://www.w3.org/2000/svg" width="55mm" height="85mm" viewBox="0 0 550 850">
<defs><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${CYAN}"/></linearGradient></defs>
<rect width="550" height="850" rx="36" fill="${OBSIDIAN}"/>
<rect x="6" y="6" width="538" height="838" rx="32" fill="none" stroke="url(#brand)" stroke-width="5"/>
<text x="275" y="88" text-anchor="middle" fill="${CYAN_ICE}" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600" letter-spacing="10">FOREAS</text>
<circle cx="275" cy="172" r="52" fill="#161D30" stroke="${VIOLET}" stroke-width="3"/>
<text x="275" y="192" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="52" font-weight="700">${initial}</text>
<text x="275" y="280" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700">${name}${rating}</text>
<text x="275" y="316" text-anchor="middle" fill="${TEXT_SUB}" font-family="Helvetica, Arial, sans-serif" font-size="24">votre chauffeur privé</text>
<text x="275" y="366" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700">Gardez votre chauffeur.</text>
${qr}
${
  promo
    ? `<rect x="85" y="628" width="380" height="56" rx="28" fill="url(#brand)"/>
<text x="275" y="665" text-anchor="middle" fill="#FFFFFF" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600">${esc(promo)}</text>`
    : ''
}
<text x="275" y="${promo ? 738 : 690}" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="600">Scannez · Réservez · Prix fixe</text>
<text x="275" y="${promo ? 778 : 730}" text-anchor="middle" fill="${TEXT_SUB}" font-family="Helvetica, Arial, sans-serif" font-size="22">confirmation directe sur WhatsApp</text>
</svg>`;
}

/** Sticker rond Ø 80 mm (viewBox 800×800) — lu pendant la course. */
async function renderRond(site: any, qrUrl: string): Promise<string> {
  const name = esc(site.display_name || 'votre chauffeur');
  const rating =
    site.rating && Number(site.rating) > 0
      ? ` · ★ ${Number(site.rating).toFixed(1).replace('.', ',')}`
      : '';
  const promo =
    site.promo_discount_percent && Number(site.promo_discount_percent) > 0
      ? `−${Number(site.promo_discount_percent)} % à la 1re réservation`
      : '';
  const qr = await qrSvg(qrUrl, 290, 260, 220);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="80mm" viewBox="0 0 800 800">
<defs><linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${CYAN}"/></linearGradient></defs>
<circle cx="400" cy="400" r="400" fill="${OBSIDIAN}"/>
<circle cx="400" cy="400" r="392" fill="none" stroke="url(#brand)" stroke-width="6"/>
<text x="400" y="130" text-anchor="middle" fill="${CYAN_ICE}" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="600" letter-spacing="10">FOREAS</text>
<text x="400" y="192" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="700">Gardez-moi pour</text>
<text x="400" y="236" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="36" font-weight="700">la prochaine fois</text>
${qr}
<text x="400" y="548" text-anchor="middle" fill="${TEXT_HERO}" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600">${name}${rating} · prix fixe</text>
${
  promo
    ? `<rect x="205" y="576" width="390" height="52" rx="26" fill="url(#brand)"/>
<text x="400" y="611" text-anchor="middle" fill="#FFFFFF" font-family="Helvetica, Arial, sans-serif" font-size="25" font-weight="600">${esc(promo)}</text>`
    : ''
}
<text x="400" y="${promo ? 672 : 620}" text-anchor="middle" fill="${TEXT_SUB}" font-family="Helvetica, Arial, sans-serif" font-size="22">Scannez · Réservez · WhatsApp direct</text>
</svg>`;
}

// GET /api/driver-site/sticker/:slug?format=carte|rond
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const format = req.query.format === 'rond' ? 'rond' : 'carte';

    const supa = await getSupa();
    const { data: site, error } = await supa
      .from('driver_sites')
      .select('slug, display_name, rating, promo_discount_percent, is_active')
      .eq('slug', slug)
      .single();

    if (error || !site || !site.is_active) {
      return res.status(404).json({ error: 'Site chauffeur introuvable' });
    }

    const backendUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    const qrUrl = `${backendUrl}/c/${site.slug}?src=qr`;

    const svg = format === 'rond' ? await renderRond(site, qrUrl) : await renderCarte(site, qrUrl);

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="foreas-${format}-${site.slug}.svg"`);
    return res.send(svg);
  } catch (err: any) {
    console.error('[Sticker] Error:', err.message);
    return res.status(500).json({ error: 'Génération autocollant impossible' });
  }
});

export const stickerRouter = router;
