'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/**
 * Page d'erreur après configuration Stripe Connect
 * URL: https://foreas.xyz/stripe/error
 */
export default function StripeErrorPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [errorMessage, setErrorMessage] = useState('Une erreur est survenue');

  useEffect(() => {
    const message = searchParams?.get('message');
    if (message) {
      setErrorMessage(decodeURIComponent(message));
    }
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-xl p-8 text-center">
        {/* Logo FOREAS */}
        <div className="mb-8">
          <div className="w-16 h-16 bg-red-600 rounded-full mx-auto mb-4 flex items-center justify-center">
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Configuration interrompue</h1>
          <p className="text-sm text-gray-600">FOREAS Driver Payments</p>
        </div>

        {/* Erreur */}
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-red-900 mb-4">Configuration annulée</h2>
          <p className="text-gray-700 mb-4">{errorMessage}</p>
          <p className="text-sm text-gray-600">
            Vous pouvez réessayer à tout moment depuis l'application.
          </p>
        </div>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={() => window.location.href = 'foreas://stripe/retry'}
            className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 transition-colors"
          >
            Réessayer la configuration
          </button>
          
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
            Besoin d'aide ? Contactez le support FOREAS
          </p>
        </div>
      </div>
    </div>
  );
}