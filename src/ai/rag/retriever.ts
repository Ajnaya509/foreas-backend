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
  options: SearchOptions = {},
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

  let results = (data || []).map((row: any) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    document_title: '',
    content: row.chunk_text || row.content || '',
    similarity: row.similarity || 0,
  })) as SearchResult[];

  // Filter by source types if specified
  if (options.sourceTypes?.length) {
    const validDocIds = await getDocumentsBySourceType(options.sourceTypes);
    results = results.filter((r) => validDocIds.has(r.document_id));
  }

  console.log(
    `[RAG Retriever] Found ${results.length} results for query: "${query.substring(0, 50)}..."`,
  );

  return results;
}

// ============================================
// ÉTAPE 2 — RECHERCHE GOUVERNÉE + HYBRIDE + RERANKER
// search_knowledge (CORE prioritaire, sens+mots, filtres) → reranker Cohere
// ============================================

export interface KnowledgeOptions {
  maxResults?: number; // top-N final (après rerank)
  candidates?: number; // top-K avant rerank
  threshold?: number;
  collections?: string[] | null;
  includeLearned?: boolean;
  intent?: 'driver' | 'sell' | 'all'; // aiguillage : chauffeur vs vente/prospect
}

// ============================================
// AIGUILLAGE D'INTENTION
// Un CHAUFFEUR ne doit pas tomber sur le savoir de VENTE
// (ex. "gagner plus" → zones/objectif, PAS la formation freelance "facturer plus cher").
// Un CLOSER/prospect a besoin de TOUT : produit + persuasion.
// ============================================
const DRIVER_COLLECTIONS = [
  'ajnaya_product',
  'general',
  'onboarding_ajnaya',
  'fiscal_compta',
  'mindset_discipline',
  'foreas_pricing_internal',
];
const SELL_COLLECTIONS = [
  'vente',
  'closing_reseaux',
  'objections',
  'copywriting',
  'email_marketing',
  'temoignages',
  'ajnaya_product',
  'general',
  'foreas_pricing_internal',
];
const SELL_SIGNALS = [
  'pourquoi je paierai',
  'pourquoi payer',
  'déjà uber',
  'deja uber',
  'déjà bolt',
  'deja bolt',
  'vs uber',
  'vs bolt',
  'abonnement',
  'ça coûte',
  'ca coute',
  'combien ça',
  'combien ca',
  'convaincre',
  'prospect',
  'hésite',
  'hesite',
  'arnaque',
  'gratuit ailleurs',
  'pourquoi foreas',
  'à quoi ça sert',
  "pourquoi m'abonner",
  "s'inscrire",
  'inscription',
];

/** Choisit les collections selon l'intention (explicite > intent > auto-détection). */
function resolveCollections(query: string, opts: KnowledgeOptions): string[] | null {
  if (opts.collections && opts.collections.length) return opts.collections; // explicite gagne
  if (opts.intent === 'all') return null;
  if (opts.intent === 'driver') return DRIVER_COLLECTIONS;
  if (opts.intent === 'sell') return SELL_COLLECTIONS;
  // auto : signaux de vente/prospect → SELL, sinon contexte chauffeur
  const q = query.toLowerCase();
  if (SELL_SIGNALS.some((s) => q.includes(s))) return SELL_COLLECTIONS;
  return DRIVER_COLLECTIONS;
}

/** Recherche gouvernée (CORE prioritaire) + hybride (sens + mots) + reranker. */
export async function searchKnowledge(
  query: string,
  options: KnowledgeOptions = {},
): Promise<SearchResult[]> {
  const supabase = getSupabaseAdmin();
  const openai = getOpenAIClient();
  const topN = options.maxResults || 5;
  const candidates = options.candidates || Math.max(topN * 3, 12);

  if (!openai.isConfigured()) return textSearch(query, topN);

  let queryEmbedding: number[];
  try {
    const response = await openai.embed({ input: query, model: EMBEDDING_MODEL });
    queryEmbedding = response.embeddings[0];
  } catch (err) {
    console.error('[RAG searchKnowledge] embedding failed:', err);
    return textSearch(query, topN);
  }

  const collections = resolveCollections(query, options);
  const { data, error } = await supabase.rpc('search_knowledge', {
    query_embedding: queryEmbedding,
    query_text: query,
    match_count: candidates,
    // seuil abaissé (0.45 → 0.30) : on laisse passer plus de candidats,
    // le reranker Cohere tranche ensuite (fini les "je ne sais pas" alors que la réponse existe).
    match_threshold: options.threshold ?? 0.3,
    filter_collections: collections,
    include_learned: options.includeLearned ?? true,
  });

  if (error) {
    console.error('[RAG searchKnowledge] rpc failed:', error.message);
    return textSearch(query, topN);
  }

  const results: SearchResult[] = (data || []).map((row: any) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    document_title: row.collection || '',
    content: row.chunk_text || '',
    similarity: row.similarity || 0,
  }));

  return rerankCohere(query, results, topN);
}

/** Reranker Cohere (2e tri de précision). Sans clé / erreur → top-N inchangé. */
async function rerankCohere(
  query: string,
  results: SearchResult[],
  topN: number,
): Promise<SearchResult[]> {
  const key = process.env.COHERE_API_KEY;
  if (!key || results.length <= 1) return results.slice(0, topN);
  try {
    const resp = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'rerank-v3.5',
        query,
        documents: results.map((r) => r.content),
        top_n: Math.min(topN, results.length),
      }),
    });
    if (!resp.ok) {
      console.warn('[RAG rerank] cohere http', resp.status);
      return results.slice(0, topN);
    }
    const data: any = await resp.json();
    const ranked = (data.results || [])
      .map((rr: any) => {
        const base = results[rr.index];
        return base ? { ...base, similarity: rr.relevance_score ?? base.similarity } : null;
      })
      .filter(Boolean) as SearchResult[];
    return ranked.length ? ranked : results.slice(0, topN);
  } catch (err) {
    console.error('[RAG rerank] error:', err);
    return results.slice(0, topN);
  }
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
      chunk_text,
      documents!inner(title, is_active)
    `,
    )
    .eq('documents.is_active', true)
    .ilike('chunk_text', `%${query}%`)
    .limit(maxResults);

  if (error) {
    console.error('[RAG Retriever] Text search failed:', error.message);
    return [];
  }

  return (data || []).map((row: any) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    document_title: row.documents?.title || 'Unknown',
    content: row.chunk_text,
    similarity: 0.5, // Arbitrary score for text match
  }));
}

/**
 * Get document IDs by source type
 */
async function getDocumentsBySourceType(sourceTypes: DocumentSourceType[]): Promise<Set<string>> {
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
  systemPrompt?: string,
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
export async function searchFAQs(query: string, maxResults = 3): Promise<SearchResult[]> {
  return searchDocuments(query, {
    maxResults,
    sourceTypes: ['faq'],
    threshold: 0.65, // Lower threshold for FAQs
  });
}

/**
 * Search support scripts
 */
export async function searchSupportScripts(query: string, maxResults = 3): Promise<SearchResult[]> {
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
  maxResults = 3,
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
  options: SearchOptions = {},
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
  return merged.sort((a, b) => b.similarity - a.similarity).slice(0, maxResults);
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
      chunk_text,
      documents!inner(title)
    `,
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
    content: data.chunk_text,
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
      chunk_text,
      documents!inner(title)
    `,
    )
    .in('id', chunkIds);

  if (error || !data) {
    return [];
  }

  return data.map((row: any) => ({
    chunk_id: row.id,
    document_id: row.document_id,
    document_title: row.documents?.title || 'Unknown',
    content: row.chunk_text,
    similarity: 1.0,
  }));
}
