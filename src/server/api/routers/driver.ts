import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  driverProcedure,
  publicProcedure,
} from "@/server/api/trpc";
import { Platform, VehicleCategory } from "@prisma/client";

export const driverRouter = createTRPCRouter({
  // Récupérer les stats du chauffeur
  getStats: driverProcedure.query(async ({ ctx }) => {
    const driver = await ctx.prisma.driver.findUnique({
      where: { userId: ctx.session.user.id },
      include: {
        rides: {
          where: {
            completedAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        },
        earnings: {
          where: {
            earnedAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        },
        reviews: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
      },
    });
    
    if (!driver) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Profil chauffeur non trouvé",
      });
    }
    
    // Calculer les stats du jour
    const todayEarnings = driver.earnings.reduce((sum, e) => sum + e.amount, 0);
    const todayRides = driver.rides.length;
    const todayDistance = driver.rides.reduce((sum, r) => sum + r.distance, 0);
    
    // Récupérer les stats de la semaine
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);
    
    const weekStats = await ctx.prisma.earning.groupBy({
      by: ["earnedAt"],
      where: {
        driverId: driver.id,
        earnedAt: { gte: weekStart },
      },
      _sum: { amount: true },
    });
    
    return {
      today: {
        earnings: todayEarnings,
        rides: todayRides,
        distance: todayDistance,
      },
      week: weekStats,
      total: {
        earnings: driver.totalEarnings,
        rides: driver.totalRides,
        rating: driver.averageRating,
      },
      recentReviews: driver.reviews,
    };
  }),
  
  // Connecter une plateforme VTC
  connectPlatform: driverProcedure
    .input(
      z.object({
        platform: z.nativeEnum(Platform),
        platformDriverId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
      });
      
      if (!driver) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profil chauffeur non trouvé",
        });
      }
      
      // Mettre à jour l'ID de la plateforme
      const updateData: any = {};
      switch (input.platform) {
        case "UBER":
          updateData.uberDriverId = input.platformDriverId;
          break;
        case "BOLT":
          updateData.boltDriverId = input.platformDriverId;
          break;
        case "HEETCH":
          updateData.heetchDriverId = input.platformDriverId;
          break;
      }
      
      return await ctx.prisma.driver.update({
        where: { id: driver.id },
        data: updateData,
      });
    }),
  
  // Ajouter/Modifier un véhicule
  setVehicle: driverProcedure
    .input(
      z.object({
        brand: z.string(),
        model: z.string(),
        year: z.number().min(2000).max(new Date().getFullYear() + 1),
        color: z.string(),
        licensePlate: z.string(),
        seats: z.number().min(1).max(9),
        category: z.nativeEnum(VehicleCategory),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
      });
      
      if (!driver) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profil chauffeur non trouvé",
        });
      }
      
      // Créer ou mettre à jour le véhicule
      const vehicle = await ctx.prisma.vehicle.upsert({
        where: { licensePlate: input.licensePlate },
        update: input,
        create: input,
      });
      
      // Associer le véhicule au chauffeur
      await ctx.prisma.driver.update({
        where: { id: driver.id },
        data: { vehicleId: vehicle.id },
      });
      
      return vehicle;
    }),
  
  // Configurer le site personnel
  setupWebsite: driverProcedure
    .input(
      z.object({
        websiteSlug: z.string()
          .min(3)
          .max(50)
          .regex(/^[a-z0-9-]+$/, "Slug invalide (lettres minuscules, chiffres et tirets uniquement)"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
      });
      
      if (!driver) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profil chauffeur non trouvé",
        });
      }
      
      // Vérifier que le slug n'est pas déjà pris
      const existingSlug = await ctx.prisma.driver.findUnique({
        where: { websiteSlug: input.websiteSlug },
      });
      
      if (existingSlug && existingSlug.id !== driver.id) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Ce nom de site est déjà pris",
        });
      }
      
      // Mettre à jour le slug et l'URL du site
      const personalWebsite = `https://foreas.app/${input.websiteSlug}`;
      
      return await ctx.prisma.driver.update({
        where: { id: driver.id },
        data: {
          websiteSlug: input.websiteSlug,
          personalWebsite,
        },
      });
    }),
  
  // Récupérer les disponibilités
  getAvailability: driverProcedure.query(async ({ ctx }) => {
    const driver = await ctx.prisma.driver.findUnique({
      where: { userId: ctx.session.user.id },
    });
    
    if (!driver) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Profil chauffeur non trouvé",
      });
    }
    
    return await ctx.prisma.availability.findMany({
      where: { driverId: driver.id },
      orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    });
  }),
  
  // Mettre à jour les disponibilités
  setAvailability: driverProcedure
    .input(
      z.array(
        z.object({
          dayOfWeek: z.number().min(0).max(6),
          startTime: z.string().regex(/^\d{2}:\d{2}$/),
          endTime: z.string().regex(/^\d{2}:\d{2}$/),
          isActive: z.boolean(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { userId: ctx.session.user.id },
      });
      
      if (!driver) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profil chauffeur non trouvé",
        });
      }
      
      // Supprimer les anciennes disponibilités
      await ctx.prisma.availability.deleteMany({
        where: { driverId: driver.id },
      });
      
      // Créer les nouvelles
      const availabilities = await ctx.prisma.availability.createMany({
        data: input.map(slot => ({
          ...slot,
          driverId: driver.id,
        })),
      });
      
      return availabilities;
    }),
  
  // Page publique du chauffeur (pour les clients)
  getPublicProfile: publicProcedure
    .input(z.object({ websiteSlug: z.string() }))
    .query(async ({ ctx, input }) => {
      const driver = await ctx.prisma.driver.findUnique({
        where: { websiteSlug: input.websiteSlug },
        include: {
          user: {
            select: {
              name: true,
              avatar: true,
            },
          },
          vehicle: true,
          reviews: {
            where: { rating: { gte: 4 } },
            take: 5,
            orderBy: { createdAt: "desc" },
          },
          availability: {
            where: { isActive: true },
            orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
          },
        },
      });
      
      if (!driver) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Chauffeur non trouvé",
        });
      }
      
      return {
        name: driver.user.name,
        avatar: driver.user.avatar,
        companyName: driver.companyName,
        vehicle: driver.vehicle,
        rating: driver.averageRating,
        totalRides: driver.totalRides,
        reviews: driver.reviews,
        availability: driver.availability,
      };
    }),
});