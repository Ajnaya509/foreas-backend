/**
 * FOREAS Data Platform V1 - Types
 * ================================
 * Types centralisés pour le data layer
 */

// ============================================
// ENUMS & CONSTANTS
// ============================================

export type ActorRole = 'driver' | 'partner' | 'admin' | 'support' | 'system' | 'anonymous';

export type EventCategory =
  | 'navigation'
  | 'recommendation'
  | 'earnings'
  | 'session'
  | 'support'
  | 'subscription'
  | 'general';

export type ConversationContextType = 'recommendation' | 'support' | 'onboarding';

export type ConversationStatus = 'active' | 'completed' | 'abandoned';

export type MessageRole = 'user' | 'assistant' | 'system';

export type OutcomeType = 'accepted' | 'rejected' | 'ignored' | 'partial' | 'unknown';

export type UserFeedback = 'helpful' | 'not_helpful' | 'neutral';

export type SnapshotType = 'daily' | 'weekly' | 'realtime' | 'manual';

export type DocumentSourceType = 'faq' | 'policy' | 'guide' | 'support_script' | 'legal' | 'training';

export type ConsentType = 'analytics' | 'ai_personalization' | 'marketing_sms' | 'marketing_email' | 'data_sharing';

// ============================================
// EVENT STORE TYPES
// ============================================

export interface EventPayload {
  [key: string]: unknown;
}

export interface TrackEventInput {
  eventName: string;
  eventCategory?: EventCategory;
  actorId?: string;
  actorRole?: ActorRole;
  payload?: EventPayload;
  source?: 'backend' | 'mobile' | 'web';
  sessionId?: string;
  ipHash?: string;
}

export interface Event {
  id: string;
  event_name: string;
  event_category: EventCategory;
  actor_id: string | null;
  actor_role: ActorRole | null;
  payload: EventPayload;
  source: string;
  session_id: string | null;
  ip_hash: string | null;
  created_at: string;
}

// ============================================
// CONVERSATION LOG TYPES
// ============================================

export interface CreateConversationInput {
  driverId: string;
  sessionId?: string;
  contextType?: ConversationContextType;
  featuresSnapshotId?: string;
}

export interface Conversation {
  id: string;
  driver_id: string;
  session_id: string | null;
  context_type: ConversationContextType;
  features_snapshot_id: string | null;
  status: ConversationStatus;
  total_tokens: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface LogMessageInput {
  conversationId: string;
  role: MessageRole;
  contentRedacted: string;
  contentHash?: string;
  promptContextSummary?: string;
  ragChunksUsed?: string[];
  model?: string;
  provider?: string;
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
  costUsd?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content_redacted: string;
  content_hash: string | null;
  prompt_context_summary: string | null;
  rag_chunks_used: string[] | null;
  model: string;
  provider: string;
  tokens_input: number;
  tokens_output: number;
  latency_ms: number | null;
  cost_usd: number;
  created_at: string;
}

// ============================================
// FEATURE STORE TYPES
// ============================================

export interface DriverFeatures {
  // Activity
  total_trips?: number;
  trips_last_7d?: number;
  trips_last_30d?: number;

  // Performance
  avg_rating?: number;
  acceptance_rate?: number;
  cancellation_rate?: number;

  // Earnings
  avg_earnings_per_hour?: number;
  total_earnings_30d?: number;

  // Behavior patterns
  peak_hours?: string[];
  top_zones?: string[];
  preferred_platforms?: string[];

  // Risk indicators
  fatigue_score?: number;
  days_since_last_trip?: number;

  // Subscription
  subscription_status?: string;
  subscription_tier?: string;

  // Custom (extensible)
  [key: string]: unknown;
}

export interface DriverFlags {
  is_new_driver?: boolean;
  needs_onboarding?: boolean;
  high_performer?: boolean;
  at_risk_churn?: boolean;
  needs_attention?: boolean;
  [key: string]: boolean | undefined;
}

export interface DriverFeaturesSnapshot {
  id: string;
  driver_id: string;
  snapshot_type: SnapshotType;
  features: DriverFeatures;
  flags: DriverFlags;
  computed_at: string;
  valid_until: string | null;
  created_at: string;
}

export interface SaveFeaturesInput {
  driverId: string;
  snapshotType?: SnapshotType;
  features: DriverFeatures;
  flags?: DriverFlags;
  validUntil?: Date;
}

// ============================================
// OUTCOMES TYPES
// ============================================

export interface RecordOutcomeInput {
  conversationId?: string;
  messageId?: string;
  driverId: string;
  actionRecommended: string;
  actionTaken?: string;
  actionTakenAt?: Date;
  outcomeType: OutcomeType;
  deltaMetric?: {
    earnings_change?: number;
    time_saved_min?: number;
    [key: string]: number | undefined;
  };
  confidence?: number;
  userFeedback?: UserFeedback;
  userFeedbackText?: string;
}

export interface Outcome {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  driver_id: string;
  action_recommended: string;
  action_taken: string | null;
  action_taken_at: string | null;
  outcome_type: OutcomeType;
  delta_metric: Record<string, number> | null;
  confidence: number | null;
  user_feedback: UserFeedback | null;
  user_feedback_text: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// AUDIT LOG TYPES
// ============================================

export interface LogAuditInput {
  actorId: string;
  actorRole: ActorRole;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipHash?: string;
  userAgent?: string;
}

export interface AuditLog {
  id: string;
  actor_id: string;
  actor_role: ActorRole;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
}

// ============================================
// RAG TYPES
// ============================================

export interface Document {
  id: string;
  title: string;
  source_type: DocumentSourceType;
  content: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  is_active: boolean;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  token_count: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  similarity: number;
}

// ============================================
// DATA CONSENT TYPES
// ============================================

export interface DataConsent {
  id: string;
  user_id: string;
  consent_type: ConsentType;
  granted: boolean;
  granted_at: string | null;
  revoked_at: string | null;
  ip_hash: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// USER ROLE TYPES
// ============================================

export interface UserRole {
  id: string;
  user_id: string;
  role: ActorRole;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  is_active: boolean;
}
