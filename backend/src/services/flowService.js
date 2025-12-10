import crypto from 'crypto';

const FLOW_API_KEY = process.env.FLOW_API_KEY;
const FLOW_SECRET_KEY = process.env.FLOW_SECRET_KEY;
const FLOW_API_URL = process.env.FLOW_API_URL || 'https://sandbox.flow.cl/api';
const FLOW_CURRENCY = process.env.FLOW_CURRENCY || 'CLP';

/**
 * Genera la firma para las peticiones a Flow
 */
function generateSignature(params, secretKey) {
  // Ordenar parámetros alfabéticamente
  const sortedKeys = Object.keys(params).sort();
  const paramsString = sortedKeys.map(key => `${key}${params[key]}`).join('');
  
  // Crear firma HMAC SHA256
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(paramsString);
  return hmac.digest('hex');
}

/**
 * Crea una orden de pago en Flow
 * @param {Object} options
 * @param {number} options.amount - Monto a cobrar
 * @param {string} options.subject - Descripción del pago
 * @param {string} options.email - Email del cliente
 * @param {string} options.paymentMethod - Método de pago (opcional: 9 para todos)
 * @param {string} options.urlConfirmation - URL de confirmación del webhook
 * @param {string} options.urlReturn - URL de retorno después del pago
 * @returns {Promise<Object>} Datos de la orden creada
 */
export async function createFlowPayment({
  amount,
  subject,
  email,
  commerceOrder,
  urlConfirmation,
  urlReturn,
  paymentMethod = 9, // 9 = Todos los medios de pago
  optional,
}) {
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
    throw new Error('Las credenciales de Flow no están configuradas');
  }

  const params = {
    apiKey: FLOW_API_KEY,
    commerceOrder: commerceOrder || `ORD-${Date.now()}`,
    subject,
    currency: FLOW_CURRENCY,
    amount: amount, // Monto exacto sin redondear (con centavos)
    email,
    paymentMethod,
    urlConfirmation,
    urlReturn,
  };

  // Agregar parámetros opcionales
  if (optional) {
    params.optional = typeof optional === 'string' ? optional : JSON.stringify(optional);
  }

  // Generar firma
  params.s = generateSignature(params, FLOW_SECRET_KEY);

  console.log('📤 Enviando a Flow:', { ...params, s: '***' });

  try {
    const response = await fetch(`${FLOW_API_URL}/payment/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });

    const responseText = await response.text();
    console.log('📥 Respuesta Flow (raw):', responseText);

    if (!response.ok) {
      throw new Error(`Error en Flow (${response.status}): ${responseText}`);
    }

    const data = JSON.parse(responseText);
    console.log('✅ Orden de pago creada:', data);

    return {
      url: data.url + '?token=' + data.token,
      token: data.token,
      flowOrder: data.flowOrder,
    };
  } catch (error) {
    console.error('❌ Error creando pago en Flow:', error);
    throw error;
  }
}

/**
 * Obtiene el estado de un pago en Flow
 * @param {string} token - Token del pago
 * @returns {Promise<Object>} Estado del pago
 */
export async function getFlowPaymentStatus(token) {
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
    throw new Error('Las credenciales de Flow no están configuradas');
  }

  const params = {
    apiKey: FLOW_API_KEY,
    token,
  };

  params.s = generateSignature(params, FLOW_SECRET_KEY);

  try {
    const response = await fetch(
      `${FLOW_API_URL}/payment/getStatus?${new URLSearchParams(params).toString()}`
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Error en Flow (${response.status}): ${responseText}`);
    }

    const data = JSON.parse(responseText);
    console.log('📊 Estado del pago Flow:', data);

    // Extraer optional si existe
    let optional = null;
    if (data.optional) {
      try {
        optional = typeof data.optional === 'string' 
          ? JSON.parse(data.optional) 
          : data.optional;
      } catch (e) {
        console.error('Error parseando optional:', e);
      }
    }

    return {
      flowOrder: data.flowOrder,
      commerceOrder: data.commerceOrder,
      status: data.status, // 1=pendiente, 2=pagado, 3=rechazado, 4=anulado
      amount: data.amount,
      currency: data.currency,
      paymentDate: data.paymentData?.date,
      paymentMethod: data.paymentData?.media,
      paymentData: data.paymentData,
      optional: optional,
    };
  } catch (error) {
    console.error('❌ Error obteniendo estado de Flow:', error);
    throw error;
  }
}

/**
 * Convierte el status de Flow a un estado legible
 */
export function getFlowStatusText(status) {
  const statuses = {
    1: 'Pendiente',
    2: 'Pagado',
    3: 'Rechazado',
    4: 'Anulado',
  };
  return statuses[status] || 'Desconocido';
}

/**
 * Mapea el método de pago de Flow a los métodos de la BD
 * Flow devuelve valores como: "Pago con YAPE", "Pago con PLIN", "Transferencia Bancaria", etc.
 * @param {string} flowPaymentMethod - Método de Flow (ej: "Pago con YAPE")
 * @returns {string} Método de BD compatible
 */
export function mapFlowPaymentMethod(flowPaymentMethod) {
  if (!flowPaymentMethod) return 'FLOW';
  
  const method = (flowPaymentMethod || '').toUpperCase().trim();
  
  // Mapeo directo para métodos de Flow
  if (method.includes('YAPE')) return 'YAPE';
  if (method.includes('PLIN')) return 'PLIN';
  
  // Billetera digital
  if (method.includes('BILLETERA') || method.includes('WALLET')) return 'BILLETERA_DIGITAL';
  
  // Tarjeta de débito
  if (method.includes('DÉBITO') || method.includes('DEBITO') || method.includes('DEBIT')) return 'TARJETA_DEBITO';
  
  // Tarjeta de crédito (mapear a tarjeta)
  if (method.includes('CRÉDITO') || method.includes('CREDITO') || method.includes('CREDIT')) return 'TARJETA';
  
  // Transferencia bancaria
  if (method.includes('TRANSFERENCIA') || method.includes('TRANSFER')) return 'FLOW';
  
  // Si no coincide con nada, retornar FLOW como default
  return 'FLOW';
}

