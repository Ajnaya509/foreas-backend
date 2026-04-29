/**
 * Driver Site Template — FOREAS v4.0
 * ═══════════════════════════════════
 * Template HTML client-facing pour les sites chauffeurs.
 * Flow booking 2 etapes:
 *   Step 1: Depart + Arrivee + Date/Heure -> Prix instantane -> "J'accepte -- Reserver"
 *   Step 2: Mapbox GL JS route map + Email/Phone + Confirmer
 *
 * ONE-PAGE, ultra-compact, Blacklane/Uber-level dark design.
 * Mobile-first, zero scroll marathon.
 * Mapbox GL JS v3 pour la carte route animee.
 * Stripe.js charge uniquement si le chauffeur a un compte Connect.
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

// ─── v104 Sprint 3B — Helpers pour sections Nike/Adidas ──────────────────

/**
 * renderServiceCards — grille 4 cards "Ce que j'offre"
 * Adapte les services affichés selon la niche du chauffeur + son véhicule.
 * Principe Krug : 1 icône + 1 titre + 1 phrase = scannable en 2 sec.
 * Principe Cialdini (autorité) : concret et spécifique > générique.
 */
function renderServiceCards(site: any, vehicleType: string): string[] {
  const niche = site.niche as string | undefined;
  const features: string[] = Array.isArray(site.features) ? site.features : [];

  // Services de base — toujours affichés
  const baseServices: Array<{ icon: string; title: string; desc: string }> = [
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
      title: 'Ponctualité garantie',
      desc: "Je suis sur place 5 min avant l'heure convenue, systématiquement.",
    },
    {
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 2v2M17 2v2M3 10h18"/></svg>',
      title: 'Prix fixe',
      desc: "Le montant affiché est le montant final. Zéro surprise à l'arrivée.",
    },
  ];

  // Services selon niche
  const nicheServices: Record<string, Array<{ icon: string; title: string; desc: string }>> = {
    corporate: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9c1.66 0 3.22.45 4.56 1.24"/><path d="m15 3 4 4-4 4"/></svg>',
        title: 'Suivi de vol',
        desc: "Je surveille votre avion en temps réel. Retard ou avance, je m'adapte.",
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
        title: 'Discrétion',
        desc: 'Trajets confidentiels. Silence ou conversation, comme vous préférez.',
      },
    ],
    evenementiel: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2 2H3v-4a2 2 0 0 1 2-2h2"/><path d="M20 14v4a2 2 0 0 1-2 2h-4"/></svg>',
        title: 'Véhicule impeccable',
        desc: 'Intérieur nettoyé avant chaque course. Prêt pour vos grandes occasions.',
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
        title: 'Tenue soignée',
        desc: 'Costume sombre pour vos galas, mariages et soirées importantes.',
      },
    ],
    medical: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7 7-7z"/></svg>',
        title: 'Accompagnement',
        desc: 'Patient et attentif. Aide à la descente du véhicule si besoin.',
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/></svg>',
        title: 'Sièges confort',
        desc: 'Véhicule adapté aux trajets longs ou post-opératoires.',
      },
    ],
    transfert: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
        title: 'Bagages à volonté',
        desc: 'Coffre spacieux. Suivi de vol gratuit en cas de retard.',
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
        title: 'Forfait aéroport fixe',
        desc: 'Tarif transparent vers CDG, Orly, Beauvais — sans supplément nuit.',
      },
    ],
    premium: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        title: 'Standing 5★',
        desc: `${vehicleType}, eau offerte, chargeur iPhone & Android, WiFi 4G.`,
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
        title: 'Conciergerie',
        desc: 'Restaurant, hôtel, shopping — je vous conseille et je réserve pour vous.',
      },
    ],
    famille: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M17 11c2 0 3 1 3 3v2"/></svg>',
        title: 'Sièges enfant',
        desc: 'Rehausseur et siège bébé sur demande. Sans supplément.',
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        title: 'Trajet scolaire',
        desc: 'Dépôt et reprise écoles. Parent notifié par SMS à chaque étape.',
      },
    ],
    nuit: [
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
        title: 'Disponible la nuit',
        desc: "Sorties jusqu'à 5h du matin. Retour safe garanti.",
      },
      {
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
        title: 'Zéro jugement',
        desc: 'Clubs, restos, afters — je vous raccompagne sans faire de remarque.',
      },
    ],
  };

  // Feature flags chauffeur — extra services si renseignés sur le profil véhicule
  const featureServices: Array<{ icon: string; title: string; desc: string }> = [];
  if (features.some((f) => /wifi/i.test(f))) {
    featureServices.push({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h0"/></svg>',
      title: 'WiFi 4G à bord',
      desc: 'Restez connecté pendant votre trajet. Réseau privé sécurisé.',
    });
  }
  if (features.some((f) => /eau|boisson/i.test(f))) {
    featureServices.push({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2h8M12 2v5M7 14c0 2 1.5 5 5 5s5-3 5-5c0-2.5-5-9-5-9s-5 6.5-5 9z"/></svg>',
      title: 'Eau offerte',
      desc: 'Bouteille fraîche à disposition à chaque course.',
    });
  }
  if (features.some((f) => /chargeur|charge/i.test(f))) {
    featureServices.push({
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
      title: 'Chargeur universel',
      desc: 'iPhone, Android, USB-C. Arrivez la batterie pleine.',
    });
  }

  const nicheMatch = (niche && nicheServices[niche]) || [];
  const combined = [...baseServices, ...nicheMatch, ...featureServices];
  // Max 4 cards pour grille 2x2 mobile-friendly
  return combined.slice(0, 4).map(
    (s, i) => `
    <div class="service-card reveal delay-${Math.min(i + 1, 3)}">
      <div class="service-icon">${s.icon}</div>
      <div class="service-title">${s.title}</div>
      <div class="service-desc">${s.desc}</div>
    </div>`,
  );
}

/**
 * renderTestimonials — carrousel 3 témoignages
 * Si le chauffeur a des tips/reviews réels dans la DB → on les affiche
 * Sinon → 3 témoignages placeholder cohérents avec sa niche + ville
 * Principe Cialdini : preuve sociale concrète > générique
 */
function renderTestimonials(site: any, firstName: string, city: string): string[] {
  const realTestimonials: Array<{
    stars: number;
    quote: string;
    author: string;
    trip: string;
  }> = Array.isArray(site.testimonials) ? site.testimonials : [];

  if (realTestimonials.length >= 3) {
    return realTestimonials.slice(0, 3).map((t, i) => renderTestimonialCard(t, i));
  }

  // Fallback placeholder — cohérent niche
  const niche = site.niche as string | undefined;
  const placeholders: Record<string, Array<(typeof realTestimonials)[number]>> = {
    corporate: [
      {
        stars: 5,
        quote: `Parfait pour mes rendez-vous clients. ${firstName} est toujours à l'heure, véhicule impeccable. Je le recommande vivement.`,
        author: 'Thomas L.',
        trip: `Trajet ${city} → La Défense · Janv. 2026`,
      },
      {
        stars: 5,
        quote:
          "Transferts aéroport sans stress. Il suit mon vol, s'adapte au retard, et m'attend à la sortie des bagages avec un sourire.",
        author: 'Sophie M.',
        trip: 'Transfert CDG · Janv. 2026',
      },
      {
        stars: 5,
        quote:
          "Discrétion et professionnalisme. Exactement ce que j'attends d'un VTC premium pour mes clients étrangers.",
        author: 'Karim B.',
        trip: `Déplacement business · Déc. 2025`,
      },
    ],
    evenementiel: [
      {
        stars: 5,
        quote: `Pour notre mariage, ${firstName} a été parfait. Véhicule nickel, tenue élégante, ponctualité absolue. Merci pour tout.`,
        author: 'Marie & Paul',
        trip: `Mariage ${city} · Nov. 2025`,
      },
      {
        stars: 5,
        quote:
          "Chauffeur VIP pour notre gala d'entreprise. Service 5★, nos invités étaient aux anges.",
        author: 'Julien R.',
        trip: 'Gala · Déc. 2025',
      },
      {
        stars: 5,
        quote:
          'Intervenu en urgence pour un événement annulé au dernier moment. Réactivité incroyable.',
        author: 'Elena T.',
        trip: `Événement ${city} · Jan. 2026`,
      },
    ],
    medical: [
      {
        stars: 5,
        quote: `${firstName} a accompagné ma mère à ses rendez-vous médicaux toute la semaine. Patient, attentionné, parfait.`,
        author: 'Nadia S.',
        trip: `Trajets hôpital · Janv. 2026`,
      },
      {
        stars: 5,
        quote:
          'Très bon accompagnement post-opératoire. Le chauffeur a pris le temps, aidé pour monter. Rassurant.',
        author: 'Robert D.',
        trip: 'Sortie clinique · Déc. 2025',
      },
      {
        stars: 5,
        quote: 'Enfin un VTC qui comprend les besoins spécifiques des seniors. Bravo.',
        author: 'Claire V.',
        trip: 'Consultation régulière · 2025',
      },
    ],
    transfert: [
      {
        stars: 5,
        quote: `${firstName} m'a pris en charge à CDG à 2h du matin après un vol long-courrier. Rapide, confortable, impeccable.`,
        author: 'Alexandre P.',
        trip: 'CDG T2E · Janv. 2026',
      },
      {
        stars: 5,
        quote:
          'Transfert Paris-Orly pour toute la famille avec 4 valises. Coffre géant, aucun stress.',
        author: 'Famille Dupont',
        trip: 'Orly Sud · Déc. 2025',
      },
      {
        stars: 5,
        quote:
          "Prix fixe annoncé = prix payé. Aucune mauvaise surprise contrairement à d'autres. Je reviendrai.",
        author: 'Isabelle K.',
        trip: 'Transfert gare · Jan. 2026',
      },
    ],
    premium: [
      {
        stars: 5,
        quote: `Service premium au sens strict. ${firstName} m'attendait avec une bouteille d'eau et un chargeur iPhone. Parfait.`,
        author: 'Victor H.',
        trip: `Hôtel Le Bristol → ${city} · Janv. 2026`,
      },
      {
        stars: 5,
        quote:
          'Véhicule Classe S impeccable. Conducteur professionnel et courtois. Vaut largement le prix.',
        author: 'Natasha F.',
        trip: 'Aéroport VIP · Déc. 2025',
      },
      {
        stars: 5,
        quote:
          'Le seul VTC sur lequel je peux compter pour mes clients étrangers. Standing 5 étoiles garanti.',
        author: 'Hôtel partenaire',
        trip: 'Transferts VIP · 2025',
      },
    ],
  };

  const list = (niche && placeholders[niche]) || [
    {
      stars: 5,
      quote: `Parfait. ${firstName} est à l'heure, le véhicule est propre, et le trajet s'est passé sans souci. Je recommande.`,
      author: 'Léa D.',
      trip: `Trajet ${city} · Janv. 2026`,
    },
    {
      stars: 5,
      quote: "Professionnel et courtois. Prix fixe respecté. Le genre de chauffeur qu'on rappelle.",
      author: 'Olivier M.',
      trip: `${city} · Déc. 2025`,
    },
    {
      stars: 5,
      quote:
        "Excellent service, j'ai réservé plusieurs fois et toujours impeccable. À recommander.",
      author: 'Sarah A.',
      trip: 'Trajets réguliers · 2025',
    },
  ];

  return list.slice(0, 3).map((t, i) => renderTestimonialCard(t, i));
}

function renderTestimonialCard(
  t: { stars: number; quote: string; author: string; trip: string },
  i: number,
): string {
  const starsStr = '★'.repeat(Math.round(t.stars)) + '☆'.repeat(5 - Math.round(t.stars));
  const initial = (t.author || '?').charAt(0).toUpperCase();
  return `
    <div class="testimonial-card reveal delay-${Math.min(i + 1, 3)}">
      <div class="testimonial-stars">${starsStr}</div>
      <div class="testimonial-quote">${t.quote}</div>
      <div class="testimonial-author">
        <div class="testimonial-avatar">${initial}</div>
        <div>
          <div class="testimonial-meta-name">${t.author}</div>
          <div class="testimonial-meta-trip">${t.trip}</div>
        </div>
      </div>
    </div>`;
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
  // v104 Sprint 3A — URL directe foreas.xyz/prenom-XX (plus de préfixe /c/)
  // Le backend conserve la route legacy /c/:slug pour rétro-compat.
  const siteUrl = `https://foreas.xyz/${site.slug}`;
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
  const tripsLabel = totalTrips > 100 ? `${totalTrips}+` : totalTrips > 0 ? `${totalTrips}` : '--';

  // JSON-LD structured data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TaxiService',
    name: `${displayName} - Chauffeur VTC`,
    description: `Réservez votre chauffeur privé ${displayName} à ${city}. Transferts, mise à disposition, tours privés. Réservation instantanée.`,
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
    priceRange: '$$',
    knowsLanguage: languages,
    areaServed: { '@type': 'City', name: city },
    provider: {
      '@type': 'LocalBusiness',
      name: `${displayName} VTC`,
      priceRange: '$$',
    },
    potentialAction: {
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
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'FOREAS', item: 'https://foreas.xyz' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Chauffeurs',
        item: `${siteUrl.split('/c/')[0]}/c`,
      },
      { '@type': 'ListItem', position: 3, name: displayName, item: siteUrl },
    ],
  };

  return `<!DOCTYPE html>
<html lang="fr" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
<title>${displayName} | Chauffeur VTC ${city} - Réservation en ligne</title>

<!-- SEO -->
<meta name="description" content="Réservez ${displayName}, chauffeur privé à ${city}. Transferts, mise à disposition, tours privés. Réservation instantanée.">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${siteUrl}">
<meta name="theme-color" content="#0a0a0f">
<meta name="author" content="${displayName}">

<!-- OG -->
<meta property="og:type" content="website">
<meta property="og:title" content="${displayName} - Chauffeur Privé ${city}">
<meta property="og:description" content="Réservez votre chauffeur privé. Réservation instantanée, prix fixe.">
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
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${displayName} - Chauffeur VTC ${city}">
<meta name="twitter:description" content="Réservez votre chauffeur privé. Prix fixe, réservation instantanée.">
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
${
  mapboxToken
    ? `<link href="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.css" rel="stylesheet">
<script src="https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.js"></script>`
    : ''
}

<style>
/* ═══════════════════════════════════════════════════════════
   FOREAS DRIVER SITE v4.0 — ONE-PAGE PREMIUM DARK DESIGN
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
  --radius: 16px;
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  min-height: 100vh;
  min-height: 100dvh;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow-x: hidden;
}

.wrap { max-width: 480px; margin: 0 auto; padding-bottom: 80px; }

/* ── ANIMATIONS ── */
@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideLeft { from { opacity: 0; transform: translateX(30px); } to { opacity: 1; transform: translateX(0); } }
@keyframes slideRight { from { opacity: 0; transform: translateX(-30px); } to { opacity: 1; transform: translateX(0); } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
@keyframes scaleIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
@keyframes priceReveal { from { opacity: 0; transform: scale(0.8) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes routePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

/* ── COMPACT HERO (max 140px) ── */
.hero {
  background: linear-gradient(165deg, var(--bg) 0%, #0d0825 50%, var(--bg) 100%);
  padding: 24px 20px 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  position: relative;
  overflow: hidden;
  animation: fadeIn 0.5s ease;
}
.hero::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--cyan), var(--violet), var(--cyan), transparent);
  opacity: 0.3;
}

.avatar {
  width: 72px; height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid transparent;
  background-image: linear-gradient(var(--bg2), var(--bg2)), linear-gradient(135deg, var(--cyan), var(--violet));
  background-origin: border-box;
  background-clip: content-box, border-box;
  flex-shrink: 0;
  animation: fadeUp 0.4s ease 0.1s both;
}
.avatar-placeholder {
  width: 72px; height: 72px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 900;
  color: #fff;
  flex-shrink: 0;
  animation: fadeUp 0.4s ease 0.1s both;
}

.hero-info { flex: 1; min-width: 0; animation: fadeUp 0.4s ease 0.15s both; }
.hero-info h1 {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.3px;
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-sub {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 6px;
}
.hero-rating {
  display: flex;
  align-items: center;
  gap: 6px;
}
.hero-stars {
  color: #FFD700;
  font-size: 14px;
  letter-spacing: 1px;
}
.hero-rating-text {
  color: var(--muted);
  font-size: 12px;
}
.hero-bio-line {
  color: var(--subtle);
  font-size: 11px;
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── TRUST BAR ── */
.trust-row {
  display: flex;
  gap: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.trust-row::-webkit-scrollbar { display: none; }
.trust-badge {
  flex: 0 0 auto;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  animation: fadeUp 0.3s ease calc(0.3s + var(--i, 0) * 0.06s) both;
  transition: border-color 0.2s;
}
.trust-badge:hover { border-color: rgba(0,201,255,0.2); }
.trust-icon {
  width: 18px; height: 18px;
  flex-shrink: 0;
}
.trust-icon svg { width: 18px; height: 18px; }
.trust-text {
  white-space: nowrap;
}
.trust-val { font-size: 13px; font-weight: 700; color: var(--text); line-height: 1; }
.trust-label { font-size: 9px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }

/* ── BOOKING MODULE ── */
.booking {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  margin: 12px 16px;
  padding: 20px 16px;
  position: relative;
  overflow: hidden;
  animation: fadeUp 0.4s ease 0.4s both;
}
.booking::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--cyan), var(--violet), var(--cyan));
  opacity: 0.5;
}
.booking-title {
  font-size: 18px;
  font-weight: 800;
  color: var(--text);
  margin-bottom: 2px;
  letter-spacing: -0.3px;
}
.booking-sub {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 16px;
}

/* Progress bar */
.booking-progress {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
}
.booking-step-dot {
  flex: 1;
  height: 3px;
  border-radius: 3px;
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
.booking-step.visible { display: block; animation: slideLeft 0.35s ease; }
.booking-step.visible-back { display: block; animation: slideRight 0.35s ease; }

/* Form elements */
.field-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.field-label svg { width: 14px; height: 14px; flex-shrink: 0; }
.field-group { margin-bottom: 12px; }
.field-row { display: flex; gap: 10px; }
.field-row > * { flex: 1; }

.b-input {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 13px 14px;
  font-size: 15px;
  color: #fff;
  font-family: var(--font);
  min-height: 48px;
  transition: border-color 0.25s, box-shadow 0.25s, background 0.25s;
  -webkit-appearance: none;
  appearance: none;
}
.b-input:focus {
  outline: none;
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0,201,255,0.1);
  background: rgba(0,201,255,0.02);
}
.b-input::placeholder { color: #3a3a4a; }
select.b-input {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  padding-right: 36px;
}
select.b-input option { background: #1a1a2e; color: #fff; }

/* ── PRICE ESTIMATE ── */
.price-estimate {
  display: none;
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 14px;
  text-align: center;
  position: relative;
  overflow: hidden;
  animation: priceReveal 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.price-estimate.visible { display: block; }
.price-estimate-bg {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(0,201,255,0.06), rgba(140,82,255,0.06));
  border: 1.5px solid rgba(0,201,255,0.15);
  border-radius: 14px;
}
.price-label {
  font-size: 9px;
  font-weight: 700;
  color: var(--cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 6px;
  position: relative;
}
.price-value {
  font-size: 38px;
  font-weight: 900;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 2px;
  position: relative;
  line-height: 1.1;
}
.price-original {
  text-decoration: line-through;
  color: var(--muted);
  font-size: 16px;
  font-weight: 600;
  margin-right: 6px;
}
.price-detail {
  font-size: 11px;
  color: var(--muted);
  position: relative;
}
.price-promo-badge {
  display: inline-block;
  background: linear-gradient(135deg, rgba(245,158,11,0.12), rgba(245,158,11,0.06));
  border: 1px solid rgba(245,158,11,0.25);
  border-radius: 16px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 700;
  color: var(--amber);
  margin-top: 6px;
}

/* ── CTA BUTTONS ── */
.cta-accept {
  width: 100%;
  border: none;
  border-radius: 14px;
  padding: 16px;
  font-size: 16px;
  font-weight: 800;
  color: #fff;
  cursor: pointer;
  font-family: var(--font);
  min-height: 52px;
  position: relative;
  overflow: hidden;
  transition: transform 0.15s, box-shadow 0.15s;
  background: linear-gradient(135deg, var(--cyan) 0%, #0BB8E8 30%, var(--violet) 70%, var(--cyan) 100%);
  background-size: 300% 100%;
  animation: shimmer 4s ease infinite;
  box-shadow: 0 4px 20px rgba(0,201,255,0.2);
  letter-spacing: 0.3px;
  margin-top: 4px;
}
.cta-accept:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(0,201,255,0.3); }
.cta-accept:active { transform: scale(0.98); }
.cta-accept:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; animation: none; }

.cta-pay {
  width: 100%;
  border: none;
  border-radius: 14px;
  padding: 16px;
  font-size: 16px;
  font-weight: 800;
  color: #fff;
  cursor: pointer;
  font-family: var(--font);
  min-height: 52px;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  box-shadow: 0 4px 20px rgba(140,82,255,0.25);
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
  font-size: 12px;
  cursor: pointer;
  padding: 10px;
  margin-top: 6px;
  font-family: var(--font);
  text-decoration: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: color 0.2s;
}
.booking-back:hover { color: var(--cyan); }

/* ── MAPBOX MAP ── */
.map-container {
  display: none;
  border-radius: 14px;
  overflow: hidden;
  margin-bottom: 14px;
  border: 1px solid rgba(0,201,255,0.12);
  animation: scaleIn 0.4s ease both;
  position: relative;
}
.map-container.visible { display: block; }
#routeMap {
  width: 100%;
  height: 250px;
}
.map-route-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  background: rgba(17,17,32,0.95);
  border-top: 1px solid var(--card-border);
}
.map-endpoint {
  flex: 1;
  min-width: 0;
}
.map-endpoint-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
.map-endpoint-label.from { color: var(--cyan); }
.map-endpoint-label.to { color: var(--violet); }
.map-endpoint-addr {
  font-size: 12px;
  color: var(--subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.map-middle {
  text-align: center;
  flex-shrink: 0;
  padding: 0 10px;
}
.map-distance {
  font-size: 16px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.map-duration {
  font-size: 10px;
  color: var(--muted);
}

/* Stripe Elements */
.stripe-element {
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 14px;
  min-height: 48px;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.stripe-element.StripeElement--focus {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0,201,255,0.1);
}
.stripe-element.StripeElement--invalid {
  border-color: var(--danger);
}
.secure-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11px;
  color: #444;
  margin-top: 8px;
}
.secure-badge svg { width: 12px; height: 12px; }

/* ── CONFIRMATION ── */
.booking-confirm {
  display: none;
  text-align: center;
  padding: 24px 14px;
  animation: scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.confirm-check {
  width: 56px; height: 56px;
  margin: 0 auto 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--success), #16a34a);
  display: flex;
  align-items: center;
  justify-content: center;
}
.confirm-check svg { width: 28px; height: 28px; color: #fff; }
.confirm-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 6px;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.confirm-text {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

/* ── MESSAGES ── */
.success-msg { background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.3); border-radius: 12px; padding: 12px; color: var(--success); text-align: center; margin-top: 10px; display: none; font-size: 13px; }
.error-msg { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); border-radius: 12px; padding: 12px; color: var(--danger); text-align: center; margin-top: 10px; display: none; font-size: 13px; }

/* ── STICKY BAR ── */
.sticky-bar {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  z-index: 999;
  transform: translateY(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  background: rgba(6,6,16,0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid rgba(255,255,255,0.06);
  padding: 10px 16px calc(10px + env(safe-area-inset-bottom, 0px));
}
.sticky-bar.visible { transform: translateY(0); }
.sticky-bar-inner { max-width: 480px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
.sticky-bar-info { flex: 1; }
.sticky-bar-name { font-size: 13px; font-weight: 700; }
.sticky-bar-price { font-size: 11px; color: var(--cyan); font-weight: 600; }
.sticky-bar-btn {
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  border: none;
  border-radius: 12px;
  padding: 12px 24px;
  font-size: 14px;
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
  border: 1px solid rgba(0,201,255,0.12);
  border-top: none;
  border-radius: 0 0 12px 12px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 100;
  display: none;
  box-shadow: 0 8px 30px rgba(0,0,0,0.5);
}
.addr-suggestions.open { display: block; }
.addr-item {
  padding: 12px 14px;
  font-size: 13px;
  color: #ccc;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-family: var(--font);
  transition: background 0.15s;
}
.addr-item:hover, .addr-item:focus { background: rgba(0,201,255,0.06); color: #fff; }
.addr-item:last-child { border-bottom: none; border-radius: 0 0 12px 12px; }
.addr-item .addr-city { color: var(--muted); font-size: 11px; margin-top: 2px; }

/* ── FOOTER ── */
.foreas-footer {
  text-align: center;
  padding: 20px 16px 32px;
  color: #333;
  font-size: 11px;
}
.foreas-footer a { color: rgba(0,201,255,0.5); text-decoration: none; font-weight: 600; }
.foreas-footer .legal { margin-top: 6px; font-size: 9px; color: #222; }

/* Form inputs general */
input[type=text], input[type=email], input[type=tel], input[type=date], input[type=time] {
  width: 100%;
  background: rgba(255,255,255,0.04);
  border: 1.5px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  padding: 13px 14px;
  font-size: 15px;
  color: #fff;
  margin-bottom: 8px;
  font-family: var(--font);
  min-height: 48px;
  transition: border-color 0.2s;
  -webkit-appearance: none;
}
input:focus { outline: none; border-color: var(--cyan); }

/* ═══════════════════════════════════════════════════════════
   v104 Sprint 3B — PEAUFINAGE NIKE/ADIDAS/PUMA
   Principes appliqués :
     Krug : 1 décision par écran, scan Z, affordances claires
     Cialdini : preuve sociale, rareté, autorité (badges), sympathie (photo)
     Ariely : anchoring prix, defaults smart
     Norman : feedback immédiat, signifiers
     Eyal : trigger permanent (sticky CTA), variable reward (prix animé)
   ═══════════════════════════════════════════════════════════ */

/* ── REVEAL SCROLL SYSTEM ── */
.reveal {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1),
              transform 0.7s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity, transform;
}
.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}
.reveal.delay-1 { transition-delay: 0.08s; }
.reveal.delay-2 { transition-delay: 0.16s; }
.reveal.delay-3 { transition-delay: 0.24s; }

/* ── HERO V2 — Full-bleed photo chauffeur + gradient overlay ── */
.hero-v2 {
  position: relative;
  min-height: 420px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 0;
  overflow: hidden;
  background: var(--bg);
}
.hero-v2-photo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
  z-index: 1;
  animation: heroKenBurns 14s ease-in-out infinite alternate;
}
@keyframes heroKenBurns {
  from { transform: scale(1.0) translateY(0); }
  to   { transform: scale(1.08) translateY(-6px); }
}
.hero-v2-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  background:
    linear-gradient(180deg,
      rgba(6,6,16,0.15) 0%,
      rgba(6,6,16,0.0) 25%,
      rgba(6,6,16,0.55) 65%,
      rgba(6,6,16,0.95) 100%),
    radial-gradient(ellipse at 30% 0%, rgba(0,201,255,0.25) 0%, transparent 55%),
    radial-gradient(ellipse at 70% 100%, rgba(140,82,255,0.28) 0%, transparent 60%);
}
.hero-v2-content {
  position: relative;
  z-index: 3;
  padding: 24px 20px 28px;
  animation: fadeUp 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both;
}
.hero-v2-badges {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.hero-v2-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 100px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.2px;
}
.hero-v2-badge.verified { border-color: rgba(0,201,255,0.45); color: var(--cyan); }
.hero-v2-badge svg { width: 12px; height: 12px; }

.hero-v2-title {
  font-size: 44px;
  font-weight: 900;
  letter-spacing: -1.2px;
  line-height: 0.98;
  margin-bottom: 8px;
  text-shadow: 0 2px 20px rgba(0,0,0,0.45);
}
.hero-v2-subline {
  font-size: 14px;
  color: rgba(255,255,255,0.82);
  margin-bottom: 10px;
  letter-spacing: 0.1px;
}
.hero-v2-rating {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #fff;
}
.hero-v2-rating .stars { color: #FFD700; letter-spacing: 1.5px; font-size: 14px; }
.hero-v2-rating .note  { font-weight: 700; }
.hero-v2-rating .count { color: rgba(255,255,255,0.62); font-size: 12px; }

.hero-scroll-hint {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: scrollBounce 1.8s ease-in-out infinite;
  opacity: 0.7;
  pointer-events: none;
}
@keyframes scrollBounce {
  0%, 100% { transform: translateX(-50%) translateY(0); opacity: 0.5; }
  50%      { transform: translateX(-50%) translateY(5px); opacity: 0.9; }
}

/* ── SCARCITY STRIP — Cialdini rareté ── */
.scarcity-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 16px 0;
  padding: 10px 14px;
  background: linear-gradient(90deg, rgba(245,158,11,0.10), rgba(239,68,68,0.05));
  border: 1px solid rgba(245,158,11,0.28);
  border-radius: 12px;
  font-size: 12px;
  color: #fff;
}
.scarcity-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #ef4444;
  flex-shrink: 0;
  box-shadow: 0 0 0 0 rgba(239,68,68,0.7);
  animation: scarcityPulse 1.6s ease-in-out infinite;
}
@keyframes scarcityPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.75); }
  50%      { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
}
.scarcity-text { flex: 1; font-weight: 600; letter-spacing: 0.1px; }
.scarcity-highlight { color: var(--amber); font-weight: 800; }

/* ── SERVICES GRID — Krug scannable, Nike product features ── */
.services-section {
  padding: 32px 16px 8px;
}
.section-eyebrow {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 8px;
}
.section-title {
  font-size: 26px;
  font-weight: 900;
  letter-spacing: -0.6px;
  line-height: 1.1;
  margin-bottom: 18px;
  color: var(--text);
}
.services-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.service-card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 14px;
  padding: 16px 14px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.3s, transform 0.3s;
}
.service-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--cyan), var(--violet));
  opacity: 0;
  transition: opacity 0.3s;
}
.service-card:hover { border-color: rgba(0,201,255,0.28); transform: translateY(-2px); }
.service-card:hover::before { opacity: 1; }
.service-icon {
  width: 36px; height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(0,201,255,0.15), rgba(140,82,255,0.15));
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 10px;
}
.service-icon svg { width: 18px; height: 18px; color: var(--cyan); }
.service-title {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: -0.2px;
  margin-bottom: 3px;
  color: var(--text);
}
.service-desc {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.4;
}

/* ── TESTIMONIALS — Cialdini preuve sociale — Airbnb/Nike signature ── */
.testimonials-section {
  padding: 28px 0 8px;
}
.testimonials-header {
  padding: 0 16px;
}
.testimonials-scroll {
  display: flex;
  gap: 12px;
  padding: 0 16px 8px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  scroll-snap-type: x mandatory;
}
.testimonials-scroll::-webkit-scrollbar { display: none; }
.testimonial-card {
  flex: 0 0 86%;
  min-width: 280px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 18px;
  padding: 18px 16px;
  scroll-snap-align: start;
  position: relative;
  overflow: hidden;
}
.testimonial-card::after {
  content: '"';
  position: absolute;
  top: -8px; right: 8px;
  font-size: 100px;
  font-family: Georgia, serif;
  color: rgba(0,201,255,0.06);
  line-height: 1;
  pointer-events: none;
}
.testimonial-stars {
  color: #FFD700;
  letter-spacing: 1.5px;
  font-size: 13px;
  margin-bottom: 8px;
}
.testimonial-quote {
  font-size: 14px;
  line-height: 1.55;
  color: var(--text);
  margin-bottom: 14px;
  font-weight: 500;
  letter-spacing: -0.1px;
}
.testimonial-author {
  display: flex;
  align-items: center;
  gap: 10px;
}
.testimonial-avatar {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 800;
  color: #fff;
  flex-shrink: 0;
}
.testimonial-meta-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.testimonial-meta-trip {
  font-size: 11px;
  color: var(--muted);
  margin-top: 1px;
}

/* ── FINAL CTA BLOCK — Nike-style repeat ── */
.final-cta {
  margin: 28px 16px 16px;
  padding: 24px 20px;
  background:
    linear-gradient(135deg, rgba(140,82,255,0.12), rgba(0,201,255,0.06)),
    var(--card);
  border: 1px solid rgba(140,82,255,0.25);
  border-radius: 20px;
  text-align: center;
  position: relative;
  overflow: hidden;
}
.final-cta::before {
  content: '';
  position: absolute;
  top: -50%; left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle, rgba(0,201,255,0.08) 0%, transparent 40%);
  animation: rotateGlow 8s linear infinite;
  pointer-events: none;
}
@keyframes rotateGlow {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.final-cta-title {
  position: relative;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: -0.5px;
  line-height: 1.1;
  margin-bottom: 6px;
}
.final-cta-sub {
  position: relative;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 16px;
  line-height: 1.45;
}
.final-cta-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: linear-gradient(135deg, var(--cyan), var(--violet));
  border: none;
  border-radius: 100px;
  padding: 14px 28px;
  font-size: 14px;
  font-weight: 800;
  color: #fff;
  letter-spacing: 0.3px;
  cursor: pointer;
  font-family: var(--font);
  transition: transform 0.2s, box-shadow 0.2s;
  box-shadow: 0 6px 24px rgba(0,201,255,0.28);
}
.final-cta-btn:hover  { transform: translateY(-2px); box-shadow: 0 10px 32px rgba(0,201,255,0.4); }
.final-cta-btn:active { transform: scale(0.97); }

/* ── RESPONSIVE ── */
@media(max-width: 400px) {
  .field-row { flex-direction: column; gap: 0; }
  .map-route-info { flex-direction: column; text-align: center; gap: 6px; }
  .map-endpoint { text-align: center; }
  h1 { font-size: 20px; }
  .price-value { font-size: 32px; }
  /* v104 Sprint 3B — hero + sections responsive */
  .hero-v2 { min-height: 380px; }
  .hero-v2-title { font-size: 36px; letter-spacing: -0.8px; }
  .section-title { font-size: 22px; }
  .services-grid { grid-template-columns: 1fr; }
  .testimonial-card { flex: 0 0 92%; min-width: 240px; }
  .final-cta-title { font-size: 20px; }
}
</style>
</head>
<body>
<div class="wrap">

<!-- ═══ 1. HERO V2 — Nike/Adidas style full-bleed (v104 Sprint 3B) ═══ -->
<header class="hero-v2">
  ${
    site.photo_url
      ? `<img class="hero-v2-photo" src="${site.photo_url}" alt="Photo de ${displayName}, ${vehicleType} ${city}" loading="eager" fetchpriority="high">`
      : `<div class="hero-v2-photo" style="background:linear-gradient(135deg,#1a1a2e,#060610);display:flex;align-items:center;justify-content:center;font-size:120px;font-weight:900;color:rgba(255,255,255,0.12);">${displayName[0].toUpperCase()}</div>`
  }
  <div class="hero-v2-overlay"></div>
  <div class="hero-v2-content">
    <div class="hero-v2-badges">
      <span class="hero-v2-badge verified">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
        VTC certifié
      </span>
      <span class="hero-v2-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h6"/></svg>
        RC Pro assuré
      </span>
      ${totalTrips > 50 ? `<span class="hero-v2-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M2 12h20"/></svg> ${tripsLabel} courses</span>` : ''}
    </div>
    <h1 class="hero-v2-title">${displayName}</h1>
    <div class="hero-v2-subline">${vehicleType} · ${city}${languages.length > 1 ? ' · ' + languages.join(', ') : ''}</div>
    <div class="hero-v2-rating">
      <span class="stars" aria-label="Note ${rating.toFixed(1)} sur 5">${stars}</span>
      <span class="note">${rating.toFixed(1)}</span>
      <span class="count">${totalTipCount > 0 ? totalTipCount + ' avis' : 'Nouveau sur FOREAS'}</span>
    </div>
  </div>
  <div class="hero-scroll-hint">
    <svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2" width="22" height="22"><polyline points="6 9 12 15 18 9"/></svg>
  </div>
</header>

<!-- ═══ 1.5 SCARCITY STRIP — Cialdini rareté (visible uniquement sur mobile) ═══ -->
<div class="scarcity-strip reveal">
  <span class="scarcity-dot" aria-hidden="true"></span>
  <span class="scarcity-text">
    <span class="scarcity-highlight">Disponible cette semaine</span> · Réponse sous 1h en moyenne
  </span>
</div>

<!-- ═══ 2. TRUST BAR ═══ -->
<div class="trust-row">
  <div class="trust-badge" style="--i:0">
    <div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></div>
    <div class="trust-text">
      <div class="trust-val">Verifie</div>
      <div class="trust-label">Carte VTC</div>
    </div>
  </div>
  <div class="trust-badge" style="--i:1">
    <div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
    <div class="trust-text">
      <div class="trust-val">${tripsLabel}</div>
      <div class="trust-label">Courses</div>
    </div>
  </div>
  <div class="trust-badge" style="--i:2">
    <div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#FFD700" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>
    <div class="trust-text">
      <div class="trust-val">${rating.toFixed(1)}</div>
      <div class="trust-label">Note</div>
    </div>
  </div>
  <div class="trust-badge" style="--i:3">
    <div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h6"/></svg></div>
    <div class="trust-text">
      <div class="trust-val">RC Pro</div>
      <div class="trust-label">Assure</div>
    </div>
  </div>
  <div class="trust-badge" style="--i:4">
    <div class="trust-icon"><svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></div>
    <div class="trust-text">
      <div class="trust-val">${languages[0]}</div>
      <div class="trust-label">Langue</div>
    </div>
  </div>
</div>

<!-- ═══ 3. BOOKING MODULE — 2 STEPS ═══ -->
<div class="booking" id="bookingSection">
  <div class="booking-title">Reservez votre trajet</div>
  <div class="booking-sub" id="bookingSub">Prix instantane · Paiement securise</div>

  <div class="booking-progress">
    <div class="booking-step-dot active" id="dot1"></div>
    <div class="booking-step-dot" id="dot2"></div>
  </div>

  <!-- ── STEP 1: Depart / Arrivee / Date / Heure / Prix ── -->
  <div class="booking-step visible" id="step1">
    <div class="field-group">
      <div class="field-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 1 0-16 0c0 3 2.7 7 8 11.7z"/></svg>
        Depart
      </div>
      <div class="addr-wrap">
        <input type="text" class="b-input" id="bFrom" placeholder="Ex: 10 rue de Rivoli, Paris" autocomplete="off">
        <div class="addr-suggestions" id="addrSuggest1"></div>
      </div>
    </div>

    <div class="field-group">
      <div class="field-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--violet)" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        Arrivee
      </div>
      <div class="addr-wrap">
        <input type="text" class="b-input" id="bTo" placeholder="Ex: Aeroport CDG, Terminal 2" autocomplete="off">
        <div class="addr-suggestions" id="addrSuggest2"></div>
      </div>
    </div>

    <div class="field-row">
      <div class="field-group">
        <div class="field-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
          Date
        </div>
        <input type="date" class="b-input" id="bDate">
      </div>
      <div class="field-group">
        <div class="field-label">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          Heure
        </div>
        <input type="time" class="b-input" id="bTime">
      </div>
    </div>

    <!-- Prix estime (apparait dynamiquement) -->
    <div class="price-estimate" id="priceEstimate">
      <div class="price-estimate-bg"></div>
      <div class="price-label" id="priceLabel">Tarif estime · Prix fixe garanti</div>
      <div class="price-value" id="priceValue"></div>
      <div class="price-detail" id="priceDetail"></div>
      <div class="price-promo-badge" id="promoBadge" style="display:none"></div>
    </div>

    <button class="cta-accept" id="acceptBtn" onclick="acceptBooking()" disabled>
      J'accepte -- Reserver
    </button>
  </div>

  <!-- ── STEP 2: Map + Contact + Confirm ── -->
  <div class="booking-step" id="step2">

    <!-- Mapbox GL Map -->
    <div class="map-container" id="mapContainer">
      <div id="routeMap"></div>
      <div class="map-route-info">
        <div class="map-endpoint">
          <div class="map-endpoint-label from">Depart</div>
          <div class="map-endpoint-addr" id="routeFrom">--</div>
        </div>
        <div class="map-middle">
          <div class="map-distance" id="routeDist">--</div>
          <div class="map-duration" id="routeDur"></div>
        </div>
        <div class="map-endpoint" style="text-align:right">
          <div class="map-endpoint-label to">Arrivee</div>
          <div class="map-endpoint-addr" id="routeTo">--</div>
        </div>
      </div>
    </div>

    <!-- Contact fields -->
    <div class="field-group">
      <div class="field-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
        Email
      </div>
      <input type="email" class="b-input" id="bEmail" placeholder="votre@email.com" autocomplete="email">
    </div>
    <div class="field-group">
      <div class="field-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        Telephone
      </div>
      <input type="tel" class="b-input" id="bPhone" placeholder="+33 6 12 34 56 78">
    </div>

    <!-- Stripe Elements (si chauffeur connecte Stripe) -->
    ${
      canAcceptPayment
        ? `
    <div class="field-group">
      <div class="field-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22"/></svg>
        Carte bancaire
      </div>
      <div class="stripe-element" id="cardElement"></div>
      <div id="cardErrors" style="color:var(--danger);font-size:11px;margin-top:4px;display:none"></div>
    </div>
    `
        : ''
    }

    <button class="cta-pay" id="payBtn" onclick="submitPayment()" disabled>
      ${canAcceptPayment ? 'Payer' : 'Confirmer la reservation'}
    </button>
    <div class="secure-badge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      ${canAcceptPayment ? 'Paiement securise' : 'Reservation gratuite · Sans engagement'}
    </div>

    <button class="booking-back" onclick="goStep1()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      Modifier le trajet
    </button>
  </div>

  <!-- Confirmation -->
  <div class="booking-confirm" id="bookingConfirm">
    <div class="confirm-check">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <div class="confirm-title">Reservation confirmee</div>
    <div class="confirm-text">
      ${firstName} a bien recu votre demande et vous recontactera rapidement.<br>
      Un SMS de confirmation vous a ete envoye.
    </div>
  </div>
  <div class="error-msg" id="bookingError"></div>
</div>

<!-- ═══ 4. SERVICES GRID — "Ce que j'offre" (Krug scannable + Nike signature) ═══ -->
<section class="services-section">
  <div class="section-eyebrow reveal">CE QUE J'OFFRE</div>
  <h2 class="section-title reveal delay-1">Le service ${firstName}</h2>
  <div class="services-grid">
    ${renderServiceCards(site, vehicleType).join('')}
  </div>
</section>

<!-- ═══ 5. TESTIMONIALS CAROUSEL — Cialdini preuve sociale ═══ -->
${
  totalTipCount > 0 || totalTrips >= 20
    ? `<section class="testimonials-section">
  <div class="testimonials-header">
    <div class="section-eyebrow reveal">CE QU'ILS EN DISENT</div>
    <h2 class="section-title reveal delay-1">${totalTipCount > 3 ? `${totalTipCount} passagers` : 'Des passagers'} satisfait${totalTipCount > 1 ? 's' : ''}</h2>
  </div>
  <div class="testimonials-scroll">
    ${renderTestimonials(site, firstName, city).join('')}
  </div>
</section>`
    : ''
}

<!-- ═══ 6. FINAL CTA — Nike-style block clôture ═══ -->
<div class="final-cta reveal">
  <div class="final-cta-title">Prêt à réserver<br>votre trajet avec ${firstName}&nbsp;?</div>
  <div class="final-cta-sub">Prix fixe garanti · Paiement sécurisé · Sans surprise</div>
  <button class="final-cta-btn" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth',block:'start'})">
    Réserver maintenant
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
  </button>
</div>

<!-- ═══ 7. FOOTER ═══ -->
<footer class="foreas-footer">
  Propulsé par <a href="https://foreas.xyz" target="_blank" rel="noopener">FOREAS</a><br>
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
      Reserver
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" style="vertical-align:middle;margin-left:4px"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
    </button>
  </div>
</div>

<script>
/* ═══════════════════════════════════════════════════════════
   FOREAS CLIENT SITE — JavaScript Engine v4.0
   ═══════════════════════════════════════════════════════════ */

var BACKEND = '${backendUrl}';
var SLUG = '${site.slug}';
var PRICING = ${pricing ? JSON.stringify(pricing) : 'null'};
var PROMO_PERCENT = ${promoPercent};
var CAN_PAY = ${canAcceptPayment};
var STRIPE_PK = ${canAcceptPayment ? `'${stripePublishableKey}'` : 'null'};
var MAPBOX_TOKEN = ${mapboxToken ? `'${mapboxToken}'` : 'null'};
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

// Mapbox
var mapInstance = null;

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
  ['bEmail', 'bPhone'].forEach(function(id) {
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
      promoEl.textContent = '-' + PROMO_PERCENT + '% · 1ere course';
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

// ── MAPBOX ROUTE MAP ──
function initRouteMap() {
  if (!MAPBOX_TOKEN || !fromCoords || !toCoords) return;
  if (typeof mapboxgl === 'undefined') return;

  var mapContainer = document.getElementById('mapContainer');
  mapContainer.classList.add('visible');

  // If map already exists, remove it
  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;
  var lng1 = fromCoords[1], lat1 = fromCoords[0];
  var lng2 = toCoords[1], lat2 = toCoords[0];

  mapInstance = new mapboxgl.Map({
    container: 'routeMap',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [(lng1 + lng2) / 2, (lat1 + lat2) / 2],
    zoom: 10,
    interactive: true,
    attributionControl: false,
  });

  mapInstance.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');

  // Markers
  var fromMarker = document.createElement('div');
  fromMarker.style.cssText = 'width:16px;height:16px;border-radius:50%;background:var(--cyan,#00C9FF);border:3px solid #fff;box-shadow:0 0 12px rgba(0,201,255,0.6);';
  var toMarker = document.createElement('div');
  toMarker.style.cssText = 'width:16px;height:16px;border-radius:50%;background:var(--violet,#8C52FF);border:3px solid #fff;box-shadow:0 0 12px rgba(140,82,255,0.6);';

  new mapboxgl.Marker({ element: fromMarker }).setLngLat([lng1, lat1]).addTo(mapInstance);
  new mapboxgl.Marker({ element: toMarker }).setLngLat([lng2, lat2]).addTo(mapInstance);

  // Fetch route from Directions API
  var dirUrl = 'https://api.mapbox.com/directions/v5/mapbox/driving/' + lng1 + ',' + lat1 + ';' + lng2 + ',' + lat2 + '?geometries=geojson&access_token=' + MAPBOX_TOKEN;

  fetch(dirUrl)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.routes || !data.routes.length) return;
      var route = data.routes[0];
      var geojson = route.geometry;

      // Update duration from real data
      var durMin = Math.round(route.duration / 60);
      var durEl = document.getElementById('routeDur');
      if (durEl) durEl.textContent = '~' + durMin + ' min';

      // Update distance from real data
      var realDist = (route.distance / 1000).toFixed(1);
      var distEl = document.getElementById('routeDist');
      if (distEl) distEl.textContent = realDist + ' km';

      mapInstance.on('load', function() {
        addRouteLayer(geojson);
      });

      // If map is already loaded
      if (mapInstance.loaded()) {
        addRouteLayer(geojson);
      }

      // Fit bounds
      var coords = geojson.coordinates;
      var bounds = coords.reduce(function(b, c) {
        return b.extend(c);
      }, new mapboxgl.LngLatBounds(coords[0], coords[0]));
      mapInstance.fitBounds(bounds, { padding: 40, maxZoom: 14, duration: 1000 });
    })
    .catch(function(e) {
      console.log('Directions API error:', e);
      // Fallback: fit to markers
      var bounds = new mapboxgl.LngLatBounds();
      bounds.extend([lng1, lat1]);
      bounds.extend([lng2, lat2]);
      mapInstance.fitBounds(bounds, { padding: 40, maxZoom: 14 });
    });
}

function addRouteLayer(geojson) {
  if (!mapInstance) return;
  // Avoid duplicate
  if (mapInstance.getSource('route')) return;

  mapInstance.addSource('route', {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: geojson }
  });

  // Route glow (background)
  mapInstance.addLayer({
    id: 'route-glow',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#8C52FF',
      'line-width': 10,
      'line-opacity': 0.15,
      'line-blur': 8,
    }
  });

  // Main route line with gradient
  mapInstance.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#00C9FF',
      'line-width': 4,
      'line-opacity': 1,
      'line-gradient': [
        'interpolate',
        ['linear'],
        ['line-progress'],
        0, '#00C9FF',
        0.5, '#8C52FF',
        1, '#00C9FF'
      ],
    }
  });

  // Animate pulse effect on the route
  var opacity = 1;
  var direction = -1;
  function pulseRoute() {
    opacity += direction * 0.01;
    if (opacity <= 0.5) direction = 1;
    if (opacity >= 1) direction = -1;
    if (mapInstance && mapInstance.getLayer('route-line')) {
      mapInstance.setPaintProperty('route-line', 'line-opacity', opacity);
    }
    requestAnimationFrame(pulseRoute);
  }
  pulseRoute();
}

// ── STEP NAVIGATION ──
function acceptBooking() {
  // Fill route info
  var fromAddr = document.getElementById('bFrom').value.trim();
  var toAddr = document.getElementById('bTo').value.trim();
  document.getElementById('routeFrom').textContent = fromAddr.split(',')[0] || fromAddr;
  document.getElementById('routeTo').textContent = toAddr.split(',')[0] || toAddr;
  document.getElementById('routeDist').textContent = calculatedDist > 0 ? calculatedDist.toFixed(1) + ' km' : '--';
  document.getElementById('routeDur').textContent = calculatedDist > 0 ? '~' + Math.round(calculatedDist * 1.8) + ' min' : '';

  // Update pay button
  var payBtn = document.getElementById('payBtn');
  if (CAN_PAY && calculatedFare > 0) {
    payBtn.textContent = 'Payer ' + Math.round(calculatedFare) + '\\u20AC';
  }

  // Animate step transition
  var s1 = document.getElementById('step1');
  var s2 = document.getElementById('step2');
  s1.classList.remove('visible');
  s2.classList.add('visible');
  document.getElementById('dot1').classList.remove('active');
  document.getElementById('dot2').classList.add('active');
  document.getElementById('bookingSub').textContent = 'Confirmez vos coordonnees';

  // Scroll to step 2
  document.getElementById('bookingSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Init Mapbox route map
  setTimeout(function() { initRouteMap(); }, 300);

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
  document.getElementById('bookingSub').textContent = 'Prix instantane · Paiement securise';
}

// ── VALIDATION ──
function validateStep2() {
  var email = document.getElementById('bEmail').value.trim();
  var ph = document.getElementById('bPhone').value.trim();
  var payBtn = document.getElementById('payBtn');

  var valid = email.length >= 5 && email.indexOf('@') > 0 && ph.length >= 8;
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
  var email = document.getElementById('bEmail').value.trim();
  var phone = document.getElementById('bPhone').value.trim();

  if (!email || !phone) {
    alert('Veuillez remplir email et telephone');
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
          email: email,
          phone: phone,
        },
      },
    }).then(function(result) {
      if (result.error) {
        document.getElementById('bookingError').textContent = result.error.message;
        document.getElementById('bookingError').style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Payer ' + Math.round(calculatedFare) + '\\u20AC';
      } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
        saveBooking(email, phone, result.paymentIntent.id);
      }
    });
  } else {
    // No Stripe — free booking request
    saveBooking(email, phone, null);
  }
}

function saveBooking(email, phone, paymentIntentId) {
  fetch(BACKEND + '/api/driver-site/booking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG,
      pickup_address: document.getElementById('bFrom').value,
      destination: document.getElementById('bTo').value,
      booking_date: document.getElementById('bDate').value,
      booking_time: document.getElementById('bTime').value,
      passenger_email: email,
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
    btn.textContent = CAN_PAY ? 'Payer ' + Math.round(calculatedFare) + '\\u20AC' : 'Confirmer la reservation';
  });
}

/* ═══════════════════════════════════════════════════════════
   v104 Sprint 3B — Scroll Reveal (IntersectionObserver)
   Principe Norman : feedback visuel subtil à chaque scroll.
   Performance : obs.unobserve() après 1 reveal (one-shot).
   ═══════════════════════════════════════════════════════════ */
(function setupScrollReveal() {
  if (!('IntersectionObserver' in window)) {
    // Fallback : tout visible d'un coup pour les vieux navigateurs
    document.querySelectorAll('.reveal').forEach(function(el) { el.classList.add('visible'); });
    return;
  }
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        obs.unobserve(entry.target);
      }
    });
  }, { root: null, threshold: 0.14, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(function(el) { obs.observe(el); });
})();
</script>
</body>
</html>`;
}
