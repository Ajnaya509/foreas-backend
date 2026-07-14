-- =====================================================
-- MIGRATION : Prospect ↔ Driver Bridge
-- =====================================================
-- Crée le pont entre les prospects acquisitions (VPS Pieuvre)
-- et les chauffeurs inscrits (Railway App).
-- Permet à Ajnaya in-app de connaître l'historique prospect.
--
-- Commit v68 — 7 avril 2026
-- =====================================================

-- ── 1. Colonnes sur pieuvre_prospects ──────────────
-- driver_id  : ID Prisma du chauffeur (CUID format, ex: clxxx...)
-- converted_at : timestamp de la conversion inscription→app
-- converted_channel : canal d'acquisition (whatsapp, widget_site, call, etc.)

ALTER TABLE pieuvre_prospects
  ADD COLUMN IF NOT EXISTS driver_id        text,
  ADD COLUMN IF NOT EXISTS converted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS converted_channel text;

-- Index pour lookup rapide par driver_id
CREATE INDEX IF NOT EXISTS idx_pieuvre_prospects_driver_id
  ON pieuvre_prospects(driver_id)
  WHERE driver_id IS NOT NULL;

-- ── 2. Table pont centrale ─────────────────────────
-- Source de vérité bidirectionnelle, indépendante des deux systèmes.
-- Le téléphone est la clé universelle de matching.

CREATE TABLE IF NOT EXISTS foreas_identity_bridge (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identité unifiée
  phone           text NOT NULL,          -- format E.164, ex: +33612345678

  -- Côté acquisition (VPS Pieuvre)
  prospect_id     uuid,                   -- pieuvre_prospects.id
  prospect_channel text,                  -- canal d'origine: whatsapp|widget_site|call|sms
  prospect_score  int DEFAULT 0,          -- score engagement au moment de la conversion
  prospect_first_seen_at timestamptz,     -- première interaction Pieuvre

  -- Côté app (Railway / Prisma)
  driver_id       text,                   -- Prisma Driver.id (CUID)
  driver_user_id  text,                   -- Prisma User.id (CUID)
  converted_at    timestamptz DEFAULT now(),

  -- Intégrité
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),

  -- Contraintes
  UNIQUE(phone),
  UNIQUE(driver_id),
  UNIQUE(prospect_id)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_identity_bridge_driver_id
  ON foreas_identity_bridge(driver_id)
  WHERE driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_bridge_prospect_id
  ON foreas_identity_bridge(prospect_id)
  WHERE prospect_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_identity_bridge_phone
  ON foreas_identity_bridge(phone);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION handle_identity_bridge_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_identity_bridge_updated ON foreas_identity_bridge;
CREATE TRIGGER on_identity_bridge_updated
  BEFORE UPDATE ON foreas_identity_bridge
  FOR EACH ROW
  EXECUTE FUNCTION handle_identity_bridge_updated_at();

-- RLS : service_role bypass, auth.uid impossible car accès backend uniquement
ALTER TABLE foreas_identity_bridge ENABLE ROW LEVEL SECURITY;

-- Seul le service_role peut lire/écrire (pas de policy restrictive pour les users)
-- Les appels viennent toujours du backend avec service_role key

-- ── 3. Vue pratique pour debug ─────────────────────
CREATE OR REPLACE VIEW v_prospect_driver_conversions AS
SELECT
  b.phone,
  b.prospect_channel        AS acquisition_channel,
  b.prospect_score          AS score_at_conversion,
  b.prospect_first_seen_at  AS first_seen,
  b.converted_at,
  EXTRACT(EPOCH FROM (b.converted_at - b.prospect_first_seen_at)) / 86400
                            AS days_to_convert,
  b.driver_id,
  b.prospect_id,
  p.status                  AS prospect_status,
  p.first_name              AS prospect_name
FROM foreas_identity_bridge b
LEFT JOIN pieuvre_prospects p ON p.id = b.prospect_id
ORDER BY b.converted_at DESC;

-- ── 4. Vérification ────────────────────────────────
-- SELECT * FROM foreas_identity_bridge LIMIT 5;
-- SELECT * FROM v_prospect_driver_conversions LIMIT 5;
