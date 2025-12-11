import PDFDocument from 'pdfkit';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import path from 'path';
import fs from 'fs';

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

  const toCents = (v) => Math.round(Number(v || 0) * 100);
  const remainingForInstallment = (amount, paid) => {
    const remainingCents = Math.max(0, toCents(amount) - toCents(paid));
    return remainingCents <= 4 ? 0 : Number((remainingCents / 100).toFixed(2));
  };

  const scheduleWithRemaining = (() => {
    if (!schedule) return [];
    return schedule.map((row) => {
      const paid = paidByInstallment.get(row.id) || 0;
      const remainingInstallment = remainingForInstallment(row.installmentAmount, paid);
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

/**
 * Convierte un número a palabras en español para boletas
 * Ejemplo: 2.30 -> "DOS Y 30/100"
 */
function numberToWords(amount) {
  const num = typeof amount === 'number' ? amount : Number(amount);
  const integerPart = Math.floor(num);
  const decimalPart = Math.round((num - integerPart) * 100);
  
  const ones = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
  const tens = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const teens = ['DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
  const hundreds = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
  
  function convertToWords(n) {
    if (n === 0) return 'CERO';
    if (n < 0) return 'MENOS ' + convertToWords(-n);
    
    let words = '';
    
    // Millones
    if (n >= 1000000) {
      const millionPart = Math.floor(n / 1000000);
      words += convertToWords(millionPart) + ' MILLÓN';
      if (millionPart > 1) words = words.replace('MILLÓN', 'MILLONES');
      n = n % 1000000;
      if (n > 0) words += ' ';
    }
    
    // Miles
    if (n >= 1000) {
      const thousandPart = Math.floor(n / 1000);
      words += convertToWords(thousandPart) + ' MIL';
      n = n % 1000;
      if (n > 0) words += ' ';
    }
    
    // Centenas
    if (n >= 100) {
      const hundredPart = Math.floor(n / 100);
      words += hundreds[hundredPart];
      n = n % 100;
      if (n > 0) words += ' ';
    }
    
    // Decenas y unidades
    if (n >= 20) {
      const tenPart = Math.floor(n / 10);
      words += tens[tenPart];
      n = n % 10;
      if (n > 0) words += ' Y ' + ones[n];
    } else if (n >= 10) {
      words += teens[n - 10];
    } else if (n > 0) {
      words += ones[n];
    }
    
    return words.trim();
  }
  
  const integerWords = convertToWords(integerPart);
  const decimalFormatted = String(decimalPart).padStart(2, '0');
  
  return `${integerWords} Y ${decimalFormatted}/100`;
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

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/**
 * Genera un comprobante de pago en PDF
 */
export function buildPaymentReceipt(doc, payment, invoiceInfo = {}) {
  const type = invoiceInfo.type === 'factura' ? 'Factura' : 'Boleta';
  
  // Si es factura, usar formato específico
  if (type === 'Factura') {
    return buildInvoicePdf(doc, payment, invoiceInfo);
  }
  
  // Para boletas, usar el formato actual
  return buildBoleta(doc, payment, invoiceInfo);
}

/**
 * Genera una FACTURA ELECTRÓNICA con formato profesional
 */
function buildInvoicePdf(doc, payment, invoiceInfo = {}) {
  const margin = 20;
  const contentWidth = doc.page.width - margin * 2;
  const client = payment.loan.client;
  const issuer = {
    name: 'NOTICICER CONTABLE',
    ruc: '20556106909',
    address: 'CAL. MARTIR OLAYA 129 DPTO. 1107 ALT CDRA. 01 DE AV. PARDO MIRAFLORES - LIMA - LIMA',
    docType: 'RUC'
  };

  const total = Number(payment.amount || 0);
  const opGravada = round2(total / 1.18);
  const igv = round2(total - opGravada);
  
  const series = 'E001';
  const correlative = String(invoiceInfo.correlative || 1).padStart(4, '0');
  const comprobanteFull = `${series}-${correlative}`;

  let y = margin;

  // Encabezado: Razón social
  doc.font('Helvetica-Bold').fontSize(13).text(issuer.name, margin, y, { align: 'left' });
  y += 16;
  doc.font('Helvetica').fontSize(10).text('NOTICIERO DEL CONTADOR S.A.C.', margin, y);
  y += 12;
  doc.fontSize(9).text(issuer.address, margin, y, { width: contentWidth - 200 });
  
  // Caja de factura en esquina superior derecha
  const boxWidth = 180;
  const boxX = doc.page.width - margin - boxWidth;
  const boxY = margin - 5;
  doc.rect(boxX, boxY, boxWidth, 85).stroke();
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('FACTURA ELECTRÓNICA', boxX + 8, boxY + 8, { width: boxWidth - 16, align: 'center' });
  doc.fontSize(10).text(`RUC: ${issuer.ruc}`, boxX + 8, boxY + 24, { width: boxWidth - 16, align: 'center' });
  doc.text(comprobanteFull, boxX + 8, boxY + 40, { width: boxWidth - 16, align: 'center' });
  doc.font('Helvetica').fontSize(9);
  doc.text('Forma de pago: Crédito', boxX + 8, boxY + 58, { width: boxWidth - 16, align: 'center' });

  y += 75;

  // Datos de vencimiento
  doc.font('Helvetica').fontSize(9);
  doc.text('Fecha de Vencimiento : 05/10/2021', margin, y);
  y += 11;
  doc.text(`Fecha de Emisión : ${formatDate(payment.paymentDate)}`, margin, y);
  y += 11;
  doc.text(`Señor(es) : ${invoiceInfo.customerName || client.firstName + ' ' + client.lastName}`, margin, y);
  y += 11;
  doc.text(`RUC : ${invoiceInfo.customerRuc || '-'}`, margin, y);
  y += 11;
  doc.text('Dirección del Receptor de la factura :', margin, y);
  y += 11;
  doc.text('Dirección del Cliente : ' + (invoiceInfo.customerAddress || '-'), margin, y);
  y += 11;
  doc.text('Tipo de Moneda : SOLES', margin, y);
  y += 11;
  doc.font('Helvetica-Bold');
  doc.text(`Observación : DETRACCION (12%): S/ ${formatCurrency(igv)}`, margin, y);
  y += 18;

  // Tabla de items
  const colWidths = [90, 280, 80, 80];
  const tableStartX = margin;
  const tableY = y;

  // Header
  doc.font('Helvetica-Bold').fontSize(9);
  doc.rect(tableStartX, tableY, contentWidth, 20).fill('#333333');
  doc.fillColor('white');
  let colX = tableStartX + 6;
  const headers = ['Cantidad', 'Unidad Medida Código', 'Descripción', 'Valor Unitario', 'ICBPER'];
  doc.text('Cantidad', colX, tableY + 4, { width: colWidths[0], align: 'left' });
  doc.text('Unidad Medida Código', colX + colWidths[0], tableY + 4, { width: colWidths[1] - 100, align: 'left' });
  doc.text('Descripción', colX + colWidths[0] + colWidths[1] - 100, tableY + 4, { width: 100, align: 'left' });
  doc.text('Valor Unitario', colX + colWidths[0] + colWidths[1], tableY + 4, { width: colWidths[2], align: 'right' });
  doc.text('ICBPER', colX + colWidths[0] + colWidths[1] + colWidths[2], tableY + 4, { width: colWidths[3], align: 'right' });
  
  doc.fillColor('black');
  y = tableY + 20;

  // Filas de items
  doc.font('Helvetica').fontSize(9);
  doc.text('1.00', tableStartX + 6, y, { width: colWidths[0], align: 'left' });
  doc.text('UNIDAD', tableStartX + 6 + colWidths[0], y, { width: colWidths[1] - 100, align: 'left' });
  doc.text('CONTABILI SERVICIO DE CONTABILIDAD MES SETIEMBRE 2021', tableStartX + 6 + colWidths[0] + colWidths[1] - 100, y, { width: 100, align: 'left' });
  doc.text(formatCurrency(opGravada), tableStartX + 6 + colWidths[0] + colWidths[1], y, { width: colWidths[2], align: 'right' });
  doc.text('0.00', tableStartX + 6 + colWidths[0] + colWidths[1] + colWidths[2], y, { width: colWidths[3], align: 'right' });
  
  y += 20;
  doc.moveTo(tableStartX, y).lineTo(tableStartX + contentWidth, y).stroke();

  // Totales - lado izquierdo
  y += 10;
  doc.font('Helvetica').fontSize(9);
  doc.text('Valor de Venta de Operaciones Gratuitas : ' + formatCurrency(0), margin, y);
  y += 25;

  // Tabla de totales - lado derecho
  const totalsX = margin + 280;
  let totalsY = tableY + 20;
  
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Sub Total Ventas :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text(formatCurrency(opGravada), totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Anticipos :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Descuentos :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Valor Venta :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text(formatCurrency(opGravada), totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('ISC :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('IGV :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text(formatCurrency(igv), totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('ICBPER :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Otros Cargos :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Otros Tributos :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Monto de redondeo :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text('S/ 0.00', totalsX + 130, totalsY, { width: 60, align: 'right' });
  
  totalsY += 16;
  doc.font('Helvetica-Bold').text('Importe Total :', totalsX, totalsY, { width: 120, align: 'right' });
  doc.font('Helvetica');
  doc.text(formatCurrency(total), totalsX + 130, totalsY, { width: 60, align: 'right' });

  // SON
  y = totalsY + 30;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`SON: ${numberToWords(total)} SOLES`, margin, y, { width: contentWidth, align: 'left' });

  // Información del crédito
  y += 30;
  doc.rect(margin, y, contentWidth, 50).stroke();
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Información del crédito', margin + 8, y + 8);
  doc.font('Helvetica');
  doc.text(`Monto neto pendiente de pago : S/ ${formatCurrency(total)}`, margin + 8, y + 22);
  doc.text('Total de Cuotas : 1', margin + 8, y + 35);

  // Tabla de cuotas
  y += 60;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.rect(margin, y, contentWidth, 18).fill('#333333');
  doc.fillColor('white');
  doc.text('N° Cuota', margin + 8, y + 4);
  doc.text('Fec. Venc.', margin + 120, y + 4);
  doc.text('Monto', margin + 240, y + 4);
  doc.text('N° Cuota', margin + 340, y + 4);
  doc.text('Fec. Venc.', margin + 460, y + 4);
  doc.text('Monto', margin + 540, y + 4);
  
  doc.fillColor('black');
  y += 18;
  doc.font('Helvetica').fontSize(9);
  doc.text('1', margin + 8, y);
  doc.text(formatDate(payment.paymentDate), margin + 120, y);
  doc.text(formatCurrency(total), margin + 240, y);

  // Footer
  y = doc.page.height - margin - 30;
  doc.font('Helvetica').fontSize(8);
  doc.text('Esta es una representación impresa de la factura electrónica, generada en el Sistema de SUNAT. Puede verificarla usando su clave SOL.', margin, y, { width: contentWidth, align: 'center' });
}

/**
 * Genera una BOLETA DE VENTA con el formato actual
 */
function buildBoleta(doc, payment, invoiceInfo = {}) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const client = payment.loan.client;
  const loan = payment.loan;
  const type = 'Boleta';

  // Datos del emisor (ajusta a tu negocio)
  const issuer = {
    name: 'CapiPresta',
    businessName: 'CapiPresta',
    address: 'C. Los Almendros 2013, Trujillo 13008',
    ruc: '20123456789',
    series: 'B001',
  };

  const total = Number(payment.amount || 0);
  const opGravada = round2(total / 1.18);
  const igv = round2(total - opGravada);
  
  const series = 'B001';
  const correlative = String(invoiceInfo.correlative || 1).padStart(8, '0');
  const comprobanteFull = `${series}-${correlative}`;

  const margin = doc.page.margins.left;

  // Logo/Nombre
  let y = margin;
  try {
    const candidate = path.resolve(process.cwd(), '../frontend/public/logogrante.png');
    const fallback = path.resolve(process.cwd(), 'frontend/public/logogrante.png');
    const logoPath = fs.existsSync(candidate) ? candidate : fallback;
    doc.image(logoPath, margin, y, { width: 120 });
  } catch (e) {
    // si no existe la imagen, continuar con texto
    doc.font('Helvetica-Bold').fontSize(20).text(issuer.name, margin, y);
  }
  const textX = margin + 130;
  doc.font('Helvetica-Bold').fontSize(16).text(issuer.name, textX, y);
  doc.font('Helvetica').fontSize(12).text(issuer.businessName, textX, y + 18);
  doc.fontSize(10).text(issuer.address, textX, y + 32);

  // Caja de RUC y doc info
  const boxW = 200;
  const boxH = 90;
  const boxX = doc.page.width - margin - boxW;
  const boxY = y;
  doc.rect(boxX, boxY, boxW, boxH).stroke();
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`R.U.C. N° ${issuer.ruc}`, boxX, boxY + 8, { width: boxW, align: 'center' });
  doc.text(`${type.toUpperCase()} ELECTRÓNICA`, boxX, boxY + 28, { width: boxW, align: 'center' });
  doc.text(`${comprobanteFull}`, boxX, boxY + 48, { width: boxW, align: 'center' });

  y = boxY + boxH + 16;

  // Datos del receptor
  const customerRuc = invoiceInfo.customerRuc || '';
  const customerName = invoiceInfo.customerName || `${client.firstName} ${client.lastName}`;
  const customerAddress = invoiceInfo.customerAddress || '-';
  const customerDocLabel = 'DNI';
  const customerDoc = client.dni;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('NOMBRE:', margin, y, { continued: true }).font('Helvetica').text(` ${customerName}`);
  y += 14;
  doc.font('Helvetica-Bold').text(`${customerDocLabel}:`, margin, y, { continued: true }).font('Helvetica').text(` ${customerDoc}`);
  y += 14;
  doc.font('Helvetica-Bold').text('DIRECCIÓN:', margin, y, { continued: true }).font('Helvetica').text(` ${customerAddress}`);
  y += 14;
  doc.font('Helvetica-Bold').text('EMISIÓN:', margin, y, { continued: true }).font('Helvetica').text(` ${formatDateTime(payment.paymentDate)}`);
  y += 14;
  doc.font('Helvetica-Bold').text('MONEDA:', margin, y, { continued: true }).font('Helvetica').text(' SOL (PEN)');
  y += 14;
  doc.font('Helvetica-Bold').text('FORMA DE PAGO:', margin, y, { continued: true }).font('Helvetica').text(' CONTADO');
  y += 14;
  doc.font('Helvetica-Bold').text('TIPO DE OPERACIÓN:', margin, y, { continued: true }).font('Helvetica').text(' VENTA INTERNA');
  y += 18;

  // Encabezado tabla
  const startX = margin;
  const headerY = y;
  const colWidths = [80, contentWidth - 80 - 90 - 90, 90, 90];
  doc.rect(startX, headerY, contentWidth, 24).fill('#1f1f1f');
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10);
  const headers = ['CANTIDAD', 'CÓDIGO y DESCRIPCIÓN', 'PRECIO UNITARIO', 'PRECIO TOTAL'];
  let x = startX + 8;
  headers.forEach((h, idx) => {
    doc.text(h, x, headerY + 6, { width: colWidths[idx] - 16, align: idx >= 2 ? 'right' : 'left' });
    x += colWidths[idx];
  });
  doc.fillColor('black').font('Helvetica').fontSize(10);

  // Fila detalle
  const rowY = headerY + 24;
  x = startX + 8;

  // Si tiene installmentsPaid, mostrar cada cuota en fila separada
  let lastRowY = rowY;
  if (payment.installmentsPaid && payment.installmentsPaid.length > 0) {
    // Mostrar cada cuota en una fila separada con línea divisoria
    let currentY = rowY;
    payment.installmentsPaid.forEach((inst, idx) => {
      const rowVals = [
        '1 UNIDAD',
        `Pago cuota #${inst.installmentNumber} (${formatDate(inst.dueDate)})`,
        formatCurrency(inst.installmentAmount),
        formatCurrency(inst.installmentAmount)
      ];
      x = startX + 8;
      rowVals.forEach((val, idxCol) => {
        doc.text(val, x, currentY + 8, { width: colWidths[idxCol] - 16, align: idxCol >= 2 ? 'right' : 'left' });
        x += colWidths[idxCol];
      });
      currentY += 20;
      // Línea separadora después de cada fila de cuota
      doc.moveTo(startX, currentY).lineTo(startX + contentWidth, currentY).stroke();
    });
    lastRowY = currentY;
  } else {
    // Pago sin installmentsPaid (compatibilidad - no debería ocurrir)
    const rowVals = [
      '1 UNIDAD',
      `Pago cuota`,
      formatCurrency(total),
      formatCurrency(total)
    ];
    x = startX + 8;
    rowVals.forEach((val, idx) => {
      doc.text(val, x, rowY + 8, { width: colWidths[idx] - 16, align: idx >= 2 ? 'right' : 'left' });
      x += colWidths[idx];
    });
    lastRowY = rowY + 20;
    doc.moveTo(startX, lastRowY).lineTo(startX + contentWidth, lastRowY).stroke();
  }

  // Totales
  const totalsY = lastRowY + 12;
  doc.font('Helvetica-Bold');
  doc.text('OP. GRAVADA', startX + colWidths[0] + colWidths[1], totalsY, { width: colWidths[2], align: 'right' });
  doc.text('IGV', startX + colWidths[0] + colWidths[1], totalsY + 14, { width: colWidths[2], align: 'right' });
  doc.text('IMPORTE TOTAL (S/)', startX + colWidths[0] + colWidths[1], totalsY + 28, { width: colWidths[2], align: 'right' });
  doc.font('Helvetica');
  doc.text(formatCurrency(opGravada), startX + colWidths[0] + colWidths[1] + colWidths[2], totalsY, { width: colWidths[3], align: 'right' });
  doc.text(formatCurrency(igv), startX + colWidths[0] + colWidths[1] + colWidths[2], totalsY + 14, { width: colWidths[3], align: 'right' });
  doc.font('Helvetica-Bold');
  doc.text(formatCurrency(total), startX + colWidths[0] + colWidths[1] + colWidths[2], totalsY + 28, { width: colWidths[3], align: 'right' });
  doc.font('Helvetica');

  // SON:
  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(`SON: ${numberToWords(total)} SOLES`, margin, doc.y, { width: contentWidth - margin, align: 'right' });
  doc.font('Helvetica').fontSize(10);

  // QR imagen + texto
  const qrY = doc.y + 10;
  const qrSize = 90;
  let qrPlaced = false;
  try {
    const qrCandidate = path.resolve(process.cwd(), '../frontend/public/qr.png');
    const qrFallback = path.resolve(process.cwd(), 'frontend/public/qr.png');
    const qrPath = fs.existsSync(qrCandidate) ? qrCandidate : qrFallback;
    doc.image(qrPath, margin, qrY, { width: qrSize, height: qrSize });
    qrPlaced = true;
  } catch (e) {
    // sin QR
  }
  if (!qrPlaced) {
    doc.rect(margin, qrY, qrSize, qrSize).stroke();
  }
  doc.fontSize(9).text('Representación impresa de la BOLETA DE VENTA ELECTRÓNICA.', margin + qrSize + 10, qrY + 10);
  doc.fillColor('#0d47a1').text('Generada en apisunat.com', margin + qrSize + 10, qrY + 26);
  doc.fillColor('black');
}

/**
 * Genera un comprobante de pago en PDF - ANTERIOR (ya no se usa directamente)
 */
export function buildPaymentReceiptOld(doc, payment, invoiceInfo = {}) {
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const client = payment.loan.client;
  const loan = payment.loan;
  const type = invoiceInfo.type === 'factura' ? 'Factura' : 'Boleta';

  // Datos del emisor (ajusta a tu negocio)
  const issuer = {
    name: 'CapiPresta',
    businessName: 'CapiPresta',
    address: 'C. Los Almendros 2013, Trujillo 13008',
    ruc: '20123456789',
    series: type === 'factura' ? 'F001' : 'B001',
  };

  const total = Number(payment.amount || 0);
  const opGravada = round2(total / 1.18);
  const igv = round2(total - opGravada);
  
  // Serie y correlativo para comprobante electrónico
  // Serie: F001 (Factura) o B001 (Boleta)
  // Correlativo: número secuencial pasado desde el endpoint (1, 2, 3, etc.)
  const series = type === 'factura' ? 'F001' : 'B001';
  const correlative = String(invoiceInfo.correlative || 1).padStart(8, '0');
  const comprobanteFull = `${series}-${correlative}`;

  const margin = doc.page.margins.left;

  // Logo/Nombre
  let y = margin;
  try {
    const candidate = path.resolve(process.cwd(), '../frontend/public/logogrante.png');
    const fallback = path.resolve(process.cwd(), 'frontend/public/logogrante.png');
    const logoPath = fs.existsSync(candidate) ? candidate : fallback;
    doc.image(logoPath, margin, y, { width: 120 });
  } catch (e) {
    // si no existe la imagen, continuar con texto
    doc.font('Helvetica-Bold').fontSize(20).text(issuer.name, margin, y);
  }
  const textX = margin + 130;
  doc.font('Helvetica-Bold').fontSize(16).text(issuer.name, textX, y);
  doc.font('Helvetica').fontSize(12).text(issuer.businessName, textX, y + 18);
  doc.fontSize(10).text(issuer.address, textX, y + 32);

  // Caja de RUC y doc info
  const boxW = 200;
  const boxH = 90;
  const boxX = doc.page.width - margin - boxW;
  const boxY = y;
  doc.rect(boxX, boxY, boxW, boxH).stroke();
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`R.U.C. N° ${issuer.ruc}`, boxX, boxY + 8, { width: boxW, align: 'center' });
  doc.text(`${type.toUpperCase()} ELECTRÓNICA`, boxX, boxY + 28, { width: boxW, align: 'center' });
  doc.text(`${comprobanteFull}`, boxX, boxY + 48, { width: boxW, align: 'center' });

  y = boxY + boxH + 16;

  // Datos del receptor
  const customerRuc = invoiceInfo.customerRuc || '';
  const customerName = invoiceInfo.customerName || `${client.firstName} ${client.lastName}`;
  const customerAddress = invoiceInfo.customerAddress || '-';
  const customerDocLabel = type === 'factura' ? 'RUC' : 'DNI';
  const customerDoc = type === 'factura' ? customerRuc : client.dni;

  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('NOMBRE:', margin, y, { continued: true }).font('Helvetica').text(` ${customerName}`);
  y += 14;
  doc.font('Helvetica-Bold').text(`${customerDocLabel}:`, margin, y, { continued: true }).font('Helvetica').text(` ${customerDoc}`);
  y += 14;
  doc.font('Helvetica-Bold').text('DIRECCIÓN:', margin, y, { continued: true }).font('Helvetica').text(` ${customerAddress}`);
  y += 14;
  doc.font('Helvetica-Bold').text('EMISIÓN:', margin, y, { continued: true }).font('Helvetica').text(` ${formatDateTime(payment.paymentDate)}`);
  y += 14;
  doc.font('Helvetica-Bold').text('MONEDA:', margin, y, { continued: true }).font('Helvetica').text(' SOL (PEN)');
  y += 14;
  doc.font('Helvetica-Bold').text('FORMA DE PAGO:', margin, y, { continued: true }).font('Helvetica').text(' CONTADO');
  y += 14;
  doc.font('Helvetica-Bold').text('TIPO DE OPERACIÓN:', margin, y, { continued: true }).font('Helvetica').text(' VENTA INTERNA');
  y += 18;

  // Encabezado tabla
  const startX = margin;
  const headerY = y;
  const colWidths = [80, contentWidth - 80 - 90 - 90, 90, 90];
  doc.rect(startX, headerY, contentWidth, 24).fill('#1f1f1f');
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10);
  const headers = ['CANTIDAD', 'CÓDIGO y DESCRIPCIÓN', 'PRECIO UNITARIO', 'PRECIO TOTAL'];
  let x = startX + 8;
  headers.forEach((h, idx) => {
    doc.text(h, x, headerY + 6, { width: colWidths[idx] - 16, align: idx >= 2 ? 'right' : 'left' });
    x += colWidths[idx];
  });
  doc.fillColor('black').font('Helvetica').fontSize(10);

  // Fila detalle
  const rowY = headerY + 24;
  x = startX + 8;

  // Si tiene installmentsPaid, mostrar cada cuota en fila separada
  let lastRowY = rowY;
  if (payment.installmentsPaid && payment.installmentsPaid.length > 0) {
    // Mostrar cada cuota en una fila separada con línea divisoria
    let currentY = rowY;
    payment.installmentsPaid.forEach((inst, idx) => {
      const rowVals = [
        '1 UNIDAD',
        `Pago cuota #${inst.installmentNumber} (${formatDate(inst.dueDate)})`,
        formatCurrency(inst.installmentAmount),
        formatCurrency(inst.installmentAmount)
      ];
      x = startX + 8;
      rowVals.forEach((val, idxCol) => {
        doc.text(val, x, currentY + 8, { width: colWidths[idxCol] - 16, align: idxCol >= 2 ? 'right' : 'left' });
        x += colWidths[idxCol];
      });
      currentY += 20;
      // Línea separadora después de cada fila de cuota
      doc.moveTo(startX, currentY).lineTo(startX + contentWidth, currentY).stroke();
    });
    lastRowY = currentY;
  } else {
    // Pago sin installmentsPaid (compatibilidad - no debería ocurrir)
    const rowVals = [
      '1 UNIDAD',
      `Pago cuota`,
      formatCurrency(total),
      formatCurrency(total)
    ];
    x = startX + 8;
    rowVals.forEach((val, idx) => {
      doc.text(val, x, rowY + 8, { width: colWidths[idx] - 16, align: idx >= 2 ? 'right' : 'left' });
      x += colWidths[idx];
    });
    lastRowY = rowY + 20;
    doc.moveTo(startX, lastRowY).lineTo(startX + contentWidth, lastRowY).stroke();
  }

  // Totales
  const totalsY = lastRowY + 12;
  doc.font('Helvetica-Bold');
  doc.text('OP. GRAVADA', startX + colWidths[0] + colWidths[1], totalsY, { width: colWidths[2], align: 'right' });
  doc.text('IGV', startX + colWidths[0] + colWidths[1], totalsY + 14, { width: colWidths[2], align: 'right' });
  doc.text('IMPORTE TOTAL (S/)', startX + colWidths[0] + colWidths[1], totalsY + 28, { width: colWidths[2], align: 'right' });
  doc.font('Helvetica');
  doc.text(formatCurrency(opGravada), startX + colWidths[0] + colWidths[1] + colWidths[2], totalsY, { width: colWidths[3], align: 'right' });
  doc.text(formatCurrency(igv), startX + colWidths[0] + colWidths[1] + colWidths[2], totalsY + 14, { width: colWidths[3], align: 'right' });
  doc.font('Helvetica-Bold');
  doc.text(formatCurrency(total), startX + colWidths[0] + colWidths[1] + colWidths[2], totalsY + 28, { width: colWidths[3], align: 'right' });
  doc.font('Helvetica');

  // SON:
  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text(`SON: ${numberToWords(total)} SOLES`, margin, doc.y, { width: contentWidth - margin, align: 'right' });
  doc.font('Helvetica').fontSize(10);

  // QR imagen + texto
  const qrY = doc.y + 10;
  const qrSize = 90;
  let qrPlaced = false;
  try {
    const qrCandidate = path.resolve(process.cwd(), '../frontend/public/qr.png');
    const qrFallback = path.resolve(process.cwd(), 'frontend/public/qr.png');
    const qrPath = fs.existsSync(qrCandidate) ? qrCandidate : qrFallback;
    doc.image(qrPath, margin, qrY, { width: qrSize, height: qrSize });
    qrPlaced = true;
  } catch (e) {
    // sin QR
  }
  if (!qrPlaced) {
    doc.rect(margin, qrY, qrSize, qrSize).stroke();
  }
  doc.fontSize(9).text('Representación impresa de la ' + (type === 'factura' ? 'FACTURA ELECTRÓNICA' : 'BOLETA DE VENTA ELECTRÓNICA') + '.', margin + qrSize + 10, qrY + 10);
  doc.fillColor('#0d47a1').text('Generada en apisunat.com', margin + qrSize + 10, qrY + 26);
  doc.fillColor('black');
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
    const gutter = 10;
    const columns = [
      { key: 'hora', title: 'Hora', width: 60 },
      { key: 'cliente', title: 'Cliente', width: 180 },
      { key: 'metodo', title: 'Método', width: 90 },
      { key: 'monto', title: 'Monto', width: 90, align: 'right' },
      { key: 'recibo', title: 'N° Recibo', width: contentWidth - (60 + 180 + 90 + 90 + gutter * 3) },
    ];
    
    const rowHeight = 22;
    let tableY = doc.y;
    
    // Dibujar encabezado
    doc.font('Helvetica-Bold');
    let x = doc.page.margins.left;
    columns.forEach(col => {
      doc.text(col.title, x + 4, tableY, { width: col.width - 8, align: col.align || 'left' });
      x += col.width + gutter;
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
          x += col.width + gutter;
        });
        tableY += rowHeight;
        doc.moveTo(doc.page.margins.left, tableY).lineTo(doc.page.width - doc.page.margins.right, tableY).stroke();
        tableY += 5;
        doc.font('Helvetica');
      }
      
      x = doc.page.margins.left;
      const hora = dayjs.tz(payment.paymentDate, TZ).format('HH:mm');
      const cliente = `${payment.loan.client.firstName} ${payment.loan.client.lastName}`;
      
      const cellY = tableY + 6;
      const pad = 4;
      doc.text(hora, x + pad, cellY, { width: columns[0].width - pad * 2 });
      x += columns[0].width + gutter;
      doc.text(cliente, x + pad, cellY, { width: columns[1].width - pad * 2 });
      x += columns[1].width + gutter;
      doc.text(payment.paymentMethod, x + pad, cellY, { width: columns[2].width - pad * 2, align: 'left' });
      x += columns[2].width + gutter;
      doc.text(formatCurrency(payment.amount), x + pad, cellY, { width: columns[3].width - pad * 2, align: 'right' });
      x += columns[3].width + gutter;
      doc.text(payment.receiptNumber, x + pad, cellY, { width: columns[4].width - pad * 2 });
      
      tableY += rowHeight;
    }
  }
  
  doc.moveDown(2);
  doc.fontSize(8).text('Reporte generado automáticamente', { align: 'center' });
}
