# Sistema de Gestión de Pagos

## Descripción General

Este sistema implementa un módulo completo de gestión de pagos para préstamos, incluyendo registro de pagos, cálculo de mora, generación de comprobantes y control de caja diario.

## Características Implementadas

### 1. Registro de Pagos

#### 1.1. Características
- **Pagos parciales y totales**: Los clientes pueden pagar cualquier monto (S/ 1, S/ 50, el total, etc.)
- **Múltiples métodos de pago**:
  - Efectivo (con redondeo automático)
  - Tarjeta de débito/crédito
  - Yape
  - Plin
  - Flow (pasarela de pago)
  - Otros

#### 1.2. Información Registrada
Cada pago registra:
- ID del préstamo asociado
- Cliente (inferido del préstamo)
- Fecha y hora del pago
- Monto pagado
- Medio de pago
- Usuario que registró el pago (cajero/operador)
- Desglose detallado:
  - Monto aplicado a capital
  - Monto aplicado a intereses
  - Monto aplicado a mora
  - Ajuste por redondeo (si aplica)

### 2. Sistema de Mora

#### 2.1. Reglas de Mora
- **Tasa**: 1% mensual sobre la deuda pendiente
- **Período**: Mensual (30 días)
- **Cálculo**: NO compuesto, es 1% simple por cada mes de atraso

#### 2.2. ¿Cuándo se Genera Mora?
- Si el cliente **NO paga nada** en un período de 30 días → se genera mora del 1%
- Si el cliente **paga algo** (aunque sea parcial) → NO se genera mora en ese período
- La mora es lineal: 1% por mes sin pago, no acumulativa ni compuesta

#### 2.3. Pagos Adelantados y Parciales
- Los pagos adelantados **NO** generan refinanciamiento
- Los pagos adelantados simplemente reducen la deuda
- Cualquier abono en un período previene la mora de ese mes

### 3. Redondeo en Efectivo

#### 3.1. Reglas de Redondeo (Norma Peruana)
Solo aplica para pagos en **efectivo**:
- Redondeo a múltiplos de S/ 0.10
- Centavos .01-.04 → redondea hacia abajo
- Centavos .05-.09 → redondea hacia arriba

**Ejemplos**:
- S/ 333.33 → S/ 333.30 (diferencia -0.03, condonada)
- S/ 333.36 → S/ 333.40 (diferencia +0.04)

#### 3.2. Para Otros Medios de Pago
- **Tarjeta, Yape, Plin, Flow**: NO hay redondeo
- Se cobra el monto exacto (ej: S/ 333.33 se cobra como S/ 333.33)

#### 3.3. Diferencias de Redondeo
- Las diferencias de centavos (±0.03, ±0.04) se consideran condonadas
- No generan mora
- Se registran en el campo `roundingAdjustment` del pago

### 4. Comprobantes de Pago

#### 4.1. Generación Automática
- Cada pago genera automáticamente un comprobante en PDF
- El comprobante se puede descargar inmediatamente
- También se puede reimprimir desde el historial de pagos

#### 4.2. Contenido del Comprobante
- **Datos del negocio**: Nombre, RUC, dirección
- **Número de recibo**: Único e irrepetible
- **Fecha y hora**: Timestamp del pago
- **Datos del cliente**: Nombre completo, DNI, email, teléfono
- **Datos del préstamo**: ID, monto, tasa de interés
- **Desglose del pago**:
  - Capital pagado
  - Interés pagado
  - Mora pagada (si aplica)
  - Ajuste por redondeo (si aplica)
  - **TOTAL PAGADO**
- **Método de pago**: Efectivo, Tarjeta, Yape, etc.
- **Referencia externa**: Si aplica (número de transacción)
- **Registrado por**: Usuario que realizó la transacción

### 5. Cuadro de Caja / Arqueo Diario

#### 5.1. Flujo de Operación
1. **Apertura de Caja** (inicio del día):
   - El cajero abre la sesión
   - Registra el saldo inicial en caja
   
2. **Durante el Día**:
   - Todos los pagos se asocian a la sesión de caja activa
   - El sistema lleva control automático de recaudación
   
3. **Cierre de Caja** (fin del día):
   - El cajero cuenta físicamente el dinero
   - Ingresa el monto físico contado
   - El sistema compara:
     - Saldo esperado = Saldo inicial + Total efectivo recaudado
     - Saldo físico = Lo que realmente hay
     - Diferencia = Saldo físico - Saldo esperado
   - Estado: "Cuadra" (diferencia = 0) o "Descuadre" (diferencia ≠ 0)

#### 5.2. Control por Método de Pago
El sistema separa automáticamente:
- **Efectivo**: Control estricto (es el que debe cuadrar físicamente)
- **Tarjeta**: Solo registro contable
- **Billeteras digitales** (Yape, Plin): Solo registro contable
- **Flow**: Solo registro contable

#### 5.3. Reporte de Cierre
Al cerrar la caja se genera un PDF con:
- Datos de la sesión (usuario, horario)
- Resumen financiero:
  - Saldo inicial
  - Total recaudado
  - Saldo esperado
  - Saldo físico
  - Diferencia (resaltada en rojo/verde)
- Desglose por método de pago
- Lista detallada de todos los pagos del día

### 6. Distribución Automática de Pagos

El sistema distribuye automáticamente cada pago en el siguiente orden:

1. **Primero**: Pagar mora pendiente
2. **Segundo**: Pagar intereses pendientes
3. **Tercero**: Pagar capital pendiente

Esta distribución es transparente y se muestra en:
- El comprobante de pago
- El estado de cuenta del préstamo
- El historial de pagos

## API Endpoints

### Pagos

#### `POST /payments`
Registra un nuevo pago
```json
{
  "loanId": 1,
  "amount": 150.50,
  "paymentMethod": "EFECTIVO",
  "cashSessionId": 5,
  "externalReference": "TXN123456" // opcional
}
```

#### `GET /payments/:id`
Obtiene detalles de un pago específico

#### `GET /payments/:id/receipt`
Descarga el comprobante de pago en PDF

#### `GET /payments/loan/:loanId`
Lista todos los pagos de un préstamo

#### `GET /payments/loan/:loanId/statement`
Obtiene el estado de cuenta completo del préstamo

#### `POST /payments/loan/:loanId/calculate-late-fees`
Calcula y registra las moras pendientes

### Sesiones de Caja

#### `POST /cash-sessions`
Abre una nueva sesión de caja
```json
{
  "openingBalance": 500.00
}
```

#### `GET /cash-sessions/current`
Obtiene la sesión de caja actual del usuario

#### `POST /cash-sessions/:id/close`
Cierra una sesión de caja
```json
{
  "physicalBalance": 1250.00
}
```

#### `GET /cash-sessions/:id`
Obtiene detalles de una sesión específica

#### `GET /cash-sessions/:id/report`
Descarga el reporte de cierre en PDF

#### `GET /cash-sessions/history/list`
Obtiene el historial de sesiones de caja

#### `GET /cash-sessions/report/daily`
Obtiene el reporte del día
```
Query params: date=2025-12-08
```

## Base de Datos

### Nuevos Modelos

#### Payment
```prisma
model Payment {
  id                 Int           @id @default(autoincrement())
  loanId             Int
  registeredByUserId Int
  amount             Decimal       @db.Decimal(18, 2)
  paymentMethod      PaymentMethod
  paymentDate        DateTime      @default(now())
  principalPaid      Decimal       @db.Decimal(18, 2)
  interestPaid       Decimal       @db.Decimal(18, 2)
  lateFeePaid        Decimal       @db.Decimal(18, 2)
  roundingAdjustment Decimal       @db.Decimal(18, 2)
  externalReference  String?
  receiptNumber      String        @unique
  cashSessionId      Int?
}
```

#### LateFee
```prisma
model LateFee {
  id          Int      @id @default(autoincrement())
  loanId      Int
  periodMonth Int
  periodYear  Int
  feeAmount   Decimal  @db.Decimal(18, 2)
  baseAmount  Decimal  @db.Decimal(18, 2)
  isPaid      Boolean  @default(false)
}
```

#### CashSession
```prisma
model CashSession {
  id              Int      @id @default(autoincrement())
  userId          Int
  openingBalance  Decimal  @db.Decimal(18, 2)
  closingBalance  Decimal? @db.Decimal(18, 2)
  physicalBalance Decimal? @db.Decimal(18, 2)
  difference      Decimal? @db.Decimal(18, 2)
  openedAt        DateTime @default(now())
  closedAt        DateTime?
  isClosed        Boolean  @default(false)
}
```

## Frontend

### Nuevas Páginas

#### `/cash-session`
- Abrir/cerrar sesión de caja
- Ver resumen de recaudación del día
- Ver desglose por método de pago
- Lista de pagos registrados
- Descargar reporte de cierre

#### `/loans/:id` (actualizada)
- Ver estado de cuenta completo
- Registrar pagos (parciales o totales)
- Ver historial de pagos
- Descargar comprobantes
- Ver moras pendientes

## Flujo de Trabajo Recomendado

### Para el Cajero/Operador

1. **Al Inicio del Día**:
   - Ir a "Caja"
   - Hacer clic en "Abrir Caja"
   - Ingresar el saldo inicial en efectivo
   - Confirmar apertura

2. **Durante el Día** (cuando un cliente paga):
   - Ir al detalle del préstamo del cliente
   - Hacer clic en "Registrar Pago"
   - Ingresar:
     - Monto que el cliente está pagando
     - Método de pago
     - Referencia externa (si no es efectivo)
   - Confirmar pago
   - El sistema descarga automáticamente el comprobante
   - Entregar comprobante al cliente (impreso o digital)

3. **Al Final del Día**:
   - Contar físicamente el dinero en caja
   - Ir a "Caja"
   - Hacer clic en "Cerrar Caja"
   - Ingresar el monto físico contado
   - Verificar que cuadre (diferencia = 0)
   - Descargar reporte de cierre
   - Si hay descuadre, investigar antes de cerrar

## Notas Importantes

1. **Solo el cajero/operador usa el sistema** - Los clientes NO tienen acceso
2. **Redondeo solo en efectivo** - Otros métodos cobran monto exacto
3. **Mora se calcula automáticamente** - No hay que calcular manualmente
4. **Comprobante siempre se genera** - Es obligatorio para cada pago
5. **No se refinancia** - Los pagos adelantados solo reducen deuda
6. **Sesión de caja obligatoria** - No se pueden registrar pagos sin sesión abierta

## Configuración

### Variables de Entorno (Backend)
```env
DATABASE_URL="postgresql://..."
```

### Variables de Entorno (Frontend)
```env
VITE_API_URL="http://localhost:4000"
```

## Instalación y Uso

### Backend
```bash
cd backend
npm install
npx prisma migrate deploy
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## Soporte

Para cualquier duda sobre el funcionamiento del sistema, referirse a este documento o contactar al equipo de desarrollo.
