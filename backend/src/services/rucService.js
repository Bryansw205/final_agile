import fetch from 'node-fetch';
import { config } from '../config.js';

export async function getCompanyByRuc(ruc) {
  if (!config.ruc.enabled || !config.ruc.token) {
    throw new Error('Servicio de RUC no configurado');
  }
  const url = `${config.ruc.baseUrl.replace(/\/$/, '')}/sunat/ruc?numero=${encodeURIComponent(ruc)}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ruc.token}`
    }
  });
  if (!res.ok) {
    const msg = await safeError(res);
    throw new Error(msg || 'No se pudo consultar RUC');
  }
  const data = await res.json();
  return normalizeCompany(data);
}

async function safeError(res) {
  try {
    const body = await res.json();
    return body?.message || body?.error;
  } catch {
    return null;
  }
}

function normalizeCompany(data) {
  return {
    ruc: data.numero_documento || '',
    razonSocial: data.razon_social || '',
    estado: data.estado || '',
    condicion: data.condicion || '',
    direccion: data.direccion || '',
    distrito: data.distrito || '',
    provincia: data.provincia || '',
    departamento: data.departamento || ''
  };
}
