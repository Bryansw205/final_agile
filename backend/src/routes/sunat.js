import { Router } from 'express';
import { query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getCompanyByRuc } from '../services/rucService.js';

const router = Router();

router.get(
  '/ruc',
  requireAuth,
  query('numero').isString().matches(/^[0-9]{11}$/),
  handleValidation,
  async (req, res, next) => {
    try {
      const { numero } = req.query;
      const company = await getCompanyByRuc(String(numero));
      res.json(company);
    } catch (e) { next(e); }
  }
);

export default router;
