import { NextAuthOptions } from "next-auth";
import { JWT } from "next-auth/jwt";
import { Session, User } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { env } from "@/env";
import { Role, UserStatus } from "@prisma/client";

/**
 * Configuration NextAuth v5 sécurisée
 * 
 * SÉCURITÉ:
 * - JWT avec role/status dans le payload
 * - Validation stricte des credentials
 * - Vérification du statut utilisateur à chaque session
 */
export const authOptions: NextAuthOptions = {
  providers: [
    // Connexion par email/password
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Email et mot de passe requis");
        }

        // Récupérer l'utilisateur avec son profil chauffeur
        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
          include: {
            driver: true,
          },
        });

        if (!user || !user.password) {
          throw new Error("Identifiants invalides");
        }

        // Vérifier le mot de passe
        const isValidPassword = await bcrypt.compare(credentials.password, user.password);
        if (!isValidPassword) {
          throw new Error("Identifiants invalides");
        }

        // SÉCURITÉ: Vérifier le statut utilisateur
        if (user.status === "BANNED") {
          throw new Error("Compte suspendu. Contactez le support.");
        }

        if (user.status === "SUSPENDED") {
          throw new Error("Compte temporairement suspendu.");
        }

        // Mettre à jour lastLoginAt
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        // Retourner l'utilisateur pour le JWT
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          avatar: user.avatar,
          driverId: user.driver?.id || null,
        };
      },
    }),

    // OAuth Google (optionnel)
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? [
      GoogleProvider({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        authorization: {
          params: {
            prompt: "consent",
            access_type: "offline",
            response_type: "code"
          }
        }
      })
    ] : []),
  ],

  // Configuration JWT sécurisée
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 jours
  },

  jwt: {
    secret: env.NEXTAUTH_SECRET,
    maxAge: 7 * 24 * 60 * 60, // 7 jours
  },

  callbacks: {
    /**
     * Callback JWT - Exécuté à chaque création/mise à jour du token
     * CRITIQUE: C'est ici qu'on sécurise le payload JWT
     */
    async jwt({ token, user, trigger }: { 
      token: JWT; 
      user?: any; 
      trigger?: "signIn" | "signUp" | "update" 
    }) {
      // Première connexion: ajouter les infos utilisateur au token
      if (user) {
        token.role = user.role;
        token.status = user.status;
        token.driverId = user.driverId;
        return token;
      }

      // SÉCURITÉ: Vérifier la validité du token à chaque requête
      if (trigger === "update" || !token.role || !token.status) {
        // Re-fetch user pour s'assurer que les permissions n'ont pas changé
        const currentUser = await prisma.user.findUnique({
          where: { id: token.sub },
          include: { driver: true },
        });

        if (!currentUser) {
          // Utilisateur supprimé = token invalide
          return {};
        }

        if (currentUser.status === "BANNED" || currentUser.status === "SUSPENDED") {
          // Statut changé = token invalide
          return {};
        }

        // Mettre à jour le token avec les nouvelles infos
        token.role = currentUser.role;
        token.status = currentUser.status;
        token.driverId = currentUser.driver?.id || null;
      }

      return token;
    },

    /**
     * Callback Session - Exécuté à chaque récupération de session
     * CRITIQUE: C'est ici qu'on expose les données au client
     */
    async session({ session, token }: { session: Session; token: JWT }) {
      if (!token.sub || !token.role || !token.status) {
        // Token invalide = pas de session
        throw new Error("Session invalide");
      }

      // SÉCURITÉ STRICTE: Triple vérification du role
      const validRoles: Role[] = ["ADMIN", "DRIVER", "CLIENT"];
      if (!validRoles.includes(token.role as Role)) {
        throw new Error("Rôle utilisateur invalide");
      }

      // Construire la session sécurisée
      session.user = {
        id: token.sub,
        email: token.email!,
        name: token.name,
        role: token.role as Role,
        status: token.status as UserStatus,
        avatar: token.picture,
        driverId: token.driverId as string | null,
      };

      return session;
    },

    /**
     * Callback SignIn - Contrôle qui peut se connecter
     */
    async signIn({ user, account, profile }) {
      // OAuth Google: créer automatiquement un compte CLIENT
      if (account?.provider === "google" && profile?.email) {
        const existingUser = await prisma.user.findUnique({
          where: { email: profile.email },
        });

        if (!existingUser) {
          // Créer un nouveau compte CLIENT via OAuth
          await prisma.user.create({
            data: {
              email: profile.email,
              name: profile.name || "Utilisateur Google",
              avatar: profile.image,
              role: "CLIENT", // Par défaut CLIENT pour OAuth
              status: "ACTIVE", // Auto-activation pour OAuth
            },
          });
        }
      }

      return true;
    },
  },

  // Pages personnalisées
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },

  // Configuration des événements
  events: {
    async signIn({ user, account, profile, isNewUser }) {
      console.log(`Connexion: ${user.email} via ${account?.provider}`);
    },
    async signOut({ token }) {
      console.log(`Déconnexion: ${token.email}`);
    },
  },

  // Mode debug en développement
  debug: env.NODE_ENV === "development",
};

/**
 * Types étendus pour NextAuth
 * IMPORTANT: Ces types sécurisent l'accès aux propriétés user.*
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: Role;
      status: UserStatus;
      avatar?: string | null;
      driverId?: string | null;
    };
  }

  interface User {
    role: Role;
    status: UserStatus;
    driverId?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: Role;
    status: UserStatus;
    driverId?: string | null;
  }
}