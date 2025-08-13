import { initTRPC, TRPCError } from "@trpc/server";
import { type CreateNextContextOptions } from "@trpc/server/adapters/next";
import { type Session } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

interface CreateContextOptions {
  session: Session | null;
}

const createInnerTRPCContext = (opts: CreateContextOptions) => {
  return {
    session: opts.session,
    prisma,
  };
};

/**
 * Crée le contexte pour chaque requête tRPC
 * Ce contexte contient la session utilisateur et l'accès à la DB
 */
export const createTRPCContext = async (opts: CreateNextContextOptions) => {
  const { req, res } = opts;
  
  // Récupération sécurisée de la session
  const session = await getServerSession(req, res, authOptions);
  
  return createInnerTRPCContext({
    session,
  });
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;

export const publicProcedure = t.procedure;

/**
 * Middleware: Vérifie que l'utilisateur est connecté ET valide
 * SÉCURITÉ CRITIQUE: Validation stricte de tous les champs obligatoires
 */
const enforceUserIsAuthed = t.middleware(({ ctx, next }) => {
  // Vérification existence session
  if (!ctx.session?.user) {
    throw new TRPCError({ 
      code: "UNAUTHORIZED",
      message: "Vous devez être connecté pour accéder à cette ressource"
    });
  }

  const user = ctx.session.user;
  
  // SÉCURITÉ ABSOLUE: Vérification stricte de TOUS les champs critiques
  if (!user.id || 
      !user.email || 
      !user.role || 
      !user.status ||
      typeof user.id !== "string" ||
      typeof user.email !== "string" ||
      typeof user.role !== "string" ||
      typeof user.status !== "string") {
    
    throw new TRPCError({
      code: "FORBIDDEN", 
      message: "Session utilisateur corrompue - reconnectez-vous"
    });
  }

  // Vérification que le rôle est valide
  const validRoles = ["ADMIN", "DRIVER", "CLIENT"];
  if (!validRoles.includes(user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Rôle utilisateur non reconnu"
    });
  }

  // Vérification du statut utilisateur
  if (user.status === "BANNED") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Compte suspendu définitivement"
    });
  }

  if (user.status === "SUSPENDED") {
    throw new TRPCError({
      code: "FORBIDDEN", 
      message: "Compte temporairement suspendu"
    });
  }

  if (user.status === "PENDING") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Compte en attente de validation"
    });
  }

  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

export const protectedProcedure = t.procedure.use(enforceUserIsAuthed);

/**
 * Middleware: Vérifie que l'utilisateur est un CHAUFFEUR
 * Utilisé par driverProcedure pour les fonctions réservées aux chauffeurs
 * 
 * ATTENTION: Vérifie que le role existe ET qu'il est DRIVER
 */
const enforceUserIsDriver = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  
  // SÉCURITÉ: Vérifier explicitement le role
  if (!ctx.session.user.role || ctx.session.user.role !== "DRIVER") {
    throw new TRPCError({ 
      code: "FORBIDDEN",
      message: "Accès réservé aux chauffeurs VTC" 
    });
  }
  
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

export const driverProcedure = t.procedure.use(enforceUserIsDriver);

/**
 * Middleware: Vérifie que l'utilisateur est un ADMIN
 * Utilisé par adminProcedure pour les fonctions d'administration
 * 
 * CRITIQUE: Accès total au système - À PROTÉGER ABSOLUMENT
 */
const enforceUserIsAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  
  // SÉCURITÉ MAXIMALE: Triple vérification pour les admins
  if (!ctx.session.user.role || 
      ctx.session.user.role !== "ADMIN" ||
      !ctx.session.user.id) {
    throw new TRPCError({ 
      code: "FORBIDDEN",
      message: "Accès strictement réservé aux administrateurs FOREAS" 
    });
  }
  
  // TODO: Ajouter vérification IP whitelist pour admins
  // TODO: Ajouter 2FA obligatoire pour admins
  
  return next({
    ctx: {
      session: { ...ctx.session, user: ctx.session.user },
    },
  });
});

export const adminProcedure = t.procedure.use(enforceUserIsAdmin);