# FOREAS Driver Backend - API Examples

Exemples de requêtes cURL et Postman pour tester l'API tRPC.

## Configuration de base

- **URL**: `http://localhost:3000`
- **Endpoint tRPC**: `/trpc`
- **Header d'auth (dev)**: `X-Dev-User: test_user_123`

## Exemples cURL

### 1. Health Check
```bash
curl -X GET http://localhost:3000/health
```

### 2. Auth - Login
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

### 3. Auth - OTP
```bash
curl -X POST http://localhost:3000/trpc/auth.consumeOtp \
  -H "Content-Type: application/json" \
  -d '{
    "json": {
      "otpSessionId": "session_123",
      "code": "123456"
    }
  }'
```

### 4. Profile - Get
```bash
curl -X POST http://localhost:3000/trpc/profile.get \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123"
```

### 5. Profile - Update
```bash
curl -X POST http://localhost:3000/trpc/profile.update \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "name": "Jean Martin Updated"
    }
  }'
```

### 6. Profile - Set Online
```bash
curl -X POST http://localhost:3000/trpc/profile.setOnline \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "isOnline": true,
      "location": {
        "lat": 48.8566,
        "lng": 2.3522
      }
    }
  }'
```

### 7. Trips - List
```bash
curl -X POST http://localhost:3000/trpc/trips.list \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "page": 1,
      "limit": 10
    }
  }'
```

### 8. Trips - Create Manual
```bash
curl -X POST http://localhost:3000/trpc/trips.createManual \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "platform": "FOREAS_DIRECT",
      "pickupAddress": "Place de la République, Paris",
      "dropoffAddress": "Gare du Nord, Paris",
      "finalPrice": 25.50
    }
  }'
```

### 9. Trips - Stats
```bash
curl -X POST http://localhost:3000/trpc/trips.stats \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "period": "month"
    }
  }'
```

### 10. Insights - Current
```bash
curl -X POST http://localhost:3000/trpc/insights.current \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "location": {
        "lat": 48.8566,
        "lng": 2.3522
      }
    }
  }'
```

### 11. Insights - Score Trip
```bash
curl -X POST http://localhost:3000/trpc/insights.scoreTrip \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "platform": "UBER",
      "estimatedFare": 25.00,
      "pickupLat": 48.8566,
      "pickupLng": 2.3522
    }
  }'
```

### 12. Stripe - Create Onboarding Link
```bash
curl -X POST http://localhost:3000/trpc/stripe.createOnboardingLink \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {
      "returnUrl": "https://app.foreas.com/onboarding/success",
      "refreshUrl": "https://app.foreas.com/onboarding/refresh"
    }
  }'
```

### 13. Stripe - Refresh Account
```bash
curl -X POST http://localhost:3000/trpc/stripe.refreshAccount \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: test_user_123" \
  -d '{
    "json": {}
  }'
```

### 14. Zones - Current
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
      "radius": 10
    }
  }'
```

## Configuration Postman

### Environment Variables
```json
{
  "baseUrl": "http://localhost:3000",
  "trpcUrl": "{{baseUrl}}/trpc",
  "devUserId": "test_user_123"
}
```

### Pre-request Script Global
```javascript
pm.request.headers.add({
    key: 'Content-Type',
    value: 'application/json'
});

// Ajouter l'auth header pour les endpoints protégés
if (pm.request.url.path.includes('profile') || 
    pm.request.url.path.includes('trips') ||
    pm.request.url.path.includes('insights') ||
    pm.request.url.path.includes('zones') ||
    pm.request.url.path.includes('stripe')) {
    pm.request.headers.add({
        key: 'X-Dev-User',
        value: pm.environment.get('devUserId')
    });
}
```

## Test Script
```bash
#!/bin/bash
BASE_URL="http://localhost:3000"
USER_ID="test_user_123"

echo "Testing FOREAS Driver tRPC API..."

echo "1. Health Check"
curl -s $BASE_URL/health | jq

echo -e "\n2. Profile Get"
curl -s -X POST $BASE_URL/trpc/profile.get \
  -H "Content-Type: application/json" \
  -H "X-Dev-User: $USER_ID" | jq

echo -e "\n3. Login"
curl -s -X POST $BASE_URL/trpc/auth.loginWithEmail \
  -H "Content-Type: application/json" \
  -d '{"json":{"email":"jean.martin@foreas.app","password":"MonMotDePasse123!"}}' | jq

echo -e "\nAll tests completed!"
```

## Notes importantes

1. **Format des données**: Toutes les données doivent être dans un objet `json`
2. **Authentification**: Header `X-Dev-User` requis pour les endpoints protégés
3. **Validation**: Toutes les entrées/sorties sont validées avec Zod
4. **Erreurs**: Format tRPC standard avec codes HTTP appropriés