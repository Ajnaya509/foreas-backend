import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";

/**
 * API Route pour synchroniser le compte Stripe avec la BDD
 * 
 * ENDPOINT: POST /api/stripe/sync-account
 * 
 * SÉCURITÉ:
 * - Validation de l'account ID Stripe
 * - Vérification que le compte appartient bien à Stripe
 * - Mise à jour atomique en base de données
 * - Logs complets pour audit
 * 
 * UTILISATION:
 * - Appelé depuis la page de retour Stripe
 * - Peut être appelé plusieurs fois (idempotent)
 * - Synchronise le statut d'onboarding en temps réel
 */

// Schéma de validation des données reçues
const syncAccountSchema = z.object({
  accountId: z.string()
    .regex(/^acct_[A-Za-z0-9]{16,}$/, "Format d'account ID invalide"),
  state: z.string().optional(), // Token de sécurité optionnel
});

export async function POST(request: NextRequest) {
  try {
    // Parser et valider les données
    const body = await request.json();
    const { accountId, state } = syncAccountSchema.parse(body);

    console.log(`🔄 Synchronisation Stripe account: ${accountId}`);

    // Vérifier que le compte existe vraiment chez Stripe
    let stripeAccount;
    try {
      stripeAccount = await stripe.accounts.retrieve(accountId);
    } catch (stripeError: any) {
      console.error('❌ Account Stripe non trouvé:', stripeError);
      return NextResponse.json(
        { error: 'Compte Stripe introuvable ou invalide' },
        { status: 400 }
      );
    }

    // Extraire les métadonnées pour identifier l'utilisateur
    const userId = stripeAccount.metadata?.userId;
    const driverId = stripeAccount.metadata?.driverId;

    if (!userId) {
      console.error('❌ User ID manquant dans les métadonnées Stripe');
      return NextResponse.json(
        { error: 'Impossible d\'identifier l\'utilisateur propriétaire' },
        { status: 400 }
      );
    }

    // Vérifier le statut d'onboarding Stripe
    const isOnboarded = stripeAccount.details_submitted && 
                       stripeAccount.charges_enabled && 
                       stripeAccount.payouts_enabled;

    const canAcceptPayments = stripeAccount.charges_enabled;
    const canReceivePayouts = stripeAccount.payouts_enabled;

    console.log('📊 Statut Stripe:', {
      accountId,
      userId,
      isOnboarded,
      canAcceptPayments,
      canReceivePayouts,
      requirements: stripeAccount.requirements?.currently_due?.length || 0
    });

    // Mise à jour en base de données (transaction atomique)
    const updatedDriver = await prisma.$transaction(async (tx) => {
      // Trouver le chauffeur par userId
      const driver = await tx.driver.findUnique({
        where: { userId },
        include: { user: true },
      });

      if (!driver) {
        throw new Error(`Chauffeur non trouvé pour userId: ${userId}`);
      }

      // Mettre à jour les informations Stripe
      const updated = await tx.driver.update({
        where: { id: driver.id },
        data: {
          stripeAccountId: accountId,
          stripeOnboarded: isOnboarded,
          updatedAt: new Date(),
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
            }
          }
        }
      });

      // Créer un log d'audit
      await tx.ajnayaInsight.create({
        data: {
          driverId: driver.id,
          type: 'PERFORMANCE',
          priority: 'MEDIUM',
          title: isOnboarded ? '✅ Paiements Stripe activés' : '⚠️ Configuration Stripe en cours',
          message: isOnboarded 
            ? 'Votre compte Stripe est maintenant actif ! Vous pouvez recevoir des paiements directs avec une commission de seulement 5%.'
            : 'Votre compte Stripe est créé mais nécessite quelques informations supplémentaires pour être complètement activé.',
          data: {
            accountId,
            isOnboarded,
            canAcceptPayments,
            canReceivePayouts,
            requirementsCount: stripeAccount.requirements?.currently_due?.length || 0,
            source: 'stripe_sync',
            timestamp: new Date().toISOString(),
          },
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 jours
          createdAt: new Date(),
        }
      });

      return updated;
    });

    // Log de succès
    console.log(`✅ Synchronisation réussie pour ${updatedDriver.user.email}:`, {
      driverId: updatedDriver.id,
      accountId,
      isOnboarded,
      previousAccountId: updatedDriver.stripeAccountId !== accountId ? 'updated' : 'same'
    });

    // Réponse avec toutes les informations utiles
    return NextResponse.json({
      success: true,
      accountId,
      userId,
      driverId: updatedDriver.id,
      driver: {
        id: updatedDriver.id,
        email: updatedDriver.user.email,
        name: updatedDriver.user.name,
      },
      stripe: {
        accountId,
        isOnboarded,
        canAcceptPayments,
        canReceivePayouts,
        requirements: stripeAccount.requirements?.currently_due || [],
        requirementsCount: stripeAccount.requirements?.currently_due?.length || 0,
      },
      message: isOnboarded 
        ? 'Compte Stripe entièrement configuré et prêt !'
        : `Configuration en cours. ${stripeAccount.requirements?.currently_due?.length || 0} élément(s) restant(s).`
    });

  } catch (error: any) {
    console.error('❌ Erreur synchronisation Stripe:', error);

    // Erreur de validation Zod
    if (error.name === 'ZodError') {
      return NextResponse.json(
        { 
          error: 'Données invalides',
          details: error.errors.map((e: any) => e.message)
        },
        { status: 400 }
      );
    }

    // Erreur Prisma (BDD)
    if (error.code === 'P2002') {
      return NextResponse.json(
        { error: 'Cet account ID est déjà associé à un autre chauffeur' },
        { status: 409 }
      );
    }

    // Erreur générique
    return NextResponse.json(
      { 
        error: 'Erreur interne du serveur',
        message: error.message || 'Une erreur est survenue lors de la synchronisation'
      },
      { status: 500 }
    );
  }
}

/**
 * GET: Récupérer le statut d'un compte
 * Utile pour vérification manuelle ou debug
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('accountId');
    const userId = searchParams.get('userId');

    if (!accountId && !userId) {
      return NextResponse.json(
        { error: 'accountId ou userId requis' },
        { status: 400 }
      );
    }

    let driver;
    
    if (userId) {
      // Recherche par userId
      driver = await prisma.driver.findUnique({
        where: { userId },
        include: { user: true },
      });
    } else if (accountId) {
      // Recherche par accountId
      driver = await prisma.driver.findFirst({
        where: { stripeAccountId: accountId },
        include: { user: true },
      });
    }

    if (!driver) {
      return NextResponse.json(
        { error: 'Chauffeur non trouvé' },
        { status: 404 }
      );
    }

    // Récupérer les infos Stripe si account ID disponible
    let stripeData = null;
    if (driver.stripeAccountId) {
      try {
        const stripeAccount = await stripe.accounts.retrieve(driver.stripeAccountId);
        stripeData = {
          accountId: stripeAccount.id,
          isOnboarded: stripeAccount.details_submitted && 
                      stripeAccount.charges_enabled && 
                      stripeAccount.payouts_enabled,
          canAcceptPayments: stripeAccount.charges_enabled,
          canReceivePayouts: stripeAccount.payouts_enabled,
          requirements: stripeAccount.requirements?.currently_due || [],
          country: stripeAccount.country,
          email: stripeAccount.email,
        };
      } catch (stripeError) {
        console.warn('⚠️ Erreur récupération compte Stripe:', stripeError);
      }
    }

    return NextResponse.json({
      driver: {
        id: driver.id,
        userId: driver.userId,
        email: driver.user.email,
        name: driver.user.name,
        stripeAccountId: driver.stripeAccountId,
        stripeOnboarded: driver.stripeOnboarded,
      },
      stripe: stripeData,
    });

  } catch (error: any) {
    console.error('❌ Erreur GET sync-account:', error);
    return NextResponse.json(
      { error: 'Erreur interne du serveur' },
      { status: 500 }
    );
  }
}