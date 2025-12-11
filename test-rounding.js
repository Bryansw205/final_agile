/**
 * Script de pruebas para la nueva función de redondeo
 * Verifica que applyRounding funciona correctamente según la regla:
 * - Si decimal > 0.05: redondea hacia arriba
 * - Si decimal <= 0.05: redondea hacia abajo
 */

function applyRounding(amount) {
  const num = Number(amount);
  const decimalPart = num % 1;
  
  if (decimalPart > 0.05) {
    return Math.ceil(num * 100) / 100;
  }
  
  return Math.floor(num * 100) / 100;
}

// Casos de prueba
const testCases = [
  // Decimales > 0.05 deben redondear hacia arriba
  { input: 150.07, expected: 150.10, description: "0.07 > 0.05 → redondea hacia arriba a 0.10" },
  { input: 150.06, expected: 150.10, description: "0.06 > 0.05 → redondea hacia arriba a 0.10" },
  { input: 150.51, expected: 150.10, description: "0.51 > 0.05 → redondea hacia arriba a 0.10" },
  { input: 150.99, expected: 151.00, description: "0.99 > 0.05 → redondea hacia arriba a 1.00" },
  { input: 100.08, expected: 100.10, description: "0.08 > 0.05 → redondea hacia arriba a 0.10" },
  
  // Decimales <= 0.05 deben redondear hacia abajo
  { input: 150.04, expected: 150.00, description: "0.04 <= 0.05 → redondea hacia abajo a 0.00" },
  { input: 150.05, expected: 150.00, description: "0.05 <= 0.05 → redondea hacia abajo a 0.00" },
  { input: 150.01, expected: 150.00, description: "0.01 <= 0.05 → redondea hacia abajo a 0.00" },
  { input: 100.03, expected: 100.00, description: "0.03 <= 0.05 → redondea hacia abajo a 0.00" },
  
  // Sin cambios
  { input: 150.00, expected: 150.00, description: "0.00 → sin cambios" },
  { input: 100.10, expected: 100.10, description: "0.10 ya está en múltiplo de 0.10" },
  { input: 200.20, expected: 200.20, description: "0.20 ya está en múltiplo de 0.10" },
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
} else {
  console.log("\n✗ Algunas pruebas fallaron. Revisar la implementación.");
  process.exit(1);
}
