# 🚗 ARCHITECTURE VTC PLATFORMS - FOREAS Driver Integration

## 🎯 **Vision FOREAS**

> **"Créer l'écosystème VTC le plus avancé pour les chauffeurs indépendants avec agrégation multi-plateformes et réservations directes à commission réduite."**

### 📊 **Comparaison Commission**
- **Plateformes VTC traditionnelles:** 25-30%
- **FOREAS Direct:** 5-15% (selon tier chauffeur)
- **FOREAS Agrégation:** 3-8% (bonus sur commissions existantes)

---

## 🏗️ **ARCHITECTURE MODULAIRE**

### **1. Core Platform Abstraction Layer**

```typescript
// /src/lib/platforms/types.ts
export interface VTCPlatform {
  id: 'uber' | 'bolt' | 'heetch' | 'marcel' | 'foreas_direct';
  name: string;
  apiVersion: string;
  capabilities: PlatformCapabilities;
  config: PlatformConfig;
}

export interface PlatformCapabilities {
  canReceiveBookings: boolean;
  canAcceptReject: boolean;
  canTrackEarnings: boolean;
  canManageAvailability: boolean;
  hasWebhooks: boolean;
  supportsBulkOperations: boolean;
}

export interface BookingRequest {
  id: string;
  platform: VTCPlatform['id'];
  pickup: {
    address: string;
    lat: number;
    lng: number;
    time: Date;
  };
  dropoff?: {
    address: string;
    lat: number;
    lng: number;
  };
  estimatedFare: number;
  estimatedDuration: number;
  distance: number;
  clientInfo: {
    firstName?: string;
    rating?: number;
    preferences?: string[];
  };
  specialRequests?: string[];
  urgency: 'low' | 'medium' | 'high';
  expiresAt: Date;
}
```

### **2. Platform-Specific Adapters**

```typescript
// /src/lib/platforms/adapters/AbstractPlatformAdapter.ts
export abstract class AbstractPlatformAdapter {
  protected platform: VTCPlatform;
  protected apiClient: any;
  protected webhookHandler: WebhookHandler;

  abstract authenticate(credentials: PlatformCredentials): Promise<boolean>;
  abstract getAvailableBookings(): Promise<BookingRequest[]>;
  abstract acceptBooking(bookingId: string): Promise<BookingAcceptance>;
  abstract rejectBooking(bookingId: string, reason?: string): Promise<void>;
  abstract updateLocation(lat: number, lng: number): Promise<void>;
  abstract setAvailability(isAvailable: boolean): Promise<void>;
  abstract getEarnings(period: DateRange): Promise<EarningsSummary>;
}
```

---

## 🔌 **INTÉGRATIONS SPÉCIFIQUES**

### **🚗 UBER Integration**

```typescript
// /src/lib/platforms/adapters/UberAdapter.ts
export class UberAdapter extends AbstractPlatformAdapter {
  constructor() {
    super({
      id: 'uber',
      name: 'Uber',
      apiVersion: '1.2',
      capabilities: {
        canReceiveBookings: true,
        canAcceptReject: true,
        canTrackEarnings: true,
        canManageAvailability: true,
        hasWebhooks: true,
        supportsBulkOperations: false,
      },
    });
  }

  async authenticate(credentials: UberCredentials) {
    // OAuth2 flow with Uber Driver API
    const response = await this.apiClient.post('/oauth/token', {
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'authorization_code',
      code: credentials.authCode,
    });
    
    return response.access_token !== undefined;
  }

  async getAvailableBookings(): Promise<BookingRequest[]> {
    const response = await this.apiClient.get('/driver/trips/current');
    return this.transformUberTrips(response.trips);
  }

  private transformUberTrips(uberTrips: any[]): BookingRequest[] {
    return uberTrips.map(trip => ({
      id: trip.trip_id,
      platform: 'uber',
      pickup: {
        address: trip.pickup.address,
        lat: trip.pickup.latitude,
        lng: trip.pickup.longitude,
        time: new Date(trip.pickup_time),
      },
      dropoff: trip.destination ? {
        address: trip.destination.address,
        lat: trip.destination.latitude,
        lng: trip.destination.longitude,
      } : undefined,
      estimatedFare: trip.fare_estimate * 100, // Convert to centimes
      estimatedDuration: trip.duration_estimate,
      distance: trip.distance_estimate,
      clientInfo: {
        firstName: trip.rider.first_name,
        rating: trip.rider.rating,
      },
      urgency: this.calculateUrgency(trip),
      expiresAt: new Date(Date.now() + 30000), // 30 seconds to accept
    }));
  }
}
```

### **⚡ BOLT Integration**

```typescript
// /src/lib/platforms/adapters/BoltAdapter.ts
export class BoltAdapter extends AbstractPlatformAdapter {
  constructor() {
    super({
      id: 'bolt',
      name: 'Bolt',
      apiVersion: '2.0',
      capabilities: {
        canReceiveBookings: true,
        canAcceptReject: true,
        canTrackEarnings: true,
        canManageAvailability: true,
        hasWebhooks: false, // Requires polling
        supportsBulkOperations: true,
      },
    });
  }

  // Similar implementation with Bolt-specific API calls
  async getAvailableBookings(): Promise<BookingRequest[]> {
    const response = await this.apiClient.get('/driver/v2/orders/available');
    return this.transformBoltOrders(response.orders);
  }
}
```

### **🟡 HEETCH Integration**

```typescript
// /src/lib/platforms/adapters/HeetchAdapter.ts
export class HeetchAdapter extends AbstractPlatformAdapter {
  constructor() {
    super({
      id: 'heetch',
      name: 'Heetch', 
      apiVersion: '1.0',
      capabilities: {
        canReceiveBookings: true,
        canAcceptReject: true,
        canTrackEarnings: false, // Limited API
        canManageAvailability: true,
        hasWebhooks: false,
        supportsBulkOperations: false,
      },
    });
  }

  // Heetch-specific implementation
}
```

---

## 🧠 **AGGREGATION ENGINE**

### **Multi-Platform Booking Manager**

```typescript
// /src/lib/aggregation/BookingAggregator.ts
export class BookingAggregator {
  private adapters: Map<string, AbstractPlatformAdapter> = new Map();
  private activeBookings: Map<string, AggregatedBooking> = new Map();

  async getAllAvailableBookings(): Promise<AggregatedBooking[]> {
    const platformBookings = await Promise.allSettled(
      Array.from(this.adapters.values()).map(adapter => 
        adapter.getAvailableBookings()
      )
    );

    const allBookings = platformBookings
      .filter(result => result.status === 'fulfilled')
      .flatMap(result => result.value);

    return this.prioritizeBookings(
      this.deduplicateBookings(allBookings)
    );
  }

  private prioritizeBookings(bookings: BookingRequest[]): AggregatedBooking[] {
    return bookings
      .map(booking => this.enrichBooking(booking))
      .sort((a, b) => {
        // Prioritize by FOREAS Smart Score
        return b.foreасScore - a.foreасScore;
      });
  }

  private enrichBooking(booking: BookingRequest): AggregatedBooking {
    return {
      ...booking,
      foreасScore: this.calculateForeасScore(booking),
      expectedCommission: this.calculateExpectedCommission(booking),
      profitability: this.calculateProfitability(booking),
      recommendation: this.generateRecommendation(booking),
    };
  }

  private calculateForeасScore(booking: BookingRequest): number {
    let score = 0;
    
    // Distance optimization (prefer medium distances)
    if (booking.distance > 5 && booking.distance < 25) score += 30;
    
    // Fare value
    if (booking.estimatedFare > 2000) score += 25; // > 20€
    
    // Client rating
    if (booking.clientInfo.rating && booking.clientInfo.rating > 4.5) score += 20;
    
    // Platform preference (FOREAS direct gets highest score)
    switch (booking.platform) {
      case 'foreas_direct': score += 40; break;
      case 'uber': score += 10; break;
      case 'bolt': score += 15; break;
      case 'heetch': score += 12; break;
    }
    
    // Time sensitivity
    if (booking.urgency === 'high') score += 10;
    
    return Math.min(score, 100);
  }
}
```

### **Smart Recommendation Engine**

```typescript
// /src/lib/ai/BookingRecommendationEngine.ts
export class BookingRecommendationEngine {
  async analyzeBooking(
    booking: BookingRequest,
    driverContext: DriverContext
  ): Promise<BookingRecommendation> {
    
    const analysis = {
      profitabilityScore: await this.calculateProfitability(booking, driverContext),
      efficiencyScore: await this.calculateEfficiency(booking, driverContext),
      strategicValue: await this.calculateStrategicValue(booking, driverContext),
      risks: await this.identifyRisks(booking),
    };

    return {
      booking,
      shouldAccept: this.calculateAcceptanceRecommendation(analysis),
      confidence: this.calculateConfidence(analysis),
      reasoning: this.generateReasoning(analysis),
      alternativeSuggestions: await this.findBetterAlternatives(booking),
      ajnayaInsight: this.generateAjnayaInsight(analysis),
    };
  }

  private generateAjnayaInsight(analysis: BookingAnalysis): AjnayaInsight {
    const { profitabilityScore, efficiencyScore } = analysis;
    
    if (profitabilityScore > 80 && efficiencyScore > 75) {
      return {
        type: 'OPPORTUNITY',
        priority: 'HIGH',
        title: '🎯 Course très rentable détectée',
        message: `Cette course présente un excellent potentiel de gains avec une efficacité optimale. Revenue estimé: ${analysis.estimatedRevenue}€ net.`,
        actionable: true,
        actions: ['accept_immediately', 'share_location'],
      };
    }
    
    if (profitabilityScore < 40) {
      return {
        type: 'WARNING',
        priority: 'MEDIUM',
        title: '⚠️ Course peu rentable',
        message: 'Cette course présente une rentabilité faible. Considérez attendre une meilleure opportunité.',
        actionable: true,
        actions: ['wait_for_better', 'check_alternatives'],
      };
    }

    return {
      type: 'INFO',
      priority: 'LOW',
      title: '📊 Analyse de course',
      message: `Course standard. Rentabilité: ${profitabilityScore}/100`,
      actionable: false,
    };
  }
}
```

---

## 📱 **INTERFACE MOBILE UNIFIÉE**

### **Dashboard Agrégé**

```tsx
// /src/screens/BookingAggregatorScreen.tsx
export default function BookingAggregatorScreen() {
  const [availableBookings, setAvailableBookings] = useState<AggregatedBooking[]>([]);
  const [isOnline, setIsOnline] = useState(false);
  
  return (
    <SafeAreaView className="flex-1 bg-black">
      {/* Multi-Platform Status Bar */}
      <View className="bg-gray-900 p-4 rounded-lg m-4">
        <Text className="text-white text-lg font-bold mb-2">📊 Status Multi-Plateformes</Text>
        <View className="flex-row justify-between">
          <PlatformStatus platform="uber" isActive={true} bookings={3} />
          <PlatformStatus platform="bolt" isActive={true} bookings={1} />
          <PlatformStatus platform="heetch" isActive={false} bookings={0} />
          <PlatformStatus platform="foreas_direct" isActive={true} bookings={2} />
        </View>
      </View>

      {/* Smart Recommendations */}
      <ScrollView className="flex-1 px-4">
        <Text className="text-white text-xl font-bold mb-4">🎯 Courses Recommandées</Text>
        
        {availableBookings.map(booking => (
          <BookingCard 
            key={booking.id}
            booking={booking}
            onAccept={() => handleAcceptBooking(booking)}
            onReject={() => handleRejectBooking(booking)}
          />
        ))}
      </ScrollView>

      {/* Quick Actions */}
      <View className="bg-gray-900 p-4 m-4 rounded-lg">
        <View className="flex-row justify-around">
          <TouchableOpacity 
            className={`px-4 py-2 rounded-lg ${isOnline ? 'bg-red-600' : 'bg-green-600'}`}
            onPress={() => setIsOnline(!isOnline)}
          >
            <Text className="text-white font-bold">
              {isOnline ? '🔴 Passer Hors Ligne' : '🟢 Passer En Ligne'}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            className="px-4 py-2 rounded-lg bg-blue-600"
            onPress={() => navigation.navigate('Statistics')}
          >
            <Text className="text-white font-bold">📊 Statistiques</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}
```

---

## 🔄 **WEBHOOK MANAGEMENT**

### **Unified Webhook Handler**

```typescript
// /src/app/api/webhooks/platforms/route.ts
export async function POST(req: Request) {
  const signature = req.headers.get('x-webhook-signature');
  const platform = req.headers.get('x-platform-id') as VTCPlatform['id'];
  const body = await req.json();

  // Verify webhook signature
  const isValid = await verifyWebhookSignature(signature, body, platform);
  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  // Route to appropriate platform handler
  switch (platform) {
    case 'uber':
      return handleUberWebhook(body);
    case 'bolt':
      return handleBoltWebhook(body);
    case 'foreas_direct':
      return handleForeасWebhook(body);
    default:
      return new Response('Unknown platform', { status: 400 });
  }
}

async function handleUberWebhook(payload: UberWebhookPayload) {
  const { event_type, data } = payload;
  
  switch (event_type) {
    case 'trip_request':
      await notifyDriverOfNewBooking(data.trip);
      break;
    case 'trip_accepted':
      await updateBookingStatus(data.trip_id, 'ACCEPTED');
      break;
    case 'trip_completed':
      await processTripCompletion(data.trip);
      break;
    case 'trip_cancelled':
      await handleTripCancellation(data.trip_id, data.reason);
      break;
  }

  return new Response('OK', { status: 200 });
}
```

---

## 📊 **ANALYTICS & PERFORMANCE**

### **Cross-Platform Analytics**

```typescript
// /src/lib/analytics/PlatformAnalytics.ts
export class PlatformAnalytics {
  async generateDriverInsights(driverId: string): Promise<DriverInsights> {
    const [uberStats, boltStats, heetchStats, foreасStats] = await Promise.all([
      this.getUberStats(driverId),
      this.getBoltStats(driverId),
      this.getHeetchStats(driverId),
      this.getForeасDirectStats(driverId),
    ]);

    return {
      totalEarnings: this.sumEarnings([uberStats, boltStats, heetchStats, foreасStats]),
      bestPerformingPlatform: this.identifyBestPlatform([uberStats, boltStats, heetchStats, foreасStats]),
      recommendations: await this.generateOptimizationRecommendations(driverId),
      foreасAdvantage: this.calculateForeасAdvantage(foreасStats, [uberStats, boltStats, heetchStats]),
      ajnayaInsights: await this.generateAjnayaInsights(driverId),
    };
  }

  private calculateForeасAdvantage(
    foreасStats: PlatformStats, 
    otherPlatformsStats: PlatformStats[]
  ): ForeасAdvantage {
    const averageOtherCommission = otherPlatformsStats
      .reduce((sum, stats) => sum + stats.averageCommissionRate, 0) / otherPlatformsStats.length;

    const commissionSaving = averageOtherCommission - foreасStats.averageCommissionRate;
    const monthlySaving = foreасStats.monthlyRevenue * (commissionSaving / 100);

    return {
      commissionSaving: `${commissionSaving.toFixed(1)}%`,
      monthlySaving: monthlySaving,
      yearlyProjection: monthlySaving * 12,
      message: `En utilisant FOREAS Direct, vous économisez ${monthlySaving.toFixed(0)}€ par mois en commissions !`,
    };
  }
}
```

---

## 🔐 **SECURITY & COMPLIANCE**

### **API Key Management**

```typescript
// /src/lib/security/CredentialManager.ts
export class CredentialManager {
  private vault: Map<string, EncryptedCredentials> = new Map();

  async storeCredentials(
    driverId: string, 
    platform: VTCPlatform['id'], 
    credentials: PlatformCredentials
  ): Promise<void> {
    const encrypted = await this.encrypt(credentials);
    
    await prisma.driverPlatformCredentials.upsert({
      where: {
        driverId_platform: {
          driverId,
          platform,
        },
      },
      update: {
        encryptedData: encrypted,
        updatedAt: new Date(),
      },
      create: {
        driverId,
        platform,
        encryptedData: encrypted,
        isActive: true,
      },
    });
  }

  async getCredentials(
    driverId: string,
    platform: VTCPlatform['id']
  ): Promise<PlatformCredentials | null> {
    const stored = await prisma.driverPlatformCredentials.findUnique({
      where: {
        driverId_platform: {
          driverId,
          platform,
        },
      },
    });

    if (!stored?.encryptedData) return null;

    return await this.decrypt(stored.encryptedData);
  }
}
```

---

## 🎯 **MIGRATION STRATEGY**

### **Phase 1: Foundation (Month 1)**
1. ✅ Core abstraction layer
2. ✅ Database schema for multi-platform support
3. ✅ Basic UI for platform management
4. ✅ FOREAS Direct integration (already done)

### **Phase 2: First Platform (Month 2)**
1. 🔄 Uber integration (most mature API)
2. 🔄 Basic booking aggregation
3. 🔄 Simple accept/reject functionality
4. 🔄 Earnings tracking

### **Phase 3: Expansion (Month 3)**
1. ⏳ Bolt integration
2. ⏳ Heetch integration
3. ⏳ Advanced recommendation engine
4. ⏳ Cross-platform analytics

### **Phase 4: Intelligence (Month 4)**
1. ⏳ AI-powered booking recommendations
2. ⏳ Predictive analytics
3. ⏳ Advanced Ajnaya insights
4. ⏳ Performance optimization

---

## 🚀 **COMPETITIVE ADVANTAGE**

### **FOREAS vs Competitors**

| Feature | FOREAS | Uber | Bolt | Heetch |
|---------|--------|------|------|--------|
| **Commission** | 5-15% | 25% | 20% | 25% |
| **Multi-Platform** | ✅ | ❌ | ❌ | ❌ |
| **AI Assistant** | ✅ Ajnaya | ❌ | ❌ | ❌ |
| **Direct Bookings** | ✅ | ❌ | ❌ | ❌ |
| **Smart Routing** | ✅ | Basic | Basic | Basic |
| **Revenue Analytics** | ✅ | Limited | Limited | Limited |

### **Value Proposition**

> **"FOREAS Driver: La seule app qui vous permet de maximiser vos revenus en agrégeant toutes les plateformes VTC avec une commission révolutionnaire de 5-15% sur les réservations directes."**

---

**✅ ARCHITECTURE VTC PLATFORMS DÉFINIE !**

Cette architecture modulaire permet à FOREAS Driver de devenir le hub central pour tous les chauffeurs VTC, avec une approche intelligente qui maximise les revenus tout en réduisant drastiquement les commissions.