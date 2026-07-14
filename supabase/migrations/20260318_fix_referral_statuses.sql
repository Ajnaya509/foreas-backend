-- Migration: Fix statuses commissions parrainage
-- Ajoute 'counting' et 'cycle_completed' aux statuts autorises
-- + contrainte level 0 pour les marqueurs de cycle

-- Supprimer l'ancienne contrainte de statut
ALTER TABLE referral_commissions DROP CONSTRAINT IF EXISTS referral_commissions_status_check;

-- Ajouter la nouvelle avec les statuts supplementaires
ALTER TABLE referral_commissions ADD CONSTRAINT referral_commissions_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'counting', 'cycle_completed'));

-- Autoriser level 0 pour les marqueurs de cycle
ALTER TABLE referral_commissions DROP CONSTRAINT IF EXISTS referral_commissions_level_check;
ALTER TABLE referral_commissions ADD CONSTRAINT referral_commissions_level_check
  CHECK (level >= 0 AND level <= 3);

-- Index pour le verrou anti-double
CREATE INDEX IF NOT EXISTS idx_ref_comm_cycle_check
  ON referral_commissions(referred_id, status)
  WHERE status IN ('cycle_completed', 'counting');
