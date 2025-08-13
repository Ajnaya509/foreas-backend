# FOREAS Driver Backend - API Examples

Ce document présente des exemples concrets de requêtes cURL et configurations Postman pour tester tous les endpoints de l'API tRPC.

## Configuration de base

**URL de base:** `http://localhost:3000`
**Endpoint tRPC:** `/trpc`
**Content-Type:** `application/json`

## Headers requis

### Authentification en développement
```
X-Dev-User: test_user_123
```

## Endpoints système

### 1. Health Check
```bash
curl -X GET http://localhost:3000/health
```

**Postman:** `GET http://localhost:3000/health`

### 2. API Info
```bash
curl -X GET http://localhost:3000/
```

## Endpoints tRPC

### Auth Router

#### 1. Login avec email/mot de passe
```bash
curl -X POST http://localhost:3000/trpc/auth.loginWithEmail \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "email": "jean.martin@foreas.app",
      "password": "MonMotDePasse123!"
    }
  }'
```

**Postman:**
- Method: `POST`
- URL: `http://localhost:3000/trpc/auth.loginWithEmail`
- Body (JSON):
```json
{
  "json": {
    "email": "jean.martin@foreas.app",
    "password": "MonMotDePasse123!"
  }
}
```

#### 2. Login déclenchant OTP
```bash
curl -X POST http://localhost:3000/trpc/auth.loginWithEmail \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "email": "driver.with.otp@foreas.app",
      "password": "MotDePasseSecure456!"
    }
  }'
```

#### 3. Validation OTP
```bash
curl -X POST http://localhost:3000/trpc/auth.consumeOtp \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "otpSessionId": "otp_session_abc123",
      "code": "123456"
    }
  }'
```

### Profile Router

#### 1. Récupérer le profil
```bash
curl -X POST http://localhost:3000/trpc/profile.get \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123"
```

**Postman:**
- Method: `POST`
- URL: `http://localhost:3000/trpc/profile.get`
- Headers:
  - `Content-Type: application/json`
  - `X-Dev-User: test_user_123`

#### 2. Mettre à jour le profil
```bash
curl -X POST http://localhost:3000/trpc/profile.update \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "name": "Jean Martin Updated",
      "phone": "+33987654321",
      "driver": {
        "companyName": "Jean Martin VTC Premium",
        "bio": "Chauffeur VTC expérimenté depuis 5 ans"
      }
    }
  }'
```

#### 3. Définir le statut en ligne
```bash
curl -X POST http://localhost:3000/trpc/profile.setOnline \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "isOnline": true,
      "location": {
        "lat": 48.8566,
        "lng": 2.3522,
        "address": "Place du Châtelet, Paris"
      }
    }
  }'
```

### Trips Router

#### 1. Lister les courses avec pagination
```bash
curl -X POST http://localhost:3000/trpc/trips.list \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "page": 1,
      "limit": 10,
      "sortBy": "requestedAt",
      "sortOrder": "desc",
      "filters": {
        "platform": "UBER",
        "status": "COMPLETED",
        "dateRange": {
          "from": "2024-01-01T00:00:00.000Z",
          "to": "2024-12-31T23:59:59.999Z"
        }
      }
    }
  }'
```

#### 2. Créer une course manuelle
```bash
curl -X POST http://localhost:3000/trpc/trips.createManual \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "platform": "FOREAS_DIRECT",
      "pickupAddress": "15 Rue de la Paix, Paris",
      "dropoffAddress": "Aéroport Charles de Gaulle, Roissy",
      "distance": 35.2,
      "duration": 45,
      "finalPrice": 65.00,
      "clientName": "Marie Dupont",
      "clientPhone": "+33123456789",
      "paymentMethod": "STRIPE",
      "notes": "Vol Air France 15h30"
    }
  }'
```

#### 3. Statistiques des courses
```bash
curl -X POST http://localhost:3000/trpc/trips.stats \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "period": "month",
      "groupBy": "platform",
      "dateRange": {
        "from": "2024-01-01T00:00:00.000Z",
        "to": "2024-01-31T23:59:59.999Z"
      }
    }
  }'
```

### Insights Router

#### 1. Insights actuels
```bash
curl -X POST http://localhost:3000/trpc/insights.current \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "location": {
        "lat": 48.8566,
        "lng": 2.3522
      },
      "weather": {
        "condition": "rainy",
        "temperature": 15,
        "humidity": 80
      },
      "timeContext": {
        "hour": 18,
        "dayOfWeek": 5,
        "isRushHour": true
      },
      "limit": 10
    }
  }'
```

#### 2. Score d'une course
```bash
curl -X POST http://localhost:3000/trpc/insights.scoreTrip \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "platform": "UBER",
      "pickupAddress": "1 Place de la Bastille, Paris",
      "pickupLat": 48.8532,
      "pickupLng": 2.3692,
      "dropoffAddress": "15 Avenue des Champs-Élysées, Paris",
      "dropoffLat": 48.8698,
      "dropoffLng": 2.3076,
      "estimatedFare": 22.50,
      "surge": 1.2,
      "clientRating": 4.6,
      "currentLocation": {
        "lat": 48.8566,
        "lng": 2.3522
      }
    }
  }'
```

### Zones Router

#### 1. Zones recommandées
```bash
curl -X POST http://localhost:3000/trpc/zones.current \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "location": {
        "lat": 48.8566,
        "lng": 2.3522
      },
      "radius": 10,
      "maxResults": 5,
      "minDemand": "MEDIUM",
      "types": ["TRANSPORT_HUB", "BUSINESS"],
      "weather": {
        "condition": "rainy",
        "temperature": 15
      },
      "timeContext": {
        "hour": 18,
        "dayOfWeek": 5,
        "isHoliday": false
      },
      "preferences": {
        "maximizeEarnings": true,
        "avoidTraffficJams": true
      }
    }
  }'
```

### Stripe Router

#### 1. Créer un lien d'onboarding
```bash
curl -X POST http://localhost:3000/trpc/stripe.createOnboardingLink \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "returnUrl": "https://app.foreas.com/dashboard?onboarding=success",
      "refreshUrl": "https://app.foreas.com/stripe/refresh"
    }
  }'
```

#### 2. Statut du compte Stripe
```bash
curl -X POST http://localhost:3000/trpc/stripe.getAccountStatus \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123"
```

#### 3. Rafraîchir les données Stripe
```bash
curl -X POST http://localhost:3000/trpc/stripe.refreshAccount \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123"
```

## Collection Postman

### Configuration d'environnement
Créez un environnement Postman avec les variables suivantes :

```json
{
  "baseUrl": "http://localhost:3000",
  "trpcUrl": "{{baseUrl}}/trpc",
  "devUserId": "test_user_123",
  "contentType": "application/json"
}
```

### Pre-request Script global
Pour ajouter automatiquement les headers requis :

```javascript
pm.request.headers.add({
    key: 'Content-Type',
    value: 'application/json'
});

pm.request.headers.add({
    key: 'X-Dev-User',
    value: pm.environment.get('devUserId')
});
```

## Gestion des erreurs

### Erreur de validation Zod
```bash
# Exemple avec des données invalides
curl -X POST http://localhost:3000/trpc/auth.loginWithEmail \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "email": "not-an-email",
      "password": "123"
    }
  }'
```

**Réponse attendue:**
```json
{
  "error": {
    "message": "Validation failed",
    "code": "BAD_REQUEST",
    "data": {
      "zodError": {
        "fieldErrors": {
          "email": ["Invalid email"],
          "password": ["String must contain at least 8 character(s)"]
        }
      }
    }
  }
}
```

### Erreur d'autorisation
```bash
# Requête sans header X-Dev-User
curl -X POST http://localhost:3000/trpc/profile.get \
  -H "Content-Type: application/json"
```

**Réponse attendue:**
```json
{
  "error": {
    "message": "UNAUTHORIZED",
    "code": "UNAUTHORIZED"
  }
}
```

## Tests automatisés

### Script de test avec curl
```bash
#!/bin/bash
BASE_URL="http://localhost:3000"
USER_ID="test_user_123"

echo "Testing FOREAS Driver Backend API..."

# Test health check
echo "1. Health check..."
curl -s -X GET $BASE_URL/health | jq .

# Test profile
echo "2. Profile..."
curl -s -X POST $BASE_URL/trpc/profile.get \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: $USER_ID" | jq .

# Test login
echo "3. Login..."
curl -s -X POST $BASE_URL/trpc/auth.loginWithEmail \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "email": "jean.martin@foreas.app",
      "password": "MonMotDePasse123!"
    }
  }' | jq .

echo "All tests completed!"
```

## Notes importantes

1. **Authentification**: En développement, utilisez le header `X-Dev-User` avec un ID utilisateur
2. **Format des données**: Toutes les données doivent être encapsulées dans un objet `json`
3. **Validation**: Toutes les entrées sont validées avec Zod selon les schémas définis
4. **Erreurs**: Les erreurs suivent le format tRPC standard avec codes d'erreur HTTP appropriés
5. **CORS**: L'API accepte les requêtes depuis tous les domaines en développement

Pour plus de détails sur la structure des réponses, consultez les tests d'intégration dans `src/__tests__/trpc-integration.test.ts`.