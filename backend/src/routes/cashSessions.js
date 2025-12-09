import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  openCashSession,
  closeCashSession,
  getCurrentCashSession,
  getCashSessionHistory,
  getCashSessionDetail,
  getDailyCashReport,
} from '../services/cashSession.js';
import { buildCashSessionReport, createPdfDocument } from '../services/pdf.js';

const router = Router();

/**
 * POST /cash-sessions
 * Abre una nueva sesión de caja
 */
router.post(
  '/',
  requireAuth,
  body('openingBalance').isFloat({ min: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { openingBalance } = req.body;
      const userId = req.user.id;

      const session = await openCashSession({
        userId,
        openingBalance: Number(openingBalance),
      });

      res.status(201).json({
        success: true,
        session: {
          id: session.id,
          userId: session.userId,
          user: session.user,
          openingBalance: Number(session.openingBalance),
          openedAt: session.openedAt,
          isClosed: session.isClosed,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/current
 * Obtiene la sesión de caja actual del usuario
 */
router.get(
  '/current',
  requireAuth,
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const session = await getCurrentCashSession(userId);

      if (!session) {
        return res.json({ session: null });
      }

      res.json({
        session: {
          ...session,
          openingBalance: Number(session.openingBalance),
          closingBalance: session.closingBalance ? Number(session.closingBalance) : null,
          physicalBalance: session.physicalBalance ? Number(session.physicalBalance) : null,
          difference: session.difference ? Number(session.difference) : null,
          payments: session.payments.map(p => ({
            ...p,
            amount: Number(p.amount),
            principalPaid: Number(p.principalPaid),
            interestPaid: Number(p.interestPaid),
            lateFeePaid: Number(p.lateFeePaid),
            roundingAdjustment: Number(p.roundingAdjustment),
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /cash-sessions/:id/close
 * Cierra una sesión de caja
 */
router.post(
  '/:id/close',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  body('physicalBalance').isFloat({ min: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { physicalBalance } = req.body;
      const sessionId = Number(req.params.id);

      const session = await closeCashSession({
        sessionId,
        physicalBalance: Number(physicalBalance),
      });

      res.json({
        success: true,
        session: {
          ...session,
          openingBalance: Number(session.openingBalance),
          closingBalance: Number(session.closingBalance),
          physicalBalance: Number(session.physicalBalance),
          difference: Number(session.difference),
          payments: session.payments.map(p => ({
            ...p,
            amount: Number(p.amount),
            principalPaid: Number(p.principalPaid),
            interestPaid: Number(p.interestPaid),
            lateFeePaid: Number(p.lateFeePaid),
            roundingAdjustment: Number(p.roundingAdjustment),
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/:id
 * Obtiene el detalle de una sesión de caja
 */
router.get(
  '/:id',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const sessionId = Number(req.params.id);
      const session = await getCashSessionDetail(sessionId);

      res.json({
        session: {
          ...session,
          openingBalance: Number(session.openingBalance),
          closingBalance: session.closingBalance ? Number(session.closingBalance) : null,
          physicalBalance: session.physicalBalance ? Number(session.physicalBalance) : null,
          difference: session.difference ? Number(session.difference) : null,
          payments: session.payments.map(p => ({
            ...p,
            amount: Number(p.amount),
            principalPaid: Number(p.principalPaid),
            interestPaid: Number(p.interestPaid),
            lateFeePaid: Number(p.lateFeePaid),
            roundingAdjustment: Number(p.roundingAdjustment),
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/:id/report
 * Descarga el reporte de cierre de caja en PDF
 */
router.get(
  '/:id/report',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const sessionId = Number(req.params.id);
      const session = await getCashSessionDetail(sessionId);

      const doc = createPdfDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=cierre-caja-${sessionId}.pdf`);

      doc.pipe(res);
      buildCashSessionReport(doc, session);
      doc.end();
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/history
 * Obtiene el historial de sesiones de caja
 */
router.get(
  '/history/list',
  requireAuth,
  query('userId').optional().isInt({ gt: 0 }),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { userId, startDate, endDate, limit } = req.query;

      const sessions = await getCashSessionHistory({
        userId: userId ? Number(userId) : undefined,
        startDate,
        endDate,
        limit: limit ? Number(limit) : 50,
      });

      res.json({
        sessions: sessions.map(s => ({
          ...s,
          openingBalance: Number(s.openingBalance),
          closingBalance: s.closingBalance ? Number(s.closingBalance) : null,
          physicalBalance: s.physicalBalance ? Number(s.physicalBalance) : null,
          difference: s.difference ? Number(s.difference) : null,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/report/daily
 * Obtiene el reporte de caja del día
 */
router.get(
  '/report/daily',
  requireAuth,
  query('date').isISO8601(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { date } = req.query;
      const report = await getDailyCashReport(date);

      res.json({
        report: {
          ...report,
          payments: report.payments.map(p => ({
            ...p,
            amount: Number(p.amount),
            principalPaid: Number(p.principalPaid),
            interestPaid: Number(p.interestPaid),
            lateFeePaid: Number(p.lateFeePaid),
            roundingAdjustment: Number(p.roundingAdjustment),
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
