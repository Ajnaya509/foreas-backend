/**
 * PlaquetteRenderer — v104 Sprint 3C
 * ============================================================
 * Rend la plaquette commerciale HTML d'un chauffeur FOREAS.
 *
 * Principe d'alignement site ↔ plaquette :
 *   - Même palette (obsidian + cyan/violet + gold accent)
 *   - Même photo hero full-bleed + overlay gradient
 *   - Même typographie Inter 900
 *   - Même bio + stats + services que le site
 *   - QR code géant centré pointant vers https://foreas.xyz/prenom-XX
 *
 * Format cible : page A5 (148 × 210 mm) — imprimable + lisible mobile.
 * L'HTML rendu peut être converti en PDF par Puppeteer sur le microservice VPS,
 * ou servi tel quel comme page statique premium.
 *
 * Design brief appliqué :
 *   - Krug : une action par plaquette (flasher le QR)
 *   - Cialdini : preuve sociale (rating + courses) + autorité (badges) en haut
 *   - Ariely : rendre le prix visible/anchor dans les services
 *   - Norman : QR scannable d'un geste, sans effort
 */

export interface PlaquetteOptions {
  siteUrl: string; // https://foreas.xyz/karim-47
  qrSvgDataUri?: string; // data:image/svg+xml;base64,... — si omis, QR API fallback
}

/**
 * Rendu HTML autonome (inline CSS, pas de dépendance externe autre que Google Fonts).
 */
export function renderPlaquetteHtml(site: any, opts: PlaquetteOptions): string {
  const displayName = site.display_name || 'Chauffeur FOREAS';
  const firstName = displayName.split(' ')[0];
  const city = site.city || 'Paris';
  const rating = site.rating ?? 5.0;
  const totalTrips = site.total_trips ?? 0;
  const totalTipCount = site.total_tip_count ?? 0;
  const languages: string[] = site.languages || ['Français'];
  const vehicleType = site.vehicle_type || site.niche_label || 'Chauffeur VTC';
  const bio = site.bio || '';
  const photoUrl = site.photo_url;
  const pricing = site.pricing || null;
  const promoCode = site.promo_code;
  const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));

  // QR code fallback — utilise API publique QR Server (permet preview sans Puppeteer)
  const qrUrl =
    opts.qrSvgDataUri ||
    `https://api.qrserver.com/v1/create-qr-code/?size=380x380&margin=0&color=FFFFFF&bgcolor=060610&format=svg&data=${encodeURIComponent(opts.siteUrl)}`;

  // Services — 3 max pour plaquette (densité papier)
  const servicesList = buildServicesForPlaquette(site, vehicleType);

  // Tarif anchor — affiche "à partir de X€" si pricing disponible
  const priceAnchor =
    pricing?.base_fare != null
      ? `<div class="price-anchor">
           <div class="price-anchor-label">À PARTIR DE</div>
           <div class="price-anchor-value">${Math.round(pricing.base_fare)}<span class="price-anchor-cur">€</span></div>
           <div class="price-anchor-detail">Prix fixe garanti · Zéro surprise</div>
         </div>`
      : '';

  const promoBadge = promoCode
    ? `<div class="promo-strip">
         <span class="promo-label">CODE PROMO PREMIÈRE COURSE</span>
         <span class="promo-code">${promoCode}</span>
         <span class="promo-detail">${site.promo_discount_percent || 10}% de réduction</span>
       </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${displayName} · Plaquette FOREAS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
/* ═══════════════════════════════════════════════════════════
   FOREAS PLAQUETTE v104 — A5 portrait (148 × 210 mm)
   Aligné au driverSiteTemplate pour univers visuel identique
   ═══════════════════════════════════════════════════════════ */

:root {
  --cyan: #00C9FF;
  --violet: #8C52FF;
  --violet-deep: #6A3CC0;
  --gold: #F5C842;
  --bg: #060610;
  --bg2: #0c0c1a;
  --card: #111120;
  --card-border: rgba(255,255,255,0.08);
  --text: #ffffff;
  --muted: #8a8a9a;
  --subtle: #b8b8cc;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

@page {
  size: A5 portrait;
  margin: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.page {
  width: 148mm;
  min-height: 210mm;
  margin: 0 auto;
  background: var(--bg);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── HERO — Même esthétique que hero-v2 du site ── */
.hero {
  position: relative;
  height: 92mm;
  overflow: hidden;
  flex-shrink: 0;
}
.hero-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
  z-index: 1;
}
.hero-photo-placeholder {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #060610 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 120pt;
  font-weight: 900;
  color: rgba(255,255,255,0.15);
  z-index: 1;
}
.hero-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  background:
    linear-gradient(180deg,
      rgba(6,6,16,0.15) 0%,
      rgba(6,6,16,0.0) 30%,
      rgba(6,6,16,0.55) 70%,
      rgba(6,6,16,0.95) 100%),
    radial-gradient(ellipse at 30% 0%, rgba(0,201,255,0.25) 0%, transparent 55%),
    radial-gradient(ellipse at 70% 100%, rgba(140,82,255,0.28) 0%, transparent 60%);
}
.hero-content {
  position: absolute;
  left: 10mm;
  right: 10mm;
  bottom: 8mm;
  z-index: 3;
}
.hero-badges {
  display: flex;
  gap: 4px;
  margin-bottom: 5mm;
  flex-wrap: wrap;
}
.hero-badge {
  background: rgba(0,0,0,0.55);
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 100px;
  padding: 2px 8px;
  font-size: 7pt;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.2px;
}
.hero-badge.verified { border-color: rgba(0,201,255,0.45); color: var(--cyan); }
.hero-title {
  font-size: 32pt;
  font-weight: 900;
  letter-spacing: -1px;
  line-height: 0.96;
  margin-bottom: 2mm;
  text-shadow: 0 2px 10px rgba(0,0,0,0.5);
}
.hero-subline {
  font-size: 10pt;
  color: rgba(255,255,255,0.85);
  margin-bottom: 3mm;
  letter-spacing: 0.1px;
}
.hero-rating {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9pt;
}
.hero-rating .stars { color: var(--gold); letter-spacing: 1.2px; font-size: 10pt; }
.hero-rating .note  { font-weight: 700; color: #fff; }
.hero-rating .count { color: rgba(255,255,255,0.62); font-size: 8pt; }

/* ── EYEBROW section ── */
.eyebrow {
  font-size: 7pt;
  font-weight: 800;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 2mm;
}

/* ── BIO BLOCK ── */
.bio-block {
  padding: 6mm 10mm 4mm;
  border-bottom: 0.3mm solid var(--card-border);
}
.bio-text {
  font-size: 9pt;
  line-height: 1.55;
  color: var(--subtle);
  letter-spacing: -0.05px;
}

/* ── STATS STRIP ── */
.stats-strip {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 2mm;
  padding: 4mm 10mm;
  border-bottom: 0.3mm solid var(--card-border);
}
.stat-cell {
  text-align: center;
  padding: 3mm 2mm;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--card-border);
  border-radius: 3mm;
}
.stat-value {
  font-size: 18pt;
  font-weight: 900;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -0.5px;
  line-height: 1;
}
.stat-label {
  font-size: 6pt;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-top: 1mm;
  font-weight: 700;
}

/* ── SERVICES ROW ── */
.services-block {
  padding: 4mm 10mm 4mm;
}
.services-list {
  display: flex;
  flex-direction: column;
  gap: 2mm;
  margin-top: 2mm;
}
.service-row {
  display: flex;
  align-items: flex-start;
  gap: 3mm;
  padding: 3mm;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 3mm;
}
.service-icon {
  flex-shrink: 0;
  width: 8mm;
  height: 8mm;
  border-radius: 2mm;
  background: linear-gradient(135deg, rgba(0,201,255,0.15), rgba(140,82,255,0.15));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11pt;
}
.service-body {
  flex: 1;
}
.service-title {
  font-size: 9pt;
  font-weight: 800;
  letter-spacing: -0.1px;
  color: #fff;
  margin-bottom: 0.5mm;
}
.service-desc {
  font-size: 7.5pt;
  color: var(--muted);
  line-height: 1.4;
}

/* ── PRICE ANCHOR ── */
.price-anchor {
  margin: 4mm 10mm 0;
  padding: 4mm 5mm;
  background: linear-gradient(135deg, rgba(0,201,255,0.08), rgba(140,82,255,0.04));
  border: 1px solid rgba(0,201,255,0.22);
  border-radius: 3mm;
  text-align: center;
}
.price-anchor-label {
  font-size: 7pt;
  color: var(--cyan);
  font-weight: 800;
  letter-spacing: 2px;
  margin-bottom: 1mm;
}
.price-anchor-value {
  font-size: 28pt;
  font-weight: 900;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -1px;
  line-height: 1;
}
.price-anchor-cur {
  font-size: 16pt;
  margin-left: 1mm;
}
.price-anchor-detail {
  font-size: 7.5pt;
  color: var(--muted);
  margin-top: 1.5mm;
}

/* ── PROMO STRIP ── */
.promo-strip {
  margin: 3mm 10mm 0;
  padding: 3mm 4mm;
  background: linear-gradient(90deg, rgba(245,200,66,0.1), rgba(245,158,11,0.05));
  border: 1px solid rgba(245,200,66,0.3);
  border-radius: 2mm;
  display: flex;
  align-items: center;
  gap: 2mm;
}
.promo-label {
  font-size: 6.5pt;
  color: var(--gold);
  font-weight: 800;
  letter-spacing: 0.8px;
  flex: 1;
}
.promo-code {
  font-size: 10pt;
  font-weight: 900;
  color: var(--gold);
  letter-spacing: 1px;
  font-family: 'SF Mono', Menlo, monospace;
}
.promo-detail {
  font-size: 6.5pt;
  color: var(--muted);
  font-weight: 600;
}

/* ── QR BLOCK — Pièce maîtresse, scan 1 geste ── */
.qr-block {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 6mm 10mm 4mm;
  position: relative;
  background: radial-gradient(ellipse at center bottom, rgba(140,82,255,0.1) 0%, transparent 60%);
}
.qr-eyebrow {
  font-size: 8pt;
  font-weight: 800;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 3mm;
}
.qr-wrap {
  width: 38mm;
  height: 38mm;
  padding: 2mm;
  background: #060610;
  border: 1px solid var(--card-border);
  border-radius: 3mm;
  position: relative;
  margin-bottom: 3mm;
}
.qr-wrap::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 3.2mm;
  background: linear-gradient(135deg, var(--cyan), var(--violet), var(--cyan));
  background-size: 300% 100%;
  z-index: -1;
}
.qr-img {
  width: 100%;
  height: 100%;
  display: block;
}
.qr-url {
  font-size: 10pt;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  margin-bottom: 1mm;
}
.qr-url .accent {
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.qr-sub {
  font-size: 7.5pt;
  color: var(--muted);
  text-align: center;
  line-height: 1.4;
  max-width: 100mm;
}

/* ── FOOTER ── */
.footer {
  padding: 3mm 10mm;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--card-border);
  flex-shrink: 0;
}
.footer-brand {
  font-size: 8pt;
  font-weight: 800;
  letter-spacing: 1px;
  color: var(--cyan);
}
.footer-url {
  font-size: 7pt;
  color: var(--muted);
}
</style>
</head>
<body>
<div class="page">

  <!-- HERO -->
  <header class="hero">
    ${
      photoUrl
        ? `<img class="hero-photo" src="${photoUrl}" alt="${displayName}">`
        : `<div class="hero-photo-placeholder">${displayName[0].toUpperCase()}</div>`
    }
    <div class="hero-overlay"></div>
    <div class="hero-content">
      <div class="hero-badges">
        <span class="hero-badge verified">✓ VTC certifié</span>
        <span class="hero-badge">RC Pro assuré</span>
        ${totalTrips > 50 ? `<span class="hero-badge">${totalTrips}+ courses</span>` : ''}
      </div>
      <h1 class="hero-title">${displayName}</h1>
      <div class="hero-subline">${vehicleType} · ${city}${languages.length > 1 ? ' · ' + languages.join(', ') : ''}</div>
      <div class="hero-rating">
        <span class="stars">${stars}</span>
        <span class="note">${rating.toFixed(1)}</span>
        <span class="count">${totalTipCount > 0 ? totalTipCount + ' avis' : 'Nouveau'}</span>
      </div>
    </div>
  </header>

  <!-- BIO -->
  ${
    bio
      ? `<div class="bio-block">
           <div class="eyebrow">À PROPOS</div>
           <div class="bio-text">${bio.substring(0, 340)}${bio.length > 340 ? '…' : ''}</div>
         </div>`
      : ''
  }

  <!-- STATS -->
  <div class="stats-strip">
    <div class="stat-cell">
      <div class="stat-value">${totalTrips > 100 ? totalTrips + '+' : totalTrips || '—'}</div>
      <div class="stat-label">Courses</div>
    </div>
    <div class="stat-cell">
      <div class="stat-value">${rating.toFixed(1)}</div>
      <div class="stat-label">Note /5</div>
    </div>
    <div class="stat-cell">
      <div class="stat-value">${languages.length}</div>
      <div class="stat-label">${languages.length > 1 ? 'Langues' : 'Langue'}</div>
    </div>
  </div>

  <!-- SERVICES -->
  <div class="services-block">
    <div class="eyebrow">CE QUE J'OFFRE</div>
    <div class="services-list">
      ${servicesList
        .map(
          (s) => `
        <div class="service-row">
          <div class="service-icon">${s.emoji}</div>
          <div class="service-body">
            <div class="service-title">${s.title}</div>
            <div class="service-desc">${s.desc}</div>
          </div>
        </div>
      `,
        )
        .join('')}
    </div>
  </div>

  ${priceAnchor}
  ${promoBadge}

  <!-- QR BLOCK -->
  <div class="qr-block">
    <div class="qr-eyebrow">RÉSERVEZ EN 1 SCAN</div>
    <div class="qr-wrap">
      <img class="qr-img" src="${qrUrl}" alt="QR vers ${opts.siteUrl}">
    </div>
    <div class="qr-url">
      foreas.xyz<span class="accent">/${site.slug}</span>
    </div>
    <div class="qr-sub">
      Flashez ce code pour réserver votre trajet avec ${firstName}.<br>
      Prix fixe garanti · Paiement sécurisé · Sans engagement.
    </div>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    <div class="footer-brand">FOREAS</div>
    <div class="footer-url">foreas.xyz</div>
  </div>

</div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

interface PlaquetteService {
  emoji: string;
  title: string;
  desc: string;
}

function buildServicesForPlaquette(site: any, vehicleType: string): PlaquetteService[] {
  const niche = site.niche as string | undefined;

  const base: PlaquetteService[] = [
    {
      emoji: '⏱',
      title: 'Ponctualité garantie',
      desc: "Je suis sur place 5 min avant l'heure convenue, systématiquement.",
    },
  ];

  const nicheOverrides: Record<string, PlaquetteService[]> = {
    corporate: [
      {
        emoji: '✈',
        title: 'Suivi de vol',
        desc: "Je surveille votre avion en temps réel. Retard ou avance, je m'adapte.",
      },
      {
        emoji: '🤫',
        title: 'Discrétion',
        desc: 'Trajets confidentiels. Silence ou conversation, comme vous préférez.',
      },
    ],
    evenementiel: [
      {
        emoji: '👔',
        title: 'Tenue soignée',
        desc: 'Costume sombre pour vos galas, mariages et soirées importantes.',
      },
      {
        emoji: '✨',
        title: 'Véhicule impeccable',
        desc: 'Intérieur nettoyé avant chaque course. Prêt pour vos grandes occasions.',
      },
    ],
    medical: [
      {
        emoji: '💛',
        title: 'Accompagnement',
        desc: 'Patient et attentif. Aide à la descente du véhicule si besoin.',
      },
      {
        emoji: '🛋',
        title: 'Sièges confort',
        desc: 'Véhicule adapté aux trajets longs ou post-opératoires.',
      },
    ],
    transfert: [
      {
        emoji: '🧳',
        title: 'Bagages à volonté',
        desc: 'Coffre spacieux. Suivi de vol gratuit en cas de retard.',
      },
      {
        emoji: '💸',
        title: 'Forfait aéroport fixe',
        desc: 'CDG, Orly, Beauvais — tarif transparent, sans supplément nuit.',
      },
    ],
    premium: [
      {
        emoji: '⭐',
        title: 'Standing 5 étoiles',
        desc: `${vehicleType}, eau offerte, chargeur iPhone/Android, WiFi 4G.`,
      },
      {
        emoji: '🗝',
        title: 'Conciergerie',
        desc: 'Restaurant, hôtel, shopping — je conseille et je réserve pour vous.',
      },
    ],
    famille: [
      {
        emoji: '🧒',
        title: 'Sièges enfant',
        desc: 'Rehausseur et siège bébé sur demande. Sans supplément.',
      },
      {
        emoji: '🏫',
        title: 'Trajet scolaire',
        desc: 'Dépôt et reprise écoles. Parent notifié par SMS à chaque étape.',
      },
    ],
    nuit: [
      {
        emoji: '🌙',
        title: 'Disponible la nuit',
        desc: "Sorties jusqu'à 5h du matin. Retour safe garanti.",
      },
      {
        emoji: '🤝',
        title: 'Zéro jugement',
        desc: 'Clubs, restos, afters — je vous raccompagne sans faire de remarque.',
      },
    ],
  };

  const extras = (niche && nicheOverrides[niche]) || [];
  return [...base, ...extras].slice(0, 3);
}
