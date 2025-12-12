import { PrismaClient } from '@prisma/client';
import { getCashSessionBalance, getCashMovements } from './cashService.js';
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
 * Abre una sesión de caja
 */
export async function openCashSession({ userId, openingBalance }) {
  // Verificar que no haya una sesión abierta
  const existingSession = await prisma.cashSession.findFirst({
    where: {
      userId,
      isClosed: false,
    },
  });

  if (existingSession) {
    throw new Error('Ya existe una sesión de caja abierta para este usuario');
  }

  const session = await prisma.cashSession.create({
    data: {
      userId,
      openingBalance: Number(openingBalance),
      openedAt: new Date(),
      isClosed: false,
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
    },
  });

  return session;
}

/**
 * Cierra una sesión de caja
 */
export async function closeCashSession({ sessionId, physicalBalance }) {
  const session = await prisma.cashSession.findUnique({
    where: { id: sessionId },
    include: {
      payments: true,
      user: {
        select: {
          id: true,
          username: true,
        },
      },
    },
  });

  if (!session) {
    throw new Error('Sesión de caja no encontrada');
  }

  if (session.isClosed) {
    throw new Error('La sesión de caja ya está cerrada');
  }

  // Calcular el balance actual incluyendo pagos + movimientos de caja
  const balance = await getCashSessionBalance(sessionId);
  const closingBalance = balance.currentBalance;
  const difference = round2(Number(physicalBalance) - closingBalance);

  // Validar que el monto físico sea exactamente igual al monto en caja
  // No permite cerrar si hay diferencia
  const TOLERANCE = 0.01; // Tolerancia mínima por redondeos
  if (Math.abs(difference) > TOLERANCE) {
    const sign = difference > 0 ? 'más' : 'menos';
    throw new Error(
      `No se puede cerrar la caja. Hay ${sign} dinero. ` +
      `Monto esperado: S/ ${closingBalance.toFixed(2)}, ` +
      `Monto ingresado: S/ ${Number(physicalBalance).toFixed(2)}`
    );
  }

  const updatedSession = await prisma.cashSession.update({
    where: { id: sessionId },
    data: {
      closingBalance,
      physicalBalance: Number(physicalBalance),
      difference,
      closedAt: new Date(),
      isClosed: true,
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
      payments: {
        include: {
          loan: {
            include: {
              client: true,
            },
          },
        },
      },
    },
  });

  return updatedSession;
}

/**
 * Obtiene la sesión de caja actual del usuario
 */
export async function getCurrentCashSession(userId) {
  const session = await prisma.cashSession.findFirst({
    where: {
      userId,
      isClosed: false,
    },
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
      payments: {
        include: {
          loan: {
            include: {
              client: true,
            },
          },
          registeredBy: {
            select: {
              username: true,
            },
          },
        },
        orderBy: {
          paymentDate: 'desc',
        },
      },
    },
  });

  if (!session) {
    return null;
  }

  // Balance y movimientos de caja (incluye ingresos/egresos/vueltos)
  const balance = await getCashSessionBalance(session.id);
  const movements = await getCashMovements(session.id);

  // Calcular totales por m?todo de pago (solo pagos, informativo)
  const paymentsByMethod = session.payments.reduce((acc, payment) => {
    const method = payment.paymentMethod;
    if (!acc[method]) {
      acc[method] = {
        count: 0,
        total: 0,
      };
    }
    acc[method].count++;
    acc[method].total = round2(acc[method].total + Number(payment.amount));
    return acc;
  }, {});

  const totalCash = balance.currentBalance;
  const expectedClosingBalance = round2(balance.currentBalance);

  return {
    ...session,
    movements,
    summary: {
      paymentsByMethod,
      totalPayments: session.payments.length,
      totalAmount: round2(session.payments.reduce((sum, p) => sum + Number(p.amount), 0)),
      totalCash,
      expectedClosingBalance,
    },
  };
}

export async function getCashSessionHistory({ userId, startDate, endDate, limit = 50 }) {
  const where = {
    ...(userId && { userId }),
    ...(startDate && { openedAt: { gte: new Date(startDate) } }),
    ...(endDate && { openedAt: { lte: new Date(endDate) } }),
  };

  const sessions = await prisma.cashSession.findMany({
    where,
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
      _count: {
        select: {
          payments: true,
        },
      },
    },
    orderBy: {
      openedAt: 'desc',
    },
    take: limit,
  });

  return sessions;
}

/**
 * Obtiene el detalle de una sesión de caja
 */
export async function getCashSessionDetail(sessionId) {
  const session = await prisma.cashSession.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        select: {
          id: true,
          username: true,
        },
      },
      payments: {
        include: {
          loan: {
            include: {
              client: true,
            },
          },
          registeredBy: {
            select: {
              username: true,
            },
          },
        },
        orderBy: {
          paymentDate: 'asc',
        },
      },
    },
  });

  if (!session) {
    throw new Error('Sesión de caja no encontrada');
  }

  // Calcular totales por método de pago
  const paymentsByMethod = session.payments.reduce((acc, payment) => {
    const method = payment.paymentMethod;
    if (!acc[method]) {
      acc[method] = {
        count: 0,
        total: 0,
        payments: [],
      };
    }
    acc[method].count++;
    acc[method].total = round2(acc[method].total + Number(payment.amount));
    acc[method].payments.push(payment);
    return acc;
  }, {});

  return {
    ...session,
    summary: {
      paymentsByMethod,
      totalPayments: session.payments.length,
      totalAmount: round2(session.payments.reduce((sum, p) => sum + Number(p.amount), 0)),
    },
  };
}

/**
 * Obtiene el reporte de caja del día
 */
export async function getDailyCashReport(date) {
  const startOfDay = dayjs.tz(date, TZ).startOf('day').toDate();
  const endOfDay = dayjs.tz(date, TZ).endOf('day').toDate();

  const payments = await prisma.payment.findMany({
    where: {
      paymentDate: {
        gte: startOfDay,
        lte: endOfDay,
      },
    },
    include: {
      loan: {
        include: {
          client: true,
        },
      },
      registeredBy: {
        select: {
          username: true,
        },
      },
      cashSession: {
        select: {
          id: true,
          isClosed: true,
        },
      },
    },
    orderBy: {
      paymentDate: 'asc',
    },
  });

  // Agrupar por método de pago
  const paymentsByMethod = payments.reduce((acc, payment) => {
    const method = payment.paymentMethod;
    if (!acc[method]) {
      acc[method] = {
        count: 0,
        total: 0,
        payments: [],
      };
    }
    acc[method].count++;
    acc[method].total = round2(acc[method].total + Number(payment.amount));
    acc[method].payments.push(payment);
    return acc;
  }, {});

  const totalAmount = round2(payments.reduce((sum, p) => sum + Number(p.amount), 0));
  const totalCash = paymentsByMethod.EFECTIVO?.total || 0;

  return {
    date: startOfDay,
    payments,
    summary: {
      paymentsByMethod,
      totalPayments: payments.length,
      totalAmount,
      totalCash,
    },
  };
}
