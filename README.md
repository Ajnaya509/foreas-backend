# FOREAS Driver - Backend Stripe

Backend Node.js/Express pour gestion des abonnements Stripe de l'application FOREAS Driver.

## 🚀 Déploiement sur Render.com

### Variables d'environnement requises :
- `STRIPE_SECRET_KEY` : Clé secrète Stripe (test ou production)
- `PRICE_ID` : ID du prix Stripe pour l'abonnement
- `SUCCESS_URL` : URL de redirection après paiement réussi
- `CANCEL_URL` : URL de redirection après annulation
- `PORT` : Port d'écoute (10000 pour Render)

### Configuration Render :
- **Build Command** : `npm install`
- **Start Command** : `npm start`
- **Health Check Path** : `/health`

## 📱 API Endpoints

### `POST /create-checkout-session`
Crée une session Stripe Checkout pour abonnement avec essai gratuit 3 jours.

**Body :**
```json
{
  "email": "user@example.com"
}
```

**Response :**
```json
{
  "url": "https://checkout.stripe.com/pay/..."
}
```

### `GET /health`
Point de santé pour monitoring.

**Response :**
```json
{
  "ok": true
}
```

## 🔧 Développement Local

```bash
npm install
npm run dev
```

Server accessible sur http://localhost:4242