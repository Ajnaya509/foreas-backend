/**
 * Bolt Fleet API Routes
 * Expose les données Bolt Fleet pour le frontend et Ajnaya
 */
import { Router, Request, Response } from 'express';
import { boltFleet } from '../services/boltFleet.js';

const router = Router();

// GET /api/bolt/status — État de la connexion Bolt
router.get('/status', async (_req: Request, res: Response) => {
  res.json({
    configured: boltFleet.isConfigured,
    has_token: !!(await boltFleet.getToken()),
  });
});

// GET /api/bolt/companies — Liste des companies
router.get('/companies', async (_req: Request, res: Response) => {
  try {
    const ids = await boltFleet.loadCompanyIds();
    res.json({ success: true, company_ids: ids });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bolt/orders?company_id=X&days=7&limit=50
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.company_id ? parseInt(req.query.company_id as string) : undefined;
    const days = parseInt(req.query.days as string) || 7;
    const limit = parseInt(req.query.limit as string) || 50;
    const orders = await boltFleet.getOrders(companyId, days, limit);
    res.json({ success: true, count: orders.length, orders });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bolt/orders/all?days=7 — Courses de TOUTES les companies
router.get('/orders/all', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const results = await boltFleet.getAllOrders(days);
    const totalOrders = results.reduce((sum, r) => sum + r.orders.length, 0);
    res.json({
      success: true,
      companies: results.length,
      total_orders: totalOrders,
      data: results,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bolt/drivers?company_id=X
router.get('/drivers', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.company_id ? parseInt(req.query.company_id as string) : undefined;
    const drivers = await boltFleet.getDrivers(companyId);
    res.json({ success: true, count: drivers.length, drivers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bolt/vehicles?company_id=X
router.get('/vehicles', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.company_id ? parseInt(req.query.company_id as string) : undefined;
    const vehicles = await boltFleet.getVehicles(companyId);
    res.json({ success: true, count: vehicles.length, vehicles });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bolt/stats?company_id=X&days=7 — Stats agrégées
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const companyId = req.query.company_id ? parseInt(req.query.company_id as string) : undefined;
    const days = parseInt(req.query.days as string) || 7;
    const stats = await boltFleet.computeStats(companyId, days);
    res.json({ success: true, stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/bolt/ajnaya-context — Résumé compact pour Ajnaya
router.get('/ajnaya-context', async (_req: Request, res: Response) => {
  try {
    const context = await boltFleet.getAjnayaContext();
    res.json({ success: true, context });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
