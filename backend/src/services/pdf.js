import PDFDocument from 'pdfkit';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);
const TZ = 'America/Lima';

// Escribe el contenido del PDF en un documento existente (no hace pipe ni end)
export function buildSchedulePdf(doc, { client, loan, schedule, payments }) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // ~515 para A4 con margen 40

  const paidByInstallment = new Map();
  (payments || []).forEach((p) => {
    if (!p.installmentId) return;
    const paidPortion = Number(p.principalPaid || 0) + Number(p.interestPaid || 0);
    paidByInstallment.set(
      p.installmentId,
      (paidByInstallment.get(p.installmentId) || 0) + paidPortion
    );
  });

  const scheduleWithRemaining = (() => {
    if (!schedule) return [];
    return schedule.map((row) => {
      const paid = paidByInstallment.get(row.id) || 0;
      const remainingInstallment = Math.max(0, Number(row.installmentAmount || 0) - paid);
      return {
        ...row,
        remainingInstallment: Number(remainingInstallment.toFixed(2))
      };
    });
  })();

  doc.fontSize(16).text('Cronograma de Pagos', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10);
  doc.text(`Cliente: ${client.firstName} ${client.lastName} (DNI: ${client.dni})`, { width: contentWidth });
  doc.text(`Préstamo: Monto ${formatCurrency(loan.principal)} | Tasa anual ${(Number(loan.interestRate) * 100).toFixed(2)}% | Plazo ${loan.termCount} meses`, { width: contentWidth });
  const totalToPay = schedule.reduce((a, r) => a + Number(r.installmentAmount || 0), 0);
  doc.text(`Total a pagar: ${formatCurrency(totalToPay)}`, { width: contentWidth });
  doc.text(`Fecha de inicio: ${formatDate(loan.startDate)}`, { width: contentWidth });
  doc.moveDown(0.5);

  // Definir columnas con anchos que sumen contentWidth
  const columns = [
    { key: 'n', title: 'Cuota', width: 50, align: 'left' },
    { key: 'fecha', title: 'Fecha', width: 85, align: 'left' },
    { key: 'cuota', title: 'Cuota (S/)', width: 90, align: 'right' },
    { key: 'interes', title: 'Interés', width: 80, align: 'right' },
    { key: 'capital', title: 'Capital', width: 80, align: 'right' },
    { key: 'saldo', title: 'Saldo', width: 70, align: 'right' },
    { key: 'saldoRestante', title: 'Saldo restante', width: contentWidth - (50 + 85 + 90 + 80 + 80 + 70), align: 'right' },
  ];

  const rowHeight = 18;
  const startX = doc.page.margins.left;
  let y = doc.y + 6;

  const drawHeader = () => {
    doc.font('Helvetica-Bold');
    let x = startX;
    columns.forEach(col => {
      doc.text(col.title, x, y, { width: col.width, align: col.align });
      x += col.width;
    });
    y += rowHeight - 6;
    doc.moveTo(startX, y).lineTo(startX + contentWidth, y).stroke();
    y += 6;
    doc.font('Helvetica');
  };

  const drawRow = (r) => {
    let x = startX;
    const cells = [
      { key: 'n', value: String(r.installmentNumber) },
      { key: 'fecha', value: formatDate(r.dueDate) },
      { key: 'cuota', value: formatCurrency(r.installmentAmount) },
      { key: 'interes', value: formatCurrency(r.interestAmount) },
      { key: 'capital', value: formatCurrency(r.principalAmount) },
      { key: 'saldo', value: formatCurrency(r.remainingBalance) },
      { key: 'saldoRestante', value: formatCurrency(r.remainingInstallment) },
    ];
    cells.forEach((cell, idx) => {
      const col = columns[idx];
      doc.text(cell.value, x, y, { width: col.width, align: col.align });
      x += col.width;
    });
    y += rowHeight;
  };

  const bottomY = doc.page.height - doc.page.margins.bottom;
  drawHeader();
  for (const row of scheduleWithRemaining) {
    if (y + rowHeight > bottomY) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
    }
    drawRow(row);
  }
}

export function createPdfDocument() {
  return new PDFDocument({ size: 'A4', margin: 40 });
}

function formatCurrency(n) {
  const num = typeof n === 'number' ? n : Number(n);
  return `S/ ${num.toFixed(2)}`;
}

function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

function formatDateTime(d) {
  const date = dayjs.tz(d, TZ);
  return date.format('DD/MM/YYYY HH:mm:ss');
}

/**
 * Genera un comprobante de pago en PDF
 */
export function buildPaymentReceipt(doc, payment) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const client = payment.loan.client;
  const loan = payment.loan;

  // Encabezado del negocio
  doc.fontSize(18).font('Helvetica-Bold').text('COMPROBANTE DE PAGO', { align: 'center' });
  doc.fontSize(10).font('Helvetica');
  doc.moveDown(0.5);
  doc.text('Sistema de Préstamos', { align: 'center' });
  doc.text('RUC: 20123456789', { align: 'center' }); // Reemplazar con RUC real
  doc.text('Dirección: Lima, Perú', { align: 'center' }); // Reemplazar con dirección real
  doc.moveDown();

  // Línea divisora
  doc.moveTo(doc.page.margins.left, doc.y)
     .lineTo(doc.page.width - doc.page.margins.right, doc.y)
     .stroke();
  doc.moveDown();

  // Información del comprobante
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(`N° de Recibo: ${payment.receiptNumber}`, { width: contentWidth });
  doc.font('Helvetica').fontSize(10);
  doc.text(`Fecha y Hora: ${formatDateTime(payment.paymentDate)}`, { width: contentWidth });
  doc.moveDown();

  // Información del cliente
  doc.font('Helvetica-Bold').fontSize(11).text('DATOS DEL CLIENTE', { width: contentWidth });
  doc.font('Helvetica').fontSize(10);
  doc.text(`Cliente: ${client.firstName} ${client.lastName}`, { width: contentWidth });
  doc.text(`DNI: ${client.dni}`, { width: contentWidth });
  if (client.email) {
    doc.text(`Email: ${client.email}`, { width: contentWidth });
  }
  if (client.phone) {
    doc.text(`Teléfono: ${client.phone}`, { width: contentWidth });
  }
  doc.moveDown();

  // Información del préstamo
  doc.font('Helvetica-Bold').fontSize(11).text('DATOS DEL PRÉSTAMO', { width: contentWidth });
  doc.font('Helvetica').fontSize(10);
  doc.text(`ID Préstamo: #${loan.id}`, { width: contentWidth });
  doc.text(`Monto Principal: ${formatCurrency(loan.principal)}`, { width: contentWidth });
  doc.text(`Tasa de Interés: ${(Number(loan.interestRate) * 100).toFixed(2)}% anual`, { width: contentWidth });
  doc.moveDown();

  // Desglose del pago
  doc.font('Helvetica-Bold').fontSize(11).text('DESGLOSE DEL PAGO', { width: contentWidth });
  doc.font('Helvetica').fontSize(10);
  
  const startY = doc.y;
  const lineHeight = 15;
  
  // Columna izquierda
  let y = startY;
  doc.text('Capital:', doc.page.margins.left, y);
  y += lineHeight;
  doc.text('Interés:', doc.page.margins.left, y);
  y += lineHeight;
  if (Number(payment.lateFeePaid) > 0) {
    doc.text('Mora:', doc.page.margins.left, y);
    y += lineHeight;
  }
  if (Number(payment.roundingAdjustment) !== 0) {
    doc.text('Redondeo:', doc.page.margins.left, y);
    y += lineHeight;
  }
  
  doc.moveTo(doc.page.margins.left, y)
     .lineTo(doc.page.width - doc.page.margins.right, y)
     .stroke();
  y += 5;
  doc.font('Helvetica-Bold').text('TOTAL PAGADO:', doc.page.margins.left, y);

  // Columna derecha (montos)
  y = startY;
  const rightX = doc.page.width - doc.page.margins.right - 100;
  doc.font('Helvetica');
  doc.text(formatCurrency(payment.principalPaid), rightX, y, { width: 100, align: 'right' });
  y += lineHeight;
  doc.text(formatCurrency(payment.interestPaid), rightX, y, { width: 100, align: 'right' });
  y += lineHeight;
  if (Number(payment.lateFeePaid) > 0) {
    doc.text(formatCurrency(payment.lateFeePaid), rightX, y, { width: 100, align: 'right' });
    y += lineHeight;
  }
  if (Number(payment.roundingAdjustment) !== 0) {
    const adjustment = Number(payment.roundingAdjustment);
    doc.text(adjustment >= 0 ? `+${formatCurrency(adjustment)}` : formatCurrency(adjustment), rightX, y, { width: 100, align: 'right' });
    y += lineHeight;
  }
  
  y += 5;
  doc.font('Helvetica-Bold').fontSize(12);
  doc.text(formatCurrency(payment.amount), rightX, y, { width: 100, align: 'right' });
  
  doc.font('Helvetica').fontSize(10);
  doc.moveDown(2);

  // Método de pago
  const paymentMethodNames = {
    EFECTIVO: 'Efectivo',
    TARJETA: 'Tarjeta',
    YAPE: 'Yape',
    PLIN: 'Plin',
    FLOW: 'Flow',
    OTRO: 'Otro',
  };
  doc.text(`Método de Pago: ${paymentMethodNames[payment.paymentMethod] || payment.paymentMethod}`, { width: contentWidth });
  
  if (payment.externalReference) {
    doc.text(`Referencia: ${payment.externalReference}`, { width: contentWidth });
  }
  
  doc.moveDown();
  doc.text(`Registrado por: ${payment.registeredBy.username}`, { width: contentWidth });
  
  doc.moveDown(2);
  
  // Línea divisora
  doc.moveTo(doc.page.margins.left, doc.y)
     .lineTo(doc.page.width - doc.page.margins.right, doc.y)
     .stroke();
  doc.moveDown();
  
  // Pie de página
  doc.fontSize(8).text('Gracias por su pago', { align: 'center' });
  doc.text('Conserve este comprobante para cualquier reclamo', { align: 'center' });
}

/**
 * Genera un reporte de cierre de caja en PDF
 */
export function buildCashSessionReport(doc, session) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  
  // Encabezado
  doc.fontSize(18).font('Helvetica-Bold').text('REPORTE DE CIERRE DE CAJA', { align: 'center' });
  doc.fontSize(10).font('Helvetica');
  doc.moveDown();
  
  // Información de la sesión
  doc.font('Helvetica-Bold').fontSize(11).text('INFORMACIÓN DE LA SESIÓN');
  doc.font('Helvetica').fontSize(10);
  doc.text(`Usuario: ${session.user.username}`);
  doc.text(`Apertura: ${formatDateTime(session.openedAt)}`);
  if (session.closedAt) {
    doc.text(`Cierre: ${formatDateTime(session.closedAt)}`);
  }
  doc.moveDown();
  
  // Resumen financiero
  doc.font('Helvetica-Bold').fontSize(11).text('RESUMEN FINANCIERO');
  doc.font('Helvetica').fontSize(10);
  
  const startY = doc.y;
  const lineHeight = 15;
  let y = startY;
  
  // Columna izquierda
  doc.text('Saldo Inicial:', doc.page.margins.left, y);
  y += lineHeight;
  doc.text('Total Recaudado:', doc.page.margins.left, y);
  y += lineHeight;
  doc.text('Saldo Esperado:', doc.page.margins.left, y);
  y += lineHeight;
  if (session.physicalBalance !== null) {
    doc.text('Saldo Físico:', doc.page.margins.left, y);
    y += lineHeight;
    doc.font('Helvetica-Bold');
    doc.text('Diferencia:', doc.page.margins.left, y);
    doc.font('Helvetica');
  }
  
  // Columna derecha (montos)
  y = startY;
  const rightX = doc.page.width - doc.page.margins.right - 100;
  doc.text(formatCurrency(session.openingBalance), rightX, y, { width: 100, align: 'right' });
  y += lineHeight;
  
  const totalRecaudado = session.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  doc.text(formatCurrency(totalRecaudado), rightX, y, { width: 100, align: 'right' });
  y += lineHeight;
  doc.text(formatCurrency(session.closingBalance || 0), rightX, y, { width: 100, align: 'right' });
  y += lineHeight;
  
  if (session.physicalBalance !== null) {
    doc.text(formatCurrency(session.physicalBalance), rightX, y, { width: 100, align: 'right' });
    y += lineHeight;
    doc.font('Helvetica-Bold');
    const difference = Number(session.difference || 0);
    const diffColor = difference === 0 ? 'black' : (difference > 0 ? 'green' : 'red');
    doc.fillColor(diffColor);
    doc.text(formatCurrency(difference), rightX, y, { width: 100, align: 'right' });
    doc.fillColor('black');
    doc.font('Helvetica');
  }
  
  doc.moveDown(2);
  
  // Desglose por método de pago
  if (session.summary?.paymentsByMethod) {
    doc.font('Helvetica-Bold').fontSize(11).text('DESGLOSE POR MÉTODO DE PAGO');
    doc.font('Helvetica').fontSize(10);
    
    const methods = Object.keys(session.summary.paymentsByMethod);
    methods.forEach(method => {
      const data = session.summary.paymentsByMethod[method];
      doc.text(`${method}: ${data.count} pagos - ${formatCurrency(data.total)}`);
    });
    
    doc.moveDown();
  }
  
  // Lista de pagos
  if (session.payments && session.payments.length > 0) {
    doc.font('Helvetica-Bold').fontSize(11).text('DETALLE DE PAGOS');
    doc.font('Helvetica').fontSize(9);
    doc.moveDown(0.5);
    
    // Encabezado de tabla
    const columns = [
      { key: 'hora', title: 'Hora', width: 60 },
      { key: 'cliente', title: 'Cliente', width: 120 },
      { key: 'metodo', title: 'Método', width: 60 },
      { key: 'monto', title: 'Monto', width: 80, align: 'right' },
      { key: 'recibo', title: 'N° Recibo', width: contentWidth - 320 },
    ];
    
    const rowHeight = 15;
    let tableY = doc.y;
    
    // Dibujar encabezado
    doc.font('Helvetica-Bold');
    let x = doc.page.margins.left;
    columns.forEach(col => {
      doc.text(col.title, x, tableY, { width: col.width, align: col.align || 'left' });
      x += col.width;
    });
    tableY += rowHeight;
    doc.moveTo(doc.page.margins.left, tableY).lineTo(doc.page.width - doc.page.margins.right, tableY).stroke();
    tableY += 5;
    
    // Dibujar filas
    doc.font('Helvetica');
    for (const payment of session.payments) {
      // Verificar espacio en la página
      if (tableY + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        tableY = doc.page.margins.top;
        
        // Redibujar encabezado
        doc.font('Helvetica-Bold');
        x = doc.page.margins.left;
        columns.forEach(col => {
          doc.text(col.title, x, tableY, { width: col.width, align: col.align || 'left' });
          x += col.width;
        });
        tableY += rowHeight;
        doc.moveTo(doc.page.margins.left, tableY).lineTo(doc.page.width - doc.page.margins.right, tableY).stroke();
        tableY += 5;
        doc.font('Helvetica');
      }
      
      x = doc.page.margins.left;
      const hora = dayjs.tz(payment.paymentDate, TZ).format('HH:mm');
      const cliente = `${payment.loan.client.firstName} ${payment.loan.client.lastName}`;
      
      doc.text(hora, x, tableY, { width: columns[0].width });
      x += columns[0].width;
      doc.text(cliente, x, tableY, { width: columns[1].width });
      x += columns[1].width;
      doc.text(payment.paymentMethod, x, tableY, { width: columns[2].width });
      x += columns[2].width;
      doc.text(formatCurrency(payment.amount), x, tableY, { width: columns[3].width, align: 'right' });
      x += columns[3].width;
      doc.text(payment.receiptNumber, x, tableY, { width: columns[4].width });
      
      tableY += rowHeight;
    }
  }
  
  doc.moveDown(2);
  doc.fontSize(8).text('Reporte generado automáticamente', { align: 'center' });
}
