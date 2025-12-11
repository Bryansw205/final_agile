import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Obtiene el saldo actual de efectivo en una sesión de caja
 * = openingBalance + ingresos - egresos - vueltos
 */
export async function getCashSessionBalance(cashSessionId) {
  const session = await prisma.cashSession.findUnique({
    where: { id: cashSessionId },
  });

  if (!session) {
    throw new Error('Sesión de caja no encontrada');
  }

  // Calcular balance dinámico basado en movimientos
  const movements = await prisma.cashMovement.findMany({
    where: { cashSessionId },
  });

  let balance = Number(session.openingBalance);

  for (const movement of movements) {
    const amount = Number(movement.amount);
    switch (movement.movementType) {
      case 'INGRESO':
        balance += amount; // Se suma el ingreso
        break;
      case 'EGRESO':
      case 'VUELTO':
        balance -= amount; // Se resta el egreso/vuelto
        break;
      case 'RECAUDACION':
        balance += amount; // Se suma la recaudación
        break;
    }
  }

  return {
    openingBalance: Number(session.openingBalance),
    currentBalance: balance,
    movements: movements.map(m => ({
      ...m,
      amount: Number(m.amount),
    })),
  };
}

/**
 * Valida si hay suficiente efectivo en caja para dar vuelto
 */
export async function validateChangeAvailable(cashSessionId, changeAmount) {
  const balance = await getCashSessionBalance(cashSessionId);
  return {
    available: balance.currentBalance >= changeAmount,
    currentBalance: balance.currentBalance,
    required: changeAmount,
  };
}

/**
 * Registra un movimiento de caja (ingreso de efectivo del dueño)
 */
export async function addCashMovement({
  cashSessionId,
  movementType, // INGRESO, EGRESO, VUELTO, RECAUDACION
  amount,
  description,
  relatedPaymentId,
}) {
  if (amount <= 0) {
    throw new Error('El monto debe ser mayor a cero');
  }

  const movement = await prisma.cashMovement.create({
    data: {
      cashSessionId,
      movementType,
      amount,
      description,
      relatedPaymentId,
    },
  });

  return {
    ...movement,
    amount: Number(movement.amount),
  };
}

/**
 * Obtiene todos los movimientos de una sesión de caja
 */
export async function getCashMovements(cashSessionId) {
  const movements = await prisma.cashMovement.findMany({
    where: { cashSessionId },
    orderBy: { createdAt: 'desc' },
  });

  return movements.map(m => ({
    ...m,
    amount: Number(m.amount),
  }));
}

/**
 * Obtiene el resumen de una sesión de caja para cierre
 */
export async function getCashSessionSummary(cashSessionId) {
  const session = await prisma.cashSession.findUnique({
    where: { id: cashSessionId },
    include: {
      payments: true,
      movements: true,
    },
  });

  if (!session) {
    throw new Error('Sesión de caja no encontrada');
  }

  // Calcular totales de pagos
  const totalPayments = session.payments.reduce(
    (sum, p) => sum + Number(p.amount),
    0
  );

  // Calcular movimientos
  let totalIngresos = 0;
  let totalEgresos = 0;
  let totalVueltos = 0;

  for (const movement of session.movements) {
    const amount = Number(movement.amount);
    switch (movement.movementType) {
      case 'INGRESO':
        totalIngresos += amount;
        break;
      case 'EGRESO':
        totalEgresos += amount;
        break;
      case 'VUELTO':
        totalVueltos += amount;
        break;
    }
  }

  // Saldo esperado = apertura + pagos recibidos + ingresos - vueltos - egresos
  const expectedBalance = 
    Number(session.openingBalance) + 
    totalPayments + 
    totalIngresos - 
    totalVueltos - 
    totalEgresos;

  return {
    sessionId: session.id,
    openingBalance: Number(session.openingBalance),
    totalPayments,
    totalIngresos,
    totalEgresos,
    totalVueltos,
    expectedBalance,
    physicalBalance: session.physicalBalance ? Number(session.physicalBalance) : null,
    difference: session.difference ? Number(session.difference) : null,
    movements: session.movements.map(m => ({
      ...m,
      amount: Number(m.amount),
    })),
  };
}
