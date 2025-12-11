/**
 * Redondea un valor a 2 decimales
 * Regla: Si parte decimal > 0.05 redondea hacia arriba, si es <= 0.05 redondea hacia abajo
 * @param {number} amount - El monto a redondear
 * @returns {number} - El monto redondeado a 2 decimales
 */
export function roundAmount(amount) {
  const num = Number(amount);
  const rounded = Math.round(num * 100) / 100;
  
  // Obtener la parte decimal
  const decimalPart = (num % 1);
  
  // Si la parte decimal es > 0.05, redondea hacia arriba
  if (decimalPart > 0.05) {
    return Math.ceil(num * 100) / 100;
  }
  
  // Si es <= 0.05, redondea hacia abajo
  return Math.floor(num * 100) / 100;
}

/**
 * Suma dos montos y los redondea según la regla
 * @param {number} amount1 - Primer monto
 * @param {number} amount2 - Segundo monto
 * @returns {number} - La suma redondeada
 */
export function sumAndRound(amount1, amount2) {
  const sum = Number(amount1) + Number(amount2);
  return roundAmount(sum);
}

/**
 * Redondea a 2 decimales de forma estándar
 * @param {number} v - El valor a redondear
 * @returns {number} - El valor redondeado a 2 decimales
 */
export function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}
