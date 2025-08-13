'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Page de ré-authentification Stripe
 * URL: https://foreas.xyz/stripe/reauth
 * 
 * Utilisée quand le lien d'onboarding expire
 */
export default function StripeReauthPage() {
  const router = useRouter();

  useEffect(() => {
    // Redirection automatique vers l'app avec message
    setTimeout(() => {
      window.location.href = 'foreas://stripe/reauth?message=link_expired';
    }, 2000);
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-xl p-8 text-center">
        {/* Logo FOREAS */}
        <div className="mb-8">
          <div className="w-16 h-16 bg-orange-600 rounded-full mx-auto mb-4 flex items-center justify-center">
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Lien expiré</h1>
          <p className="text-sm text-gray-600">FOREAS Driver Payments</p>
        </div>

        {/* Message */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-orange-900 mb-4">Session expirée</h2>
          <p className="text-gray-700 mb-4">
            Votre lien de configuration Stripe a expiré. 
            Pas de souci, nous allons vous en générer un nouveau.
          </p>
          <p className="text-sm text-gray-600">
            Redirection vers l'application en cours...
          </p>
        </div>

        {/* Loading */}
        <div className="mb-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600 mx-auto"></div>
        </div>

        {/* Action manuelle */}
        <button
          onClick={() => window.location.href = 'foreas://stripe/reauth'}
          className="w-full bg-orange-600 text-white py-2 px-4 rounded-lg hover:bg-orange-700 transition-colors"
        >
          Ouvrir l'application
        </button>

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-gray-200">
          <p className="text-xs text-gray-500">
            Les liens d'onboarding Stripe expirent après 24h pour votre sécurité
          </p>
        </div>
      </div>
    </div>
  );
}