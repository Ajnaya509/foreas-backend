#!/bin/bash

echo "🚀 Déploiement FOREAS Backend sur Railway"
echo "============================================="

# Initialiser le projet
echo "📝 Initialisation du projet..."
railway init --service foreas-stripe-backend

# Configurer les variables d'environnement
echo "🔧 Configuration des variables..."
railway variables set \
STRIPE_SECRET_KEY="YOUR_STRIPE_SECRET_KEY" \
PRICE_ID="YOUR_PRICE_ID" \
SUCCESS_URL="https://foreas-driver.app/success" \
CANCEL_URL="https://foreas-driver.app/cancel" \
PORT=8080

# Déployer
echo "🚀 Déploiement en cours..."
railway up

echo "✅ Déploiement terminé !"
echo "📱 N'oubliez pas de mettre à jour EXPO_PUBLIC_BACKEND_URL dans l'app"