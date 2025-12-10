import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Lima';

const prisma = new PrismaClient();

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Aplica Redondeo de Banquero (Redondeo al Par Más Cercano)
 * Reglas:
 * - Si saldo < 0.05: redondea a 0 (cuota considerada pagada)
 * - Si saldo >= 0.05: redondea a 0.10
 * - Si dígito anterior a 0.05 es par, redondea hacia abajo
 * - Si es impar, redondea hacia arriba para que resultado sea par
 */
export function applyRounding(amount) {
  const cents = Math.round((amount % 1) * 100);
  const integerPart = Math.floor(amount);
  
  // Si los centavos son menores a 5, redondea hacia abajo (condonar)
  if (cents < 5) {
    return integerPart; // Cuota considerada como pagada
  }
  
  // Si los centavos están entre 5-9, redondea hacia arriba a 0.10
  if (cents >= 5 && cents <= 9) {
    return integerPart + 0.10; // Redondea hacia arriba a .10
  }
  
  // Para centavos 10-99, aplicar redondeo de banquero
  const decimalPart = Math.floor(cents / 10) * 10;
  const remainder = cents % 10;
  
  if (remainder < 5) {
    // Redondea hacia abajo al múltiplo de 10 anterior (redondeo de banquero)
    return integerPart + (decimalPart / 100);
  } else if (remainder > 5) {
    // Redondea hacia arriba
    return integerPart + ((decimalPart + 10) / 100);
  } else {
    // remainder === 5: Redondeo de banquero (al par más cercano)
    const tenthDigit = Math.floor((decimalPart / 10) % 10);
    const isEven = tenthDigit % 2 === 0;
    return isEven 
      ? integerPart + (decimalPart / 100)  // Mantiene decimal par
      : integerPart + ((decimalPart + 10) / 100);  // Redondea hacia par
  }
}

/**
 * Calcula la mora para una cuota específica
 * Mora = 1% de la cuota, fija, se aplica UNA SOLA VEZ cuando vence
 * No aumenta aunque pasen más meses sin pagar
 */
export function calculateInstallmentLateFee(schedule, payments) {
  const today = dayjs.tz(new Date(), TZ);
  const dueDate = dayjs.tz(schedule.dueDate, TZ);

  // Si ya está pagada, no hay mora
  if (schedule.isPaid) {
    return { hasLateFee: false, lateFeeAmount: 0 };
  }

  // Si aún no está vencida, no hay mora
  if (today.isBefore(dueDate) || today.isSame(dueDate, 'day')) {
    return { hasLateFee: false, lateFeeAmount: 0 };
  }

  // Verificar si hay pagos para esta cuota después de la fecha de vencimiento
  const relevantPayments = payments.filter(p => 
    p.installmentId === schedule.id && dayjs.tz(p.paymentDate, TZ).isAfter(dueDate)
  );

  // Si hay pagos parciales después del vencimiento, se anula la mora
  if (relevantPayments.length > 0) {
    return { hasLateFee: false, lateFeeAmount: 0 };
  }

  // Mora FIJA = 1% de la cuota (no acumulativa, no aumenta con el tiempo)
  // Ejemplo: cuota S/94.56 → mora = 94.56 × 0.01 = S/0.95
  // Total a pagar = S/95.51 (sin importar cuántos meses pasen)
  const installmentAmount = Number(schedule.installmentAmount);
  const lateFeeAmount = round2(installmentAmount * 0.01);

  return { hasLateFee: true, lateFeeAmount };
}

/**
 * Calcula la mora para un préstamo completo
 * Mora = 1% mensual sobre la deuda pendiente, solo si no hubo pagos en ese período
 */
export async function calculateLateFees(loanId) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: {
      schedules: { orderBy: { installmentNumber: 'asc' } },
      payments: { orderBy: { paymentDate: 'asc' } },
      lateFees: true,
    },
  });

  if (!loan) throw new Error('Préstamo no encontrado');

  const startDate = dayjs.tz(loan.startDate, TZ);
  const today = dayjs.tz(new Date(), TZ);
  
  // Calcular pagos totales
  const totalPaid = loan.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  
  // Calcular deuda total esperada
  const totalDebt = loan.schedules.reduce((sum, s) => sum + Number(s.installmentAmount), 0);
  
  // Deuda pendiente
  const pendingDebt = round2(totalDebt - totalPaid);
  
  if (pendingDebt <= 0) return { lateFees: [], totalLateFee: 0 };

  const lateFees = [];
  let monthsElapsed = 0;
  let currentDate = startDate;

  // Iterar por cada mes desde el inicio del préstamo
  while (currentDate.isBefore(today)) {
    const monthStart = currentDate.startOf('month');
    const monthEnd = currentDate.endOf('month');
    const periodMonth = currentDate.month() + 1;
    const periodYear = currentDate.year();

    // Verificar si hubo algún pago en este período
    const paymentsInPeriod = loan.payments.filter(p => {
      const paymentDate = dayjs.tz(p.paymentDate, TZ);
      return paymentDate.isAfter(monthStart) && paymentDate.isBefore(monthEnd);
    });

    // Si no hubo pagos en el período, se genera mora
    if (paymentsInPeriod.length === 0 && currentDate.isBefore(today.startOf('month'))) {
      // Verificar si ya existe esta mora
      const existingFee = loan.lateFees.find(
        f => f.periodMonth === periodMonth && f.periodYear === periodYear
      );

      if (!existingFee) {
        const feeAmount = round2(pendingDebt * 0.01); // 1% de la deuda
        lateFees.push({
          loanId,
          periodMonth,
          periodYear,
          feeAmount,
          baseAmount: pendingDebt,
          isPaid: false,
        });
      }
    }

    currentDate = currentDate.add(1, 'month');
    monthsElapsed++;
  }

  return {
    lateFees,
    totalLateFee: round2(lateFees.reduce((sum, f) => sum + Number(f.feeAmount), 0)),
  };
}

/**
 * Genera un número de recibo único
 */
export function generateReceiptNumber() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `REC-${timestamp}-${random}`;
}

/**
 * Registra un pago
 */
export async function registerPayment({
  loanId,
  amount,
  paymentMethod,
  registeredByUserId,
  cashSessionId,
  externalReference,
  installmentId, // ID de la cuota específica a pagar
}) {
  console.log('📝 registerPayment llamado con:', {
    loanId,
    amount,
    paymentMethod,
    registeredByUserId,
    cashSessionId,
    installmentId,
    externalReference
  });

  // Validar que exista una sesión de caja abierta antes de cualquier pago
  if (!cashSessionId) {
    throw new Error('Debe abrir una sesión de caja antes de registrar pagos');
  }

  const cashSession = await prisma.cashSession.findUnique({
    where: { id: Number(cashSessionId) },
    select: { id: true, isClosed: true, userId: true },
  });

  if (!cashSession) {
    throw new Error('Sesión de caja no encontrada');
  }

  if (cashSession.isClosed) {
    throw new Error('La sesión de caja está cerrada. Abra una nueva antes de registrar pagos');
  }

  if (cashSession.userId !== registeredByUserId) {
    throw new Error('La sesión de caja abierta pertenece a otro usuario');
  }

  // VERIFICAR DUPLICADOS: Para pagos de EFECTIVO, verificar si ya existe un pago reciente con los mismos datos
  if (paymentMethod === 'EFECTIVO' && installmentId) {
    const recentPayment = await prisma.payment.findFirst({
      where: {
        loanId,
        installmentId,
        paymentMethod: 'EFECTIVO',
        amount: Number(amount),
        // Buscar pagos creados en los últimos 60 segundos
        createdAt: {
          gte: new Date(Date.now() - 60000),
        },
      },
    });

    if (recentPayment) {
      console.log('⚠️ Pago duplicado detectado, retornando el existente:', { paymentId: recentPayment.id });
      // Retornar el pago existente en lugar de crear uno nuevo
      const existingPayment = await prisma.payment.findUnique({
        where: { id: recentPayment.id },
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
      return existingPayment;
    }
  }

  // Validar préstamo
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: {
      schedules: { orderBy: { installmentNumber: 'asc' } },
      payments: true,
      lateFees: { where: { isPaid: false }, orderBy: { createdAt: 'asc' } },
      client: true,
    },
  });

  if (!loan) throw new Error('Préstamo no encontrado');

  // Calcular totales
  const totalDebt = loan.schedules.reduce((sum, s) => sum + Number(s.installmentAmount), 0);
  const totalPaid = loan.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const totalInterest = loan.schedules.reduce((sum, s) => sum + Number(s.interestAmount), 0);
  const totalLateFee = loan.lateFees.reduce((sum, f) => sum + Number(f.feeAmount), 0);
  
  const pendingDebt = round2(totalDebt - totalPaid);
  const pendingInterest = round2(totalInterest - loan.payments.reduce((sum, p) => sum + Number(p.interestPaid), 0));
  const pendingPrincipal = round2(Number(loan.principal) - loan.payments.reduce((sum, p) => sum + Number(p.principalPaid), 0));
  const pendingLateFee = round2(totalLateFee - loan.payments.reduce((sum, p) => sum + Number(p.lateFeePaid), 0));
  const pendingTotal = round2(pendingDebt + pendingLateFee);

  if (pendingDebt <= 0) {
    throw new Error('El préstamo ya está completamente pagado');
  }

  let paymentAmount = Number(amount);
  let roundingAdjustment = 0;

  // Calcular el máximo permitido según el método de pago
  // EFECTIVO: máximo redondeado | Otros métodos: máximo original (sin redondear)
  let maxAllowed = pendingTotal;
  if (paymentMethod === 'EFECTIVO') {
    maxAllowed = applyRounding(pendingTotal);
  }

  // Aplicar redondeo al monto del pago solo si es efectivo
  if (paymentMethod === 'EFECTIVO') {
    const roundedAmount = applyRounding(paymentAmount);
    roundingAdjustment = round2(roundedAmount - paymentAmount);
    paymentAmount = roundedAmount;
  }

  if (paymentAmount <= 0) {
    throw new Error('El monto del pago debe ser mayor a cero');
  }

  // Si se especifica una cuota, validar que las cuotas anteriores estén pagadas
  // pero permitir pagar hasta el límite de deuda total pendiente
  if (installmentId) {
    const installment = loan.schedules.find(s => s.id === installmentId);
    if (installment) {
      // Validar que todas las cuotas anteriores estén completamente pagadas
      const previousInstallments = loan.schedules.filter(s => s.installmentNumber < installment.installmentNumber);
      for (const prevInstallment of previousInstallments) {
        const paidForPrevious = loan.payments
          .filter(p => p.installmentId === prevInstallment.id)
          .reduce((sum, p) => sum + Number(p.principalPaid) + Number(p.interestPaid), 0);
        
        if (paidForPrevious < Number(prevInstallment.installmentAmount)) {
          throw new Error(`No puedes pagar la cuota #${installment.installmentNumber} hasta que hayas pagado la cuota #${prevInstallment.installmentNumber} completamente`);
        }
      }
    }
  }

  if (paymentAmount > maxAllowed) {
    throw new Error(`El monto del pago supera la deuda pendiente total (máximo S/ ${maxAllowed.toFixed(2)})`);
  }

  // Validar incrementos en efectivo: solo múltiplos de 0.10
  if (paymentMethod === 'EFECTIVO') {
    const cents = Math.round(paymentAmount * 100);
    if (cents % 10 !== 0) {
      throw new Error('Para pagos en efectivo, solo se permiten montos en múltiplos de S/ 0.10');
    }
  }

  if (
    (paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') &&
    paymentAmount < 2
  ) {
    throw new Error('El monto mínimo para billetera digital o tarjeta débito es S/ 2.00');
  }

  // Distribuir el pago: primero mora, luego interés, luego capital
  let remaining = paymentAmount;
  let lateFeePaid = 0;
  let interestPaid = 0;
  let principalPaid = 0;

  // 1. Pagar mora pendiente
  if (pendingLateFee > 0 && remaining > 0) {
    lateFeePaid = Math.min(remaining, pendingLateFee);
    remaining = round2(remaining - lateFeePaid);
  }

  // 2. Pagar interés pendiente
  if (pendingInterest > 0 && remaining > 0) {
    interestPaid = Math.min(remaining, pendingInterest);
    remaining = round2(remaining - interestPaid);
  }

  // 3. Pagar capital pendiente
  if (pendingPrincipal > 0 && remaining > 0) {
    principalPaid = Math.min(remaining, pendingPrincipal);
    remaining = round2(remaining - principalPaid);
  }

  // Generar número de recibo
  const receiptNumber = generateReceiptNumber();

  // TODO: Registrar el pago y marcar como pagada en una transacción
  const payment = await prisma.$transaction(async (tx) => {
    // 1. Crear el pago
    const newPayment = await tx.payment.create({
      data: {
        loanId,
        installmentId, // Asociar con la cuota específica
        registeredByUserId,
        amount: paymentAmount,
        paymentMethod,
        principalPaid,
        interestPaid,
        lateFeePaid,
        roundingAdjustment,
        externalReference,
        receiptNumber,
        cashSessionId,
        paymentDate: new Date(),
      },
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

    console.log('✅ Pago creado en BD:', { paymentId: newPayment.id, amount: paymentAmount });

    // 2. Marcar moras como pagadas si corresponde
    if (lateFeePaid > 0) {
      let remainingLateFee = lateFeePaid;
      for (const fee of loan.lateFees) {
        if (remainingLateFee <= 0) break;
        
        const feeAmount = Number(fee.feeAmount);
        if (remainingLateFee >= feeAmount) {
          await tx.lateFee.update({
            where: { id: fee.id },
            data: { isPaid: true },
          });
          remainingLateFee = round2(remainingLateFee - feeAmount);
        }
      }
    }

    // 3. Marcar la cuota como pagada si se pagó el monto completo
    if (installmentId) {
      console.log('🔍 Verificando si marcar cuota como pagada:', { installmentId });
      
      const installment = await tx.paymentSchedule.findUnique({
        where: { id: installmentId },
      });

      if (installment) {
        const installmentAmount = Number(installment.installmentAmount);
        
        // Obtener TODOS los pagos para esta cuota (INCLUYENDO el que acaba de crearse)
        const allPaymentsForInstallment = await tx.payment.findMany({
          where: { installmentId },
        });

        const totalPaid = allPaymentsForInstallment.reduce((sum, p) => sum + Number(p.amount), 0);
        
        console.log('📊 Pagos encontrados para cuota:', {
          installmentId,
          totalPaid,
          paymentCount: allPaymentsForInstallment.length
        });
        
        // Calcular mora solo si la cuota está vencida
        const today = dayjs.tz(new Date(), TZ);
        const dueDate = dayjs.tz(installment.dueDate, TZ);
        let lateFeeAmount = 0;

        // Si está vencida
        if (today.isAfter(dueDate)) {
          // Verificar si hay pagos DESPUÉS del vencimiento
          const paymentsAfterDue = allPaymentsForInstallment.filter(p => 
            dayjs.tz(p.paymentDate, TZ).isAfter(dueDate)
          );

          // Si hay pagos después del vencimiento, NO hay mora (pago parcial anula mora)
          if (paymentsAfterDue.length === 0) {
            // Si NO hay pagos después del vencimiento, calcular mora
            const daysLate = today.diff(dueDate, 'day');
            const periodsLate = Math.floor(daysLate / 30);
            if (periodsLate > 0) {
              lateFeeAmount = round2(installmentAmount * (0.01 * periodsLate));
            }
          }
        }

        const totalAmountDue = round2(installmentAmount + lateFeeAmount);
        
        console.log('💰 Comparación de montos:', {
          installmentId,
          installmentAmount,
          lateFeeAmount,
          totalAmountDue,
          totalPaid,
          shouldMarkAsPaid: totalPaid >= totalAmountDue
        });
        
        // Si se pagó el monto completo o más (incluyendo mora), marcar como pagada
        if (totalPaid >= totalAmountDue) {
          await tx.paymentSchedule.update({
            where: { id: installmentId },
            data: { isPaid: true },
          });
          console.log('✅ Cuota marcada como pagada:', installmentId);
        } else {
          console.log('⏳ Cuota aún no completamente pagada');
        }
      } else {
        console.log('❌ No se encontró la cuota con id:', installmentId);
      }
    } else {
      console.log('⚠️ No se proporcionó installmentId');
    }

    return newPayment;
  });

  return payment;
}

/**
 * Obtiene el estado de cuenta de un préstamo
 */
export async function getLoanStatement(loanId) {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: {
      client: true,
      schedules: { orderBy: { installmentNumber: 'asc' } },
      payments: { 
        orderBy: { paymentDate: 'desc' },
        include: {
          registeredBy: {
            select: {
              username: true,
            },
          },
        },
      },
      lateFees: { orderBy: { createdAt: 'asc' } },
    },
  });

  if (!loan) throw new Error('Préstamo no encontrado');

  // Calcular totales
  const totalDebt = loan.schedules.reduce((sum, s) => sum + Number(s.installmentAmount), 0);
  const totalPrincipal = Number(loan.principal);
  const totalInterest = loan.schedules.reduce((sum, s) => sum + Number(s.interestAmount), 0);
  const totalLateFee = loan.lateFees.reduce((sum, f) => sum + Number(f.feeAmount), 0);

  // Calcular pagado
  const totalPaid = loan.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const principalPaid = loan.payments.reduce((sum, p) => sum + Number(p.principalPaid), 0);
  const interestPaid = loan.payments.reduce((sum, p) => sum + Number(p.interestPaid), 0);
  const lateFeePaid = loan.payments.reduce((sum, p) => sum + Number(p.lateFeePaid), 0);

  // Calcular pendiente
  const pendingTotal = round2(totalDebt + totalLateFee - totalPaid);
  const pendingPrincipal = round2(totalPrincipal - principalPaid);
  const pendingInterest = round2(totalInterest - interestPaid);
  const pendingLateFee = round2(totalLateFee - lateFeePaid);

  return {
    loan: {
      id: loan.id,
      principal: Number(loan.principal),
      interestRate: Number(loan.interestRate),
      termCount: loan.termCount,
      startDate: loan.startDate,
      client: loan.client,
    },
    totals: {
      totalDebt: round2(totalDebt + totalLateFee),
      totalPrincipal,
      totalInterest,
      totalLateFee,
      totalPaid,
      principalPaid,
      interestPaid,
      lateFeePaid,
      pendingTotal,
      pendingPrincipal,
      pendingInterest,
      pendingLateFee,
    },
    schedule: loan.schedules,
    payments: loan.payments,
    lateFees: loan.lateFees,
  };
}
