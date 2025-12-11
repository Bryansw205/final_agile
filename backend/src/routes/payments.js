import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { PrismaClient } from '@prisma/client';
import { 
  registerPayment,
  registerAdvancePayment, 
  getLoanStatement, 
  calculateLateFees 
} from '../services/payment.js';
import { buildPaymentReceipt, createPdfDocument } from '../services/pdf.js';

const router = Router();
const prisma = new PrismaClient();

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
  body('amountGiven').optional().isFloat({ gt: 0 }),
  body('change').optional().isFloat({ min: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { loanId, amount, paymentMethod, cashSessionId, installmentId, externalReference, amountGiven, change } = req.body;
      const registeredByUserId = req.user.id;

      // Validación: Si es pago FLOW, externalReference es requerido
      if (paymentMethod === 'FLOW' && !externalReference) {
        return res.status(400).json({ error: 'Para pagos con Flow, se requiere externalReference' });
      }

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
        amountGiven: amountGiven ? Number(amountGiven) : null,
        change: change !== undefined ? Number(change) : null,
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
          receiptType: payment.receiptType,
          invoiceRuc: payment.invoiceRuc,
          invoiceBusinessName: payment.invoiceBusinessName,
          invoiceAddress: payment.invoiceAddress,
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

      if (!payment.receiptType) {
        return res.status(400).json({ error: 'El comprobante aún no ha sido configurado' });
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
              schedules: { orderBy: { installmentNumber: 'asc' } },
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

      // Si es un pago adelantado (sin installmentId), obtener todas las cuotas pagadas relacionadas
      // El sistema crea múltiples pagos (uno por cuota) con el mismo receiptNumber base
      if (!payment.installmentId && payment.loan.schedules) {
        // Buscar todos los pagos con el mismo receiptNumber base (sin sufijo)
        const baseReceiptNumber = payment.receiptNumber.split('-')[0];
        const relatedPayments = await prisma.payment.findMany({
          where: {
            loanId: payment.loanId,
            receiptNumber: {
              startsWith: baseReceiptNumber,
            },
            paymentDate: payment.paymentDate, // Mismo día
          },
        });

        // Construir lista de cuotas pagadas de estos pagos
        const installmentsPaid = [];
        for (const relatedPayment of relatedPayments) {
          if (relatedPayment.installmentId) {
            const schedule = payment.loan.schedules.find(s => s.id === relatedPayment.installmentId);
            if (schedule) {
              installmentsPaid.push({
                id: schedule.id,
                installmentNumber: schedule.installmentNumber,
                dueDate: schedule.dueDate,
                installmentAmount: Number(schedule.installmentAmount),
                amountPaid: Number(relatedPayment.amount),
                principalPaid: Number(relatedPayment.principalPaid || 0),
                interestPaid: Number(relatedPayment.interestPaid || 0),
                lateFeePaid: Number(relatedPayment.lateFeePaid || 0),
              });
            }
          }
        }
        if (installmentsPaid.length > 0) {
          payment.installmentsPaid = installmentsPaid;
        }
      }

      const type = (payment.receiptType || 'BOLETA').toLowerCase();
      
      // Contar pagos del mismo tipo generados hasta ahora (para correlativo secuencial)
      const paymentCount = await prisma.payment.count({
        where: {
          receiptType: payment.receiptType || 'BOLETA',
          id: { lte: payment.id }, // Contar solo pagos con ID menor o igual al actual
        },
      });
      
      const invoiceInfo = {
        type,
        correlative: paymentCount, // Número secuencial 1, 2, 3, etc.
        customerRuc: payment.invoiceRuc || '',
        customerName: payment.invoiceBusinessName || '',
        customerAddress: payment.invoiceAddress || '',
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
        where: { loanId: Number(req.params.loanId), receiptType: { not: null } },
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
          receiptType: p.receiptType,
          invoiceRuc: p.invoiceRuc,
          invoiceBusinessName: p.invoiceBusinessName,
          invoiceAddress: p.invoiceAddress,
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

      // Convertir Decimals a números y filtrar pagos con comprobante configurado
      const paymentsWithReceipt = statement.payments
        .filter((p) => !!p.receiptType)
        .map(p => ({
          ...p,
          amount: Number(p.amount),
          principalPaid: Number(p.principalPaid),
          interestPaid: Number(p.interestPaid),
          lateFeePaid: Number(p.lateFeePaid),
          roundingAdjustment: Number(p.roundingAdjustment),
          receiptType: p.receiptType,
          invoiceRuc: p.invoiceRuc,
          invoiceBusinessName: p.invoiceBusinessName,
          invoiceAddress: p.invoiceAddress,
        }));

      res.json({
        ...statement,
        schedule: statement.schedule.map(s => ({
          ...s,
          installmentAmount: Number(s.installmentAmount),
          principalAmount: Number(s.principalAmount),
          interestAmount: Number(s.interestAmount),
          remainingBalance: Number(s.remainingBalance),
        })),
        payments: paymentsWithReceipt,
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

/**
 * POST /payments/advance
 * Registra un pago adelantado para múltiples cuotas
 */
router.post(
  '/advance',
  requireAuth,
  body('loanId').isInt({ gt: 0 }),
  body('amount').isFloat({ gt: 0 }),
  body('paymentMethod').isIn(['EFECTIVO', 'BILLETERA_DIGITAL', 'TARJETA_DEBITO', 'TARJETA', 'YAPE', 'PLIN', 'FLOW', 'OTRO']),
  body('cashSessionId').isInt({ gt: 0 }),
  body('installmentIds').isArray({ min: 1 }),
  body('installmentIds.*').isInt({ gt: 0 }),
  body('externalReference').optional().isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { loanId, amount, paymentMethod, cashSessionId, installmentIds, externalReference } = req.body;
      const registeredByUserId = req.user.id;

      // Validación: Si es pago FLOW, externalReference es requerido
      if (paymentMethod === 'FLOW' && !externalReference) {
        return res.status(400).json({ error: 'Para pagos con Flow, se requiere externalReference' });
      }

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

      const payment = await registerAdvancePayment({
        loanId: Number(loanId),
        amount: Number(amount),
        paymentMethod,
        registeredByUserId,
        cashSessionId: Number(cashSessionId),
        installmentIds: installmentIds.map(id => Number(id)),
        externalReference,
      });

      // Obtener todos los payment IDs creados por este adelanto
      // Buscar pagos creados recientemente para este préstamo (últimos 5 segundos)
      const advancePayments = await prisma.payment.findMany({
        where: {
          loanId: Number(loanId),
          createdAt: {
            gte: new Date(Date.now() - 5000), // Últimos 5 segundos
          },
        },
        select: { id: true },
      });
      const paymentIds = advancePayments.map(p => p.id);

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
          installmentsPaid: payment.installmentsPaid || [],
          paymentIds: paymentIds,
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
 * POST /payments/advance/receipt-config
 * Actualiza el tipo de comprobante para múltiples pagos del adelanto
 */
router.post(
  '/advance/receipt-config',
  requireAuth,
  body('paymentIds').isArray({ min: 1 }),
  body('paymentIds.*').isInt({ gt: 0 }),
  body('receiptType').isIn(['BOLETA', 'FACTURA']),
  body('invoiceRuc').optional({ checkFalsy: true }).matches(/^[0-9]{11}$/),
  body('invoiceBusinessName').optional({ checkFalsy: true }).isString(),
  body('invoiceAddress').optional({ checkFalsy: true }).isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { paymentIds, receiptType, invoiceRuc, invoiceBusinessName, invoiceAddress } = req.body;

      // Actualizar todos los pagos con la información del comprobante
      const updateData = { receiptType };
      if (receiptType === 'FACTURA') {
        updateData.invoiceRuc = invoiceRuc || null;
        updateData.invoiceBusinessName = invoiceBusinessName || null;
        updateData.invoiceAddress = invoiceAddress || null;
      } else {
        // Si es BOLETA, limpiar datos de invoice
        updateData.invoiceRuc = null;
        updateData.invoiceBusinessName = null;
        updateData.invoiceAddress = null;
      }

      await prisma.payment.updateMany({
        where: {
          id: { in: paymentIds },
        },
        data: updateData,
      });

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /payments/:id/receipt-info
 * Guarda el tipo de comprobante e info de factura
 */
router.post(
  '/:id/receipt-info',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  body('receiptType').isIn(['BOLETA', 'FACTURA']),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { receiptType, invoiceRuc, invoiceBusinessName, invoiceAddress } = req.body;

      // Validación condicional: FACTURA requiere datos de invoice
      if (receiptType === 'FACTURA') {
        const errors = [];
        if (!invoiceRuc || typeof invoiceRuc !== 'string') {
          errors.push({ path: 'invoiceRuc', msg: 'invoiceRuc es requerido para FACTURA' });
        }
        if (!invoiceBusinessName || typeof invoiceBusinessName !== 'string') {
          errors.push({ path: 'invoiceBusinessName', msg: 'invoiceBusinessName es requerido para FACTURA' });
        }
        if (!invoiceAddress || typeof invoiceAddress !== 'string') {
          errors.push({ path: 'invoiceAddress', msg: 'invoiceAddress es requerido para FACTURA' });
        }
        if (errors.length > 0) {
          return res.status(400).json({ errors });
        }
      }
      
      const updated = await prisma.payment.update({
        where: { id },
        data: {
          receiptType,
          invoiceRuc: invoiceRuc || null,
          invoiceBusinessName: invoiceBusinessName || null,
          invoiceAddress: invoiceAddress || null,
        },
        select: {
          id: true,
          receiptType: true,
          invoiceRuc: true,
          invoiceBusinessName: true,
          invoiceAddress: true,
          installmentId: true,
        },
      });

      // Marcar la cuota como pagada si ya se cubrió el monto
      if (updated.installmentId) {
        const installment = await prisma.paymentSchedule.findUnique({
          where: { id: updated.installmentId },
        });
        const paymentsForInstallment = await prisma.payment.findMany({
          where: { installmentId: updated.installmentId, receiptType: { not: null } },
          select: { amount: true },
        });
        const totalPaid = paymentsForInstallment.reduce((sum, p) => sum + Number(p.amount), 0);
        if (installment && totalPaid >= Number(installment.installmentAmount)) {
          await prisma.paymentSchedule.update({
            where: { id: installment.id },
            data: { isPaid: true, remainingBalance: 0 },
          });
        }
      }

      res.json({ success: true, payment: updated });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /payments/:id/receipt-multi
 * Descarga múltiples boletas para pagos adelantados (una por cuota)
 */
router.get(
  '/:id/receipt-multi',
  requireAuth,
  param('id').isInt({ gt: 0 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const prisma = new PrismaClient();
      
      const mainPayment = await prisma.payment.findUnique({
        where: { id: Number(req.params.id) },
        include: {
          loan: {
            include: {
              client: true,
              schedules: { orderBy: { installmentNumber: 'asc' } },
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

      if (!mainPayment) {
        return res.status(404).json({ error: 'Pago no encontrado' });
      }

      // Buscar todos los pagos relacionados al mismo adelantado
      // Los pagos adelantados comparten: mismo loanId, createdAt cercano, mismo registeredByUserId
      const timeWindow = 60000; // 60 segundos
      const relatedPayments = await prisma.payment.findMany({
        where: {
          loanId: mainPayment.loanId,
          registeredByUserId: mainPayment.registeredByUserId,
          createdAt: {
            gte: new Date(new Date(mainPayment.createdAt).getTime() - timeWindow),
            lte: new Date(new Date(mainPayment.createdAt).getTime() + timeWindow),
          },
          receiptType: { not: null },
          installmentId: { not: null }, // Solo pagos con cuotas específicas
        },
        include: {
          installment: true,
          loan: {
            include: {
              client: true,
              schedules: { orderBy: { installmentNumber: 'asc' } },
            },
          },
          registeredBy: {
            select: {
              id: true,
              username: true,
            },
          },
        },
        orderBy: { installment: { installmentNumber: 'asc' } },
      });

      // Si no hay múltiples pagos, devolver error
      if (relatedPayments.length <= 1) {
        return res.status(400).json({ error: 'Este pago no es un adelanto múltiple' });
      }

      // Crear un PDF multi-página
      const { createPdfDocument } = await import('../services/pdf.js');
      const { buildPaymentReceipt } = await import('../services/pdf.js');

      const doc = createPdfDocument();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=boletas-adelanto-${mainPayment.receiptNumber}.pdf`);
      
      doc.pipe(res);

      // Generar una página por cada pago
      for (let i = 0; i < relatedPayments.length; i++) {
        const payment = relatedPayments[i];
        const type = (payment.receiptType || 'BOLETA').toLowerCase();
        
        const paymentCount = await prisma.payment.count({
          where: {
            receiptType: payment.receiptType || 'BOLETA',
            id: { lte: payment.id },
          },
        });
        
        const invoiceInfo = {
          type,
          correlative: paymentCount,
          customerRuc: payment.invoiceRuc || '',
          customerName: payment.invoiceBusinessName || '',
          customerAddress: payment.invoiceAddress || '',
        };

        buildPaymentReceipt(doc, payment, invoiceInfo);
        
        // Agregar página nueva si no es la última
        if (i < relatedPayments.length - 1) {
          doc.addPage();
        }
      }

      doc.end();
    } catch (error) {
      next(error);
    }
  }
);

export default router;
