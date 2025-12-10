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

  // Calcular lo pagado hacia la cuota (principal + interés)
  const paidTowardsInstallment = paymentsForInstallment.reduce(
    (sum, p) => sum + Number(p.principalPaid || 0) + Number(p.interestPaid || 0),
    0
  );
  const remainingInstallment = Math.max(0, round2(installmentAmount - paidTowardsInstallment));

  // Si aún no está vencida, no hay mora
  if (today.isBefore(dueDate) || today.isSame(dueDate, 'day')) {
    return { hasLateFee: false, lateFeeAmount: 0, remainingInstallment, pendingTotal: remainingInstallment };
  }

  // Verificar si hay CUALQUIER pago después del vencimiento
  const paymentsAfterDue = paymentsForInstallment.filter(p => 
    dayjs.tz(p.paymentDate, TZ).isAfter(dueDate)
  );

  // Si hay pagos después del vencimiento, la mora se cancela/reinicia a 0
  if (paymentsAfterDue.length > 0) {
    return { hasLateFee: false, lateFeeAmount: 0, remainingInstallment, pendingTotal: remainingInstallment };
  }

  // Si NO hay pagos después del vencimiento, calcular mora
  // Mora FIJA = 1% de la cuota (no acumulativa, no aumenta con el tiempo)
  const baseLateFee = round2(installmentAmount * 0.01);
  const pendingTotal = round2(remainingInstallment + baseLateFee);

  return { hasLateFee: true, lateFeeAmount: baseLateFee, remainingInstallment, pendingTotal };
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
    throw new Error(`Las cuotas ${alreadyPaid.map(s => `#${s.installmentNumber}`).join(', ')} ya estГЎn pagadas`);
  }

<<<<<<< HEAD
  if (enforcePreviousPaid) {
    for (const selectedInstallment of selectedInstallments) {
      const previousInstallments = loan.schedules.filter(
        (s) => s.installmentNumber < selectedInstallment.installmentNumber
      );
      for (const prevInstallment of previousInstallments) {
        // Si la cuota anterior también está incluida en la selección actual, se pagará en la misma operación
        if (normalizedInstallmentIds.includes(prevInstallment.id)) {
          console.log('[ADVANCE] Saltando validación de cuota previa porque está seleccionada en el mismo pago:', {
            selectedInstallment: selectedInstallment.installmentNumber,
            previousInstallment: prevInstallment.installmentNumber,
          });
          continue;
        }
=======
  for (const selectedInstallment of selectedInstallments) {
    const previousInstallments = loan.schedules.filter(s => s.installmentNumber < selectedInstallment.installmentNumber);
    for (const prevInstallment of previousInstallments) {
      // Si la cuota anterior tambiÇ¸n estÇ­ incluida en la selecciÇün actual, se pagarÇ­ en la misma operaciÇün
      if (normalizedInstallmentIds.includes(prevInstallment.id)) {
        continue;
      }
>>>>>>> parent of a8a6096 (chux)

      if (prevInstallment.isPaid === false) {
        const paymentsForPrevious = loan.payments.filter(p => p.installmentId === prevInstallment.id);
        const lateFeeInfo = calculateInstallmentLateFee(prevInstallment, paymentsForPrevious);
        const previousOutstanding = Number(lateFeeInfo.pendingTotal || 0);

<<<<<<< HEAD
          console.log('[ADVANCE] Validando cuota previa pendiente:', {
            targetInstallment: selectedInstallment.installmentNumber,
            previousInstallment: prevInstallment.installmentNumber,
            previousOutstanding: previousOutstanding.toFixed(2),
            tolerance: OUTSTANDING_TOLERANCE,
            enforcePreviousPaid,
          });

          if (previousOutstanding > OUTSTANDING_TOLERANCE) {
            throw new Error(
              `No puedes pagar la cuota #${selectedInstallment.installmentNumber} hasta que hayas pagado la cuota #${prevInstallment.installmentNumber} completamente. Pendiente: S/ ${previousOutstanding.toFixed(2)}`
            );
          }
=======
        if (previousOutstanding > OUTSTANDING_TOLERANCE) {
          throw new Error(
            `No puedes pagar la cuota #${selectedInstallment.installmentNumber} hasta que hayas pagado la cuota #${prevInstallment.installmentNumber} completamente. Pendiente: S/ ${previousOutstanding.toFixed(2)}`
          );
>>>>>>> parent of a8a6096 (chux)
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

  const receiptNumber = generateReceiptNumber();
  let remaining = paymentAmount;
  const paymentsCreated = [];

  const payment = await prisma.$transaction(async (tx) => {
    for (const installment of orderedInstallments) {
      if (remaining <= 0) break;

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

        const allPaymentsNow = await tx.payment.findMany({
          where: { installmentId: installment.id },
        });

        const lateFeeDetailsNow = calculateInstallmentLateFee(installment, allPaymentsNow);
        const outstandingAmount = Number(lateFeeDetailsNow.pendingTotal || 0);

        if (outstandingAmount <= OUTSTANDING_TOLERANCE) {
          await tx.paymentSchedule.update({
            where: { id: installment.id },
            data: {
              isPaid: true,
              remainingBalance: 0,
            },
          });
        }

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

  // Validar que exista una sesión de caja abierta
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

  // Validar que haya al menos una cuota seleccionada
  if (!installmentIds || installmentIds.length === 0) {
    throw new Error('Debe seleccionar al menos una cuota');
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

  // Validar que todas las cuotas seleccionadas existan y pertenezcan a este préstamo
  const selectedInstallments = loan.schedules.filter(s => installmentIds.includes(s.id));
  if (selectedInstallments.length !== installmentIds.length) {
    throw new Error('Una o más cuotas seleccionadas no existen o no pertenecen a este préstamo');
  }

  // Validar que ninguna cuota seleccionada esté ya pagada
  const alreadyPaid = selectedInstallments.filter(s => s.isPaid === true);
  if (alreadyPaid.length > 0) {
    throw new Error(`Las cuotas ${alreadyPaid.map(s => `#${s.installmentNumber}`).join(', ')} ya están pagadas`);
  }

  // Validar que todas las cuotas anteriores de cada cuota seleccionada estén pagadas
  for (const selectedInstallment of selectedInstallments) {
    const previousInstallments = loan.schedules.filter(s => s.installmentNumber < selectedInstallment.installmentNumber);
    for (const prevInstallment of previousInstallments) {
      if (prevInstallment.isPaid === false) {
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
  }

  // Calcular el total exacto adeudado para las cuotas seleccionadas
  let totalOwed = 0;
  for (const installment of selectedInstallments) {
    const paymentsForInstallment = loan.payments.filter(p => p.installmentId === installment.id);
    const lateFeeInfo = calculateInstallmentLateFee(installment, paymentsForInstallment);
    const pendingTotal = Number(lateFeeInfo.pendingTotal || 0);
    totalOwed += pendingTotal;
  }
  totalOwed = round2(totalOwed);

  let paymentAmount = Number(amount);
  let roundingAdjustment = 0;

  // Calcular el máximo permitido según el método de pago
  // EFECTIVO: máximo redondeado | Otros métodos: máximo original (sin redondear)
  let maxAllowed = totalOwed;
  if (paymentMethod === 'EFECTIVO') {
    maxAllowed = applyRounding(totalOwed);
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

  // Validar que el monto sea exacto para las cuotas seleccionadas
  if (Math.abs(paymentAmount - totalOwed) > OUTSTANDING_TOLERANCE) {
    throw new Error(`El monto debe ser exactamente S/ ${totalOwed.toFixed(2)}. Ingresó S/ ${paymentAmount.toFixed(2)}`);
  }

  // Validar que en EFECTIVO el monto sea múltiplo de S/ 0.10
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

  // Ordenar cuotas por número para distribuir en orden
  const orderedInstallments = [...selectedInstallments].sort((a, b) => a.installmentNumber - b.installmentNumber);

  const receiptNumber = generateReceiptNumber();
  let remaining = paymentAmount;
  const paymentsCreated = [];

  // Crear UN PAGO POR CADA CUOTA (igual que si las pagara una por una)
  const payment = await prisma.$transaction(async (tx) => {
    for (const installment of orderedInstallments) {
      if (remaining <= 0) break;

      // Obtener pagos anteriores para esta cuota (dentro de la transacción)
      const paymentsForInstallment = await tx.payment.findMany({
        where: { installmentId: installment.id },
      });

      // Calcular lo que falta pagar en esta cuota
      const lateFeeInfo = calculateInstallmentLateFee(installment, paymentsForInstallment);
      
      let installmentInterestRemaining = Number(installment.interestAmount) - 
        paymentsForInstallment.reduce((sum, p) => sum + Number(p.interestPaid || 0), 0);
      installmentInterestRemaining = Math.max(0, round2(installmentInterestRemaining));

      let installmentPrincipalRemaining = Number(installment.principalAmount) - 
        paymentsForInstallment.reduce((sum, p) => sum + Number(p.principalPaid || 0), 0);
      installmentPrincipalRemaining = Math.max(0, round2(installmentPrincipalRemaining));

      let installmentLateFeePending = Number(lateFeeInfo.lateFeeAmount || 0);

      // Calcular cuánto pagar en esta cuota con el remaining disponible
      let paymentForThisInstallment = 0;
      let installmentInterestPaid = 0;
      let installmentPrincipalPaid = 0;
      let installmentLateFeePaid = 0;

      // Pagar interés de esta cuota
      if (installmentInterestRemaining > 0 && remaining > 0) {
        const toPay = Math.min(remaining, installmentInterestRemaining);
        installmentInterestPaid = round2(toPay);
        paymentForThisInstallment = round2(paymentForThisInstallment + toPay);
        remaining = round2(remaining - toPay);
        installmentInterestRemaining = round2(installmentInterestRemaining - toPay);
      }

      // Pagar principal de esta cuota
      if (installmentPrincipalRemaining > 0 && remaining > 0) {
        const toPay = Math.min(remaining, installmentPrincipalRemaining);
        installmentPrincipalPaid = round2(toPay);
        paymentForThisInstallment = round2(paymentForThisInstallment + toPay);
        remaining = round2(remaining - toPay);
        installmentPrincipalRemaining = round2(installmentPrincipalRemaining - toPay);
      }

      // Pagar mora si el principal e interés están cubiertos
      if (installmentInterestRemaining <= OUTSTANDING_TOLERANCE && 
          installmentPrincipalRemaining <= OUTSTANDING_TOLERANCE && 
          installmentLateFeePending > 0 && remaining > 0) {
        const toPay = Math.min(remaining, installmentLateFeePending);
        installmentLateFeePaid = round2(toPay);
        paymentForThisInstallment = round2(paymentForThisInstallment + toPay);
        remaining = round2(remaining - toPay);
      }

      // Solo crear el pago si hay algo que pagar en esta cuota
      if (paymentForThisInstallment > 0) {
        const newPayment = await tx.payment.create({
          data: {
            loanId,
            installmentId: installment.id, // Asociar con ESTA cuota específica
            registeredByUserId,
            amount: paymentForThisInstallment,
            paymentMethod,
            principalPaid: installmentPrincipalPaid,
            interestPaid: installmentInterestPaid,
            lateFeePaid: installmentLateFeePaid,
            roundingAdjustment: 0, // Sin redondeo por ahora para cada pago individual
            externalReference,
            receiptNumber, // Todos comparten el mismo recibo
            cashSessionId,
            paymentDate: new Date(),
          },
        });

        console.log('✅ Pago creado para cuota #' + installment.installmentNumber + ':', {
          paymentId: newPayment.id,
          amount: paymentForThisInstallment,
          interest: installmentInterestPaid,
          principal: installmentPrincipalPaid,
          lateFee: installmentLateFeePaid,
        });

        paymentsCreated.push(newPayment);

        // Verificar si esta cuota está ahora completamente pagada
        const allPaymentsNow = await tx.payment.findMany({
          where: { installmentId: installment.id },
        });

        const lateFeeDetailsNow = calculateInstallmentLateFee(installment, allPaymentsNow);
        const outstandingAmount = Number(lateFeeDetailsNow.pendingTotal || 0);

        if (outstandingAmount <= OUTSTANDING_TOLERANCE) {
          await tx.paymentSchedule.update({
            where: { id: installment.id },
            data: { 
              isPaid: true,
              remainingBalance: 0, // Establecer saldo restante a 0 cuando se paga
            },
          });
          console.log('✅ Cuota #' + installment.installmentNumber + ' marcada como pagada');
        }

        // Marcar moras como pagadas si se pagaron
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

    // Retornar el primer pago como referencia (o un pago consolidado)
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

  // Incluir información de cuotas pagadas en la respuesta
  payment.installmentsPaid = orderedInstallments.map(s => ({
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
  receiptType = 'BOLETA', // Tipo de comprobante (BOLETA o FACTURA)
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
        const lateFeeDetails = calculateInstallmentLateFee(installment, allPaymentsForInstallment);
        const outstandingInstallment = Number(lateFeeDetails.remainingInstallment || 0);
        const outstandingLateFee = Number(lateFeeDetails.lateFeeAmount || 0);
        const outstandingAmount = Number(
          lateFeeDetails.pendingTotal ?? round2(outstandingInstallment + outstandingLateFee)
        );
        const shouldMarkAsPaid = outstandingAmount <= OUTSTANDING_TOLERANCE;

        console.log('📊 Pagos encontrados para cuota:', {
          installmentId,
          totalPaid,
          paymentCount: allPaymentsForInstallment.length
        });

        console.log('💰 Comparación de montos:', {
          installmentId,
          installmentAmount,
          outstandingInstallment,
          outstandingLateFee,
          totalPaid,
          outstandingAmount,
          outstandingTolerance: OUTSTANDING_TOLERANCE,
          shouldMarkAsPaid,
        });

        // Solo marcar como pagada si el total pagado cubre el monto exacto (sin redondear)
        if (shouldMarkAsPaid) {
          await tx.paymentSchedule.update({
            where: { id: installmentId },
            data: { 
              isPaid: true,
              remainingBalance: 0, // Establecer saldo restante a 0 cuando se paga
            },
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

  // Recalcular remainingBalance para cada cuota dinámicamente basado en pagos reales
  const scheduleWithCalculatedBalance = loan.schedules.map(schedule => {
    const paymentsForSchedule = loan.payments.filter(p => p.installmentId === schedule.id);
    const lateFeeInfo = calculateInstallmentLateFee(schedule, paymentsForSchedule);
    
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
