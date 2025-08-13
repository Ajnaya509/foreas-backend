import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  publicProcedure,
  protectedProcedure,
} from "@/server/api/trpc";
import { env } from "@/env";

export const authRouter = createTRPCRouter({
  // Inscription chauffeur
  signUp: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(2),
        phone: z.string().optional(),
        licenseNumber: z.string().min(5),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { email, password, name, phone, licenseNumber } = input;
      
      // Vérifier si l'utilisateur existe déjà
      const existingUser = await ctx.prisma.user.findUnique({
        where: { email },
      });
      
      if (existingUser) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Un compte existe déjà avec cet email",
        });
      }
      
      // Vérifier si le numéro de licence existe déjà
      const existingLicense = await ctx.prisma.driver.findUnique({
        where: { licenseNumber },
      });
      
      if (existingLicense) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Ce numéro de licence est déjà enregistré",
        });
      }
      
      // Hasher le mot de passe
      const hashedPassword = await bcrypt.hash(password, 12);
      
      // Créer l'utilisateur et le profil chauffeur
      const user = await ctx.prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          phone,
          role: "DRIVER",
          driver: {
            create: {
              licenseNumber,
            },
          },
        },
        include: {
          driver: true,
        },
      });
      
      // Générer un token JWT
      const token = jwt.sign(
        { userId: user.id, email: user.email },
        env.NEXTAUTH_SECRET,
        { expiresIn: "7d" }
      );
      
      // Créer une session
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      
      await ctx.prisma.session.create({
        data: {
          userId: user.id,
          token,
          expiresAt,
        },
      });
      
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          driver: user.driver,
        },
        token,
      };
    }),
  
  // Connexion
  signIn: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { email, password } = input;
      
      // Récupérer l'utilisateur
      const user = await ctx.prisma.user.findUnique({
        where: { email },
        include: {
          driver: true,
        },
      });
      
      if (!user || !user.password) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Email ou mot de passe incorrect",
        });
      }
      
      // Vérifier le mot de passe
      const isValidPassword = await bcrypt.compare(password, user.password);
      
      if (!isValidPassword) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Email ou mot de passe incorrect",
        });
      }
      
      // Mettre à jour lastLoginAt
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      
      // Générer un token JWT
      const token = jwt.sign(
        { userId: user.id, email: user.email },
        env.NEXTAUTH_SECRET,
        { expiresIn: "7d" }
      );
      
      // Créer une session
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      
      await ctx.prisma.session.create({
        data: {
          userId: user.id,
          token,
          expiresAt,
        },
      });
      
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          driver: user.driver,
        },
        token,
      };
    }),
  
  // Récupérer le profil utilisateur
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUnique({
      where: { id: ctx.session.user.id },
      include: {
        driver: {
          include: {
            vehicle: true,
            _count: {
              select: {
                rides: true,
                bookings: true,
                reviews: true,
              },
            },
          },
        },
      },
    });
    
    if (!user) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Utilisateur non trouvé",
      });
    }
    
    return user;
  }),
  
  // Mettre à jour le profil
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().optional(),
        phone: z.string().optional(),
        avatar: z.string().optional(),
        companyName: z.string().optional(),
        siret: z.string().optional(),
        vatNumber: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { companyName, siret, vatNumber, ...userFields } = input;
      
      // Mettre à jour l'utilisateur
      const user = await ctx.prisma.user.update({
        where: { id: ctx.session.user.id },
        data: userFields,
        include: {
          driver: true,
        },
      });
      
      // Si c'est un chauffeur, mettre à jour ses infos business
      if (user.driver && (companyName || siret || vatNumber)) {
        await ctx.prisma.driver.update({
          where: { id: user.driver.id },
          data: {
            companyName,
            siret,
            vatNumber,
          },
        });
      }
      
      return user;
    }),
  
  // Déconnexion
  signOut: protectedProcedure.mutation(async ({ ctx }) => {
    // Supprimer toutes les sessions de l'utilisateur
    await ctx.prisma.session.deleteMany({
      where: { userId: ctx.session.user.id },
    });
    
    return { success: true };
  }),
  
  // Vérifier un token
  verifyToken: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        // Vérifier le token JWT
        const decoded = jwt.verify(input.token, env.NEXTAUTH_SECRET) as {
          userId: string;
          email: string;
        };
        
        // Vérifier que la session existe
        const session = await ctx.prisma.session.findUnique({
          where: { token: input.token },
          include: {
            user: {
              include: {
                driver: true,
              },
            },
          },
        });
        
        if (!session || session.expiresAt < new Date()) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Session expirée",
          });
        }
        
        return {
          valid: true,
          user: session.user,
        };
      } catch (error) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Token invalide",
        });
      }
    }),
});