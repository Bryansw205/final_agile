import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiDownload, apiFileUrl } from '../lib/api.js';
import { formatDate } from '../lib/date.js';

export default function LoanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loan, setLoan] = useState(null);
  const [statement, setStatement] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentData, setPaymentData] = useState({
    amount: '',
    paymentMethod: 'EFECTIVO',
    externalReference: '',
  });
  const [cashSession, setCashSession] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [loanData, statementData, sessionData] = await Promise.all([
        apiGet(`/loans/${id}`),
        apiGet(`/payments/loan/${id}/statement`),
        apiGet('/cash-sessions/current'),
      ]);
      setLoan(loanData);
      setStatement(statementData);
      setCashSession(sessionData.session);
    } catch (e) {
      setError('No se pudo cargar el préstamo');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const handlePaymentSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!cashSession || cashSession.isClosed) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }

    try {
      setLoading(true);
      const response = await apiPost('/payments', {
        loanId: parseInt(id),
        amount: parseFloat(paymentData.amount),
        paymentMethod: paymentData.paymentMethod,
        cashSessionId: cashSession.id,
        externalReference: paymentData.externalReference || null,
      });

      // Descargar comprobante
      await apiDownload(
        `/payments/${response.payment.id}/receipt`,
        `comprobante-${response.payment.receiptNumber}.pdf`
      );

      // Recargar datos
      await load();
      setShowPaymentForm(false);
      setPaymentData({ amount: '', paymentMethod: 'EFECTIVO', externalReference: '' });
      alert('Pago registrado correctamente. Descargando comprobante...');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading && !loan) return <div>Cargando...</div>;
  if (error && !loan) return <div className="badge badge-red">{error}</div>;
  if (!loan) return null;

  const totalAPagar = statement?.totals?.totalDebt || 0;
  const totalPagado = statement?.totals?.totalPaid || 0;
  const pendiente = statement?.totals?.pendingTotal || 0;

  const scheduleWithRemaining = (() => {
    if (!loan?.schedules) return [];
    const paidByInstallment = new Map();
    (statement?.payments || []).forEach((p) => {
      if (!p.installmentId) return;
      const paidPortion = Number(p.principalPaid || 0) + Number(p.interestPaid || 0);
      paidByInstallment.set(
        p.installmentId,
        (paidByInstallment.get(p.installmentId) || 0) + paidPortion
      );
    });
    return loan.schedules.map((row) => {
      const paid = paidByInstallment.get(row.id) || 0;
      const remainingInstallment = Math.max(0, Number(row.installmentAmount || 0) - paid);
      return {
        ...row,
        remainingInstallment: Number(remainingInstallment.toFixed(2)),
      };
    });
  })();

  return (
    <div className="section">
      {error && <div className="badge badge-red mb-3">{error}</div>}
      
      <div className="card mb-4">
        <div className="mb-3">
          <button className="btn" onClick={() => navigate(-1)}>Volver</button>
        </div>
        <h4 style={{ marginTop: 0 }}>Préstamo #{loan.id}</h4>
        <div className="mb-2">
          Cliente: {loan.client.firstName} {loan.client.lastName} (DNI {loan.client.dni})
        </div>
        <div className="mb-2">Creado por: {loan.createdBy?.username || '-'}</div>
        
        {statement && (
          <div className="mb-2">
            <strong>Total Deuda:</strong> S/ {totalAPagar.toFixed(2)} | 
            <strong> Pagado:</strong> S/ {totalPagado.toFixed(2)} | 
            <strong> Pendiente:</strong> <span style={{ color: pendiente > 0 ? '#dc3545' : '#28a745' }}>
              S/ {pendiente.toFixed(2)}
            </span>
          </div>
        )}

        {statement?.totals?.pendingLateFee > 0 && (
          <div className="mb-2" style={{ color: '#dc3545' }}>
            <strong>Mora Pendiente:</strong> S/ {statement.totals.pendingLateFee.toFixed(2)}
          </div>
        )}

        <div className="mb-2">
          Monto: S/ {Number(loan.principal).toFixed(2)} | Tasa anual: {(Number(loan.interestRate) * 100).toFixed(2)}% | Plazo: {loan.termCount} {loan.termCount === 1 ? 'mes' : 'meses'}
        </div>
        
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <a
            className="btn"
            href={apiFileUrl(`/loans/${loan.id}/schedule.pdf?token=${encodeURIComponent(localStorage.getItem('token') || '')}`)}
            target="_blank"
            rel="noreferrer"
          >
            Descargar Cronograma PDF
          </a>
          
          {pendiente > 0 && (
            <button 
              className="btn" 
              style={{ backgroundColor: '#28a745' }}
              onClick={() => setShowPaymentForm(!showPaymentForm)}
            >
              {showPaymentForm ? 'Cancelar Pago' : 'Registrar Pago'}
            </button>
          )}
        </div>
      </div>

      {showPaymentForm && (
        <div className="card mb-4">
          <h4>Registrar Pago</h4>
          
          {!cashSession || cashSession.isClosed ? (
            <div className="badge badge-red">
              No hay sesión de caja abierta. Por favor, abra una sesión antes de registrar pagos.
            </div>
          ) : (
            <form onSubmit={handlePaymentSubmit}>
              <div className="mb-3">
                <label>Monto (S/)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={pendiente}
                  value={paymentData.amount}
                  onChange={(e) => setPaymentData({ ...paymentData, amount: e.target.value })}
                  required
                  disabled={loading}
                />
                <small>Monto pendiente: S/ {pendiente.toFixed(2)}</small>
              </div>

              <div className="mb-3">
                <label>Método de Pago</label>
                <select
                  value={paymentData.paymentMethod}
                  onChange={(e) => setPaymentData({ ...paymentData, paymentMethod: e.target.value })}
                  disabled={loading}
                >
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="TARJETA">Tarjeta</option>
                  <option value="YAPE">Yape</option>
                  <option value="PLIN">Plin</option>
                  <option value="FLOW">Flow</option>
                  <option value="OTRO">Otro</option>
                </select>
                {paymentData.paymentMethod === 'EFECTIVO' && (
                  <small style={{ color: '#666' }}>
                    Se aplicará redondeo automático según normas peruanas
                  </small>
                )}
              </div>

              {paymentData.paymentMethod !== 'EFECTIVO' && (
                <div className="mb-3">
                  <label>Referencia Externa (opcional)</label>
                  <input
                    type="text"
                    value={paymentData.externalReference}
                    onChange={(e) => setPaymentData({ ...paymentData, externalReference: e.target.value })}
                    placeholder="N° de operación, transacción, etc."
                    disabled={loading}
                  />
                </div>
              )}

              <button type="submit" className="btn" disabled={loading}>
                {loading ? 'Procesando...' : 'Registrar Pago'}
              </button>
            </form>
          )}
        </div>
      )}

      {statement?.payments && statement.payments.length > 0 && (
        <div className="card mb-4">
          <h4>Historial de Pagos</h4>
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Recibo</th>
                <th>Método</th>
                <th>Monto</th>
                <th>Capital</th>
                <th>Interés</th>
                <th>Mora</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {statement.payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{new Date(payment.paymentDate).toLocaleString('es-PE')}</td>
                  <td>{payment.receiptNumber}</td>
                  <td>{payment.paymentMethod}</td>
                  <td>S/ {payment.amount.toFixed(2)}</td>
                  <td>S/ {payment.principalPaid.toFixed(2)}</td>
                  <td>S/ {payment.interestPaid.toFixed(2)}</td>
                  <td>S/ {payment.lateFeePaid.toFixed(2)}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={() => apiDownload(
                        `/payments/${payment.id}/receipt`,
                        `comprobante-${payment.receiptNumber}.pdf`
                      )}
                    >
                      Descargar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card table-flush">
        <h4>Cronograma de Pagos</h4>
        <table className="table">
          <thead>
            <tr>
              <th>Cuota</th>
              <th>Fecha</th>
              <th>Cuota (S/)</th>
              <th>Interés</th>
              <th>Capital</th>
              <th>Saldo</th>
              <th>Saldo restante</th>
            </tr>
          </thead>
          <tbody>
            {scheduleWithRemaining.map((row) => (
              <tr key={row.id}>
                <td>{row.installmentNumber}</td>
                <td>{formatDate(row.dueDate)}</td>
                <td>{Number(row.installmentAmount).toFixed(2)}</td>
                <td>{Number(row.interestAmount).toFixed(2)}</td>
                <td>{Number(row.principalAmount).toFixed(2)}</td>
                <td>{Number(row.remainingBalance).toFixed(2)}</td>
                <td>{Number(row.remainingInstallment || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style jsx>{`
        .mb-2 { margin-bottom: 0.5rem; }
        .mb-3 { margin-bottom: 1rem; }
        .mb-4 { margin-bottom: 1.5rem; }
        
        .btn-sm {
          padding: 0.25rem 0.5rem;
          font-size: 0.875rem;
        }

        label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 600;
        }

        input, select {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }

        small {
          display: block;
          margin-top: 0.25rem;
          font-size: 0.875rem;
          color: #666;
        }
      `}</style>
    </div>
  );
}
