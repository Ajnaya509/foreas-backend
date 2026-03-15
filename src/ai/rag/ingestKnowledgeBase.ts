/**
 * FOREAS RAG — Script d'ingestion de la knowledge base VTC
 * =========================================================
 * Lit les documents .md, les découpe par sections (## headings),
 * et indexe chaque section comme un document séparé dans Supabase pgvector.
 *
 * V2 — Mars 2026 : ingère TOUS les fichiers de la knowledge base
 *
 * Usage : npx ts-node src/ai/rag/ingestKnowledgeBase.ts
 * Ou via la route admin : POST /api/admin/rag/ingest
 */

import * as fs from 'fs';
import * as path from 'path';
import { indexDocument, listDocuments, deleteDocument } from './indexer';
import type { DocumentSourceType } from '../../data/types';

// ─── Configuration ───────────────────────────────────────────

const DOCUMENTS_DIR = path.resolve(__dirname, 'documents');

// Tous les fichiers KB à ingérer, dans l'ordre de priorité
const KNOWLEDGE_BASE_FILES = [
  'foreas-knowledge-base-v2.md', // V2 enrichie (prioritaire)
  'FOREAS_KNOWLEDGE_BASE_V1.md', // V1 complémentaire (algorithmes détaillés)
];

// Mapping section title → source_type pour catégoriser les chunks
const SOURCE_TYPE_MAP: Record<string, DocumentSourceType> = {
  // Legal / Réglementation
  'RÉGLEMENTATION VTC': 'legal',
  'STATUT JURIDIQUE': 'legal',
  'CARTE PROFESSIONNELLE': 'legal',
  RATTACHEMENT: 'legal',
  ASSURANCE: 'legal',

  // Fiscal / Comptabilité
  FISCALITÉ: 'guide',
  'OPTIMISATION FISCALE': 'guide',
  'FRAIS DÉDUCTIBLES': 'guide',
  TVA: 'guide',
  ACRE: 'guide',

  // Plateformes
  'PLATEFORMES VTC': 'guide',
  UBER: 'guide',
  BOLT: 'guide',
  HEETCH: 'guide',
  FREENOW: 'guide',
  ALGORITHME: 'guide',
  'MULTI-APP': 'guide',
  'MULTI-PLATEFORME': 'guide',
  'STRATÉGIE MULTI': 'guide',

  // Zones / Géo
  'ZONES PARIS': 'guide',
  'POSITIONNEMENT GPS': 'guide',
  GARES: 'guide',
  AÉROPORTS: 'guide',

  // Optimisation
  'OPTIMISATION REVENUS': 'guide',
  REVENUS: 'guide',
  'ERREURS COURANTES': 'guide',
  FATIGUE: 'guide',

  // Météo / Événements
  MÉTÉO: 'guide',
  ÉVÉNEMENTS: 'guide',
  'DONNÉES TEMPS RÉEL': 'guide',

  // Sécurité
  SÉCURITÉ: 'policy',
  'BONNES PRATIQUES': 'policy',

  // FOREAS Product
  'APPLICATION FOREAS': 'faq',
  'FOREAS VS': 'faq',
  'MODULE AJNAYA': 'faq',
  'COACH DE COURSE': 'faq',
  'OBJECTIF JOURNALIER': 'faq',
  'MON ARGENT': 'faq',
  'MON SITE': 'faq',

  // Parrainage
  PARRAINAGE: 'guide',
  RÉCOMPENSES: 'guide',
  'MON RÉSEAU': 'guide',

  // FAQ
  'QUESTIONS FRÉQUENTES': 'faq',
  FAQ: 'faq',
};

function detectSourceType(sectionTitle: string): DocumentSourceType {
  const upperTitle = sectionTitle.toUpperCase();
  for (const [keyword, type] of Object.entries(SOURCE_TYPE_MAP)) {
    if (upperTitle.includes(keyword)) return type;
  }
  return 'guide';
}

// ─── Parser Markdown ─────────────────────────────────────────

interface Section {
  title: string;
  content: string;
  sourceType: DocumentSourceType;
}

/**
 * Découpe le .md en sections basées sur les headings ## (H2)
 * Chaque section = un document RAG séparé
 */
function parseMarkdownSections(markdown: string): Section[] {
  const sections: Section[] = [];
  const lines = markdown.split('\n');

  let currentTitle = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    // Détecter les headings H2 (## ...)
    if (line.startsWith('## ')) {
      // Sauver la section précédente si elle existe
      if (currentTitle && currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content.length > 50) {
          // Ignorer les sections trop courtes
          sections.push({
            title: currentTitle,
            content,
            sourceType: detectSourceType(currentTitle),
          });
        }
      }
      currentTitle = line.replace('## ', '').trim();
      currentContent = [];
    } else if (line.startsWith('# ') || line.startsWith('---')) {
      // Ignorer les H1 (titre du document) et les séparateurs
      continue;
    } else {
      currentContent.push(line);
    }
  }

  // Dernière section
  if (currentTitle && currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    if (content.length > 50) {
      sections.push({
        title: currentTitle,
        content,
        sourceType: detectSourceType(currentTitle),
      });
    }
  }

  return sections;
}

// ─── Ingestion principale ────────────────────────────────────

export async function ingestKnowledgeBase(): Promise<{
  filesProcessed: number;
  totalSections: number;
  documentsIndexed: number;
  errors: string[];
}> {
  console.log('📚 [RAG Ingest V2] Démarrage ingestion knowledge base...');
  console.log(`📂 [RAG Ingest V2] Dossier: ${DOCUMENTS_DIR}`);

  let totalSections = 0;
  let documentsIndexed = 0;
  let filesProcessed = 0;
  const errors: string[] = [];

  for (const filename of KNOWLEDGE_BASE_FILES) {
    const filepath = path.join(DOCUMENTS_DIR, filename);

    if (!fs.existsSync(filepath)) {
      console.warn(`⚠️ [RAG Ingest V2] Fichier non trouvé: ${filename}, skip`);
      continue;
    }

    console.log(`\n📄 [RAG Ingest V2] ── Traitement: ${filename} ──`);
    const markdown = fs.readFileSync(filepath, 'utf-8');
    console.log(`   ${markdown.length} caractères`);

    // Parser en sections
    const sections = parseMarkdownSections(markdown);
    console.log(`   ${sections.length} sections détectées:`);
    sections.forEach((s, i) => {
      console.log(`     ${i + 1}. "${s.title}" (${s.content.length} chars, type: ${s.sourceType})`);
    });

    totalSections += sections.length;

    // Indexer chaque section
    for (const section of sections) {
      try {
        await indexDocument({
          title: `FOREAS KB: ${section.title}`,
          content: section.content,
          sourceType: section.sourceType,
          metadata: {
            source: filename,
            version: filename.includes('v2') ? '2.0' : '1.0',
            ingestedAt: new Date().toISOString(),
            section: section.title,
          },
        });
        documentsIndexed++;
        console.log(`     ✅ "${section.title}"`);
      } catch (err: any) {
        const errorMsg = `Erreur "${section.title}" (${filename}): ${err.message}`;
        errors.push(errorMsg);
        console.error(`     ❌ ${errorMsg}`);
      }
    }

    filesProcessed++;
  }

  console.log(`\n📊 [RAG Ingest V2] Résultat final:`);
  console.log(`   Fichiers traités: ${filesProcessed}/${KNOWLEDGE_BASE_FILES.length}`);
  console.log(`   Sections totales: ${totalSections}`);
  console.log(`   Documents indexés: ${documentsIndexed}`);
  console.log(`   Erreurs: ${errors.length}`);

  return {
    filesProcessed,
    totalSections,
    documentsIndexed,
    errors,
  };
}

/**
 * Réindexer tout : supprime les anciens documents KB et réingère
 */
export async function reingestKnowledgeBase(): Promise<{
  deleted: number;
  filesProcessed: number;
  totalSections: number;
  documentsIndexed: number;
  errors: string[];
}> {
  console.log('🔄 [RAG Ingest V2] Réindexation complète...');

  // 1. Supprimer les anciens documents KB
  const existingDocs = await listDocuments();
  const kbDocs = existingDocs.filter(
    (d) =>
      d.title.startsWith('FOREAS KB:') ||
      (d.metadata as any)?.source?.includes('knowledge') ||
      (d.metadata as any)?.source?.includes('vtc'),
  );

  let deleted = 0;
  for (const doc of kbDocs) {
    await deleteDocument(doc.id);
    deleted++;
  }
  console.log(`🗑️ [RAG Ingest V2] ${deleted} anciens documents supprimés`);

  // 2. Réingérer
  const result = await ingestKnowledgeBase();

  return {
    deleted,
    ...result,
  };
}

// ─── CLI standalone ──────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const forceReingest = args.includes('--force') || args.includes('-f');

  const run = forceReingest ? reingestKnowledgeBase : ingestKnowledgeBase;

  run()
    .then((result) => {
      console.log('\n✅ Ingestion terminée:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Ingestion échouée:', err);
      process.exit(1);
    });
}
