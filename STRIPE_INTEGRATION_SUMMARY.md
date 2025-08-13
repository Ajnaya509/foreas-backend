# 🚀 Stripe Connect Integration - FOREAS Driver Backend

## 📋 Résumé de l'intégration

Cette intégration Stripe Connect permet aux chauffeurs FOREAS de configurer leurs comptes de paiement via Stripe Express pour recevoir leurs revenus directement.

## 🏗️ Architecture

### 1. Service Layer (`StripeService`)
**Fichier**: `src/services/StripeService.ts`

Service isolé avec 3 méthodes principales :

- **`ensureAccount(userId)`** : Assure l'existence d'un compte Stripe Connect
- **`createOnboardingLink(accountId, refreshUrl, returnUrl)`** : Génère un lien d'onboarding
- **`refreshStatus(accountId)`** : Met à jour le statut depuis Stripe

✅ **Fonctionnalités** :
- Gestion d'erreurs typées avec TRPCError
- Logging sécurisé avec masquage des secrets
- Persistance automatique en base de données
- Support des comptes Express Stripe

### 2. Router tRPC (`stripeRouter`)
**Fichier**: `src/server/routers/stripe.ts`

Endpoints tRPC avec validation Zod :

- **`createOnboardingLink`** : Crée un lien d'onboarding pour le chauffeur connecté
- **`refreshAccount`** : Met à jour le statut du compte Stripe

✅ **Fonctionnalités** :
- Validation d'entrée/sortie avec Zod
- Authentification requise via `requireAuth` middleware
- URLs par défaut depuis les variables d'environnement
- Gestion d'erreurs cohérente

### 3. Webhook Handler (`stripeWebhook`)
**Fichier**: `src/webhooks/stripeWebhook.ts`

Gestionnaire de webhooks avec :

- **Vérification de signature** Stripe obligatoire
- **Idempotence** via base de données (table `WebhookEvent`)
- **Support des événements** : `account.updated`, `payout.paid`, `payout.failed`, `payout.updated`

✅ **Fonctionnalités** :
- Signature verification avec `stripe.webhooks.constructEvent`
- Idempotence automatique (évite le double traitement)
- Logging détaillé de tous les événements
- Gestion d'erreurs avec retry par Stripe

### 4. Logger sécurisé (`logger`)
**Fichier**: `src/utils/logger.ts`

Logger Pino avec protection des secrets :

- **Redaction automatique** des clés sensibles
- **Contextes spécialisés** : `stripeLogger`, `webhookLogger`
- **Format adaptatif** : pretty en dev, JSON en prod

✅ **Fonctionnalités** :
- Masquage automatique des secrets (clés API, tokens)
- Logs structurés avec contexte
- Support test avec niveau `silent`

## 🗃️ Base de données

### Table `StripeAccount`
```prisma
model StripeAccount {
  id              String    @id @default(cuid())
  userId          String    @unique
  accountId       String    @unique
  chargesEnabled  Boolean   @default(false)
  payoutsEnabled  Boolean   @default(false)
  detailsSubmitted Boolean  @default(false)
  businessType    String?
  country         String?
  defaultCurrency String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
}
```

### Table `WebhookEvent` (Idempotence)
```prisma
model WebhookEvent {
  id          String    @id @default(cuid())
  eventId     String    @unique
  eventType   String
  processed   Boolean   @default(false)
  processedAt DateTime?
  error       String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}
```

## 🔧 Configuration

### Variables d'environnement requises
```bash
# Stripe
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# URLs de retour Stripe Connect
RETURN_URL="https://app.foreas.fr/onboarding/complete"
REFRESH_URL="https://app.foreas.fr/onboarding/refresh"
```

## 🧪 Tests

### Tests unitaires : `StripeService.test.ts`
- ✅ Création/récupération de comptes
- ✅ Génération de liens d'onboarding
- ✅ Refresh de statut
- ✅ Gestion d'erreurs Stripe
- ✅ Mocks complets pour isolation

### Tests d'intégration : `stripeWebhook.test.ts`
- ✅ Vérification de signature
- ✅ Gestion des types d'événements
- ✅ Idempotence complète
- ✅ Formats de body multiples
- ✅ Gestion d'erreurs webhook

## 🎯 Démonstration

### Script de démo : `demo:stripe`
```bash
npm run demo:stripe
```

Le script démontre le flow complet :
1. **Création compte** + lien d'onboarding
2. **Simulation webhook** `account.updated`
3. **Refresh statut** du compte
4. **Simulation webhook** `payout.paid`

## 🔄 Flow utilisateur complet

### 1. Côté Frontend (tRPC)
```typescript
// 1. Créer le lien d'onboarding
const { onboardingUrl } = await trpc.stripe.createOnboardingLink.mutate({
  returnUrl: "https://app.foreas.fr/complete",
  refreshUrl: "https://app.foreas.fr/refresh"
});

// 2. Rediriger l'utilisateur vers onboardingUrl
window.location.href = onboardingUrl;

// 3. Après retour, vérifier le statut
const status = await trpc.stripe.refreshAccount.mutate({});
if (status.onboardingDone) {
  // ✅ Onboarding terminé !
}
```

### 2. Côté Backend (Webhooks)
```typescript
// Configuration Express pour webhook
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.post('/webhooks/stripe', handleStripeWebhook);
```

### 3. Événements Stripe automatiques
- `account.updated` → Met à jour le statut en base
- `payout.paid` → Log du virement réussi
- `payout.failed` → Log + notification d'échec

## ✅ Checklist de production

- [x] **Service isolé** avec gestion d'erreurs
- [x] **Validation Zod** sur tous les inputs/outputs
- [x] **Webhook sécurisé** avec vérification signature
- [x] **Idempotence** pour éviter les doublons
- [x] **Logging sécurisé** avec masquage des secrets
- [x] **Tests unitaires** et d'intégration
- [x] **Démo fonctionnelle** du flow complet
- [x] **Documentation complète**

## 🚀 Prêt pour la production !

L'intégration Stripe Connect est **complète et sécurisée**. Tous les composants sont testés et documentés. Le système gère :

- ✅ Onboarding automatique des chauffeurs
- ✅ Webhooks temps réel pour les mises à jour
- ✅ Idempotence et sécurité
- ✅ Logging et monitoring
- ✅ Gestion d'erreurs robuste

La prochaine étape serait de :
1. Configurer les webhooks Stripe en production
2. Tester avec de vrais comptes Stripe Connect
3. Intégrer le frontend React Native
4. Ajouter la gestion des notifications utilisateur