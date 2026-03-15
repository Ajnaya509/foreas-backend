/**
 * FOREAS Backend - Production Entry Point
 * ========================================
 * RÈGLES DE BOOT:
 * 1. /health répond AVANT tout import lourd
 * 2. Stripe = lazy (premier usage)
 * 3. Supabase = lazy (via OTP routes)
 * 4. Version = SHA Git via env
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ============================================
// APP INIT - UN SEUL express()
// ============================================
const app = express();
app.use(cors());

// ============================================
// CONSTANTES BOOT
// ============================================
const START_TIME = Date.now();
const GIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'dev';
const VERSION = process.env.npm_package_version || '2.1.0';
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

// ============================================
// HEALTH CHECK - PRIORITÉ ABSOLUE
// Répond IMMÉDIATEMENT, AVANT tout import lourd
// Railway healthcheck attend 200 + body non-vide
// ============================================
app.get('/health', (_req, res) => {
  // Texte simple pour Railway healthcheck (pas JSON)
  res.status(200).send(`OK v${VERSION} sha:${GIT_SHA.substring(0, 7)}`);
});

app.get('/version', (_req, res) => {
  res.status(200).json({
    version: VERSION,
    sha: GIT_SHA,
    env: process.env.NODE_ENV || 'production',
    node: process.version,
    uptime_ms: Date.now() - START_TIME,
    modules: {
      data_platform: 'v1',
      ai_service: 'v1',
      rbac: 'v1',
    },
  });
});

app.get('/', (_req, res) => {
  res.send(`FOREAS Backend v${VERSION} (${GIT_SHA.substring(0, 7)})`);
});

// ============================================
// LAZY STRIPE - Chargé au premier usage
// ============================================
let stripeClient: import('stripe').default | null = null;

async function getStripe(): Promise<import('stripe').default> {
  if (!stripeClient) {
    const Stripe = (await import('stripe')).default;
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
      apiVersion: '2024-06-20',
    });
    console.log('[Stripe] Client initialized');
  }
  return stripeClient;
}

// ============================================
// STRIPE WEBHOOK - AVANT express.json()
// ============================================
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string | undefined;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !whSecret) {
    return res.status(400).send('Missing signature or secret');
  }

  try {
    const stripe = await getStripe();
    const event = stripe.webhooks.constructEvent(req.body, sig, whSecret);

    switch (event.type) {
      case 'checkout.session.completed':
      case 'payment_intent.succeeded':
      case 'invoice.payment_succeeded':
        console.log(`[Stripe] Event: ${event.type}`);
        markPremiumNow();
        break;
      default:
        console.log(`[Stripe] Unhandled: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error(`[Stripe] Webhook error: ${err.message}`);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ============================================
// JSON PARSER - APRÈS webhook Stripe
// ============================================
app.use(express.json({ limit: '10mb' })); // 10MB pour audio base64 (transcription Whisper)

// ============================================
// ÉTAT PREMIUM (démo in-memory)
// ============================================
let lastPremiumTimestamp = 0;

function markPremiumNow(): void {
  lastPremiumTimestamp = Date.now();
}

// ============================================
// OTP ROUTES - LAZY LOADED
// ============================================
let otpRoutesLoaded = false;

async function loadOtpRoutes(): Promise<void> {
  if (otpRoutesLoaded) return;
  try {
    const { otpRouter } = await import('./routes/otp.routes.js');
    app.use('/api/auth', otpRouter);
    otpRoutesLoaded = true;
    console.log('[OTP] Routes mounted at /api/auth');
  } catch (err: any) {
    console.error(`[OTP] Failed to load: ${err.message}`);
  }
}

// ============================================
// AI & ADMIN & ANALYTICS ROUTES - LAZY LOADED
// ============================================
let aiRoutesLoaded = false;
let adminRoutesLoaded = false;
let analyticsRoutesLoaded = false;

async function loadAIRoutes(): Promise<void> {
  if (aiRoutesLoaded) return;
  try {
    const { aiRouter } = await import('./routes/ai.routes.js');
    app.use('/api/ai', aiRouter);
    aiRoutesLoaded = true;
    console.log('[AI] Routes mounted at /api/ai');
  } catch (err: any) {
    console.error(`[AI] Failed to load: ${err.message}`);
  }
}

async function loadAdminRoutes(): Promise<void> {
  if (adminRoutesLoaded) return;
  try {
    const { adminRouter } = await import('./routes/admin.routes.js');
    app.use('/api/admin', adminRouter);
    adminRoutesLoaded = true;
    console.log('[Admin] Routes mounted at /api/admin');
  } catch (err: any) {
    console.error(`[Admin] Failed to load: ${err.message}`);
  }
}

async function loadAnalyticsRoutes(): Promise<void> {
  if (analyticsRoutesLoaded) return;
  try {
    const { analyticsRouter } = await import('./routes/analytics.routes.js');
    app.use('/api/analytics', analyticsRouter);
    // Alias for compatibility
    app.use('/api/events', analyticsRouter);
    analyticsRoutesLoaded = true;
    console.log('[Analytics] Routes mounted at /api/analytics + /api/events');
  } catch (err: any) {
    console.error(`[Analytics] Failed to load: ${err.message}`);
  }
}

let bookingRoutesLoaded = false;
async function loadBookingRoutes(): Promise<void> {
  if (bookingRoutesLoaded) return;
  try {
    const { bookingRouter, geocodeRouter } = await import('./routes/booking.routes.js');
    app.use('/api/bookings', bookingRouter);
    app.use('/api/geocode', geocodeRouter);
    bookingRoutesLoaded = true;
    console.log('[Booking] Routes mounted at /api/bookings + /api/geocode');
  } catch (err: any) {
    console.error(`[Booking] Failed to load: ${err.message}`);
  }
}

// ── Ajnaya IA routes (Whisper + GPT-4o + ElevenLabs TTS) ──
let ajnayaRoutesLoaded = false;
async function loadAjnayaRoutes(): Promise<void> {
  if (ajnayaRoutesLoaded) return;
  try {
    const ajnayaRouter = (await import('./routes/ajnaya.js')).default;
    app.use('/api/ajnaya', ajnayaRouter);
    ajnayaRoutesLoaded = true;
    console.log('[Ajnaya] Routes mounted at /api/ajnaya');
  } catch (err: any) {
    console.error(`[Ajnaya] Failed to load: ${err.message}`);
  }
}

// Charger toutes les routes après le serveur prêt
setTimeout(() => {
  loadOtpRoutes();
  loadAIRoutes();
  loadAdminRoutes();
  loadAnalyticsRoutes();
  loadBookingRoutes();
  loadAjnayaRoutes();
}, 0);

// ============================================
// STRIPE CHECKOUT — Anti-duplication chauffeur
// ============================================
app.use('/create-checkout-session', express.json());
app.post('/create-checkout-session', async (req, res) => {
  try {
    const priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId) {
      return res.status(400).json({ error: 'Missing STRIPE_PRICE_ID' });
    }

    const { email, phone, driverId } = req.body as {
      email?: string;
      phone?: string;
      driverId?: string;
    };

    if (!email) {
      return res.status(400).json({ error: 'email requis pour créer un abonnement' });
    }

    const stripe = await getStripe();

    // ── 1. Chercher client existant par email ──────────────────────────
    const existingCustomers = await stripe.customers.list({ email, limit: 5 });

    let customerId: string | undefined;
    let alreadySubscribed = false;

    if (existingCustomers.data.length > 0) {
      // Prendre le plus récent avec metadata.driver_id si dispo
      const matched = driverId
        ? existingCustomers.data.find((c) => c.metadata?.driver_id === driverId)
        : existingCustomers.data[0];

      customerId = (matched ?? existingCustomers.data[0]).id;

      // ── 2. Vérifier abonnement actif ──────────────────────────────
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 1,
      });

      if (subs.data.length > 0) {
        // Chauffeur déjà abonné — retourner portal au lieu d'un nouveau checkout
        alreadySubscribed = true;
        console.log(`[Checkout] Doublon bloqué — déjà abonné: ${email} (${customerId})`);

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: 'https://foreas.app/dashboard',
        });

        return res.json({
          already_subscribed: true,
          portal_url: portalSession.url,
          message: 'Vous avez déjà un abonnement actif.',
        });
      }
    }

    // ── 3. Créer ou récupérer le customer Stripe ───────────────────
    if (!customerId) {
      const newCustomer = await stripe.customers.create({
        email,
        phone: phone ?? undefined,
        metadata: {
          driver_id: driverId ?? '',
          source: 'foreas_app',
          created_at: new Date().toISOString(),
        },
      });
      customerId = newCustomer.id;
      console.log(`[Checkout] Nouveau customer créé: ${customerId} (${email})`);
    }

    // ── 4. Créer la session checkout liée au customer ─────────────
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      customer_update: { address: 'auto' },
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: {
          driver_id: driverId ?? '',
          source: 'foreas_app',
        },
      },
      // Empêche de changer d'email pendant le checkout
      customer_email: !customerId ? email : undefined,
      allow_promotion_codes: true,
      success_url: 'https://foreas.app/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://foreas.app/cancel',
    });

    console.log(`[Checkout] Session créée: ${session.id} pour ${email}`);
    res.json({ url: session.url, session_id: session.id });
  } catch (e: any) {
    console.error(`[Checkout] Error: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// ── Vérifier le statut d'abonnement par email ─────────────────────────────
app.post('/subscription/check', express.json(), async (req, res) => {
  try {
    const { email, driverId } = req.body as { email?: string; driverId?: string };
    if (!email) return res.status(400).json({ error: 'email requis' });

    const stripe = await getStripe();
    const customers = await stripe.customers.list({ email, limit: 5 });

    if (customers.data.length === 0) {
      return res.json({ subscribed: false, customer_exists: false });
    }

    const customerId = driverId
      ? (customers.data.find((c) => c.metadata?.driver_id === driverId) ?? customers.data[0]).id
      : customers.data[0].id;

    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });

    const sub = subs.data[0] ?? null;
    return res.json({
      subscribed: !!sub,
      customer_exists: true,
      customer_id: customerId,
      subscription_id: sub?.id ?? null,
      current_period_end: sub ? new Date(sub.current_period_end * 1000).toISOString() : null,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================
// SUBSCRIPTION STATUS
// ============================================
app.get('/subscription/status', (_req, res) => {
  const PREMIUM_DURATION_MS = 30 * 60 * 1000; // 30 min
  const active = Date.now() - lastPremiumTimestamp < PREMIUM_DURATION_MS;
  res.json({ active });
});

// ============================================
// TTS — AJNAYA VOICE (ElevenLabs proxy)
// ============================================
app.post('/api/tts', express.json(), async (req: any, res: any) => {
  const { text, voice_id } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Missing text' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Text too long (max 500 chars)' });
  }

  const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
  const VOICE_ID = voice_id || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  if (!ELEVEN_KEY) {
    return res.status(503).json({ error: 'TTS not configured' });
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.trim(),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.72, similarity_boost: 0.85, style: 0.1 },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[TTS] ElevenLabs error:', response.status, err);
      return res.status(502).json({ error: 'ElevenLabs error', detail: response.status });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(audioBuffer);
  } catch (err: any) {
    console.error('[TTS] Fetch error:', err.message);
    return res.status(500).json({ error: 'TTS failed', message: err.message });
  }
});

// ============================================
// CONTEXT API — Ajnaya (OpenWeather + PredictHQ proxy sécurisé)
// Les clés API ne quittent jamais le backend
// ============================================
app.get('/api/context/weather', async (req: any, res: any) => {
  const { lat, lng } = req.query as { lat?: string; lng?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) {
    console.warn('[Context] OPENWEATHER_API_KEY not set — returning neutral');
    return res.json({
      weather: [{ main: 'Clear', description: 'clear sky' }],
      main: { temp: 15 },
    });
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&appid=${key}&units=metric&lang=fr`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`OpenWeather ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err: any) {
    console.error('[Context] Weather fetch error:', err.message);
    // Mode dégradé — contexte neutre plutôt qu'erreur 502
    res.json({
      weather: [{ main: 'Clear', description: 'unknown' }],
      main: { temp: 15 },
    });
  }
});

app.get('/api/context/events', async (req: any, res: any) => {
  const { lat, lng } = req.query as { lat?: string; lng?: string };
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng required' });

  const key = process.env.PREDICTHQ_API_KEY;
  if (!key) {
    console.warn('[Context] PREDICTHQ_API_KEY not set — returning empty events');
    return res.json({ results: [], count: 0 });
  }

  try {
    const url = `https://api.predicthq.com/v1/events/?within=10km@${encodeURIComponent(lat)},${encodeURIComponent(lng)}&active.gte=now&limit=20&sort=predicted_event_spend`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error(`PredictHQ ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err: any) {
    console.error('[Context] Events fetch error:', err.message);
    res.json({ results: [], count: 0 });
  }
});

// ============================================================
// DRIVER SITE — Site personnel chauffeur haute conversion
// FOREAS prend 15% platform fee sur chaque pourboire
// ============================================================

// Lazy Supabase client (service role — bypass RLS pour pages publiques)
let supabaseAdmin: any = null;
async function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    const { createClient } = await import('@supabase/supabase-js');
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return supabaseAdmin;
}

// ── Helper : générer un slug unique à partir du nom ──────────
function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${base}-${suffix}`;
}

// ── Helper : générer la bio Ajnaya (PAS Framework) ───────────
function generateBio(
  name: string,
  city: string,
  rating: number,
  trips: number,
  languages: string[],
): string {
  const firstName = name.split(' ')[0];
  const langStr = languages.length > 1 ? languages.join(', ') : '';
  const tripsText =
    trips > 50
      ? `${trips}+ courses réalisées`
      : trips > 0
        ? `${trips} courses`
        : 'nouveau sur FOREAS';
  const ratingText =
    rating >= 4.5 ? `noté ${rating.toFixed(1)}/5 par ses passagers` : `note ${rating.toFixed(1)}/5`;

  // 3 templates PAS (Problem-Agitate-Solution) — variation déterministe
  const variant = name.length % 3;

  if (variant === 0) {
    // Template A: Urgence + fiabilité
    return `Besoin d'un trajet fiable à ${city} ? ${firstName} est chauffeur VTC professionnel, ${ratingText} avec ${tripsText}. Ponctualité, confort et discrétion garantis.${langStr ? ` Parle ${langStr}.` : ''} Réservez en 30 secondes, sans application à télécharger.`;
  } else if (variant === 1) {
    // Template B: Confiance + expérience
    return `Vous cherchez un chauffeur de confiance à ${city} ? ${firstName}, ${ratingText}, assure vos trajets avec professionnalisme et ponctualité. ${tripsText} et des passagers satisfaits.${langStr ? ` Langues : ${langStr}.` : ''} Réservez directement — réponse rapide garantie.`;
  } else {
    // Template C: Simplicité + résultat
    return `${firstName}, chauffeur VTC à ${city}. ${tripsText}, ${ratingText}. Véhicule propre, trajet sans stress, arrivée à l'heure.${langStr ? ` ${langStr}.` : ''} Réservez votre course en quelques clics — c'est simple, rapide et gratuit.`;
  }
}

// ── Page HTML publique passager (/c/:slug) — CRO OPTIMISÉ ────
function renderDriverPage(site: any, source: string): string {
  const rating = site.rating || 5;
  const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));
  const backendUrl =
    process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
  const siteUrl = `${backendUrl}/c/${site.slug}`;
  const themeColor = site.theme_color || '#8C52FF';
  const displayName = site.display_name || 'Chauffeur';
  const firstName = displayName.split(' ')[0];
  const city = site.city || 'France';
  const vehicleType = site.vehicle_type || 'Chauffeur VTC';
  const totalTrips = site.total_trips || 0;
  const totalTipCount = site.total_tip_count || 0;
  const languages = site.languages || ['Français'];
  const bio = site.bio || generateBio(displayName, city, rating, totalTrips, languages);
  const metaDescription = bio.substring(0, 155).replace(/"/g, '&quot;');
  const pricing = site.pricing || null;

  // JSON-LD structured data
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    additionalType: 'https://schema.org/TaxiService',
    name: `${displayName} — ${vehicleType}`,
    description: bio.substring(0, 300),
    url: siteUrl,
    ...(site.photo_url ? { image: site.photo_url } : {}),
    address: {
      '@type': 'PostalAddress',
      addressLocality: city,
      addressCountry: 'FR',
    },
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
    areaServed: {
      '@type': 'City',
      name: city,
    },
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
      {
        '@type': 'DonateAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: siteUrl,
          actionPlatform: [
            'http://schema.org/DesktopWebPlatform',
            'http://schema.org/MobileWebPlatform',
          ],
        },
        name: 'Laisser un pourboire',
      },
    ],
  };

  // Pricing grid HTML
  let pricingHtml = '';
  if (pricing && typeof pricing === 'object') {
    const entries = Object.entries(pricing).filter(([, v]) => v && Number(v) > 0);
    if (entries.length > 0) {
      pricingHtml = `
<div class="card">
  <div class="section-title">Tarifs indicatifs</div>
  <div class="pricing-grid">
    ${entries.map(([label, price]) => `<div class="pricing-item"><span class="pricing-label">${label}</span><span class="pricing-price">${price}€</span></div>`).join('')}
  </div>
</div>`;
    }
  }

  // Trust badges
  const tripsLabel = totalTrips > 100 ? `${totalTrips}+` : totalTrips > 0 ? `${totalTrips}` : '—';

  return `<!DOCTYPE html>
<html lang="fr" prefix="og: https://ogp.me/ns#">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
<title>${displayName} — ${vehicleType} ${city} | FOREAS</title>

<!-- SEO Meta -->
<meta name="description" content="${metaDescription}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${siteUrl}">
<meta name="theme-color" content="${themeColor}">
<meta name="author" content="${displayName}">

<!-- Open Graph -->
<meta property="og:type" content="profile">
<meta property="og:title" content="${displayName} — ${vehicleType} ${city}">
<meta property="og:description" content="${metaDescription}">
<meta property="og:url" content="${siteUrl}">
${
  site.photo_url
    ? `<meta property="og:image" content="${site.photo_url}">
<meta property="og:image:width" content="400">
<meta property="og:image:height" content="400">
<meta property="og:image:alt" content="Photo de ${displayName}">`
    : ''
}
<meta property="og:locale" content="fr_FR">
<meta property="og:site_name" content="FOREAS">
<meta property="profile:first_name" content="${displayName.split(' ')[0]}">
${displayName.split(' ').length > 1 ? `<meta property="profile:last_name" content="${displayName.split(' ').slice(1).join(' ')}">` : ''}

<!-- Twitter Card -->
<meta name="twitter:card" content="${site.photo_url ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${displayName} — ${vehicleType}">
<meta name="twitter:description" content="${metaDescription}">
${site.photo_url ? `<meta name="twitter:image" content="${site.photo_url}">` : ''}

<!-- JSON-LD Structured Data -->
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>

<!-- Google Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
  :root{--c-primary:${themeColor};--c-bg:#0a0a0f;--c-card:#111118;--c-border:rgba(255,255,255,0.07);--c-text:#fff;--c-muted:#aaa;--c-subtle:#ccc;--radius:20px;--font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--c-bg);color:var(--c-text);font-family:var(--font);min-height:100vh;-webkit-font-smoothing:antialiased}
  .wrap{max-width:480px;margin:0 auto;padding-bottom:80px}

  /* ── HERO (compact, CTA above fold) ── */
  .hero{background:linear-gradient(160deg,#0d0d1a 0%,#1a0d2e 50%,#0d0d1a 100%);padding:36px 20px 28px;text-align:center;position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,var(--c-primary)22 0%,transparent 70%)}
  .avatar{width:100px;height:100px;border-radius:50%;object-fit:cover;border:3px solid var(--c-primary);margin:0 auto 12px;display:block;background:#1a1a2e;position:relative}
  .avatar-placeholder{width:100px;height:100px;border-radius:50%;background:linear-gradient(135deg,var(--c-primary),#4a90e2);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800;color:#fff;position:relative}
  h1{font-size:26px;font-weight:800;margin-bottom:4px;position:relative;letter-spacing:-0.3px}
  .vehicle{color:var(--c-muted);font-size:14px;margin-bottom:8px;position:relative}
  .stars{color:#FFD700;font-size:20px;margin-bottom:2px;position:relative;letter-spacing:2px}
  .rating-text{color:var(--c-muted);font-size:13px;margin-bottom:16px;position:relative}

  /* ── PRIMARY CTA (above fold) ── */
  .hero-cta{display:block;width:calc(100% - 16px);margin:0 auto;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:16px;padding:18px;font-size:17px;font-weight:700;color:#fff;cursor:pointer;transition:all .2s;text-align:center;text-decoration:none;font-family:var(--font);min-height:56px;position:relative;letter-spacing:0.2px}
  .hero-cta:hover{opacity:.92;transform:scale(1.01)}
  .hero-cta:active{transform:scale(0.98)}

  /* ── TRUST BADGES ── */
  .trust-row{display:flex;gap:8px;justify-content:center;padding:16px 16px 0}
  .trust-badge{flex:1;background:var(--c-card);border:1px solid var(--c-border);border-radius:14px;padding:14px 8px;text-align:center}
  .trust-icon{font-size:20px;margin-bottom:4px}
  .trust-val{font-size:16px;font-weight:700;color:var(--c-text)}
  .trust-label{font-size:10px;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:2px}

  /* ── BOOKING MODULE ── */
  .booking{background:var(--c-card);border:1px solid var(--c-border);border-radius:var(--radius);margin:16px;padding:22px;position:relative}
  .booking-title{font-size:18px;font-weight:700;color:var(--c-text);margin-bottom:4px}
  .booking-sub{font-size:13px;color:var(--c-muted);margin-bottom:18px}
  .booking-progress{display:flex;gap:6px;margin-bottom:20px}
  .booking-step-dot{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.1);transition:background .3s}
  .booking-step-dot.active{background:var(--c-primary)}
  .booking-step{display:none}
  .booking-step.visible{display:block}
  .field-label{font-size:12px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
  .field-row{display:flex;gap:10px}
  .field-row > *{flex:1}
  .field-group{margin-bottom:14px}
  .b-input{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;font-size:15px;color:#fff;font-family:var(--font);min-height:48px;transition:border-color .2s}
  .b-input:focus{outline:none;border-color:var(--c-primary)}
  .b-input::placeholder{color:#555}
  select.b-input{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px}
  select.b-input option{background:#1a1a2e;color:#fff}
  .booking-next{width:100%;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;transition:all .2s;font-family:var(--font);min-height:52px;margin-top:4px}
  .booking-next:hover{opacity:.92}
  .booking-next:active{transform:scale(0.98)}
  .booking-next:disabled{opacity:.5;cursor:not-allowed}
  .booking-back{background:none;border:none;color:var(--c-muted);font-size:13px;cursor:pointer;padding:10px;margin-top:8px;font-family:var(--font);text-decoration:underline}
  .booking-confirm{background:#0d2b1a;border:1px solid #2ecc71;border-radius:16px;padding:20px;text-align:center;display:none}
  .booking-confirm h3{color:#2ecc71;font-size:18px;margin-bottom:6px}
  .booking-confirm p{color:var(--c-muted);font-size:14px}
  .required-star{color:#e74c3c;margin-left:2px}

  /* ── CARD / BIO ── */
  .card{background:var(--c-card);border:1px solid var(--c-border);border-radius:var(--radius);margin:16px;padding:22px}
  .bio{color:var(--c-subtle);font-size:15px;line-height:1.7}
  .section-title{font-size:13px;font-weight:600;color:var(--c-primary);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}

  /* ── PRICING ── */
  .pricing-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .pricing-item{background:rgba(255,255,255,0.04);border:1px solid var(--c-border);border-radius:12px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:4px}
  .pricing-label{font-size:12px;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.5px}
  .pricing-price{font-size:20px;font-weight:700;color:var(--c-primary)}

  /* ── SECONDARY CTA ── */
  .cta-secondary{display:block;width:calc(100% - 32px);margin:8px auto 16px;background:transparent;border:2px solid var(--c-primary);border-radius:16px;padding:16px;font-size:16px;font-weight:700;color:var(--c-primary);cursor:pointer;transition:all .2s;text-align:center;text-decoration:none;font-family:var(--font);min-height:52px}
  .cta-secondary:hover{background:var(--c-primary);color:#fff}
  .cta-sub{display:block;text-align:center;font-size:12px;color:var(--c-muted);margin-bottom:16px}

  /* ── TIP ── */
  .tip-amounts{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px}
  .tip-btn{background:#1a1a2e;border:2px solid rgba(255,255,255,0.1);border-radius:12px;padding:12px 0;text-align:center;font-size:16px;font-weight:700;color:#fff;cursor:pointer;transition:all .2s;min-height:48px}
  .tip-btn.selected,.tip-btn:hover{border-color:var(--c-primary);background:var(--c-primary)22;color:var(--c-primary)}
  .pay-btn{width:100%;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:16px;padding:18px;font-size:17px;font-weight:700;color:#fff;cursor:pointer;transition:opacity .2s;font-family:var(--font);min-height:56px}
  .pay-btn:hover{opacity:.9}
  .pay-btn:disabled{opacity:.5;cursor:not-allowed}

  /* ── REVIEW ── */
  .review-stars{display:flex;gap:10px;justify-content:center;margin-bottom:16px}
  .review-star{font-size:34px;cursor:pointer;color:#333;transition:color .15s}
  .review-star.lit{color:#FFD700}
  textarea{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;font-size:15px;color:#fff;resize:none;min-height:90px;margin-bottom:12px;font-family:var(--font)}
  input[type=text],input[type=email],input[type=tel],input[type=date],input[type=time]{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;font-size:15px;color:#fff;margin-bottom:10px;font-family:var(--font);min-height:48px}
  .submit-btn{width:100%;background:#1a1a2e;border:2px solid var(--c-primary);border-radius:16px;padding:16px;font-size:16px;font-weight:700;color:var(--c-primary);cursor:pointer;transition:all .2s;font-family:var(--font);min-height:52px}
  .submit-btn:hover{background:var(--c-primary);color:#fff}

  /* ── FOOTER ── */
  .foreas-badge{text-align:center;padding:32px 16px 48px;color:#444;font-size:12px}
  .foreas-badge a{color:var(--c-primary);text-decoration:none;font-weight:600}
  .foreas-badge .legal{margin-top:8px;font-size:10px;color:#333}

  /* ── MESSAGES ── */
  .success-msg{background:#0d2b1a;border:1px solid #2ecc71;border-radius:12px;padding:16px;color:#2ecc71;text-align:center;margin-top:12px;display:none}
  .error-msg{background:#2b0d0d;border:1px solid #e74c3c;border-radius:12px;padding:16px;color:#e74c3c;text-align:center;margin-top:12px;display:none}
  .stripe-secure{font-size:12px;color:#555;text-align:center;margin-top:8px}

  /* ── STICKY BAR ── */
  .sticky-bar{position:fixed;bottom:0;left:0;right:0;z-index:999;transform:translateY(100%);transition:transform .3s ease;background:linear-gradient(0deg,var(--c-bg) 0%,rgba(10,10,15,0.97) 100%);border-top:1px solid var(--c-border);padding:12px 16px;display:flex;align-items:center;justify-content:center}
  .sticky-bar.visible{transform:translateY(0)}
  .sticky-bar-btn{width:100%;max-width:480px;background:linear-gradient(135deg,var(--c-primary),#4a90e2);border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;font-family:var(--font);min-height:52px;transition:all .2s}
  .sticky-bar-btn:hover{opacity:.92}
  .sticky-bar-btn:active{transform:scale(0.98)}

  @media(max-width:400px){.tip-amounts{grid-template-columns:repeat(2,1fr)}.pricing-grid{grid-template-columns:1fr}.field-row{flex-direction:column;gap:0}}
</style>
</head>
<body>
<div class="wrap">

<!-- ═══ 1. HERO COMPACT (Attention — above fold) ═══ -->
<header class="hero">
  ${
    site.photo_url
      ? `<img class="avatar" src="${site.photo_url}" alt="Photo de ${displayName}, ${vehicleType} ${city}" width="100" height="100">`
      : `<div class="avatar-placeholder">${displayName[0].toUpperCase()}</div>`
  }
  <h1>${displayName}</h1>
  <div class="vehicle">${vehicleType} · ${city}</div>
  <div class="stars" aria-label="Note ${rating.toFixed(1)} sur 5">${stars}</div>
  <div class="rating-text">${rating.toFixed(1)}/5 · ${totalTipCount > 0 ? totalTipCount + ' avis' : 'Nouveau sur FOREAS'}</div>
  <button class="hero-cta" id="heroCTA" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
    Réserver ${firstName} maintenant
  </button>
</header>

<!-- ═══ 2. TRUST BADGES (Desire) ═══ -->
<div class="trust-row">
  <div class="trust-badge">
    <div class="trust-icon">✅</div>
    <div class="trust-val">Vérifié</div>
    <div class="trust-label">Profil</div>
  </div>
  <div class="trust-badge">
    <div class="trust-icon">🚗</div>
    <div class="trust-val">${tripsLabel}</div>
    <div class="trust-label">Courses</div>
  </div>
  <div class="trust-badge">
    <div class="trust-icon">⭐</div>
    <div class="trust-val">${rating.toFixed(1)}</div>
    <div class="trust-label">Note</div>
  </div>
</div>

<!-- ═══ 3. BOOKING MODULE — 2 ÉTAPES (Action) ═══ -->
<div class="booking" id="bookingSection">
  <div class="booking-title">Réserver votre trajet</div>
  <div class="booking-sub">Gratuit, sans engagement · Réponse rapide</div>

  <!-- Progress dots -->
  <div class="booking-progress">
    <div class="booking-step-dot active" id="dot1"></div>
    <div class="booking-step-dot" id="dot2"></div>
  </div>

  <!-- STEP 1: Trajet -->
  <div class="booking-step visible" id="step1">
    <div class="field-group">
      <div class="field-label">Type de service</div>
      <select class="b-input" id="bService">
        <option value="transfer">Transfert / Trajet</option>
        <option value="airport">Aéroport</option>
        <option value="hourly">Mise à disposition</option>
        <option value="event">Événement</option>
      </select>
    </div>
    <div class="field-group">
      <div class="field-label">Adresse de prise en charge</div>
      <input type="text" class="b-input" id="bAddress" placeholder="Ex: 10 rue de Rivoli, Paris">
    </div>
    <div class="field-row">
      <div class="field-group">
        <div class="field-label">Date</div>
        <input type="date" class="b-input" id="bDate">
      </div>
      <div class="field-group">
        <div class="field-label">Heure</div>
        <input type="time" class="b-input" id="bTime">
      </div>
    </div>
    <button class="booking-next" onclick="goStep2()">Continuer →</button>
  </div>

  <!-- STEP 2: Coordonnées -->
  <div class="booking-step" id="step2">
    <div class="field-group">
      <div class="field-label">Votre nom<span class="required-star">*</span></div>
      <input type="text" class="b-input" id="bName" placeholder="Prénom Nom" required>
    </div>
    <div class="field-group">
      <div class="field-label">Téléphone<span class="required-star">*</span></div>
      <input type="tel" class="b-input" id="bPhone" placeholder="06 12 34 56 78" required>
    </div>
    <div class="field-group">
      <div class="field-label">Email (optionnel)</div>
      <input type="email" class="b-input" id="bEmail" placeholder="votre@email.com">
    </div>
    <div class="field-group">
      <div class="field-label">Notes (optionnel)</div>
      <input type="text" class="b-input" id="bNotes" placeholder="Nombre de bagages, destination...">
    </div>
    <button class="booking-next" id="bookSubmitBtn" onclick="submitBooking()">Confirmer la réservation</button>
    <button class="booking-back" onclick="goStep1()">← Modifier le trajet</button>
  </div>

  <!-- Confirmation -->
  <div class="booking-confirm" id="bookingConfirm">
    <h3>Réservation envoyée !</h3>
    <p>${firstName} vous recontactera très rapidement pour confirmer votre trajet.</p>
  </div>
  <div class="error-msg" id="bookingError"></div>
</div>

<!-- ═══ 4. BIO (Interest — PAS Framework) ═══ -->
<div class="card">
  <div class="bio">${bio}</div>
</div>

<!-- ═══ 5. TARIFS ═══ -->
${pricingHtml}

<!-- ═══ 6. CTA SECONDAIRE ═══ -->
<button class="cta-secondary" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
  Réserver ${firstName} maintenant
</button>
<span class="cta-sub">Gratuit · Sans application · Réponse rapide</span>

<!-- ═══ 7. POURBOIRE ═══ -->
<div class="card">
  <div class="section-title">💳 Laisser un pourboire</div>
  <div class="tip-amounts">
    <div class="tip-btn" onclick="selectTip(2)" data-amount="2">2€</div>
    <div class="tip-btn" onclick="selectTip(5)" data-amount="5">5€</div>
    <div class="tip-btn" onclick="selectTip(10)" data-amount="10">10€</div>
    <div class="tip-btn" onclick="selectTip(0)" data-amount="0">Autre</div>
  </div>
  <input type="text" id="customTip" placeholder="Montant personnalisé (€)" style="display:none" oninput="updateCustom(this.value)">
  <input type="email" id="passengerEmail" placeholder="Votre email (reçu)" autocomplete="email">
  <button class="pay-btn" id="payBtn" onclick="processTip()" disabled>Payer en sécurité</button>
  <div class="stripe-secure">🔒 Paiement sécurisé par Stripe</div>
  <div class="success-msg" id="tipSuccess">Merci ! Votre pourboire a bien été envoyé.</div>
  <div class="error-msg" id="tipError"></div>
</div>

<!-- ═══ 8. AVIS ═══ -->
<div class="card">
  <div class="section-title">⭐ Laisser un avis</div>
  <div class="review-stars">
    <span class="review-star" onclick="setRating(1)" aria-label="1 étoile">★</span>
    <span class="review-star" onclick="setRating(2)" aria-label="2 étoiles">★</span>
    <span class="review-star" onclick="setRating(3)" aria-label="3 étoiles">★</span>
    <span class="review-star" onclick="setRating(4)" aria-label="4 étoiles">★</span>
    <span class="review-star" onclick="setRating(5)" aria-label="5 étoiles">★</span>
  </div>
  <textarea id="reviewText" placeholder="Dites-nous comment s'est passé votre trajet..."></textarea>
  <input type="text" id="reviewName" placeholder="Votre prénom (optionnel)">
  <button class="submit-btn" onclick="submitReview()">Publier l'avis</button>
  <div class="success-msg" id="reviewSuccess">Merci pour votre avis !</div>
  <div class="error-msg" id="reviewError"></div>
</div>

<!-- ═══ 9. FOOTER ═══ -->
<footer class="foreas-badge">
  Site propulsé par <a href="https://foreas.app" target="_blank" rel="noopener">FOREAS</a> · Copilote IA pour chauffeurs VTC<br>
  <div class="legal">&copy; ${new Date().getFullYear()} FOREAS Labs &middot; CGU &middot; Confidentialit&eacute;</div>
</footer>

</div><!-- /wrap -->

<!-- ═══ 10. STICKY BOTTOM BAR ═══ -->
<div class="sticky-bar" id="stickyBar">
  <button class="sticky-bar-btn" onclick="document.getElementById('bookingSection').scrollIntoView({behavior:'smooth'})">
    Réserver ${firstName} →
  </button>
</div>

<script>
  var BACKEND = '${backendUrl}';
  var SLUG = '${site.slug}';
  var selectedAmount = 0;
  var selectedRating = 0;

  // Track view
  fetch(BACKEND + '/api/driver-site/view/' + SLUG, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'${source}'})}).catch(function(){});

  // ── BOOKING 2-STEP ──
  function goStep2() {
    document.getElementById('step1').classList.remove('visible');
    document.getElementById('step2').classList.add('visible');
    document.getElementById('dot1').classList.remove('active');
    document.getElementById('dot2').classList.add('active');
    document.getElementById('step2').scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  function goStep1() {
    document.getElementById('step2').classList.remove('visible');
    document.getElementById('step1').classList.add('visible');
    document.getElementById('dot2').classList.remove('active');
    document.getElementById('dot1').classList.add('active');
  }

  function submitBooking() {
    var name = document.getElementById('bName').value.trim();
    var phone = document.getElementById('bPhone').value.trim();
    if (!name || !phone) {
      alert('Nom et téléphone sont obligatoires');
      return;
    }
    var btn = document.getElementById('bookSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Envoi en cours...';
    document.getElementById('bookingError').style.display = 'none';

    fetch(BACKEND + '/api/driver-site/booking', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        slug: SLUG,
        service_type: document.getElementById('bService').value,
        pickup_address: document.getElementById('bAddress').value,
        booking_date: document.getElementById('bDate').value,
        booking_time: document.getElementById('bTime').value,
        passenger_name: name,
        passenger_phone: phone,
        passenger_email: document.getElementById('bEmail').value,
        notes: document.getElementById('bNotes').value,
        source: '${source}'
      })
    }).then(function(r){return r.json()}).then(function(data) {
      if (data.success) {
        document.getElementById('step2').classList.remove('visible');
        document.querySelector('.booking-progress').style.display = 'none';
        document.querySelector('.booking-sub').style.display = 'none';
        document.getElementById('bookingConfirm').style.display = 'block';
      } else {
        throw new Error(data.error || 'Erreur');
      }
    }).catch(function(e) {
      document.getElementById('bookingError').textContent = 'Erreur: ' + e.message;
      document.getElementById('bookingError').style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Confirmer la réservation';
    });
  }

  // ── STICKY BAR (IntersectionObserver) ──
  var stickyBar = document.getElementById('stickyBar');
  var heroCTA = document.getElementById('heroCTA');
  if (heroCTA && stickyBar && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          stickyBar.classList.remove('visible');
        } else {
          stickyBar.classList.add('visible');
        }
      });
    }, {threshold: 0});
    observer.observe(heroCTA);
  }

  // ── TIP (preserved) ──
  function selectTip(amount) {
    document.querySelectorAll('.tip-btn').forEach(function(b){b.classList.remove('selected')});
    document.getElementById('customTip').style.display = amount === 0 ? 'block' : 'none';
    if (amount > 0) {
      document.querySelector('[data-amount="'+amount+'"]').classList.add('selected');
      selectedAmount = amount;
    } else {
      selectedAmount = 0;
    }
    updatePayBtn();
  }

  function updateCustom(val) {
    selectedAmount = parseFloat(val) || 0;
    updatePayBtn();
  }

  function updatePayBtn() {
    var btn = document.getElementById('payBtn');
    btn.disabled = selectedAmount < 1;
    btn.textContent = selectedAmount >= 1 ? 'Payer ' + selectedAmount + '€ en sécurité' : 'Sélectionnez un montant';
  }

  function processTip() {
    var btn = document.getElementById('payBtn');
    var email = document.getElementById('passengerEmail').value;
    btn.disabled = true;
    btn.textContent = 'Traitement...';
    document.getElementById('tipError').style.display = 'none';
    fetch(BACKEND + '/api/driver-site/tip', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({slug: SLUG, amount: selectedAmount, email: email, source: '${source}'})
    }).then(function(r){return r.json()}).then(function(data) {
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else if (data.error) {
        throw new Error(data.error);
      }
    }).catch(function(e) {
      document.getElementById('tipError').textContent = 'Erreur: ' + e.message;
      document.getElementById('tipError').style.display = 'block';
      btn.disabled = false;
      updatePayBtn();
    });
  }

  // ── REVIEW (preserved) ──
  function setRating(n) {
    selectedRating = n;
    document.querySelectorAll('.review-star').forEach(function(s,i) {
      s.classList.toggle('lit', i < n);
    });
  }

  function submitReview() {
    if (!selectedRating) { alert('Choisissez une note d\\'abord'); return; }
    var text = document.getElementById('reviewText').value;
    var name = document.getElementById('reviewName').value;
    document.getElementById('reviewError').style.display = 'none';
    fetch(BACKEND + '/api/driver-site/review', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({slug: SLUG, rating: selectedRating, text: text, name: name})
    }).then(function() {
      document.getElementById('reviewSuccess').style.display = 'block';
      document.getElementById('reviewText').value = '';
      setRating(0);
    }).catch(function() {
      document.getElementById('reviewError').textContent = 'Erreur, réessayez.';
      document.getElementById('reviewError').style.display = 'block';
    });
  }
</script>
</body></html>`;
}

// ── GET /c/:slug — Page publique passager ────────────────────
app.get('/c/:slug', async (req: any, res: any) => {
  const { slug } = req.params;
  const source = (req.query.src as string) || 'link';
  try {
    const supa = await getSupabaseAdmin();
    const { data: site, error } = await supa
      .from('driver_sites')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();
    if (error || !site) {
      return res
        .status(404)
        .send(
          '<h1 style="font-family:sans-serif;text-align:center;margin-top:80px;color:#333">Page introuvable</h1>',
        );
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    return res.send(renderDriverPage(site, source));
  } catch (err: any) {
    console.error('[DriverSite] render error:', err.message);
    return res.status(500).send('<p>Erreur serveur</p>');
  }
});

// ── POST /api/driver-site/generate — Créer / mettre à jour le site ──
app.post('/api/driver-site/generate', async (req: any, res: any) => {
  const {
    driver_id,
    display_name,
    photo_url,
    bio,
    languages,
    vehicle_type,
    city,
    rating,
    total_trips,
    theme_color,
    niche,
    niche_label,
    pricing,
  } = req.body || {};
  if (!driver_id || !display_name)
    return res.status(400).json({ error: 'driver_id + display_name requis' });
  try {
    const supa = await getSupabaseAdmin();
    // Vérifier si un site existe déjà
    const { data: existing } = await supa
      .from('driver_sites')
      .select('id,slug')
      .eq('driver_id', driver_id)
      .single();
    const slug = existing?.slug || generateSlug(display_name);
    const generatedBio =
      bio ||
      generateBio(
        display_name,
        city || 'France',
        rating || 5.0,
        total_trips || 0,
        languages || ['Français'],
      );
    const siteData: Record<string, any> = {
      driver_id,
      slug,
      display_name,
      photo_url: photo_url || null,
      bio: generatedBio,
      languages: languages || ['Français'],
      vehicle_type: vehicle_type || null,
      city: city || null,
      rating: rating || 5.0,
      total_trips: total_trips || 0,
      theme_color: theme_color || '#8C52FF',
      is_active: true,
      updated_at: new Date().toISOString(),
    };
    // Add optional enriched fields if provided
    if (niche) siteData.niche = niche;
    if (niche_label) siteData.niche_label = niche_label;
    if (pricing) siteData.pricing = pricing;

    const { data, error } = existing
      ? await supa.from('driver_sites').update(siteData).eq('id', existing.id).select().single()
      : await supa.from('driver_sites').insert(siteData).select().single();
    if (error) throw new Error(error.message);
    const backendUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    return res.json({
      success: true,
      site: data,
      public_url: `${backendUrl}/c/${data.slug}`,
      qr_data: `${backendUrl}/c/${data.slug}?src=qr`,
    });
  } catch (err: any) {
    console.error('[DriverSite] generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/driver-site/mine/:driverId — Données du site chauffeur ──
app.get('/api/driver-site/mine/:driverId', async (req: any, res: any) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('*')
      .eq('driver_id', driverId)
      .single();
    const backendUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    if (!site) return res.json({ exists: false });
    return res.json({
      exists: true,
      site,
      public_url: `${backendUrl}/c/${site.slug}`,
      qr_data: `${backendUrl}/c/${site.slug}?src=qr`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/tip — Créer checkout Stripe pour pourboire ──
app.post('/api/driver-site/tip', async (req: any, res: any) => {
  const { slug, amount, email, source } = req.body || {};
  if (!slug || !amount || amount < 1)
    return res.status(400).json({ error: 'slug + amount (min 1€) requis' });
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa.from('driver_sites').select('*').eq('slug', slug).single();
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    if (!site.stripe_account_id || !site.stripe_charges_enabled) {
      return res
        .status(400)
        .json({ error: 'Chauffeur non connecté à Stripe', code: 'stripe_not_connected' });
    }
    const stripe = await getStripe();
    const amountCents = Math.round(amount * 100);
    const platformFeeCents = Math.round(amountCents * 0.15); // 15% FOREAS
    const backendUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    // Stripe Checkout pour le pourboire
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: amountCents,
            product_data: {
              name: `Pourboire pour ${site.display_name}`,
              description: `Merci pour votre course ! FOREAS facilite ce paiement.`,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: platformFeeCents, // 15% FOREAS
        transfer_data: { destination: site.stripe_account_id },
        metadata: { driver_site_id: site.id, slug, source: source || 'web' },
      },
      customer_email: email || undefined,
      success_url: `${backendUrl}/c/${slug}?tip=success`,
      cancel_url: `${backendUrl}/c/${slug}?tip=cancel`,
    });
    // Enregistrer l'interaction (en attente de confirmation)
    await supa.from('driver_site_interactions').insert({
      driver_site_id: site.id,
      interaction_type: 'tip',
      passenger_email: email || null,
      tip_amount: amount,
      platform_fee: platformFeeCents / 100,
      driver_net: (amountCents - platformFeeCents) / 100,
      scan_source: source || 'web',
    });
    return res.json({ checkout_url: session.url });
  } catch (err: any) {
    console.error('[DriverSite] tip error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/review — Avis passager ─────────────
app.post('/api/driver-site/review', async (req: any, res: any) => {
  const { slug, rating, text, name } = req.body || {};
  if (!slug || !rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'slug + rating (1-5) requis' });
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('id,total_tip_count,rating')
      .eq('slug', slug)
      .single();
    if (!site) return res.status(404).json({ error: 'Site introuvable' });
    // Sauvegarder l'avis
    await supa.from('driver_site_interactions').insert({
      driver_site_id: site.id,
      interaction_type: 'review',
      passenger_name: name || null,
      review_rating: rating,
      review_text: text || null,
    });
    // Mettre à jour la note moyenne du site
    const newCount = (site.total_tip_count || 0) + 1;
    const newRating = ((site.rating || 5.0) * (newCount - 1) + rating) / newCount;
    await supa
      .from('driver_sites')
      .update({ total_tip_count: newCount, rating: Math.round(newRating * 100) / 100 })
      .eq('id', site.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/booking — Réservation passager (2 étapes) ──
app.post('/api/driver-site/booking', async (req: any, res: any) => {
  const {
    slug,
    service_type,
    pickup_address,
    booking_date,
    booking_time,
    passenger_name,
    passenger_phone,
    passenger_email,
    notes,
    source,
  } = req.body || {};

  if (!slug || !passenger_name || !passenger_phone) {
    return res.status(400).json({ error: 'slug + nom + téléphone requis' });
  }

  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('id,display_name')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (!site) return res.status(404).json({ error: 'Site introuvable' });

    const { data, error } = await supa
      .from('driver_bookings')
      .insert({
        driver_site_id: site.id,
        slug,
        service_type: service_type || 'transfer',
        pickup_address: pickup_address || null,
        booking_date: booking_date || null,
        booking_time: booking_time || null,
        passenger_name,
        passenger_phone,
        passenger_email: passenger_email || null,
        notes: notes || null,
        source: source || 'web',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Track interaction
    await supa.from('driver_site_interactions').insert({
      driver_site_id: site.id,
      interaction_type: 'booking',
      passenger_name,
      scan_source: source || 'web',
    });

    return res.json({ success: true, booking_id: data.id });
  } catch (err: any) {
    console.error('[DriverSite] booking error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/driver-site/view/:slug — Track view ─────────────
app.post('/api/driver-site/view/:slug', async (req: any, res: any) => {
  const { slug } = req.params;
  const { source } = req.body || {};
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa.from('driver_sites').select('id').eq('slug', slug).single();
    if (!site) return res.json({ ok: false });
    await Promise.all([
      supa
        .from('driver_sites')
        .update({ view_count: supa.rpc('increment', { x: 1 }) })
        .eq('id', site.id),
      supa.from('driver_site_interactions').insert({
        driver_site_id: site.id,
        interaction_type: 'view',
        scan_source: source || 'link',
      }),
    ]);
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: false });
  }
});

// ── POST /api/driver-site/connect/onboard — Stripe Connect Express ──
app.post('/api/driver-site/connect/onboard', async (req: any, res: any) => {
  const { driver_id, driver_email, slug } = req.body || {};
  if (!driver_id || !slug) return res.status(400).json({ error: 'driver_id + slug requis' });
  try {
    const stripe = await getStripe();
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('stripe_account_id')
      .eq('driver_id', driver_id)
      .single();
    let accountId = site?.stripe_account_id;
    // Créer le compte Express si inexistant
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: driver_email || undefined,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { driver_id, foreas_slug: slug },
      });
      accountId = account.id;
      await supa
        .from('driver_sites')
        .update({ stripe_account_id: accountId })
        .eq('driver_id', driver_id);
    }
    // Générer le lien d'onboarding
    const backendUrl =
      process.env.BACKEND_URL || 'https://foreas-stripe-backend-production.up.railway.app';
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${backendUrl}/api/driver-site/connect/onboard`,
      return_url: `${backendUrl}/c/${slug}?onboard=success`,
      type: 'account_onboarding',
    });
    return res.json({ onboarding_url: accountLink.url, account_id: accountId });
  } catch (err: any) {
    console.error('[DriverSite] connect error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/driver-site/connect/status/:driverId — Vérifie si Stripe Connect est actif ──
app.get('/api/driver-site/connect/status/:driverId', async (req: any, res: any) => {
  const { driverId } = req.params;
  try {
    const supa = await getSupabaseAdmin();
    const { data: site } = await supa
      .from('driver_sites')
      .select('stripe_account_id,stripe_onboarded,stripe_charges_enabled')
      .eq('driver_id', driverId)
      .single();
    if (!site?.stripe_account_id) return res.json({ connected: false });
    // Vérifier via Stripe
    const stripe = await getStripe();
    const account = await stripe.accounts.retrieve(site.stripe_account_id);
    const chargesEnabled = account.charges_enabled;
    if (chargesEnabled !== site.stripe_charges_enabled) {
      await supa
        .from('driver_sites')
        .update({ stripe_charges_enabled: chargesEnabled, stripe_onboarded: true })
        .eq('driver_id', driverId);
    }
    return res.json({
      connected: true,
      charges_enabled: chargesEnabled,
      account_id: site.stripe_account_id,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ============================================
// DEBUG ROUTES (dev only)
// ============================================
if (process.env.NODE_ENV !== 'production') {
  app.get('/__routes', (_req, res) => {
    const stack = (app as any)._router?.stack || [];
    const routes = stack
      .filter((l: any) => l.route)
      .map((l: any) => ({ methods: l.route.methods, path: l.route.path }));
    res.json(routes);
  });
}

// ============================================
// SERVER START
// ============================================
app.listen(PORT, HOST, () => {
  console.log(`[FOREAS] Backend v${VERSION} (${GIT_SHA.substring(0, 7)})`);
  console.log(`[FOREAS] Listening on ${HOST}:${PORT}`);
  console.log(`[FOREAS] Health: http://localhost:${PORT}/health`);
});
