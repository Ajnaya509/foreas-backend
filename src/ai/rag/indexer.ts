/**
 * FOREAS AI Platform V1 - RAG Indexer
 * ====================================
 * Document indexing and embedding for RAG.
 * Tables: public.documents, public.document_chunks
 */

import { createHash } from 'crypto';
import { getSupabaseAdmin } from '../../helpers/supabase';
import { getOpenAIClient } from '../llm/providers/OpenAIClient';
import type { Document, DocumentChunk, DocumentSourceType } from '../../data/types';

// ============================================
// CONFIGURATION
// ============================================

const CHUNK_SIZE = 500; // tokens (approximate)
const CHUNK_OVERLAP = 50; // tokens overlap between chunks
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSION = 1536;

// ============================================
// TEXT CHUNKING
// ============================================

/**
 * Simple text chunker by character count (approximates tokens)
 * Rule of thumb: ~4 chars per token for English, ~3 for French
 */
function chunkText(
  text: string,
  maxCharsPerChunk = CHUNK_SIZE * 3,
  overlapChars = CHUNK_OVERLAP * 3
): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    // Find a good break point (paragraph or sentence)
    let end = Math.min(start + maxCharsPerChunk, text.length);

    if (end < text.length) {
      // Try to break at paragraph
      const paragraphBreak = text.lastIndexOf('\n\n', end);
      if (paragraphBreak > start + maxCharsPerChunk / 2) {
        end = paragraphBreak;
      } else {
        // Try to break at sentence
        const sentenceBreak = text.lastIndexOf('. ', end);
        if (sentenceBreak > start + maxCharsPerChunk / 2) {
          end = sentenceBreak + 1;
        }
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // Move start with overlap
    start = end - overlapChars;
    if (start < end && start > 0) {
      // Find word boundary for overlap
      const wordBoundary = text.indexOf(' ', start);
      if (wordBoundary > start && wordBoundary < start + overlapChars) {
        start = wordBoundary + 1;
      }
    }
  }

  return chunks;
}

/**
 * Estimate token count for text
 */
function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 3-4 chars for French/English
  return Math.ceil(text.length / 3.5);
}

// ============================================
// DOCUMENT MANAGEMENT
// ============================================

export interface IndexDocumentInput {
  title: string;
  content: string;
  sourceType: DocumentSourceType;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}

/**
 * Index a new document (or update if content changed)
 */
export async function indexDocument(input: IndexDocumentInput): Promise<Document> {
  const supabase = getSupabaseAdmin();
  const contentHash = createHash('sha256').update(input.content).digest('hex');

  // Check if document with same hash exists
  const { data: existing } = await supabase
    .from('documents')
    .select('id')
    .eq('content_hash', contentHash)
    .eq('is_active', true)
    .maybeSingle();

  if (existing) {
    console.log(`[RAG Indexer] Document already indexed: ${input.title}`);
    const { data } = await supabase
      .from('documents')
      .select()
      .eq('id', existing.id)
      .single();
    return data as Document;
  }

  // Deactivate old versions with same title
  await supabase
    .from('documents')
    .update({ is_active: false })
    .eq('title', input.title)
    .eq('is_active', true);

  // Get next version
  const { data: versionData } = await supabase
    .from('documents')
    .select('version')
    .eq('title', input.title)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const version = (versionData?.version || 0) + 1;

  // Insert new document
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .insert({
      title: input.title,
      content: input.content,
      source_type: input.sourceType,
      content_hash: contentHash,
      metadata: input.metadata || {},
      is_active: true,
      version,
      created_by: input.createdBy || null,
    })
    .select()
    .single();

  if (docError) {
    console.error('[RAG Indexer] Document insert failed:', docError.message);
    throw new Error(`Failed to index document: ${docError.message}`);
  }

  console.log(`[RAG Indexer] Document created: ${doc.id} (v${version})`);

  // Chunk and embed
  await chunkAndEmbed(doc as Document);

  return doc as Document;
}

/**
 * Chunk a document and generate embeddings
 */
async function chunkAndEmbed(doc: Document): Promise<void> {
  const supabase = getSupabaseAdmin();
  const openai = getOpenAIClient();

  // Chunk the content
  const chunks = chunkText(doc.content);
  console.log(`[RAG Indexer] Created ${chunks.length} chunks for document ${doc.id}`);

  // Batch embed chunks
  const batchSize = 10;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);

    let embeddings: number[][] = [];

    if (openai.isConfigured()) {
      try {
        const response = await openai.embed({
          input: batch,
          model: EMBEDDING_MODEL,
        });
        embeddings = response.embeddings;
      } catch (err) {
        console.error(`[RAG Indexer] Embedding failed for batch ${i}:`, err);
        // Continue with null embeddings
        embeddings = batch.map(() => []);
      }
    } else {
      console.warn('[RAG Indexer] OpenAI not configured, storing chunks without embeddings');
      embeddings = batch.map(() => []);
    }

    // Insert chunks
    const chunkRecords = batch.map((content, j) => ({
      document_id: doc.id,
      chunk_index: i + j,
      content,
      embedding: embeddings[j]?.length === EMBEDDING_DIMENSION ? embeddings[j] : null,
      token_count: estimateTokens(content),
      metadata: {},
    }));

    const { error } = await supabase.from('document_chunks').insert(chunkRecords);

    if (error) {
      console.error(`[RAG Indexer] Chunk insert failed:`, error.message);
    }
  }

  console.log(`[RAG Indexer] Indexed ${chunks.length} chunks for document ${doc.id}`);
}

/**
 * Get document by ID
 */
export async function getDocument(documentId: string): Promise<Document | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('documents')
    .select()
    .eq('id', documentId)
    .maybeSingle();

  if (error) {
    console.error('[RAG Indexer] Get document failed:', error.message);
    throw new Error(`Failed to get document: ${error.message}`);
  }

  return data as Document | null;
}

/**
 * List active documents
 */
export async function listDocuments(
  sourceType?: DocumentSourceType
): Promise<Document[]> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('documents')
    .select()
    .eq('is_active', true)
    .order('updated_at', { ascending: false });

  if (sourceType) {
    query = query.eq('source_type', sourceType);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[RAG Indexer] List documents failed:', error.message);
    throw new Error(`Failed to list documents: ${error.message}`);
  }

  return data as Document[];
}

/**
 * Delete document (soft delete)
 */
export async function deleteDocument(documentId: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from('documents')
    .update({ is_active: false })
    .eq('id', documentId);

  if (error) {
    console.error('[RAG Indexer] Delete document failed:', error.message);
    throw new Error(`Failed to delete document: ${error.message}`);
  }

  console.log(`[RAG Indexer] Soft deleted document: ${documentId}`);
}

/**
 * Re-embed a document (useful after model update)
 */
export async function reembedDocument(documentId: string): Promise<void> {
  const supabase = getSupabaseAdmin();

  // Delete existing chunks
  await supabase.from('document_chunks').delete().eq('document_id', documentId);

  // Get document
  const doc = await getDocument(documentId);
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }

  // Re-chunk and embed
  await chunkAndEmbed(doc);
}

// ============================================
// BULK OPERATIONS
// ============================================

/**
 * Index multiple documents
 */
export async function bulkIndexDocuments(
  documents: IndexDocumentInput[]
): Promise<Document[]> {
  const results: Document[] = [];

  for (const doc of documents) {
    try {
      const indexed = await indexDocument(doc);
      results.push(indexed);
    } catch (err) {
      console.error(`[RAG Indexer] Failed to index "${doc.title}":`, err);
    }
  }

  return results;
}

/**
 * Index FAQ documents from JSON
 */
export async function indexFAQs(
  faqs: Array<{ question: string; answer: string; category?: string }>
): Promise<number> {
  let indexed = 0;

  for (const faq of faqs) {
    try {
      await indexDocument({
        title: faq.question,
        content: `Question: ${faq.question}\n\nRéponse: ${faq.answer}`,
        sourceType: 'faq',
        metadata: { category: faq.category },
      });
      indexed++;
    } catch (err) {
      console.error(`[RAG Indexer] Failed to index FAQ "${faq.question}":`, err);
    }
  }

  return indexed;
}
