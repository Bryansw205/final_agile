import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Lima';

// Calcula cronograma de pagos con cuotas fijas (sistema francés).
// interestRate es anual (ej. 0.24 para 24%).
// Fechas: cada cuota vence a los 30 días exactos desde la anterior
// (ej.: 15/10 -> 14/11), manteniendo TZ Lima.
export function generateSchedule({ principal, interestRate, termCount, startDate }) {
  if (principal <= 0) throw new Error('Monto debe ser positivo');
  if (termCount <= 0) throw new Error('Plazo debe ser positivo');
  if (interestRate < 0) throw new Error('Tasa no puede ser negativa');

  const periods = termCount;
  // Interpretar la fecha como Lima y al inicio del día
  const start = dayjs.tz(startDate, TZ).startOf('day');

  // Tasa por periodo (mensual)
  const r = interestRate / 12;

  // Fórmula de anualidad para cuota fija si r>0; si r=0 cuota = principal/periods
  const installment = r > 0
    ? (principal * (r * Math.pow(1 + r, periods)) / (Math.pow(1 + r, periods) - 1))
    : (principal / periods);

  let balance = principal;
  const schedule = [];
  let prevDue = start;
  for (let i = 1; i <= periods; i++) {
    const interest = balance * r;
    const principalPart = Math.max(0, installment - interest);
    balance = Math.max(0, balance - principalPart);

    // Próxima fecha: +30 días respecto a la anterior
    let dueDate = prevDue.add(30, 'day');
    // Fijar mediodía para evitar desfaces por TZ/DST al serializar
    dueDate = dueDate.hour(12).minute(0).second(0).millisecond(0);

    schedule.push({
      installmentNumber: i,
      dueDate: dueDate.toDate(),
      installmentAmount: round2(installment),
      principalAmount: round2(principalPart),
      interestAmount: round2(interest),
      remainingBalance: round2(balance),
    });

    prevDue = dueDate.startOf('day');
  }

  // Ajustes finales por redondeos
  const last = schedule[schedule.length - 1];
  if (last) {
    // 1) Si queda saldo por redondeo, súmalo al capital de la última cuota
    if (last.remainingBalance !== 0) {
      const diff = last.remainingBalance;
      last.principalAmount = round2(last.principalAmount + diff);
      last.remainingBalance = 0;
    }
    // 2) Asegurar que la suma de capital sea exactamente el principal
    const sumPrincipal = round2(schedule.reduce((a, r) => a + Number(r.principalAmount), 0));
    const diffPrincipal = round2(principal - sumPrincipal);
    if (diffPrincipal !== 0) {
      last.principalAmount = round2(last.principalAmount + diffPrincipal);
    }
    // 3) Alinear la última cuota = capital + interés
    last.installmentAmount = round2(Number(last.principalAmount) + Number(last.interestAmount));
  }
  return schedule;
}

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
