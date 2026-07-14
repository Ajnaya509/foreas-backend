/**
 * account.routes.ts — Suppression de compte in-app (conformité Apple 5.1.1(v)).
 * ═══════════════════════════════════════════════════════════════════════════
 * POST /api/account/delete
 *   Header  Authorization: Bearer <supabase access_token du chauffeur>
 *   Effet   supprime définitivement le compte auth + les données du chauffeur.
 *
 * Apple exige une suppression RÉELLE, initiée ET complétée dans l'app (un simple
 * lien web ne suffit pas / n'est pas trouvé par le reviewer). Ici : le chauffeur
 * confirme dans l'app → l'app appelle cet endpoint avec SON token → le compte
 * est supprimé côté serveur (service_role) → l'app le déconnecte.
 *
 * Sécurité : le token prouve l'identité ; on ne supprime QUE le compte de ce token.
 * Best-effort sur les tables filles (ne bloque pas si l'une échoue) ; la suppression
 * auth (auth.admin.deleteUser) est l'étape qui compte — après elle, plus de login.
 */
import { Router, Request, Response } from 'express';

const router = Router();

let admin: any = null;
async function getAdmin() {
  if (!admin) {
    const { createClient } = await import('@supabase/supabase-js');
    admin = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return admin;
}

// POST /api/account/delete
router.post('/delete', async (req: Request, res: Response) => {
  const authz = req.headers.authorization || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const sb = await getAdmin();

    // 1. Vérifier le token → identité réelle du demandeur
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user?.id) {
      return res.status(401).json({ error: 'Session invalide' });
    }
    const userId: string = userData.user.id;

    // 2. Nettoyage best-effort des données du chauffeur (ne bloque jamais la suppression).
    //    On tente les deux clés possibles (id = auth uid, ou user_id/driver_id = auth uid).
    const bestEffort = async (table: string, col: string) => {
      try {
        await sb.from(table).delete().eq(col, userId);
      } catch (e: any) {
        console.warn(`[Account] cleanup ${table}.${col} KO:`, e?.message);
      }
    };
    await bestEffort('driver_sites', 'driver_id');
    await bestEffort('bookings', 'driver_id');
    await bestEffort('driver_reviews', 'driver_id');
    await bestEffort('user_preferences', 'user_id');
    await bestEffort('subscriptions', 'driver_id');
    await bestEffort('pieuvre_in_app_messages', 'driver_id');
    await bestEffort('drivers', 'id');
    await bestEffort('drivers', 'user_id');
    await bestEffort('users', 'id');

    // 3. Suppression du compte auth — l'étape décisive (après : plus aucun login possible).
    const { error: delErr } = await sb.auth.admin.deleteUser(userId);
    if (delErr) {
      console.error('[Account] auth delete KO:', delErr.message);
      return res.status(500).json({ error: 'Suppression impossible, réessaie.' });
    }

    console.log(`[Account] ✅ Compte supprimé : ${userId.slice(0, 8)}…`);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[Account] delete error:', err?.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

export const accountRouter = router;
