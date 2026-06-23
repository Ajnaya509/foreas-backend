/**
 * MLM Routes — Admin partners + public CAP landing
 * v1.10.55 — 2 mai 2026
 *
 * ROUTES ADMIN (auth admin requise) :
 *   GET   /api/admin/partners                              → liste partners + KPIs
 *   GET   /api/admin/partners/:id                          → fiche complète + filleuls
 *   PATCH /api/admin/partners/:id/discount                 → set discount config
 *   GET   /api/admin/partners/:id/recruits                 → table chauffeurs recrutés
 *   GET   /api/admin/payouts/pending                       → commissions en attente (vue agrégée)
 *   GET   /api/admin/payouts/history                       → historique versements
 *   POST  /api/admin/payouts/run-cron-now                  → debug : run cron immédiat
 *   POST  /api/admin/partner-applications/:id/approve      → (TROU #2) approuver candidature site
 *
 * ROUTES PARTENAIRE (auth partenaire requise) :
 *   POST  /api/partner/stripe/connect-link                 → (TROU #3) lien onboarding Stripe Connect
 *
 * ROUTES PUBLIQUES (aucune auth) :
 *   GET   /api/public/partners/:referralCode/landing → données pour la page CAP fil Site
 *   POST  /api/public/partners/signup                → création partner + email Resend code
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const router = Router();

// ── Supabase admin singleton ────────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function getSupa(): SupabaseClient {
  if (_supa) return _supa;
  _supa = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supa;
}

// ── Resend lazy client ───────────────────────────────────────────────────
let _resend: any = null;
async function getResend() {
  if (!_resend) {
    const { Resend } = await import('resend');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// ── Auth admin middleware ───────────────────────────────────────────────
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token required' });
  }
  try {
    const supa = getSupa();
    const { data } = await supa.auth.getUser(authHeader.replace('Bearer ', ''));
    if (!data?.user?.id) return res.status(401).json({ error: 'Invalid token' });

    // Vérifie que l'utilisateur a le rôle 'admin' dans user_roles
    const { data: role } = await supa
      .from('user_roles')
      .select('role')
      .eq('user_id', data.user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!role) return res.status(403).json({ error: 'Admin role required' });

    (req as any).adminUserId = data.user.id;
    next();
  } catch (err: any) {
    console.error('[MlmAdmin] requireAdmin error:', err?.message);
    return res.status(500).json({ error: 'Auth failed' });
  }
}

// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/partners
// Liste tous les partners avec KPIs synthétiques
// ════════════════════════════════════════════════════════════════════════
router.get('/admin/partners', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const supa = getSupa();
    const { data, error } = await supa
      .from('partners')
      .select(
        `
        id, company_name, company_type, contact_email, status, referral_code,
        stripe_account_id, total_drivers, active_drivers, total_earned,
        pending_commission, discount_percent_for_recruits,
        discount_duration_months, is_promo_active, created_at, approved_at
      `,
      )
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ partners: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/partners/:id — fiche complète
// ════════════════════════════════════════════════════════════════════════
router.get('/admin/partners/:id', requireAdmin, async (req: Request, res: Response) => {
  const partnerId = req.params.id;
  try {
    const supa = getSupa();

    const [{ data: partner }, { data: recruits }, { data: commissions }] = await Promise.all([
      supa.from('partners').select('*').eq('id', partnerId).maybeSingle(),
      supa
        .from('partner_referrals')
        .select('driver_id, signup_date, subscription_status, total_earned, monthly_commission')
        .eq('partner_id', partnerId),
      supa
        .from('partner_commissions')
        .select(
          'id, level, commission_amount, commission_month, status, paid_at, stripe_transfer_id',
        )
        .eq('partner_id', partnerId)
        .order('commission_month', { ascending: false })
        .limit(100),
    ]);

    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    return res.json({
      partner,
      recruits: recruits ?? [],
      commissions: commissions ?? [],
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// PATCH /api/admin/partners/:id/discount — set discount config
// ════════════════════════════════════════════════════════════════════════
const DiscountSchema = z.object({
  discount_percent_for_recruits: z.number().int().min(0).max(50),
  discount_duration_months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  landing_message: z.string().max(2000).optional().nullable(),
  landing_hero_url: z.string().url().optional().nullable(),
  is_promo_active: z.boolean().optional(),
});

router.patch('/admin/partners/:id/discount', requireAdmin, async (req: Request, res: Response) => {
  const parsed = DiscountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
  }

  try {
    const supa = getSupa();
    const { data, error } = await supa
      .from('partners')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, partner: data });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/partners/:id/recruits — détail des chauffeurs recrutés
// ════════════════════════════════════════════════════════════════════════
router.get('/admin/partners/:id/recruits', requireAdmin, async (req: Request, res: Response) => {
  try {
    const supa = getSupa();
    const { data, error } = await supa
      .from('partner_referrals')
      .select(
        `
        id, driver_id, signup_date, subscription_status, total_earned,
        monthly_commission, driver_activity_score, conversion_funnel,
        utm_source, utm_campaign,
        drivers (id, first_name, last_name, email, subscription_active, qualified_for_referral)
      `,
      )
      .eq('partner_id', req.params.id)
      .order('signup_date', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ recruits: data ?? [] });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/payouts/pending — commissions en attente
// Lit la vue v_pending_mlm_payouts (chauffeur + partner agrégés)
// ════════════════════════════════════════════════════════════════════════
router.get('/admin/payouts/pending', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const supa = getSupa();
    const { data, error } = await supa
      .from('v_pending_mlm_payouts')
      .select('*')
      .order('total_amount_eur', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const total_eur = (data ?? []).reduce(
      (sum: number, row: any) => sum + Number(row.total_amount_eur ?? 0),
      0,
    );

    return res.json({ pending: data ?? [], total_eur });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/admin/payouts/history?month=YYYY-MM → historique
// ════════════════════════════════════════════════════════════════════════
router.get('/admin/payouts/history', requireAdmin, async (req: Request, res: Response) => {
  const month = (req.query.month as string) || null;
  try {
    const supa = getSupa();
    let query = supa
      .from('v_mlm_payouts_history')
      .select('*')
      .order('paid_at', { ascending: false });

    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const monthStart = `${month}-01`;
      query = query.eq('commission_month', monthStart);
    }

    const { data, error } = await query.limit(500);
    if (error) return res.status(500).json({ error: error.message });

    const total_eur = (data ?? []).reduce(
      (sum: number, row: any) => sum + Number(row.total_paid_eur ?? 0),
      0,
    );

    return res.json({ history: data ?? [], total_eur });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/admin/payouts/run-cron-now — debug : run cron immédiat
// ════════════════════════════════════════════════════════════════════════
router.post('/admin/payouts/run-cron-now', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { runMlmMonthlyPayout } = await import('../jobs/mlmMonthlyPayoutCron.js');
    const result = await runMlmMonthlyPayout();
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /api/public/partners/:referralCode/landing — données page CAP
// (consommé par fil Site pour la page d'inscription affiliée)
// ════════════════════════════════════════════════════════════════════════
router.get('/public/partners/:referralCode/landing', async (req: Request, res: Response) => {
  try {
    const supa = getSupa();
    const { data: partner } = await supa
      .from('partners')
      .select(
        `
        company_name, company_type, referral_code,
        discount_percent_for_recruits, discount_duration_months,
        landing_message, landing_hero_url, is_promo_active, status
      `,
      )
      .eq('referral_code', req.params.referralCode)
      .maybeSingle();

    if (!partner) {
      return res.status(404).json({ error: 'Code partenaire introuvable' });
    }
    if (partner.status !== 'active') {
      return res.status(404).json({ error: 'Code partenaire inactif' });
    }

    return res.json({
      partner: {
        company_name: partner.company_name,
        company_type: partner.company_type,
        referral_code: partner.referral_code,
        landing_message: partner.landing_message,
        landing_hero_url: partner.landing_hero_url,
      },
      discount: partner.is_promo_active
        ? {
            percent: partner.discount_percent_for_recruits,
            duration_months: partner.discount_duration_months,
          }
        : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// POST /api/public/partners/signup — inscription partner + email code
// (consommé par formulaire site d'inscription "Devenir partenaire FOREAS")
// ════════════════════════════════════════════════════════════════════════
const SignupSchema = z.object({
  company_name: z.string().min(2).max(120),
  contact_email: z.string().email(),
  contact_phone: z.string().min(6).max(30).optional(),
  company_type: z.enum([
    'auto_ecole',
    'fleet_manager',
    'influencer',
    'agent_commercial',
    'federation',
    'autre',
  ]),
  siret: z.string().min(14).max(14).optional().nullable(),
  address: z.string().max(255).optional().nullable(),
});

/**
 * Génère un code partner unique format FOREAS-{XX}{99}
 * où XX = 2 premières lettres entreprise + 2 digits aléatoires.
 */
async function generateUniquePartnerCode(
  supa: SupabaseClient,
  companyName: string,
): Promise<string> {
  const prefix = companyName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .substring(0, 2)
    .toUpperCase()
    .padEnd(2, 'X');

  for (let attempt = 0; attempt < 10; attempt++) {
    const digits = Math.floor(Math.random() * 90 + 10);
    const code = `FOREAS-${prefix}${digits}`;
    const { data: existing } = await supa
      .from('partners')
      .select('id')
      .eq('referral_code', code)
      .maybeSingle();
    if (!existing) return code;
  }

  // Fallback : 4 digits
  const fallback = Math.floor(Math.random() * 9000 + 1000);
  return `FOREAS-${prefix}${fallback}`;
}

router.post('/public/partners/signup', async (req: Request, res: Response) => {
  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid body', details: parsed.error.issues });
  }

  const { company_name, contact_email, contact_phone, company_type, siret, address } = parsed.data;

  try {
    const supa = getSupa();

    // Anti-doublon par email
    const { data: existing } = await supa
      .from('partners')
      .select('id, referral_code, status')
      .eq('contact_email', contact_email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error: 'Un partenaire est déjà enregistré avec cet email',
        referral_code: existing.referral_code,
        status: existing.status,
      });
    }

    // Génère code unique
    const referralCode = await generateUniquePartnerCode(supa, company_name);

    // Insert partner avec status='pending' (à valider par admin)
    const { data: partner, error: insErr } = await supa
      .from('partners')
      .insert({
        company_name,
        contact_email,
        contact_phone: contact_phone || null,
        company_type,
        siret: siret || null,
        address: address || null,
        referral_code: referralCode,
        status: 'pending',
        discount_percent_for_recruits: 0,
        discount_duration_months: 1,
        is_promo_active: true,
      })
      .select()
      .single();

    if (insErr) {
      console.error('[MlmPublic] insert partner failed:', insErr);
      return res.status(500).json({ error: insErr.message });
    }

    // Envoi email Resend avec le code
    try {
      const resend = await getResend();
      const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#F8FAFC;">
  <div style="max-width:600px;margin:40px auto;padding:32px;background:linear-gradient(180deg,rgba(140,82,255,0.08) 0%,transparent 50%);">
    <p style="font-size:11px;font-weight:800;letter-spacing:2.5px;color:#00D4FF;text-transform:uppercase;margin-bottom:12px;">FOREAS · PARTENAIRE</p>
    <h1 style="font-size:28px;font-weight:900;color:#F8FAFC;margin:0 0 16px;letter-spacing:-1px;">Bienvenue dans le programme partenaire FOREAS</h1>
    <p style="color:rgba(248,250,252,0.85);line-height:1.55;">Bonjour,</p>
    <p style="color:rgba(248,250,252,0.78);line-height:1.55;">Ta candidature pour <strong>${company_name}</strong> a bien été reçue. Voici ton code parrainage personnalisé :</p>
    <div style="margin:24px 0;padding:24px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;text-align:center;">
      <p style="font-size:11px;font-weight:700;color:#00D4FF;letter-spacing:1.5px;margin:0;">TON CODE PARRAINAGE</p>
      <p style="font-size:36px;font-weight:900;color:#F8FAFC;letter-spacing:2px;margin:8px 0 0;">${referralCode}</p>
    </div>
    <p style="color:rgba(248,250,252,0.78);line-height:1.55;">Pour chaque chauffeur que tu inscris avec ce code :</p>
    <ul style="color:rgba(248,250,252,0.85);line-height:1.7;">
      <li>10 € / mois en N1 (filleul direct)</li>
      <li>4 € / mois en N2 (filleul de filleul)</li>
      <li>2 € / mois en N3</li>
    </ul>
    <p style="color:rgba(248,250,252,0.78);line-height:1.55;">Versement automatique le 5 de chaque mois sur ton compte bancaire (Stripe Connect Express requis).</p>
    <p style="color:rgba(248,250,252,0.78);line-height:1.55;">⏳ Ton compte est en attente de validation par notre équipe (24-48h). Une fois validé, tu recevras un second email avec ton accès au dashboard partenaire et le lien d'onboarding Stripe.</p>
    <p style="margin-top:32px;color:rgba(248,250,252,0.45);font-size:11px;">© 2026 FOREAS Labs · contact@foreas.xyz</p>
  </div>
</body>
</html>`;

      await resend.emails.send({
        from: 'FOREAS Partenaires <partenaires@foreas.xyz>',
        to: contact_email,
        subject: `🎁 Ton code parrainage FOREAS : ${referralCode}`,
        html,
      });
      console.log(`[MlmPublic] Welcome email sent to ${contact_email}`);
    } catch (emailErr: any) {
      console.warn('[MlmPublic] email send failed (non-blocking):', emailErr?.message);
    }

    return res.status(201).json({
      ok: true,
      partner_id: partner.id,
      referral_code: referralCode,
      status: 'pending',
      message: 'Inscription reçue. Validation 24-48h.',
    });
  } catch (err: any) {
    console.error('[MlmPublic] signup error:', err?.message);
    return res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// Stripe lazy singleton (partagé avec les endpoints partenaire)
// ════════════════════════════════════════════════════════════════════════
let _stripe: any = null;
async function getStripe() {
  if (_stripe) return _stripe;
  const Stripe = (await import('stripe')).default;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-12-18.acacia' as any,
  });
  return _stripe;
}

// ════════════════════════════════════════════════════════════════════════
// POST /api/admin/partner-applications/:id/approve — TROU #2
//
// 1. Lit partner_applications (status='pending')
// 2. Génère referral_code unique + crée ligne partners
// 3. Marque l'application 'approved'
// 4. Invite auth Supabase (magic-link set-password) → partner.user_id = user.id
// 5. Crée compte Stripe Connect Express + lien onboarding
//
// Réponse : { ok, referral_code, onboarding_url }
// ════════════════════════════════════════════════════════════════════════
router.post(
  '/admin/partner-applications/:id/approve',
  requireAdmin,
  async (req: Request, res: Response) => {
    const applicationId = req.params.id;
    const adminUserId = (req as any).adminUserId as string;
    const supa = getSupa();

    try {
      // 1. Lire l'application
      const { data: application, error: appErr } = await supa
        .from('partner_applications')
        .select('id, company_name, contact_name, email, phone, siret, status')
        .eq('id', applicationId)
        .maybeSingle();

      if (appErr || !application) {
        return res.status(404).json({ error: 'Candidature introuvable' });
      }
      if (application.status !== 'pending') {
        return res.status(409).json({ error: `Candidature déjà ${application.status}` });
      }

      // 2. Générer code unique
      const referralCode = await generateUniquePartnerCode(supa, application.company_name);

      // 3. Créer la ligne partners
      const { data: partner, error: partnerErr } = await supa
        .from('partners')
        .insert({
          company_name: application.company_name,
          contact_email: application.email,
          contact_phone: application.phone ?? null,
          company_type: 'autre',
          siret: application.siret ?? null,
          referral_code: referralCode,
          status: 'active',
          discount_percent_for_recruits: 0,
          discount_duration_months: 1,
          is_promo_active: false,
          approved_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (partnerErr || !partner) {
        console.error('[PartnerApprove] insert partners failed:', partnerErr);
        return res.status(500).json({ error: partnerErr?.message ?? 'Erreur création partenaire' });
      }

      // 4. Marquer l'application approuvée
      await supa
        .from('partner_applications')
        .update({
          status: 'approved',
          reviewed_at: new Date().toISOString(),
          reviewed_by: adminUserId,
        })
        .eq('id', applicationId);

      // 5. Inviter l'utilisateur via Supabase auth (magic-link set-password)
      //    → user.id récupéré pour relier partners.user_id
      let onboardingUrl: string | null = null;
      try {
        const { data: inviteData, error: inviteErr } = await supa.auth.admin.inviteUserByEmail(
          application.email,
          {
            data: {
              partner_id: partner.id,
              full_name: application.contact_name ?? application.company_name,
            },
            redirectTo: 'https://partners.foreas.xyz/auth/callback',
          },
        );

        if (!inviteErr && inviteData?.user?.id) {
          // Lier user_id → partners
          await supa.from('partners').update({ user_id: inviteData.user.id }).eq('id', partner.id);
        }

        // 6. Créer Stripe Connect Express + lien onboarding
        const stripe = await getStripe();
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'FR',
          email: application.email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_type: 'company',
          metadata: { partner_id: partner.id, platform: 'FOREAS' },
        });

        await supa.from('partners').update({ stripe_account_id: account.id }).eq('id', partner.id);

        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: 'https://partners.foreas.xyz/partner',
          return_url: 'https://partners.foreas.xyz/partner',
          type: 'account_onboarding',
        });

        onboardingUrl = accountLink.url;
      } catch (sideErr: any) {
        // Invite ou Stripe échoue → partenaire créé, on log mais on ne rollback pas
        console.warn('[PartnerApprove] side-effect error (non-blocking):', sideErr?.message);
      }

      console.log(
        `[PartnerApprove] ✅ ${application.company_name} approuvé → code ${referralCode}`,
      );
      return res.json({ ok: true, referral_code: referralCode, onboarding_url: onboardingUrl });
    } catch (err: any) {
      console.error('[PartnerApprove] error:', err?.message);
      return res.status(500).json({ error: err?.message });
    }
  },
);

// ════════════════════════════════════════════════════════════════════════
// POST /api/partner/stripe/connect-link — TROU #3
//
// Génère (ou régénère) le lien d'onboarding Stripe Connect Express
// pour le partenaire authentifié. Crée le compte si absent.
//
// Auth : Bearer token Supabase du partenaire (pas admin)
// Réponse : { ok, url }
// ════════════════════════════════════════════════════════════════════════
router.post('/partner/stripe/connect-link', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token requis' });
  }

  const supa = getSupa();
  const token = authHeader.replace('Bearer ', '');

  try {
    // Auth
    const { data: authData, error: authErr } = await supa.auth.getUser(token);
    if (authErr || !authData?.user?.id) {
      return res.status(401).json({ error: 'Token invalide' });
    }

    // Récupérer la fiche partenaire
    const { data: partner, error: partnerErr } = await supa
      .from('partners')
      .select('id, company_name, contact_email, stripe_account_id')
      .eq('user_id', authData.user.id)
      .maybeSingle();

    if (partnerErr || !partner) {
      return res.status(404).json({ error: 'Compte partenaire introuvable' });
    }

    const stripe = await getStripe();
    let accountId = partner.stripe_account_id;

    // Créer le compte Express si absent
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'FR',
        email: partner.contact_email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'company',
        metadata: { partner_id: partner.id, platform: 'FOREAS' },
      });
      accountId = account.id;

      await supa.from('partners').update({ stripe_account_id: accountId }).eq('id', partner.id);

      // Webhook account.updated gérera charges_enabled / payouts_enabled
      console.log(`[PartnerConnect] ✅ Compte Express créé : ${accountId} → partner ${partner.id}`);
    }

    // Générer le lien d'onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://partners.foreas.xyz/partner',
      return_url: 'https://partners.foreas.xyz/partner',
      type: 'account_onboarding',
    });

    return res.json({ ok: true, url: accountLink.url, onboarding_url: accountLink.url });
  } catch (err: any) {
    console.error('[PartnerConnect] error:', err?.message);
    return res.status(500).json({ error: err?.message });
  }
});

export default router;
