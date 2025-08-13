# 🗄️ Database Setup & Management - FOREAS Driver Backend

## 🚀 Quick Start

### Prerequisites
- PostgreSQL 14+ running
- Environment variables configured (see [README_ENV.md](./README_ENV.md))

### Initial Setup

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma client
npm run db:generate

# 3. Run migrations to create database schema
npm run db:migrate --name init

# 4. Seed database with sample data
npm run db:seed
```

## 📋 Available Commands

### Migration Commands

| Command | Description | When to use |
|---------|-------------|-------------|
| `npm run db:migrate` | Create and apply new migration | After schema changes in development |
| `npm run db:migrate:deploy` | Apply migrations in production | Production deployments |
| `npm run db:reset` | Reset database and apply all migrations + seed | When you need a fresh start |
| `npm run db:generate` | Generate Prisma client | After schema changes |

### Development Commands

| Command | Description | When to use |
|---------|-------------|-------------|
| `npm run db:seed` | Populate database with sample data | Initial setup or reset |
| `npm run db:studio` | Open Prisma Studio (GUI) | Visual database inspection |
| `npm run db:push` | Push schema changes without migrations | Prototyping schema changes |

## 🏗️ Database Schema Overview

### Core Models

```mermaid
graph TD
    A[User] --> B[Driver]
    B --> C[Trip]
    B --> D[Booking] 
    B --> E[Earning]
    B --> F[StripeAccount]
    C --> E
    D --> E
    B --> G[AjnayaInsight]
    B --> H[Review]
    I[Vehicle] --> B
```

### Key Features

- **Multi-platform support**: Uber, Bolt, Heetch, FOREAS Direct
- **Stripe Connect integration**: Secure payment processing
- **AI Insights (Ajnaya)**: Performance analytics and recommendations
- **Comprehensive tracking**: Trips, earnings, reviews, availability

## 📊 Seed Data

The seed script creates realistic test data:

- **1 Driver Profile**: Jean Martin (Premium driver)
- **3 Completed Trips**: Uber, Bolt, Heetch examples
- **1 Future Booking**: FOREAS Direct reservation
- **Reviews & Ratings**: Sample customer feedback
- **AI Insights**: Ajnaya recommendations
- **Stripe Account**: Connected payment account

### Sample Data Access

```typescript
// After seeding, you can access:
const driver = await prisma.driver.findFirst({
  where: { 
    user: { email: 'jean.martin@foreas.app' }
  },
  include: {
    trips: true,
    earnings: true,
    reviews: true
  }
});
```

## 🔒 Schema Security Features

### Constraints & Indexes

- **Unique constraints**: Email, phone, license numbers, Stripe accounts
- **Performance indexes**: Composite indexes for common queries
- **Data protection**: `onDelete: Restrict` for trips in V1

### Key Indexes

```sql
-- Performance optimized queries
@@index([driverId, platform, startedAt]) -- Trip queries
@@index([driverId]) -- Driver relations
@@index([expiresAt]) -- Ajnaya insights cleanup
```

## 🧪 Testing

### Database Tests

```bash
# Run database-specific tests
npm test -- database.test.ts

# Run all tests with coverage
npm run test:coverage
```

### Test Environment

- Isolated test database
- Automatic cleanup between tests
- Transaction-based test isolation

## 🚨 Troubleshooting

### Common Issues

#### Migration Fails
```bash
# Check database connection
npm run db:generate

# Reset if corrupted
npm run db:reset
```

#### Seed Fails
```bash
# Clear existing data first
npm run db:reset

# Then seed again
npm run db:seed
```

#### Schema Drift
```bash
# If development schema differs from migrations
npm run db:push  # Quick fix for development
npm run db:migrate  # Proper migration for production
```

### Environment Issues

#### DATABASE_URL Problems
```bash
# Test connection
psql $DATABASE_URL

# Common format:
# postgresql://username:password@localhost:5432/foreas_driver
```

#### Permission Issues
```sql
-- Grant necessary permissions
GRANT ALL PRIVILEGES ON DATABASE foreas_driver TO your_user;
GRANT ALL ON SCHEMA public TO your_user;
```

## 🔄 Development Workflow

### Making Schema Changes

1. **Update** `prisma/schema.prisma`
2. **Create migration**: `npm run db:migrate`
3. **Generate client**: `npm run db:generate` (usually automatic)
4. **Update** application code
5. **Test** changes: `npm test`

### Production Deployment

1. **Deploy migrations**: `npm run db:migrate:deploy`
2. **Verify** deployment: Check production logs
3. **Monitor** performance: Use Prisma metrics

## 📈 Performance Monitoring

### Query Performance

```typescript
// Enable query logging in development
const prisma = new PrismaClient({
  log: ['query', 'info', 'warn', 'error'],
});
```

### Database Health Check

```typescript
import { getDatabaseHealth } from '@/server/db';

const health = await getDatabaseHealth();
// { status: 'healthy', latency: 23, timestamp: '...' }
```

## 🔧 Advanced Features

### Transaction Support

```typescript
import { withTransaction } from '@/server/db';

const result = await withTransaction(async (tx) => {
  const trip = await tx.trip.create({ ... });
  const earning = await tx.earning.create({ ... });
  return { trip, earning };
});
```

### Connection Pooling

Prisma automatically handles connection pooling. For high-load scenarios:

```typescript
// Adjust connection pool size
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `${DATABASE_URL}?connection_limit=10&pool_timeout=20`
    }
  }
});
```

## 📚 Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [PostgreSQL Best Practices](https://wiki.postgresql.org/wiki/Performance_Optimization)
- [Database Design Patterns](https://www.prisma.io/docs/concepts/components/prisma-schema/data-model)

## 🆘 Support

For database-related issues:

1. Check this documentation
2. Verify environment variables
3. Test database connection
4. Review Prisma logs
5. Contact development team if persistent issues