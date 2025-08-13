/**
 * Système de gestion d'erreurs centralisé FOREAS Driver
 * Erreurs typées avec codes standardisés pour le frontend
 */

export enum ErrorCode {
  // Authentification
  AUTH_INVALID_CREDENTIALS = 'AUTH_INVALID_CREDENTIALS',
  AUTH_SESSION_EXPIRED = 'AUTH_SESSION_EXPIRED',
  AUTH_INSUFFICIENT_PERMISSIONS = 'AUTH_INSUFFICIENT_PERMISSIONS',
  
  // Stripe
  STRIPE_ACCOUNT_NOT_FOUND = 'STRIPE_ACCOUNT_NOT_FOUND',
  STRIPE_ACCOUNT_NOT_ONBOARDED = 'STRIPE_ACCOUNT_NOT_ONBOARDED',
  STRIPE_PAYMENT_FAILED = 'STRIPE_PAYMENT_FAILED',
  STRIPE_WEBHOOK_INVALID = 'STRIPE_WEBHOOK_INVALID',
  STRIPE_CONNECT_ERROR = 'STRIPE_CONNECT_ERROR',
  
  // Ajnaya IA
  AJNAYA_ANALYSIS_FAILED = 'AJNAYA_ANALYSIS_FAILED',
  AJNAYA_INSUFFICIENT_DATA = 'AJNAYA_INSUFFICIENT_DATA',
  AJNAYA_FEEDBACK_INVALID = 'AJNAYA_FEEDBACK_INVALID',
  
  // Business Logic
  DRIVER_PROFILE_INCOMPLETE = 'DRIVER_PROFILE_INCOMPLETE',
  BOOKING_NOT_FOUND = 'BOOKING_NOT_FOUND',
  BOOKING_ALREADY_ACCEPTED = 'BOOKING_ALREADY_ACCEPTED',
  RIDE_STATUS_INVALID = 'RIDE_STATUS_INVALID',
  
  // External APIs
  PLATFORM_API_UNAVAILABLE = 'PLATFORM_API_UNAVAILABLE',
  WEATHER_API_ERROR = 'WEATHER_API_ERROR',
  GEOCODING_FAILED = 'GEOCODING_FAILED',
  
  // System
  DATABASE_ERROR = 'DATABASE_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
}

export interface ErrorDetails {
  code: ErrorCode;
  message: string;
  userMessage: string; // Message friendly pour l'utilisateur
  statusCode: number;
  retryable: boolean;
  context?: Record<string, any>;
}

export class ForeacError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly userMessage: string;
  public readonly retryable: boolean;
  public readonly context?: Record<string, any>;

  constructor(details: ErrorDetails) {
    super(details.message);
    this.name = 'ForeacError';
    this.code = details.code;
    this.statusCode = details.statusCode;
    this.userMessage = details.userMessage;
    this.retryable = details.retryable;
    this.context = details.context;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      statusCode: this.statusCode,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

// Factory pour créer des erreurs typées
export const createError = {
  auth: {
    invalidCredentials: (context?: Record<string, any>) => new ForeасError({
      code: ErrorCode.AUTH_INVALID_CREDENTIALS,
      message: 'Invalid credentials provided',
      userMessage: 'Email ou mot de passe incorrect',
      statusCode: 401,
      retryable: true,
      context,
    }),

    sessionExpired: (context?: Record<string, any>) => new ForeасError({
      code: ErrorCode.AUTH_SESSION_EXPIRED,
      message: 'Session has expired',
      userMessage: 'Votre session a expiré, veuillez vous reconnecter',
      statusCode: 401,
      retryable: false,
      context,
    }),

    insufficientPermissions: (context?: Record<string, any>) => new ForeасError({
      code: ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
      message: 'Insufficient permissions for this operation',
      userMessage: 'Vous n\'avez pas les permissions pour cette action',
      statusCode: 403,
      retryable: false,
      context,
    }),
  },

  stripe: {
    accountNotFound: (accountId: string) => new ForeacError({
      code: ErrorCode.STRIPE_ACCOUNT_NOT_FOUND,
      message: `Stripe account ${accountId} not found`,
      userMessage: 'Compte Stripe introuvable',
      statusCode: 404,
      retryable: false,
      context: { accountId },
    }),

    accountNotOnboarded: (accountId: string) => new ForeacError({
      code: ErrorCode.STRIPE_ACCOUNT_NOT_ONBOARDED,
      message: `Stripe account ${accountId} onboarding incomplete`,
      userMessage: 'Configuration Stripe incomplète. Veuillez finaliser votre inscription.',
      statusCode: 402,
      retryable: false,
      context: { accountId },
    }),

    paymentFailed: (paymentIntentId: string, reason?: string) => new ForeacError({
      code: ErrorCode.STRIPE_PAYMENT_FAILED,
      message: `Payment failed for ${paymentIntentId}: ${reason}`,
      userMessage: 'Le paiement a échoué. Veuillez réessayer.',
      statusCode: 402,
      retryable: true,
      context: { paymentIntentId, reason },
    }),

    webhookInvalid: (signature?: string) => new ForeacError({
      code: ErrorCode.STRIPE_WEBHOOK_INVALID,
      message: 'Invalid Stripe webhook signature',
      userMessage: 'Erreur de synchronisation Stripe',
      statusCode: 400,
      retryable: false,
      context: { signature },
    }),

    connectError: (operation: string, details?: any) => new ForeacError({
      code: ErrorCode.STRIPE_CONNECT_ERROR,
      message: `Stripe Connect error during ${operation}`,
      userMessage: 'Erreur de connexion Stripe. Réessayez dans quelques minutes.',
      statusCode: 503,
      retryable: true,
      context: { operation, details },
    }),
  },

  ajnaya: {
    analysisFailed: (analysisType: string, reason?: string) => new ForeacError({
      code: ErrorCode.AJNAYA_ANALYSIS_FAILED,
      message: `Ajnaya ${analysisType} analysis failed: ${reason}`,
      userMessage: 'Analyse Ajnaya temporairement indisponible',
      statusCode: 503,
      retryable: true,
      context: { analysisType, reason },
    }),

    insufficientData: (dataType: string, required: number, available: number) => new ForeacError({
      code: ErrorCode.AJNAYA_INSUFFICIENT_DATA,
      message: `Insufficient ${dataType} data: need ${required}, have ${available}`,
      userMessage: 'Données insuffisantes pour l\'analyse. Continuez à utiliser l\'app pour améliorer les prédictions.',
      statusCode: 412,
      retryable: false,
      context: { dataType, required, available },
    }),

    feedbackInvalid: (feedbackId: string, reason: string) => new ForeacError({
      code: ErrorCode.AJNAYA_FEEDBACK_INVALID,
      message: `Invalid feedback ${feedbackId}: ${reason}`,
      userMessage: 'Format de feedback invalide',
      statusCode: 400,
      retryable: false,
      context: { feedbackId, reason },
    }),
  },

  business: {
    driverProfileIncomplete: (missingFields: string[]) => new ForeacError({
      code: ErrorCode.DRIVER_PROFILE_INCOMPLETE,
      message: `Driver profile incomplete: missing ${missingFields.join(', ')}`,
      userMessage: 'Veuillez compléter votre profil chauffeur',
      statusCode: 412,
      retryable: false,
      context: { missingFields },
    }),

    bookingNotFound: (bookingId: string) => new ForeacError({
      code: ErrorCode.BOOKING_NOT_FOUND,
      message: `Booking ${bookingId} not found`,
      userMessage: 'Réservation introuvable',
      statusCode: 404,
      retryable: false,
      context: { bookingId },
    }),

    bookingAlreadyAccepted: (bookingId: string) => new ForeacError({
      code: ErrorCode.BOOKING_ALREADY_ACCEPTED,
      message: `Booking ${bookingId} already accepted`,
      userMessage: 'Cette réservation a déjà été acceptée',
      statusCode: 409,
      retryable: false,
      context: { bookingId },
    }),
  },

  system: {
    databaseError: (operation: string, error: Error) => new ForeacError({
      code: ErrorCode.DATABASE_ERROR,
      message: `Database error during ${operation}: ${error.message}`,
      userMessage: 'Erreur temporaire. Veuillez réessayer.',
      statusCode: 503,
      retryable: true,
      context: { operation, originalError: error.name },
    }),

    validationError: (field: string, value: any, rule: string) => new ForeacError({
      code: ErrorCode.VALIDATION_ERROR,
      message: `Validation error: ${field} with value ${value} failed rule ${rule}`,
      userMessage: `Le champ ${field} n'est pas valide`,
      statusCode: 400,
      retryable: false,
      context: { field, value, rule },
    }),

    rateLimitExceeded: (operation: string, limit: number) => new ForeacError({
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
      message: `Rate limit exceeded for ${operation}: ${limit} requests per minute`,
      userMessage: 'Trop de requêtes. Veuillez patienter avant de réessayer.',
      statusCode: 429,
      retryable: true,
      context: { operation, limit },
    }),

    internalServerError: (context?: Record<string, any>) => new ForeacError({
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      userMessage: 'Une erreur inattendue s\'est produite',
      statusCode: 500,
      retryable: true,
      context,
    }),
  },
};

// Middleware Express pour gestion centralisée des erreurs
export const errorHandler = (error: any, req: any, res: any, next: any) => {
  // Logger l'erreur
  const context = {
    requestId: req.requestId,
    userId: req.user?.id,
    path: req.path,
    method: req.method,
  };

  if (error instanceof ForeacError) {
    logger.warn(`FOREAS Error: ${error.message}`, context, error);
    
    return res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.userMessage,
        retryable: error.retryable,
        context: error.context,
      },
    });
  } else {
    // Erreur non typée - logs détaillés et réponse générique
    logger.error('Unhandled error', context, error);
    
    const genericError = createError.system.internalServerError(context);
    return res.status(500).json({
      error: {
        code: genericError.code,
        message: genericError.userMessage,
        retryable: true,
      },
    });
  }
};