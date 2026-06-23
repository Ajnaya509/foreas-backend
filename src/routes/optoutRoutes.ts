/**
 * Opt-out routes — Désinscription publique (RGPD)
 * Ajnaya2026v87.1
 *
 * GET /api/optout/:token  → valide + ajoute à finder_optout_list + page HTML
 * GET /optout/:token      → alias raccourci (mêmes handlers)
 */

import { Router, Request, Response } from 'express';
import { decodeOptoutToken, addToOptoutList } from '../services/OptoutService.js';

const router = Router();

function renderHtml(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #050508; color: #fff;
    padding: 60px 20px; text-align: center; max-width: 520px; margin: 0 auto; }
  h1 { color: #8C52FF; margin-bottom: 16px; }
  p { color: #D1D5DB; line-height: 1.6; }
  a { color: #00D4FF; }
  .box { background: #0C0C14; border: 1px solid #1A1A2E; border-radius: 16px; padding: 32px; }
</style>
</head><body><div class="box">${body}</div></body></html>`;
}

router.get('/optout/:token', async (req: Request, res: Response) => {
  const email = decodeOptoutToken(req.params.token);
  if (!email) {
    return res
      .status(400)
      .send(
        renderHtml(
          'Lien invalide',
          '<h1>❌ Lien invalide</h1><p>Ce lien de désabonnement est incorrect ou a expiré.</p>',
        ),
      );
  }

  try {
    await addToOptoutList(email, 'link');
    return res.status(200).send(
      renderHtml(
        'Désabonnement confirmé',
        `<h1>✅ Désabonnement confirmé</h1>
         <p>L'adresse <strong>${escapeHtml(email)}</strong> ne recevra plus aucun message de FOREAS.</p>
         <p>Une erreur ? <a href="mailto:contact@foreas.xyz">contact@foreas.xyz</a></p>`,
      ),
    );
  } catch (err: any) {
    console.error('[Optout] Error:', err?.message);
    return res
      .status(500)
      .send(
        renderHtml(
          'Erreur',
          '<h1>⚠️ Erreur serveur</h1><p>Merci de réessayer dans un instant.</p>',
        ),
      );
  }
});

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export default router;
