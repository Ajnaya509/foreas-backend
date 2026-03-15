/**
 * Driver Site Template — FOREAS v3.0
 * ═══════════════════════════════════
 * Template HTML client-facing pour les sites chauffeurs.
 * Flow booking 2 étapes:
 *   Step 1: Départ + Arrivée + Date/Heure → Prix instantané → "J'accepte — Réserver"
 *   Step 2: Animation tracé route (cyan→violet→cyan) + Paiement Stripe Elements inline
 *
 * Mobile-first, ultra-responsive, conversion-optimisé.
 * Aucune dépendance JS lourde (pas de React, pas de Mapbox GL JS).
 * Stripe.js chargé uniquement si le chauffeur a un compte Connect.
 */

// ─── Helper: service options par niche ─────────────────────────────────────

export function getNicheServiceOptions(niche?: string): string {
  const base = '<option value="transfer">Transfert / Trajet</option>';
  const options: Record<string, string> = {
    corporate:
      '<option value="corporate">Transport Business</option><option value="airport">Transfert Aéroport</option><option value="seminar">Séminaire / Événement</option>',
    evenementiel:
      '<option value="wedding">Mariage</option><option value="gala">Gala / Soirée</option><option value="event">Événement</option>',
    medical:
      '<option value="hospital">Hôpital / Clinique</option><option value="appointment">Rendez-vous Santé</option><option value="mobility">Mobilité réduite</option>',
    transfert:
      '<option value="airport">Aéroport</option><option value="station">Gare</option><option value="longdist">Longue distance</option>',
    nuit: '<option value="nightout">Sortie nocturne</option><option value="club">Club / Bar</option><option value="afterwork">After-work</option>',
    famille:
      '<option value="school">Trajet scolaire</option><option value="family">Sortie famille</option><option value="childcare">Avec siège enfant</option>',
    premium:
      '<option value="vip">Service VIP</option><option value="luxury">Luxe / Prestige</option><option value="concierge">Conciergerie</option>',
  };
  return base + (niche && options[niche] ? options[niche] : '<option value="other">Autre</option>');
}

// ─── Helper: bio auto-générée ──────────────────────────────────────────────

export function generateBio(
  name: string,
  city: string,
  rating: number,
  trips: number,
  languages: string[],
  niche?: string,
): string {
  const firstName = name.split(' ')[0];
  const langStr = languages.length > 1 ? languages.join(', ') : '';
  const tripsStr = trips > 50 ? `Fort de plus de ${trips} courses,` : '';
  const ratingStr = rating >= 4.5 ? `noté ${rating.toFixed(1)}/5 par ses passagers,` : '';

  const nicheIntros: Record<string, string> = {
    corporate: `${firstName} est un chauffeur VTC spécialisé dans les déplacements professionnels à ${city}. ${tripsStr} ${ratingStr} il garantit ponctualité et discrétion pour vos rendez-vous d'affaires et transferts aéroport.`,
    evenementiel: `${firstName} est votre chauffeur dédié pour vos événements à ${city}. ${tripsStr} ${ratingStr} mariages, galas et soirées, il assure un service élégant et sans stress.`,
    medical: `${firstName} est un chauffeur attentionné spécialisé dans les trajets médicaux à ${city}. ${tripsStr} ${ratingStr} il accompagne ses passagers avec patience et bienveillance.`,
    transfert: `${firstName} est expert des transferts aéroport et gare à ${city}. ${tripsStr} ${ratingStr} suivi des vols en temps réel et ponctualité garantie.`,
    nuit: `${firstName} est disponible en soirée et la nuit à ${city}. ${tripsStr} ${ratingStr} clubs, restaurants, sorties : rentrez en toute sécurité.`,
    famille: `${firstName} est un chauffeur familial équipé de sièges enfants à ${city}. ${tripsStr} ${ratingStr} patience et sécurité pour vos trajets en famille.`,
    premium: `${firstName} offre un service VTC haut de gamme à ${city}. ${tripsStr} ${ratingStr} véhicule premium et service sur-mesure pour vos déplacements d'exception.`,
  };

  const intro =
    niche && nicheIntros[niche]
      ? nicheIntros[niche]
      : `${firstName} est chauffeur VTC professionnel à ${city}. ${tripsStr} ${ratingStr} il vous garantit un trajet confortable et ponctuel.`;

  return `${intro}${langStr ? ` Langues parlées : ${langStr}.` : ''}`;
}

// ─── Main Template ─────────────────────────────────────────────────────────

export function renderDriverPage(
  site: any,
  source: string,
  options: {
    backendUrl: string;
    stripePublishableKey?: string;
    mapboxToken?: string;
  },
): string {
  const { backendUrl, stripePublishableKey, mapboxToken } = options;
  const rating = site.rating || 5;
  const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
  const siteUrl = `${backendUrl}/c/${site.slug}`;
  const themeColor = site.theme_color || '#8C52FF';
  const displayName = site.display_name || 'Chauffeur';
  const firstName = displayName.split(' ')[0];
  const city = site.city || 'France';

  const nicheLabels: Record<string, string> = {
    corporate: 'VTC Corporate',
    evenementiel: 'VTC Événementiel',
    medical: 'VTC Médical',
    transfert: 'VTC Transfert',
    nuit: 'VTC Nuit',
    famille: 'VTC Famille',
    premium: 'VTC Premium',
  };
  const vehicleType =
    site.vehicle_type ||
    site.niche_label ||
    (site.niche && nicheLabels[site.niche]) ||
    'Chauffeur VTC';
  const totalTrips = site.total_trips || 0;
  const totalTipCount = site.total_tip_count || 0;
  const languages = site.languages || ['Français'];
  const bio = site.bio || generateBio(displayName, city, rating, totalTrips, languages, site.niche);
  const metaDescription = bio.substring(0, 155).replace(/"/g, '&quot;');
  const pricing = site.pricing || null;
  const promoCode = site.promo_code || null;
  const promoPercent = site.promo_discount_percent || 0;
  const hasStripe = !!site.stripe_account_id && !!site.stripe_charges_enabled;
  const canAcceptPayment = hasStripe && !!stripePublishableKey;
  const tripsLabel = totalTrips > 100 ? `${totalTrips}+` : totalTrips > 0 ? `${totalTrips}` : '—';

  // JSON-LD structured data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    additionalType: 'https://schema.org/TaxiService',
    name: `${displayName} — ${vehicleType}`,
    description: bio.substring(0, 300),
    url: siteUrl,
    ...(site.photo_url ? { image: site.photo_url } : {}),
    address: { '@type': 'PostalAddress', addressLocality: city, addressCountry: 'FR' },
    ...(totalTipCount > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: rating.toFixed(1),
            bestRating: '5',
            ratingCount: String(totalTipCount),
          },
        }
      : {}),
    priceRange: '€€',
    knowsLanguage: languages,
    areaServed: { '@type': 'City', name: city },
    potentialAction: [
      {
        '@type': 'ReserveAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: siteUrl,
          actionPlatform: [
            'http://schema.org/DesktopWebPlatform',
            'http://schema.org/MobileWebPlatform',
          ],
        },
        name: 'Réserver une course',
      },
    ],
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'FOREAS', item: 'https://foreas.app' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Chauffeurs',
        item: `${siteUrl.split('/c/')[0]}/c`,
      },
      { '@type': 'ListItem', position: 3, name: displayName, item: siteUrl },
    ],
  };

  // Pricing grid
  let pricingHtml = '';
  if (pricing && typeof pricing === 'object') {
    const labels: Record<string, string> = {
      baseRate: 'Prise en charge',
      perKmRate: 'Par km',
      waitingRate: 'Attente/min',
      minimumFare: 'Minimum',
    };
    const units: Record<string, string> = {
      baseRate: '€',
      perKmRate: '€/km',
      waitingRate: '€/min',
      minimumFare: '€',
    };
    const entries = Object.entries(pricing).filter(([, v]) => v && Number(v) > 0);
    if (entries.length > 0) {
      pricingHtml = `
<div class="card">
  <div class="section-title">Tarifs</div>
  <div class="pricing-grid">
    ${entries.map(([k, v]) => `<div class="pricing-item"><span class="pricing-label">${labels[k] || k}</span><span class="pricing-price">${v}${units[k] ? units[k].replace('€', '') : ''}€</span></div>`).join('')}
  </div>
</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="fr" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
<title>${displayName} — ${vehicleType} ${city} | FOREAS</title>

<!-- SEO -->
<meta name="description" content="${metaDescription}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${siteUrl}">
<meta name="theme-color" content="#0a0a0f">
<meta name="author" content="${displayName}">

<!-- OG -->
<meta property="og:type" content="profile">
<meta property="og:title" content="${displayName} — ${vehicleType} ${city}">
<meta property="og:description" content="${metaDescription}">
<meta property="og:url" content="${siteUrl}">
${
  site.photo_url
    ? `<meta property="og:image" content="${site.photo_url}">
<meta property="og:image:width" content="400"><meta property="og:image:height" content="400">`
    : ''
}
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="FOREAS">

<!-- Twitter -->
<meta name="twitter:card" content="${site.photo_url ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${displayName} — ${vehicleType}">
<meta name="twitter:description" content="${metaDescription}">
${site.photo_url ? `<meta name="twitter:image" content="${site.photo_url}">` : ''}

<!-- Geo SEO -->
<meta name="geo.region" content="FR">
<meta name="geo.placename" content="${city}">
<link rel="alternate" hreflang="fr" href="${siteUrl}">
<meta name="format-detection" content="telephone=yes">

<!-- JSON-LD -->
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>

<!-- Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
${canAcceptPayment ? '<script src="https://js.stripe.com/v3/"></script>' : ''}

<style>
/* ═══════════════════════════════════════════════════════════
   FOREAS DRIVER SITE v3.0 — MOBILE-FIRST PREMIUM DESIGN
   ═══════════════════════════════════════════════════════════ */

:root {
  --cyan: #00C9FF;
  --violet: #8C52FF;
  --violet-deep: #6A3CC0;
  --bg: #060610;
  --bg2: #0c0c1a;
  --card: #111120;
  --card-border: rgba(255,255,255,0.06);
  --text: #ffffff;
  --muted: #8a8a9a;
  --subtle: #b8b8cc;
  --success: #22C55E;
  --amber: #F59E0B;
  --danger: #EF4444;
  --radius: 20px;
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow-x: hidden;
}

.wrap { max-width: 480px; margin: 0 auto; padding-bottom: 100px; }

/* ── ANIMATIONS ── */
@keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideLeft { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
@keyframes slideRight { from { opacity: 0; transform: translateX(-40px); } to { opacity: 1; transform: translateX(0); } }
@keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes drawRoute {
  0% { stroke-dashoffset: 1000; }
  100% { stroke-dashoffset: 0; }
}
@keyframes dotPulse {
  0%, 100% { r: 6; opacity: 1; }
  50% { r: 9; opacity: 0.7; }
}
@keyframes floatBadge {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}
@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.85); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes confettiDrop {
  0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
  100% { transform: translateY(40px) rotate(360deg); opacity: 0; }
}
@keyframes priceReveal {
  from { opacity: 0; transform: scale(0.7) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* ── HERO ── */
.hero {
  background: linear-gradient(165deg, var(--bg) 0%, #0d0825 40%, #0a0a1e 100%);
  padding: 40px 20px 28px;
  text-align: center;
  position: relative;
  overflow: hidden;
  animation: fadeIn 0.6s ease;
}
.hero::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 50% -20%, rgba(0,201,255,0.08) 0%, transparent 60%),
              radial-gradient(ellipse at 30% 80%, rgba(140,82,255,0.06) 0%, transparent 50%);
  pointer-events: none;
}
.hero::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--cyan), var(--violet), var(--cyan), transparent);
  opacity: 0.4;
}

.avatar {
  width: 110px; height: 110px;
  border-radius: 50%;
  object-fit: cover;
  border: 3px solid transparent;
  background-image: linear-gradient(var(--bg2), var(--bg2)), linear-gradient(135deg, var(--cyan), var(--violet));
  background-origin: border-box;
  background-clip: content-box, border-box;
  margin: 0 auto 14px;
  display: block;
  position: relative;
  animation: fadeUp 0.5s ease 0.1s both;
}
.avatar-placeholder {
  width: 110px; height: 110px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  margin: 0 auto 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  font-weight: 900;
  color: #fff;
  position: relative;
  animation: fadeUp 0.5s ease 0.1s both;
}

h1 {
  font-size: 28px;
  font-weight: 800;
  letter-spacing: -0.5px;
  position: relative;
  animation: fadeUp 0.5s ease 0.2s both;
  margin-bottom: 4px;
}
.vehicle {
  color: var(--muted);
  font-size: 14px;
  margin-bottom: 10px;
  position: relative;
  animation: fadeUp 0.5s ease 0.25s both;
}
.stars {
  color: #FFD700;
  font-size: 22px;
  letter-spacing: 3px;
  margin-bottom: 2px;
  position: relative;
  animation: fadeUp 0.5s ease 0.3s both;
}
.rating-text {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 20px;
  position: relative;
  animation: fadeUp 0.5s ease 0.35s both;
}

/* ── TRUST BAR (enrichie) ── */
.trust-row {
  display: flex;
  gap: 8px;
  padding: 16px 16px 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.trust-row::-webkit-scrollbar { display: none; }
.trust-badge {
  flex: 0 0 auto;
  min-width: 80px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 16px;
  padding: 14px 12px;
  text-align: center;
  animation: fadeUp 0.4s ease calc(0.4s + var(--i, 0) * 0.08s) both;
  transition: transform 0.2s, border-color 0.2s;
}
.trust-badge:hover { transform: translateY(-2px); border-color: rgba(0,201,255,0.2); }
.trust-icon { font-size: 22px; margin-bottom: 6px; }
.trust-val { font-size: 15px; font-weight: 700; color: var(--text); }
.trust-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; margin-top: 3px; }

/* ── BOOKING MODULE ── */
.booking {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  margin: 16px;
  padding: 24px 20px;
  position: relative;
  overflow: hidden;
  animation: fadeUp 0.5s ease 0.5s both;
}
.booking::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--cyan), var(--violet), var(--cyan));
  opacity: 0.5;
}
.booking-title {
  font-size: 20px;
  font-weight: 800;
  color: var(--text);
  margin-bottom: 4px;
  letter-spacing: -0.3px;
}
.booking-sub {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 20px;
}

/* Progress bar */
.booking-progress {
  display: flex;
  gap: 8px;
  margin-bottom: 22px;
}
.booking-step-dot {
  flex: 1;
  height: 4px;
  border-radius: 4px;
  background: rgba(255,255,255,0.08);
  transition: background 0.5s ease;
  position: relative;
  overflow: hidden;
}
.booking-step-dot.active {
  background: linear-gradient(90deg, var(--cyan), var(--violet));
}
.booking-step-dot.active::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
  animation: shimmer 2s ease infinite;
  background-size: 200% 100%;
}

/* Steps */
.booking-step { display: none; }
.booking-step.visible { display: block; animation: slideLeft 0.4s ease; }
.booking-step.visible-back { display: block; animation: slideRight 0.4s ease; }

/* Form elements */
.field-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.field-label .icon { font-size: 14px; }
.field-group { margin-bottom: 16px; }
.field-row { display: flex; gap: 12px; }
.field-row > * { flex: 1; }

.b-input {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 15px 16px;
  font-size: 16px;
  color: #fff;
  font-family: var(--font);
  min-height: 52px;
  transition: border-color 0.25s, box-shadow 0.25s, background 0.25s;
  -webkit-appearance: none;
  appearance: none;
}
.b-input:focus {
  outline: none;
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0,201,255,0.12);
  background: rgba(0,201,255,0.03);
}
.b-input::placeholder { color: #444455; }
select.b-input {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 16px center;
  padding-right: 40px;
}
select.b-input option { background: #1a1a2e; color: #fff; }

/* ── PRICE ESTIMATE ── */
.price-estimate {
  display: none;
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 18px;
  text-align: center;
  position: relative;
  overflow: hidden;
  animation: priceReveal 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.price-estimate.visible { display: block; }
.price-estimate-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(0,201,255,0.08), rgba(140,82,255,0.08));
  border: 1.5px solid rgba(0,201,255,0.2);
  border-radius: 18px;
}
.price-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 8px;
  position: relative;
}
.price-value {
  font-size: 42px;
  font-weight: 900;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 4px;
  position: relative;
  line-height: 1.1;
}
.price-original {
  text-decoration: line-through;
  color: var(--muted);
  font-size: 18px;
  font-weight: 600;
  margin-right: 8px;
}
.price-detail {
  font-size: 12px;
  color: var(--muted);
  position: relative;
}
.price-promo-badge {
  display: inline-block;
  background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.08));
  border: 1px solid rgba(245,158,11,0.3);
  border-radius: 20px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--amber);
  margin-top: 8px;
  animation: floatBadge 3s ease infinite;
}

/* ── CTA BUTTONS ── */
.cta-accept {
  width: 100%;
  border: none;
  border-radius: 16px;
  padding: 18px;
  font-size: 17px;
  font-weight: 800;
  color: #fff;
  cursor: pointer;
  font-family: var(--font);
  min-height: 58px;
  position: relative;
  overflow: hidden;
  transition: transform 0.15s, box-shadow 0.15s;
  background: linear-gradient(135deg, var(--cyan) 0%, #0BB8E8 30%, var(--violet) 70%, var(--cyan) 100%);
  background-size: 300% 100%;
  animation: shimmer 4s ease infinite;
  box-shadow: 0 6px 24px rgba(0,201,255,0.25);
  letter-spacing: 0.3px;
  margin-top: 6px;
}
.cta-accept:hover { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(0,201,255,0.35); }
.cta-accept:active { transform: scale(0.98); }
.cta-accept:disabled { opacity: 0.45; cursor: not-allowed; transform: none; box-shadow: none; animation: none; }

.cta-pay {
  width: 100%;
  border: none;
  border-radius: 16px;
  padding: 18px;
  font-size: 17px;
  font-weight: 800;
  color: #fff;
  cursor: pointer;
  font-family: var(--font);
  min-height: 58px;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  box-shadow: 0 6px 24px rgba(140,82,255,0.3);
  transition: all 0.2s;
  letter-spacing: 0.3px;
}
.cta-pay:hover { opacity: 0.92; transform: translateY(-1px); }
.cta-pay:active { transform: scale(0.98); }
.cta-pay:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

.booking-back {
  background: none;
  border: none;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  padding: 12px;
  margin-top: 8px;
  font-family: var(--font);
  text-decoration: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: color 0.2s;
}
.booking-back:hover { color: var(--cyan); }

/* ── ROUTE ANIMATION (Step 2) ── */
.route-card {
  background: linear-gradient(160deg, #0a0a1e, #0d0825, #0a0a1e);
  border: 1px solid rgba(0,201,255,0.12);
  border-radius: 20px;
  padding: 24px 20px;
  margin-bottom: 20px;
  position: relative;
  overflow: hidden;
  animation: scaleIn 0.5s ease both;
}
.route-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at 30% 30%, rgba(0,201,255,0.04) 0%, transparent 60%),
              radial-gradient(ellipse at 70% 70%, rgba(140,82,255,0.04) 0%, transparent 60%);
  pointer-events: none;
}
.route-svg-container {
  width: 100%;
  height: 120px;
  position: relative;
  margin-bottom: 16px;
}
.route-svg {
  width: 100%;
  height: 100%;
}
.route-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.route-endpoint {
  flex: 1;
  min-width: 0;
}
.route-endpoint-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 4px;
}
.route-endpoint-label.from { color: var(--cyan); }
.route-endpoint-label.to { color: var(--violet); }
.route-endpoint-addr {
  font-size: 13px;
  color: var(--subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.route-middle {
  text-align: center;
  flex-shrink: 0;
}
.route-distance {
  font-size: 18px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.route-duration {
  font-size: 11px;
  color: var(--muted);
}
.route-price-summary {
  text-align: center;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(255,255,255,0.06);
}
.route-price-value {
  font-size: 32px;
  font-weight: 900;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.route-price-label {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}

/* Stripe Elements container */
.stripe-element {
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 16px;
  min-height: 52px;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.stripe-element.StripeElement--focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0,201,255,0.12);
}
.stripe-element.StripeElement--invalid {
  border-color: var(--danger);
}
.stripe-secure-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: #555;
  margin-top: 10px;
}

/* ── CONFIRMATION ── */
.booking-confirm {
  display: none;
  text-align: center;
  padding: 30px 16px;
  animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.confirm-icon {
  font-size: 64px;
  margin-bottom: 16px;
  animation: pulse 1.5s ease infinite;
}
.confirm-title {
  font-size: 22px;
  font-weight: 800;
  margin-bottom: 8px;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.confirm-text {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.6;
}

/* ── CARDS ── */
.card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  margin: 16px;
  padding: 22px;
}
.bio { color: var(--subtle); font-size: 15px; line-height: 1.8; }
.section-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--cyan);
  text-transform: uppercase;
  letter-spacing: 1.2px;
  margin-bottom: 14px;
}

/* ── PRICING GRID ── */
.pricing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pricing-item {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--card-border);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.pricing-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
.pricing-price { font-size: 22px; font-weight: 800; color: var(--cyan); }

/* ── PROMO CODE ── */
.promo-card {
  background: linear-gradient(135deg, rgba(245,158,11,0.06), rgba(245,158,11,0.02));
  border: 1px solid rgba(245,158,11,0.2);
  border-radius: var(--radius);
  margin: 16px;
  padding: 24px;
  text-align: center;
}
.promo-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--amber);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 12px;
}
.promo-value {
  font-size: 40px;
  font-weight: 900;
  color: var(--amber);
  margin-bottom: 8px;
}
.promo-code-box {
  display: inline-block;
  background: rgba(0,0,0,0.3);
  border: 2px dashed rgba(245,158,11,0.4);
  border-radius: 12px;
  padding: 12px 28px;
  margin: 4px 0;
}
.promo-code {
  font-size: 22px;
  font-weight: 900;
  color: #fff;
  letter-spacing: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.promo-hint {
  font-size: 12px;
  color: var(--muted);
  margin-top: 10px;
}

/* ── SECONDARY CTA ── */
.cta-secondary {
  display: block;
  width: calc(100% - 32px);
  margin: 8px auto 16px;
  background: transparent;
  border: 2px solid var(--cyan);
  border-radius: 16px;
  padding: 16px;
  font-size: 16px;
  font-weight: 700;
  color: var(--cyan);
  cursor: pointer;
  transition: all 0.25s;
  text-align: center;
  text-decoration: none;
  font-family: var(--font);
  min-height: 54px;
}
.cta-secondary:hover { background: var(--cyan); color: #fff; }
.cta-sub { display: block; text-align: center; font-size: 12px; color: var(--muted); margin-bottom: 16px; }

/* ── TIP ── */
.tip-amounts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
.tip-btn {
  background: rgba(255,255,255,0.04);
  border: 2px solid rgba(255,255,255,0.08);
  border-radius: 14px;
  padding: 14px 0;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  cursor: pointer;
  transition: all 0.2s;
  min-height: 50px;
}
.tip-btn.selected, .tip-btn:hover { border-color: var(--cyan); background: rgba(0,201,255,0.08); color: var(--cyan); }
.pay-btn {
  width: 100%;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  border: none;
  border-radius: 16px;
  padding: 18px;
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  cursor: pointer;
  font-family: var(--font);
  min-height: 56px;
  transition: all 0.2s;
}
.pay-btn:hover { opacity: 0.9; }
.pay-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── REVIEW ── */
.review-stars { display: flex; gap: 10px; justify-content: center; margin-bottom: 16px; }
.review-star { font-size: 36px; cursor: pointer; color: #222; transition: color 0.15s, transform 0.15s; }
.review-star.lit { color: #FFD700; }
.review-star:hover { transform: scale(1.15); }
textarea {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 14px 16px;
  font-size: 15px;
  color: #fff;
  resize: none;
  min-height: 100px;
  margin-bottom: 12px;
  font-family: var(--font);
  transition: border-color 0.2s;
}
textarea:focus { outline: none; border-color: var(--cyan); }
input[type=text], input[type=email], input[type=tel], input[type=date], input[type=time] {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 15px 16px;
  font-size: 16px;
  color: #fff;
  margin-bottom: 10px;
  font-family: var(--font);
  min-height: 52px;
  transition: border-color 0.2s;
  -webkit-appearance: none;
}
input:focus { outline: none; border-color: var(--cyan); }
.submit-btn {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 2px solid var(--cyan);
  border-radius: 16px;
  padding: 16px;
  font-size: 16px;
  font-weight: 700;
  color: var(--cyan);
  cursor: pointer;
  transition: all 0.2s;
  font-family: var(--font);
  min-height: 54px;
}
.submit-btn:hover { background: var(--cyan); color: #fff; }

/* ── FOOTER ── */
.foreas-badge { text-align: center; padding: 32px 16px 48px; color: #333; font-size: 12px; }
.foreas-badge a { color: var(--cyan); text-decoration: none; font-weight: 600; }
.foreas-badge .legal { margin-top: 8px; font-size: 10px; color: #222; }

/* ── MESSAGES ── */
.success-msg { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.3); border-radius: 14px; padding: 16px; color: var(--success); text-align: center; margin-top: 12px; display: none; font-size: 14px; }
.error-msg { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); border-radius: 14px; padding: 16px; color: var(--danger); text-align: center; margin-top: 12px; display: none; font-size: 14px; }

/* ── STICKY BAR ── */
.sticky-bar {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  z-index: 999;
  transform: translateY(100%);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  background: linear-gradient(0deg, var(--bg) 0%, rgba(6,6,16,0.97) 100%);
  border-top: 1px solid var(--card-border);
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
}
.sticky-bar.visible { transform: translateY(0); }
.sticky-bar-inner { max-width: 480px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
.sticky-bar-info { flex: 1; }
.sticky-bar-name { font-size: 14px; font-weight: 700; }
.sticky-bar-price { font-size: 12px; color: var(--cyan); font-weight: 600; }
.sticky-bar-btn {
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  border: none;
  border-radius: 14px;
  padding: 14px 28px;
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  cursor: pointer;
  font-family: var(--font);
  transition: all 0.2s;
  white-space: nowrap;
}
.sticky-bar-btn:hover { opacity: 0.92; }
.sticky-bar-btn:active { transform: scale(0.98); }

/* ── ADDRESS AUTOCOMPLETE ── */
.addr-wrap { position: relative; }
.addr-suggestions {
  position: absolute;
  top: 100%;
  left: 0; right: 0;
  background: #15152a;
  border: 1px solid rgba(0,201,255,0.15);
  border-top: none;
  border-radius: 0 0 14px 14px;
  max-height: 240px;
  overflow-y: auto;
  z-index: 100;
  display: none;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
.addr-suggestions.open { display: block; }
.addr-item {
  padding: 14px 16px;
  font-size: 14px;
  color: #ccc;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-family: var(--font);
  transition: background 0.15s;
}
.addr-item:hover, .addr-item:focus { background: rgba(0,201,255,0.08); color: #fff; }
.addr-item:last-child { border-bottom: none; border-radius: 0 0 14px 14px; }
.addr-item .addr-city { color: var(--muted); font-size: 12px; margin-top: 3px; }

/* ── RESPONSIVE ── */
@media(max-width: 400px) {
  .tip-amounts { grid-template-columns: repeat(2, 1fr); }
  .pricing-grid { grid-template-columns: 1fr; }
  .field-row { flex-direction: column; gap: 0; }
  .route-info { flex-direction: column; text-align: center; }
  .route-endpoint { text-align: center; }
  h1 { font-size: 24px; }
  .price-value { font-size: 36px; }
}
</style>
</head>
<body>
<div class="wrap">

<!-- ═══ 1. HERO ═══ -->
<header class="hero">
  ${
    site.photo_url
      ? `<img class="avatar" src="${site.photo_url}" alt="Photo de ${displayName}, ${vehicleType} ${city}" width="110" height="110" loading="eager">`
      : `<div class="avatar-placeholder">${displayName[0].toUpperCase()}</div>`
  }
  <h1>${displayName}</h1>
  <div class="vehicle">${vehicleType} · ${city}</div>
  <div class="stars" aria-label="Note ${rating.toFixed(1)} sur 5">${stars}</div>
  <div class="rating-text">${rating.toFixed(1)}/5 · ${totalTipCount > 0 ? totalTipCount + ' avis' : 'Nouveau sur FOREAS'}</div>
</header>

<!-- ═══ 2. TRUST BAR (enrichie) ═══ -->
<div class="trust-row">
  <div class="trust-badge" style="--i:0">
    <div class="trust-icon">🛡️</div>
    <div class="trust-val">Vérifié</div>
    <div class="trust-label">Carte VTC</div>
  </div>
  <div class="trust-badge" style="--i:1">
    <div class="trust-icon">🚗</div>
    <div class="trust-val">${tripsLabel}</div>
    <div class="trust-label">Courses</div>
  </div>
  <div class="trust-badge" style="--i:2">
    <div class="trust-icon">⭐</div>
    <div class="trust-val">${rating.toFixed(1)}</div>
    <div class="trust-label">Note</div>
  </div>
  <div class="trust-badge" style="--i:3">
    <div class="trust-icon">📋</div>
    <div class="trust-val">RC Pro</div>
    <div class="trust-label">Assuré</div>
  </div>
  <div class="trust-badge" style="--i:4">
    <div class="trust-icon">🗣️</div>
    <div class="trust-val">${languages[0]}</div>
    <div class="trust-label">Langue</div>
  </div>
</div>

<!-- ═══ 3. BOOKING MODULE — 2 ÉTAPES ═══ -->
<div class="booking" id="bookingSection">
  <div class="booking-title">Réservez votre trajet</div>
  <div class="booking-sub" id="bookingSub">Prix instantané · Paiement sécurisé</div>

  <div class="booking-progress">
    <div class="booking-step-dot active" id="dot1"></div>
    <div class="booking-step-dot" id="dot2"></div>
  </div>

  <!-- ── STEP 1: Départ / Arrivée / Prix ── -->
  <div class="booking-step visible" id="step1">
    <div class="field-group">
      <div class="field-label"><span class="icon">📍</span> Départ</div>
      <div class="addr-wrap">
        <input type="text" class="b-input" id="bFrom" placeholder="Ex: 10 rue de Rivoli, Paris" autocomplete="off">
        <div class="addr-suggestions" id="addrSuggest1"></div>
      </div>
    </div>

    <div class="field-group">
      <div class="field-label"><span class="icon">🏁</span> Arrivée</div>
      <div class="addr-wrap">
        <input type="text" class="b-input" id="bTo" placeholder="Ex: Aéroport CDG, Terminal 2" autocomplete="off">
        <div class="addr-suggestions" id="addrSuggest2"></div>
      </div>
    </div>

    <div class="field-row">
      <div class="field-group">
        <div class="field-label"><span class="icon">📅</span> Date</div>
        <input type="date" class="b-input" id="bDate">
      </div>
      <div class="field-group">
        <div class="field-label"><span class="icon">⏰</span> Heure</div>
        <input type="time" class="b-input" id="bTime">
      </div>
    </div>

    <!-- Prix estimé (apparaît dynamiquement) -->
    <div class="price-estimate" id="priceEstimate">
      <div class="price-estimate-bg"></div>
      <div class="price-label" id="priceLabel">Tarif estimé · Prix fixe garanti</div>
      <div class="price-value" id="priceValue"></div>
      <div class="price-detail" id="priceDetail"></div>
      <div class="price-promo-badge" id="promoBadge" style="display:none"></div>
    </div>

    <button class="cta-accept" id="acceptBtn" onclick="acceptBooking()" disabled>
      ✓ J'accepte — Réserver
    </button>
  </div>

  <!-- ── STEP 2: Animation Tracé + Paiement ── -->
  <div class="booking-step" id="step2">

    <!-- Carte du tracé (SVG animé) -->
    <div class="route-card" id="routeCard">
      <div class="route-svg-container">
        <svg class="route-svg" id="routeSvg" viewBox="0 0 400 120" preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="routeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#00C9FF;stop-opacity:1" />
              <stop offset="50%" style="stop-color:#8C52FF;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#00C9FF;stop-opacity:1" />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
          <!-- Route path (drawn with animation) -->
          <path id="routePath" d="M 40 80 C 120 20, 200 100, 280 40 S 360 60, 360 50"
                fill="none" stroke="url(#routeGradient)" stroke-width="3" stroke-linecap="round"
                stroke-dasharray="1000" stroke-dashoffset="1000" filter="url(#glow)"
                style="animation: drawRoute 2s ease forwards 0.3s" />
          <!-- Departure dot -->
          <circle cx="40" cy="80" r="6" fill="#00C9FF" filter="url(#glow)">
            <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle cx="40" cy="80" r="3" fill="#fff" />
          <!-- Arrival dot -->
          <circle cx="360" cy="50" r="6" fill="#8C52FF" filter="url(#glow)" opacity="0"
                  style="animation: fadeIn 0.3s ease 2s forwards">
            <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite" begin="2s" />
          </circle>
          <circle cx="360" cy="50" r="3" fill="#fff" opacity="0" style="animation: fadeIn 0.3s ease 2s forwards" />
        </svg>
      </div>

      <!-- Route info -->
      <div class="route-info">
        <div class="route-endpoint">
          <div class="route-endpoint-label from">Départ</div>
          <div class="route-endpoint-addr" id="routeFrom">—</div>
        </div>
        <div class="route-middle">
          <div class="route-distance" id="routeDist">—</div>
          <div class="route-duration" id="routeDur">~35 min</div>
        </div>
        <div class="route-endpoint" style="text-align:right">
          <div class="route-endpoint-label to">Arrivée</div>
          <div class="route-endpoint-addr" id="routeTo">—</div>
        </div>
      </div>

      <!-- Récap prix -->
      <div class="route-price-summary">
        <div class="route-price-value" id="routePrice">—</div>
        <div class="route-price-label">Prix fixe garanti</div>
      </div>
    </div>

    <!-- Formulaire passager -->
    <div class="field-group">
      <div class="field-label"><span class="icon">👤</span> Prénom</div>
      <input type="text" class="b-input" id="bFirstName" placeholder="Votre prénom">
    </div>
    <div class="field-group">
      <div class="field-label"><span class="icon">👤</span> Nom</div>
      <input type="text" class="b-input" id="bLastName" placeholder="Votre nom">
    </div>
    <div class="field-group">
      <div class="field-label"><span class="icon">📱</span> Téléphone</div>
      <input type="tel" class="b-input" id="bPhone" placeholder="+33 6 12 34 56 78">
    </div>

    <!-- Stripe Elements (si chauffeur connecté Stripe) -->
    ${
      canAcceptPayment
        ? `
    <div class="field-group">
      <div class="field-label"><span class="icon">💳</span> Carte bancaire</div>
      <div class="stripe-element" id="cardElement"></div>
      <div id="cardErrors" style="color:var(--danger);font-size:12px;margin-top:6px;display:none"></div>
    </div>
    `
        : ''
    }

    <button class="cta-pay" id="payBtn" onclick="submitPayment()" disabled>
      ${canAcceptPayment ? '🔒 Payer — €' : 'Confirmer la réservation'}
    </button>
    <div class="stripe-secure-badge">
      ${canAcceptPayment ? '🔒 Paiement sécurisé par Stripe' : '✓ Réservation gratuite · Sans engagement'}
    </div>

    <button class="booking-back" onclick="goStep1()">← Modifier le trajet</button>
  </div>

  <!-- Confirmation -->
  <div class="booking-confirm" id="bookingConfirm">
    <div class="confirm-icon">✅</div>
    <div class="confirm-title">Réservation confirmée !</div>
    <div class="confirm-text">
      ${firstName} a bien reçu votre demande et vous recontactera très rapidement.<br>
      Un SMS de confirmation vous a été envoyé.
    </div>
  </div>
  <div class="error-msg" id="bookingError"></div>
</div>

<!-- ═══ 4. BIO ═══ -->
<div class="card">
  <div class="section-title">À propos</div>
  <div class="bio">${bio}</div>
</div>

<!-- ═══ 5. TARIFS ═══ -->
${pricingHtml}

<!-- ═══ 6. CODE PROMO ═══ -->
${
  promoCode && promoPercent > 0
    ? `
<div class="promo-card">
  <div class="promo-badge">🎁 Offre 1ère réservation</div>
  <div class="promo-value">-${promoPercent}%</div>
  <div class="promo-code-box">
    <span class="promo-code">${promoCode}</span>
  </div>
  <div class="promo-hint">Appliqué automatiquement · Valable 1 fois</div>
</div>
`
    : ''
}

<!-- ═══ 7. CTA SECONDAIRE ═══ -->
<button class="cta-secondary" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
  Réserver ${firstName} maintenant
</button>
<span class="cta-sub">Sans application · Réponse immédiate</span>

<!-- ═══ 8. POURBOIRE ═══ -->
<div class="card">
  <div class="section-title">💳 Laisser un pourboire</div>
  <div class="tip-amounts">
    <div class="tip-btn" onclick="selectTip(2)" data-amount="2">2€</div>
    <div class="tip-btn" onclick="selectTip(5)" data-amount="5">5€</div>
    <div class="tip-btn" onclick="selectTip(10)" data-amount="10">10€</div>
    <div class="tip-btn" onclick="selectTip(0)" data-amount="0">Autre</div>
  </div>
  <input type="text" id="customTip" placeholder="Montant personnalisé (€)" style="display:none" oninput="updateCustom(this.value)">
  <input type="email" id="passengerEmail" placeholder="Votre email (pour le reçu)" autocomplete="email">
  <button class="pay-btn" id="tipPayBtn" onclick="processTip()" disabled>Sélectionnez un montant</button>
  <div class="stripe-secure-badge">🔒 Paiement sécurisé par Stripe</div>
  <div class="success-msg" id="tipSuccess">Merci ! Votre pourboire a été envoyé à ${firstName}.</div>
  <div class="error-msg" id="tipError"></div>
</div>

<!-- ═══ 9. AVIS ═══ -->
<div class="card">
  <div class="section-title">⭐ Laisser un avis</div>
  <div class="review-stars">
    <span class="review-star" onclick="setRating(1)" aria-label="1 étoile">★</span>
    <span class="review-star" onclick="setRating(2)" aria-label="2 étoiles">★</span>
    <span class="review-star" onclick="setRating(3)" aria-label="3 étoiles">★</span>
    <span class="review-star" onclick="setRating(4)" aria-label="4 étoiles">★</span>
    <span class="review-star" onclick="setRating(5)" aria-label="5 étoiles">★</span>
  </div>
  <textarea id="reviewText" placeholder="Décrivez votre expérience avec ${firstName}..."></textarea>
  <input type="text" id="reviewName" placeholder="Votre prénom (optionnel)">
  <button class="submit-btn" onclick="submitReview()">Publier l'avis</button>
  <div class="success-msg" id="reviewSuccess">Merci pour votre avis !</div>
  <div class="error-msg" id="reviewError"></div>
</div>

<!-- ═══ 10. FOOTER ═══ -->
<footer class="foreas-badge">
  Propulsé par <a href="https://foreas.app" target="_blank" rel="noopener">FOREAS</a> · Technologie IA pour chauffeurs VTC<br>
  <div class="legal">&copy; ${new Date().getFullYear()} FOREAS Labs &middot; <a href="#" style="color:#333">CGU</a> &middot; <a href="#" style="color:#333">Confidentialité</a> &middot; <a href="#" style="color:#333">Mentions légales</a></div>
</footer>

</div><!-- /wrap -->

<!-- ═══ STICKY BAR ═══ -->
<div class="sticky-bar" id="stickyBar">
  <div class="sticky-bar-inner">
    <div class="sticky-bar-info">
      <div class="sticky-bar-name">${firstName} · ${vehicleType}</div>
      <div class="sticky-bar-price" id="stickyPrice"></div>
    </div>
    <button class="sticky-bar-btn" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
      Réserver →
    </button>
  </div>
</div>

<script>
/* ═══════════════════════════════════════════════════════════
   FOREAS CLIENT SITE — JavaScript Engine v3.0
   ═══════════════════════════════════════════════════════════ */

var BACKEND = '${backendUrl}';
var SLUG = '${site.slug}';
var PRICING = ${pricing ? JSON.stringify(pricing) : 'null'};
var PROMO_PERCENT = ${promoPercent};
var CAN_PAY = ${canAcceptPayment};
var STRIPE_PK = ${canAcceptPayment ? `'${stripePublishableKey}'` : 'null'};
var selectedAmount = 0;
var selectedRating = 0;

// Geocoded coordinates storage
var fromCoords = null;
var toCoords = null;
var calcTimeout = null;
var calculatedFare = 0;
var calculatedDist = 0;

// Stripe Elements
var stripe = null;
var cardElement = null;
var clientSecret = null;

// ── INIT ──
(function init() {
  // Set today as default date
  var today = new Date().toISOString().split('T')[0];
  var dateInput = document.getElementById('bDate');
  if (dateInput) { dateInput.value = today; dateInput.min = today; }

  // Set current hour + 1 as default time
  var now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  var timeInput = document.getElementById('bTime');
  if (timeInput) timeInput.value = now.toTimeString().substring(0, 5);

  // Setup address autocomplete
  setupAddrAutocomplete('bFrom', 'addrSuggest1');
  setupAddrAutocomplete('bTo', 'addrSuggest2');

  // Price calculator triggers
  ['bFrom', 'bTo'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', debounceCalcPrice);
  });

  // Sticky bar observer
  var heroEl = document.querySelector('.hero');
  var stickyBar = document.getElementById('stickyBar');
  if (heroEl && stickyBar && 'IntersectionObserver' in window) {
    new IntersectionObserver(function(entries) {
      entries.forEach(function(e) {
        stickyBar.classList.toggle('visible', !e.isIntersecting);
      });
    }, { threshold: 0 }).observe(heroEl);
  }

  // Init Stripe if available
  if (CAN_PAY && STRIPE_PK) {
    stripe = Stripe(STRIPE_PK);
    var elements = stripe.elements({
      fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' }],
    });
    cardElement = elements.create('card', {
      style: {
        base: {
          color: '#fff',
          fontFamily: 'Inter, sans-serif',
          fontSize: '16px',
          '::placeholder': { color: '#444455' },
        },
        invalid: { color: '#EF4444' },
      },
      hidePostalCode: true,
    });
    var mountEl = document.getElementById('cardElement');
    if (mountEl) {
      cardElement.mount('#cardElement');
      cardElement.on('change', function(event) {
        var errEl = document.getElementById('cardErrors');
        if (event.error) {
          errEl.textContent = event.error.message;
          errEl.style.display = 'block';
        } else {
          errEl.style.display = 'none';
        }
        validateStep2();
      });
    }
  }

  // Enable pay button validation on input
  ['bFirstName', 'bLastName', 'bPhone'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', validateStep2);
  });

  // Track view
  fetch(BACKEND + '/api/driver-site/view/' + SLUG, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: '${source}' }),
  }).catch(function() {});
})();

// ── DEBOUNCE ──
function debounceCalcPrice() {
  clearTimeout(calcTimeout);
  calcTimeout = setTimeout(calcPrice, 500);
}

// ── PRICE CALCULATOR ──
function calcPrice() {
  var from = document.getElementById('bFrom').value.trim();
  var to = document.getElementById('bTo').value.trim();
  var el = document.getElementById('priceEstimate');
  var acceptBtn = document.getElementById('acceptBtn');

  if (!from || !to || from.length < 5 || to.length < 5) {
    el.classList.remove('visible');
    el.style.display = 'none';
    acceptBtn.disabled = true;
    return;
  }

  // Need pricing data to calculate
  if (!PRICING) {
    el.classList.remove('visible');
    el.style.display = 'none';
    // Still allow booking without price
    acceptBtn.disabled = false;
    return;
  }

  Promise.all([geocode(from), geocode(to)]).then(function(coords) {
    if (!coords[0] || !coords[1]) {
      el.classList.remove('visible');
      el.style.display = 'none';
      acceptBtn.disabled = false;
      return;
    }

    fromCoords = coords[0];
    toCoords = coords[1];

    var dist = haversine(coords[0][0], coords[0][1], coords[1][0], coords[1][1]);
    var roadDist = dist * 1.3; // road factor
    calculatedDist = roadDist;
    var fare = Math.max(
      PRICING.minimumFare || 15,
      (PRICING.baseRate || 10) + (PRICING.perKmRate || 1.8) * roadDist
    );
    calculatedFare = fare;

    var valEl = document.getElementById('priceValue');
    var detEl = document.getElementById('priceDetail');
    var promoEl = document.getElementById('promoBadge');
    var stickyPriceEl = document.getElementById('stickyPrice');

    if (PROMO_PERCENT > 0) {
      var discounted = Math.round(fare * (1 - PROMO_PERCENT / 100));
      calculatedFare = discounted;
      valEl.innerHTML = '<span class="price-original">' + Math.round(fare) + '\\u20AC</span>' + discounted + '\\u20AC';
      detEl.textContent = roadDist.toFixed(1) + ' km · Prix fixe garanti';
      promoEl.textContent = '\\uD83C\\uDF81 -' + PROMO_PERCENT + '% · 1ère course';
      promoEl.style.display = 'inline-block';
      if (stickyPriceEl) stickyPriceEl.textContent = discounted + '\\u20AC · ' + roadDist.toFixed(1) + ' km';
    } else {
      valEl.textContent = Math.round(fare) + '\\u20AC';
      detEl.textContent = roadDist.toFixed(1) + ' km · Prix fixe garanti';
      promoEl.style.display = 'none';
      if (stickyPriceEl) stickyPriceEl.textContent = Math.round(fare) + '\\u20AC · ' + roadDist.toFixed(1) + ' km';
    }

    el.style.display = 'block';
    // Force reflow for animation
    el.offsetHeight;
    el.classList.add('visible');
    acceptBtn.disabled = false;

  }).catch(function() {
    el.classList.remove('visible');
    el.style.display = 'none';
    acceptBtn.disabled = false;
  });
}

// ── GEOCODE ──
function geocode(addr) {
  return fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(addr) + '&limit=1')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      return d.features && d.features.length
        ? [d.features[0].geometry.coordinates[1], d.features[0].geometry.coordinates[0]]
        : null;
    })
    .catch(function() { return null; });
}

// ── HAVERSINE ──
function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── ADDRESS AUTOCOMPLETE ──
function setupAddrAutocomplete(inputId, suggestId) {
  var input = document.getElementById(inputId);
  var list = document.getElementById(suggestId);
  if (!input || !list) return;
  var timer = null;

  input.addEventListener('input', function() {
    clearTimeout(timer);
    var q = input.value.trim();
    if (q.length < 3) { list.classList.remove('open'); list.innerHTML = ''; return; }
    timer = setTimeout(function() {
      fetch('https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) + '&limit=5')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          list.innerHTML = '';
          if (!data.features || !data.features.length) { list.classList.remove('open'); return; }
          data.features.forEach(function(f) {
            var p = f.properties;
            var div = document.createElement('div');
            div.className = 'addr-item';
            div.tabIndex = 0;
            div.innerHTML = p.name + '<div class="addr-city">' + p.postcode + ' ' + p.city + '</div>';
            div.addEventListener('click', function() {
              input.value = p.label;
              list.classList.remove('open');
              list.innerHTML = '';
              debounceCalcPrice();
            });
            list.appendChild(div);
          });
          list.classList.add('open');
        })
        .catch(function() { list.classList.remove('open'); });
    }, 250);
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.addr-wrap')) { list.classList.remove('open'); list.innerHTML = ''; }
  });

  input.addEventListener('keydown', function(e) {
    var items = list.querySelectorAll('.addr-item');
    if (!items.length) return;
    var active = list.querySelector('.addr-item:focus');
    if (e.key === 'ArrowDown') { e.preventDefault(); (active && active.nextElementSibling ? active.nextElementSibling : items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (active && active.previousElementSibling) active.previousElementSibling.focus(); else input.focus(); }
    else if (e.key === 'Enter' && active) { e.preventDefault(); active.click(); }
    else if (e.key === 'Escape') { list.classList.remove('open'); list.innerHTML = ''; }
  });
}

// ── STEP NAVIGATION ──
function acceptBooking() {
  // Fill route card info
  var fromAddr = document.getElementById('bFrom').value.trim();
  var toAddr = document.getElementById('bTo').value.trim();
  document.getElementById('routeFrom').textContent = fromAddr.split(',')[0] || fromAddr;
  document.getElementById('routeTo').textContent = toAddr.split(',')[0] || toAddr;
  document.getElementById('routeDist').textContent = calculatedDist > 0 ? calculatedDist.toFixed(1) + ' km' : '—';
  document.getElementById('routeDur').textContent = calculatedDist > 0 ? '~' + Math.round(calculatedDist * 1.8) + ' min' : '';
  document.getElementById('routePrice').textContent = calculatedFare > 0 ? Math.round(calculatedFare) + '\\u20AC' : '—';

  // Update pay button
  var payBtn = document.getElementById('payBtn');
  if (CAN_PAY && calculatedFare > 0) {
    payBtn.textContent = '\\uD83D\\uDD12 Payer ' + Math.round(calculatedFare) + '\\u20AC';
  }

  // Animate step transition
  var s1 = document.getElementById('step1');
  var s2 = document.getElementById('step2');
  s1.classList.remove('visible');
  s2.classList.add('visible');
  document.getElementById('dot1').classList.remove('active');
  document.getElementById('dot2').classList.add('active');
  document.getElementById('bookingSub').textContent = 'Confirmez vos coordonnées';

  // Reset route animation by cloning SVG path
  var path = document.getElementById('routePath');
  if (path) {
    var clone = path.cloneNode(true);
    path.parentNode.replaceChild(clone, path);
    clone.id = 'routePath';
  }

  // Scroll to step 2
  document.getElementById('bookingSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Create PaymentIntent if Stripe enabled
  if (CAN_PAY && calculatedFare > 0) {
    createPaymentIntent();
  }
}

function goStep1() {
  var s1 = document.getElementById('step1');
  var s2 = document.getElementById('step2');
  s2.classList.remove('visible');
  s1.classList.remove('visible');
  s1.classList.add('visible-back');
  setTimeout(function() {
    s1.classList.remove('visible-back');
    s1.classList.add('visible');
  }, 400);
  document.getElementById('dot2').classList.remove('active');
  document.getElementById('dot1').classList.add('active');
  document.getElementById('bookingSub').textContent = 'Prix instantané · Paiement sécurisé';
}

// ── VALIDATION ──
function validateStep2() {
  var fn = document.getElementById('bFirstName').value.trim();
  var ln = document.getElementById('bLastName').value.trim();
  var ph = document.getElementById('bPhone').value.trim();
  var payBtn = document.getElementById('payBtn');

  var valid = fn.length >= 2 && ln.length >= 2 && ph.length >= 8;
  // If Stripe, also check card
  // (Stripe card validation is handled separately, but we enable button if basic fields are filled)
  payBtn.disabled = !valid;
}

// ── STRIPE PAYMENT INTENT ──
function createPaymentIntent() {
  if (!CAN_PAY || calculatedFare <= 0) return;

  fetch(BACKEND + '/api/driver-site/create-payment-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG,
      amount: Math.round(calculatedFare),
      pickup_address: document.getElementById('bFrom').value,
      destination: document.getElementById('bTo').value,
      booking_date: document.getElementById('bDate').value,
      booking_time: document.getElementById('bTime').value,
    }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.client_secret) {
      clientSecret = data.client_secret;
    }
  })
  .catch(function(e) { console.log('PaymentIntent error:', e); });
}

// ── SUBMIT PAYMENT / BOOKING ──
function submitPayment() {
  var btn = document.getElementById('payBtn');
  var fn = document.getElementById('bFirstName').value.trim();
  var ln = document.getElementById('bLastName').value.trim();
  var phone = document.getElementById('bPhone').value.trim();

  if (!fn || !ln || !phone) {
    alert('Veuillez remplir tous les champs obligatoires');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Traitement en cours...';
  document.getElementById('bookingError').style.display = 'none';

  // If Stripe payment
  if (CAN_PAY && clientSecret && cardElement) {
    stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card: cardElement,
        billing_details: {
          name: fn + ' ' + ln,
          phone: phone,
        },
      },
    }).then(function(result) {
      if (result.error) {
        document.getElementById('bookingError').textContent = result.error.message;
        document.getElementById('bookingError').style.display = 'block';
        btn.disabled = false;
        btn.textContent = '\\uD83D\\uDD12 Payer ' + Math.round(calculatedFare) + '\\u20AC';
      } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
        // Also save booking
        saveBooking(fn, ln, phone, result.paymentIntent.id);
      }
    });
  } else {
    // No Stripe — free booking request
    saveBooking(fn, ln, phone, null);
  }
}

function saveBooking(firstName, lastName, phone, paymentIntentId) {
  fetch(BACKEND + '/api/driver-site/booking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG,
      pickup_address: document.getElementById('bFrom').value,
      destination: document.getElementById('bTo').value,
      booking_date: document.getElementById('bDate').value,
      booking_time: document.getElementById('bTime').value,
      passenger_name: firstName + ' ' + lastName,
      passenger_phone: phone,
      estimated_fare: calculatedFare,
      payment_intent_id: paymentIntentId,
      source: '${source}',
    }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.success) {
      document.getElementById('step2').classList.remove('visible');
      document.querySelector('.booking-progress').style.display = 'none';
      document.getElementById('bookingSub').style.display = 'none';
      document.getElementById('bookingConfirm').style.display = 'block';
    } else {
      throw new Error(data.error || 'Erreur');
    }
  })
  .catch(function(e) {
    document.getElementById('bookingError').textContent = 'Erreur: ' + e.message;
    document.getElementById('bookingError').style.display = 'block';
    var btn = document.getElementById('payBtn');
    btn.disabled = false;
    btn.textContent = CAN_PAY ? '\\uD83D\\uDD12 Payer ' + Math.round(calculatedFare) + '\\u20AC' : 'Confirmer la réservation';
  });
}

// ── TIP ──
function selectTip(amount) {
  document.querySelectorAll('.tip-btn').forEach(function(b) { b.classList.remove('selected'); });
  document.getElementById('customTip').style.display = amount === 0 ? 'block' : 'none';
  if (amount > 0) {
    document.querySelector('[data-amount="' + amount + '"]').classList.add('selected');
    selectedAmount = amount;
  } else { selectedAmount = 0; }
  updatePayBtn();
}

function updateCustom(val) { selectedAmount = parseFloat(val) || 0; updatePayBtn(); }

function updatePayBtn() {
  var btn = document.getElementById('tipPayBtn');
  btn.disabled = selectedAmount < 1;
  btn.textContent = selectedAmount >= 1 ? 'Payer ' + selectedAmount + '\\u20AC' : 'Sélectionnez un montant';
}

function processTip() {
  var btn = document.getElementById('tipPayBtn');
  var email = document.getElementById('passengerEmail').value;
  btn.disabled = true;
  btn.textContent = 'Traitement...';
  document.getElementById('tipError').style.display = 'none';
  fetch(BACKEND + '/api/driver-site/tip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, amount: selectedAmount, email: email, source: '${source}' }),
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.checkout_url) window.location.href = data.checkout_url;
    else if (data.error) throw new Error(data.error);
  })
  .catch(function(e) {
    document.getElementById('tipError').textContent = 'Erreur: ' + e.message;
    document.getElementById('tipError').style.display = 'block';
    btn.disabled = false;
    updatePayBtn();
  });
}

// ── REVIEW ──
function setRating(n) {
  selectedRating = n;
  document.querySelectorAll('.review-star').forEach(function(s, i) { s.classList.toggle('lit', i < n); });
}

function submitReview() {
  if (!selectedRating) { alert('Choisissez une note'); return; }
  var text = document.getElementById('reviewText').value;
  var name = document.getElementById('reviewName').value;
  document.getElementById('reviewError').style.display = 'none';
  fetch(BACKEND + '/api/driver-site/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, rating: selectedRating, text: text, name: name }),
  })
  .then(function() {
    document.getElementById('reviewSuccess').style.display = 'block';
    document.getElementById('reviewText').value = '';
    setRating(0);
  })
  .catch(function() {
    document.getElementById('reviewError').textContent = 'Erreur, réessayez.';
    document.getElementById('reviewError').style.display = 'block';
  });
}
</script>
</body>
</html>`;
}
