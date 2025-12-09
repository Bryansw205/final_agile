import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { 
  registerPayment, 
  getLoanStatement, 
  calculateLateFees 
} from '../services/payment.js';
import { buildPaymentReceipt, createPdfDocument } from '../services/pdf.js';

const router = Router();

/**
 * POST /payments
 * Registra un pago
 */
router.post(
  '/',
  requireAuth,
  body('loanId').isInt({ gt: 0 }),
  body('amount').isFloat({ gt: 0 }),
  body('paymentMethod').isIn(['EFECTIVO', 'BILLETERA_DIGITAL', 'TARJETA_DEBITO', 'TARJETA', 'YAPE', 'PLIN', 'FLOW', 'OTRO']),
  body('cashSessionId').isInt({ gt: 0 }),
  body('installmentId').optional().isInt({ gt: 0 }),
  body('externalReference').optional().isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { loanId, amount, paymentMethod, cashSessionId, installmentId, externalReference } = req.body;
      const registeredByUserId = req.user.id;

      if (
        paymentMethod === 'EFECTIVO' &&
        (Math.round(Number(amount) * 100) % 10 !== 0)
      ) {
        return res.status(400).json({ error: 'Para pagos en efectivo, solo se permiten montos en múltiplos de S/ 0.10' });
      }

      if (
        (paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') &&
        Number(amount) < 2
      ) {
        return res.status(400).json({ error: 'El monto mínimo para billetera digital o tarjeta débito es S/ 2.00' });
      }

      const payment = await registerPayment({
        loanId: Number(loanId),
        amount: Number(amount),
        paymentMethod,
        registeredByUserId,
        cashSessionId: Number(cashSessionId),
        installmentId: installmentId ? Number(installmentId) : null,
        externalReference,
      });

      res.status(201).json({
        success: true,
        payment: {
          id: payment.id,
          receiptNumber: payment.receiptNumber,
          amount: Number(payment.amount),
          paymentMethod: payment.paymentMethod,
          paymentDate: payment.paymentDate,
          principalPaid: Number(payment.principalPaid),
          interestPaid: Number(payment.interestPaid),
          lateFeePaid: Number(payment.lateFeePaid),
          roundingAdjustment: Number(payment.roundingAdjustment),
          loan: {
            id: payment.loan.id,
            client: payment.loan.client,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/:id
 * Obtiene un pago por ID
 */
router.get(
  '/:id',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const payment = await prisma.payment.findUnique({
        where: { id: Number(req.params.id) },
        include: {
          loan: {
            include: {
              client: true,
            },
          },
          registeredBy: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      if (!payment) {
        return res.status(404).json({ error: 'Pago no encontrado' });
      }

      res.json({
        id: payment.id,
        receiptNumber: payment.receiptNumber,
        amount: Number(payment.amount),
        paymentMethod: payment.paymentMethod,
        paymentDate: payment.paymentDate,
        principalPaid: Number(payment.principalPaid),
        interestPaid: Number(payment.interestPaid),
        lateFeePaid: Number(payment.lateFeePaid),
        roundingAdjustment: Number(payment.roundingAdjustment),
        externalReference: payment.externalReference,
        loan: {
          id: payment.loan.id,
          client: payment.loan.client,
        },
        registeredBy: payment.registeredBy,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/:id/receipt
 * Descarga el comprobante de pago en PDF
 */
router.get(
  '/:id/receipt',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const payment = await prisma.payment.findUnique({
        where: { id: Number(req.params.id) },
        include: {
          loan: {
            include: {
              client: true,
            },
          },
          registeredBy: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      if (!payment) {
        return res.status(404).json({ error: 'Pago no encontrado' });
      }

      const type = (req.query.type || 'boleta').toString().toLowerCase();
      if (!['boleta', 'factura'].includes(type)) {
        return res.status(400).json({ error: 'Tipo de comprobante inválido' });
      }
      const invoiceInfo = {
        type,
        customerRuc: req.query.customerRuc || '',
        customerName: req.query.customerName || '',
        customerAddress: req.query.customerAddress || '',
      };

      const doc = createPdfDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=comprobante-${payment.receiptNumber}.pdf`);
      
      doc.pipe(res);
      buildPaymentReceipt(doc, payment, invoiceInfo);
      doc.end();
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/loan/:loanId
 * Obtiene todos los pagos de un préstamo
 */
router.get(
  '/loan/:loanId',
  requireAuth,
  param('loanId').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const payments = await prisma.payment.findMany({
        where: { loanId: Number(req.params.loanId) },
        include: {
          registeredBy: {
            select: {
              id: true,
              username: true,
            },
          },
        },
        orderBy: {
          paymentDate: 'desc',
        },
      });

      res.json({
        payments: payments.map(p => ({
          id: p.id,
          receiptNumber: p.receiptNumber,
          amount: Number(p.amount),
          paymentMethod: p.paymentMethod,
          paymentDate: p.paymentDate,
          principalPaid: Number(p.principalPaid),
          interestPaid: Number(p.interestPaid),
          lateFeePaid: Number(p.lateFeePaid),
          roundingAdjustment: Number(p.roundingAdjustment),
          registeredBy: p.registeredBy,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/loan/:loanId/statement
 * Obtiene el estado de cuenta de un préstamo
 */
router.get(
  '/loan/:loanId/statement',
  requireAuth,
  param('loanId').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const statement = await getLoanStatement(Number(req.params.loanId));
      
      // Convertir Decimals a números
      res.json({
        ...statement,
        schedule: statement.schedule.map(s => ({
          ...s,
          installmentAmount: Number(s.installmentAmount),
          principalAmount: Number(s.principalAmount),
          interestAmount: Number(s.interestAmount),
          remainingBalance: Number(s.remainingBalance),
        })),
        payments: statement.payments.map(p => ({
          ...p,
          amount: Number(p.amount),
          principalPaid: Number(p.principalPaid),
          interestPaid: Number(p.interestPaid),
          lateFeePaid: Number(p.lateFeePaid),
          roundingAdjustment: Number(p.roundingAdjustment),
        })),
        lateFees: statement.lateFees.map(f => ({
          ...f,
          feeAmount: Number(f.feeAmount),
          baseAmount: Number(f.baseAmount),
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/loan/:loanId/calculate-late-fees
 * Calcula y registra las moras de un préstamo
 */
router.post(
  '/loan/:loanId/calculate-late-fees',
  requireAuth,
  param('loanId').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const loanId = Number(req.params.loanId);
      const result = await calculateLateFees(loanId);

      // Crear las moras que no existen
      if (result.lateFees.length > 0) {
        await prisma.lateFee.createMany({
          data: result.lateFees,
          skipDuplicates: true,
        });
      }

      res.json({
        success: true,
        loanId,
        lateFees: result.lateFees.map(f => ({
          ...f,
          feeAmount: Number(f.feeAmount),
          baseAmount: Number(f.baseAmount),
        })),
        totalLateFee: result.totalLateFee,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
