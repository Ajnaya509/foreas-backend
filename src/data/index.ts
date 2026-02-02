/**
 * FOREAS Data Platform V1 - Module Index
 * ======================================
 * Centralized exports for the data layer.
 */

// Types
export * from './types';

// Event Store
export {
  trackEvent,
  trackEventAsync,
  queryEvents,
  countEvents,
  trackNavigation,
  trackRecommendationShown,
  trackSessionStart,
  trackSessionEnd,
  trackAIInteraction,
} from './eventStore';

// Conversation Log
export {
  createConversation,
  getConversation,
  updateConversationStatus,
  getDriverConversations,
  logMessage,
  getConversationMessages,
  buildMessageHistory,
  getDriverConversationStats,
} from './conversationLog';

// Feature Store
export {
  getDriverFeatures,
  getDriverContext,
  saveFeatures,
  computeDriverFeatures,
  computeDriverFlags,
  refreshDriverFeatures,
  getFeatureHistory,
  buildContextSummary,
} from './featureStore';

// Outcomes
export {
  recordOutcome,
  recordOutcomeAsync,
  updateOutcomeAction,
  addOutcomeFeedback,
  queryOutcomes,
  getDriverOutcomes,
  getOutcome,
  getOutcomeStats,
  getDeltaMetricsSummary,
  recordNavigationOutcome,
  recordZoneOutcome,
} from './outcomes';

// Audit Log
export {
  logAudit,
  logAuditAsync,
  queryAuditLogs,
  getTargetAuditLogs,
  getActorAuditLogs,
  logUserAction,
  logAdminUserAction,
  logSupportAction,
  logSystemAction,
  AUDIT_ACTIONS,
} from './auditLog';

export type { AuditAction } from './auditLog';
export type { EventQueryOptions } from './eventStore';
export type { OutcomeQueryOptions, OutcomeStats } from './outcomes';
export type { AuditQueryOptions } from './auditLog';
