import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Lima';
import { generateSchedule } from '../services/schedule.js';
import { buildSchedulePdf, createPdfDocument } from '../services/pdf.js';
import { calculateInstallmentLateFee } from '../services/payment.js';
import PDFDocument from 'pdfkit';

const prisma = new PrismaClient();
const router = Router();

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Vista previa de prÃ©stamo (no persiste)
router.post(
  '/preview',
  requireAuth,
  body('principal').isFloat({ gt: 0 }),
  body('interestRate').isFloat({ gt: 0 }),
  body('termCount').isInt({ gt: 0 }),
  body('startDate').isISO8601(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { principal, interestRate, termCount, startDate } = req.body;
      // Reglas anteriores de monto mÃ­nimo/mÃ¡ximo eliminadas
      // Regla anterior de tasa mÃ­nima eliminada
      const start = dayjs.tz(startDate, TZ).startOf('day');
      const today = dayjs.tz(new Date(), TZ).startOf('day');
      if (start.isBefore(today)) return res.status(400).json({ error: 'La fecha del prÃ©stamo no puede ser pasada' });

      const schedule = generateSchedule({ principal: Number(principal), interestRate: Number(interestRate), termCount: Number(termCount), startDate });
      const totalInterest = round2(schedule.reduce((a, r) => a + Number(r.interestAmount), 0));
      const totalAmount = round2(schedule.reduce((a, r) => a + Number(r.installmentAmount), 0));
      const installmentAmount = schedule.length ? Number(schedule[0].installmentAmount) : 0;
      const lastDueDate = schedule.length ? schedule[schedule.length - 1].dueDate : null;
      res.json({
        summary: {
          principal: Number(principal),
          interestRate: Number(interestRate),
          termCount: Number(termCount),
          startDate,
          installmentAmount: round2(installmentAmount),
          totalInterest,
          totalAmount,
          lastDueDate
        },
        schedule
      });
    } catch (e) { next(e); }
  }
);

// Listar prÃ©stamos con filtros bÃ¡sicos
router.get(
  '/',
  requireAuth,
  query('clientId').optional().isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const where = {};
      if (req.query.clientId) where.clientId = Number(req.query.clientId);
      const loans = await prisma.loan.findMany({ where, include: { client: true, createdBy: true }, orderBy: { id: 'desc' } });
      res.json(loans);
    } catch (e) { next(e); }
  }
);

// Crear un prÃ©stamo y su cronograma
router.post(
  '/',
  requireAuth,
  body('clientId').isInt(),
  body('principal').isFloat({ gt: 0 }),
  body('interestRate').isFloat({ gt: 0 }),
  body('termCount').isInt({ gt: 0 }),
  body('startDate').isISO8601(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { clientId, principal, interestRate, termCount, startDate } = req.body;
      const userId = Number(req.user?.sub || req.user?.id);
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
      // ValidaciÃ³n de fecha: no en pasado (solo fecha, no hora)
      const start = dayjs.tz(startDate, TZ).startOf('day');
      const today = dayjs.tz(new Date(), TZ).startOf('day');
      if (start.isBefore(today)) return res.status(400).json({ error: 'La fecha del prÃ©stamo no puede ser pasada' });

      // Reglas anteriores de monto mÃ­nimo/mÃ¡ximo eliminadas
      // Regla anterior de tasa mÃ­nima eliminada
      if (Number(principal) >= 5350 && req.body.declarationAccepted !== true) {
        return res.status(400).json({ error: 'Para montos desde S/ 5,350 debe descargar y aceptar la DeclaraciÃ³n Jurada.' });
      }

      const client = await prisma.client.findUnique({ where: { id: Number(clientId) } });
      if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

      // Regla: un solo préstamo por cliente (no se permite más de uno)
      const existing = await prisma.loan.findFirst({ where: { clientId: client.id } });
      if (existing) {
        return res.status(400).json({ error: 'El cliente ya tiene un préstamo registrado.' });
      }

      const createdLoan = await prisma.$transaction(async (tx) => {
        const loan = await tx.loan.create({
          data: {
            clientId: client.id,
            createdByUserId: userId,
            principal: String(principal),
            interestRate: String(interestRate),
            termCount,
            // Guardar la fecha de inicio a mediodÃ­a en Lima para evitar desfase (-05:00)
            startDate: dayjs.tz(startDate, TZ).hour(12).minute(0).second(0).millisecond(0).toDate()
          }
        });

        const schedule = generateSchedule({ principal: Number(principal), interestRate: Number(interestRate), termCount, startDate });
        await Promise.all(schedule.map((row) => tx.paymentSchedule.create({
          data: {
            loanId: loan.id,
            installmentNumber: row.installmentNumber,
            dueDate: row.dueDate,
            installmentAmount: String(row.installmentAmount),
            principalAmount: String(row.principalAmount),
            interestAmount: String(row.interestAmount),
            remainingBalance: String(row.remainingBalance)
          }
        })));

        return loan;
      });

      const full = await prisma.loan.findUnique({ where: { id: createdLoan.id }, include: { client: true, schedules: true } });
      res.status(201).json(full);
    } catch (e) { next(e); }
  }
);

// Detalle de préstamo con cronograma
router.get(
  '/:id',
  requireAuth,
  param('id').isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const loan = await prisma.loan.findUnique({ where: { id }, include: { client: true, createdBy: true, schedules: { orderBy: { installmentNumber: 'asc' } } } });
      if (!loan) return res.status(404).json({ error: 'Préstamo no encontrado' });
      res.json(loan);
    } catch (e) { next(e); }
  }
);

// Obtener cronograma con mora calculada
router.get(
  '/:id/schedules-with-mora',
  requireAuth,
  param('id').isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const loan = await prisma.loan.findUnique({ 
        where: { id }, 
        include: { 
          schedules: { orderBy: { installmentNumber: 'asc' } },
          payments: { orderBy: { paymentDate: 'asc' } }
        } 
      });
      if (!loan) return res.status(404).json({ error: 'Préstamo no encontrado' });
      
      // Calcular mora para cada cuota
      const schedulesWithMora = loan.schedules.map(schedule => {
        const { hasLateFee, lateFeeAmount } = calculateInstallmentLateFee(schedule, loan.payments);
        return {
          ...schedule,
          hasLateFee,
          lateFeeAmount,
        };
      });
      
      res.json(schedulesWithMora);
    } catch (e) { next(e); }
  }
);

// Exportar cronograma a PDF
router.get(
  '/:id/schedule.pdf',
  requireAuth,
  param('id').isInt(),
  handleValidation,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const loan = await prisma.loan.findUnique({ 
        where: { id }, 
        include: { 
          client: true, 
          schedules: { orderBy: { installmentNumber: 'asc' } },
          payments: { orderBy: { paymentDate: 'asc' } }
        } 
      });
      if (!loan) return res.status(404).json({ error: 'PrÃ©stamo no encontrado' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cronograma_loan_${loan.id}.pdf"`);
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      doc.pipe(res);
      buildSchedulePdf(doc, { client: loan.client, loan, schedule: loan.schedules, payments: loan.payments });
      doc.end();
    } catch (e) { next(e); }
  }
);

export default router;



