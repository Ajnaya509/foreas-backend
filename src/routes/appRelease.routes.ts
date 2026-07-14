/**
 * appRelease.routes.ts — expose côté public la vraie version Android en
 * ligne sur le Play Store, pour le bandeau "mets à jour" de l'app
 * (AppReleaseGateService.ts côté mobile). Miroir de l'iTunes Lookup API
 * qu'utilise directement l'app pour iOS — ici il faut passer par le
 * serveur car la clé de compte de service ne doit jamais vivre côté client.
 *
 * GET /api/app-release/android → { versionCode: number | null }
 * Public, pas de secret : juste un numéro de version, rien de sensible.
 */
import { Router, Request, Response } from 'express';
import { getCachedLatestAndroidVersionCode } from '../services/GooglePlayReleaseService';

const router = Router();

router.get('/android', async (_req: Request, res: Response) => {
  try {
    const versionCode = await getCachedLatestAndroidVersionCode();
    return res.json({ versionCode });
  } catch (err: any) {
    console.error('[AppRelease] android error:', err?.message);
    return res.json({ versionCode: null });
  }
});

export const appReleaseRouter = router;
