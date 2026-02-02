/**
 * FOREAS AI Platform V1 - RAG Retriever
 * ======================================
 * Semantic search and retrieval for RAG pipeline.
 * Uses pgvector for similarity search.
 */

import { getSupabaseAdmin } from '../../helpers/supabase';
import { getOpenAIClient } from '../llm/providers/OpenAIClient';
import type { SearchResult, DocumentSourceType } from '../../data/types';

// ============================================
// CONFIGURATION
// ============================================

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_MAX_RESULTS = 5;
const EMBEDDING_MODEL = 'text-embedding-3-small';

// ============================================
// SEARCH FUNCTIONS
// ============================================

export interface SearchOptions {
  maxResults?: number;
  threshold?: number;
  sourceTypes?: DocumentSourceType[];
  rerank?: boolean;
}

/**
 * Search documents by semantic similarity
 */
export async function searchDocuments(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const supabase = getSupabaseAdmin();
  const openai = getOpenAIClient();

  const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
  const threshold = options.threshold || DEFAULT_SIMILARITY_THRESHOLD;

  // Check if OpenAI is configured
  if (!openai.isConfigured()) {
    console.warn('[RAG Retriever] OpenAI not configured, falling back to text search');
    return textSearch(query, maxResults);
  }

  // Generate query embedding
  let queryEmbedding: number[];
  try {
    const response = await openai.embed({
      input: query,
      model: EMBEDDING_MODEL,
    });
    queryEmbedding = response.embeddings[0];
  } catch (err) {
    console.error('[RAG Retriever] Embedding generation failed:', err);
    return textSearch(query, maxResults);
  }

  // Use the search_documents function defined in migration
  const { data, error } = await supabase.rpc('search_documents', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: maxResults,
  });

  if (error) {
    console.error('[RAG Retriever] Search failed:', error.message);
    // Fallback to text search
    return textSearch(query, maxResults);
  }

  let results = (data || []) as SearchResult[];

  // Filter by source types if specified
  if (options.sourceTypes?.length) {
    const validDocIds = await getDocumentsBySourceType(options.sourceTypes);
    results = results.filter((r) => validDocIds.has(r.document_id));
  }

  console.log(
    `[RAG Retriever] Found ${results.length} results for query: "${query.substring(0, 50)}..."`
  );

  return results;
}

/**
 * Fallback text search when embeddings unavailable
 */
async function textSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const supabase = getSupabaseAdmin();

  // Simple text match search
  const { data, error } = await supabase
    .from('document_chunks')
    .select(
      `
      id,
      document_id,
      content,
      documents!inner(title, is_active)
    `
    )
    .eq('documents.is_active', true)
    .ilike('content', `%${query}%`)
    .limit(maxResults);

  if (error) {
    console.error('[RAG Retriever] Text search failed:', error.message);
    return [];
  }

  return (data || []).map((row: any) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    document_title: row.documents?.title || 'Unknown',
    content: row.content,
    similarity: 0.5, // Arbitrary score for text match
  }));
}

/**
 * Get document IDs by source type
 */
async function getDocumentsBySourceType(
  sourceTypes: DocumentSourceType[]
): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();

  const { data } = await supabase
    .from('documents')
    .select('id')
    .eq('is_active', true)
    .in('source_type', sourceTypes);

  return new Set((data || []).map((d: any) => d.id));
}

// ============================================
// CONTEXT BUILDING
// ============================================

/**
 * Build RAG context from search results
 */
export function buildContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const contextParts = results.map((r, i) => {
    return `[Source ${i + 1}: ${r.document_title}]\n${r.content}`;
  });

  return contextParts.join('\n\n---\n\n');
}

/**
 * Build RAG prompt with context
 */
export function buildRAGPrompt(
  query: string,
  results: SearchResult[],
  systemPrompt?: string
): string {
  const context = buildContext(results);

  if (!context) {
    return query;
  }

  const ragSystemPrompt =
    systemPrompt ||
    `Tu es un assistant IA spécialisé pour les chauffeurs VTC.
Utilise le contexte fourni pour répondre aux questions de manière précise et utile.
Si le contexte ne contient pas d'information pertinente, dis-le clairement.`;

  return `${ragSystemPrompt}

## Contexte (Documents de référence)

${context}

## Question

${query}

## Instructions

Réponds en français de manière claire et concise.
Cite les sources si tu utilises des informations du contexte.`;
}

// ============================================
// SPECIALIZED SEARCHES
// ============================================

/**
 * Search FAQs only
 */
export async function searchFAQs(
  query: string,
  maxResults = 3
): Promise<SearchResult[]> {
  return searchDocuments(query, {
    maxResults,
    sourceTypes: ['faq'],
    threshold: 0.65, // Lower threshold for FAQs
  });
}

/**
 * Search support scripts
 */
export async function searchSupportScripts(
  query: string,
  maxResults = 3
): Promise<SearchResult[]> {
  return searchDocuments(query, {
    maxResults,
    sourceTypes: ['support_script'],
    threshold: 0.7,
  });
}

/**
 * Search guides and policies
 */
export async function searchGuidesAndPolicies(
  query: string,
  maxResults = 3
): Promise<SearchResult[]> {
  return searchDocuments(query, {
    maxResults,
    sourceTypes: ['guide', 'policy', 'legal'],
    threshold: 0.7,
  });
}

// ============================================
// HYBRID SEARCH
// ============================================

/**
 * Hybrid search combining semantic + keyword
 */
export async function hybridSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;

  // Run both searches in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    searchDocuments(query, { ...options, maxResults }),
    textSearch(query, maxResults),
  ]);

  // Merge and deduplicate
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  // Semantic results first (higher quality)
  for (const result of semanticResults) {
    if (!seen.has(result.chunk_id)) {
      seen.add(result.chunk_id);
      merged.push(result);
    }
  }

  // Add keyword results not in semantic
  for (const result of keywordResults) {
    if (!seen.has(result.chunk_id)) {
      seen.add(result.chunk_id);
      // Boost score slightly for keyword match
      merged.push({ ...result, similarity: result.similarity + 0.1 });
    }
  }

  // Sort by similarity and limit
  return merged
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

// ============================================
// ANALYTICS
// ============================================

/**
 * Get chunk by ID (for logging/tracking)
 */
export async function getChunkById(chunkId: string): Promise<SearchResult | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('document_chunks')
    .select(
      `
      id,
      document_id,
      content,
      documents!inner(title)
    `
    )
    .eq('id', chunkId)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    chunk_id: data.id,
    document_id: data.document_id,
    document_title: (data as any).documents?.title || 'Unknown',
    content: data.content,
    similarity: 1.0,
  };
}

/**
 * Get multiple chunks by IDs
 */
export async function getChunksByIds(chunkIds: string[]): Promise<SearchResult[]> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('document_chunks')
    .select(
      `
      id,
      document_id,
      content,
      documents!inner(title)
    `
    )
    .in('id', chunkIds);

  if (error || !data) {
    return [];
  }

  return data.map((row: any) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    document_title: row.documents?.title || 'Unknown',
    content: row.content,
    similarity: 1.0,
  }));
}
