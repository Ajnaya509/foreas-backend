-- ============================================
-- FOREAS DATA PLATFORM V1
-- Migration: 20260201_data_platform.sql
-- ============================================
-- Tables: events, ai_conversations, ai_messages, driver_features, ai_outcomes, documents, document_chunks, audit_logs
-- ============================================

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- 1. EVENTS (Analytics - Append-Only)
-- ============================================
CREATE TABLE IF NOT EXISTS public.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  event_category TEXT NOT NULL DEFAULT 'general',
  actor_id UUID,  -- user/driver/admin id (nullable for anonymous)
  actor_role TEXT CHECK (actor_role IN ('driver', 'partner', 'admin', 'support', 'system', 'anonymous')),
  payload JSONB NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'backend',  -- backend, mobile, web
  session_id TEXT,
  ip_hash TEXT,  -- hashed IP, not raw
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No UPDATE or DELETE allowed via RLS
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- Insert-only policy
CREATE POLICY "events_insert_only" ON public.events
  FOR INSERT WITH CHECK (true);

-- Select for admins only (via service_role)
CREATE POLICY "events_select_admin" ON public.events
  FOR SELECT USING (true);  -- Filtered by service_role

-- Index for querying
CREATE INDEX IF NOT EXISTS idx_events_actor ON public.events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_name ON public.events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_category ON public.events(event_category, created_at DESC);

-- ============================================
-- 2. AI CONVERSATIONS
-- ============================================
CREATE TABLE IF NOT EXISTS public.ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id TEXT,
  context_type TEXT NOT NULL DEFAULT 'recommendation',  -- recommendation, support, onboarding
  features_snapshot_id UUID,  -- link to driver_features snapshot
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd NUMERIC(10, 6) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_driver ON public.ai_conversations(driver_id, created_at DESC);

-- ============================================
-- 3. AI MESSAGES (Conversation Turns)
-- ============================================
CREATE TABLE IF NOT EXISTS public.ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content_redacted TEXT NOT NULL,  -- PII redacted
  content_hash TEXT,  -- SHA256 of original for dedup
  prompt_context_summary TEXT,  -- summary of context used
  rag_chunks_used TEXT[],  -- IDs of RAG chunks retrieved
  model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  provider TEXT NOT NULL DEFAULT 'openai',
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  latency_ms INTEGER,
  cost_usd NUMERIC(10, 6) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON public.ai_messages(conversation_id, created_at);

-- ============================================
-- 4. DRIVER FEATURES (Snapshots)
-- ============================================
CREATE TABLE IF NOT EXISTS public.driver_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_type TEXT NOT NULL DEFAULT 'daily' CHECK (snapshot_type IN ('daily', 'weekly', 'realtime', 'manual')),

  -- Computed features (JSONB for flexibility)
  features JSONB NOT NULL DEFAULT '{}',
  /*
    Expected features structure:
    {
      "total_trips": 150,
      "trips_last_7d": 25,
      "avg_rating": 4.8,
      "acceptance_rate": 0.92,
      "cancellation_rate": 0.03,
      "avg_earnings_per_hour": 18.50,
      "peak_hours": ["08:00", "18:00"],
      "top_zones": ["paris_9", "paris_10"],
      "fatigue_score": 0.2,
      "days_since_last_trip": 1,
      "subscription_status": "active",
      "platforms": ["uber", "heetch"]
    }
  */

  -- Flags for personalization
  flags JSONB NOT NULL DEFAULT '{}',
  /*
    {
      "is_new_driver": false,
      "needs_onboarding": false,
      "high_performer": true,
      "at_risk_churn": false
    }
  */

  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_driver_features_driver ON public.driver_features(driver_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_features_latest ON public.driver_features(driver_id, snapshot_type, computed_at DESC);

-- ============================================
-- 5. AI OUTCOMES (Labels for Training)
-- ============================================
CREATE TABLE IF NOT EXISTS public.ai_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES public.ai_conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.ai_messages(id) ON DELETE SET NULL,
  driver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Recommendation tracking
  action_recommended TEXT NOT NULL,  -- e.g., "go_to_zone_paris_9"
  action_taken TEXT,  -- what user actually did
  action_taken_at TIMESTAMPTZ,

  -- Outcome metrics
  outcome_type TEXT NOT NULL CHECK (outcome_type IN ('accepted', 'rejected', 'ignored', 'partial', 'unknown')),
  delta_metric JSONB,  -- {"earnings_change": 15.00, "time_saved_min": 10}
  confidence NUMERIC(3, 2),  -- 0.00 to 1.00

  -- Feedback
  user_feedback TEXT CHECK (user_feedback IN ('helpful', 'not_helpful', 'neutral', NULL)),
  user_feedback_text TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_outcomes_driver ON public.ai_outcomes(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_outcomes_type ON public.ai_outcomes(outcome_type, created_at DESC);

-- ============================================
-- 6. DOCUMENTS (RAG Source)
-- ============================================
CREATE TABLE IF NOT EXISTS public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('faq', 'policy', 'guide', 'support_script', 'legal', 'training')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,  -- for dedup
  metadata JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_hash ON public.documents(content_hash) WHERE is_active = true;

-- ============================================
-- 7. DOCUMENT CHUNKS (RAG Embeddings)
-- ============================================
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),  -- OpenAI ada-002 dimension
  token_count INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON public.document_chunks(document_id, chunk_index);

-- Vector similarity search index
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON public.document_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================
-- 8. AUDIT LOGS
-- ============================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL,  -- who performed the action
  actor_role TEXT NOT NULL CHECK (actor_role IN ('driver', 'partner', 'admin', 'support', 'system')),
  action TEXT NOT NULL,  -- e.g., "user.suspend", "refund.issue"
  target_type TEXT,  -- e.g., "user", "payment", "subscription"
  target_id UUID,
  details JSONB NOT NULL DEFAULT '{}',  -- action-specific details (redacted)
  ip_hash TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON public.audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON public.audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON public.audit_logs(target_type, target_id, created_at DESC);

-- ============================================
-- 9. USER ROLES (RBAC)
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('driver', 'partner', 'admin', 'support')),
  granted_by UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id) WHERE is_active = true;

-- ============================================
-- 10. DATA CONSENTS (GDPR)
-- ============================================
CREATE TABLE IF NOT EXISTS public.data_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('analytics', 'ai_personalization', 'marketing_sms', 'marketing_email', 'data_sharing')),
  granted BOOLEAN NOT NULL,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, consent_type)
);

CREATE INDEX IF NOT EXISTS idx_consents_user ON public.data_consents(user_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to get latest driver features
CREATE OR REPLACE FUNCTION get_driver_features(p_driver_id UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT features || flags INTO result
  FROM public.driver_features
  WHERE driver_id = p_driver_id
  ORDER BY computed_at DESC
  LIMIT 1;

  RETURN COALESCE(result, '{}'::JSONB);
END;
$$ LANGUAGE plpgsql;

-- Function for RAG similarity search
CREATE OR REPLACE FUNCTION search_documents(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  document_title TEXT,
  content TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id AS chunk_id,
    dc.document_id,
    d.title AS document_title,
    dc.content,
    1 - (dc.embedding <=> query_embedding) AS similarity
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE d.is_active = true
    AND 1 - (dc.embedding <=> query_embedding) > match_threshold
  ORDER BY dc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- RLS POLICIES
-- ============================================

-- Driver features: users can only see their own
ALTER TABLE public.driver_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_features_own" ON public.driver_features
  FOR SELECT USING (auth.uid() = driver_id);

-- AI conversations: users can only see their own
ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_conv_own" ON public.ai_conversations
  FOR ALL USING (auth.uid() = driver_id);

-- AI messages: via conversation ownership
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_msg_own" ON public.ai_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.ai_conversations c
      WHERE c.id = ai_messages.conversation_id
      AND c.driver_id = auth.uid()
    )
  );

-- AI outcomes: users can see their own
ALTER TABLE public.ai_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_outcomes_own" ON public.ai_outcomes
  FOR ALL USING (auth.uid() = driver_id);

-- Data consents: users manage their own
ALTER TABLE public.data_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "consents_own" ON public.data_consents
  FOR ALL USING (auth.uid() = user_id);

-- Audit logs: admin only (via service_role)
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- User roles: read own, admin manages
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "roles_read_own" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);

-- Documents: public read for active
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "documents_read_active" ON public.documents
  FOR SELECT USING (is_active = true);

-- Document chunks: public read
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chunks_read" ON public.document_chunks
  FOR SELECT USING (true);
