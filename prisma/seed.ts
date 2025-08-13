/**
 * Prisma Seed Script - FOREAS Driver Backend
 * Données initiales pour le développement
 */

import { PrismaClient, Platform, TripStatus, BookingStatus, Role, UserStatus, VehicleCategory } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Nettoie la base de données avant le seed
 */
async function cleanup(): Promise<void> {
  console.log('🧹 Cleaning database...');
  
  // Ordre important à cause des foreign keys
  const tables = [
    'AjnayaFeedback',
    'AjnayaInsight',
    'AggregatedBooking',
    'PlatformStats',
    'DriverPlatformCredentials',
    'Earning',
    'Review',
    'Availability',
    'Booking',
    'Trip',
    'StripeAccount',
    'Driver',
    'Session',
    'Vehicle',
    'User',
  ];

  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}";`);
    } catch (error) {
      // Ignorer si la table n'existe pas encore
      console.warn(`Warning: Could not clean table ${table}`);
    }
  }
}

/**
 * Crée les données de seed
 */
async function seedData(): Promise<void> {
  console.log('🌱 Starting seed...');

  // 1. Créer un utilisateur chauffeur
  console.log('👤 Creating user and driver...');
  const user = await prisma.user.create({
    data: {
      email: 'jean.martin@foreas.app',
      phone: '+33123456789',
      name: 'Jean Martin',
      role: Role.DRIVER,
      status: UserStatus.ACTIVE,
      password: 'hashed_password_example', // En production, utilisez bcrypt
      lastLoginAt: new Date(),
    },
  });

  // 2. Créer un véhicule
  console.log('🚗 Creating vehicle...');
  const vehicle = await prisma.vehicle.create({
    data: {
      brand: 'Mercedes',
      model: 'Classe E',
      year: 2021,
      color: 'Noir',
      licensePlate: 'AB-123-CD',
      seats: 4,
      category: VehicleCategory.PREMIUM,
    },
  });

  // 3. Créer le profil chauffeur
  const driver = await prisma.driver.create({
    data: {
      userId: user.id,
      licenseNumber: 'VTC-2024-001',
      vehicleId: vehicle.id,
      companyName: 'Jean Martin VTC',
      siret: '12345678901234',
      uberDriverId: '12345678-1234-1234-1234-123456789012',
      boltDriverId: '123456',
      heetchDriverId: 'HTC123ABC',
      stripeAccountId: 'acct_test_stripe_123',
      stripeOnboarded: true,
      personalWebsite: 'https://jean-martin-vtc.fr',
      websiteSlug: 'jean-martin',
      totalRides: 0,
      totalEarnings: 0,
      averageRating: 4.8,
    },
  });

  // 4. Créer un compte Stripe
  console.log('💳 Creating Stripe account...');
  await prisma.stripeAccount.create({
    data: {
      userId: driver.userId,
      accountId: 'acct_test_stripe_123',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      businessType: 'individual',
      country: 'FR',
      defaultCurrency: 'eur',
    },
  });

  // 5. Créer des courses sur différentes plateformes
  console.log('🚕 Creating trips...');
  
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

  const trips = [
    // Trip Uber - terminée
    {
      driverId: driver.id,
      platform: Platform.UBER,
      platformTripId: 'uber_trip_001',
      pickupAddress: '1 Place de la Bastille, Paris',
      pickupLat: 48.8532,
      pickupLng: 2.3692,
      dropoffAddress: '15 Avenue des Champs-Élysées, Paris',
      dropoffLat: 48.8698,
      dropoffLng: 2.3076,
      distance: 5.2,
      duration: 25,
      basePrice: 18.50,
      surge: 1.2,
      finalPrice: 22.20,
      commission: 5.55, // 25% commission Uber
      netEarnings: 16.65,
      status: TripStatus.COMPLETED,
      requestedAt: threeHoursAgo,
      acceptedAt: new Date(threeHoursAgo.getTime() + 30000), // 30s après
      startedAt: new Date(threeHoursAgo.getTime() + 5 * 60000), // 5min après
      completedAt: new Date(threeHoursAgo.getTime() + 30 * 60000), // 30min après
    },
    // Trip Bolt - terminée
    {
      driverId: driver.id,
      platform: Platform.BOLT,
      platformTripId: 'bolt_trip_001',
      pickupAddress: '10 Rue de Rivoli, Paris',
      pickupLat: 48.8566,
      pickupLng: 2.3522,
      dropoffAddress: 'Gare du Nord, Paris',
      dropoffLat: 48.8809,
      dropoffLng: 2.3553,
      distance: 3.8,
      duration: 15,
      basePrice: 12.80,
      surge: 1.0,
      finalPrice: 12.80,
      commission: 2.56, // 20% commission Bolt
      netEarnings: 10.24,
      status: TripStatus.COMPLETED,
      requestedAt: twoHoursAgo,
      acceptedAt: new Date(twoHoursAgo.getTime() + 45000),
      startedAt: new Date(twoHoursAgo.getTime() + 6 * 60000),
      completedAt: new Date(twoHoursAgo.getTime() + 21 * 60000),
    },
    // Trip Heetch - terminée
    {
      driverId: driver.id,
      platform: Platform.HEETCH,
      platformTripId: 'heetch_trip_001',
      pickupAddress: 'Châtelet-Les Halles, Paris',
      pickupLat: 48.8606,
      pickupLng: 2.3472,
      dropoffAddress: 'Aéroport Charles de Gaulle, Roissy',
      dropoffLat: 49.0097,
      dropoffLng: 2.5479,
      distance: 32.5,
      duration: 45,
      basePrice: 45.00,
      surge: 1.1,
      finalPrice: 49.50,
      commission: 12.38, // 25% commission Heetch
      netEarnings: 37.12,
      status: TripStatus.COMPLETED,
      requestedAt: oneHourAgo,
      acceptedAt: new Date(oneHourAgo.getTime() + 20000),
      startedAt: new Date(oneHourAgo.getTime() + 8 * 60000),
      completedAt: new Date(oneHourAgo.getTime() + 53 * 60000),
    },
  ];

  const createdTrips = [];
  for (const tripData of trips) {
    const trip = await prisma.trip.create({ data: tripData });
    createdTrips.push(trip);
  }

  // 6. Créer les gains associés aux courses
  console.log('💰 Creating earnings...');
  for (const trip of createdTrips) {
    await prisma.earning.create({
      data: {
        driverId: driver.id,
        type: 'RIDE',
        platform: trip.platform,
        amount: trip.netEarnings,
        currency: 'EUR',
        tripId: trip.id,
        earnedAt: trip.completedAt!,
      },
    });
  }

  // 7. Créer une réservation directe FOREAS
  console.log('📅 Creating FOREAS direct booking...');
  const futureBooking = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Demain
  
  const clientUser = await prisma.user.create({
    data: {
      email: 'marie.client@gmail.com',
      phone: '+33987654321',
      name: 'Marie Dupont',
      role: Role.CLIENT,
      status: UserStatus.ACTIVE,
    },
  });

  await prisma.booking.create({
    data: {
      driverId: driver.id,
      clientId: clientUser.id,
      pickupAddress: '75 Boulevard Saint-Germain, Paris',
      pickupLat: 48.8534,
      pickupLng: 2.3488,
      dropoffAddress: 'Opéra Bastille, Paris',
      dropoffLat: 48.8532,
      dropoffLng: 2.3695,
      scheduledFor: futureBooking,
      estimatedDuration: 20,
      proposedPrice: 25.00,
      finalPrice: 25.00,
      paymentMethod: 'STRIPE',
      paymentStatus: 'COMPLETED',
      status: BookingStatus.CONFIRMED,
      clientNotes: 'Merci d\'être ponctuel, j\'ai un rendez-vous important',
      confirmedAt: now,
    },
  });

  // 8. Créer quelques avis
  console.log('⭐ Creating reviews...');
  const reviews = [
    {
      driverId: driver.id,
      clientName: 'Sophie L.',
      rating: 5,
      comment: 'Excellent chauffeur, très professionnel et véhicule impeccable !',
      platform: Platform.UBER,
    },
    {
      driverId: driver.id,
      clientName: 'Marc B.',
      rating: 4,
      comment: 'Bonne course, chauffeur sympa',
      platform: Platform.BOLT,
    },
    {
      driverId: driver.id,
      clientName: 'Anonymous',
      rating: 5,
      comment: 'Parfait comme toujours',
      platform: Platform.HEETCH,
    },
  ];

  for (const reviewData of reviews) {
    await prisma.review.create({ data: reviewData });
  }

  // 9. Créer quelques insights Ajnaya
  console.log('🧠 Creating Ajnaya insights...');
  const insights = [
    {
      driverId: driver.id,
      type: 'ZONE_ALERT',
      priority: 'HIGH',
      title: '🌧️ Forte demande détectée',
      message: 'Conditions météo favorables à +40% de la demande dans le 1er arrondissement. Dirigez-vous vers Châtelet-Les Halles pour optimiser vos gains !',
      data: JSON.stringify({
        zone: 'Châtelet-Les Halles',
        demandMultiplier: 1.4,
        estimatedBonus: '+15€/h',
        weather: 'rainy',
        confidence: 87,
      }),
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000), // Expire dans 2h
    },
    {
      driverId: driver.id,
      type: 'PERFORMANCE',
      priority: 'MEDIUM',
      title: '📊 Bilan hebdomadaire',
      message: 'Excellente semaine ! Vous avez généré +15% de revenus par rapport à la semaine précédente.',
      data: JSON.stringify({
        weeklyEarnings: 450.80,
        previousWeekEarnings: 392.00,
        growth: 15,
        bestDay: 'Friday',
      }),
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // Expire dans 7 jours
    },
  ];

  for (const insightData of insights) {
    await prisma.ajnayaInsight.create({ data: insightData });
  }

  // 10. Mettre à jour les statistiques du chauffeur
  console.log('📈 Updating driver stats...');
  const totalEarnings = createdTrips.reduce((sum, trip) => sum + trip.netEarnings, 0);
  const avgRating = (5 + 4 + 5) / 3; // Moyenne des avis

  await prisma.driver.update({
    where: { id: driver.id },
    data: {
      totalRides: createdTrips.length,
      totalEarnings,
      averageRating: avgRating,
    },
  });

  console.log('✅ Seed completed successfully!');
  console.log(`📊 Created:`);
  console.log(`   - 2 Users (1 driver, 1 client)`);
  console.log(`   - 1 Driver profile`);
  console.log(`   - 1 Vehicle`);
  console.log(`   - 1 Stripe account`);
  console.log(`   - 3 Trips (Uber, Bolt, Heetch)`);
  console.log(`   - 3 Earnings records`);
  console.log(`   - 1 FOREAS booking`);
  console.log(`   - 3 Reviews`);
  console.log(`   - 2 Ajnaya insights`);
  console.log(`   - Total earnings: ${totalEarnings.toFixed(2)}€`);
}

/**
 * Main seed function
 */
async function main(): Promise<void> {
  try {
    await cleanup();
    await seedData();
  } catch (error) {
    console.error('❌ Seed failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run seed
main().catch((error) => {
  console.error(error);
  process.exit(1);
});