import fetch from 'node-fetch';
import { config } from '../config.js';

// Servicio para consultar datos por DNI usando Decolecta.
// Endpoint: GET {baseUrl}/reniec/dni?numero={dni}
export async function getPersonByDni(dni) {
  if (!/^[0-9]{8}$/.test(dni)) {
    const err = new Error('DNI inválido (deben ser 8 dígitos)');
    err.status = 400;
    throw err;
  }
  if (!config.dni.enabled || !config.dni.token) {
    // Modo mock para desarrollo
    return { firstName: 'Cliente', lastName: `DNI${dni.substring(4)}` };
  }
  try {
    const url = `${config.dni.baseUrl.replace(/\/$/, '')}/reniec/dni?numero=${dni}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.dni.token}`,
        'Content-Type': 'application/json'
      }
    });
    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Error API DNI (${resp.status}): ${text}`);
      err.status = resp.status === 404 ? 404 : 400;
      throw err;
    }
    const data = safeJson(text);

    // Mapeo flexible según posibles claves: nombres/apellidos o full_name
    const nombres = data?.nombres || data?.first_name || '';
    const apPat = data?.apellido_paterno || data?.apellidoPaterno || '';
    const apMat = data?.apellido_materno || data?.apellidoMaterno || '';
    let firstName = nombres?.toString().trim();
    let lastName = [apPat, apMat].filter(Boolean).join(' ').trim();

    if ((!firstName || !lastName) && data?.full_name) {
      const full = String(data.full_name).trim();
      // Heurística RENIEC (Perú): "APELLIDO_PATERNO APELLIDO_MATERNO NOMBRES..."
      // Ej: "GALLARDO DIAZ ALEXANDER YAIR" → lastName: "GALLARDO DIAZ", firstName: "ALEXANDER YAIR"
      const parts = full.split(/\s+/).filter(Boolean);
      if (parts.length >= 3) {
        // Asume 2 apellidos + el resto como nombres
        lastName = parts.slice(0, 2).join(' ');
        firstName = parts.slice(2).join(' ');
      } else if (parts.length === 2) {
        lastName = parts[0];
        firstName = parts[1];
      } else {
        firstName = full;
        lastName = '';
      }
    }

    if (!firstName) {
      const err = new Error('Datos incompletos desde API de DNI');
      err.status = 404;
      throw err;
    }

    return { firstName, lastName };
  } catch (e) {
    if (!e.status) e.status = 502;
    throw e;
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return {}; }
}
