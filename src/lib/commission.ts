/**
 * Service de calcul des commissions FOREAS
 * 
 * MODÈLE ÉCONOMIQUE:
 * - Commission standard: 15% (vs 25% plateformes VTC)
 * - Commission premium: 10% (chauffeurs 5⭐ avec > 100 courses)
 * - Commission réduite: 5% (courses > 50€)
 * 
 * SPLITS AUTOMATIQUES:
 * - Chauffeur reçoit le montant net directement
 * - FOREAS reçoit la commission sur le compte plateforme
 */

export interface CommissionTier {
  name: string;
  percentage: number;
  minAmount?: number; // Montant minimum en centimes
  requirements?: {
    minRating?: number;
    minRides?: number;
    verified?: boolean;
  };
}

// Configuration des tiers de commission
export const COMMISSION_TIERS: CommissionTier[] = [
  {
    name: 'premium',
    percentage: 10, // 10% pour les chauffeurs premium
    requirements: {
      minRating: 4.8,
      minRides: 100,
      verified: true,
    },
  },
  {
    name: 'reduced_high_value',
    percentage: 5, // 5% pour les courses > 50€
    minAmount: 5000, // 50€ en centimes
  },
  {
    name: 'standard',
    percentage: 15, // 15% commission standard
  },
];

export interface CommissionCalculation {
  totalAmount: number; // Montant total en centimes
  commissionTier: string;
  commissionPercentage: number;
  commissionAmount: number; // Commission FOREAS en centimes
  netAmount: number; // Montant net chauffeur en centimes
  breakdown: {
    subtotal: number;
    commission: number;
    stripeProcessingFee: number; // Estimation frais Stripe (2.9% + 0.25€)
    driverReceives: number;
  };
}

/**
 * Calcule la commission optimale pour un chauffeur et un montant
 */
export function calculateCommission(
  amount: number, // Montant en centimes
  driverStats?: {
    totalRides?: number;
    averageRating?: number;
    isVerified?: boolean;
  }
): CommissionCalculation {
  // Trouver le tier de commission applicable
  const applicableTier = COMMISSION_TIERS.find(tier => {
    // Vérifier le montant minimum
    if (tier.minAmount && amount < tier.minAmount) {
      return false;
    }
    
    // Vérifier les requirements du chauffeur
    if (tier.requirements && driverStats) {
      const { minRating, minRides, verified } = tier.requirements;
      
      if (minRating && (driverStats.averageRating || 0) < minRating) {
        return false;
      }
      
      if (minRides && (driverStats.totalRides || 0) < minRides) {
        return false;
      }
      
      if (verified && !driverStats.isVerified) {
        return false;
      }
    }
    
    return true;
  }) || COMMISSION_TIERS[COMMISSION_TIERS.length - 1]; // Fallback sur standard

  const commissionPercentage = applicableTier.percentage;
  const commissionAmount = Math.round(amount * (commissionPercentage / 100));
  const netAmount = amount - commissionAmount;
  
  // Estimation des frais Stripe (2.9% + 0.25€)
  const stripeProcessingFee = Math.round(amount * 0.029 + 25); // 25 centimes

  return {
    totalAmount: amount,
    commissionTier: applicableTier.name,
    commissionPercentage,
    commissionAmount,
    netAmount,
    breakdown: {
      subtotal: amount,
      commission: commissionAmount,
      stripeProcessingFee,
      driverReceives: netAmount, // Le chauffeur reçoit le net, Stripe prend sa part sur la commission
    },
  };
}

/**
 * Valide qu'un montant est acceptable pour les paiements
 */
export function validatePaymentAmount(amount: number): {
  valid: boolean;
  error?: string;
  warnings?: string[];
} {
  const warnings: string[] = [];
  
  // Montant minimum: 5€
  if (amount < 500) {
    return {
      valid: false,
      error: 'Montant minimum: 5€'
    };
  }
  
  // Montant maximum: 500€ (limite réglementaire)
  if (amount > 50000) {
    return {
      valid: false,
      error: 'Montant maximum: 500€'
    };
  }
  
  // Avertissements
  if (amount > 10000) { // > 100€
    warnings.push('Montant élevé, vérification supplémentaire requise');
  }
  
  if (amount < 1000) { // < 10€
    warnings.push('Course de faible montant, commission standard appliquée');
  }
  
  return {
    valid: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Génère une description claire pour le client
 */
export function generatePaymentDescription(
  rideDetails: {
    from: string;
    to?: string;
    distance?: number;
    duration?: number;
    driverName?: string;
  },
  commission: CommissionCalculation
): string {
  const baseDescription = rideDetails.to 
    ? `Course ${rideDetails.from} → ${rideDetails.to}`
    : `Course depuis ${rideDetails.from}`;
    
  const details: string[] = [];
  
  if (rideDetails.distance) {
    details.push(`${rideDetails.distance.toFixed(1)}km`);
  }
  
  if (rideDetails.duration) {
    const minutes = Math.round(rideDetails.duration);
    details.push(`${minutes}min`);
  }
  
  if (rideDetails.driverName) {
    details.push(`avec ${rideDetails.driverName}`);
  }
  
  // Ajouter info commission si réduite
  if (commission.commissionTier === 'premium') {
    details.push('(Chauffeur Premium -10%)');
  } else if (commission.commissionTier === 'reduced_high_value') {
    details.push('(Course longue -5%)');
  }
  
  const detailsStr = details.length > 0 ? ` - ${details.join(', ')}` : '';
  
  return `${baseDescription}${detailsStr} • FOREAS`;
}

/**
 * Types pour l'export
 */
export interface PaymentSplitData {
  totalAmount: number;
  applicationFeeAmount: number;
  transferDestination: string;
  description: string;
  metadata: Record<string, string>;
  commission: CommissionCalculation;
}

/**
 * Prépare les données pour le PaymentIntent Stripe
 */
export function preparePaymentSplit(
  amount: number,
  driverAccountId: string,
  rideDetails: {
    bookingId?: string;
    driverId: string;
    clientId: string;
    from: string;
    to?: string;
    distance?: number;
    duration?: number;
    driverName?: string;
  },
  driverStats?: {
    totalRides?: number;
    averageRating?: number;
    isVerified?: boolean;
  }
): PaymentSplitData {
  const commission = calculateCommission(amount, driverStats);
  const description = generatePaymentDescription(rideDetails, commission);
  
  return {
    totalAmount: amount,
    applicationFeeAmount: commission.commissionAmount,
    transferDestination: driverAccountId,
    description,
    metadata: {
      bookingId: rideDetails.bookingId || '',
      driverId: rideDetails.driverId,
      clientId: rideDetails.clientId,
      commissionTier: commission.commissionTier,
      commissionPercentage: commission.commissionPercentage.toString(),
      platform: 'FOREAS_DIRECT',
      version: '2.0',
    },
    commission,
  };
}