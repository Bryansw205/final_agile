# Integración con Flow (Pasarela de Pagos)

## Configuración

### 1. Obtener Credenciales de Flow

1. Regístrate en [Flow.cl](https://www.flow.cl)
2. Ve a la sección de API
3. Obtén tus credenciales:
   - **API Key**: Identificador público de tu comercio
   - **Secret Key**: Clave secreta para firmar peticiones

### 2. Configurar Variables de Entorno

Edita el archivo `backend/.env` y agrega:

```env
# Configuración de Flow (Pasarela de Pagos)
FLOW_API_KEY=tu_api_key_aqui
FLOW_SECRET_KEY=tu_secret_key_aqui
FLOW_API_URL=https://sandbox.flow.cl/api
# Para producción: https://www.flow.cl/api

# URLs base (para webhooks y redirecciones)
BASE_URL=http://localhost:4000
FRONTEND_URL=http://localhost:5173
```

**Importante**:
- Usa `sandbox.flow.cl` para pruebas
- Usa `www.flow.cl` para producción
- El `BASE_URL` debe ser accesible públicamente para que Flow envíe webhooks

### 3. Configurar Webhook en Flow

En tu panel de Flow, configura:
- **URL de Confirmación**: `https://tu-dominio.com/flow/webhook`
- El webhook recibirá notificaciones cuando un pago sea completado

## Flujo de Pago con Flow

### 1. Crear Orden de Pago

```javascript
// POST /flow/create-payment
{
  "loanId": 1,
  "amount": 500.00,
  "email": "cliente@example.com"
}

// Respuesta
{
  "success": true,
  "paymentUrl": "https://www.flow.cl/app/web/pay.php?token=ABC123",
  "token": "ABC123",
  "flowOrder": 12345,
  "commerceOrder": "LOAN-1-1234567890"
}
```

### 2. Redirigir al Cliente

Envía al cliente a `paymentUrl`. El cliente completará el pago en el sitio de Flow.

### 3. Webhook Automático

Flow notificará automáticamente a tu servidor cuando el pago sea exitoso:
- El sistema registra el pago automáticamente
- Se genera el comprobante
- El préstamo se actualiza

### 4. Confirmación Manual (Fallback)

Si el webhook falla, puedes confirmar manualmente:

```javascript
// POST /flow/confirm-payment
{
  "token": "ABC123"
}
```

### 5. Consultar Estado

```javascript
// GET /flow/payment-status?token=ABC123
{
  "success": true,
  "status": {
    "flowOrder": 12345,
    "commerceOrder": "LOAN-1-1234567890",
    "status": 2,
    "statusText": "Pagado",
    "amount": 500,
    "paymentDate": "2025-12-08T10:30:00Z",
    "paymentMethod": "Webpay"
  }
}
```

## Estados de Pago en Flow

| Status | Descripción |
|--------|-------------|
| 1      | Pendiente   |
| 2      | Pagado      |
| 3      | Rechazado   |
| 4      | Anulado     |

## Integración Frontend

### Ejemplo de uso en React:

```jsx
async function handlePayWithFlow() {
  try {
    // Crear orden de pago
    const response = await apiPost('/flow/create-payment', {
      loanId: loan.id,
      amount: paymentAmount,
      email: client.email || 'cliente@example.com',
    });

    // Redirigir al cliente a Flow
    window.location.href = response.paymentUrl;
  } catch (error) {
    console.error('Error:', error);
  }
}
```

### Manejo de Retorno

Cuando el cliente regresa de Flow, puedes verificar el estado:

```jsx
// En el componente LoanDetail
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const flowSuccess = params.get('flow');
  const token = params.get('token');

  if (flowSuccess === 'success' && token) {
    // Verificar estado del pago
    apiGet(`/flow/payment-status?token=${token}`)
      .then(data => {
        if (data.status.status === 2) {
          alert('¡Pago exitoso!');
          // Recargar datos del préstamo
          loadLoan();
        }
      });
  }
}, []);
```

## Seguridad

### 1. Verificación de Firmas

Todas las peticiones a Flow están firmadas con HMAC-SHA256:

```javascript
// El sistema verifica automáticamente las firmas
function generateSignature(params, secretKey) {
  const sortedKeys = Object.keys(params).sort();
  const paramsString = sortedKeys.map(key => `${key}${params[key]}`).join('');
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(paramsString);
  return hmac.digest('hex');
}
```

### 2. Validación en Webhook

El webhook verifica:
- Firma válida
- Estado del pago (solo procesa pagos exitosos)
- Previene pagos duplicados

### 3. No Asociado a Sesión de Caja

Los pagos con Flow:
- **NO** se asocian a sesión de caja
- **NO** requieren sesión de caja abierta
- Se registran como método "FLOW"
- Son puramente digitales

## Testing (Sandbox)

### Tarjetas de Prueba Flow

En sandbox, usa estas tarjetas para probar:

**Visa Exitosa**:
- Número: 4051 8842 3993 7763
- CVV: 123
- Fecha: cualquier fecha futura

**Mastercard Exitosa**:
- Número: 5186 0595 9207 8247
- CVV: 123
- Fecha: cualquier fecha futura

**Tarjeta Rechazada**:
- Número: 4051 8842 3993 7771
- CVV: 123

## Conversión de Moneda

**Importante**: Flow trabaja con pesos chilenos (CLP).

Si tu sistema usa soles peruanos (PEN), necesitas:

1. Convertir el monto antes de enviar a Flow:
```javascript
const amountInCLP = amountInPEN * exchangeRate;
```

2. O configurar Flow para usar otra moneda (si está disponible)

## Troubleshooting

### El webhook no funciona

1. **Verifica que `BASE_URL` sea accesible públicamente**
   - No uses `localhost` en producción
   - Usa un dominio real o ngrok para pruebas

2. **Revisa los logs del servidor**
   ```bash
   tail -f backend/logs/server.log
   ```

3. **Confirma manualmente**
   ```bash
   POST /flow/confirm-payment
   { "token": "ABC123" }
   ```

### El pago aparece duplicado

El sistema previene duplicados verificando `externalReference`. Si ocurre:
- Revisa que el webhook no se esté llamando múltiples veces
- Verifica que la referencia de Flow sea única

### Error de firma inválida

- Verifica que `FLOW_SECRET_KEY` sea correcta
- Asegúrate de no tener espacios al inicio/fin
- Confirma que estás usando el entorno correcto (sandbox vs producción)

## Monitoreo

### Ver Pagos Flow en el Sistema

```sql
-- Todos los pagos con Flow
SELECT * FROM "Payment" 
WHERE "paymentMethod" = 'FLOW'
ORDER BY "paymentDate" DESC;

-- Pagos Flow de hoy
SELECT * FROM "Payment" 
WHERE "paymentMethod" = 'FLOW'
  AND DATE("paymentDate") = CURRENT_DATE;
```

### Logs Importantes

El sistema registra:
- Creación de órdenes de pago
- Notificaciones de webhook recibidas
- Confirmaciones exitosas
- Errores de firma o validación

## Resumen

✅ **Ventajas de Flow**:
- Pago en línea seguro
- Sin manejo de efectivo
- Confirmación automática
- Múltiples métodos de pago (Webpay, tarjetas, etc.)
- No requiere sesión de caja

✅ **Flujo Completo**:
1. Cliente decide pagar con Flow
2. Sistema crea orden en Flow
3. Cliente paga en sitio de Flow
4. Flow notifica vía webhook
5. Sistema registra pago automáticamente
6. Se genera comprobante
7. Cliente puede descargar comprobante

✅ **Para Producción**:
1. Cambia a credenciales de producción
2. Actualiza `FLOW_API_URL` a `https://www.flow.cl/api`
3. Configura `BASE_URL` con tu dominio real
4. Prueba el webhook con pagos reales pequeños
