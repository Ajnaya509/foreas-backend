-- =====================================================
-- Migration : Systeme de parrainage FOREAS
-- 3 niveaux : 10 EUR N1, 4 EUR N2, 2 EUR N3
-- =====================================================

-- Ajouter colonne referral_code sur drivers (si absente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'referral_code'
  ) THEN
    ALTER TABLE drivers ADD COLUMN referral_code TEXT UNIQUE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_drivers_referral_code ON drivers(referral_code);

-- Table referrals (arbre parrain/filleul)
CREATE TABLE IF NOT EXISTS referrals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sponsor_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  level INT NOT NULL DEFAULT 1 CHECK (level IN (1, 2, 3)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_id, level),
  CHECK(sponsor_id != referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_sponsor ON referrals(sponsor_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- Table commissions parrainage
CREATE TABLE IF NOT EXISTS referral_commissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sponsor_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  level INT NOT NULL CHECK (level IN (1, 2, 3)),
  amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
  source_amount DECIMAL(10,2) NOT NULL,
  invoice_id TEXT,
  subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ref_comm_sponsor ON referral_commissions(sponsor_id);
CREATE INDEX IF NOT EXISTS idx_ref_comm_referred ON referral_commissions(referred_id);
CREATE INDEX IF NOT EXISTS idx_ref_comm_status ON referral_commissions(status);
CREATE INDEX IF NOT EXISTS idx_ref_comm_created ON referral_commissions(created_at);

-- Fonction RPC pour somme commissions
CREATE OR REPLACE FUNCTION sum_referral_commissions(p_sponsor_id UUID)
RETURNS DECIMAL AS $$
  SELECT COALESCE(SUM(amount), 0)
  FROM referral_commissions
  WHERE sponsor_id = p_sponsor_id AND status = 'paid';
$$ LANGUAGE sql STABLE;

-- Trigger updated_at sur referrals
CREATE OR REPLACE FUNCTION update_referrals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_referrals_updated_at ON referrals;
CREATE TRIGGER trg_referrals_updated_at
  BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION update_referrals_updated_at();

-- RLS referrals
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'referrals_select_own') THEN
    CREATE POLICY referrals_select_own ON referrals FOR SELECT
      USING (auth.uid() = sponsor_id OR auth.uid() = referred_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'referrals_insert_service') THEN
    CREATE POLICY referrals_insert_service ON referrals FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referrals' AND policyname = 'referrals_update_service') THEN
    CREATE POLICY referrals_update_service ON referrals FOR UPDATE USING (true);
  END IF;
END $$;

-- RLS referral_commissions
ALTER TABLE referral_commissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_commissions' AND policyname = 'ref_comm_select_own') THEN
    CREATE POLICY ref_comm_select_own ON referral_commissions FOR SELECT
      USING (auth.uid() = sponsor_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'referral_commissions' AND policyname = 'ref_comm_insert_service') THEN
    CREATE POLICY ref_comm_insert_service ON referral_commissions FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- Backfill : generer codes parrainage pour drivers existants sans code
DO $$
DECLARE
  r RECORD;
  new_code TEXT;
  first_init CHAR(1);
  last_init CHAR(1);
  digits INT;
BEGIN
  FOR r IN SELECT id, first_name, last_name FROM drivers WHERE referral_code IS NULL
  LOOP
    first_init := UPPER(LEFT(COALESCE(r.first_name, 'X'), 1));
    last_init := UPPER(LEFT(COALESCE(r.last_name, r.first_name, 'X'), 1));
    digits := 10 + floor(random() * 90)::int;
    new_code := 'FOREAS-' || first_init || last_init || digits::text;
    UPDATE drivers SET referral_code = new_code WHERE id = r.id;
  END LOOP;
END $$;
