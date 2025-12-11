import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Lima';
const OUTSTANDING_TOLERANCE = 0.05;

const prisma = new PrismaClient();

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Aplica Redondeo Bancario (Banker's Rounding) a múltiplos de S/ 0.10
 * 
 * Reglas:
 * 1. Si el dígito es < 5 o > 5: redondea estándar (hacia abajo si < 5, hacia arriba si > 5)
 * 2. Si el dígito es exactamente 5 (con precisión flotante):
 *    - Mira el dígito a la izquierda del 5
 *    - Si es PAR: redondea hacia abajo
 *    - Si es IMPAR: redondea hacia arriba
 * 
 * Ejemplos:
 * - 16.23 → 16.20 (3 < 5, redondea abajo)
 * - 16.27 → 16.30 (7 > 5, redondea arriba)
 * - 16.25 → 16.20 (5 exacto, dígito izquierdo es 2=PAR, redondea abajo)
 * - 10.15 → 10.20 (5 exacto, dígito izquierdo es 1=IMPAR, redondea arriba)
 * - 10.25 → 10.20 (5 exacto, dígito izquierdo es 2=PAR, redondea abajo)
 * - 10.35 → 10.40 (5 exacto, dígito izquierdo es 3=IMPAR, redondea arriba)
 * - 10.45 → 10.40 (5 exacto, dígito izquierdo es 4=PAR, redondea abajo)
 */
export function applyRounding(amount) {
  const num = Number(amount);
  const multiplied = num * 10;
  const integer = Math.floor(multiplied);
  const decimal = Math.round((multiplied - integer) * 10) / 10; // Para manejar precisión flotante
  
  // Si el decimal es aproximadamente 0.5 (5 exacto)
  if (Math.abs(decimal - 0.5) < 0.001) {
    // Es exactamente 5: aplicar regla del par/impar
    const leftDigit = integer % 10; // Dígito a la izquierda del 5
    if (leftDigit % 2 === 0) {
      // Es PAR: redondea hacia abajo
      return integer / 10;
    } else {
      // Es IMPAR: redondea hacia arriba
      return (integer + 1) / 10;
    }
  } else if (decimal < 0.5) {
    // Menos de 0.5: redondea hacia abajo
    return integer / 10;
  } else {
    // Más de 0.5: redondea hacia arriba
    return (integer + 1) / 10;
  }
}

/**
 * Calcula la mora para una cuota específica.
 * Mora = 1% de la cuota, fija, se aplica UNA SOLA VEZ cuando vence
 * - No aumenta aunque pasen más meses sin pagar
 * - Si se hace CUALQUIER pago después del vencimiento, la mora se cancela/reinicia a 0
 * - El saldo pendiente después de un pago parcial es solo lo que falta de la cuota (sin mora)
 */
export function calculateInstallmentLateFee(schedule, payments) {
  const today = dayjs.tz(new Date(), TZ);
  const dueDate = dayjs.tz(schedule.dueDate, TZ);
  const installmentAmount = Number(schedule.installmentAmount);
  const paymentsForInstallment = (payments || []).filter(p => p.installmentId === schedule.id);

  const totalPrincipalPaid = paymentsForInstallment.reduce(
    (sum, p) => sum + Number(p.principalPaid || 0),
    0
  );
  const totalInterestPaid = paymentsForInstallment.reduce(
    (sum, p) => sum + Number(p.interestPaid || 0),
    0
  );
  const totalLateFeePaid = paymentsForInstallment.reduce(
    (sum, p) => sum + Number(p.lateFeePaid || 0),
    0
  );

  const remainingInstallment = Math.max(0, round2(installmentAmount - (totalPrincipalPaid + totalInterestPaid)));

  // Si aun no vence, no se aplica mora
  if (today.isBefore(dueDate) || today.isSame(dueDate, 'day')) {
    return { hasLateFee: false, lateFeeAmount: 0, remainingInstallment, pendingTotal: remainingInstallment };
  }

  // ESTÁ VENCIDA - Calcular mora
  // Mora compuesta: se acumula cada mes (o cada 30 días)
  
  const paymentsAfterDue = paymentsForInstallment
    .filter(p => dayjs.tz(p.paymentDate, TZ).isAfter(dueDate))
    .sort((a, b) => dayjs.tz(a.paymentDate, TZ).valueOf() - dayjs.tz(b.paymentDate, TZ).valueOf());

  const paidOnOrBeforeDue = paymentsForInstallment
    .filter(p => !dayjs.tz(p.paymentDate, TZ).isAfter(dueDate))
    .reduce(
      (sum, p) =>
        sum +
        Number(p.principalPaid || 0) +
        Number(p.interestPaid || 0) +
        Number(p.lateFeePaid || 0),
      0
    );

  let outstanding = Math.max(0, round2(installmentAmount - paidOnOrBeforeDue));
  let accruedLateFee = 0;
  
  const applyPayment = (payment) => {
    const paidTotal =
      Number(payment.principalPaid || 0) +
      Number(payment.interestPaid || 0) +
      Number(payment.lateFeePaid || 0);
    outstanding = Math.max(0, round2(outstanding - paidTotal));
  };

  // Mora acumulativa compuesta: se aplica inmediatamente al pasar la fecha de vencimiento,
  // luego cada 30 días se aplica 1% adicional sobre el total acumulado
  let cursor = dueDate.clone();
  let idx = 0;
  
  // PRIMERA MORA: Se aplica inmediatamente al pasar la fecha de vencimiento
  if (outstanding > OUTSTANDING_TOLERANCE) {
    // Primera aplicación de mora (día 1 de atraso)
    const currentTotal = round2(outstanding + accruedLateFee);
    const lateFeeDay1 = round2(currentTotal * 0.01);
    accruedLateFee = round2(accruedLateFee + lateFeeDay1);
  }
  
  // MORA ADICIONAL: Cada 30 días posteriores se aplica 1% más
  while (true) {
    const nextBoundary = cursor.clone().add(30, 'days');
    
    // Si el siguiente período está en el futuro, terminar
    if (nextBoundary.isAfter(today)) {
      break;
    }
    
    // Aplicar pagos hasta este punto
    while (idx < paymentsAfterDue.length) {
      const paymentDate = dayjs.tz(paymentsAfterDue[idx].paymentDate, TZ);
      if (paymentDate.isAfter(nextBoundary)) break;
      applyPayment(paymentsAfterDue[idx]);
      idx += 1;
    }

    // Si hay saldo pendiente, aplicar 1% de mora sobre el total acumulado
    if (outstanding > OUTSTANDING_TOLERANCE) {
      const currentTotal = round2(outstanding + accruedLateFee);
      const lateFeeThisMonth = round2(currentTotal * 0.01);
      accruedLateFee = round2(accruedLateFee + lateFeeThisMonth);
    }

    cursor = nextBoundary;
  }

  // Aplicar pagos finales después del último período
  while (idx < paymentsAfterDue.length) {
    applyPayment(paymentsAfterDue[idx]);
    idx += 1;
  }

  const lateFeeOutstanding = Math.max(0, round2(accruedLateFee - totalLateFeePaid));
  const pendingTotal = round2(remainingInstallment + lateFeeOutstanding);

  return {
    hasLateFee: lateFeeOutstanding > OUTSTANDING_TOLERANCE,
    lateFeeAmount: lateFeeOutstanding,
    remainingInstallment,
    pendingTotal,
  };
}

/**
 * Calcula la mora para un préstamo completo con mora acumulativa mensual
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

  const installmentLateFees = loan.schedules.map(schedule =>
    calculateInstallmentLateFee(schedule, loan.payments)
  );

  const totalLateFee = round2(
    installmentLateFees.reduce((sum, info) => sum + Number(info.lateFeeAmount || 0), 0)
  );

  // Se retorna vacío para evitar crear registros de mora persistentes; se calcula en línea
  return {
    lateFees: [],
    totalLateFee,
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
 * Valida la selecciГіn de cuotas para un pago adelantado y calcula el total adeudado.
 * Retorna el prГ©stamo, cuotas seleccionadas y el total exacto a pagar.
 */
async function buildAdvancePaymentContext({
  loanId,
  installmentIds,
  registeredByUserId,
  cashSessionId,
}) {
  if (!cashSessionId) {
    throw new Error('Debe abrir una sesiГіn de caja antes de registrar pagos');
  }

  const normalizedInstallmentIds = (installmentIds || []).map(id => Number(id));

  const cashSession = await prisma.cashSession.findUnique({
    where: { id: Number(cashSessionId) },
    select: { id: true, isClosed: true, userId: true },
  });

  if (!cashSession) {
    throw new Error('SesiГіn de caja no encontrada');
  }

  if (cashSession.isClosed) {
    throw new Error('La sesiГіn de caja estГЎ cerrada. Abra una nueva antes de registrar pagos');
  }

  if (cashSession.userId !== registeredByUserId) {
    throw new Error('La sesiГіn de caja abierta pertenece a otro usuario');
  }

  if (!normalizedInstallmentIds || normalizedInstallmentIds.length === 0) {
    throw new Error('Debe seleccionar al menos una cuota');
  }

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: {
      schedules: { orderBy: { installmentNumber: 'asc' } },
      payments: true,
      lateFees: { where: { isPaid: false }, orderBy: { createdAt: 'asc' } },
      client: true,
    },
  });

  if (!loan) throw new Error('PrГ©stamo no encontrado');

  const selectedInstallments = loan.schedules.filter(s => normalizedInstallmentIds.includes(s.id));
  if (selectedInstallments.length !== normalizedInstallmentIds.length) {
    throw new Error('Una o mГЎs cuotas seleccionadas no existen o no pertenecen a este prГ©stamo');
  }

  const alreadyPaid = selectedInstallments.filter(s => s.isPaid === true);
  if (alreadyPaid.length > 0) {
    throw new Error(`Las cuotas ${alreadyPaid.map(s => `#${s.installmentNumber}`).join(', ')} ya están pagadas`);
  }

  for (const selectedInstallment of selectedInstallments) {
    const previousInstallments = loan.schedules.filter(s => s.installmentNumber < selectedInstallment.installmentNumber);
    for (const prevInstallment of previousInstallments) {
      // Si la cuota anterior también está incluida en la selección actual, se pagará en la misma operación
      if (normalizedInstallmentIds.includes(prevInstallment.id)) {
        continue;
      }

      if (prevInstallment.isPaid === false) {
        const paymentsForPrevious = loan.payments.filter(p => p.installmentId === prevInstallment.id);
        const lateFeeInfo = calculateInstallmentLateFee(prevInstallment, paymentsForPrevious);
        const previousOutstanding = Number(lateFeeInfo.pendingTotal || 0);

        if (previousOutstanding > OUTSTANDING_TOLERANCE) {
          throw new Error(
            `No puedes pagar la cuota #${selectedInstallment.installmentNumber} hasta que hayas pagado la cuota #${prevInstallment.installmentNumber} completamente. Pendiente: S/ ${previousOutstanding.toFixed(2)}`
          );
        }
      }
    }
  }

  let totalOwed = 0;
  for (const installment of selectedInstallments) {
    const paymentsForInstallment = loan.payments.filter(p => p.installmentId === installment.id);
    const lateFeeInfo = calculateInstallmentLateFee(installment, paymentsForInstallment);
    const pendingTotal = Number(lateFeeInfo.pendingTotal || 0);
    totalOwed += pendingTotal;
  }

  return {
    loan,
    selectedInstallments,
    installmentIds: normalizedInstallmentIds,
    totalOwed: round2(totalOwed),
  };
}

export async function calculateAdvancePaymentAmount({
  loanId,
  installmentIds,
  registeredByUserId,
  cashSessionId,
}) {
  return buildAdvancePaymentContext({
    loanId,
    installmentIds,
    registeredByUserId,
    cashSessionId,
  });
}

/**
 * Registra un pago adelantado para múltiples cuotas
 * Este pago NO afecta la estructura de datos existente, solo agrega un nuevo registro
 */
export async function registerAdvancePayment({
  loanId,
  amount,
  paymentMethod,
  registeredByUserId,
  cashSessionId,
  installmentIds, // Array de IDs de cuotas seleccionadas
  externalReference,
}) {
  console.log('📝 registerAdvancePayment llamado con:', {
    loanId,
    amount,
    paymentMethod,
    registeredByUserId,
    cashSessionId,
    installmentIds,
    externalReference
  });

  const {
    loan,
    selectedInstallments,
    installmentIds: normalizedInstallmentIds,
    totalOwed,
  } = await buildAdvancePaymentContext({
    loanId,
    installmentIds,
    registeredByUserId,
    cashSessionId,
  });

  let paymentAmount = Number(amount);
  let roundingAdjustment = 0;

  if (paymentMethod === 'EFECTIVO') {
    const roundedAmount = applyRounding(paymentAmount);
    roundingAdjustment = round2(roundedAmount - paymentAmount);
    paymentAmount = roundedAmount;
  }

  if (paymentAmount <= 0) {
    throw new Error('El monto del pago debe ser mayor a cero');
  }

  if (Math.abs(paymentAmount - totalOwed) > OUTSTANDING_TOLERANCE) {
    throw new Error(`El monto debe ser exactamente S/ ${totalOwed.toFixed(2)}. Ingres? S/ ${paymentAmount.toFixed(2)}`);
  }

  if (paymentMethod === 'EFECTIVO') {
    const cents = Math.round(paymentAmount * 100);
    if (cents % 10 !== 0) {
      throw new Error('Para pagos en efectivo, solo se permiten montos en m?ltiplos de S/ 0.10');
    }
  }

  if (
    (paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') &&
    paymentAmount < 2
  ) {
    throw new Error('El monto m?nimo para billetera digital o tarjeta d?bito es S/ 2.00');
  }

  const orderedInstallments = [...selectedInstallments].sort(
    (a, b) => a.installmentNumber - b.installmentNumber
  );

  // Usar un numero base para este adelanto y garantizar unicidad por fila
  const receiptNumberBase = generateReceiptNumber();
  let remaining = paymentAmount;
  const paymentsCreated = [];

  const payment = await prisma.$transaction(async (tx) => {
    for (let i = 0; i < orderedInstallments.length; i += 1) {
      const installment = orderedInstallments[i];
      if (remaining <= OUTSTANDING_TOLERANCE) break; // Cambiar condición para evitar dejar decimales
      
      // Sufijar el numero de recibo cuando hay multiples filas para cumplir la
      // restriccion unica en BD y mantener la relacion con el mismo adelanto.
      const receiptNumber =
        orderedInstallments.length > 1
          ? `${receiptNumberBase}-${i + 1}`
          : receiptNumberBase;

      const paymentsForInstallment = await tx.payment.findMany({
        where: { installmentId: installment.id },
      });

      const lateFeeInfo = calculateInstallmentLateFee(installment, paymentsForInstallment);

      let installmentInterestRemaining =
        Number(installment.interestAmount) -
        paymentsForInstallment.reduce((sum, p) => sum + Number(p.interestPaid || 0), 0);
      installmentInterestRemaining = Math.max(0, round2(installmentInterestRemaining));

      let installmentPrincipalRemaining =
        Number(installment.principalAmount) -
        paymentsForInstallment.reduce((sum, p) => sum + Number(p.principalPaid || 0), 0);
      installmentPrincipalRemaining = Math.max(0, round2(installmentPrincipalRemaining));

      let installmentLateFeePending = Number(lateFeeInfo.lateFeeAmount || 0);

      let paymentForThisInstallment = 0;
      let installmentInterestPaid = 0;
      let installmentPrincipalPaid = 0;
      let installmentLateFeePaid = 0;

      if (installmentInterestRemaining > 0 && remaining > 0) {
        const toPay = Math.min(remaining, installmentInterestRemaining);
        installmentInterestPaid = round2(toPay);
        paymentForThisInstallment = round2(paymentForThisInstallment + toPay);
        remaining = round2(remaining - toPay);
        installmentInterestRemaining = round2(installmentInterestRemaining - toPay);
      }

      if (installmentPrincipalRemaining > 0 && remaining > 0) {
        const toPay = Math.min(remaining, installmentPrincipalRemaining);
        installmentPrincipalPaid = round2(toPay);
        paymentForThisInstallment = round2(paymentForThisInstallment + toPay);
        remaining = round2(remaining - toPay);
        installmentPrincipalRemaining = round2(installmentPrincipalRemaining - toPay);
      }

      if (
        installmentInterestRemaining <= OUTSTANDING_TOLERANCE &&
        installmentPrincipalRemaining <= OUTSTANDING_TOLERANCE &&
        installmentLateFeePending > 0 &&
        remaining > 0
      ) {
        const toPay = Math.min(remaining, installmentLateFeePending);
        installmentLateFeePaid = round2(toPay);
        paymentForThisInstallment = round2(paymentForThisInstallment + toPay);
        remaining = round2(remaining - toPay);
      }

      // Si es la última cuota y hay remaining pendiente, agregarlo a esta cuota
      // Se agrega al capital principal (lo más importante)
      const isLastInstallment = i === orderedInstallments.length - 1;
      if (isLastInstallment && remaining > OUTSTANDING_TOLERANCE) {
        // Agregar al principal restante primero
        if (installmentPrincipalRemaining > 0) {
          const additionalPrincipal = Math.min(remaining, installmentPrincipalRemaining);
          installmentPrincipalPaid = round2(installmentPrincipalPaid + additionalPrincipal);
          paymentForThisInstallment = round2(paymentForThisInstallment + additionalPrincipal);
          remaining = round2(remaining - additionalPrincipal);
          installmentPrincipalRemaining = round2(installmentPrincipalRemaining - additionalPrincipal);
        }
        // Si aún hay remaining, agregarlo al interés
        if (remaining > OUTSTANDING_TOLERANCE && installmentInterestRemaining > 0) {
          const additionalInterest = Math.min(remaining, installmentInterestRemaining);
          installmentInterestPaid = round2(installmentInterestPaid + additionalInterest);
          paymentForThisInstallment = round2(paymentForThisInstallment + additionalInterest);
          remaining = round2(remaining - additionalInterest);
          installmentInterestRemaining = round2(installmentInterestRemaining - additionalInterest);
        }
        // Si aún hay remaining (cosa rara), agregarlo a la mora
        if (remaining > OUTSTANDING_TOLERANCE && installmentLateFeePending > 0) {
          const additionalLateFee = Math.min(remaining, installmentLateFeePending);
          installmentLateFeePaid = round2(installmentLateFeePaid + additionalLateFee);
          paymentForThisInstallment = round2(paymentForThisInstallment + additionalLateFee);
          remaining = round2(remaining - additionalLateFee);
        }
      }

      if (paymentForThisInstallment > 0) {
        const newPayment = await tx.payment.create({
          data: {
            loanId,
            installmentId: installment.id,
            registeredByUserId,
            amount: paymentForThisInstallment,
            paymentMethod,
            principalPaid: installmentPrincipalPaid,
            interestPaid: installmentInterestPaid,
            lateFeePaid: installmentLateFeePaid,
            roundingAdjustment: 0,
            externalReference,
            receiptNumber,
            cashSessionId,
            paymentDate: new Date(),
          },
        });

        paymentsCreated.push(newPayment);

        if (installmentLateFeePaid > 0) {
          let remainingLateFee = installmentLateFeePaid;
          const lateFees = await tx.lateFee.findMany({
            where: { loanId, isPaid: false },
            orderBy: { createdAt: 'asc' },
          });

          for (const fee of lateFees) {
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
      }
    }

    // Después de registrar todos los pagos, marcar las cuotas como pagadas si corresponde
    for (const installment of orderedInstallments) {
      const paymentsForInstallment = await tx.payment.findMany({
        where: { installmentId: installment.id },
      });

      // Calcular el total pendiente de esta cuota
      const lateFeeInfo = calculateInstallmentLateFee(installment, paymentsForInstallment);
      
      // Si no hay nada pendiente, marcar como pagada
      if (lateFeeInfo.remainingInstallment <= OUTSTANDING_TOLERANCE && 
          lateFeeInfo.lateFeeAmount <= OUTSTANDING_TOLERANCE) {
        await tx.paymentSchedule.update({
          where: { id: installment.id },
          data: { isPaid: true, remainingBalance: 0 },
        });
      }
    }

    if (paymentsCreated.length > 0) {
      return await tx.payment.findUnique({
        where: { id: paymentsCreated[0].id },
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
    }

    throw new Error('No se pudieron crear los pagos');
  });

  payment.installmentsPaid = orderedInstallments.map((s) => ({
    id: s.id,
    installmentNumber: s.installmentNumber,
    dueDate: s.dueDate,
    installmentAmount: Number(s.installmentAmount),
  }));

  return payment;
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
  receiptType = null, // Tipo de comprobante (BOLETA o FACTURA)
}) {
  console.log('📝 registerPayment llamado con:', {
    loanId,
    amount,
    paymentMethod,
    registeredByUserId,
    cashSessionId,
    installmentId,
    externalReference,
    receiptType
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

  // Calcular totales (mora acumulativa 1% mensual sobre saldo vencido)
  const totalDebt = loan.schedules.reduce((sum, s) => sum + Number(s.installmentAmount), 0);
  const totalInterest = loan.schedules.reduce((sum, s) => sum + Number(s.interestAmount), 0);
  const totalPrincipal = Number(loan.principal);
  const totalPaidInterest = loan.payments.reduce((sum, p) => sum + Number(p.interestPaid || 0), 0);
  const totalPaidPrincipal = loan.payments.reduce((sum, p) => sum + Number(p.principalPaid || 0), 0);

  const pendingInterest = round2(totalInterest - totalPaidInterest);
  const pendingPrincipal = round2(totalPrincipal - totalPaidPrincipal);
  const pendingDebt = round2(totalDebt - (totalPaidInterest + totalPaidPrincipal));

  const installmentLateFees = loan.schedules.map(s => calculateInstallmentLateFee(s, loan.payments));
  const pendingLateFee = round2(
    installmentLateFees.reduce((sum, info) => sum + Number(info.lateFeeAmount || 0), 0)
  );
  const pendingTotal = round2(pendingDebt + pendingLateFee);

  if (pendingDebt <= OUTSTANDING_TOLERANCE && pendingLateFee <= OUTSTANDING_TOLERANCE) {
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
  let selectedInstallment = null;
  if (installmentId) {
    selectedInstallment = loan.schedules.find(s => s.id === installmentId) || null;
    if (!selectedInstallment) {
      throw new Error('No se encontró la cuota seleccionada');
    }

    // Validar que todas las cuotas anteriores estén completamente pagadas (con tolerancia mínima)
    const previousInstallments = loan.schedules.filter(s => s.installmentNumber < selectedInstallment.installmentNumber);
    for (const prevInstallment of previousInstallments) {
      const paymentsForPrevious = loan.payments.filter(p => p.installmentId === prevInstallment.id);
      
      // Calcular lo que realmente falta pagar (usando calculateInstallmentLateFee que es la función correcta)
      const lateFeeInfo = calculateInstallmentLateFee(prevInstallment, paymentsForPrevious);
      const previousOutstanding = Number(lateFeeInfo.pendingTotal || 0);

      if (previousOutstanding > OUTSTANDING_TOLERANCE) {
        throw new Error(
          `No puedes pagar la cuota #${selectedInstallment.installmentNumber} hasta que hayas pagado la cuota #${prevInstallment.installmentNumber} completamente. Pendiente: S/ ${previousOutstanding.toFixed(2)}`
        );
      }
    }
  }

  // Saldos pendientes específicos de la cuota (interés, capital y mora)
  let installmentPendingPrincipal = 0;
  let installmentPendingInterest = 0;
  let installmentPendingLateFee = 0;

  if (selectedInstallment) {
    const paymentsForInstallment = loan.payments.filter(p => p.installmentId === installmentId);
    const principalPaidForInstallment = paymentsForInstallment.reduce(
      (sum, p) => sum + Number(p.principalPaid || 0),
      0
    );
    const interestPaidForInstallment = paymentsForInstallment.reduce(
      (sum, p) => sum + Number(p.interestPaid || 0),
      0
    );

    installmentPendingPrincipal = Math.max(
      0,
      round2(Number(selectedInstallment.principalAmount || 0) - principalPaidForInstallment)
    );
    installmentPendingInterest = Math.max(
      0,
      round2(Number(selectedInstallment.interestAmount || 0) - interestPaidForInstallment)
    );

    const installmentLateFeeInfo = calculateInstallmentLateFee(selectedInstallment, paymentsForInstallment);
    installmentPendingLateFee = Number(installmentLateFeeInfo.lateFeeAmount || 0);
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
  let pendingLoanLateFee = pendingLateFee;
  let pendingLoanInterest = pendingInterest;
  let pendingLoanPrincipal = pendingPrincipal;

  if (selectedInstallment) {
    if (installmentPendingInterest > 0 && remaining > 0) {
      const installmentInterestCovered = Math.min(remaining, installmentPendingInterest);
      interestPaid = round2(interestPaid + installmentInterestCovered);
      remaining = round2(remaining - installmentInterestCovered);
      installmentPendingInterest = Math.max(
        0,
        round2(installmentPendingInterest - installmentInterestCovered)
      );
      pendingLoanInterest = Math.max(0, round2(pendingLoanInterest - installmentInterestCovered));
    }

    if (installmentPendingPrincipal > 0 && remaining > 0) {
      const installmentPrincipalCovered = Math.min(remaining, installmentPendingPrincipal);
      principalPaid = round2(principalPaid + installmentPrincipalCovered);
      remaining = round2(remaining - installmentPrincipalCovered);
      installmentPendingPrincipal = Math.max(
        0,
        round2(installmentPendingPrincipal - installmentPrincipalCovered)
      );
      pendingLoanPrincipal = Math.max(0, round2(pendingLoanPrincipal - installmentPrincipalCovered));
    }

    const basePendingCleared =
      installmentPendingInterest <= OUTSTANDING_TOLERANCE &&
      installmentPendingPrincipal <= OUTSTANDING_TOLERANCE;

    if (basePendingCleared && installmentPendingLateFee > 0 && remaining > 0) {
      const installmentLateFeeCovered = Math.min(remaining, installmentPendingLateFee);
      lateFeePaid = round2(lateFeePaid + installmentLateFeeCovered);
      remaining = round2(remaining - installmentLateFeeCovered);
      installmentPendingLateFee = Math.max(
        0,
        round2(installmentPendingLateFee - installmentLateFeeCovered)
      );
      pendingLoanLateFee = Math.max(0, round2(pendingLoanLateFee - installmentLateFeeCovered));
    }
  }

  // 1. Pagar mora pendiente
  if (pendingLoanLateFee > 0 && remaining > 0) {
    const loanLateFeeCovered = Math.min(remaining, pendingLoanLateFee);
    lateFeePaid = round2(lateFeePaid + loanLateFeeCovered);
    remaining = round2(remaining - loanLateFeeCovered);
    pendingLoanLateFee = round2(pendingLoanLateFee - loanLateFeeCovered);
  }

  // 2. Pagar interés pendiente
  if (pendingLoanInterest > 0 && remaining > 0) {
    const loanInterestCovered = Math.min(remaining, pendingLoanInterest);
    interestPaid = round2(interestPaid + loanInterestCovered);
    remaining = round2(remaining - loanInterestCovered);
    pendingLoanInterest = round2(pendingLoanInterest - loanInterestCovered);
  }

  // 3. Pagar capital pendiente
  if (pendingLoanPrincipal > 0 && remaining > 0) {
    const loanPrincipalCovered = Math.min(remaining, pendingLoanPrincipal);
    principalPaid = round2(principalPaid + loanPrincipalCovered);
    remaining = round2(remaining - loanPrincipalCovered);
    pendingLoanPrincipal = round2(pendingLoanPrincipal - loanPrincipalCovered);
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
        receiptType, // Tipo de comprobante (BOLETA o FACTURA)
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

    // 3. Solo verificar estado de la cuota (se marca como pagada al guardar el comprobante)
    if (installmentId) {
      console.log('?? Verificando estado de cuota:', { installmentId });
      
      const installment = await tx.paymentSchedule.findUnique({
        where: { id: installmentId },
      });

      if (installment) {
        const installmentAmount = Number(installment.installmentAmount);
        const allPaymentsForInstallment = await tx.payment.findMany({
          where: { installmentId },
        });

        const totalPaid = allPaymentsForInstallment.reduce((sum, p) => sum + Number(p.amount), 0);
        const lateFeeDetails = calculateInstallmentLateFee(installment, allPaymentsForInstallment);
        const outstandingInstallment = Number(lateFeeDetails.remainingInstallment || 0);
        const outstandingLateFee = Number(lateFeeDetails.lateFeeAmount || 0);
        const outstandingAmount = Number(
          lateFeeDetails.pendingTotal ?? round2(outstandingInstallment + outstandingLateFee)
        );
        const shouldMarkAsPaid = outstandingAmount <= OUTSTANDING_TOLERANCE;

        console.log('?? Pagos encontrados para cuota:', {
          installmentId,
          totalPaid,
          paymentCount: allPaymentsForInstallment.length
        });

        console.log('?? Comparaci?n de montos:', {
          installmentId,
          installmentAmount,
          outstandingInstallment,
          outstandingLateFee,
          totalPaid,
          outstandingAmount,
          outstandingTolerance: OUTSTANDING_TOLERANCE,
          shouldMarkAsPaid,
        });
      } else {
        console.log('?? No se encontr? la cuota con id:', installmentId);
      }
    } else {
      console.log('?? No se proporcion? installmentId');
    }

    return newPayment;
  });

  // Incluir información de cuota pagada en la respuesta
  if (installmentId) {
    const installment = loan.schedules.find(s => s.id === installmentId);
    if (installment) {
      payment.installmentsPaid = [{
        id: installment.id,
        installmentNumber: installment.installmentNumber,
        dueDate: installment.dueDate,
        installmentAmount: Number(installment.installmentAmount),
      }];
    }
  }

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

  // Calcular totales con mora acumulativa
  const totalDebt = loan.schedules.reduce((sum, s) => sum + Number(s.installmentAmount), 0);
  const totalPrincipal = Number(loan.principal);
  const totalInterest = loan.schedules.reduce((sum, s) => sum + Number(s.interestAmount), 0);

  // Calcular pagado
  const totalPaid = loan.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const principalPaid = loan.payments.reduce((sum, p) => sum + Number(p.principalPaid || 0), 0);
  const interestPaid = loan.payments.reduce((sum, p) => sum + Number(p.interestPaid || 0), 0);
  const lateFeePaid = loan.payments.reduce((sum, p) => sum + Number(p.lateFeePaid || 0), 0);

  const installmentLateFees = loan.schedules.map(schedule => {
    const paymentsForSchedule = loan.payments.filter(p => p.installmentId === schedule.id);
    return calculateInstallmentLateFee(schedule, paymentsForSchedule);
  });

  const outstandingLateFee = round2(
    installmentLateFees.reduce((sum, info) => sum + Number(info.lateFeeAmount || 0), 0)
  );

  // Calcular pendiente
  const pendingPrincipal = round2(totalPrincipal - principalPaid);
  const pendingInterest = round2(totalInterest - interestPaid);
  const pendingBaseDebt = round2(totalDebt - (principalPaid + interestPaid));
  const pendingLateFee = outstandingLateFee;
  const pendingTotal = round2(pendingBaseDebt + pendingLateFee);
  const totalLateFee = round2(outstandingLateFee + lateFeePaid);

  // Recalcular remainingBalance para cada cuota dinámicamente basado en pagos reales
  const scheduleWithCalculatedBalance = loan.schedules.map((schedule, idx) => {
    const lateFeeInfo = installmentLateFees[idx];
    return {
      ...schedule,
      remainingBalance: lateFeeInfo.pendingTotal, // Usar el cálculo dinámico, no el valor guardado
    };
  });

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
    schedule: scheduleWithCalculatedBalance,
    payments: loan.payments,
    lateFees: loan.lateFees,
  };
}
