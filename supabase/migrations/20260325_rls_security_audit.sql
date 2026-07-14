-- Migration : Audit sécurité RLS complet — Ajnaya2026v59
-- Supprime les policies dangereuses (qual = true) sur drivers
-- Ajoute RLS sur toutes les tables manquantes

-- Fix drivers: supprimer les policies ouvertes
DROP POLICY IF EXISTS drivers_select_own ON drivers;
DROP POLICY IF EXISTS drivers_update_own ON drivers;

-- Partenaire peut voir/modifier les chauffeurs de sa flotte
CREATE POLICY IF NOT EXISTS drivers_select_partner ON drivers
FOR SELECT USING (partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid()));

CREATE POLICY IF NOT EXISTS drivers_update_partner ON drivers
FOR UPDATE USING (partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid()))
WITH CHECK (partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid()));

-- Sécuriser partner_commissions INSERT
DROP POLICY IF EXISTS partner_commissions_insert ON partner_commissions;
CREATE POLICY IF NOT EXISTS partner_commissions_insert_service ON partner_commissions
FOR INSERT WITH CHECK (partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid()));

-- Sécuriser partner_referrals INSERT
DROP POLICY IF EXISTS partner_referrals_insert ON partner_referrals;
CREATE POLICY IF NOT EXISTS partner_referrals_insert_service ON partner_referrals
FOR INSERT WITH CHECK (partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid()));

-- ajnaya_conversations
ALTER TABLE ajnaya_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS ajnaya_conv_select_own ON ajnaya_conversations FOR SELECT USING (auth.uid()::text = driver_id::text);
CREATE POLICY IF NOT EXISTS ajnaya_conv_insert_own ON ajnaya_conversations FOR INSERT WITH CHECK (auth.uid()::text = driver_id::text);

-- devices
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS devices_select_own ON devices FOR SELECT USING (auth.uid()::text = user_id::text);
CREATE POLICY IF NOT EXISTS devices_insert_own ON devices FOR INSERT WITH CHECK (auth.uid()::text = user_id::text);

-- activity_logs + drivers_referral_audit = admin only
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS activity_logs_service ON activity_logs FOR ALL USING (false);

ALTER TABLE drivers_referral_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS ref_audit_service ON drivers_referral_audit FOR ALL USING (false);

-- Données agrégées = lecture publique
ALTER TABLE zone_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS zone_patterns_read ON zone_patterns FOR SELECT USING (true);

ALTER TABLE ajnaya_community_aggregates ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS community_agg_read ON ajnaya_community_aggregates FOR SELECT USING (true);

ALTER TABLE community_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS community_alerts_read ON community_alerts FOR SELECT USING (true);
