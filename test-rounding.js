/**
 * Script de pruebas para la nueva función de redondeo
 * Verifica que applyRounding funciona correctamente según la regla:
 * - Si decimal > 0.05: redondea hacia arriba al siguiente 0.10
 * - Si decimal <= 0.05: redondea hacia abajo al 0.10 anterior
 */

function applyRounding(amount) {
  const num = Number(amount);
  const decimalPart = num % 1;
  
  if (decimalPart > 0.05) {
    return Math.ceil(num * 10) / 10;
  }
  
  return Math.floor(num * 10) / 10;
}

// Casos de prueba
const testCases = [
  // Decimales > 0.05 deben redondear hacia arriba al siguiente 0.10
  { input: 10.66, expected: 10.70, description: "10.66 (0.66 > 0.05) → redondea a 10.70" },
  { input: 10.56, expected: 10.60, description: "10.56 (0.56 > 0.05) → redondea a 10.60" },
  { input: 150.07, expected: 150.10, description: "150.07 (0.07 > 0.05) → redondea a 150.10" },
  { input: 150.06, expected: 150.10, description: "150.06 (0.06 > 0.05) → redondea a 150.10" },
  { input: 150.51, expected: 150.60, description: "150.51 (0.51 > 0.05) → redondea a 150.60" },
  { input: 150.99, expected: 151.00, description: "150.99 (0.99 > 0.05) → redondea a 151.00" },
  
  // Decimales <= 0.05 deben redondear hacia abajo al 0.10 anterior
  { input: 10.04, expected: 10.00, description: "10.04 (0.04 <= 0.05) → redondea a 10.00" },
  { input: 10.05, expected: 10.00, description: "10.05 (0.05 <= 0.05) → redondea a 10.00" },
  { input: 150.04, expected: 150.00, description: "150.04 (0.04 <= 0.05) → redondea a 150.00" },
  { input: 150.05, expected: 150.00, description: "150.05 (0.05 <= 0.05) → redondea a 150.00" },
  { input: 150.01, expected: 150.00, description: "150.01 (0.01 <= 0.05) → redondea a 150.00" },
  { input: 100.03, expected: 100.00, description: "100.03 (0.03 <= 0.05) → redondea a 100.00" },
  
  // Sin cambios (ya en múltiplos de 0.10)
  { input: 150.00, expected: 150.00, description: "150.00 → sin cambios" },
  { input: 100.10, expected: 100.10, description: "100.10 → sin cambios" },
  { input: 200.20, expected: 200.20, description: "200.20 → sin cambios" },
  { input: 200.30, expected: 200.30, description: "200.30 → sin cambios" },
];

console.log("=== PRUEBAS DE REDONDEO - NUEVA FUNCIÓN ===\n");

let passCount = 0;
let failCount = 0;

testCases.forEach((test, index) => {
  const result = applyRounding(test.input);
  const pass = Math.abs(result - test.expected) < 0.001;
  
  if (pass) {
    passCount++;
    console.log(`✓ CASO ${index + 1}: ${test.description}`);
  } else {
    failCount++;
    console.log(`✗ CASO ${index + 1}: ${test.description}`);
  }
  console.log(`  Entrada: ${test.input.toFixed(2)} → Resultado: ${result.toFixed(2)} (esperado: ${test.expected.toFixed(2)})`);
  console.log();
});

console.log(`\n=== RESUMEN ===`);
console.log(`Pruebas pasadas: ${passCount}/${testCases.length}`);
console.log(`Pruebas fallidas: ${failCount}/${testCases.length}`);

if (failCount === 0) {
  console.log("\n✓ ¡Todas las pruebas pasaron correctamente!");
  console.log("\nLa función ahora redondea correctamente a múltiplos de S/ 0.10:");
  console.log("- Si decimal > 0.05: redondea hacia ARRIBA");
  console.log("- Si decimal <= 0.05: redondea hacia ABAJO");
} else {
  console.log("\n✗ Algunas pruebas fallaron. Revisar la implementación.");
  process.exit(1);
}
