import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { apiGet, apiPost, apiDownload, apiFileUrl } from '../lib/api.js';
import { formatDate } from '../lib/date.js';

/**
 * Redondeo de Banquero (Redondeo al Par Más Cercano)
 * Si el dígito anterior al 0.05 es par, redondea hacia abajo
 * Si es impar, redondea hacia arriba para que el resultado sea par
 * Reglas:
 * - Si saldo < 0.05: redondea a 0 (cuota considerada pagada)
 * - Si saldo >= 0.05: redondea a 0.10
 */
function roundCash(amount) {
  const cents = Math.round((amount % 1) * 100);
  const integerPart = Math.floor(amount);

  // Si los centavos son menores a 5, redondea hacia abajo (condonar)
  if (cents < 5) return integerPart;

  // Si los centavos son >= 5, redondea hacia arriba a 0.10
  if (cents >= 5 && cents <= 9) return integerPart + 0.10;

  // Para centavos 10-99, aplicar redondeo de banquero
  const decimalPart = Math.floor(cents / 10) * 10;
  const remainder = cents % 10;

  if (remainder < 5) {
    // Redondea hacia abajo al múltiplo de 10 anterior (redondeo de banquero)
    return integerPart + (decimalPart / 100);
  } else if (remainder > 5) {
    // Redondea hacia arriba
    return integerPart + ((decimalPart + 10) / 100);
  } else {
    // remainder === 5: Redondeo de banquero (al par más cercano)
    const isEven = (decimalPart / 10) % 2 === 0;
    return isEven 
      ? integerPart + (decimalPart / 100)  // Mantiene decimal par
      : integerPart + ((decimalPart + 10) / 100);  // Redondea hacia par
  }
}

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
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [receiptPayment, setReceiptPayment] = useState(null);
  const [receiptType, setReceiptType] = useState('boleta');
  const [invoiceRuc, setInvoiceRuc] = useState('');
  const [invoiceName, setInvoiceName] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [loanData, statementData, sessionData, schedulesWithMora] = await Promise.all([
        apiGet(`/loans/${id}`),
        apiGet(`/payments/loan/${id}/statement`),
        apiGet('/cash-sessions/current'),
        apiGet(`/loans/${id}/schedules-with-mora`),
      ]);
      // Combinar los datos de mora con las cuotas del préstamo
      const loansWithMora = {
        ...loanData,
        schedules: loanData.schedules.map((s, idx) => ({
          ...s,
          hasLateFee: schedulesWithMora[idx]?.hasLateFee || false,
          lateFeeAmount: schedulesWithMora[idx]?.lateFeeAmount || 0,
        }))
      };
      setLoan(loansWithMora);
      setStatement(statementData);
      setCashSession(sessionData.session);
    } catch (e) {
      console.error('Error cargando préstamo:', e);
      // Si viene de Flow, no mostrar error inmediato - dejar que continúe polling
      const fromFlow = searchParams.get('from') === 'flow';
      if (!fromFlow) {
        setError('No se pudo cargar el préstamo: ' + e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    
    // Detectar si viene de Flow (con o sin token en URL)
    const flowToken = searchParams.get('token');
    const fromFlow = searchParams.get('from') === 'flow';
    
    if (flowToken) {
      // Si hay token en URL, verificar directamente
      console.log('🔍 Detectado token de Flow en URL, iniciando verificación...');
      verifyFlowPaymentWithPolling(flowToken);
    } else if (fromFlow) {
      // Si hay parámetro ?from=flow pero sin token, iniciar verificación automática
      console.log('🔍 Detectado retorno de Flow (sin token), iniciando verificación automática...');
      verifyFlowPaymentAutomatic();
    }
  }, [id, searchParams]);

  async function verifyFlowPaymentAutomatic() {
    /**
     * Esta función se ejecuta cuando el cliente retorna de Flow sin token en URL.
     * Realiza polling para verificar si el pago se registró en la BD.
     * ROBUSTA: Continúa intentando incluso si hay errores de red.
     */
    try {
      // NO establecer loading aquí para permitir visualización de la página
      console.log('⏳ Iniciando verificación automática de pago Flow...');
      setError(''); // Limpiar errores previos
      
      // Intentar durante 10 minutos (600 segundos)
      let attempts = 0;
      const maxAttempts = 300; // 300 * 2 = 600 segundos (10 minutos)
      let pollInterval;
      
      const performPoll = async () => {
        attempts++;
        
        // Log cada 10 intentos para no saturar la consola
        if (attempts % 10 === 0 || attempts === 1) {
          console.log(`🔄 Intento ${attempts}/${maxAttempts} (${(attempts * 2).toFixed(0)} segundos)`);
        }
        
        try {
          const apiUrl = import.meta.env.VITE_API_URL;
          const jwtToken = localStorage.getItem('token');
          
          if (!jwtToken) {
            console.log('⚠️ Sin token de autenticación');
            return;
          }
          
          // Recargar datos del préstamo
          const loanData = await axios.get(`${apiUrl}/loans/${id}`, {
            headers: {
              'Authorization': `Bearer ${jwtToken}`,
            }
          });
          
          const statementData = await axios.get(`${apiUrl}/payments/loan/${id}/statement`, {
            headers: {
              'Authorization': `Bearer ${jwtToken}`,
            }
          });
          
          // Verificar si hay pagos FLOW registrados recientemente
          const recentFlowPayments = statementData.data.payments.filter(p => {
            if (p.paymentMethod !== 'FLOW') return false;
            // Verificar si fue creado en los últimos 2 minutos
            const paymentTime = new Date(p.createdAt);
            const now = new Date();
            const diffSeconds = (now - paymentTime) / 1000;
            return diffSeconds < 120; // Últimos 2 minutos
          });
          
          if (recentFlowPayments.length > 0) {
            // Pago exitoso detectado
            if (pollInterval) clearInterval(pollInterval);
            console.log('✅ Pago exitoso detectado:', recentFlowPayments[0]);
            
            // Actualizar estado
            setSuccess('¡Pago con Flow realizado exitosamente!');
            setSearchParams({});
            
            // Recargar datos
            setLoan(loanData);
            setStatement(statementData.data);
            try {
              const sessionResponse = await apiGet('/cash-sessions/current');
              setCashSession(sessionResponse.session);
            } catch (sessionErr) {
              console.error('No se pudo actualizar la sesión de caja después de Flow:', sessionErr);
            }
          }
        } catch (err) {
          if (attempts % 30 === 0) {
            console.log(`⏳ Pago aún no procesado... (${(attempts * 2).toFixed(0)}s) - ${err.message}`);
          }
        }
        
        if (attempts >= maxAttempts) {
          if (pollInterval) clearInterval(pollInterval);
          console.log('⏱️ Timeout: Se alcanzó el máximo de intentos (10 minutos)');
          setError('El tiempo de espera se agotó. Por favor, recarga la página para verificar el estado del pago.')
        }
      };
      
      // Ejecutar inmediatamente la primera verificación
      await performPoll();
      
      // Luego crear intervalo para reintentos
      pollInterval = setInterval(performPoll, 2000); // Preguntar cada 2 segundos
      
    } catch (err) {
      console.error('❌ Error iniciando verificación automática de Flow:', err);
      setError('Error verificando el pago de Flow: ' + err.message);
    }
  }

  async function verifyFlowPaymentWithPolling(token) {
    try {
      setLoading(true);
      console.log('⏳ Iniciando polling para verificar pago de Flow...');
      
      // Intentar durante 10 minutos (600 segundos)
      let attempts = 0;
      const maxAttempts = 300; // 300 * 2 = 600 segundos (10 minutos)
      
      const pollInterval = setInterval(async () => {
        attempts++;
        
        // Log cada 10 intentos para no saturar la consola
        if (attempts % 10 === 0 || attempts === 1) {
          console.log(`🔄 Intento ${attempts}/${maxAttempts} (${(attempts * 2).toFixed(0)} segundos)`);
        }
        
        try {
          const apiUrl = import.meta.env.VITE_API_URL;
          const jwtToken = localStorage.getItem('token');
          
          const response = await axios.get(`${apiUrl}/flow/payment-status?token=${token}`, {
            headers: {
              'Authorization': `Bearer ${jwtToken}`,
            }
          });
          
          const statusData = response.data;
          
          if (statusData.status.status === 2) {
            // Pago exitoso
            clearInterval(pollInterval);
            console.log('✅ Pago exitoso detectado');
            
            // Esperar un poco para que se registre en BD
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            setSuccess('¡Pago con Flow realizado exitosamente!');
            console.log('✅ Pago exitoso confirmado');
            setSearchParams({});
            
            // Recargar datos después del éxito
            await load();
            setLoading(false);
          }
        } catch (err) {
          if (attempts % 30 === 0) {
            console.log(`⏳ Pago aún no procesado... (${(attempts * 2).toFixed(0)}s)`);
          }
        }
        
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          setLoading(false);
          console.log('⏱️ Timeout: Se alcanzó el máximo de intentos (10 minutos)');
          setError('El tiempo de espera se agotó. Por favor, recarga la página para verificar el estado del pago.');
        }
      }, 2000); // Preguntar cada 2 segundos
      
    } catch (err) {
      console.error('❌ Error en polling de Flow:', err);
      setError('Error verificando el pago de Flow');
      setLoading(false);
    }
  }

  async function verifyFlowPayment(token) {
    try {
      setLoading(true);
      console.log('🔍 Verificando pago de Flow con token:', token);
      
      // Usar axios para llamar directamente al endpoint
      const apiUrl = import.meta.env.VITE_API_URL;
      const jwtToken = localStorage.getItem('token');
      
      const response = await axios.get(`${apiUrl}/flow/payment-status?token=${token}`, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
        }
      });
      
      const statusData = response.data;
      console.log('📊 Respuesta de Flow:', statusData);
      
      if (statusData.status.status === 2) {
        // Pago exitoso
        setSuccess('¡Pago con Flow realizado exitosamente!');
        console.log('✅ Pago exitoso');
        // Limpiar parámetros de URL
        setSearchParams({});
        // Recargar datos del préstamo después de un pequeño delay
        setTimeout(() => {
          load();
        }, 1000);
      } else if (statusData.status.status === 3) {
        setError('El pago con Flow fue rechazado');
        console.log('❌ Pago rechazado');
        setSearchParams({});
      } else {
        setError('El pago está pendiente');
        console.log('⏳ Pago pendiente');
        setSearchParams({});
      }
    } catch (err) {
      console.error('❌ Error verificando pago Flow:', err);
      setError('Error verificando el pago de Flow: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleOpenPaymentModal(installment) {
    console.log('handleOpenPaymentModal called', installment);
    console.log('cashSession:', cashSession);
    console.log('paymentMethod:', paymentMethod);

    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }
    
    setSelectedInstallment(installment);
    // Convertir a número y redondear a múltiplos de 0.10 para efectivo tomando el saldo pendiente
    const remaining = parseFloat(installment.remainingInstallment ?? installment.installmentAmount);
    const amount = isNaN(remaining) ? 0 : remaining;
    const initialAmount = roundCash(amount);
    setPaymentAmount(initialAmount.toFixed(2));
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

  function handlePaymentMethodChange(e) {
    const method = e.target.value;
    setPaymentMethod(method);
    if (method === 'EFECTIVO') {
      const raw = parseFloat(paymentAmount || baseInstallmentAmount || 0) || 0;
      const rounded = roundCash(raw);
      setPaymentAmount(rounded.toFixed(2));
    }
  }

  function handleOpenReceiptModal(payment) {
    setReceiptPayment(payment);
    setReceiptType('boleta');
    setInvoiceRuc('');
    setInvoiceName('');
    setInvoiceAddress('');
    setShowReceiptModal(true);
    setError('');
    setSuccess('');
  }

  function handleCloseReceiptModal() {
    setShowReceiptModal(false);
    setReceiptPayment(null);
    setReceiptType('boleta');
    setInvoiceRuc('');
    setInvoiceName('');
    setInvoiceAddress('');
  }

  async function handleLookupRuc() {
    const ruc = (invoiceRuc || '').trim();
    if (!/^[0-9]{11}$/.test(ruc)) {
      setError('Ingrese un RUC válido de 11 dígitos');
      return;
    }
    try {
      setError('');
      const data = await apiGet(`/sunat/ruc?numero=${encodeURIComponent(ruc)}`);
      setInvoiceName(data.razonSocial || '');
      setInvoiceAddress(data.direccion || '');
      setSuccess(`RUC válido: ${data.razonSocial || ''}`);
    } catch (err) {
      setError(err.message || 'No se pudo consultar el RUC');
    }
  }

  async function handleDownloadReceipt(e) {
    e.preventDefault();
    if (!receiptPayment) return;

    if (receiptType === 'factura') {
      if (!invoiceRuc || invoiceRuc.trim().length < 8) {
        setError('Ingrese un RUC válido para factura');
        return;
      }
      if (!invoiceName.trim()) {
        setError('Ingrese la Razón Social para factura');
        return;
      }
    }

    const params = new URLSearchParams();
    params.set('type', receiptType);
    if (receiptType === 'factura') {
      params.set('customerRuc', invoiceRuc.trim());
      params.set('customerName', invoiceName.trim());
      if (invoiceAddress.trim()) params.set('customerAddress', invoiceAddress.trim());
    }

    await apiDownload(
      `/payments/${receiptPayment.id}/receipt?${params.toString()}`,
      `comprobante-${receiptPayment.receiptNumber}.pdf`
    );
    handleCloseReceiptModal();
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

    const remainingBase = parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0;
    const maxAmount = remainingBase + (selectedInstallment.lateFeeAmount || 0);
    if (amount > maxAmount) {
      setError(`El monto no puede ser mayor a ${maxAmount.toFixed(2)}`);
      return;
    }

    if ((paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') && amount < 2) {
      setError('El monto mínimo para billetera digital o tarjeta débito es S/ 2.00');
      return;
    }

    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }

    // Aplicar redondeo automático para efectivo
    const finalAmount = paymentMethod === 'EFECTIVO'
      ? Number(roundCash(amount).toFixed(2))
      : amount;
    if (paymentMethod === 'EFECTIVO') {
      setPaymentAmount(finalAmount.toFixed(2));
    }

    setProcessingPayment(true);

    try {
      if (paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') {
        // Pago con Flow (billetera digital o tarjeta de débito)
        const email = 'cliente@example.com'; // Email dummy, el backend usará OWNER_EMAIL

        const flowResponse = await apiPost('/flow/create-payment', {
          loanId: parseInt(id),
          amount,
          email,
          installmentId: selectedInstallment.id,
        });

        // Redirigir a Flow
        window.location.href = flowResponse.paymentUrl;
      } else {
        // Pago con efectivo
        const paymentPayload = {
          loanId: parseInt(id),
          amount: finalAmount,
          paymentMethod,
          cashSessionId: cashSession?.id || null,
          installmentId: selectedInstallment.id,
        };

        console.log('📤 Enviando pago:', paymentPayload);
        await apiPost('/payments', paymentPayload);
        console.log('✅ Pago registrado, recargando datos...');

        setSuccess('Pago registrado exitosamente');
        
        // Esperar un momento antes de cerrar el modal para asegurar que se vea el mensaje
        await new Promise(resolve => setTimeout(resolve, 500));
        
        handleClosePaymentModal();
        
        // Recargar todos los datos
        console.log('🔄 Recargando datos del préstamo...');
        await load();
        console.log('✅ Datos recargados');
      }
    } catch (err) {
      console.error('❌ Error al procesar pago:', err);
      setError(err.message || 'Error al procesar el pago');
    } finally {
      setProcessingPayment(false);
    }
  }

  if (loading && !loan) return <div className="section">Cargando...</div>;
  
  // Si viene de Flow y aún no cargó, mostrar estado de verificación en lugar de error
  const fromFlow = searchParams.get('from') === 'flow';
  if (error && !loan) {
    if (fromFlow) {
      return <div className="section" style={{ textAlign: 'center', padding: '2rem' }}>
        <div style={{ marginBottom: '1rem' }}>
          <svg style={{ animation: 'spin 1s linear infinite', width: '40px', height: '40px' }} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="15 10" />
          </svg>
        </div>
        <p><strong>Verificando tu pago con Flow...</strong></p>
        <p style={{ fontSize: '0.9rem', color: '#666' }}>Esto puede tomar algunos segundos</p>
      </div>;
    }
    return <div className="section"><div className="badge badge-red">{error}</div></div>;
  }
  
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
    // Convertir a decimal y redondear a múltiplo de 0.10
    const remainingAmount = remainingCents / 100;
    return Number(roundCash(remainingAmount).toFixed(2));
  };

  // Saldo restante por cuota = monto de la cuota menos lo pagado a esa cuota
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
        isPaid: isPaid,
      };
    });
  })();

  const baseInstallmentAmount = selectedInstallment
    ? parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0
    : 0;
  const lateFeeForSelected = selectedInstallment ? (selectedInstallment.lateFeeAmount || 0) : 0;
  const displayInstallmentAmount = paymentMethod === 'EFECTIVO'
    ? roundCash(baseInstallmentAmount)
    : baseInstallmentAmount;
  const displayTotalToPay = displayInstallmentAmount + lateFeeForSelected;

  return (
    <div className="section">
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
                <th>Mora</th>
                <th>Estado</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              {scheduleWithRemaining.map((row) => {
                const installmentAmount = parseFloat(row.installmentAmount);
                const isPaid = row.isPaid === true;

                return (
                  <tr key={row.id}>
                    <td>{row.installmentNumber}</td>
                    <td>{formatDate(row.dueDate)}</td>
                    <td>S/ {installmentAmount.toFixed(2)}</td>
                    <td>S/ {parseFloat(row.interestAmount).toFixed(2)}</td>
                    <td>S/ {parseFloat(row.principalAmount).toFixed(2)}</td>
                    <td>S/ {parseFloat(row.remainingBalance).toFixed(2)}</td>
                    <td>S/ {Number(row.remainingInstallment || 0).toFixed(2)}</td>
                    <td>
                      {row.hasLateFee ? (
                        <span className="badge badge-red">✓</span>
                      ) : (
                        <span className="badge badge-gray">✗</span>
                      )}
                    </td>
                    <td>
                      {isPaid ? (
                        <span className="badge badge-green">Pagado</span>
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
                      onClick={() => handleOpenReceiptModal(payment)}
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
            
            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            <div style={{ padding: '1rem', backgroundColor: '#f8f9fa', borderRadius: '8px', marginBottom: '1rem' }}>
              <div><strong>Fecha de Vencimiento:</strong> {formatDate(selectedInstallment.dueDate)}</div>
              <div>
                <strong>Monto de Cuota{paymentMethod === 'EFECTIVO' ? ' (redondeado efectivo)' : ''}:</strong>{' '}
                S/ {displayInstallmentAmount.toFixed(2)}
              </div>
              <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #ddd' }}>
                <strong>Mora:</strong> S/ {(selectedInstallment.lateFeeAmount || 0).toFixed(2)}
              </div>
              <div style={{ marginTop: '0.5rem', fontWeight: 'bold', fontSize: '1.1rem', color: '#007bff' }}>
                <strong>Total a Pagar:</strong> S/ {displayTotalToPay.toFixed(2)}
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
                  max={(parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) + (selectedInstallment.lateFeeAmount || 0)).toFixed(2)}
                  min="0.01"
                  required
                  disabled={processingPayment}
                />
                <small>
                  Máximo: S/ {(
                    parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) +
                    (selectedInstallment.lateFeeAmount || 0)
                  ).toFixed(2)}
                </small>
              </div>

              <div className="form-group">
                <label htmlFor="paymentMethod">Método de Pago</label>
                <select
                  id="paymentMethod"
                  value={paymentMethod}
                  onChange={handlePaymentMethodChange}
                  required
                  disabled={processingPayment}
                >
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="BILLETERA_DIGITAL">Billetera Digital</option>
                  <option value="TARJETA_DEBITO">Tarjeta de Débito</option>
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

              {(paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') && (
                <div className="badge badge-blue" style={{ marginBottom: '1rem' }}>
                  ℹ️ Será redirigido a Flow para completar el pago
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
                  style={{ opacity: processingPayment ? 0.6 : 1, cursor: processingPayment ? 'not-allowed' : 'pointer' }}
                >
                  {processingPayment ? '⏳ Procesando...' : (paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') ? 'Ir a Flow' : 'Registrar Pago'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Comprobante */}
      {showReceiptModal && receiptPayment && (
        <div className="modal-overlay" onClick={handleCloseReceiptModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Descargar Comprobante</h3>

            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            <form onSubmit={handleDownloadReceipt}>
              <div className="form-group">
                <label>Tipo de Comprobante</label>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="radio"
                      name="receiptType"
                      value="boleta"
                      checked={receiptType === 'boleta'}
                      onChange={(e) => setReceiptType(e.target.value)}
                    />
                    Boleta
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="radio"
                      name="receiptType"
                      value="factura"
                      checked={receiptType === 'factura'}
                      onChange={(e) => setReceiptType(e.target.value)}
                    />
                    Factura
                  </label>
                </div>
              </div>

              {receiptType === 'factura' && (
                <>
                  <div className="form-group">
                    <label htmlFor="invoiceRuc">RUC</label>
                    <input
                      id="invoiceRuc"
                      value={invoiceRuc}
                      onChange={(e) => setInvoiceRuc(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginTop: '0.5rem' }}
                      onClick={handleLookupRuc}
                    >
                      Consultar RUC
                    </button>
                  </div>
                  <div className="form-group">
                    <label htmlFor="invoiceName">Razón Social</label>
                    <input
                      id="invoiceName"
                      value={invoiceName}
                      onChange={(e) => setInvoiceName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="invoiceAddress">Dirección</label>
                    <input
                      id="invoiceAddress"
                      value={invoiceAddress}
                      onChange={(e) => setInvoiceAddress(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={handleCloseReceiptModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary">
                  Descargar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
