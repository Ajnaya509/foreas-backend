// src/lib/langgraph/state.ts
import { Annotation } from '@langchain/langgraph';

/**
 * State partagé entre tous les noeuds du graphe Ajnaya.
 * Chaque agent lit et enrichit ce state.
 */
export const AjnayaState = Annotation.Root({
  // === INPUT (rempli par le Dispatcher) ===
  rawMessage: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  channel: Annotation<string>({ reducer: (_, b) => b, default: () => 'widget_site' }),
  // "widget_site" | "whatsapp" | "in_app" | "push"
  prospectId: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  driverId: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  sessionId: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),

  // === PONT PROSPECT ↔ DRIVER (enrichi par Agent Contexte) ===
  // Canal d'acquisition original avant inscription app
  prospectOriginChannel: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  // Score engagement au moment de la conversion
  prospectScoreAtConversion: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  // Nombre de jours entre première interaction Pieuvre et inscription app
  prospectDaysToConvert: Annotation<number | null>({ reducer: (_, b) => b, default: () => null }),

  // === DISPATCHER OUTPUT ===
  isDriver: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  isSubscriber: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  hasStripeConnect: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  daysSinceSubscription: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),

  // === CONTEXTE (Agent Contexte) ===
  conversationHistory: Annotation<
    Array<{ role: string; content: string; channel: string; created_at: string }>
  >({
    reducer: (_, b) => b,
    default: () => [],
  }),

  // === SIGNAUX (Agent Signaux) ===
  recentEvents: Annotation<Array<Record<string, unknown>>>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  currentZone: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),
  surgeActive: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  lastFare: Annotation<number | null>({ reducer: (_, b) => b, default: () => null }),
  nearbyEvents: Annotation<Array<Record<string, unknown>>>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  gtfsDisruptions: Annotation<Array<Record<string, unknown>>>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  zoneIntelligence: Annotation<Record<string, unknown> | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),

  // === PROFIL (Agent Profil) ===
  profile: Annotation<Record<string, unknown> | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),

  // === PRIVATE HUNTER (Agent Hunter — conditionnel) ===
  hunterResult: Annotation<{ hasPendingClient: boolean; clientPreview: string | null }>({
    reducer: (_, b) => b,
    default: () => ({ hasPendingClient: false, clientPreview: null }),
  }),

  // === PARRAINAGE (Agent Parrainage — conditionnel) ===
  referralResult: Annotation<{
    totalReferrals: number;
    monthlyEarnings: number;
    isGoodMoment: boolean;
  }>({
    reducer: (_, b) => b,
    default: () => ({ totalReferrals: 0, monthlyEarnings: 0, isGoodMoment: false }),
  }),

  // === COMPTA (Agent Compta — conditionnel) ===
  comptaResult: Annotation<{
    monthlyEarnings: number | null;
    projection: number | null;
    vsLastMonth: string | null;
    bestDay: string | null;
    bestZone: string | null;
  } | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),

  // === STRATEGISTE OUTPUT ===
  strategy: Annotation<{
    tone: string;
    priorityInfo: string[];
    ctaType: string | null;
    avoidTopics: string[];
    maxWords: number;
    includeEmoji: boolean;
    rgpdResponse: boolean;
    closingScript: string | null;
  }>({
    reducer: (_, b) => b,
    default: () => ({
      tone: 'empathique',
      priorityInfo: [],
      ctaType: null,
      avoidTopics: [],
      maxWords: 50,
      includeEmoji: true,
      rgpdResponse: false,
      closingScript: null,
    }),
  }),

  // === GENERATEUR OUTPUT ===
  response: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  llmModel: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  llmTokens: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  llmCostUsd: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  sentiment: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),

  // === ERREURS (pour fallback) ===
  errors: Annotation<Array<{ agent: string; error: string }>>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type AjnayaStateType = typeof AjnayaState.State;
