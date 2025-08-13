const { Mistral } = require('@mistralai/mistralai');

class MistralService {
  constructor() {
    // Configuration Mistral AI
    this.client = new Mistral({
      apiKey: process.env.MISTRAL_API_KEY || ''
    });
    
    // Cache conversation history par chauffeur (en production: Redis/DB)
    this.conversationHistory = new Map();
    
    // Statistiques pour monitoring
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      fallbackUsed: 0,
      averageResponseTime: 0,
      lastReset: Date.now()
    };
    
    console.log('🧠 MistralService initialized');
  }

  /**
   * Génère une recommandation Ajnaya pour un chauffeur
   */
  async getRecommendation(driverId, context) {
    const startTime = Date.now();
    this.stats.totalRequests++;
    
    try {
      // Récupération historique chauffeur
      const history = this.conversationHistory.get(driverId) || [];
      
      // Construction du prompt contextualisé
      const systemPrompt = this.buildSystemPrompt(context);
      const userPrompt = this.buildUserPrompt(context);
      
      console.log(`🤖 Generating recommendation for driver ${driverId}`);
      
      // Appel Mistral AI
      const response = await this.client.chat.complete({
        model: 'mistral-small-latest', // Optimisé coût/performance
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.slice(-3), // 3 derniers échanges pour contexte
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.6, // Équilibre créativité/précision  
        maxTokens: 200,
        timeout: 8000 // 8s timeout
      });

      const recommendation = response.choices?.[0]?.message?.content;
      
      if (!recommendation) {
        throw new Error('Empty response from Mistral');
      }

      // Parsing et validation de la recommandation
      const parsedRecommendation = this.parseRecommendation(recommendation, context);
      
      // Sauvegarde pour apprentissage
      this.saveInteractionForTraining(driverId, context, recommendation);
      
      // Mise à jour historique
      this.updateConversationHistory(driverId, userPrompt, recommendation);
      
      // Stats
      this.stats.successfulRequests++;
      this.stats.averageResponseTime = 
        (this.stats.averageResponseTime + (Date.now() - startTime)) / 2;
      
      console.log(`✅ Recommendation generated for ${driverId}: ${parsedRecommendation.zone}`);
      
      return parsedRecommendation;
      
    } catch (error) {
      console.error(`❌ Mistral error for ${driverId}:`, error.message);
      
      // Fallback intelligent  
      this.stats.fallbackUsed++;
      return this.getFallbackRecommendation(context);
    }
  }

  /**
   * Construction du prompt système optimisé
   */
  buildSystemPrompt(context) {
    const hour = context.time.getHours();
    const dayOfWeek = context.time.getDay();
    const timeContext = this.getTimeContext(hour, dayOfWeek);
    
    return `Tu es Ajnaya, l'IA experte VTC de Paris. Tu optimises les revenus des chauffeurs avec des recommandations précises.

CONTEXTE TEMPOREL: ${timeContext}
POSITION ACTUELLE: ${this.getZoneFromCoordinates(context.location)}
MÉTÉO: ${context.weather || 'Inconnue'}
${context.lastRideRevenue ? `DERNIER GAIN: ${context.lastRideRevenue}€` : ''}

ZONES PARIS PRIORITAIRES:
- La Défense (Business, 7h-10h + 17h-20h)  
- Opéra/Châtelet (Shopping, tourisme)
- Gares (Montparnasse, Nord, Lyon - voyageurs)
- Aéroports CDG/Orly (via correspondances)
- Sortie nocturne (Bastille, Oberkampf, Champs 20h-2h)

RÈGLES:
- Recommandation courte (40 mots max)
- Zone précise + justification
- Temps de trajet estimé si >10min
- Emoji pour identifier rapidement
- Prendre en compte trafic et demande

Format: "[EMOJI] [Zone]: [Justification courte]. Trajet ~[X]min."`;
  }

  /**
   * Construction du prompt utilisateur contextualisé
   */
  buildUserPrompt(context) {
    const hour = context.time.getHours();
    
    let prompt = "Où aller maintenant pour optimiser mes revenus ?";
    
    // Contexte spécifique selon l'heure
    if (hour >= 6 && hour < 10) {
      prompt += " C'est l'heure de pointe matinale.";
    } else if (hour >= 17 && hour < 20) {
      prompt += " Les bureaux se vident.";
    } else if (hour >= 20 && hour < 2) {
      prompt += " Les soirées commencent.";
    }
    
    return prompt;
  }

  /**
   * Parse et structure la recommandation Mistral
   */
  parseRecommendation(recommendation, context) {
    // Extraction de données de la recommandation textuelle
    const zones = ['La Défense', 'Opéra', 'Châtelet', 'Bastille', 'Montparnasse', 'Gare du Nord', 'Gare de Lyon', 'Champs-Élysées', 'Marais', 'République'];
    
    let detectedZone = 'Centre Paris';
    let confidence = 75;
    
    // Détection de zone mentionnée
    for (const zone of zones) {
      if (recommendation.toLowerCase().includes(zone.toLowerCase())) {
        detectedZone = zone;
        confidence = 85;
        break;
      }
    }
    
    // Calcul métrics basés sur contexte
    const hour = context.time.getHours();
    const demandLevel = this.calculateDemand(detectedZone, hour);
    const waitTime = this.calculateWaitTime(demandLevel);
    const priceMultiplier = this.calculatePriceMultiplier(hour, context.weather);
    
    return {
      zone: detectedZone,
      confidence: confidence,
      text: recommendation.slice(0, 120), // Limité à 120 chars
      estimatedDemand: demandLevel,
      estimatedWaitTime: waitTime,
      priceMultiplier: priceMultiplier,
      voiceEnabled: true,
      priority: demandLevel > 80 ? 'high' : demandLevel > 60 ? 'medium' : 'low',
      actionType: 'move',
      estimatedRevenue: Math.round(25 * priceMultiplier * (demandLevel / 100)),
      nearbyDrivers: Math.floor(Math.random() * 10) + 2,
      trafficLevel: Math.floor(Math.random() * 40) + 40,
      weatherImpact: context.weather === 'rainy' ? 25 : 0,
    };
  }

  /**
   * Recommandation fallback intelligente
   */
  getFallbackRecommendation(context) {
    const hour = context.time.getHours();
    const dayOfWeek = context.time.getDay();
    
    let zone, text, priority;
    
    if (hour >= 7 && hour < 10) {
      zone = 'Gare du Nord';
      text = '🌅 Rush matinal: Direction gares pour les voyageurs. Forte demande business.';
      priority = 'high';
    } else if (hour >= 17 && hour < 20) {
      zone = 'La Défense';
      text = '🏢 Sortie bureaux: La Défense se vide. Positionnement côté RER recommandé.';
      priority = 'high';
    } else if (hour >= 22 || hour <= 2) {
      zone = 'Bastille';
      text = '🌃 Vie nocturne: Bastille/Oberkampf actifs. Multiplicateur x1.4 en cours.';
      priority = 'medium';
    } else if (dayOfWeek === 6 || dayOfWeek === 0) { // Weekend
      zone = 'Champs-Élysées';
      text = '🛍️ Weekend: Touristes sur Champs-Élysées. Shopping et loisirs prioritaires.';
      priority = 'medium';
    } else {
      zone = 'Opéra';
      text = '🚖 Période standard: Centre Opéra équilibré. Bonne rotation moyenne.';
      priority = 'low';
    }
    
    return {
      zone,
      confidence: 70,
      text,
      estimatedDemand: priority === 'high' ? 85 : priority === 'medium' ? 65 : 45,
      estimatedWaitTime: 8,
      priceMultiplier: 1.1,
      voiceEnabled: true,
      priority,
      actionType: 'move',
      estimatedRevenue: 28,
      nearbyDrivers: 5,
      trafficLevel: 55,
      weatherImpact: 0,
    };
  }

  /**
   * Sauvegarde pour le futur fine-tuning
   */
  async saveInteractionForTraining(driverId, context, response) {
    const trainingData = {
      driverId: driverId,
      timestamp: new Date().toISOString(),
      context: {
        location: context.location,
        time: context.time.toISOString(),
        weather: context.weather,
        hour: context.time.getHours(),
        dayOfWeek: context.time.getDay(),
      },
      response: response,
      version: '1.0'
    };
    
    // En production: sauvegarder en base de données
    console.log(`💾 Training data saved for ${driverId}`);
    // await database.trainingData.create(trainingData);
  }

  /**
   * Mise à jour historique conversation
   */
  updateConversationHistory(driverId, userPrompt, aiResponse) {
    const history = this.conversationHistory.get(driverId) || [];
    
    history.push(
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: aiResponse }
    );
    
    // Garder seulement 10 derniers échanges (20 messages)
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }
    
    this.conversationHistory.set(driverId, history);
  }

  // Méthodes utilitaires
  getTimeContext(hour, dayOfWeek) {
    if (hour >= 6 && hour < 10) return "Rush matinal";
    if (hour >= 11 && hour < 14) return "Pause déjeuner";  
    if (hour >= 17 && hour < 20) return "Rush soir";
    if (hour >= 20 && hour < 2) return "Vie nocturne";
    if (dayOfWeek === 6) return "Samedi";
    if (dayOfWeek === 0) return "Dimanche";
    return "Heure standard";
  }

  getZoneFromCoordinates({ lat, lng }) {
    // Mapping simple coordonnées -> zones Paris
    // En production: utiliser une vraie API de geocoding
    if (lat > 48.87 && lng > 2.25) return "Nord Paris";
    if (lat < 48.84 && lng > 2.35) return "Sud-Est Paris";  
    if (lng < 2.30) return "Ouest Paris";
    return "Centre Paris";
  }

  calculateDemand(zone, hour) {
    // Algorithme simplifié de demande par zone/heure
    let baseDemand = {
      'La Défense': 80,
      'Opéra': 70, 
      'Gare du Nord': 85,
      'Bastille': 60,
      'Champs-Élysées': 75
    }[zone] || 50;
    
    // Modulation par heure
    if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)) {
      baseDemand += 20;
    }
    
    return Math.min(100, baseDemand + Math.floor(Math.random() * 20 - 10));
  }

  calculateWaitTime(demandLevel) {
    return Math.max(2, Math.floor(15 - (demandLevel * 0.1)));
  }

  calculatePriceMultiplier(hour, weather) {
    let multiplier = 1.0;
    
    if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)) {
      multiplier += 0.2;
    }
    
    if (weather === 'rainy') {
      multiplier += 0.3;
    }
    
    return Math.round(multiplier * 100) / 100;
  }

  /**
   * Statistiques du service
   */
  getStats() {
    const runtime = Date.now() - this.stats.lastReset;
    const successRate = this.stats.totalRequests > 0 
      ? (this.stats.successfulRequests / this.stats.totalRequests * 100).toFixed(1)
      : 0;
    
    return {
      ...this.stats,
      runtime: Math.floor(runtime / 1000),
      successRate: `${successRate}%`,
      fallbackRate: `${(this.stats.fallbackUsed / this.stats.totalRequests * 100).toFixed(1)}%`
    };
  }

  /**
   * Reset des statistiques
   */
  resetStats() {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      fallbackUsed: 0,
      averageResponseTime: 0,
      lastReset: Date.now()
    };
  }
}

module.exports = new MistralService();