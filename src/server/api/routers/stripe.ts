import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  driverProcedure,
  protectedProcedure,
} from "@/server/api/trpc";
import { 
  stripe, 
  STRIPE_CONNECT_CONFIG, 
  getStripeUrls,
  calculatePlatformFee,
  isValidStripeAccountId,
  type StripeAccountCreationResult,
  type StripePaymentIntentData
} from "@/lib/stripe";

export const stripeRouter = createTRPCRouter({
  /**
   * Créer un compte Stripe Connect pour un chauffeur
   * SÉCURITÉ: Seuls les chauffeurs authentifiés peuvent créer un compte
   */
  createConnectAccount: driverProcedure
    .input(
      z.object({
        email: z.string().email("Email invalide"),
        phone: z.string().optional(),
        firstName: z.string().min(2, "Prénom requis"),
        lastName: z.string().min(2, "Nom requis"),
      })
    )
    .mutation(async ({ ctx, input }): Promise<StripeAccountCreationResult> => {
      const userId = ctx.session.user.id;
      
      // Vérifier que le chauffeur existe
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId },
        include: { user: true },
      });

      if (!driver) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profil chauffeur non trouvé",
        });
      }

      // Vérifier qu'il n'a pas déjà un compte Stripe
      if (driver.stripeAccountId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Vous avez déjà un compte Stripe Connect",
        });
      }

      try {
        // Créer le compte Stripe Connect
        const account = await stripe.accounts.create({
          ...STRIPE_CONNECT_CONFIG.account,
          email: input.email,
          individual: {
            email: input.email,
            phone: input.phone,
            first_name: input.firstName,
            last_name: input.lastName,
          },
          metadata: {
            userId: driver.userId,
            driverId: driver.id,
            licenseNumber: driver.licenseNumber,
            platform: "FOREAS",
          },
        });

        // Créer le lien d'onboarding
        const urls = getStripeUrls();
        const accountLink = await stripe.accountLinks.create({
          account: account.id,
          refresh_url: urls.refresh_url,
          return_url: urls.return_url,
          type: "account_onboarding",
        });

        // Sauvegarder l'account ID en base
        await ctx.prisma.driver.update({
          where: { id: driver.id },
          data: {
            stripeAccountId: account.id,
            stripeOnboarded: false, // Sera mis à true après onboarding
          },
        });

        console.log(`✅ Compte Stripe créé pour ${driver.user.email}: ${account.id}`);

        return {
          accountId: account.id,
          onboardingUrl: accountLink.url,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
        };
      } catch (error) {
        console.error("❌ Erreur création compte Stripe:", error);
        
        if (error instanceof Error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Erreur Stripe: ${error.message}`,
          });
        }
        
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR", 
          message: "Erreur inconnue lors de la création du compte Stripe",
        });
      }
    }),

  /**
   * Récupérer le statut du compte Stripe Connect
   */
  getAccountStatus: driverProcedure.query(async ({ ctx }) => {
    const driver = await ctx.prisma.driver.findUnique({
      where: { userId: ctx.session.user.id },
    });

    if (!driver?.stripeAccountId) {
      return {
        hasAccount: false,
        isOnboarded: false,
        canAcceptPayments: false,
      };
    }

    try {
      // Récupérer les infos du compte Stripe
      const account = await stripe.accounts.retrieve(driver.stripeAccountId);
      
      const isOnboarded = account.details_submitted && 
                         account.charges_enabled && 
                         account.payouts_enabled;

      // Mettre à jour le statut en base si nécessaire
      if (isOnboarded !== driver.stripeOnboarded) {
        await ctx.prisma.driver.update({
          where: { id: driver.id },
          data: { stripeOnboarded: isOnboarded },
        });
      }

      return {
        hasAccount: true,
        isOnboarded,
        canAcceptPayments: account.charges_enabled,
        canReceivePayouts: account.payouts_enabled,
        requirements: account.requirements?.currently_due || [],
        accountId: account.id,
      };
    } catch (error) {
      console.error("❌ Erreur récupération compte Stripe:", error);
      return {
        hasAccount: true,
        isOnboarded: false,
        canAcceptPayments: false,
        error: "Erreur lors de la vérification du compte",
      };
    }
  }),

  /**
   * Créer un nouveau lien d'onboarding (si expiré)
   */
  refreshOnboardingLink: driverProcedure.mutation(async ({ ctx }) => {
    const driver = await ctx.prisma.driver.findUnique({
      where: { userId: ctx.session.user.id },
    });

    if (!driver?.stripeAccountId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Aucun compte Stripe trouvé",
      });
    }

    try {
      const urls = getStripeUrls();
      const accountLink = await stripe.accountLinks.create({
        account: driver.stripeAccountId,
        refresh_url: urls.refresh_url,
        return_url: urls.return_url,
        type: "account_onboarding",
      });

      return {
        onboardingUrl: accountLink.url,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      };
    } catch (error) {
      console.error("❌ Erreur refresh lien onboarding:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Impossible de générer un nouveau lien",
      });
    }
  }),

  /**
   * Créer un Payment Intent V2 avec splits automatiques
   * NOUVELLE VERSION avec commission intelligente et splits Stripe Connect
   * 
   * FONCTIONNALITÉS:
   * - Commission adaptive (5%, 10% ou 15%)
   * - Split automatique vers le chauffeur
   * - Validation complète des montants
   * - Metadata enrichie pour tracking
   */
  createPaymentIntentV2: protectedProcedure
    .input(
      z.object({
        bookingId: z.string().cuid("ID réservation invalide"),
        amount: z.number()
          .min(500, "Montant minimum: 5€") 
          .max(50000, "Montant maximum: 500€"), // en centimes
        currency: z.string().default("eur"),
        description: z.string().optional(),
        rideDetails: z.object({
          from: z.string().min(1, "Adresse de départ requise"),
          to: z.string().optional(),
          distance: z.number().min(0).optional(), // en km
          duration: z.number().min(0).optional(), // en minutes
        }).optional(),
      })
    )
    .mutation(async ({ ctx, input }): Promise<StripePaymentIntentData> => {
      const { bookingId, amount, currency, description, rideDetails } = input;
      
      // Récupérer la réservation avec toutes les relations
      const booking = await ctx.prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          driver: {
            include: {
              user: true,
              _count: {
                select: { rides: true }
              }
            }
          },
          client: true,
        },
      });

      if (!booking) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Réservation non trouvée",
        });
      }

      // Vérifier les permissions
      const isClient = booking.clientId === ctx.session.user.id;
      const isDriver = booking.driver.userId === ctx.session.user.id;
      const isAdmin = ctx.session.user.role === "ADMIN";
      
      if (!isClient && !isDriver && !isAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Accès non autorisé à cette réservation",
        });
      }

      // Vérifier que le chauffeur peut recevoir des paiements
      if (!booking.driver.stripeAccountId || !booking.driver.stripeOnboarded) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Le chauffeur n'a pas terminé sa configuration Stripe Connect",
        });
      }

      try {
        // Import dynamique du service de commission
        const { preparePaymentSplit, validatePaymentAmount } = await import("@/lib/commission");
        
        // Valider le montant
        const validation = validatePaymentAmount(amount);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: validation.error || "Montant invalide",
          });
        }

        // Préparer les stats du chauffeur pour le calcul de commission
        const driverStats = {
          totalRides: booking.driver._count.rides,
          averageRating: booking.driver.averageRating,
          isVerified: booking.driver.user.status === "ACTIVE",
        };

        // Calculer la commission et préparer le split
        const splitData = preparePaymentSplit(
          amount,
          booking.driver.stripeAccountId,
          {
            bookingId: booking.id,
            driverId: booking.driver.id,
            clientId: booking.clientId,
            from: booking.pickupAddress,
            to: booking.dropoffAddress || undefined,
            distance: rideDetails?.distance,
            duration: rideDetails?.duration || booking.estimatedDuration || undefined,
            driverName: booking.driver.user.name || undefined,
          },
          driverStats
        );

        console.log(`💳 Création PaymentIntent V2:`, {
          bookingId,
          amount,
          commission: `${splitData.commission.commissionPercentage}%`,
          tier: splitData.commission.commissionTier,
          driverReceives: splitData.commission.netAmount,
        });

        // Créer le Payment Intent avec split automatique
        const paymentIntent = await stripe.paymentIntents.create({
          amount: splitData.totalAmount,
          currency,
          description: description || splitData.description,
          
          // 🚀 SPLIT AUTOMATIQUE VERS LE CHAUFFEUR
          application_fee_amount: splitData.applicationFeeAmount,
          transfer_data: {
            destination: splitData.transferDestination,
          },
          
          // Métadonnées enrichies pour analytics
          metadata: {
            ...splitData.metadata,
            originalAmount: amount.toString(),
            finalAmount: splitData.totalAmount.toString(),
            warnings: validation.warnings?.join(', ') || '',
          },
          
          // Configuration pour UX optimale
          confirm: false, // Le client devra confirmer côté frontend
          capture_method: 'automatic',
          
          // Receipt email automatique
          receipt_email: booking.client.email || undefined,
        });

        // Mettre à jour la réservation avec les nouvelles données
        await ctx.prisma.booking.update({
          where: { id: booking.id },
          data: {
            stripePaymentId: paymentIntent.id,
            proposedPrice: amount / 100, // Conversion centimes → euros
            finalPrice: splitData.totalAmount / 100,
            paymentStatus: "PROCESSING",
            updatedAt: new Date(),
          },
        });

        // Créer une notification Ajnaya pour le chauffeur
        if (isClient) {
          await ctx.prisma.ajnayaInsight.create({
            data: {
              driverId: booking.driver.id,
              type: 'EARNINGS_BOOST',
              priority: 'HIGH',
              title: '💰 Nouveau paiement en cours',
              message: `Un client vient d'initier un paiement de ${(amount/100).toFixed(2)}€. Vous recevrez ${(splitData.commission.netAmount/100).toFixed(2)}€ net (commission ${splitData.commission.commissionPercentage}%).`,
              data: {
                paymentIntentId: paymentIntent.id,
                bookingId: booking.id,
                clientAmount: amount,
                driverAmount: splitData.commission.netAmount,
                commissionTier: splitData.commission.commissionTier,
                source: 'payment_intent_v2',
              },
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
              createdAt: new Date(),
            },
          });
        }

        console.log(`✅ PaymentIntent créé: ${paymentIntent.id} - Split: ${splitData.commission.commissionPercentage}%`);

        return {
          id: paymentIntent.id,
          amount: splitData.totalAmount,
          currency,
          status: paymentIntent.status,
          clientSecret: paymentIntent.client_secret!,
          platformFee: splitData.applicationFeeAmount,
          netAmount: splitData.commission.netAmount,
          commission: splitData.commission,
        } as StripePaymentIntentData;

      } catch (error: any) {
        console.error("❌ Erreur création PaymentIntent V2:", error);
        
        if (error instanceof TRPCError) {
          throw error;
        }
        
        if (error.type === 'StripeCardError') {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Erreur carte: ${error.message}`,
          });
        }
        
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Erreur paiement: ${error.message || 'Erreur inconnue'}`,
        });
      }
    }),

  /**
   * Créer un Payment Intent pour une réservation directe (VERSION LEGACY)
   * DEPRECATED: Utiliser createPaymentIntentV2 pour les nouvelles intégrations
   */
  createPaymentIntent: protectedProcedure
    .input(
      z.object({
        bookingId: z.string().cuid("ID réservation invalide"),
        amount: z.number().min(500, "Montant minimum: 5€").max(100000, "Montant maximum: 1000€"), // en centimes
        currency: z.string().default("eur"),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }): Promise<StripePaymentIntentData> => {
      // Récupérer la réservation avec le chauffeur
      const booking = await ctx.prisma.booking.findUnique({
        where: { id: input.bookingId },
        include: {
          driver: true,
          client: true,
        },
      });

      if (!booking) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Réservation non trouvée",
        });
      }

      // Vérifier que l'utilisateur est soit le client soit le chauffeur
      const isClient = booking.clientId === ctx.session.user.id;
      const isDriver = booking.driver.userId === ctx.session.user.id;
      
      if (!isClient && !isDriver) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Accès non autorisé à cette réservation",
        });
      }

      // Vérifier que le chauffeur a un compte Stripe actif
      if (!booking.driver.stripeAccountId || !booking.driver.stripeOnboarded) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Le chauffeur n'a pas terminé sa configuration Stripe",
        });
      }

      try {
        // Calculer la commission FOREAS
        const platformFee = calculatePlatformFee(input.amount);
        const netAmount = input.amount - platformFee;

        // Créer le Payment Intent avec destination
        const paymentIntent = await stripe.paymentIntents.create({
          amount: input.amount,
          currency: input.currency,
          description: input.description || `Réservation FOREAS ${booking.id}`,
          
          // Paiement direct au chauffeur avec commission
          transfer_data: {
            destination: booking.driver.stripeAccountId,
          },
          application_fee_amount: platformFee,
          
          // Métadonnées pour tracking
          metadata: {
            bookingId: booking.id,
            driverId: booking.driver.id,
            clientId: booking.clientId,
            platform: "FOREAS_DIRECT",
            platformFee: platformFee.toString(),
          },
        });

        // Mettre à jour la réservation avec le Payment Intent
        await ctx.prisma.booking.update({
          where: { id: booking.id },
          data: {
            stripePaymentId: paymentIntent.id,
            finalPrice: input.amount / 100, // Convertir centimes en euros
            paymentStatus: "PROCESSING",
          },
        });

        console.log(`💳 Payment Intent créé: ${paymentIntent.id} (${input.amount}¢)`);

        return {
          id: paymentIntent.id,
          amount: input.amount,
          currency: input.currency,
          status: paymentIntent.status,
          clientSecret: paymentIntent.client_secret!,
          platformFee,
          netAmount,
        };
      } catch (error) {
        console.error("❌ Erreur création Payment Intent:", error);
        
        if (error instanceof Error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Erreur paiement: ${error.message}`,
          });
        }
        
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Erreur lors de la création du paiement",
        });
      }
    }),

  /**
   * Synchroniser manuellement le statut Stripe depuis l'app
   * Utile après retour de configuration ou pour refresh
   */
  syncAccountStatus: driverProcedure.mutation(async ({ ctx }) => {
    const driver = await ctx.prisma.driver.findUnique({
      where: { userId: ctx.session.user.id },
    });

    if (!driver?.stripeAccountId) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Aucun compte Stripe trouvé pour ce chauffeur",
      });
    }

    try {
      // Récupérer les infos actuelles depuis Stripe
      const stripeAccount = await stripe.accounts.retrieve(driver.stripeAccountId);
      
      const isOnboarded = stripeAccount.details_submitted && 
                         stripeAccount.charges_enabled && 
                         stripeAccount.payouts_enabled;

      // Mettre à jour en base de données
      const updatedDriver = await ctx.prisma.driver.update({
        where: { id: driver.id },
        data: {
          stripeOnboarded: isOnboarded,
          updatedAt: new Date(),
        },
      });

      // Créer une notification si le statut a changé
      if (isOnboarded !== driver.stripeOnboarded) {
        await ctx.prisma.ajnayaInsight.create({
          data: {
            driverId: driver.id,
            type: 'PERFORMANCE',
            priority: isOnboarded ? 'HIGH' : 'MEDIUM',
            title: isOnboarded ? '🎉 Paiements Stripe activés !' : '⏳ Configuration Stripe en cours',
            message: isOnboarded 
              ? 'Félicitations ! Votre compte Stripe est maintenant entièrement configuré. Vous pouvez recevoir des paiements directs avec une commission de seulement 5%.'
              : 'Votre configuration Stripe est en cours de finalisation. Quelques informations supplémentaires sont peut-être nécessaires.',
            data: {
              accountId: driver.stripeAccountId,
              statusChanged: true,
              previousStatus: driver.stripeOnboarded,
              newStatus: isOnboarded,
              requirements: stripeAccount.requirements?.currently_due || [],
              source: 'sync_mutation',
            },
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 jours
            createdAt: new Date(),
          }
        });
      }

      console.log(`🔄 Sync Stripe pour ${ctx.session.user.email}: ${driver.stripeOnboarded} → ${isOnboarded}`);

      return {
        success: true,
        accountId: driver.stripeAccountId,
        statusChanged: isOnboarded !== driver.stripeOnboarded,
        stripe: {
          accountId: stripeAccount.id,
          isOnboarded,
          canAcceptPayments: stripeAccount.charges_enabled,
          canReceivePayouts: stripeAccount.payouts_enabled,
          requirements: stripeAccount.requirements?.currently_due || [],
          email: stripeAccount.email,
          country: stripeAccount.country,
        }
      };
    } catch (error: any) {
      console.error('❌ Erreur sync Stripe:', error);
      
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Impossible de synchroniser le statut Stripe",
      });
    }
  }),

  /**
   * Récupérer l'historique des paiements d'un chauffeur
   */
  getPaymentHistory: driverProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        startingAfter: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
      });

      if (!driver?.stripeAccountId) {
        return { payments: [], hasMore: false };
      }

      try {
        // Récupérer les paiements depuis Stripe
        const charges = await stripe.charges.list({
          destination: driver.stripeAccountId,
          limit: input.limit,
          starting_after: input.startingAfter,
        });

        const payments = charges.data.map(charge => ({
          id: charge.id,
          amount: charge.amount,
          currency: charge.currency,
          status: charge.status,
          description: charge.description,
          created: new Date(charge.created * 1000),
          bookingId: charge.metadata?.bookingId,
          platformFee: parseInt(charge.metadata?.platformFee || "0"),
        }));

        return {
          payments,
          hasMore: charges.has_more,
        };
      } catch (error) {
        console.error("❌ Erreur historique paiements:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Impossible de récupérer l'historique",
        });
      }
    }),
});