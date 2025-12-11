import { useState, useEffect } from 'react';
import { apiGet, apiPost, apiDownload, getPaymentMethodLabel } from '../lib/api';

export default function Payments() {
  const [cashSession, setCashSession] = useState(null);
  const [openingBalance, setOpeningBalance] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [history, setHistory] = useState([]);

  useEffect(() => {
    loadCurrentSession();
    loadHistory();
  }, []);

  async function loadCurrentSession() {
    try {
      setLoading(true);
      const data = await apiGet('/cash-sessions/current');
      setCashSession(data.session);
    } catch (err) {
      console.error('Error cargando sesión:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const data = await apiGet('/cash-sessions/history/list?limit=50');
      setHistory(data.sessions || []);
    } catch (err) {
      console.error('Error cargando historial:', err);
    }
  }

  async function handleOpenSession(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    
    try {
      setLoading(true);
      const data = await apiPost('/cash-sessions', {
        openingBalance: parseFloat(openingBalance),
      });
      setCashSession(data.session);
      setOpeningBalance('');
      setSuccess('Sesión de caja abierta correctamente');
      loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  
async function handleAddCash() {
  if (!cashSession) return;
  const amountStr = prompt('Monto a ingresar en caja (S/):');
  if (amountStr === null) return;
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    setError('Ingrese un monto v?lido mayor a 0');
    return;
  }

  setError('');
  setSuccess('');

  try {
    setLoading(true);
    await apiPost(`/cash-sessions/${cashSession.id}/movements`, {
      movementType: 'INGRESO',
      amount,
      description: 'Ingreso manual a caja',
    });
    setSuccess('Efectivo agregado a caja');
    await loadCurrentSession();
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
}

async function handleCloseSession() {
    const physicalBalance = prompt('Ingrese el monto físico contado en caja:');
    if (physicalBalance === null) return;

    setError('');
    setSuccess('');

    try {
      setLoading(true);
      const data = await apiPost(`/cash-sessions/${cashSession.id}/close`, {
        physicalBalance: parseFloat(physicalBalance),
      });
      setCashSession(data.session);
      setSuccess('Sesión de caja cerrada correctamente');
      loadHistory();
      
      // Descargar reporte
      setTimeout(() => {
        apiDownload(`/cash-sessions/${cashSession.id}/report`, `cierre-caja-${cashSession.id}.pdf`);
      }, 500);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading && !cashSession) {
    return <div className="container">Cargando...</div>;
  }

  return (
    <div className="container">
      <h1>Gestión de Caja</h1>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {!cashSession || cashSession.isClosed ? (
        <div className="card">
          <h2>Abrir Sesión de Caja</h2>
          <form onSubmit={handleOpenSession}>
            <div className="form-group">
              <label htmlFor="openingBalance">Saldo Inicial (S/)</label>
              <input
                type="number"
                id="openingBalance"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(e.target.value)}
                step="0.01"
                min="0"
                required
                disabled={loading}
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Abriendo...' : 'Abrir Caja'}
            </button>
          </form>
        </div>
      ) : (
        <div>
          <div className="card">
            <h2>Sesión de Caja Actual</h2>
            <div className="info-grid">
              <div>
                <strong>Usuario:</strong> {cashSession.user.username}
              </div>
              <div>
                <strong>Apertura:</strong> {new Date(cashSession.openedAt).toLocaleString('es-PE')}
              </div>
              <div>
                <strong>Saldo Inicial:</strong> S/ {cashSession.openingBalance.toFixed(2)}
              </div>
              {cashSession.summary && (
                <>
                  <div>
                    <strong>Total Recaudado:</strong> S/ {cashSession.summary.totalAmount.toFixed(2)}
                  </div>
                  <div>
                    <strong>Efectivo en Caja:</strong> S/ {cashSession.summary.totalCash.toFixed(2)}
                  </div>
                  <div>
                    <strong>Saldo Esperado:</strong> S/ {cashSession.summary.expectedClosingBalance.toFixed(2)}
                  </div>
                  <div>
                    <strong>Total Pagos:</strong> {cashSession.summary.totalPayments}
                  </div>
                </>
              )}
            </div>

            {cashSession.summary?.paymentsByMethod && (
              <div style={{ marginTop: '1rem' }}>
                <h3>Desglose por Método de Pago</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Método</th>
                      <th>Cantidad</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(cashSession.summary.paymentsByMethod).map(([method, data]) => (
                      <tr key={method}>
                        <td>{getPaymentMethodLabel(method)}</td>
                        <td>{data.count}</td>
                        <td>S/ {data.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button
                onClick={handleAddCash}
                disabled={loading}
                style={{ backgroundColor: '#198754' }}
              >
                {loading ? 'Guardando...' : 'Agregar efectivo a caja'}
              </button>

              <button
                onClick={handleCloseSession}
                disabled={loading}
                style={{ backgroundColor: '#dc3545' }}
              >
                {loading ? 'Cerrando...' : 'Cerrar Caja'}
              </button>
            </div>
          </div>

          {cashSession.payments && cashSession.payments.length > 0 && (
            <div className="card" style={{ marginTop: '2rem' }}>
              <h2>Pagos del Día</h2>
              <table>
                <thead>
                  <tr>
                    <th>Hora</th>
                    <th>Cliente</th>
                    <th>Método</th>
                    <th>Monto</th>
                    <th>Monto Dado</th>
                    <th>Vuelto</th>
                    <th>Recibo</th>
                  </tr>
                </thead>
                <tbody>
                  {cashSession.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td>{new Date(payment.paymentDate).toLocaleTimeString('es-PE')}</td>
                      <td>{payment.loan.client.firstName} {payment.loan.client.lastName}</td>
                      <td>{getPaymentMethodLabel(payment.paymentMethod)}</td>
                      <td>S/ {payment.amount.toFixed(2)}</td>
                      <td>{payment.amountGiven ? `S/ ${Number(payment.amountGiven).toFixed(2)}` : '-'}</td>
                      <td>{payment.change !== null && payment.change !== undefined ? `S/ ${Number(payment.change).toFixed(2)}` : '-'}</td>
                      <td>{payment.receiptNumber}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 2rem;
        }

        .card {
          background: white;
          border-radius: 8px;
          padding: 2rem;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .alert {
          padding: 1rem;
          border-radius: 4px;
          margin-bottom: 1rem;
        }

        .alert-error {
          background-color: #fee;
          color: #c33;
          border: 1px solid #fcc;
        }

        .alert-success {
          background-color: #efe;
          color: #3c3;
          border: 1px solid #cfc;
        }

        .form-group {
          margin-bottom: 1rem;
        }

        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 600;
        }

        .form-group input {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }

        button {
          background-color: #007bff;
          color: white;
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1rem;
        }

        button:hover:not(:disabled) {
          background-color: #0056b3;
        }

        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1rem;
          margin: 1rem 0;
        }

        .info-grid div {
          padding: 0.5rem;
          background: #f8f9fa;
          border-radius: 4px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 1rem;
        }

        th, td {
          padding: 0.75rem;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }

        th {
          background-color: #f8f9fa;
          font-weight: 600;
        }

        tr:hover {
          background-color: #f8f9fa;
        }
      `}</style>

      {history && history.length > 0 && (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h2>Historial de Cajas Cerradas</h2>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Usuario</th>
                <th>Apertura</th>
                <th>Cierre</th>
                <th>Saldo Inicial</th>
                <th>Saldo Cierre</th>
                <th>Diferencia</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td>{s.user?.username || '-'}</td>
                  <td>{new Date(s.openedAt).toLocaleString('es-PE')}</td>
                  <td>{s.closedAt ? new Date(s.closedAt).toLocaleString('es-PE') : '-'}</td>
                  <td>S/ {Number(s.openingBalance).toFixed(2)}</td>
                  <td>{s.closingBalance !== null ? `S/ ${Number(s.closingBalance).toFixed(2)}` : '-'}</td>
                  <td>{s.difference !== null ? `S/ ${Number(s.difference).toFixed(2)}` : '-'}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={() => apiDownload(`/cash-sessions/${s.id}/report`, `cierre-caja-${s.id}.pdf`)}
                    >
                      Descargar PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
