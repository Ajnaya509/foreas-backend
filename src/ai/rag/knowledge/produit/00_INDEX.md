# 00_INDEX — Sources du cerveau « Produit » d'Ajnaya

> Dossier canonique (versionné) qui alimente la collection RAG **`ajnaya_product`** (tier `core`).
> **Vérité du contenu** = `FOREAS-SHARED/CARTE_FONCTIONNALITES_AJNAYA.md` (maintenue par le fil APP, dérivée de graphify + écrans).
> Ce dossier en est la copie synchronisée + ré-indexable.

| Source | Statut | Fraîcheur | Indexé |
|---|---|---|---|
| `CARTE_FONCTIONNALITES_AJNAYA.md` | ✅ indexé | 2026-06-26 | 12 fiches (1 feature = 1 chunk) en `collection='ajnaya_product'`, `tier='core'` |
| `faq/` | à venir | — | FAQ chauffeurs détaillées par feature |

## Ce qui est en base (2026-06-26)
- Table `pieuvre_feature_catalog` : **12 features** ajoutées + colonne **`canvas_screen`** (HomeScreen, AjnayaScreen, CommunauteScreen, ClientsDirects, ArgentDashboard, SubscriptionScreen, RideNavigationScreen, CoachReflexe).
- Table `document_chunks` : 12 chunks `collection='ajnaya_product'`, `tier='core'`, `source='CARTE_FONCTIONNALITES_AJNAYA.md'` ; chaque chunk porte **feature_key + canvas_screen + required_tier + voice_script + forbidden_claims** (dans le texte ET la metadata).

## Contrat retrieval (pour l'avatar live)
`POST {backend}/api/rag/search` (header `x-pieuvre-key`), body `{ "query": "...", "collection": "ajnaya_product" }`
→ remonte la bonne fiche : **ce qu'Ajnaya DIT** (voice_script) + **ce qu'elle MONTRE** (canvas_screen) + **ce qu'elle ne dit JAMAIS** (forbidden_claims). CORE prioritaire, anti-hallucination.

## Ré-indexation (quand le fil APP régénère la carte)
1. Re-sync `CARTE_FONCTIONNALITES_AJNAYA.md` depuis `FOREAS-SHARED/`.
2. Mettre à jour `pieuvre_feature_catalog` (features + `canvas_screen`).
3. Relancer l'ingestion (catalog → embeddings OpenAI `text-embedding-3-small` → `document_chunks`, idempotent via `source`).
