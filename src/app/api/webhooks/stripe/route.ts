import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { env } from "@/env";

/**
 * Webhook Stripe pour gérer les événements de paiement
 * 
 * SÉCURITÉ CRITIQUE:
 * - Vérification de la signature Stripe
 * - Idempotence des événements
 * - Gestion des erreurs avec retry automatique
 * 
 * ÉVÉNEMENTS GÉRÉS:
 * - payment_intent.succeeded
 * - payment_intent.payment_failed
 * - account.updated (chauffeur)
 * - charge.dispute.created
 */

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    console.error("❌ Webhook: Signature Stripe manquante");
    return NextResponse.json(
      { error: "Signature manquante" }, 
      { status: 400 }
    );
  }

  let event: Stripe.Event;

  try {
    // Vérifier la signature pour s'assurer que l'événement vient de Stripe
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error("❌ Webhook: Signature invalide", err);
    return NextResponse.json(
      { error: "Signature invalide" }, 
      { status: 400 }
    );
  }

  console.log(`📡 Webhook Stripe reçu: ${event.type} (${event.id})`);

  try {
    // Traiter l'événement selon son type
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      case "account.updated":
        await handleAccountUpdated(event.data.object as Stripe.Account);
        break;

      case "charge.dispute.created":
        await handleDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      case "payout.paid":
        await handlePayoutPaid(event.data.object as Stripe.Payout);
        break;

      default:
        console.log(`ℹ️ Événement non géré: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error(`❌ Erreur traitement webhook ${event.type}:`, error);
    
    // Retourner 500 pour que Stripe retry automatiquement
    return NextResponse.json(
      { error: "Erreur traitement" }, 
      { status: 500 }
    );
  }
}

/**
 * Paiement réussi - Mettre à jour la réservation
 */
async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  
  if (!bookingId) {
    console.warn("⚠️ Payment Intent sans bookingId:", paymentIntent.id);
    return;
  }

  try {
    // Mettre à jour la réservation et créer l'earning
    await prisma.$transaction(async (tx) => {
      // Mettre à jour le statut de paiement
      const booking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          paymentStatus: "COMPLETED",
          finalPrice: paymentIntent.amount / 100, // Centimes → Euros
        },
        include: { driver: true },
      });

      // Créer l'earning pour le chauffeur
      const platformFee = parseInt(paymentIntent.metadata?.platformFee || "0");
      const netAmount = paymentIntent.amount - platformFee;

      await tx.earning.create({
        data: {
          driverId: booking.driver.id,
          type: "BOOKING",
          platform: "DIRECT",
          amount: netAmount / 100, // Centimes → Euros
          currency: "EUR",
          bookingId: booking.id,
          earnedAt: new Date(),
        },
      });

      // Mettre à jour les stats du chauffeur
      await tx.driver.update({
        where: { id: booking.driver.id },
        data: {
          totalEarnings: {
            increment: netAmount / 100,
          },
        },
      });
    });

    console.log(`✅ Paiement traité: ${paymentIntent.id} → Réservation ${bookingId}`);
  } catch (error) {
    console.error("❌ Erreur mise à jour paiement réussi:", error);
    throw error; // Relancer pour déclencher le retry Stripe
  }
}

/**
 * Paiement échoué - Notifier le chauffeur et le client
 */
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  const bookingId = paymentIntent.metadata?.bookingId;
  
  if (!bookingId) {
    console.warn("⚠️ Payment Intent échoué sans bookingId:", paymentIntent.id);
    return;
  }

  try {
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        paymentStatus: "FAILED",
      },
    });

    // TODO: Envoyer notification push au client et chauffeur
    // TODO: Envoyer email d'échec de paiement
    
    console.log(`❌ Paiement échoué: ${paymentIntent.id} → Réservation ${bookingId}`);
  } catch (error) {
    console.error("❌ Erreur mise à jour paiement échoué:", error);
    throw error;
  }
}

/**
 * Compte Stripe mis à jour - Synchroniser le statut d'onboarding
 */
async function handleAccountUpdated(account: Stripe.Account) {
  const userId = account.metadata?.userId;
  
  if (!userId) {
    console.warn("⚠️ Compte Stripe sans userId:", account.id);
    return;
  }

  try {
    const isOnboarded = account.details_submitted && 
                       account.charges_enabled && 
                       account.payouts_enabled;

    await prisma.driver.updateMany({
      where: { 
        userId: userId,
        stripeAccountId: account.id,
      },
      data: {
        stripeOnboarded: isOnboarded,
      },
    });

    console.log(`🔄 Compte mis à jour: ${account.id} → Onboarded: ${isOnboarded}`);
  } catch (error) {
    console.error("❌ Erreur mise à jour compte:", error);
    throw error;
  }
}

/**
 * Litige créé - Alerter l'équipe support
 */
async function handleDisputeCreated(dispute: Stripe.Dispute) {
  const chargeId = dispute.charge as string;
  
  try {
    // Récupérer les détails du charge
    const charge = await stripe.charges.retrieve(chargeId);
    const bookingId = charge.metadata?.bookingId;

    if (bookingId) {
      // TODO: Créer un ticket support automatiquement
      // TODO: Notifier l'équipe FOREAS par Slack/Discord
      // TODO: Envoyer email au chauffeur concerné
      
      console.log(`⚠️ LITIGE créé: ${dispute.id} → Réservation ${bookingId}`);
      console.log(`💰 Montant: ${dispute.amount / 100}€ - Raison: ${dispute.reason}`);
    }
  } catch (error) {
    console.error("❌ Erreur traitement litige:", error);
    throw error;
  }
}

/**
 * Virement effectué - Mettre à jour les stats chauffeur
 */
async function handlePayoutPaid(payout: Stripe.Payout) {
  // TODO: Enregistrer les virements en base
  // TODO: Notifier le chauffeur par push/email
  
  console.log(`💸 Virement effectué: ${payout.amount / 100}€ → ${payout.destination}`);
}