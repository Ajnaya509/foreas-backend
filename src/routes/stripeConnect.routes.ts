/**
 * Stripe Connect Routes — Onboarding chauffeurs
 * Crée un compte Express, génère le lien d'onboarding, vérifie le statut
 */
import { Router, Request, Response } from 'express';

const router = Router();

let stripeInstance: any = null;
async function getStripe() {
  if (stripeInstance) return stripeInstance;
  const Stripe = (await import('stripe')).default;
  stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-12-18.acacia' as any,
  });
  return stripeInstance;
}

let supabaseAdmin: any = null;
async function getSupa() {
  if (supabaseAdmin) return supabaseAdmin;
  const { createClient } = await import('@supabase/supabase-js');
  supabaseAdmin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return supabaseAdmin;
}

// ── GET /stripe/account — Statut du compte Stripe Connect ──
router.get('/account', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token requis' });
    }

    const supa = await getSupa();
    const {
      data: { user },
      error: authError,
    } = await supa.auth.getUser(authHeader.split(' ')[1]);
    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    const { data: driver } = await supa
      .from('drivers')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    if (!driver?.stripe_account_id) {
      return res.json({
        accountId: '',
        isOnboarded: false,
        hasPayouts: false,
        requirements: [],
      });
    }

    // Vérifier le statut chez Stripe
    const stripe = await getStripe();
    const account = await stripe.accounts.retrieve(driver.stripe_account_id);

    return res.json({
      accountId: account.id,
      isOnboarded: account.details_submitted || false,
      hasPayouts: account.payouts_enabled || false,
      requirements: account.requirements?.currently_due || [],
    });
  } catch (err: any) {
    console.error('[StripeConnect] account error:', err.message);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// ── POST /stripe/account — Créer un compte Stripe Connect Express ──
router.post('/account', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token requis' });
    }

    const supa = await getSupa();
    const {
      data: { user },
      error: authError,
    } = await supa.auth.getUser(authHeader.split(' ')[1]);
    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    const { data: driver } = await supa
      .from('drivers')
      .select('id, email, first_name, last_name, phone, stripe_account_id')
      .eq('id', user.id)
      .single();

    if (!driver) {
      return res.status(404).json({ success: false, error: 'Chauffeur non trouvé' });
    }

    // Déjà un compte ?
    if (driver.stripe_account_id) {
      return res.json({
        accountId: driver.stripe_account_id,
        isOnboarded: false,
        hasPayouts: false,
        requirements: [],
        message: 'Compte déjà existant',
      });
    }

    const stripe = await getStripe();
    const { email, firstName, lastName, phone } = req.body;

    // Créer le compte Express
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'FR',
      email: email || driver.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      individual: {
        email: email || driver.email,
        first_name: firstName || driver.first_name,
        last_name: lastName || driver.last_name,
        phone: phone || driver.phone,
      },
      metadata: {
        driver_id: driver.id,
        platform: 'FOREAS',
      },
    });

    // Sauvegarder l'ID dans Supabase
    await supa.from('drivers').update({ stripe_account_id: account.id }).eq('id', driver.id);

    // Créer le lien d'onboarding
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'foreas://stripe-refresh',
      return_url: 'foreas://stripe-return',
      type: 'account_onboarding',
    });

    console.log(`[StripeConnect] ✅ Compte créé : ${account.id} pour driver ${driver.id}`);

    return res.json({
      accountId: account.id,
      isOnboarded: false,
      hasPayouts: false,
      requirements: [],
      onboardingUrl: accountLink.url,
    });
  } catch (err: any) {
    console.error('[StripeConnect] create error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /stripe/onboarding-link — Générer/régénérer un lien d'onboarding ──
router.post('/onboarding-link', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token requis' });
    }

    const supa = await getSupa();
    const {
      data: { user },
      error: authError,
    } = await supa.auth.getUser(authHeader.split(' ')[1]);
    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    const { data: driver } = await supa
      .from('drivers')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    if (!driver?.stripe_account_id) {
      return res
        .status(400)
        .json({ success: false, error: "Pas de compte Stripe — créez-en un d'abord" });
    }

    const stripe = await getStripe();

    const accountLink = await stripe.accountLinks.create({
      account: driver.stripe_account_id,
      refresh_url: 'foreas://stripe-refresh',
      return_url: 'foreas://stripe-return',
      type: 'account_onboarding',
    });

    console.log(`[StripeConnect] 🔗 Lien onboarding régénéré pour ${driver.stripe_account_id}`);

    return res.json({
      url: accountLink.url,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // ~30 min
    });
  } catch (err: any) {
    console.error('[StripeConnect] onboarding-link error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /stripe/connect/login-link — Dashboard Express (chauffeur déjà onboardé) ──
router.post('/connect/login-link', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token requis' });
    }

    const supa = await getSupa();
    const {
      data: { user },
      error: authError,
    } = await supa.auth.getUser(authHeader.split(' ')[1]);
    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Non authentifié' });
    }

    const { data: driver } = await supa
      .from('drivers')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    if (!driver?.stripe_account_id) {
      return res.status(400).json({ success: false, error: 'Pas de compte Stripe Connect' });
    }

    const stripe = await getStripe();

    const loginLink = await stripe.accounts.createLoginLink(driver.stripe_account_id);

    return res.json({
      success: true,
      url: loginLink.url,
    });
  } catch (err: any) {
    console.error('[StripeConnect] login-link error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
