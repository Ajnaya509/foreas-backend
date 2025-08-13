/**
 * tRPC Context - FOREAS Driver Backend
 * Contexte de requête avec extraction de userId et accès à la base de données
 */

import type { Request, Response } from 'express';

import { env } from '@/env';
import { prisma } from '@/server/db';
import { generateCorrelationId } from '@/utils/logger';

/**
 * Type du contexte tRPC
 */
export interface Context {
  userId: string | undefined;
  prisma: typeof prisma;
  req: Request;
  correlationId: string;
}

/**
 * Crée le contexte pour chaque requête tRPC
 */
export function createContext({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Context {
  const userId = extractUserIdFromRequest(req);
  const correlationId = generateCorrelationId();

  return {
    userId,
    prisma,
    req,
    correlationId,
  };
}

/**
 * Extrait l'userId depuis la requête
 * En développement: utilise le header X-Dev-User
 * En production: extrairait depuis JWT/session (à implémenter)
 */
function extractUserIdFromRequest(req: Request): string | undefined {
  // Mode développement: utiliser le header X-Dev-User pour mock
  if (env.NODE_ENV === 'development') {
    const devUserId = req.headers['x-dev-user'] as string | undefined;
    return devUserId;
  }

  // Mode production: TODO - extraire depuis Authorization header (JWT)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    // TODO: Implémenter la vérification JWT en production
    // const token = authHeader.slice(7);
    // const userId = verifyJWT(token);
    // return userId;
  }

  return undefined;
}