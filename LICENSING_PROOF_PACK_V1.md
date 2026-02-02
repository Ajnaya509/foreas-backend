# FOREAS Data Platform - Licensing Proof Pack V1

> **Date**: 2026-02-02
> **Version**: V1.0
> **Status**: PRODUCTION READY

---

## 1. DATA SCHEMA MINIMAL

### 1.1 Events (Analytics - Append-Only)

```sql
CREATE TABLE public.events (
  id UUID PRIMARY KEY,
  event_name TEXT NOT NULL,           -- 20 events whitelist V1
  event_category TEXT NOT NULL,       -- session, navigation, recommendation, earnings, support, subscription
  actor_id UUID,                      -- driver_id (nullable for anonymous)
  actor_role TEXT,                    -- driver, partner, admin, support, system, anonymous
  payload JSONB NOT NULL DEFAULT '{}', -- PII-sanitized
  source TEXT NOT NULL DEFAULT 'backend',
  session_id TEXT,
  ip_hash TEXT,                       -- SHA256 hash, not raw IP
  created_at TIMESTAMPTZ NOT NULL
);
```

### 1.2 Driver Features (Snapshots)

```sql
CREATE TABLE public.driver_features (
  id UUID PRIMARY KEY,
  driver_id UUID NOT NULL,
  snapshot_type TEXT NOT NULL,        -- daily, weekly, realtime, manual
  features JSONB NOT NULL,            -- 15+ computed features
  flags JSONB NOT NULL,               -- personalization flags
  computed_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ
);
```

### 1.3 AI Outcomes (Labels for Training)

```sql
CREATE TABLE public.ai_outcomes (
  id UUID PRIMARY KEY,
  conversation_id UUID,
  message_id UUID,
  driver_id UUID NOT NULL,
  action_recommended TEXT NOT NULL,
  action_taken TEXT,
  outcome_type TEXT NOT NULL,         -- accepted, rejected, ignored, partial, unknown
  delta_metric JSONB,                 -- {"earnings_change": 15.00}
  confidence NUMERIC(3, 2),
  user_feedback TEXT,                 -- helpful, not_helpful, neutral
  created_at TIMESTAMPTZ NOT NULL
);
```

---

## 2. EVENT TAXONOMY V1 (20 Events)

| Event Name | Category | Description |
|------------|----------|-------------|
| `session.started` | session | App opened |
| `session.ended` | session | App closed |
| `session.resumed` | session | App resumed from background |
| `navigation.started` | navigation | Navigation to destination started |
| `navigation.completed` | navigation | Arrived at destination |
| `navigation.cancelled` | navigation | Navigation cancelled |
| `reco.shown` | recommendation | Recommendation displayed to driver |
| `reco.accepted` | recommendation | Driver accepted recommendation |
| `reco.rejected` | recommendation | Driver explicitly rejected |
| `reco.ignored` | recommendation | No action taken (timeout) |
| `earnings.trip_completed` | earnings | Trip completed with earnings |
| `earnings.daily_summary` | earnings | Daily earnings summary |
| `support.chat_started` | support | Support chat initiated |
| `support.issue_resolved` | support | Support issue marked resolved |
| `subscription.started` | subscription | Subscription activated |
| `subscription.cancelled` | subscription | Subscription cancelled |
| `subscription.renewed` | subscription | Subscription renewed |
| `features.refreshed` | recommendation | Driver features recomputed |
| `outcome.feedback` | recommendation | User feedback on outcome |
| `app.error` | general | App error tracked |

---

## 3. FEATURE DEFINITIONS V1 (15 Features)

| Feature | Type | Description |
|---------|------|-------------|
| `total_trips` | int | Lifetime completed trips |
| `trips_last_7d` | int | Trips in last 7 days |
| `trips_last_30d` | int | Trips in last 30 days |
| `days_since_last_trip` | int | Days since last completed trip |
| `acceptance_rate_7d` | float | % of recommendations accepted (7d) |
| `rejection_rate_7d` | float | % of recommendations rejected (7d) |
| `ignored_rate_7d` | float | % of recommendations ignored (7d) |
| `avg_earnings_per_trip` | float | Average earnings per trip (€) |
| `earnings_trend_7d` | enum | up, down, stable |
| `sessions_last_7d` | int | App sessions in last 7 days |
| `avg_session_duration_min` | int | Average session length (minutes) |
| `ai_interactions_7d` | int | AI chat interactions in 7 days |
| `subscription_status` | enum | active, trial, expired, none |
| `days_since_signup` | int | Days since account creation |
| `churn_risk_score` | int | 0-100 churn risk score |

---

## 4. LICENSING METRICS QUERIES

### 4.1 Couverture Events (Drivers Actifs + Events/Jour)

```sql
-- Count active drivers with events in last 7 days
SELECT
  COUNT(DISTINCT actor_id) as active_drivers,
  COUNT(*) as total_events,
  ROUND(COUNT(*)::numeric / 7, 2) as events_per_day
FROM public.events
WHERE actor_id IS NOT NULL
  AND created_at >= NOW() - INTERVAL '7 days';
```

### 4.2 Couverture Features (Drivers avec Snapshot 7j)

```sql
-- Drivers with recent feature snapshots
SELECT
  COUNT(DISTINCT driver_id) as drivers_with_features,
  COUNT(*) as total_snapshots,
  snapshot_type,
  MAX(computed_at) as latest_snapshot
FROM public.driver_features
WHERE computed_at >= NOW() - INTERVAL '7 days'
GROUP BY snapshot_type;
```

### 4.3 Outcomes Rate (Pending/Applied/Ignored)

```sql
-- Outcome distribution
SELECT
  outcome_type,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) as percentage
FROM public.ai_outcomes
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY outcome_type
ORDER BY count DESC;
```

### 4.4 Performance Reco (Si Data Dispo)

```sql
-- Recommendation performance metrics
SELECT
  DATE_TRUNC('day', created_at) as day,
  COUNT(*) FILTER (WHERE event_name = 'reco.shown') as shown,
  COUNT(*) FILTER (WHERE event_name = 'reco.accepted') as accepted,
  COUNT(*) FILTER (WHERE event_name = 'reco.rejected') as rejected,
  COUNT(*) FILTER (WHERE event_name = 'reco.ignored') as ignored,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE event_name = 'reco.accepted') /
    NULLIF(COUNT(*) FILTER (WHERE event_name = 'reco.shown'), 0),
    2
  ) as acceptance_rate_pct
FROM public.events
WHERE event_name LIKE 'reco.%'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY day DESC;
```

### 4.5 Data Quality (PII Rejections Count)

```sql
-- Count events with redacted PII in payload
SELECT
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE payload::text LIKE '%[REDACTED]%') as pii_redacted_events,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE payload::text LIKE '%[REDACTED]%') / COUNT(*),
    2
  ) as pii_redaction_rate_pct
FROM public.events
WHERE created_at >= NOW() - INTERVAL '30 days';
```

---

## 5. API ENDPOINTS

### 5.1 Public (No Auth)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analytics/track` | POST | Track single event |
| `/api/analytics/batch` | POST | Track batch events (max 50) |
| `/api/analytics/events` | GET | List allowed events |
| `/api/analytics/health` | GET | Service health check |

### 5.2 Authenticated (Driver)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ai/chat` | POST | AI chat completion |
| `/api/ai/context` | GET | Get driver context |
| `/api/ai/context/refresh` | POST | Force refresh features |
| `/api/ai/outcomes` | GET | Get driver outcomes |
| `/api/ai/outcomes/:id/feedback` | POST | Submit outcome feedback |

### 5.3 Admin Only

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/events` | GET | Query all events |
| `/api/admin/outcomes` | GET | Query all outcomes |
| `/api/admin/stats` | GET | System statistics |
| `/api/admin/jobs` | GET | List available jobs |
| `/api/admin/jobs/features` | POST | Trigger daily features job |
| `/api/admin/jobs/outcomes-timeout` | POST | Trigger outcomes timeout job |

---

## 6. DATA FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MOBILE APP                                   │
│                                                                     │
│  ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐       │
│  │ Session │     │  Reco   │     │ Earnings│     │ Support │       │
│  │ Events  │     │ Events  │     │ Events  │     │ Events  │       │
│  └────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘       │
│       │              │              │              │               │
└───────┼──────────────┼──────────────┼──────────────┼───────────────┘
        │              │              │              │
        └──────────────┴──────────────┴──────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │       POST /api/analytics/track             │
        │       (Public, Rate-Limited, PII-Sanitized) │
        └─────────────────────┬───────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │              TABLE: events                   │
        │         (Append-Only, Immutable)            │
        └─────────────────────┬───────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   CRON: Daily Features  │     │   CRON: Outcomes Timeout │
│      (04:00 UTC)        │     │       (05:00 UTC)       │
└───────────┬─────────────┘     └───────────┬─────────────┘
            │                               │
            ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  TABLE: driver_features │     │   TABLE: ai_outcomes    │
│    (Daily Snapshots)    │     │  (pending → ignored)    │
└───────────┬─────────────┘     └─────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────┐
│           AI PERSONALIZATION                 │
│  (Context-aware recommendations)            │
└─────────────────────────────────────────────┘
```

---

## 7. COMPLIANCE & SECURITY

### 7.1 GDPR

- ✅ PII sanitization (phone, email, SSN, card, IP)
- ✅ Data deletion function (`delete_user_data(user_id)`)
- ✅ Consent tracking (`data_consents` table)
- ✅ Audit logging (`audit_logs` table)

### 7.2 Security

- ✅ Rate limiting (100 req/min per IP)
- ✅ Event whitelist (20 events only)
- ✅ Field denylist (phone, email, password, etc.)
- ✅ IP hashing (SHA256, not raw)
- ✅ RBAC middleware (anonymous < driver < partner < support < admin)

### 7.3 Data Quality

- ✅ Strict event validation (Zod-like)
- ✅ PII detection and redaction
- ✅ Immutable event store (no UPDATE/DELETE)
- ✅ Timestamped snapshots

---

## 8. LICENSING READINESS CHECKLIST

| Requirement | Status | Notes |
|-------------|--------|-------|
| Events tracked | ✅ | 20 events V1 |
| PII sanitization | ✅ | Regex + field denylist |
| Features computed | ✅ | 15 features V1 |
| Outcomes tracked | ✅ | 5 types + feedback |
| GDPR compliance | ✅ | Deletion, consent, audit |
| API documented | ✅ | This document |
| Rate limiting | ✅ | 100 req/min |
| Audit trail | ✅ | All admin actions logged |

---

## 9. SMOKE TEST COMMANDS

```bash
# 1. Track event
curl -X POST https://foreas-stripe-backend-production.up.railway.app/api/analytics/track \
  -H "Content-Type: application/json" \
  -d '{"event_name":"session.started","actor_id":"test-driver-123","session_id":"s1","payload":{"platform":"ios","app_version":"1.0.0"}}'

# 2. List allowed events
curl https://foreas-stripe-backend-production.up.railway.app/api/analytics/events

# 3. Health check
curl https://foreas-stripe-backend-production.up.railway.app/api/analytics/health

# 4. Batch events
curl -X POST https://foreas-stripe-backend-production.up.railway.app/api/analytics/batch \
  -H "Content-Type: application/json" \
  -d '{"events":[{"event_name":"session.started","actor_id":"test","session_id":"s1"},{"event_name":"reco.shown","actor_id":"test","session_id":"s1"}]}'
```

---

## 10. DEPLOYMENT NOTES

- **Repository**: `https://github.com/Ajnaya509/foreas-backend.git`
- **Branch**: `main`
- **Deployed SHA**: `a601c6fd319309dde2cf9e8c12916ad6dc94ca56` (+ this patch)
- **Runtime**: Node.js v22, Railway
- **Database**: Supabase (Postgres + pgvector)

---

*Generated by FOREAS Release Captain*
*Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>*
