require('dotenv').config();
const { Server } = require('socket.io');
const http = require('http');
const mistralService = require('./services/MistralService');

// Configuration
const PORT = process.env.WEBSOCKET_PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:8081";

// Créer le serveur HTTP
const server = http.createServer();

// Créer le serveur Socket.IO
const io = new Server(server, {
  cors: {
    origin: [CORS_ORIGIN, "http://localhost:8082", "http://localhost:8085"],
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// État global
let connectedDrivers = new Map();
let zones = new Map();

// Données mock des zones Paris
const PARIS_ZONES = [
  { id: 'opera', name: 'Opéra', lat: 48.8708, lng: 2.3321, baseDemand: 80 },
  { id: 'champs', name: 'Champs-Élysées', lat: 48.8698, lng: 2.3076, baseDemand: 85 },
  { id: 'marais', name: 'Le Marais', lat: 48.8566, lng: 2.3522, baseDemand: 70 },
  { id: 'montparnasse', name: 'Montparnasse', lat: 48.8420, lng: 2.3219, baseDemand: 75 },
  { id: 'defense', name: 'La Défense', lat: 48.8915, lng: 2.2401, baseDemand: 90 },
  { id: 'bastille', name: 'Bastille', lat: 48.8532, lng: 2.3693, baseDemand: 65 }
];

// Initialiser les zones
PARIS_ZONES.forEach(zone => {
  zones.set(zone.id, {
    ...zone,
    demandLevel: zone.baseDemand + Math.floor(Math.random() * 20) - 10,
    driverCount: Math.floor(Math.random() * 15) + 3,
    averageWaitTime: Math.floor(Math.random() * 10) + 3,
    priceMultiplier: 1.0 + (Math.random() * 0.5),
    lastUpdated: Date.now()
  });
});

console.log('🚀 FOREAS WebSocket Server Starting...');
console.log(`📡 Port: ${PORT}`);
console.log(`🔗 CORS Origin: ${CORS_ORIGIN}`);

io.on('connection', (socket) => {
  console.log(`🔌 Driver connected: ${socket.id}`);

  // Authentification (simplifiée pour les tests)
  socket.on('authenticate', (data) => {
    const driverId = data.driverId || `driver_${socket.id}`;
    socket.driverId = driverId;
    
    connectedDrivers.set(driverId, {
      socketId: socket.id,
      driverId: driverId,
      location: null,
      zone: null,
      connectedAt: Date.now()
    });

    console.log(`✅ Driver authenticated: ${driverId}`);
    socket.emit('authenticated', { driverId });
  });

  // Mise à jour de position du chauffeur
  socket.on('driver_position_update', (position) => {
    if (!socket.driverId) return;

    const driver = connectedDrivers.get(socket.driverId);
    if (driver) {
      driver.location = {
        latitude: position.latitude,
        longitude: position.longitude,
        timestamp: Date.now()
      };
      driver.zone = position.zone || findNearestZone(position.latitude, position.longitude);

      connectedDrivers.set(socket.driverId, driver);
      console.log(`📍 Position updated: ${socket.driverId} at ${driver.zone}`);
    }
  });

  // Demande de chauffeurs à proximité
  socket.on('request_nearby_drivers', (data) => {
    const { latitude, longitude, radius = 2000 } = data;
    
    const nearbyDrivers = Array.from(connectedDrivers.values())
      .filter(driver => driver.location && driver.socketId !== socket.id)
      .filter(driver => {
        const distance = calculateDistance(
          latitude, longitude,
          driver.location.latitude, driver.location.longitude
        );
        return distance <= radius;
      })
      .map(driver => ({
        driverId: driver.driverId,
        latitude: driver.location.latitude,
        longitude: driver.location.longitude,
        zone: driver.zone,
        distance: calculateDistance(
          latitude, longitude,
          driver.location.latitude, driver.location.longitude
        )
      }));

    socket.emit('drivers_nearby', nearbyDrivers);
    console.log(`🚗 Sent ${nearbyDrivers.length} nearby drivers to ${socket.id}`);
  });

  // Demande de données de zone
  socket.on('request_zone_data', (data) => {
    const { zoneId } = data;
    const zone = zones.get(zoneId);
    
    if (zone) {
      socket.emit('zone_update', zone);
      console.log(`📊 Sent zone data: ${zone.name} to ${socket.id}`);
    }
  });

  // Demande de recommandation Ajnaya AI
  socket.on('request_ajnaya_recommendation', async (data) => {
    if (!socket.driverId) return;

    try {
      const { location, weather, lastRideRevenue } = data;
      
      // Contexte pour l'IA
      const context = {
        location: location || { lat: 48.8566, lng: 2.3522 }, // Default Paris center
        time: new Date(),
        weather: weather || 'clear',
        lastRideRevenue: lastRideRevenue
      };

      console.log(`🧠 Processing Ajnaya recommendation for ${socket.driverId}`);
      
      // Appel au service Mistral
      const recommendation = await mistralService.getRecommendation(socket.driverId, context);
      
      // Envoi de la recommandation
      socket.emit('ajnaya_recommendation', {
        success: true,
        recommendation: recommendation,
        timestamp: Date.now()
      });

      console.log(`✅ Ajnaya recommendation sent to ${socket.driverId}: ${recommendation.zone}`);
      
    } catch (error) {
      console.error(`❌ Error generating Ajnaya recommendation for ${socket.driverId}:`, error);
      
      socket.emit('ajnaya_recommendation', {
        success: false,
        error: 'Unable to generate recommendation',
        timestamp: Date.now()
      });
    }
  });

  // Abonnement aux mises à jour de zone
  socket.on('subscribe_zone', (data) => {
    const { zoneId } = data;
    socket.join(`zone_${zoneId}`);
    console.log(`🔔 ${socket.id} subscribed to zone ${zoneId}`);
  });

  // Désabonnement des mises à jour de zone
  socket.on('unsubscribe_zone', (data) => {
    const { zoneId } = data;
    socket.leave(`zone_${zoneId}`);
    console.log(`🔕 ${socket.id} unsubscribed from zone ${zoneId}`);
  });

  // Statistiques du service Mistral (admin uniquement)
  socket.on('request_mistral_stats', () => {
    if (!socket.driverId) return;
    
    const stats = mistralService.getStats();
    socket.emit('mistral_stats', {
      success: true,
      stats: stats,
      timestamp: Date.now()
    });
    
    console.log(`📈 Mistral stats sent to ${socket.driverId}`);
  });

  // Déconnexion
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Driver disconnected: ${socket.id} (${reason})`);
    
    if (socket.driverId) {
      connectedDrivers.delete(socket.driverId);
    }
  });
});

// Fonctions utilitaires
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Rayon de la Terre en mètres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function findNearestZone(lat, lng) {
  let nearestZone = 'Paris';
  let minDistance = Infinity;

  PARIS_ZONES.forEach(zone => {
    const distance = calculateDistance(lat, lng, zone.lat, zone.lng);
    if (distance < minDistance) {
      minDistance = distance;
      nearestZone = zone.name;
    }
  });

  return nearestZone;
}

// Simulation de données temps réel
setInterval(() => {
  // Mettre à jour aléatoirement les zones
  PARIS_ZONES.forEach(zoneData => {
    const zone = zones.get(zoneData.id);
    if (zone) {
      // Variation aléatoire de la demande
      zone.demandLevel = Math.max(20, Math.min(100, 
        zone.demandLevel + (Math.random() * 20 - 10)
      ));
      
      // Mise à jour du nombre de chauffeurs dans la zone
      const driversInZone = Array.from(connectedDrivers.values())
        .filter(driver => driver.zone === zone.name).length;
      zone.driverCount = driversInZone;
      
      // Calcul du temps d'attente basé sur l'offre/demande
      zone.averageWaitTime = Math.max(1, Math.round(
        10 - (zone.demandLevel / 10) + (zone.driverCount * 2)
      ));
      
      zone.lastUpdated = Date.now();
      zones.set(zoneData.id, zone);

      // Envoyer les mises à jour aux abonnés
      io.to(`zone_${zoneData.id}`).emit('zone_update', zone);
    }
  });

  // Envoyer des insights Ajnaya occasionnels
  if (Math.random() > 0.9) { // 10% de chance chaque intervalle
    const randomZone = PARIS_ZONES[Math.floor(Math.random() * PARIS_ZONES.length)];
    const insight = {
      type: 'ajnaya_insight',
      priority: 'medium',
      zone: randomZone.name,
      message: `Demande croissante à ${randomZone.name}. +${Math.floor(Math.random() * 30 + 10)}% de courses prévues.`,
      confidence: Math.floor(Math.random() * 20 + 75),
      timestamp: Date.now()
    };

    io.emit('ajnaya_insight', insight);
    console.log(`🧠 Ajnaya insight sent: ${insight.message}`);
  }

}, 15000); // Toutes les 15 secondes

// Statistiques périodiques
setInterval(() => {
  console.log(`📊 Connected drivers: ${connectedDrivers.size}`);
  console.log(`📍 Active zones: ${zones.size}`);
}, 60000); // Toutes les minutes

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(`✅ FOREAS WebSocket Server running on port ${PORT}`);
  console.log(`🔗 WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`📱 Ready for FOREAS Driver connections`);
});

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Arrêt gracieux
process.on('SIGINT', () => {
  console.log('⛔ FOREAS WebSocket Server shutting down...');
  server.close(() => {
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });
});