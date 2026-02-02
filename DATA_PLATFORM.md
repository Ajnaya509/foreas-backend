# FOREAS Data Platform V1

> Backend produit + IA data-driven sans fine-tuning

## 📋 Vue d'ensemble

La Data Platform V1 fournit l'infrastructure complète pour:
- **Traçabilité IA**: Conversations, messages, tokens, coûts
- **Analytics**: Events append-only pour analyse comportementale
- **Personnalisation**: Feature store pour contexte ML
- **Amélioration continue**: Outcomes pour ground truth labels
- **Sécurité**: RBAC + Audit logs

## 🗄️ Architecture

```
src/
├── data/                    # Data Layer
│   ├── types.ts             # Types centralisés
│   ├── eventStore.ts        # Analytics events (append-only)
│   ├── conversationLog.ts   # LLM conversations + messages
│   ├── featureStore.ts      # Driver features/flags
│   ├── outcomes.ts          # Recommendation outcomes
│   ├── auditLog.ts          # Security audit logs
│   └── index.ts             # Barrel export
│
├── ai/                      # AI Layer
│   ├── llm/                 # LLM Abstraction
│   │   ├── types.ts         # LLM types (messages, costs)
│   │   ├── LLMClient.ts     # Abstract base class
│   │   └── providers/
│   │       ├── OpenAIClient.ts   # OpenAI implementation
│   │       └── MistralClient.ts  # Mistral stub
│   ├── rag/                 # RAG Pipeline
│   │   ├── indexer.ts       # Document indexing
│   │   └── retriever.ts     # Semantic search
│   ├── aiService.ts         # Main orchestration
│   └── index.ts
│
├── middleware/
│   └── rbac.ts              # Role-Based Access Control
│
└── routes/
    ├── ai.routes.ts         # AI API endpoints
    └── admin.routes.ts      # Admin endpoints
```

## 🔑 Variables d'environnement

```bash
# Supabase (requis)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# OpenAI (requis pour AI)
OPENAI_API_KEY=sk-...

# Mistral (optionnel - stub si absent)
MISTRAL_API_KEY=...

# Stripe (existant)
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...
```

## 📊 Tables Supabase

### Migration: `20260201_data_platform.sql`

| Table | Description | RLS |
|-------|-------------|-----|
| `events` | Analytics events (append-only) | Insert-only |
| `ai_conversations` | Conversation sessions | Owner-only |
| `ai_messages` | Messages with PII redaction | Via conversation |
| `driver_features` | Feature snapshots | Owner-only |
| `ai_outcomes` | Recommendation outcomes | Owner-only |
| `documents` | RAG source documents | Public read |
| `document_chunks` | RAG embeddings (pgvector) | Public read |
| `audit_logs` | Security audit trail | Admin-only |
| `user_roles` | RBAC roles | Owner-read |
| `data_consents` | GDPR consents | Owner-manage |

### Appliquer la migration

```bash
# Via Supabase CLI
supabase db push

# OU via SQL Editor
# Copier le contenu de supabase/migrations/20260201_data_platform.sql
```

## 🚀 API Endpoints

### AI Routes (`/api/ai`)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/chat` | Main AI chat | Driver + Consent |
| POST | `/quick` | Quick recommendation | Driver |
| GET | `/context` | Get driver features | Driver |
| POST | `/context/refresh` | Force refresh features | Driver |
| GET | `/conversations` | List conversations | Driver |
| GET | `/conversations/stats` | Conversation stats | Driver |
| POST | `/conversations/:id/complete` | Complete conversation | Driver |
| GET | `/outcomes` | List outcomes | Driver |
| GET | `/outcomes/stats` | Outcome stats | Driver |
| POST | `/outcomes/:id/feedback` | Add feedback | Driver |
| GET | `/health` | AI service health | Public |

### Admin Routes (`/api/admin`)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/events` | Query analytics | Support+ |
| GET | `/events/count` | Count events | Support+ |
| GET | `/audit` | Query audit logs | Admin |
| GET | `/outcomes` | Query all outcomes | Support+ |
| GET | `/documents` | List RAG documents | Admin |
| POST | `/documents` | Index new document | Admin |
| DELETE | `/documents/:id` | Delete document | Admin |
| GET | `/users` | List users/roles | Admin |
| POST | `/users/:userId/roles` | Grant role | Admin |
| DELETE | `/users/:userId/roles/:role` | Revoke role | Admin |
| GET | `/users/:userId/consents` | Get consents | Support+ |
| GET | `/stats` | System-wide stats | Admin |

## 🔒 RBAC (Roles)

| Role | Level | Access |
|------|-------|--------|
| `anonymous` | 0 | Public endpoints only |
| `driver` | 10 | Own data + AI features |
| `partner` | 20 | Partner dashboard |
| `support` | 30 | Read all users + events |
| `admin` | 100 | Full access + role management |
| `system` | 100 | Internal processes |

### Usage

```typescript
import { requireRole, requireAuth, requireOwnership } from '../middleware/rbac';

// Require authentication
router.get('/protected', requireAuth, handler);

// Require specific role
router.get('/admin-only', requireRole('admin'), handler);

// Require resource ownership
router.get('/users/:userId/data', requireOwnership('userId'), handler);
```

## 🤖 LLM Provider Abstraction

### Supported Providers

| Provider | Status | Models |
|----------|--------|--------|
| OpenAI | ✅ Active | gpt-4o, gpt-4o-mini, embeddings |
| Mistral | ⏸️ Stub | mistral-7b-instruct (stub) |

### Usage

```typescript
import { getOpenAIClient, createLLMClient } from '../ai/llm';

// Get default client (OpenAI)
const llm = getOpenAIClient();

// Or create specific client
const mistral = createLLMClient('mistral');

// Complete
const response = await llm.complete({
  messages: [
    { role: 'system', content: 'Tu es Ajnaya...' },
    { role: 'user', content: 'Où aller?' },
  ],
  model: 'gpt-4o-mini',
  temperature: 0.7,
});

// Embed
const embeddings = await llm.embed({
  input: ['Texte à vectoriser'],
  model: 'text-embedding-3-small',
});
```

## 📚 RAG Pipeline

### Indexer

```typescript
import { indexDocument, indexFAQs } from '../ai/rag';

// Index a document
await indexDocument({
  title: 'Guide zones chaudes Paris',
  content: 'Les meilleures zones à Paris sont...',
  sourceType: 'guide',
  metadata: { category: 'zones' },
});

// Bulk index FAQs
await indexFAQs([
  {
    question: 'Comment activer Ajnaya?',
    answer: 'Appuie sur le micro dans l\'app...',
    category: 'onboarding',
  },
]);
```

### Retriever

```typescript
import { searchDocuments, buildRAGPrompt } from '../ai/rag';

// Search
const results = await searchDocuments('zones chaudes paris', {
  maxResults: 5,
  threshold: 0.7,
  sourceTypes: ['guide', 'faq'],
});

// Build prompt with context
const prompt = buildRAGPrompt(
  'Où dois-je aller ce soir?',
  results,
  'Tu es Ajnaya...'
);
```

## 📈 Data Flows

### AI Chat Flow

```
1. User sends message
   ↓
2. Get/create conversation
   ↓
3. Load message history (last 10)
   ↓
4. Get driver features (context)
   ↓
5. RAG search (if enabled)
   ↓
6. Build full prompt
   ↓
7. Log user message (redacted)
   ↓
8. Call LLM
   ↓
9. Log assistant message + tokens + cost
   ↓
10. Track event
   ↓
11. Return response
```

### Event Tracking Flow

```typescript
import { trackEventAsync, trackNavigation } from '../data/eventStore';

// Fire-and-forget event
trackEventAsync({
  eventName: 'recommendation.shown',
  eventCategory: 'recommendation',
  actorId: driverId,
  actorRole: 'driver',
  payload: { type: 'zone', confidence: 0.85 },
});

// Convenience helpers
trackNavigation(driverId, { lat: 48.8, lng: 2.3, label: 'Bastille' }, 'voice');
```

## 🧪 Testing

### Smoke Test

```bash
# Local
curl http://localhost:8080/health
curl http://localhost:8080/version

# Check AI routes
curl http://localhost:8080/api/ai/health
```

### Production

```bash
# After deploy
./scripts/smoke-prod.sh
```

## 📝 Costs Tracking

Le système track automatiquement:

| Metric | Location |
|--------|----------|
| Tokens (input/output) | `ai_messages` |
| Cost USD | `ai_messages.cost_usd` |
| Total per conversation | `ai_conversations.total_cost_usd` |
| Latency | `ai_messages.latency_ms` |

### Model Pricing (Feb 2026)

| Model | Input/1M | Output/1M |
|-------|----------|-----------|
| gpt-4o | $2.50 | $10.00 |
| gpt-4o-mini | $0.15 | $0.60 |
| text-embedding-3-small | $0.02 | - |

## 🔐 Security

### PII Redaction

Tous les contenus sont automatiquement redactés avant stockage:
- Numéros de téléphone → `[PHONE]`
- Emails → `[EMAIL]`
- Noms → `[NAME]`
- Adresses → `[ADDRESS]`
- Cartes de crédit → `[CARD]`
- NIR (SSN français) → `[SSN]`

### Audit Logging

Actions admin/support automatiquement loggées:
- `user.suspended`, `user.reactivated`
- `role.granted`, `role.revoked`
- `document.indexed`, `document.deleted`
- `auth.access_denied`

## 🚧 Prochaines étapes

1. **Jobs de refresh features**: Cron pour `daily`/`weekly` snapshots
2. **Notifications**: Interface + mocks pour push notifications
3. **Mistral activation**: Configurer MISTRAL_API_KEY
4. **Monitoring**: Dashboard Supabase ou custom
5. **Fine-tuning pipeline**: Export des outcomes pour training
