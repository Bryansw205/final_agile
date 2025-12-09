import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiDownload, apiFileUrl } from '../lib/api.js';
import { formatDate } from '../lib/date.js';

export default function LoanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loan, setLoan] = useState(null);
  const [statement, setStatement] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedInstallment, setSelectedInstallment] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('EFECTIVO');
  const [processingPayment, setProcessingPayment] = useState(false);
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
      setError('No se pudo cargar el préstamo: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    
    // Verificar si viene de Flow
    const flowToken = searchParams.get('token');
    if (flowToken) {
      verifyFlowPayment(flowToken);
    }
  }, [id]);

  async function verifyFlowPayment(token) {
    try {
      setLoading(true);
      const statusData = await apiGet(`/flow/payment-status?token=${token}`);
      
      if (statusData.status.status === 2) {
        // Pago exitoso
        setSuccess('¡Pago con Flow realizado exitosamente!');
        // Limpiar parámetros de URL
        setSearchParams({});
        // Recargar datos
        await load();
      } else if (statusData.status.status === 3) {
        setError('El pago con Flow fue rechazado');
        setSearchParams({});
      } else {
        setError('El pago está pendiente');
        setSearchParams({});
      }
    } catch (err) {
      console.error('Error verificando pago Flow:', err);
    } finally {
      setLoading(false);
    }
  }

  function handleOpenPaymentModal(installment) {
    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }

    setSelectedInstallment(installment);
    const remaining = parseFloat(installment.remainingInstallment ?? installment.installmentAmount) || 0;
    setPaymentAmount(remaining.toFixed(2));
    setShowPaymentModal(true);
    setError('');
    setSuccess('');
  }

  function handleClosePaymentModal() {
    setShowPaymentModal(false);
    setSelectedInstallment(null);
    setPaymentAmount('');
    setPaymentMethod('EFECTIVO');
  }

  async function handlePayment(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      setError('Ingrese un monto válido');
      return;
    }

    const maxAmount = (parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0) + (selectedInstallment.lateFeeAmount || 0);
    if (amount > maxAmount) {
      setError(`El monto no puede ser mayor a ${maxAmount.toFixed(2)}`);
      return;
    }

    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }

    setProcessingPayment(true);

    try {
      if (paymentMethod === 'FLOW') {
        // Pago con Flow
        const email = loan.client.email || prompt('Ingrese el email del cliente:');
        if (!email) {
          setError('Email requerido para pagar con Flow');
          setProcessingPayment(false);
          return;
        }

        const flowResponse = await apiPost('/flow/create-payment', {
          loanId: parseInt(id),
          amount,
          email,
        });

        // Redirigir a Flow
        window.location.href = flowResponse.paymentUrl;
      } else {
        // Pago con efectivo, tarjeta, yape, plin
        const paymentPayload = {
          loanId: parseInt(id),
          amount,
          paymentMethod,
          cashSessionId: cashSession?.id || null,
        };

        await apiPost('/payments', paymentPayload);

        setSuccess('Pago registrado exitosamente');
        handleClosePaymentModal();
        await load();
      }
    } catch (err) {
      setError(err.message || 'Error al procesar el pago');
    } finally {
      setProcessingPayment(false);
    }
  }

  if (loading && !loan) return <div className="section">Cargando...</div>;
  if (error && !loan) return <div className="section"><div className="badge badge-red">{error}</div></div>;
  if (!loan) return null;

  const totalAPagar = statement?.totals?.totalDebt || 0;
  const totalPagado = statement?.totals?.totalPaid || 0;
  const pendiente = statement?.totals?.pendingTotal || 0;

  const toCents = (v) => Math.round(Number(v || 0) * 100);
  const remainingForInstallment = (amount, paid) => {
    const remainingCents = Math.max(0, toCents(amount) - toCents(paid));
    // Si saldo restante < 0.05 (5 centavos), se redondea a 0 y se considera pagado
    // Si saldo restante >= 0.05, se redondea a 0.10 usando redondeo de banquero
    if (remainingCents < 5) {
      return 0; // Cuota considerada como pagada
    }
    // Para centavos >= 5, aplicar redondeo de banquero
    const remainingAmount = remainingCents / 100;
    const integerPart = Math.floor(remainingAmount);
    const cents = remainingCents % 100;
    
    // Si centavos 5-9, redondea a 0.10
    if (cents >= 5 && cents <= 9) {
      return integerPart + 0.10;
    }
    
    // Para centavos 10-99, aplicar redondeo de banquero
    const decimalPart = Math.floor(cents / 10) * 10;
    const remainder = cents % 10;
    
    if (remainder < 5) {
      return Number((integerPart + (decimalPart / 100)).toFixed(2));
    } else if (remainder > 5) {
      return Number((integerPart + ((decimalPart + 10) / 100)).toFixed(2));
    } else {
      // remainder === 5: Redondeo de banquero (al par más cercano)
      const tenthDigit = Math.floor((decimalPart / 10) % 10);
      const isEven = tenthDigit % 2 === 0;
      return isEven 
        ? Number((integerPart + (decimalPart / 100)).toFixed(2))  // Mantiene decimal par
        : Number((integerPart + ((decimalPart + 10) / 100)).toFixed(2));  // Redondea hacia par
    }
  };

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
      const remainingInstallment = remainingForInstallment(row.installmentAmount, paid);
      // Una cuota está pagada si el saldo restante es 0 (por redondeo de banquero)
      // o si el monto pagado es >= al monto de la cuota
      const isPaid = remainingInstallment === 0 || paid >= row.installmentAmount;
      return {
        ...row,
        remainingInstallment: Number(remainingInstallment.toFixed(2)),
        paidForThisInstallment: paid,
        isPaid: isPaid,
      };
    });
  })();

  return (
    <div className="section">
      {error && <div className="badge badge-red" style={{ marginBottom: '1rem' }}>{error}</div>}
      {success && <div className="badge badge-green" style={{ marginBottom: '1rem' }}>{success}</div>}
      {!cashSession && (
        <div className="badge badge-yellow" style={{ marginBottom: '1rem' }}>
          ⚠️ Debe abrir una sesión de caja antes de registrar pagos
        </div>
      )}

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
          <div style={{ marginTop: '1rem', padding: '1rem', backgroundColor: '#f8f9fa', borderRadius: '8px' }}>
            <h5 style={{ marginTop: 0 }}>Resumen de Pagos</h5>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
              <div>
                <strong>Total Deuda:</strong> S/ {totalAPagar.toFixed(2)}
              </div>
              <div>
                <strong>Total Pagado:</strong> S/ {totalPagado.toFixed(2)}
              </div>
              <div>
                <strong>Pendiente:</strong> S/ {pendiente.toFixed(2)}
              </div>
              <div>
                <strong>Mora:</strong> S/ {statement.totals.pendingLateFee.toFixed(2)}
              </div>
            </div>
          </div>
        )}

        <div className="mb-2" style={{ marginTop: '1rem' }}>
          Monto: S/ {Number(loan.principal).toFixed(2)} | Tasa anual: {(Number(loan.interestRate) * 100).toFixed(2)}% | Plazo: {loan.termCount} {loan.termCount === 1 ? 'mes' : 'meses'}
        </div>
        <a
          className="btn"
          href={apiFileUrl(`/loans/${loan.id}/schedule.pdf?token=${encodeURIComponent(localStorage.getItem('token') || '')}`)}
          target="_blank"
          rel="noreferrer"
        >
          Descargar Cronograma PDF
        </a>
      </div>

      <div className="card">
        <h4 style={{ marginTop: 0 }}>Cronograma de Pagos</h4>
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Cuota</th>
                <th>Fecha</th>
                <th>Monto</th>
                <th>Interés</th>
                <th>Capital</th>
                <th>Saldo</th>
                <th>Saldo restante</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {scheduleWithRemaining.map((row) => {
                const installmentAmount = Number(row.installmentAmount);
                const paidForThisInstallment = Number(row.paidForThisInstallment || 0);
                const isPaid = row.isPaid === true;
                const isPartiallyPaid = paidForThisInstallment > 0 && !isPaid;

                return (
                  <tr key={row.id}>
                    <td>{row.installmentNumber}</td>
                    <td>{formatDate(row.dueDate)}</td>
                    <td>S/ {installmentAmount.toFixed(2)}</td>
                    <td>S/ {Number(row.interestAmount).toFixed(2)}</td>
                    <td>S/ {Number(row.principalAmount).toFixed(2)}</td>
                    <td>S/ {Number(row.remainingBalance).toFixed(2)}</td>
                    <td>S/ {Number(row.remainingInstallment || 0).toFixed(2)}</td>
                    <td>
                      {isPaid ? (
                        <span className="badge badge-green">Pagado</span>
                      ) : isPartiallyPaid ? (
                        <span className="badge badge-yellow">Parcial</span>
                      ) : (
                        <span className="badge badge-red">Pendiente</span>
                      )}
                    </td>
                    <td>
                      {!isPaid && (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleOpenPaymentModal(row)}
                          disabled={processingPayment || !cashSession}
                        >
                          Pagar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {statement?.payments && statement.payments.length > 0 && (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h4 style={{ marginTop: 0 }}>Historial de Pagos</h4>
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Monto</th>
                <th>Método</th>
                <th>Capital</th>
                <th>Interés</th>
                <th>Mora</th>
                <th>Recibo</th>
                <th>Comprobante</th>
              </tr>
            </thead>
            <tbody>
              {statement.payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{new Date(payment.paymentDate).toLocaleString('es-PE')}</td>
                  <td>S/ {payment.amount.toFixed(2)}</td>
                  <td>{payment.paymentMethod}</td>
                  <td>S/ {payment.principalPaid.toFixed(2)}</td>
                  <td>S/ {payment.interestPaid.toFixed(2)}</td>
                  <td>S/ {payment.lateFeePaid.toFixed(2)}</td>
                  <td>{payment.receiptNumber}</td>
                  <td>
                    <button
                      className="btn btn-sm"
                      onClick={() => apiDownload(`/payments/${payment.id}/receipt`, `comprobante-${payment.receiptNumber}.pdf`)}
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

      {/* Modal de Pago */}
      {showPaymentModal && selectedInstallment && (
        <div className="modal-overlay" onClick={handleClosePaymentModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Registrar Pago - Cuota #{selectedInstallment.installmentNumber}</h3>
            
            <div style={{ padding: '1rem', backgroundColor: '#f8f9fa', borderRadius: '8px', marginBottom: '1rem' }}>
              <div><strong>Fecha de Vencimiento:</strong> {formatDate(selectedInstallment.dueDate)}</div>
              <div>
                <strong>Monto Pendiente de Cuota:</strong>{' '}
                S/ {(parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0).toFixed(2)}
              </div>
            </div>

            <form onSubmit={handlePayment}>
              <div className="form-group">
                <label htmlFor="paymentAmount">Monto a Pagar (S/)</label>
                <input
                  type="number"
                  id="paymentAmount"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  step="0.01"
                  max={(parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0).toFixed(2)}
                  min="0.01"
                  required
                  disabled={processingPayment}
                />
                <small>
                  Máximo: S/ {(parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0).toFixed(2)}
                </small>
              </div>

              <div className="form-group">
                <label htmlFor="paymentMethod">Método de Pago</label>
                <select
                  id="paymentMethod"
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  required
                  disabled={processingPayment}
                >
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="YAPE">Yape</option>
                  <option value="PLIN">Plin</option>
                  <option value="FLOW">Flow (Tarjeta/Webpay)</option>
                </select>
              </div>

              {!cashSession && (
                <div className="badge badge-yellow" style={{ marginBottom: '1rem' }}>
                  ⚠️ Debe abrir una sesión de caja para registrar pagos
                </div>
              )}

              {paymentMethod === 'EFECTIVO' && (
                <div className="badge badge-blue" style={{ marginBottom: '1rem' }}>
                  ℹ️ Se aplicará redondeo automático según normas peruanas
                </div>
              )}

              {paymentMethod === 'FLOW' && (
                <div className="badge badge-blue" style={{ marginBottom: '1rem' }}>
                  ℹ️ Será redirigido a Flow para completar el pago con tarjeta
                </div>
              )}

              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleClosePaymentModal}
                  disabled={processingPayment}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={processingPayment || !cashSession}
                >
                  {processingPayment ? 'Procesando...' : paymentMethod === 'FLOW' ? 'Ir a Flow' : 'Registrar Pago'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style jsx>{`
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal-content {
          background: white;
          padding: 2rem;
          border-radius: 8px;
          max-width: 500px;
          width: 90%;
          max-height: 90vh;
          overflow-y: auto;
        }

        .form-group {
          margin-bottom: 1.5rem;
        }

        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 600;
        }

        .form-group input,
        .form-group select {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }

        .form-group small {
          display: block;
          margin-top: 0.25rem;
          color: #666;
          font-size: 0.875rem;
        }

        .btn-sm {
          padding: 0.25rem 0.75rem;
          font-size: 0.875rem;
        }

        .badge {
          display: inline-block;
          padding: 0.25rem 0.75rem;
          border-radius: 4px;
          font-size: 0.875rem;
          font-weight: 600;
        }

        .badge-green {
          background-color: #d4edda;
          color: #155724;
        }

        .badge-yellow {
          background-color: #fff3cd;
          color: #856404;
        }

        .badge-red {
          background-color: #f8d7da;
          color: #721c24;
        }

        .badge-blue {
          background-color: #d1ecf1;
          color: #0c5460;
        }

        .table {
          width: 100%;
          border-collapse: collapse;
        }

        .table th,
        .table td {
          padding: 0.75rem;
          text-align: left;
          border-bottom: 1px solid #ddd;
        }

        .table th {
          background-color: #f8f9fa;
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}
