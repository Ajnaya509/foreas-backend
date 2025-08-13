/**
 * Système de logs structurés FOREAS Driver
 * Compatible Sentry + monitoring production
 */

import { env, logConfig } from '@/config/environment';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  userId?: string;
  driverId?: string;
  requestId?: string;
  action?: string;
  metadata?: Record<string, any>;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class Logger {
  private shouldLog(level: LogLevel): boolean {
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(logConfig.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext, error?: Error): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    if (context) {
      entry.context = this.sanitizeContext(context);
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: logConfig.redactSensitiveData ? undefined : error.stack,
      };
    }

    return entry;
  }

  private sanitizeContext(context: LogContext): LogContext {
    if (!logConfig.redactSensitiveData) {
      return context;
    }

    const sanitized = { ...context };
    
    // Masquer les données sensibles en production
    if (sanitized.metadata) {
      const sensitiveKeys = ['password', 'token', 'secret', 'key', 'apiKey'];
      for (const key of sensitiveKeys) {
        if (sanitized.metadata[key]) {
          sanitized.metadata[key] = '[REDACTED]';
        }
      }
    }

    return sanitized;
  }

  private output(entry: LogEntry): void {
    if (logConfig.format === 'json') {
      console.log(JSON.stringify(entry));
    } else {
      const emoji = {
        debug: '🐛',
        info: '📋',
        warn: '⚠️',
        error: '❌',
      }[entry.level];

      console.log(
        `${emoji} [${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`,
        entry.context ? `\nContext: ${JSON.stringify(entry.context, null, 2)}` : '',
        entry.error ? `\nError: ${entry.error.name} - ${entry.error.message}` : ''
      );
    }

    // Envoyer à Sentry en production pour les erreurs
    if (entry.level === 'error' && env.SENTRY_DSN && global.Sentry) {
      global.Sentry.captureException(
        entry.error ? new Error(entry.error.message) : new Error(entry.message),
        {
          contexts: {
            foreas: entry.context,
          },
          tags: {
            level: entry.level,
            component: 'foreas-driver-backend',
          },
        }
      );
    }
  }

  debug(message: string, context?: LogContext): void {
    if (this.shouldLog('debug')) {
      this.output(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    if (this.shouldLog('info')) {
      this.output(this.formatMessage('info', message, context));
    }
  }

  warn(message: string, context?: LogContext, error?: Error): void {
    if (this.shouldLog('warn')) {
      this.output(this.formatMessage('warn', message, context, error));
    }
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (this.shouldLog('error')) {
      this.output(this.formatMessage('error', message, context, error));
    }
  }

  // Méthodes spécialisées pour FOREAS
  stripeEvent(eventType: string, accountId?: string, success = true): void {
    this.info(`Stripe ${eventType} ${success ? 'réussi' : 'échoué'}`, {
      action: `stripe_${eventType}`,
      metadata: { accountId, success },
    });
  }

  ajnayaAnalysis(driverId: string, analysisType: string, result: any): void {
    this.info(`Analyse Ajnaya ${analysisType} terminée`, {
      driverId,
      action: `ajnaya_${analysisType}`,
      metadata: { 
        score: result.score,
        confidence: result.confidence,
      },
    });
  }

  userAction(userId: string, action: string, details?: Record<string, any>): void {
    this.info(`Action utilisateur: ${action}`, {
      userId,
      action: `user_${action}`,
      metadata: details,
    });
  }

  securityEvent(message: string, context: LogContext, severity: 'low' | 'medium' | 'high' = 'medium'): void {
    const level = severity === 'high' ? 'error' : 'warn';
    this[level](`SÉCURITÉ: ${message}`, {
      ...context,
      action: 'security_event',
      metadata: { ...context.metadata, severity },
    });
  }
}

export const logger = new Logger();

// Middleware Express pour logs de requêtes
export const requestLogger = (req: any, res: any, next: any) => {
  const requestId = Math.random().toString(36).substring(7);
  req.requestId = requestId;

  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    
    logger[level](`${req.method} ${req.path}`, {
      requestId,
      action: 'http_request',
      metadata: {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
      },
    });
  });

  next();
};