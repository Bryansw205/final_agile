import React, { useState, useEffect } from 'react';
import { apiPost } from '../lib/api.js';
import { formatDate } from '../lib/date.js';

export default function NewLoan() {
  const [dni, setDni] = useState('12345678');
  const [client, setClient] = useState(null);
  const [principal, setPrincipal] = useState(300);
  const [interestPercent, setInterestPercent] = useState(10); // UI en %
  const [termCount, setTermCount] = useState(12);
  const todayPeru = (() => {
    const nowPeru = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/Lima' })
    );
    const y = nowPeru.getFullYear();
    const m = String(nowPeru.getMonth() + 1).padStart(2, '0');
    const d = String(nowPeru.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  })();
  const [startDate, setStartDate] = useState(todayPeru);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const [toast, setToast] = useState(null);
  const [toastType, setToastType] = useState('success'); // 'success' | 'error'
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Declaración general (>= 5350)
  const [declarationDownloaded, setDeclarationDownloaded] = useState(false);
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  // PEP
  const [pep, setPep] = useState(false);
  const [pepDownloaded, setPepDownloaded] = useState(false);
  const [pepAccepted, setPepAccepted] = useState(false);

  useEffect(() => {
    if (Number(principal) < 5350) {
      setDeclarationDownloaded(false);
      setDeclarationAccepted(false);
    }
  }, [principal]);

  useEffect(() => {
    if (!pep) {
      setPepDownloaded(false);
      setPepAccepted(false);
    }
  }, [pep]);

  const showToast = (message, type = 'error') => {
    setToast(message);
    setToastType(type);
    setTimeout(() => setToast(null), 3000);
  };

  const lookup = async () => {
    setError('');
    setClient(null);
    try {
      const value = String(dni || '').trim();
      if (!/^\d{8}$/.test(value)) {
        const friendly = 'DNI inválido. Debe tener 8 dígitos.';
        setError(friendly);
        showToast(friendly, 'error');
        return;
      }
      const c = await apiPost('/clients/lookup', { dni });
      setClient(c);
    } catch (e) {
      const raw = e?.message || '';
      const friendly = /not\s*found|404/i.test(raw)
        ? 'DNI no encontrado'
        : 'No se pudo obtener datos del DNI';
      setError(friendly);
      showToast(friendly, 'error');
    }
  };

  // Nueva validación: monto > 0 y tasa > 0
  const validateLoanInputs = () => {
    if (Number(principal) <= 0) return 'El monto debe ser mayor a 0.';
    if (Number(interestPercent) <= 0) return 'La tasa debe ser mayor a 0%.';
    const t = Number(termCount);
    if (!Number.isFinite(t) || t <= 0) return 'El plazo debe ser mayor a 0.';
    if (!Number.isInteger(t)) return 'El plazo debe ser un entero.';
    return '';
  };

  const loadPreview = async () => {
    setError('');
    setCreated(null);
    setPreview(null);
    const validation = validateLoanInputs();
    if (validation) {
      setError(validation);
      showToast(validation, 'error');
      return;
    }
    setLoadingPreview(true);
    try {
      const data = await apiPost('/loans/preview', {
        principal: Number(principal),
        interestRate: Number(interestPercent) / 100,
        termCount: Number(termCount),
        startDate,
      });
      setPreview(data);
    } catch (e) {
      const msg = e?.message || 'No se pudo generar la vista previa';
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setLoadingPreview(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setCreated(null);
    const validation = validateLoanInputs();
    if (validation) {
      setError(validation);
      showToast(validation, 'error');
      return;
    }
    if (!client) {
      const msg = 'Debe seleccionar cliente';
      setError(msg);
      showToast(msg, 'error');
      return;
    }
    try {
      const loan = await apiPost('/loans', {
        clientId: client.id,
        principal: Number(principal),
        interestRate: Number(interestPercent) / 100,
        termCount: Number(termCount),
        startDate,
        declarationAccepted:
          Number(principal) >= 5350
            ? Boolean(pep ? pepAccepted : declarationAccepted)
            : true,
      });
      setCreated(loan);
      showToast('Préstamo creado', 'success');
    } catch (e) {
      const msg = e?.message || 'Error al crear préstamo';
      setError(msg);
      showToast(msg, 'error');
    }
  };

  return (
    <div className="section">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Registrar nuevo préstamo</h3>
        <form onSubmit={submit} className="form">
          <div className="label">DNI</div>
          <div
            className="form-row"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              alignItems: 'center',
              gap: 12,
              width: '100%',
            }}
          >
            <input
              className="input"
              value={dni}
              onChange={(e) => setDni(e.target.value)}
              maxLength={8}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="8 dígitos"
            />
            <button
              type="button"
              className="btn btn-primary"
              style={{ height: 48 }}
              onClick={lookup}
            >
              Buscar
            </button>
            <label
              className="checkbox"
              style={{ height: 48, display: 'inline-flex', alignItems: 'center' }}
            >
              <input
                className="check"
                type="checkbox"
                checked={pep}
                onChange={(e) => setPep(e.target.checked)}
              />
              <span>Cliente PEP</span>
            </label>
          </div>

          {!client && (
            <div className="muted">
              Busca el DNI y selecciona al cliente para asociar el préstamo.
            </div>
          )}
          {client && (
            <div className="badge badge-green client-badge">
              Cliente: {client.firstName} {client.lastName} (DNI: {client.dni})
            </div>
          )}

          <div className="grid-2">
            <div>
              <div className="label">Monto</div>
              <input
                className="input"
                type="number"
                step="0.01"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
              />
            </div>
            <div>
              <div className="label">Tasa anual (%)</div>
              <input
                className="input"
                type="number"
                step="0.01"
                value={interestPercent}
                onChange={(e) => setInterestPercent(e.target.value)}
              />
            </div>
          </div>

          <div className="grid-2">
            <div>
              <div className="label">Plazo (meses)</div>
              <input
                className="input"
                type="number"
                step="1"
                value={termCount}
                onChange={(e) => setTermCount(e.target.value)}
              />
            </div>
            <div>
              <div className="label">Fecha de inicio</div>
              <input
                className="input"
                type="date"
                value={startDate}
                disabled
                readOnly
              />
            </div>
          </div>

          {/* Declaración jurada PEP (si está marcado) */}
          {pep && (
            <div className="card" style={{ background: '#fff7ed', borderColor: '#fdba74' }}>
              <div className="mb-2">
                <strong>Declaración Jurada (PEP)</strong>
              </div>
              <div className="mb-2">
                Por ser cliente PEP debe descargar y aceptar la Declaración Jurada.
              </div>
              <div className="form-row">
                <a
                  className="btn"
                  href="/declaracion_jurada.pdf"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setPepDownloaded(true)}
                >
                  Descargar Declaración Jurada
                </a>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    disabled={!pepDownloaded}
                    checked={pepAccepted}
                    onChange={(e) => setPepAccepted(e.target.checked)}
                  />
                  El cliente PEP firmó y aceptó la Declaración Jurada
                </label>
              </div>
            </div>
          )}

          {/* Declaración jurada para montos >= 5,350 (solo si NO es PEP) */}
          {!pep && Number(principal) >= 5350 && (
            <div className="card" style={{ background: '#fff7ed', borderColor: '#fdba74' }}>
              <div className="mb-2">
                <strong>Requisito obligatorio</strong>
              </div>
              <div className="mb-2">
                Para montos desde S/ 5,350 es obligatorio descargar y aceptar la Declaración Jurada.
              </div>
              <div className="form-row">
                <a
                  className="btn"
                  href="/declaracion_jurada.pdf"
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setDeclarationDownloaded(true)}
                >
                  Descargar Declaración Jurada
                </a>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    disabled={!declarationDownloaded}
                    checked={declarationAccepted}
                    onChange={(e) => setDeclarationAccepted(e.target.checked)}
                  />
                  El cliente firmó y aceptó la Declaración Jurada
                </label>
              </div>
            </div>
          )}

          <div className="form-row">
            <button type="button" className="btn" onClick={loadPreview} disabled={loadingPreview}>
              {loadingPreview ? 'Generando...' : 'Ver vista previa'}
            </button>
          </div>

          {/* errores como toast */}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={(pep && !pepAccepted) || (!pep && Number(principal) >= 5350 && !declarationAccepted)}
          >
            Crear préstamo
          </button>
        </form>
      </div>

      {preview && (
        <div className="card table-flush" style={{ marginTop: 16 }}>
          <div className="card-content">
            <h4 style={{ marginTop: 0 }}>Vista previa del cronograma</h4>
            <div className="mb-2">
              Cuota estimada: S/ {Number(preview.summary.installmentAmount).toFixed(2)} | Total intereses: S/ {Number(preview.summary.totalInterest).toFixed(2)} | Total a pagar: S/ {Number(preview.summary.totalAmount).toFixed(2)}
            </div>
            <div className="mb-2">
              Última cuota: {formatDate(preview.summary.lastDueDate)}
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Cuota</th>
                <th>Fecha</th>
                <th>Cuota (S/)</th>
                <th>Interés</th>
                <th>Capital</th>
                <th>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {preview.schedule.map((row) => (
                <tr key={row.installmentNumber}>
                  <td>{row.installmentNumber}</td>
                  <td>{formatDate(row.dueDate)}</td>
                  <td>{Number(row.installmentAmount).toFixed(2)}</td>
                  <td>{Number(row.interestAmount).toFixed(2)}</td>
                  <td>{Number(row.principalAmount).toFixed(2)}</td>
                  <td>{Number(row.remainingBalance).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div className={'toast ' + (toastType === 'error' ? 'error' : '')}>{toast}</div>
      )}
    </div>
  );
}
