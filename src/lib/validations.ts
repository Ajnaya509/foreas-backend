import { z } from "zod";

/**
 * Validations Zod pour les formats spécifiques aux plateformes VTC
 * SÉCURITÉ: Empêche les injections et formats invalides
 */

// Formats des IDs chauffeurs par plateforme
export const uberDriverIdSchema = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 
    "Format UUID Uber invalide (ex: 12345678-1234-1234-1234-123456789012)")
  .optional();

export const boltDriverIdSchema = z.string()
  .regex(/^\d{6,10}$/, 
    "Format Bolt invalide (6-10 chiffres)")
  .optional();

export const heetchDriverIdSchema = z.string()
  .regex(/^HTC[A-Z0-9]{3,8}$/i, 
    "Format Heetch invalide (ex: HTC123ABC)")
  .optional();

// Validation du numéro de permis
export const licenseNumberSchema = z.string()
  .regex(/^[A-Z0-9]{8,15}$/, 
    "Numéro de permis invalide (8-15 caractères alphanumériques)")
  .min(8)
  .max(15);

// Validation plaque d'immatriculation française
export const licensePlateSchema = z.string()
  .regex(/^[A-Z]{2}-\d{3}-[A-Z]{2}$|^\d{1,4}\s?[A-Z]{1,3}\s?\d{2}$/, 
    "Format de plaque invalide (ex: AB-123-CD ou 123ABC45)")
  .transform(s => s.replace(/\s/g, '').toUpperCase());

// Validation SIRET
export const siretSchema = z.string()
  .regex(/^\d{14}$/, 
    "SIRET invalide (14 chiffres)")
  .optional();

// Validation numéro de TVA
export const vatNumberSchema = z.string()
  .regex(/^FR\d{2}\d{9}$/, 
    "Numéro de TVA français invalide (ex: FR12345678901)")
  .optional();

// Validation email strict
export const emailSchema = z.string()
  .email("Email invalide")
  .min(5)
  .max(100)
  .toLowerCase();

// Validation téléphone français
export const phoneSchema = z.string()
  .regex(/^(\+33|0)[1-9](\d{8})$/, 
    "Numéro de téléphone français invalide")
  .transform(phone => phone.replace(/\s/g, ''))
  .optional();

// Validation mot de passe sécurisé
export const passwordSchema = z.string()
  .min(8, "8 caractères minimum")
  .max(100, "100 caractères maximum")
  .regex(/[A-Z]/, "Au moins 1 majuscule")
  .regex(/[a-z]/, "Au moins 1 minuscule") 
  .regex(/\d/, "Au moins 1 chiffre")
  .regex(/[^A-Za-z0-9]/, "Au moins 1 caractère spécial");

// Validation prix (en euros)
export const priceSchema = z.number()
  .min(0, "Le prix ne peut pas être négatif")
  .max(1000, "Prix maximum: 1000€")
  .multipleOf(0.01, "2 décimales maximum");

// Validation coordonnées GPS
export const latitudeSchema = z.number()
  .min(-90, "Latitude invalide")
  .max(90, "Latitude invalide");

export const longitudeSchema = z.number()
  .min(-180, "Longitude invalide") 
  .max(180, "Longitude invalide");

// Validation distance en km
export const distanceSchema = z.number()
  .min(0, "Distance ne peut pas être négative")
  .max(1000, "Distance maximum: 1000km");

// Validation durée en minutes
export const durationSchema = z.number()
  .min(1, "Durée minimum: 1 minute")
  .max(1440, "Durée maximum: 24h");

// Validation note (1-5 étoiles)
export const ratingSchema = z.number()
  .min(1, "Note minimum: 1")
  .max(5, "Note maximum: 5")
  .int("La note doit être un entier");

// Validation slug pour site web
export const websiteSlugSchema = z.string()
  .min(3, "3 caractères minimum")
  .max(50, "50 caractères maximum")
  .regex(/^[a-z0-9-]+$/, "Lettres minuscules, chiffres et tirets uniquement")
  .refine(slug => !slug.startsWith('-') && !slug.endsWith('-'), 
    "Ne peut pas commencer ou finir par un tiret")
  .refine(slug => !slug.includes('--'), 
    "Pas de tirets consécutifs");

// Schema complet pour l'inscription chauffeur
export const driverSignUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(2, "2 caractères minimum").max(100),
  phone: phoneSchema,
  licenseNumber: licenseNumberSchema,
  companyName: z.string().min(2).max(100).optional(),
  siret: siretSchema,
  vatNumber: vatNumberSchema,
});

// Schema pour connexion plateformes
export const connectPlatformSchema = z.object({
  platform: z.enum(["UBER", "BOLT", "HEETCH"]),
  platformDriverId: z.string().min(1, "ID plateforme requis"),
}).refine(data => {
  // Validation spécifique selon la plateforme
  switch (data.platform) {
    case "UBER":
      return uberDriverIdSchema.safeParse(data.platformDriverId).success;
    case "BOLT": 
      return boltDriverIdSchema.safeParse(data.platformDriverId).success;
    case "HEETCH":
      return heetchDriverIdSchema.safeParse(data.platformDriverId).success;
    default:
      return false;
  }
}, "Format d'ID invalide pour cette plateforme");

export type ConnectPlatformInput = z.infer<typeof connectPlatformSchema>;
export type DriverSignUpInput = z.infer<typeof driverSignUpSchema>;