/**
 * Realtime Adapters — APIs temps réel pour Ajnaya
 *
 * Phase 1 (gratuit) :
 * ✅ OpenWeather — météo Paris temps réel
 * ✅ SNCF Open Data — arrivées TGV gares parisiennes
 * ✅ PredictHQ — événements majeurs Paris
 * ✅ TomTom Traffic — trafic routier temps réel
 * ✅ IDFM/RATP PRIM — perturbations métro/RER
 * ✅ Calendrier — jours fériés + vacances scolaires
 * ✅ X/Twitter — signaux sociaux grèves/manifs
 *
 * Chaque adapter retourne un string compact (~30-100 tokens)
 * injecté dans le system prompt via collectRealtimeContext().
 */

export { getWeatherContext } from './WeatherAdapter';
export { getTrainContext } from './SNCFAdapter';
export { getEventsContext } from './PredictHQAdapter';
export { getTrafficContext } from './TomTomTrafficAdapter';
export { getTransportContext } from './IDFMAdapter';
export { getCalendarContext } from './FrenchCalendarAdapter';
export { getSocialContext } from './XTwitterAdapter';
