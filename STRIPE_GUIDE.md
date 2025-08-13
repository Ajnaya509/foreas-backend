# 💳 Guide Stripe Connect FOREAS

## 🎯 Architecture Stripe Connect

### Flux de Paiement FOREAS
```
Client Mobile → Stripe → Chauffeur (95%) + FOREAS (5%)
     ↓
Réservation Direct → Payment Intent → Webhook → Database
```

### Types de Comptes
- **FOREAS**: Compte plateforme principal
- **Chauffeurs**: Comptes Express Connect (onboarding rapide)
- **Clients**: Pas de compte, paiement par carte

## 🔧 Configuration

### 1. Variables d'environnement
```bash
# .env
STRIPE_SECRET_KEY="sk_test_51..."  # Clé secrète Stripe
STRIPE_WEBHOOK_SECRET="whsec_..."  # Endpoint: /api/webhooks/stripe
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..." # Frontend
```

### 2. Webhook Stripe
```
URL: https://votre-backend.com/api/webhooks/stripe
Événements à écouter:
✅ payment_intent.succeeded
✅ payment_intent.payment_failed  
✅ account.updated
✅ charge.dispute.created
✅ payout.paid
```

## 📱 Utilisation Frontend

### 1. Créer un compte chauffeur
```typescript
// Dans l'app React Native
const { mutate: createAccount } = trpc.stripe.createConnectAccount.useMutation();

const handleCreateStripeAccount = async () => {
  try {
    const result = await createAccount({
      email: "chauffeur@foreas.app",
      firstName: "Jean",
      lastName: "Dupont",
      phone: "0123456789",
    });
    
    // Rediriger vers l'onboarding Stripe
    Linking.openURL(result.onboardingUrl);
  } catch (error) {
    console.error("Erreur création compte:", error);
  }
};
```

### 2. Vérifier le statut du compte
```typescript
const { data: accountStatus } = trpc.stripe.getAccountStatus.useQuery();

if (!accountStatus?.isOnboarded) {
  // Afficher bouton "Terminer la configuration Stripe"
}
```

### 3. Créer un paiement pour réservation
```typescript
const { mutate: createPayment } = trpc.stripe.createPaymentIntent.useMutation();

const handlePayment = async (bookingId: string, amount: number) => {
  const paymentIntent = await createPayment({
    bookingId,
    amount: amount * 100, // Euros → Centimes
    description: "Course FOREAS",
  });
  
  // Utiliser Stripe Elements pour confirmer le paiement
  // avec paymentIntent.clientSecret
};
```

## 🔒 Sécurité Implémentée

### ✅ Authentification Stricte
- Seuls les chauffeurs authentifiés peuvent créer un compte
- Vérification du rôle et statut utilisateur
- Protection contre l'usurpation d'identité

### ✅ Validation des Montants
- Montant minimum: 5€ (500 centimes)
- Montant maximum: 1000€ (100000 centimes) 
- Calcul automatique de la commission FOREAS (5%)

### ✅ Webhooks Sécurisés
- Vérification signature Stripe obligatoire
- Idempotence des événements
- Gestion des erreurs avec retry automatique

### ✅ Traçabilité Complète
- Metadata sur tous les paiements
- Liaison bookingId ↔ paymentIntent
- Historique complet en base de données

## 💰 Gestion des Revenus

### Commission FOREAS: 5%
```typescript
// Exemple pour une course de 20€
const courseAmount = 2000; // 20€ en centimes
const platformFee = 100;   // 1€ commission FOREAS (5%)
const driverAmount = 1900; // 19€ pour le chauffeur
```

### Virements Automatiques
- **Fréquence**: Quotidienne
- **Délai**: J+2 pour les virements SEPA
- **Notifications**: Email + Push pour chaque virement

## 🚀 API Endpoints tRPC

### `stripe.createConnectAccount`
Crée un compte Stripe Connect pour un chauffeur
```typescript
Input: { email, firstName, lastName, phone? }
Output: { accountId, onboardingUrl, expiresAt }
```

### `stripe.getAccountStatus`
Récupère le statut d'onboarding du compte
```typescript
Output: { 
  hasAccount, 
  isOnboarded, 
  canAcceptPayments, 
  requirements[] 
}
```

### `stripe.createPaymentIntent`
Crée un paiement pour une réservation
```typescript
Input: { bookingId, amount, currency?, description? }
Output: { id, clientSecret, platformFee, netAmount }
```

### `stripe.getPaymentHistory`
Historique des paiements du chauffeur
```typescript
Input: { limit?, startingAfter? }
Output: { payments[], hasMore }
```

## 🔍 Tests & Debug

### Mode Test Stripe
```bash
# Utiliser les clés de test
STRIPE_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."

# Cartes de test Stripe
4242424242424242 # Visa réussie
4000000000000002 # Carte déclinée
4000000000009995 # Fonds insuffisants
```

### Logs à Surveiller
```bash
✅ Compte Stripe créé pour chauffeur@foreas.app: acct_123
💳 Payment Intent créé: pi_123 (2000¢)
📡 Webhook Stripe reçu: payment_intent.succeeded (evt_123)
💸 Virement effectué: 19.00€ → acct_123
```

## ⚠️ Points Critiques

1. **JAMAIS** stocker les clés Stripe côté client
2. **TOUJOURS** vérifier la signature des webhooks
3. **OBLIGATOIRE** gérer l'idempotence des événements
4. **CRITIQUE** valider les montants côté serveur
5. **ESSENTIEL** logger tous les événements financiers

## 📞 Support

En cas de problème:
1. Vérifier les logs backend
2. Consulter le dashboard Stripe
3. Vérifier les webhooks Stripe (tentatives/échecs)
4. Tester en mode sandbox avant production