'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Page de retour après configuration Stripe Connect
 * URL: https://foreas.xyz/stripe/success
 * 
 * PARAMÈTRES REÇUS:
 * - account: Account ID Stripe (acct_xxxxx)
 * - state: Token de sécurité (optionnel)
 * 
 * ACTIONS:
 * - Récupérer l'account ID depuis l'URL
 * - Synchroniser avec la base de données
 * - Vérifier le statut d'onboarding
 * - Rediriger vers l'app mobile
 */
export default function StripeSuccessPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Finalisation de votre compte Stripe...');

  useEffect(() => {
    handleStripeReturn();
  }, []);

  const handleStripeReturn = async () => {
    try {
      // Récupérer l'account ID depuis les paramètres URL
      const accountId = searchParams?.get('account');
      const state = searchParams?.get('state');

      console.log('🔄 Stripe return:', { accountId, state });

      if (!accountId) {
        throw new Error('Account ID manquant dans l\'URL de retour');
      }

      // Vérifier le format de l'account ID
      if (!accountId.startsWith('acct_')) {
        throw new Error('Format d\'account ID invalide');
      }

      setMessage('Synchronisation avec votre profil...');

      // Appeler l'API de synchronisation
      const response = await fetch('/api/stripe/sync-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accountId,
          state,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Erreur lors de la synchronisation');
      }

      console.log('✅ Synchronisation réussie:', result);

      setStatus('success');
      setMessage('Compte Stripe configuré avec succès !');

      // Attendre 2 secondes puis rediriger vers l'app mobile
      setTimeout(() => {
        // Redirection vers l'app mobile avec deep linking
        window.location.href = 'foreas://stripe/success?status=completed';
      }, 2000);

    } catch (error: any) {
      console.error('❌ Erreur synchronisation Stripe:', error);
      setStatus('error');
      setMessage(error.message || 'Une erreur est survenue');

      // Redirection vers l'app avec erreur après 3 secondes
      setTimeout(() => {
        window.location.href = `foreas://stripe/error?message=${encodeURIComponent(error.message)}`;
      }, 3000);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-xl p-8 text-center">
        {/* Logo FOREAS */}
        <div className="mb-8">
          <div className="w-16 h-16 bg-purple-600 rounded-full mx-auto mb-4 flex items-center justify-center">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4zM18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">FOREAS</h1>
          <p className="text-sm text-gray-600">Driver Payments</p>
        </div>

        {/* Statut */}
        <div className="mb-8">
          {status === 'loading' && (
            <div className="space-y-4">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
              <h2 className="text-xl font-semibold text-gray-900">Configuration en cours</h2>
              <p className="text-gray-600">{message}</p>
            </div>
          )}

          {status === 'success' && (
            <div className="space-y-4">
              <div className="rounded-full h-12 w-12 bg-green-100 mx-auto flex items-center justify-center">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-green-900">Succès !</h2>
              <p className="text-green-700">{message}</p>
              <p className="text-sm text-gray-600">Redirection vers l'application...</p>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-4">
              <div className="rounded-full h-12 w-12 bg-red-100 mx-auto flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-red-900">Erreur</h2>
              <p className="text-red-700">{message}</p>
              <p className="text-sm text-gray-600">Redirection vers l'application...</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-3">
          {status === 'error' && (
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 transition-colors"
            >
              Réessayer
            </button>
          )}
          
          <button
            onClick={() => window.location.href = 'foreas://home'}
            className="w-full bg-gray-100 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Retour à l'application
          </button>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-gray-200">
          <p className="text-xs text-gray-500">
            Sécurisé par Stripe • FOREAS Driver v1.0
          </p>
        </div>
      </div>
    </div>
  );
}