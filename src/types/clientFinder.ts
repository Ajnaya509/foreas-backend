/**
 * Client Finder — Types backend
 * Ajnaya2026v86
 */

export type PlaceTypeFamily = 'HOSPITALITY' | 'HIGH_INCOME' | 'EVENT';

export type OutreachResponseType = 'POSITIVE' | 'NEGATIVE' | 'IGNORED';

export interface PlaceDirectory {
  id: string;
  google_place_id: string;
  name: string;
  place_type: string;
  place_type_family: PlaceTypeFamily;
  address: string | null;
  city: string;
  lat: number | null;
  lng: number | null;
  contact_email: string | null;
  contact_name: string | null;
  contact_title: string | null;
  enrichment_source: 'GOOGLE_PLACES' | 'MANUAL' | 'N8N';
  enriched_at: string | null;
  quality_score: number;
  created_at: string;
  updated_at: string;
}

export interface ClientFinderSettings {
  driver_id: string;
  enabled: boolean;
  daily_limit: number;
  target_families: PlaceTypeFamily[];
  city_slug: string;
  driver_presentation: string | null;
  custom_signature: string | null;
  pause_until: string | null;
  voice_calls_enabled: boolean;
  max_voice_calls_per_week: number;
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientFinderPerformance {
  id: string;
  driver_id: string;
  place_id: string;
  place_type_family: PlaceTypeFamily;
  outreach_sent_at: string;
  response_at: string | null;
  response_type: OutreachResponseType | null;
  converted_at: string | null;
  revenue_generated: number | null;
  ai_model: string;
  outreach_subject: string | null;
  created_at: string;
}

export interface OutreachRequest {
  driverName: string;
  driverPresentation?: string;
  customSignature?: string;
  place: {
    name: string;
    placeType: string;
    placeTypeFamily: PlaceTypeFamily;
    address: string;
    city: string;
    contactName?: string;
    contactTitle?: string;
  };
}

export interface OutreachResult {
  subject: string;
  body: string;
  model: string;
}

export interface FinderRunResult {
  driverId: string;
  prospectsScanned: number;
  emailsSent: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

// 9 types de lieux × 3 familles
export const PLACE_TYPES_BY_FAMILY: Record<PlaceTypeFamily, string[]> = {
  HOSPITALITY: ['hotel', 'luxury_hotel', 'business_hotel'],
  HIGH_INCOME: ['golf_course', 'country_club', 'private_bank'],
  EVENT: ['convention_center', 'concert_hall', 'wedding_venue'],
};

// ── v87 Phase 2A : véhicule + conversation ──────────────────────

export type VehicleFeature =
  | 'wifi'
  | 'usb_c'
  | 'water'
  | 'leather'
  | 'baby_seat'
  | 'phone_charger'
  | 'tablet'
  | 'english_speaking'
  | 'arabic_speaking'
  | 'spanish_speaking';

export interface DriverVehicleProfile {
  id: string;
  driver_id: string;
  make: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  seats: number;
  license_plate: string | null;
  photo_url: string | null;
  features: VehicleFeature[];
  commercial_name: string | null;
  is_validated: boolean;
}

export type ThreadStatus = 'OPEN' | 'CLOSED_WON' | 'CLOSED_LOST' | 'SILENT' | 'HANDOFF_PENDING';
export type MessageDirection = 'OUT' | 'IN';
export type MessageSequenceType =
  | 'INITIAL'
  | 'FOLLOWUP_1'
  | 'FOLLOWUP_2'
  | 'REPLY'
  | 'HANDOFF'
  | 'AGREEMENT'
  | 'HANDOFF_CONFIRMATION'
  | 'REPLY_FAILED'
  | 'VOICE_CALL'
  | 'VOICE_SUMMARY';

export interface EmailThread {
  id: string;
  log_id: string;
  driver_id: string;
  thread_subject: string | null;
  status: ThreadStatus;
  messages_count: number;
  last_message_at: string | null;
  last_direction: MessageDirection | null;
}

export type EmailIntent =
  | 'INTERESTED'
  | 'QUESTION_PRICE'
  | 'QUESTION_AVAILABILITY'
  | 'QUESTION_VEHICLE'
  | 'OBJECTION_ALREADY_PARTNER'
  | 'OBJECTION_PRICE'
  | 'OBJECTION_NOT_NOW'
  | 'NOT_INTERESTED'
  | 'HANDOFF_REQUEST'
  | 'UNCLEAR';

export const ALL_EMAIL_INTENTS: EmailIntent[] = [
  'INTERESTED',
  'QUESTION_PRICE',
  'QUESTION_AVAILABILITY',
  'QUESTION_VEHICLE',
  'OBJECTION_ALREADY_PARTNER',
  'OBJECTION_PRICE',
  'OBJECTION_NOT_NOW',
  'NOT_INTERESTED',
  'HANDOFF_REQUEST',
  'UNCLEAR',
];

// ── v88 Phase 2B : appels téléphoniques Ajnaya ──────────────────

export type VoiceCallStatus =
  | 'INITIATED'
  | 'RINGING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'FAILED'
  | 'TRANSFERRED'
  | 'HANGUP_PROSPECT'
  | 'HANGUP_AJNAYA';

export type VoiceCallOutcome =
  | 'CONVERTED'
  | 'INTERESTED'
  | 'CALLBACK_REQUESTED'
  | 'DECLINED'
  | 'UNREACHABLE'
  | 'TECH_FAILURE';

export interface VoiceCall {
  id: string;
  thread_id: string | null;
  log_id: string | null;
  driver_id: string;
  place_id: string | null;
  elevenlabs_conversation_id: string | null;
  twilio_call_sid: string | null;
  from_number: string;
  to_number: string;
  status: VoiceCallStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  transferred_to_driver: boolean;
  transfer_success: boolean | null;
  outcome: VoiceCallOutcome | null;
  cost_estimate_eur: number | null;
  call_summary: string | null;
  full_transcript: any;
  analysis_data: any;
  robot_detected_count: number;
  language_detected: string;
  created_at: string;
}

export interface ObjectionPlaybook {
  id: string;
  objection_category: string;
  response_template: string;
  language: string;
  times_used: number;
  times_succeeded: number;
  success_rate: number;
  is_active: boolean;
}

export interface MLWeight {
  id: string;
  driver_id: string;
  dimension: string;
  weight: number;
  samples_count: number;
  last_updated: string;
}

export interface ApolloEnrichmentResult {
  place_id: string;
  contact_email: string | null;
  contact_name: string | null;
  contact_title: string | null;
  contact_linkedin: string | null;
  contact_seniority: string | null;
  phone: string | null;
  apollo_org_id: string | null;
  apollo_person_id: string | null;
  credits_used: number;
  status: 'SUCCESS' | 'NO_RESULT' | 'ERROR' | 'RATE_LIMITED';
}

export type PlaceTypeFamilyExtended =
  | 'HOSPITALITY'
  | 'HIGH_INCOME'
  | 'EVENT'
  | 'GASTRONOMY'
  | 'CORPORATE'
  | 'HEALTH_LUXURY'
  | 'REAL_ESTATE'
  | 'DIPLOMATIC';
