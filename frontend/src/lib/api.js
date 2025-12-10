const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export function authHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseError(res) {
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json.error || json.message || text;
  } catch {
    return text;
  }
}

export async function apiGet(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiPost(path, data) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiPatch(path, data) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function apiDownload(path, filename) {
  const res = await fetch(`${API_URL}${path}`, { headers: { ...authHeaders() } });
  if (!res.ok) throw new Error(await parseError(res));
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export function apiFileUrl(path) {
  return `${API_URL}${path}`;
}

/**
 * Convierte el código de método de pago a un nombre legible
 * @param {string} method - Método de pago (EFECTIVO, YAPE, PLIN, TARJETA, etc.)
 * @returns {string} Nombre legible del método
 */
export function getPaymentMethodLabel(method) {
  const methods = {
    'EFECTIVO': '💵 Efectivo',
    'YAPE': '📱 YAPE',
    'PLIN': '📱 PLIN',
    'BILLETERA_DIGITAL': '💳 Billetera Digital',
    'TARJETA_DEBITO': '💳 Tarjeta Débito',
    'TARJETA CREDITO': '💳 Tarjeta Crédito',
    'FLOW': '🌐 Flow',
    'OTRO': '❓ Otro'
  };
  return methods[method] || method;
}
