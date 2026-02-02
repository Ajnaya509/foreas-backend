/**
 * FOREAS AI Platform V1 - RAG Module Index
 * =========================================
 * Centralized exports for RAG pipeline.
 */

// Indexer
export {
  indexDocument,
  getDocument,
  listDocuments,
  deleteDocument,
  reembedDocument,
  bulkIndexDocuments,
  indexFAQs,
} from './indexer';

export type { IndexDocumentInput } from './indexer';

// Retriever
export {
  searchDocuments,
  buildContext,
  buildRAGPrompt,
  searchFAQs,
  searchSupportScripts,
  searchGuidesAndPolicies,
  hybridSearch,
  getChunkById,
  getChunksByIds,
} from './retriever';

export type { SearchOptions } from './retriever';
