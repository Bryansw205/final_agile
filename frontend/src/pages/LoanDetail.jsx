import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import dayjs from 'dayjs';
import { apiGet, apiPost, apiDownload, apiFileUrl } from '../lib/api.js';
import { formatDate } from '../lib/date.js';

/**
 * Redondeo para efectivo en Perú
 * Redondea al múltiplo de 0.10 más cercano
 * Ejemplos:
 *   95.51 -> 95.50
 *   95.55 -> 95.60 (redondeo de banquero: .55 -> .60 porque 5 es impar)
 *   95.54 -> 95.50
 *   95.56 -> 95.60
 */
function roundCash(amount) {
  // Redondear al múltiplo de 0.10 más cercano
  return Math.round(amount * 10) / 10;
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
  const [paymentStep, setPaymentStep] = useState(1); // 1 = seleccionar método, 2 = detalles y monto
  const [selectedInstallment, setSelectedInstallment] = useState(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [processingPayment, setProcessingPayment] = useState(false);
  const [cashSession, setCashSession] = useState(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [receiptPayment, setReceiptPayment] = useState(null);
  const [receiptType, setReceiptType] = useState('boleta');
  const [invoiceRuc, setInvoiceRuc] = useState('');
  const [invoiceName, setInvoiceName] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');
  // Estados para el modo "Adelantar Pago"
  const [advancePaymentMode, setAdvancePaymentMode] = useState(false);
  const [selectedInstallments, setSelectedInstallments] = useState(new Set());
  const [advancePaymentMethod, setAdvancePaymentMethod] = useState('');
  const [advancePaymentAmount, setAdvancePaymentAmount] = useState('');

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
        schedules: loanData.schedules.map((s, idx) => {
          const moraInfo = schedulesWithMora[idx] || {};
          return {
            ...s,
            hasLateFee: Boolean(moraInfo.hasLateFee),
            lateFeeAmount: Number(moraInfo.lateFeeAmount ?? s.lateFeeAmount ?? 0),
            remainingInstallment: moraInfo.remainingInstallment ?? s.remainingInstallment,
            pendingTotal:
              moraInfo.pendingTotal ??
              (moraInfo.remainingInstallment ?? s.remainingInstallment ?? Number(s.installmentAmount)) +
                Number(moraInfo.lateFeeAmount ?? s.lateFeeAmount ?? 0),
          };
        })
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

    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }
    
    setSelectedInstallment(installment);
    setPaymentMethod(''); // Reset para que elija
    setPaymentAmount('');
    setPaymentStep(1); // Empezar en paso 1: seleccionar método
    setShowPaymentModal(true);
    setError('');
    setSuccess('');
  }

  function handleOpenAdvancePaymentMode() {
    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }
    setAdvancePaymentMode(true);
    setSelectedInstallments(new Set());
    setAdvancePaymentMethod('');
    setAdvancePaymentAmount('');
    setError('');
    setSuccess('');
  }

  function handleCloseAdvancePaymentMode() {
    setAdvancePaymentMode(false);
    setSelectedInstallments(new Set());
    setAdvancePaymentMethod('');
    setAdvancePaymentAmount('');
  }

  function handleToggleInstallmentSelection(installmentId) {
    const newSelected = new Set(selectedInstallments);
    if (newSelected.has(installmentId)) {
      newSelected.delete(installmentId);
    } else {
      newSelected.add(installmentId);
    }
    setSelectedInstallments(newSelected);
  }

  function handleSelectAdvancePaymentMethod(method) {
    setAdvancePaymentMethod(method);
    // Calcular total de cuotas seleccionadas
    const total = scheduleWithRemaining
      .filter(s => selectedInstallments.has(s.id) && !s.isPaid)
      .reduce((sum, s) => sum + (Number(s.pendingTotal) || 0), 0);
    
    const initialAmount = method === 'EFECTIVO' ? roundCash(total) : total;
    setAdvancePaymentAmount(initialAmount.toFixed(2));
  }

  function handleSelectPaymentMethod(method) {
    setPaymentMethod(method);
    // Usar pendingTotal del backend (ya incluye cuota restante + mora si aplica)
    const total = selectedInstallment.pendingTotal !== undefined
      ? Number(selectedInstallment.pendingTotal)
      : (parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0) + (selectedInstallment.lateFeeAmount || 0);
    
    // Si es EFECTIVO, redondear el TOTAL; si no, usar el total exacto
    const initialAmount = method === 'EFECTIVO' ? roundCash(total) : total;
    setPaymentAmount(initialAmount.toFixed(2));
    setPaymentStep(2); // Ir al paso 2: detalles y monto
  }

  function handleBackToMethodSelection() {
    setPaymentStep(1);
    setPaymentMethod('');
    setPaymentAmount('');
  }

  function handleClosePaymentModal() {
    setShowPaymentModal(false);
    setSelectedInstallment(null);
    setPaymentAmount('');
    setPaymentMethod('');
    setPaymentStep(1);
  }

  function handlePaymentAmountChange(e) {
    setPaymentAmount(e.target.value);
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

    // Validar que en EFECTIVO el monto sea múltiplo de S/ 0.10
    if (paymentMethod === 'EFECTIVO') {
      const cents = Math.round(amount * 100);
      if (cents % 10 !== 0) {
        setError('En efectivo solo se aceptan múltiplos de S/ 0.10');
        return;
      }
    }

    // Validar que todas las cuotas anteriores estén pagadas (cuotas seguidas)
    const previousInstallments = scheduleWithRemaining.filter(s => s.installmentNumber < selectedInstallment.installmentNumber);
    const firstUnpaid = previousInstallments.find(s => s.isPaid !== true);
    if (firstUnpaid) {
      setError(`No puedes pagar la cuota #${selectedInstallment.installmentNumber} hasta que hayas pagado la cuota #${firstUnpaid.installmentNumber} completamente`);
      return;
    }

    const remainingBase = parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0;
    const moraBase = selectedInstallment.lateFeeAmount || 0;
    const totalBase = remainingBase + moraBase;
    // Monto máximo = total (cuota + mora), redondeado si es EFECTIVO
    const maxAllowed = paymentMethod === 'EFECTIVO' ? roundCash(totalBase) : totalBase;
    if (amount > maxAllowed) {
      setError(`El monto no puede ser mayor a S/ ${maxAllowed.toFixed(2)}`);
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

  async function handleAdvancePayment(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (selectedInstallments.size === 0) {
      setError('Seleccione al menos una cuota');
      return;
    }

    const amount = parseFloat(advancePaymentAmount);
    if (isNaN(amount) || amount <= 0) {
      setError('Ingrese un monto válido');
      return;
    }

    if (!advancePaymentMethod) {
      setError('Seleccione un método de pago');
      return;
    }

    // Validar que en EFECTIVO el monto sea múltiplo de S/ 0.10
    if (advancePaymentMethod === 'EFECTIVO') {
      const cents = Math.round(amount * 100);
      if (cents % 10 !== 0) {
        setError('En efectivo solo se aceptan múltiplos de S/ 0.10');
        return;
      }
    }

    if ((advancePaymentMethod === 'BILLETERA_DIGITAL' || advancePaymentMethod === 'TARJETA_DEBITO') && amount < 2) {
      setError('El monto mínimo para billetera digital o tarjeta débito es S/ 2.00');
      return;
    }

    if (!cashSession) {
      setError('Debe abrir una sesión de caja antes de registrar pagos');
      return;
    }

    // Aplicar redondeo automático para efectivo
    const finalAmount = advancePaymentMethod === 'EFECTIVO'
      ? Number(roundCash(amount).toFixed(2))
      : amount;

    setProcessingPayment(true);

    try {
      if (advancePaymentMethod === 'BILLETERA_DIGITAL' || advancePaymentMethod === 'TARJETA_DEBITO') {
        // Pago adelantado con Flow
        const installmentIds = Array.from(selectedInstallments);
        const flowResponse = await apiPost('/flow/create-advance-payment', {
          loanId: parseInt(id),
          amount,
          email: 'cliente@example.com',
          installmentIds,
        });
        window.location.href = flowResponse.paymentUrl;
      } else {
        // Pago adelantado con efectivo
        const installmentIds = Array.from(selectedInstallments);
        const paymentPayload = {
          loanId: parseInt(id),
          amount: finalAmount,
          paymentMethod: advancePaymentMethod,
          cashSessionId: cashSession?.id || null,
          installmentIds,
        };

        console.log('📤 Enviando pago adelantado:', paymentPayload);
        const response = await apiPost('/payments/advance', paymentPayload);
        console.log('✅ Pago adelantado registrado:', response);

        setSuccess('¡Pago adelantado registrado exitosamente!');
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        handleCloseAdvancePaymentMode();
        
        console.log('🔄 Recargando datos del préstamo...');
        await load();
        console.log('✅ Datos recargados');
      }
    } catch (err) {
      console.error('❌ Error al procesar pago adelantado:', err);
      setError(err.message || 'Error al procesar el pago adelantado');
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
  
  // Calcula el saldo restante ORIGINAL (sin redondear)
  const remainingForInstallmentOriginal = (amount, paid) => {
    const remainingCents = Math.max(0, toCents(amount) - toCents(paid));
    return remainingCents / 100;
  };
  
  const normalizeAmount = (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback;

  const scheduleWithRemaining = (() => {
    if (!loan?.schedules) return [];
    return loan.schedules.map((row) => {
      const baseRemaining =
        row.remainingInstallment !== undefined && row.remainingInstallment !== null
          ? normalizeAmount(row.remainingInstallment)
          : remainingForInstallmentOriginal(row.installmentAmount, 0);
      const pendingTotal =
        row.pendingTotal !== undefined && row.pendingTotal !== null
          ? normalizeAmount(row.pendingTotal)
          : baseRemaining + normalizeAmount(row.lateFeeAmount);
      return {
        ...row,
        remainingInstallment: Number(baseRemaining.toFixed(2)),
        pendingTotal: Number(pendingTotal.toFixed(2)),
        isPaid: row.isPaid === true,
      };
    });
  })();

  const baseInstallmentAmount = selectedInstallment
    ? parseFloat(selectedInstallment.remainingInstallment ?? selectedInstallment.installmentAmount) || 0
    : 0;
  const lateFeeForSelected = selectedInstallment ? (selectedInstallment.lateFeeAmount || 0) : 0;
  
  // Saldo pendiente = pendingTotal del backend (ya incluye cuota restante + mora si aplica)
  // Si no hay pendingTotal, calcular manualmente
  const rawTotal = selectedInstallment?.pendingTotal !== undefined
    ? Number(selectedInstallment.pendingTotal)
    : (baseInstallmentAmount + lateFeeForSelected);
  
  // Si EFECTIVO: redondear el TOTAL
  // Si otros métodos: total exacto sin redondear
  const displayTotalToPay = paymentMethod === 'EFECTIVO'
    ? roundCash(rawTotal)
    : rawTotal;
  
  // Monto máximo = total a pagar (ya redondeado si es efectivo)
  const maxPaymentAmount = displayTotalToPay;

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
                const remainingInstallment = row.remainingInstallment !== undefined
                  ? Number(row.remainingInstallment)
                  : Math.max(
                      0,
                      (row.pendingTotal !== undefined
                        ? Number(row.pendingTotal)
                        : Number(row.installmentAmount || 0)) - Number(row.lateFeeAmount || 0)
                    );
                const pendingTotal = row.pendingTotal !== undefined
                  ? Number(row.pendingTotal)
                  : (remainingInstallment + (row.lateFeeAmount || 0));

                return (
                  <tr key={row.id}>
                    <td>{row.installmentNumber}</td>
                    <td>{formatDate(row.dueDate)}</td>
                    <td>S/ {installmentAmount.toFixed(2)}</td>
                    <td>S/ {parseFloat(row.interestAmount).toFixed(2)}</td>
                    <td>S/ {parseFloat(row.principalAmount).toFixed(2)}</td>
                    <td>S/ {parseFloat(row.remainingBalance).toFixed(2)}</td>
                    <td>S/ {pendingTotal.toFixed(2)}</td>
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
                          disabled={processingPayment || !cashSession || (() => {
                            const previousInstallments = scheduleWithRemaining.filter(s => s.installmentNumber < row.installmentNumber);
                            return previousInstallments.some(s => s.isPaid !== true);
                          })()}
                          title={(() => {
                            const previousInstallments = scheduleWithRemaining.filter(s => s.installmentNumber < row.installmentNumber);
                            const firstUnpaid = previousInstallments.find(s => s.isPaid !== true);
                            return firstUnpaid ? `Debes pagar la cuota #${firstUnpaid.installmentNumber} primero` : '';
                          })()}
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
        {/* Botón "Adelantar Pago" en la parte inferior derecha */}
        <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn btn-primary"
            onClick={handleOpenAdvancePaymentMode}
            disabled={processingPayment || !cashSession || scheduleWithRemaining.every(s => s.isPaid)}
            title={!cashSession ? 'Abre una sesión de caja primero' : scheduleWithRemaining.every(s => s.isPaid) ? 'Todas las cuotas están pagadas' : 'Pagar múltiples cuotas a la vez'}
          >
            ⏩ Adelantar Pago
          </button>
        </div>
      </div>

      {statement?.payments && statement.payments.length > 0 && (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h4 style={{ marginTop: 0 }}>Historial de Pagos</h4>
          <table className="table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
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
              {statement.payments.map((payment) => {
                // Detectar si es pago adelantado
                const isAdvancePayment = !payment.installmentId || (payment.externalReference && payment.externalReference.includes('ADVANCE'));
                return (
                  <tr key={payment.id} style={{ backgroundColor: isAdvancePayment ? '#f0f7ff' : 'transparent' }}>
                    <td>{new Date(payment.paymentDate).toLocaleString('es-PE')}</td>
                    <td>
                      {isAdvancePayment && (
                        <span style={{ backgroundColor: '#667eea', color: 'white', padding: '0.3rem 0.6rem', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 'bold' }}>
                          ⏩ ADELANTADO
                        </span>
                      )}
                      {!isAdvancePayment && (
                        <span style={{ backgroundColor: '#28a745', color: 'white', padding: '0.3rem 0.6rem', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 'bold' }}>
                          ✓ NORMAL
                        </span>
                      )}
                    </td>
                    <td><strong>S/ {payment.amount.toFixed(2)}</strong></td>
                    <td>{payment.paymentMethod}</td>
                    <td>S/ {payment.principalPaid.toFixed(2)}</td>
                    <td>S/ {payment.interestPaid.toFixed(2)}</td>
                    <td>S/ {payment.lateFeePaid.toFixed(2)}</td>
                    <td><code style={{ fontSize: '0.85rem' }}>{payment.receiptNumber}</code></td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => handleOpenReceiptModal(payment)}
                        title={isAdvancePayment ? 'Ver comprobante con detalle de cuotas pagadas' : 'Descargar comprobante'}
                      >
                        {isAdvancePayment ? '📋 Ver' : 'Descargar'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal de Pago - Paso 1: Seleccionar Método */}
      {showPaymentModal && selectedInstallment && paymentStep === 1 && (
        <div className="modal-overlay" onClick={handleClosePaymentModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Seleccionar Método de Pago</h3>
            <p style={{ color: '#666', marginBottom: '1.5rem' }}>
              Cuota #{selectedInstallment.installmentNumber} - Vencimiento: {formatDate(selectedInstallment.dueDate)}
            </p>
            
            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <button
                className="btn"
                style={{ 
                  padding: '1rem', 
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onClick={() => handleSelectPaymentMethod('EFECTIVO')}
              >
                💵 Efectivo
              </button>
              <button
                className="btn"
                style={{ 
                  padding: '1rem', 
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onClick={() => handleSelectPaymentMethod('BILLETERA_DIGITAL')}
              >
                📱 Billetera Digital (Yape, Plin, etc.)
              </button>
              <button
                className="btn"
                style={{ 
                  padding: '1rem', 
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onClick={() => handleSelectPaymentMethod('TARJETA_DEBITO')}
              >
                💳 Tarjeta de Débito
              </button>
            </div>

            <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
              <button
                type="button"
                className="btn"
                onClick={handleClosePaymentModal}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Pago - Paso 2: Detalles y Monto */}
      {showPaymentModal && selectedInstallment && paymentStep === 2 && (
        <div className="modal-overlay" onClick={handleClosePaymentModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>
              Pagar Cuota #{selectedInstallment.installmentNumber}
              <span style={{ fontSize: '0.9rem', fontWeight: 'normal', marginLeft: '0.5rem', color: '#666' }}>
                ({paymentMethod === 'EFECTIVO' ? '💵 Efectivo' : paymentMethod === 'BILLETERA_DIGITAL' ? '📱 Billetera Digital' : '💳 Tarjeta'})
              </span>
            </h3>
            
            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            <div style={{ padding: '1rem', backgroundColor: '#f8f9fa', borderRadius: '8px', marginBottom: '1rem' }}>
              <div><strong>Fecha de Vencimiento:</strong> {formatDate(selectedInstallment.dueDate)}</div>
              <div>
                <strong>Saldo pendiente:</strong>{' '}
                S/ {rawTotal.toFixed(2)}
                {lateFeeForSelected > 0 && ' (incluye mora)'}
              </div>
              {lateFeeForSelected > 0 && (
                <div style={{ marginTop: '0.5rem', color: '#dc3545' }}>
                  <strong>Mora (1% fijo):</strong> S/ {lateFeeForSelected.toFixed(2)}
                  <br />
                  <small style={{ color: '#666' }}>* Si pagas parcialmente, la mora se cancela</small>
                </div>
              )}
              <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #ddd', fontWeight: 'bold', fontSize: '1.1rem', color: '#007bff' }}>
                <strong>Total a Pagar:</strong> S/ {displayTotalToPay.toFixed(2)}
                {paymentMethod === 'EFECTIVO' && rawTotal !== displayTotalToPay && ' (redondeado)'}
              </div>
            </div>

            <form onSubmit={handlePayment}>
              <div className="form-group">
                <label htmlFor="paymentAmount">Monto a Pagar (S/)</label>
                <input
                  type="number"
                  id="paymentAmount"
                  value={paymentAmount}
                  onChange={handlePaymentAmountChange}
                  step="any"
                  max={maxPaymentAmount.toFixed(2)}
                  min="0.01"
                  required
                  disabled={processingPayment}
                />
                <small>
                  Máximo: S/ {maxPaymentAmount.toFixed(2)}
                  {paymentMethod === 'EFECTIVO' && ' (solo múltiplos de S/ 0.10)'}
                </small>
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
                  ℹ️ Será redirigido a Flow para completar el pago (monto exacto sin redondear)
                </div>
              )}

              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleBackToMethodSelection}
                  disabled={processingPayment}
                >
                  ← Cambiar método
                </button>
                <div style={{ display: 'flex', gap: '1rem' }}>
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
                    {processingPayment ? '⏳ Procesando...' : (paymentMethod === 'BILLETERA_DIGITAL' || paymentMethod === 'TARJETA_DEBITO') ? 'Ir a Flow →' : 'Registrar Pago'}
                  </button>
                </div>
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

      {/* Modal de Adelanto de Pago - Seleccionar Cuotas */}
      {advancePaymentMode && !advancePaymentMethod && (
        <div className="modal-overlay" onClick={handleCloseAdvancePaymentMode}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
              <span style={{ fontSize: '2rem' }}>⏩</span>
              <div>
                <h3 style={{ marginTop: 0, marginBottom: 0 }}>Adelantar Pago de Cuotas</h3>
                <p style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.25rem', marginBottom: 0 }}>Selecciona cuotas por orden de prioridad</p>
              </div>
            </div>

            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            {/* Tarjetas de cuotas pendientes ordenadas por número */}
            <div style={{ marginBottom: '1.5rem' }}>
              {scheduleWithRemaining.filter(s => !s.isPaid).length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#999', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
                  <p style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>✓ Todas las cuotas están pagadas</p>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem', maxHeight: '500px', overflowY: 'auto' }}>
                  {scheduleWithRemaining
                    .filter(s => !s.isPaid)
                    .sort((a, b) => a.installmentNumber - b.installmentNumber)
                    .map((installment) => {
                      const isSelected = selectedInstallments.has(installment.id);
                      const hasLateFee = installment.lateFeeAmount > 0;
                      const daysOverdue = dayjs().diff(dayjs(installment.dueDate), 'day');
                      const isOverdue = daysOverdue > 0;

                      return (
                        <label
                          key={installment.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '1rem',
                            padding: '1rem',
                            backgroundColor: isSelected ? '#e3f2fd' : 'white',
                            borderRadius: '8px',
                            border: isSelected ? '2px solid #007bff' : '1px solid #ddd',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease',
                            boxShadow: isSelected ? '0 2px 8px rgba(0, 123, 255, 0.2)' : 'none'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleInstallmentSelection(installment.id)}
                            style={{ cursor: 'pointer', transform: 'scale(1.2)' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              <strong style={{ fontSize: '1.1rem' }}>Cuota #{installment.installmentNumber}</strong>
                              {isOverdue && (
                                <span style={{ backgroundColor: '#ff6b6b', color: 'white', padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                                  {daysOverdue}d VENCIDA
                                </span>
                              )}
                              {hasLateFee && (
                                <span style={{ backgroundColor: '#ffc107', color: '#333', padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                                  ⚠️ MORA
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem' }}>
                              Vencimiento: <strong>{formatDate(installment.dueDate)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.95rem' }}>
                              <span>Pendiente:</span>
                              <strong style={{ color: '#007bff', fontSize: '1.1rem' }}>
                                S/ {Number(installment.pendingTotal || installment.installmentAmount).toFixed(2)}
                              </strong>
                            </div>
                            {hasLateFee && (
                              <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #eee', fontSize: '0.85rem', color: '#d32f2f' }}>
                                Mora: <strong>S/ {Number(installment.lateFeeAmount).toFixed(2)}</strong>
                              </div>
                            )}
                          </div>
                        </label>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Resumen de selección */}
            {selectedInstallments.size > 0 && (
              <div style={{
                padding: '1.25rem',
                backgroundColor: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                backgroundImage: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                borderRadius: '8px',
                marginBottom: '1.5rem',
                color: 'white',
                boxShadow: '0 4px 12px rgba(102, 126, 234, 0.3)'
              }}>
                <div style={{ marginBottom: '0.75rem', fontSize: '0.95rem', opacity: 0.95 }}>
                  Cuotas seleccionadas: <strong>{selectedInstallments.size}</strong>
                </div>
                <div style={{ fontSize: '1.4rem', fontWeight: 'bold' }}>
                  Total: S/ {scheduleWithRemaining
                    .filter(s => selectedInstallments.has(s.id))
                    .reduce((sum, s) => sum + (Number(s.pendingTotal) || 0), 0)
                    .toFixed(2)}
                </div>
              </div>
            )}

            {/* Botones de acción */}
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn"
                onClick={handleCloseAdvancePaymentMode}
                disabled={processingPayment}
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (selectedInstallments.size === 0) {
                    setError('Selecciona al menos una cuota');
                    return;
                  }
                  setAdvancePaymentMethod('pending');
                }}
                disabled={processingPayment || selectedInstallments.size === 0}
                style={{ fontSize: '1rem', padding: '0.75rem 1.5rem' }}
              >
                Continuar → ({selectedInstallments.size} cuota{selectedInstallments.size > 1 ? 's' : ''})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Adelanto de Pago - Seleccionar Método y Monto */}
      {advancePaymentMode && advancePaymentMethod === 'pending' && (
        <div className="modal-overlay" onClick={handleCloseAdvancePaymentMode}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Adelantar Pago - Seleccionar Método</h3>
            <p style={{ color: '#666', marginBottom: '1.5rem' }}>
              Selecciona un método de pago para {selectedInstallments.size} cuota{selectedInstallments.size > 1 ? 's' : ''}
            </p>

            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}>
              <button
                className="btn"
                style={{
                  padding: '1rem',
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onClick={() => handleSelectAdvancePaymentMethod('EFECTIVO')}
              >
                💵 Efectivo
              </button>
              <button
                className="btn"
                style={{
                  padding: '1rem',
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onClick={() => handleSelectAdvancePaymentMethod('BILLETERA_DIGITAL')}
              >
                📱 Billetera Digital (Yape, Plin, etc.)
              </button>
              <button
                className="btn"
                style={{
                  padding: '1rem',
                  fontSize: '1.1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
                onClick={() => handleSelectAdvancePaymentMethod('TARJETA_DEBITO')}
              >
                💳 Tarjeta de Débito
              </button>
            </div>

            <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setAdvancePaymentMethod('');
                  setAdvancePaymentAmount('');
                }}
              >
                ← Volver
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Adelanto de Pago - Confirmar Monto */}
      {advancePaymentMode && advancePaymentMethod && advancePaymentMethod !== 'pending' && (
        <div className="modal-overlay" onClick={handleCloseAdvancePaymentMode}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>
              Adelantar Pago
              <span style={{ fontSize: '0.9rem', fontWeight: 'normal', marginLeft: '0.5rem', color: '#666' }}>
                ({advancePaymentMethod === 'EFECTIVO' ? '💵 Efectivo' : advancePaymentMethod === 'BILLETERA_DIGITAL' ? '📱 Billetera Digital' : '💳 Tarjeta'})
              </span>
            </h3>

            {error && (
              <div className="badge badge-red" style={{ marginBottom: '0.75rem' }}>
                {error}
              </div>
            )}

            <div style={{ padding: '1rem', backgroundColor: '#f8f9fa', borderRadius: '8px', marginBottom: '1rem' }}>
              <div style={{ marginBottom: '1rem' }}>
                <strong>Cuotas seleccionadas ({selectedInstallments.size}):</strong>
              </div>
              <div style={{ maxHeight: '200px', overflowY: 'auto', marginBottom: '1rem' }}>
                {scheduleWithRemaining
                  .filter(s => selectedInstallments.has(s.id))
                  .map(s => (
                    <div key={s.id} style={{ padding: '0.5rem', backgroundColor: 'white', marginBottom: '0.5rem', borderRadius: '4px', fontSize: '0.9rem', display: 'flex', justifyContent: 'space-between' }}>
                      <span>Cuota #{s.installmentNumber}</span>
                      <strong>S/ {Number(s.pendingTotal || s.installmentAmount).toFixed(2)}</strong>
                    </div>
                  ))}
              </div>
              <div style={{ paddingTop: '1rem', borderTop: '1px solid #ddd', fontWeight: 'bold', fontSize: '1.1rem', color: '#007bff' }}>
                <strong>Total a Pagar:</strong> S/ {scheduleWithRemaining
                  .filter(s => selectedInstallments.has(s.id))
                  .reduce((sum, s) => sum + (Number(s.pendingTotal) || 0), 0)
                  .toFixed(2)}
                {advancePaymentMethod === 'EFECTIVO' && ' (se redondeará según normas)'}
              </div>
            </div>

            <form onSubmit={handleAdvancePayment}>
              <div className="form-group">
                <label htmlFor="advancePaymentAmount">Monto a Pagar (S/)</label>
                <input
                  type="number"
                  id="advancePaymentAmount"
                  value={advancePaymentAmount}
                  onChange={(e) => setAdvancePaymentAmount(e.target.value)}
                  step="any"
                  min="0.01"
                  required
                  disabled={processingPayment}
                />
                <small>
                  ℹ️ El monto se calcula automáticamente basado en el total adeudado de las cuotas seleccionadas.
                  {advancePaymentMethod === 'EFECTIVO' && ' Se aplicará redondeo según normas peruanas.'}
                </small>
              </div>

              {advancePaymentMethod === 'EFECTIVO' && (
                <div className="badge badge-blue" style={{ marginBottom: '1rem' }}>
                  ℹ️ Se aplicará redondeo automático según normas peruanas
                </div>
              )}

              {(advancePaymentMethod === 'BILLETERA_DIGITAL' || advancePaymentMethod === 'TARJETA_DEBITO') && (
                <div className="badge badge-blue" style={{ marginBottom: '1rem' }}>
                  ℹ️ Será redirigido a Flow para completar el pago
                </div>
              )}

              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setAdvancePaymentMethod('pending')}
                  disabled={processingPayment}
                >
                  ← Cambiar método
                </button>
                <div style={{ display: 'flex', gap: '1rem' }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleCloseAdvancePaymentMode}
                    disabled={processingPayment}
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={processingPayment}
                    style={{ opacity: processingPayment ? 0.6 : 1, cursor: processingPayment ? 'not-allowed' : 'pointer' }}
                  >
                    {processingPayment ? '⏳ Procesando...' : (advancePaymentMethod === 'BILLETERA_DIGITAL' || advancePaymentMethod === 'TARJETA_DEBITO') ? 'Ir a Flow →' : 'Registrar Pago'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
