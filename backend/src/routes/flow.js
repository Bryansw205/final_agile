import { Router } from 'express';
import { body, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createFlowPayment,
  getFlowPaymentStatus,
  getFlowStatusText,
  mapFlowPaymentMethod,
} from '../services/flowService.js';
import { calculateAdvancePaymentAmount, registerAdvancePayment, registerPayment } from '../services/payment.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();
const OUTSTANDING_TOLERANCE = 0.05;

async function finalizeReceiptForFlowPayment(externalReference) {
  // NO asigna automáticamente BOLETA - deja que el usuario elija el tipo de comprobante
  const payments = await prisma.payment.findMany({
    where: { externalReference, receiptType: null },
  });

  for (const payment of payments) {
    // Solo marcar cuota pagada si ya se cubrió el monto, sin asignar receiptType
    if (payment.installmentId) {
      const installment = await prisma.paymentSchedule.findUnique({
        where: { id: payment.installmentId },
      });
      if (installment) {
        const paymentsForInstallment = await prisma.payment.findMany({
          where: { installmentId: payment.installmentId, receiptType: { not: null } },
          select: { amount: true },
        });
        const totalPaid = paymentsForInstallment.reduce(
          (sum, p) => sum + Number(p.amount),
          0
        );
        // Solo contar pagos con receiptType asignado para marcar como pagado
        if (totalPaid >= Number(installment.installmentAmount) - OUTSTANDING_TOLERANCE) {
          await prisma.paymentSchedule.update({
            where: { id: payment.installmentId },
            data: { isPaid: true, remainingBalance: 0 },
          });
        }
      }
    }
  }
}

/**
 * POST /flow/create-payment
 * Crea una orden de pago en Flow
 */
router.post(
  '/create-payment',
  requireAuth,
  body('loanId').isInt({ gt: 0 }),
  body('amount').isFloat({ gt: 0 }),
  body('installmentId').optional().isInt({ gt: 0 }),
  body('email').isEmail(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { loanId, amount, email, installmentId } = req.body;
      const userId = req.user.id;

      if (Number(amount) < 2) {
        return res.status(400).json({ error: 'El monto mínimo para billetera digital o tarjeta débito es S/ 2.00' });
      }

      // Verificar que el préstamo existe
      const loan = await prisma.loan.findUnique({
        where: { id: Number(loanId) },
        include: { client: true },
      });

      if (!loan) {
        return res.status(404).json({ error: 'Préstamo no encontrado' });
      }

      // Validar que el usuario tenga una sesión de caja abierta
      const cashSession = await prisma.cashSession.findFirst({
        where: { userId, isClosed: false },
      });

      if (!cashSession) {
        return res.status(400).json({ error: 'Debe abrir una sesión de caja antes de registrar pagos' });
      }

      // Crear orden de pago en Flow
      const commerceOrder = `LOAN-${loanId}-${Date.now()}`;
      const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const ownerEmail = process.env.OWNER_EMAIL || email;
      
      console.log('💾 Guardando intención de pago:', { loanId, userId, installmentId, commerceOrder });
      
      const flowPayment = await createFlowPayment({
        amount: Number(amount),
        subject: `Pago préstamo #${loanId} - ${loan.client.firstName} ${loan.client.lastName}`,
        email: ownerEmail,
        commerceOrder,
        urlConfirmation: `${baseUrl}/flow/webhook`,
        urlReturn: `${frontendUrl}/loans/${loanId}?from=flow`,
        paymentMethod: 9, // 9 = Todos los medios de pago
        optional: { loanId, userId, installmentId: installmentId || null, cashSessionId: cashSession.id, commerceOrder },
      });

      console.log('✅ Orden Flow creada:', { flowOrder: flowPayment.flowOrder, commerceOrder });

      // Guardar en caché en memoria: comerceOrder -> installmentId
      if (!global.flowPaymentCache) global.flowPaymentCache = {};
      global.flowPaymentCache[flowPayment.flowOrder] = {
        loanId,
        userId,
        installmentId: installmentId || null,
        amount: Number(amount),
        cashSessionId: cashSession.id,
      };
      console.log('📌 Información guardada en cache para flowOrder:', flowPayment.flowOrder);

      res.json({
        success: true,
        paymentUrl: flowPayment.url,
        token: flowPayment.token,
        flowOrder: flowPayment.flowOrder,
        commerceOrder,
      });
    } catch (error) {
      console.error('Error creando pago en Flow:', error);
      next(error);
    }
  }
);


/**
 * POST /flow/create-advance-payment
 * Crea una orden de pago en Flow para adelantar varias cuotas
 */
router.post(
  '/create-advance-payment',
  requireAuth,
  body('loanId').isInt({ gt: 0 }),
  body('installmentIds').isArray({ min: 1 }),
  body('installmentIds.*').isInt({ gt: 0 }),
  body('email').isEmail(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { loanId, email, installmentIds } = req.body;
      const userId = req.user.id;

      const loan = await prisma.loan.findUnique({
        where: { id: Number(loanId) },
        include: { client: true },
      });

      if (!loan) {
        return res.status(404).json({ error: 'Pr?stamo no encontrado' });
      }

      const cashSession = await prisma.cashSession.findFirst({
        where: { userId, isClosed: false },
      });

      if (!cashSession) {
        return res.status(400).json({ error: 'Debe abrir una sesi?n de caja antes de registrar pagos' });
      }

      const calculation = await calculateAdvancePaymentAmount({
        loanId: Number(loanId),
        installmentIds: (installmentIds || []).map((id) => Number(id)),
        registeredByUserId: userId,
        cashSessionId: cashSession.id,
      });

      const amountToCharge = Number(calculation.totalOwed);

      const commerceOrder = `ADV-LOAN-${loanId}-${Date.now()}`;
      const baseUrl = process.env.BASE_URL || 'http://localhost:4000';
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const ownerEmail = process.env.OWNER_EMAIL || email;

      const flowPayment = await createFlowPayment({
        amount: amountToCharge,
        subject: `Adelanto pr?stamo #${loanId} (${calculation.selectedInstallments.length} cuotas) - ${loan.client.firstName} ${loan.client.lastName}`,
        email: ownerEmail,
        commerceOrder,
        urlConfirmation: `${baseUrl}/flow/webhook`,
        urlReturn: `${frontendUrl}/loans/${loanId}?from=flow`,
        paymentMethod: 9,
        optional: {
          loanId,
          userId,
          installmentIds: calculation.selectedInstallments.map((s) => s.id),
          cashSessionId: cashSession.id,
          commerceOrder,
          isAdvance: true,
        },
      });

      if (!global.flowPaymentCache) global.flowPaymentCache = {};
      global.flowPaymentCache[flowPayment.flowOrder] = {
        loanId,
        userId,
        installmentIds: calculation.selectedInstallments.map((s) => s.id),
        amount: amountToCharge,
        cashSessionId: cashSession.id,
        isAdvance: true,
      };

      res.json({
        success: true,
        paymentUrl: flowPayment.url,
        token: flowPayment.token,
        flowOrder: flowPayment.flowOrder,
        commerceOrder,
        amount: amountToCharge,
      });
    } catch (error) {
      console.error('Error creando pago adelantado en Flow:', error);
      next(error);
    }
  }
);

/**
 * GET /flow/payment-status
 * Obtiene el estado de un pago en Flow y lo registra si está pagado
 */
router.get(
  '/payment-status',
  requireAuth,
  query('token').isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { token } = req.query;
      const userId = req.user.id;
      const status = await getFlowPaymentStatus(token);

      console.log('🔍 Flow payment-status completo:', JSON.stringify(status, null, 2));

      // Si el pago está exitoso (status = 2), intentar registrarlo
      if (status.status === 2) {
        console.log('💳 Pago exitoso detectado, flowOrder:', status.flowOrder);
        
        // Primero intentar recuperar del optional
        let optional = status.optional;
        let installmentId = optional?.installmentId || null;
        let installmentIds = Array.isArray(optional?.installmentIds)
          ? optional.installmentIds.map((id) => Number(id))
          : [];
        let cashSessionId = optional?.cashSessionId ? Number(optional.cashSessionId) : null;
        let registeredByUserId = optional?.userId ? Number(optional.userId) : userId;
        const isAdvance = optional?.isAdvance === true || optional?.isAdvance === 'true';

        // Si falta informaci?n, intentar desde cache
        if (status.flowOrder && global.flowPaymentCache) {
          const cached = global.flowPaymentCache[status.flowOrder];
          if (cached) {
            console.log('?? Encontrado en cache:', cached);
            installmentId = installmentId || cached.installmentId || null;
            if ((!installmentIds || installmentIds.length === 0) && cached.installmentIds) {
              installmentIds = cached.installmentIds.map((id) => Number(id));
            }
            optional = optional || cached;
            if (!cashSessionId && cached.cashSessionId) {
              cashSessionId = Number(cached.cashSessionId);
            }
            if (!registeredByUserId && cached.userId) {
              registeredByUserId = Number(cached.userId);
            }
          } else {
            console.log('? No encontrado en cache para flowOrder:', status.flowOrder);
            console.log('?? Cache disponible:', Object.keys(global.flowPaymentCache || {}));
          }
        }

        console.log('?? installmentId final:', installmentId, 'cashSessionId:', cashSessionId, 'installmentIds:', installmentIds);


        if (optional && optional.loanId) {
          const loanId = Number(optional.loanId);
          const targetInstallmentIds = (installmentIds && installmentIds.length > 0)
            ? installmentIds
            : (installmentId ? [Number(installmentId)] : []);

          if (!cashSessionId) {
            return res.status(400).json({ error: 'No hay sesi?n de caja abierta para registrar el pago de Flow' });
          }

          console.log('?? Registrando pago:', { loanId, registeredByUserId, installmentId, installmentIds: targetInstallmentIds, cashSessionId, flowOrder: status.flowOrder });

          const existingPayment = await prisma.payment.findFirst({
            where: {
              externalReference: status.flowOrder.toString(),
            },
          });

          if (!existingPayment) {
            console.log('?? Registrando pago nuevo...');
            const realPaymentMethod = mapFlowPaymentMethod(status.paymentMethod);
            console.log('?? M?todo de pago mapeado: Flow:', status.paymentMethod, '-> BD:', realPaymentMethod);

            if (targetInstallmentIds && targetInstallmentIds.length > 0) {
              await registerAdvancePayment({
                loanId,
                amount: status.amount,
                paymentMethod: realPaymentMethod,
                registeredByUserId,
                cashSessionId,
                installmentIds: targetInstallmentIds,
                externalReference: status.flowOrder.toString(),
              });
              await finalizeReceiptForFlowPayment(status.flowOrder.toString());
            } else {
              await registerPayment({
                loanId,
                amount: status.amount,
                paymentMethod: realPaymentMethod,
                registeredByUserId,
                cashSessionId,
                installmentId,
                externalReference: status.flowOrder.toString(),
              });
              await finalizeReceiptForFlowPayment(status.flowOrder.toString());
            }
          } else {
            console.log(`?? Pago ya exist?a: ${status.flowOrder}`);
          }
        } else {
          console.error('? No se pudo extraer loanId del optional:', optional);
}
      }

      res.json({
        success: true,
        status: {
          ...status,
          statusText: getFlowStatusText(status.status),
        },
      });
    } catch (error) {
      console.error('❌ Error obteniendo estado de Flow:', error);
      next(error);
    }
  }
);

/**
 * GET /flow/check-payment-registered/:loanId/:flowOrder
 * Verifica si un pago de Flow fue registrado en el sistema
 */
router.get(
  '/check-payment-registered/:loanId/:flowOrder',
  requireAuth,
  async (req, res, next) => {
    try {
      const { loanId, flowOrder } = req.params;

      const payment = await prisma.payment.findFirst({
        where: {
          loanId: Number(loanId),
          externalReference: flowOrder,
          paymentMethod: 'FLOW',
        },
      });

      if (payment) {
        console.log('✅ Pago Flow confirmado en BD:', { loanId, flowOrder, paymentId: payment.id });
        res.json({
          registered: true,
          paymentId: payment.id,
          amount: Number(payment.amount),
        });
      } else {
        console.log('⏳ Pago Flow aún no registrado:', { loanId, flowOrder });
        res.json({
          registered: false,
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /flow/webhook
 * Webhook para recibir notificaciones de Flow
 * Este endpoint NO requiere autenticación (es llamado por Flow)
 */
router.post(
  '/webhook',
  async (req, res, next) => {
    try {
      // Flow envía los datos como form data en req.body
      // Puede ser { token } o { token: "..." }
      let token = req.body?.token;
      
      // Si no viene en body, intentar desde query (algunos webhooks lo envían así)
      if (!token) {
        token = req.query?.token;
      }

      console.log('📨 Webhook Flow recibido - body:', JSON.stringify(req.body), 'query:', req.query);

      if (!token) {
        console.error('❌ Webhook Flow: Token no recibido en body ni en query');
        console.error('   Body:', req.body);
        console.error('   Query:', req.query);
        return res.status(200).send('OK'); // Responder OK para que Flow no reintente
      }

      console.log('✅ Webhook Flow: Token recibido:', token);

      // Obtener estado del pago
      const paymentStatus = await getFlowPaymentStatus(token);
      console.log('📊 Estado completo del pago:', JSON.stringify(paymentStatus, null, 2));

      // Solo procesar si el pago fue exitoso (status = 2)
      if (paymentStatus.status === 2) {
        console.log('💳 Webhook: Pago exitoso detectado, flowOrder:', paymentStatus.flowOrder);
        
        // Primero intentar recuperar del optional
        let optional = paymentStatus.optional;
        let installmentId = optional?.installmentId || null;
        let installmentIds = Array.isArray(optional?.installmentIds)
          ? optional.installmentIds.map((id) => Number(id))
          : [];
        let userId = optional?.userId ? Number(optional.userId) : null;
        let cashSessionId = optional?.cashSessionId ? Number(optional.cashSessionId) : null;
        const isAdvance = optional?.isAdvance === true || optional?.isAdvance === 'true';

        // Si no hay datos en optional, intentar desde cache
        if ((!optional || !optional.loanId) && paymentStatus.flowOrder && global.flowPaymentCache) {
          const cached = global.flowPaymentCache[paymentStatus.flowOrder];
          if (cached) {
            console.log('?? Encontrado en cache (webhook):', cached);
            installmentId = cached.installmentId;
            if ((!installmentIds || installmentIds.length === 0) && cached.installmentIds) {
              installmentIds = cached.installmentIds.map((id) => Number(id));
            }
            userId = cached.userId;
            cashSessionId = cashSessionId || (cached.cashSessionId ? Number(cached.cashSessionId) : null);
            optional = cached;
          } else {
            console.log('? No encontrado en cache para flowOrder:', paymentStatus.flowOrder);
            console.log('?? Cache disponible:', Object.keys(global.flowPaymentCache || {}));
          }
        }

        console.log('?? Datos del webhook:', { optional, installmentId, installmentIds, userId, cashSessionId });

        if (optional && optional.loanId) {
          const loanId = Number(optional.loanId);
          const targetInstallmentIds = (installmentIds && installmentIds.length > 0)
            ? installmentIds
            : (installmentId ? [Number(installmentId)] : []);

          if (!cashSessionId) {
            console.error('? No hay sesi?n de caja abierta para registrar el pago de Flow (webhook)');
            return res.status(200).send('OK');
          }

          console.log('?? Webhook registrando:', { loanId, userId, installmentId, installmentIds: targetInstallmentIds, cashSessionId, flowOrder: paymentStatus.flowOrder });

          const existingPayment = await prisma.payment.findFirst({
            where: {
              externalReference: paymentStatus.flowOrder.toString(),
            },
          });

          if (!existingPayment) {
            console.log('?? Registrando pago nuevo...');
            
            const realPaymentMethod = mapFlowPaymentMethod(paymentStatus.paymentMethod);
            console.log('?? M?todo de pago mapeado: Flow:', paymentStatus.paymentMethod, '-> BD:', realPaymentMethod);
            
            if (targetInstallmentIds && targetInstallmentIds.length > 0) {
              await registerAdvancePayment({
                loanId,
                amount: paymentStatus.amount,
                paymentMethod: realPaymentMethod,
                registeredByUserId: userId,
                cashSessionId,
                installmentIds: targetInstallmentIds,
                externalReference: paymentStatus.flowOrder.toString(),
              });
              await finalizeReceiptForFlowPayment(paymentStatus.flowOrder.toString());
            } else {
              await registerPayment({
                loanId,
                amount: paymentStatus.amount,
                paymentMethod: realPaymentMethod,
                registeredByUserId: userId,
                cashSessionId,
                installmentId,
                externalReference: paymentStatus.flowOrder.toString(),
              });
              await finalizeReceiptForFlowPayment(paymentStatus.flowOrder.toString());
            }
          } else {
            console.log(`?? Pago ya exist?a: ${paymentStatus.flowOrder}`);
          }
        } else {
          console.error('No se pudo extraer loanId del optional del webhook:', optional);
        }
      } else {
        console.log(`ℹ️ Pago Flow con estado ${paymentStatus.status}: ${getFlowStatusText(paymentStatus.status)}`);
      }

      // Flow espera una respuesta exitosa
      res.status(200).send('OK');
    } catch (error) {
      console.error('❌ Error en webhook de Flow:', error);
      // Aún así responder OK para que Flow no reintente
      res.status(200).send('OK');
    }
  }
);

/**
 * POST /flow/confirm-payment
 * Confirma manualmente un pago de Flow
 * (En caso de que el webhook falle)
 */
router.post(
  '/confirm-payment',
  requireAuth,
  body('token').isString(),
  handleValidation,
  async (req, res, next) => {
    try {
      const { token } = req.body;
      const userId = req.user.id;

      // Obtener estado del pago
      const paymentStatus = await getFlowPaymentStatus(token);

      if (paymentStatus.status !== 2) {
        return res.status(400).json({
          error: 'El pago no está en estado pagado',
          status: getFlowStatusText(paymentStatus.status),
        });
      }

      // Extraer datos opcionales
      const optional = paymentStatus.paymentData?.optional
        ? JSON.parse(paymentStatus.paymentData.optional)
        : null;

      if (!optional || !optional.loanId) {
        return res.status(400).json({
          error: 'No se pudo identificar el préstamo asociado',
        });
      }

      const loanId = Number(optional.loanId);
      const registeredByUserId = optional.userId ? Number(optional.userId) : userId;

      let cashSessionId = optional.cashSessionId ? Number(optional.cashSessionId) : null;
      if (!cashSessionId) {
        const session = await prisma.cashSession.findFirst({
          where: { userId: registeredByUserId, isClosed: false },
        });
        if (session) {
          cashSessionId = session.id;
        }
      }

      if (!cashSessionId) {
        return res.status(400).json({
          error: 'Debe abrir una sesión de caja antes de registrar pagos de Flow',
        });
      }

      // Verificar si ya existe un pago con esta referencia
      const existingPayment = await prisma.payment.findFirst({
        where: {
          externalReference: paymentStatus.flowOrder.toString(),
        },
      });

      if (existingPayment) {
        return res.status(400).json({
          error: 'Este pago ya fue registrado',
          paymentId: existingPayment.id,
        });
      }

      // Obtener el método de pago real desde Flow
      const realPaymentMethod = mapFlowPaymentMethod(paymentStatus.paymentMethod);
      console.log('💳 Método de pago mapeado (confirm): Flow:', paymentStatus.paymentMethod, '-> BD:', realPaymentMethod);

      // Extraer installmentId e installmentIds
      const installmentId = optional?.installmentId || null;
      const installmentIds = Array.isArray(optional?.installmentIds)
        ? optional.installmentIds.map((id) => Number(id))
        : [];
      const isAdvance = optional?.isAdvance === true || optional?.isAdvance === 'true';

      // Registrar el pago
      let payment;
      if (isAdvance && installmentIds && installmentIds.length > 0) {
        // Pago adelantado a múltiples cuotas
        payment = await registerAdvancePayment({
          loanId,
          amount: paymentStatus.amount,
          paymentMethod: realPaymentMethod,
          registeredByUserId,
          cashSessionId,
          installmentIds,
          externalReference: paymentStatus.flowOrder.toString(),
        });
      } else {
        // Pago normal a una sola cuota
        payment = await registerPayment({
          loanId,
          amount: paymentStatus.amount,
          paymentMethod: realPaymentMethod,
          registeredByUserId,
          cashSessionId,
          installmentId,
          externalReference: paymentStatus.flowOrder.toString(),
        });
      }
      await finalizeReceiptForFlowPayment(paymentStatus.flowOrder.toString());

      res.json({
        success: true,
        message: 'Pago confirmado y registrado',
        payment: {
          id: payment.id,
          receiptNumber: payment.receiptNumber,
          amount: Number(payment.amount),
        },
      });
    } catch (error) {
      console.error('Error confirmando pago de Flow:', error);
      next(error);
    }
  }
);

/**
 * GET /flow/pending-payments/:loanId
 * Obtiene los pagos de Flow pendientes de registrar para un préstamo
 * Útil para el fallback cuando Flow redirige sin parámetros
 */
router.get(
  '/pending-payments/:loanId',
  requireAuth,
  async (req, res, next) => {
    try {
      const { loanId } = req.params;
      
      // Buscar pagos FLOW sin externalReference que sean recientes
      const pendingFlowPayments = await prisma.payment.findMany({
        where: {
          loanId: Number(loanId),
          paymentMethod: 'FLOW',
          externalReference: null,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: 10,
      });

      // También buscar en cache global
      const cachedFlowOrders = global.flowPaymentCache 
        ? Object.values(global.flowPaymentCache).filter(p => p.loanId === Number(loanId))
        : [];

      console.log('📋 Pagos Flow pendientes:', { 
        inDatabase: pendingFlowPayments.length,
        inCache: cachedFlowOrders.length
      });

      res.json({
        pendingInDatabase: pendingFlowPayments,
        pendingInCache: cachedFlowOrders,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
