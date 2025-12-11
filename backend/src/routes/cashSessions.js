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
import {
  getCashSessionBalance,
  validateChangeAvailable,
  addCashMovement,
  getCashMovements,
  getCashSessionSummary,
} from '../services/cashService.js';
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

/**
 * GET /cash-sessions/:sessionId/balance
 * Obtiene el saldo actual de efectivo en caja
 */
router.get(
  '/:sessionId/balance',
  requireAuth,
  param('sessionId').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const balance = await getCashSessionBalance(Number(sessionId));

      res.json({
        success: true,
        ...balance,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /cash-sessions/:sessionId/movements
 * Registra un movimiento de caja (ingreso de efectivo)
 */
router.post(
  '/:sessionId/movements',
  requireAuth,
  param('sessionId').isInt({ gt: 0 }),
  body('movementType').isIn(['INGRESO', 'EGRESO', 'VUELTO', 'RECAUDACION']),
  body('amount').isFloat({ gt: 0 }),
  body('description').optional().isString(),
  body('relatedPaymentId').optional().isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { movementType, amount, description, relatedPaymentId } = req.body;

      const movement = await addCashMovement({
        cashSessionId: Number(sessionId),
        movementType,
        amount: Number(amount),
        description,
        relatedPaymentId: relatedPaymentId ? Number(relatedPaymentId) : null,
      });

      res.status(201).json({
        success: true,
        movement,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/:sessionId/movements
 * Obtiene todos los movimientos de una sesión de caja
 */
router.get(
  '/:sessionId/movements',
  requireAuth,
  param('sessionId').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const movements = await getCashMovements(Number(sessionId));

      res.json({
        success: true,
        movements,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /cash-sessions/:sessionId/summary
 * Obtiene el resumen de una sesión de caja para cierre
 */
router.get(
  '/:sessionId/summary',
  requireAuth,
  param('sessionId').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const summary = await getCashSessionSummary(Number(sessionId));

      res.json({
        success: true,
        ...summary,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /cash-sessions/:sessionId/validate-change
 * Valida si hay suficiente efectivo para dar vuelto
 */
router.post(
  '/:sessionId/validate-change',
  requireAuth,
  param('sessionId').isInt({ gt: 0 }),
  body('changeAmount').isFloat({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { changeAmount } = req.body;

      const validation = await validateChangeAvailable(
        Number(sessionId),
        Number(changeAmount)
      );

      res.json({
        success: true,
        ...validation,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /cash-sessions/:sessionId/add-cash
 * Agrega dinero a la caja (ingreso de propietario)
 */
router.post(
  '/:sessionId/add-cash',
  requireAuth,
  param('sessionId').isInt({ gt: 0 }),
  body('amount').isFloat({ gt: 0 }),
  body('description').optional().isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { sessionId } = req.params;
      const { amount, description } = req.body;

      // Verificar que la sesión existe y no está cerrada
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const session = await prisma.cashSession.findUnique({
        where: { id: Number(sessionId) },
      });

      if (!session) {
        return res.status(404).json({ error: 'Sesión de caja no encontrada' });
      }

      if (session.isClosed) {
        return res.status(400).json({ error: 'La sesión de caja está cerrada' });
      }

      // Registrar el ingreso de dinero
      const movement = await addCashMovement({
        cashSessionId: Number(sessionId),
        movementType: 'INGRESO',
        amount: Number(amount),
        description: description || 'Ingreso de dinero a caja',
        relatedPaymentId: null,
      });

      // Obtener el balance actualizado
      const balance = await getCashSessionBalance(Number(sessionId));

      res.status(201).json({
        success: true,
        movement: {
          id: movement.id,
          movementType: movement.movementType,
          amount: Number(movement.amount),
          description: movement.description,
          createdAt: movement.createdAt,
        },
        cashBalance: balance.currentBalance,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
