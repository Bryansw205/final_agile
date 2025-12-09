import { Router } from 'express';
import { body, query } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createFlowPayment,
  getFlowPaymentStatus,
  getFlowStatusText,
} from '../services/flowService.js';
import { registerPayment } from '../services/payment.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

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

      // Verificar que el préstamo existe
      const loan = await prisma.loan.findUnique({
        where: { id: Number(loanId) },
        include: { client: true },
      });

      if (!loan) {
        return res.status(404).json({ error: 'Préstamo no encontrado' });
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
        urlReturn: `${frontendUrl}/loans/${loanId}`,
        paymentMethod: 9, // 9 = Todos los medios de pago
        optional: { loanId, userId, installmentId: installmentId || null, commerceOrder },
      });

      console.log('✅ Orden Flow creada:', { flowOrder: flowPayment.flowOrder, commerceOrder });

      // Guardar en caché en memoria: comerceOrder -> installmentId
      if (!global.flowPaymentCache) global.flowPaymentCache = {};
      global.flowPaymentCache[flowPayment.flowOrder] = {
        loanId,
        userId,
        installmentId: installmentId || null,
        amount: Number(amount),
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

        // Si no hay installmentId en optional, intentar desde cache
        if (!installmentId && status.flowOrder && global.flowPaymentCache) {
          const cached = global.flowPaymentCache[status.flowOrder];
          if (cached) {
            console.log('🔍 Encontrado en cache:', cached);
            installmentId = cached.installmentId;
            optional = optional || cached;
          } else {
            console.log('❌ No encontrado en cache para flowOrder:', status.flowOrder);
            console.log('📦 Cache disponible:', Object.keys(global.flowPaymentCache || {}));
          }
        }

        console.log('📋 installmentId final:', installmentId);

        if (optional && optional.loanId) {
          const loanId = Number(optional.loanId);

          console.log('🎯 Registrando pago:', { loanId, userId, installmentId, flowOrder: status.flowOrder });

          // Verificar si ya existe un pago con esta referencia
          const existingPayment = await prisma.payment.findFirst({
            where: {
              externalReference: status.flowOrder.toString(),
            },
          });

          if (!existingPayment) {
            console.log('📦 Registrando pago nuevo...');
            
            // Registrar el pago en el sistema
            const payment = await registerPayment({
              loanId,
              amount: status.amount,
              paymentMethod: 'FLOW',
              registeredByUserId: userId,
              cashSessionId: null,
              installmentId,
              externalReference: status.flowOrder.toString(),
            });

            console.log(`✅ Pago Flow registrado:`, {
              paymentId: payment.id,
              flowOrder: status.flowOrder,
              installmentId,
            });
          } else {
            console.log(`ℹ️ Pago ya existía: ${status.flowOrder}`);
          }
        } else {
          console.error('❌ No se pudo extraer loanId del optional:', optional);
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
      const { token } = req.body;

      if (!token) {
        console.error('❌ Webhook Flow: Token no recibido');
        return res.status(200).send('OK'); // Responder OK para que Flow no reintente
      }

      console.log('📨 Webhook Flow recibido:', { token });

      // Obtener estado del pago
      const paymentStatus = await getFlowPaymentStatus(token);
      console.log('📊 Estado completo del pago:', JSON.stringify(paymentStatus, null, 2));

      // Solo procesar si el pago fue exitoso (status = 2)
      if (paymentStatus.status === 2) {
        console.log('💳 Webhook: Pago exitoso detectado, flowOrder:', paymentStatus.flowOrder);
        
        // Primero intentar recuperar del optional
        let optional = paymentStatus.optional;
        let installmentId = optional?.installmentId || null;
        let userId = optional?.userId ? Number(optional.userId) : null;

        // Si no hay datos en optional, intentar desde cache
        if ((!optional || !optional.loanId) && paymentStatus.flowOrder && global.flowPaymentCache) {
          const cached = global.flowPaymentCache[paymentStatus.flowOrder];
          if (cached) {
            console.log('🔍 Encontrado en cache (webhook):', cached);
            installmentId = cached.installmentId;
            userId = cached.userId;
            optional = cached;
          } else {
            console.log('❌ No encontrado en cache para flowOrder:', paymentStatus.flowOrder);
            console.log('📦 Cache disponible:', Object.keys(global.flowPaymentCache || {}));
          }
        }

        console.log('📋 Datos del webhook:', { optional, installmentId, userId });

        if (optional && optional.loanId) {
          const loanId = Number(optional.loanId);

          console.log('🎯 Webhook registrando:', { loanId, userId, installmentId, flowOrder: paymentStatus.flowOrder });

          // Verificar si ya existe un pago con esta referencia
          const existingPayment = await prisma.payment.findFirst({
            where: {
              externalReference: paymentStatus.flowOrder.toString(),
            },
          });

          if (!existingPayment) {
            console.log('📦 Registrando pago desde webhook...');
            
            // Registrar el pago en el sistema
            const payment = await registerPayment({
              loanId,
              amount: paymentStatus.amount,
              paymentMethod: 'FLOW',
              registeredByUserId: userId,
              cashSessionId: null, // Flow no se asocia a sesión de caja
              installmentId,
              externalReference: paymentStatus.flowOrder.toString(),
            });

            console.log(`✅ Pago Flow registrado desde webhook:`, {
              paymentId: payment.id,
              flowOrder: paymentStatus.flowOrder,
              installmentId,
            });
          } else {
            console.log(`ℹ️ Pago ya existía: ${paymentStatus.flowOrder}`);
          }
        } else {
          console.error('❌ No se pudo extraer loanId del optional del webhook:', optional);
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

      // Registrar el pago
      const payment = await registerPayment({
        loanId,
        amount: paymentStatus.amount,
        paymentMethod: 'FLOW',
        registeredByUserId: userId,
        cashSessionId: null,
        externalReference: paymentStatus.flowOrder.toString(),
      });

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

export default router;
