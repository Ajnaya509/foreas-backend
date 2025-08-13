# 🔐 Environment Configuration - FOREAS Driver Backend

## 📋 Required Environment Variables

This backend requires specific environment variables to function properly. All variables are validated at startup using Zod schemas to ensure type safety and prevent runtime errors.

## 🚀 Quick Start

1. Copy the example environment file:
```bash
cp .env.example .env.local
```

2. Fill in your actual values in `.env.local`

3. Never commit `.env.local` to version control

## 📝 Environment Variables Reference

### Database Configuration

| Variable | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `DATABASE_URL` | URL | ✅ | PostgreSQL connection string | `postgresql://user:pass@localhost:5432/db` |

### Stripe Configuration

| Variable | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | String | ✅ | Stripe secret key (starts with `sk_`) | `sk_test_51234...` |
| `STRIPE_WEBHOOK_SECRET` | String | ✅ | Stripe webhook endpoint secret (starts with `whsec_`) | `whsec_abc123...` |

### Application URLs

| Variable | Type | Required | Description | Example |
|----------|------|----------|-------------|---------|
| `APP_ORIGIN` | URL | ✅ | Base URL of your application (no trailing slash) | `https://app.foreas.com` |
| `RETURN_URL` | URL | ✅ | Stripe Connect return URL | `https://app.foreas.com/stripe/return` |
| `REFRESH_URL` | URL | ✅ | Stripe Connect refresh URL | `https://app.foreas.com/stripe/refresh` |

### Optional Configuration

| Variable | Type | Required | Description | Default | Example |
|----------|------|----------|-------------|---------|---------|
| `NODE_ENV` | Enum | ❌ | Environment mode (`development`, `test`, `production`) | `development` | `production` |
| `PORT` | Number | ❌ | Server port | `3000` | `8080` |
| `SENTRY_DSN` | URL | ❌ | Sentry error tracking DSN | - | `https://xxx@sentry.io/xxx` |

## 🛡️ Security Best Practices

### DO's ✅
- Store sensitive values in `.env.local` only
- Use different values for development, staging, and production
- Rotate keys regularly
- Use strong, randomly generated secrets
- Keep `.env.example` updated with new variables (without real values)

### DON'T's ❌
- Never commit `.env` or `.env.local` files
- Never log environment variables in production
- Never expose secrets in error messages
- Never use production keys in development
- Never share secrets via email or chat

## 🔍 Validation

All environment variables are validated at startup using the schema defined in `src/env.ts`:

```typescript
import { env } from '@/env';

// Use validated environment variables
console.log(env.DATABASE_URL); // Type-safe, guaranteed to exist
console.log(env.SENTRY_DSN);   // Type-safe, may be undefined
```

### Validation Rules

- **DATABASE_URL**: Must be a valid URL starting with `postgresql://`
- **STRIPE_SECRET_KEY**: Must start with `sk_test_` or `sk_live_`
- **STRIPE_WEBHOOK_SECRET**: Must start with `whsec_`
- **APP_ORIGIN**: Must be a valid URL
- **RETURN_URL**: Must be a valid URL
- **REFRESH_URL**: Must be a valid URL
- **SENTRY_DSN**: If provided, must be a valid URL
- **NODE_ENV**: Must be `development`, `test`, or `production`
- **PORT**: If provided, must be a positive number ≤ 65535

## 🚨 Troubleshooting

### Application won't start

If the application fails to start with environment validation errors:

1. Check that all required variables are set in `.env.local`
2. Verify the format of each variable matches the requirements
3. Look at the error message which will specify exactly which variable failed validation

Example error:
```
❌ Environment validation failed:

  - DATABASE_URL: Invalid URL
  - STRIPE_SECRET_KEY: Must start with sk_test_ or sk_live_

📝 Please check your .env file and ensure all required variables are set.
   See .env.example for reference.
```

### Development vs Production

For local development:
```bash
NODE_ENV=development
DATABASE_URL=postgresql://localhost:5432/foreas_dev
STRIPE_SECRET_KEY=sk_test_...
```

For production:
```bash
NODE_ENV=production
DATABASE_URL=postgresql://prod-server:5432/foreas_prod
STRIPE_SECRET_KEY=sk_live_...
```

## 📚 Additional Resources

- [Stripe API Keys Documentation](https://stripe.com/docs/keys)
- [PostgreSQL Connection Strings](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING)
- [Sentry DSN Documentation](https://docs.sentry.io/product/sentry-basics/dsn-explainer/)

## 🆘 Support

If you encounter issues with environment configuration:

1. Verify all required variables are set
2. Check variable formats match the validation rules
3. Ensure no trailing spaces or quotes in values
4. Test with minimal configuration first
5. Contact the development team if issues persist