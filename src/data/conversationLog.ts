/**
 * FOREAS Data Platform V1 - Conversation Log
 * ==========================================
 * LLM conversation traceability with PII redaction.
 * Tables: public.ai_conversations, public.ai_messages
 *
 * RÈGLES:
 * - Tous les contenus sont REDACTÉS avant stockage
 * - Tracking tokens/coûts pour monitoring
 * - Références aux chunks RAG utilisés
 */

import { createHash } from 'crypto';
import { getSupabaseAdmin } from '../helpers/supabase';
import type {
  CreateConversationInput,
  Conversation,
  LogMessageInput,
  Message,
  ConversationStatus,
  MessageRole,
} from './types';

// ============================================
// PII REDACTION
// ============================================

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Phone numbers
  { pattern: /(\+33|0033|0)[1-9](\s?\d{2}){4}/g, replacement: '[PHONE]' },
  { pattern: /\+\d{1,3}\s?\d{6,14}/g, replacement: '[PHONE]' },
  // Email
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  // Names (common French patterns)
  { pattern: /\b[A-Z][a-zéèêëàâäùûüôöîïç]+\s+[A-Z][A-Zéèêëàâäùûüôöîïç]+\b/g, replacement: '[NAME]' },
  // Addresses
  { pattern: /\d{1,4}\s+(rue|avenue|boulevard|place|impasse|allée)\s+[^,\n]+/gi, replacement: '[ADDRESS]' },
  // Credit cards
  { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, replacement: '[CARD]' },
  // French SSN
  { pattern: /[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}/g, replacement: '[SSN]' },
];

function redactPII(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ============================================
// CONVERSATION MANAGEMENT
// ============================================

/**
 * Create a new AI conversation
 */
export async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('ai_conversations')
    .insert({
      driver_id: input.driverId,
      session_id: input.sessionId || null,
      context_type: input.contextType || 'recommendation',
      features_snapshot_id: input.featuresSnapshotId || null,
      status: 'active',
      total_tokens: 0,
      total_cost_usd: 0,
    })
    .select()
    .single();

  if (error) {
    console.error('[ConversationLog] Create failed:', error.message);
    throw new Error(`Failed to create conversation: ${error.message}`);
  }

  console.log(`[ConversationLog] Created conversation: ${data.id}`);
  return data as Conversation;
}

/**
 * Get conversation by ID
 */
export async function getConversation(conversationId: string): Promise<Conversation | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('ai_conversations')
    .select()
    .eq('id', conversationId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    console.error('[ConversationLog] Get failed:', error.message);
    throw new Error(`Failed to get conversation: ${error.message}`);
  }

  return data as Conversation;
}

/**
 * Update conversation status
 */
export async function updateConversationStatus(
  conversationId: string,
  status: ConversationStatus
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (status === 'completed' || status === 'abandoned') {
    updateData.ended_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from('ai_conversations')
    .update(updateData)
    .eq('id', conversationId);

  if (error) {
    console.error('[ConversationLog] Update status failed:', error.message);
    throw new Error(`Failed to update conversation status: ${error.message}`);
  }

  console.log(`[ConversationLog] Updated ${conversationId} status to: ${status}`);
}

/**
 * Get conversations for a driver
 */
export async function getDriverConversations(
  driverId: string,
  options: { limit?: number; status?: ConversationStatus } = {}
): Promise<Conversation[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('ai_conversations')
    .select()
    .eq('driver_id', driverId)
    .order('created_at', { ascending: false });

  if (options.status) {
    query = query.eq('status', options.status);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[ConversationLog] Get driver conversations failed:', error.message);
    throw new Error(`Failed to get driver conversations: ${error.message}`);
  }

  return data as Conversation[];
}

// ============================================
// MESSAGE LOGGING
// ============================================

/**
 * Log a message in a conversation (with PII redaction)
 */
export async function logMessage(input: LogMessageInput): Promise<Message> {
  const supabase = getSupabaseAdmin();

  // Redact PII from content
  const contentRedacted = redactPII(input.contentRedacted);
  const contentHash = input.contentHash || hashContent(input.contentRedacted);

  const messageData = {
    conversation_id: input.conversationId,
    role: input.role,
    content_redacted: contentRedacted,
    content_hash: contentHash,
    prompt_context_summary: input.promptContextSummary || null,
    rag_chunks_used: input.ragChunksUsed || null,
    model: input.model || 'gpt-4o-mini',
    provider: input.provider || 'openai',
    tokens_input: input.tokensInput || 0,
    tokens_output: input.tokensOutput || 0,
    latency_ms: input.latencyMs || null,
    cost_usd: input.costUsd || 0,
  };

  const { data, error } = await supabase
    .from('ai_messages')
    .insert(messageData)
    .select()
    .single();

  if (error) {
    console.error('[ConversationLog] Log message failed:', error.message);
    throw new Error(`Failed to log message: ${error.message}`);
  }

  // Update conversation totals
  await updateConversationTotals(
    input.conversationId,
    (input.tokensInput || 0) + (input.tokensOutput || 0),
    input.costUsd || 0
  );

  console.log(`[ConversationLog] Logged ${input.role} message in ${input.conversationId}`);
  return data as Message;
}

/**
 * Update conversation token and cost totals
 */
async function updateConversationTotals(
  conversationId: string,
  tokens: number,
  cost: number
): Promise<void> {
  const supabase = getSupabaseAdmin();

  // Use RPC for atomic increment (or raw SQL if needed)
  // For now, fetch and update (not ideal but simple)
  const { data: conv } = await supabase
    .from('ai_conversations')
    .select('total_tokens, total_cost_usd')
    .eq('id', conversationId)
    .single();

  if (conv) {
    await supabase
      .from('ai_conversations')
      .update({
        total_tokens: (conv.total_tokens || 0) + tokens,
        total_cost_usd: (conv.total_cost_usd || 0) + cost,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);
  }
}

/**
 * Get messages for a conversation
 */
export async function getConversationMessages(
  conversationId: string,
  options: { limit?: number; role?: MessageRole } = {}
): Promise<Message[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('ai_messages')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (options.role) {
    query = query.eq('role', options.role);
  }

  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[ConversationLog] Get messages failed:', error.message);
    throw new Error(`Failed to get messages: ${error.message}`);
  }

  return data as Message[];
}

// ============================================
// CONVERSATION CONTEXT BUILDER
// ============================================

/**
 * Build message history for LLM context (last N messages)
 */
export async function buildMessageHistory(
  conversationId: string,
  maxMessages = 10
): Promise<Array<{ role: MessageRole; content: string }>> {
  const messages = await getConversationMessages(conversationId, { limit: maxMessages });

  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content_redacted,
  }));
}

// ============================================
// ANALYTICS HELPERS
// ============================================

/**
 * Get conversation stats for a driver
 */
export async function getDriverConversationStats(driverId: string): Promise<{
  totalConversations: number;
  totalTokens: number;
  totalCostUsd: number;
  avgTokensPerConversation: number;
}> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('ai_conversations')
    .select('total_tokens, total_cost_usd')
    .eq('driver_id', driverId);

  if (error) {
    console.error('[ConversationLog] Get stats failed:', error.message);
    throw new Error(`Failed to get conversation stats: ${error.message}`);
  }

  const totalConversations = data.length;
  const totalTokens = data.reduce((sum, c) => sum + (c.total_tokens || 0), 0);
  const totalCostUsd = data.reduce((sum, c) => sum + (c.total_cost_usd || 0), 0);
  const avgTokensPerConversation = totalConversations > 0 ? totalTokens / totalConversations : 0;

  return {
    totalConversations,
    totalTokens,
    totalCostUsd,
    avgTokensPerConversation,
  };
}
