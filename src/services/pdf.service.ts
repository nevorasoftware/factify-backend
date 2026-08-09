import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const DEPARTAMENTOS: Record<string, string> = {
  '01': 'AHUACHAPÁN',
  '02': 'SANTA ANA',
  '03': 'SONSONATE',
  '04': 'CHALATENANGO',
  '05': 'LA LIBERTAD',
  '06': 'SAN SALVADOR',
  '07': 'CUSCATLÁN',
  '08': 'LA PAZ',
  '09': 'CABAÑAS',
  '10': 'SAN VICENTE',
  '11': 'USULUTÁN',
  '12': 'SAN MIGUEL',
  '13': 'MORAZÁN',
  '14': 'LA UNIÓN'
};

const TIPOS_DTE: Record<string, string> = {
  '01': 'FACTURA',
  '03': 'COMPROBANTE DE CRÉDITO FISCAL',
  '05': 'NOTA DE CRÉDITO',
  '06': 'NOTA DE DÉBITO',
  '07': 'COMPROBANTE DE RETENCIÓN',
  '08': 'COMPROBANTE DE LIQUIDACIÓN',
  '09': 'DOCUMENTO CONTABLE DE LIQUIDACIÓN',
  '11': 'FACTURA DE EXPORTACIÓN',
  '14': 'FACTURA DE SUJETO EXCLUIDO',
  '15': 'COMPROBANTE DE DONACIÓN'
};

const UNIDADES_MEDIDA: Record<number, string> = {
  59: 'Unidad',
  99: 'Otros',
  22: 'Gramo',
  23: 'Kilogramo',
  24: 'Tonelada',
  31: 'Metro',
  32: 'Centímetro',
  34: 'Pulgada',
  35: 'Pie',
  36: 'Yarda',
  40: 'Metro cuadrado',
  45: 'Metro cúbico',
  57: 'Litro',
  58: 'Galón'
};

function fmtNum(val: any): string {
  const num = Number(val || 0);
  return isNaN(num) ? '0.00' : num.toFixed(2);
}

function drawWatermark(doc: typeof PDFDocument) {
  doc.save();
  doc.rotate(-35, { origin: [286, 380] });
  doc.fontSize(16);
  doc.fillColor('#B0B0B0');
  doc.fillOpacity(0.2);
  doc.text('DTE SOLO PARA CONSULTA NO TIENE VALIDEZ LEGAL', -40, 150, { width: 600, align: 'center' });
  doc.text('DTE SOLO PARA CONSULTA NO TIENE VALIDEZ LEGAL', -40, 350, { width: 600, align: 'center' });
  doc.text('DTE SOLO PARA CONSULTA NO TIENE VALIDEZ LEGAL', -40, 550, { width: 600, align: 'center' });
  doc.restore();
}

/**
 * Genera un PDF de Representación Gráfica del DTE idéntico a la normativa del MH El Salvador.
 */
export async function generarPdfDte(dteCompleto: any): Promise<Buffer> {
  const identificacion = dteCompleto.identificacion || {};
  const emisor = dteCompleto.emisor || {};
  const receptor = dteCompleto.receptor || {};
  const resumen = dteCompleto.resumen || {};
  const cuerpo = dteCompleto.cuerpoDocumento || [];
  const selloRecibido = dteCompleto.selloRecibido || dteCompleto.respuesta_mh?.selloRecibido || dteCompleto.sello_recepcion_mh || 'N/A';

  // Generar QR Buffer
  const qrUrl = `https://consulta.dtes.mh.gob.sv/consultaPublica?ambiente=${identificacion.ambiente || '00'}&codGen=${identificacion.codigoGeneracion || ''}&fechaEmi=${identificacion.fecEmi || ''}`;
  let qrBuffer: Buffer;
  try {
    qrBuffer = await QRCode.toBuffer(qrUrl, { margin: 1, width: 80 });
  } catch (e) {
    qrBuffer = Buffer.from('');
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 20 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    // 1. Marca de agua
    drawWatermark(doc);

    // 2. Encabezado principal
    let y = 18;

    // Logo del Emisor (Top Left)
    const logoUrl = emisor.logoUrl || emisor.logo_url;
    if (logoUrl && typeof logoUrl === 'string') {
      try {
        if (logoUrl.startsWith('data:image')) {
          const base64Data = logoUrl.replace(/^data:image\/\w+;base64,/, '');
          const logoBuffer = Buffer.from(base64Data, 'base64');
          doc.image(logoBuffer, 22, 12, { fit: [95, 35] });
        }
      } catch (e) {
        console.error('Error al renderizar logo de emisor en PDF:', e);
      }
    }

    doc.fillColor('#000000');
    doc.fontSize(7).font('Helvetica-Bold').text('DOCUMENTO DE CONSULTA PORTAL OPERATIVO', 20, y, { width: 572, align: 'center' });
    y += 10;
    doc.fontSize(8).font('Helvetica-Bold').text('DOCUMENTO TRIBUTARIO ELECTRÓNICO', 20, y, { width: 572, align: 'center' });
    y += 11;
    const nombreTipoDte = TIPOS_DTE[identificacion.tipoDte] || 'FACTURA';
    doc.fontSize(10).font('Helvetica-Bold').text(nombreTipoDte, 20, y, { width: 572, align: 'center' });
    doc.fontSize(7).font('Helvetica').text(`Ver.${identificacion.version || 1}`, 540, 18, { width: 50, align: 'right' });

    // 3. Caja Meta Identificación + QR (Y=52)
    y = 52;
    const metaBoxHeight = 62;
    doc.lineWidth(0.6).rect(20, y, 572, metaBoxHeight).stroke('#000000');

    // Columna Izquierda (Datos DTE)
    let metaY = y + 6;
    doc.fontSize(7).font('Helvetica-Bold').text('Código de Generación: ', 26, metaY, { continued: true });
    doc.font('Helvetica').text(identificacion.codigoGeneracion || '');
    
    metaY += 14;
    doc.font('Helvetica-Bold').text('Número de Control : ', 26, metaY, { continued: true });
    doc.font('Helvetica').text(identificacion.numeroControl || '');

    metaY += 14;
    doc.font('Helvetica-Bold').text('Sello de Recepción: ', 26, metaY, { continued: true });
    doc.font('Helvetica').text(selloRecibido);

    // Centro (QR Code)
    if (qrBuffer.length > 0) {
      doc.image(qrBuffer, 276, y + 3, { width: 56, height: 56 });
    }

    // Columna Derecha (Modelo, Transmisión, Fecha)
    let metaRightY = y + 10;
    const rightX = 350;
    doc.fontSize(7).font('Helvetica-Bold').text('Modelo de Facturación: ', rightX, metaRightY, { continued: true });
    doc.font('Helvetica').text(identificacion.tipoModelo === 1 ? 'Previo' : 'Diferido');

    metaRightY += 14;
    doc.font('Helvetica-Bold').text('Tipo de Transmisión: ', rightX, metaRightY, { continued: true });
    doc.font('Helvetica').text(identificacion.tipoOperacion === 1 ? 'Normal' : 'Contingencia');

    metaRightY += 14;
    doc.font('Helvetica-Bold').text('Fecha y Hora de Generación: ', rightX, metaRightY, { continued: true });
    doc.font('Helvetica').text(`${identificacion.fecEmi || ''} ${identificacion.horEmi || ''}`);

    // 4. Seccion Emisor y Receptor (Y=120)
    y = 120;
    const partyBoxWidth = 282;
    const partyBoxHeight = 100;

    // --- Box EMISOR ---
    doc.rect(20, y, partyBoxWidth, partyBoxHeight).stroke('#000000');
    doc.fontSize(8).font('Helvetica-Bold').text('EMISOR', 20, y + 4, { width: partyBoxWidth, align: 'center' });
    doc.moveTo(20, y + 14).lineTo(20 + partyBoxWidth, y + 14).stroke('#000000');

    let ey = y + 17;
    const lineStep = 10;
    doc.fontSize(6.5);
    
    doc.font('Helvetica-Bold').text('Nombre o razón social: ', 24, ey, { continued: true, width: partyBoxWidth - 10 });
    doc.font('Helvetica').text(emisor.nombre || '');
    ey += lineStep + 2;

    doc.font('Helvetica-Bold').text('NIT: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(emisor.nit || '');
    ey += lineStep;

    doc.font('Helvetica-Bold').text('NRC: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(emisor.nrc || '');
    ey += lineStep;

    doc.font('Helvetica-Bold').text('Actividad económica: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(emisor.descActividad || '', { width: partyBoxWidth - 30 });
    ey += lineStep + 2;

    const depEmisor = DEPARTAMENTOS[emisor.direccion?.departamento] || '';
    const dirEmisorText = `${emisor.direccion?.complemento || ''}${depEmisor ? ', ' + depEmisor : ''}`;
    doc.font('Helvetica-Bold').text('Dirección: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(dirEmisorText, { width: partyBoxWidth - 30 });
    ey += lineStep + 4;

    doc.font('Helvetica-Bold').text('Número de teléfono: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(emisor.telefono || '');
    ey += lineStep;

    doc.font('Helvetica-Bold').text('Correo electrónico: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(emisor.correo || '');
    ey += lineStep;

    doc.font('Helvetica-Bold').text('Tipo de establecimiento: ', 24, ey, { continued: true });
    doc.font('Helvetica').text(emisor.tipoEstablecimiento === '01' ? 'Sucursal / Agencia' : 'Casa Matriz');

    // --- Box RECEPTOR ---
    const rx = 310;
    doc.rect(rx, y, partyBoxWidth, partyBoxHeight).stroke('#000000');
    doc.fontSize(8).font('Helvetica-Bold').text('RECEPTOR', rx, y + 4, { width: partyBoxWidth, align: 'center' });
    doc.moveTo(rx, y + 14).lineTo(rx + partyBoxWidth, y + 14).stroke('#000000');

    let ry = y + 17;

    doc.fontSize(6.5);
    doc.font('Helvetica-Bold').text('Nombre o razón social: ', rx + 4, ry, { continued: true });
    doc.font('Helvetica').text(receptor.nombre || '');
    ry += lineStep + 2;

    doc.font('Helvetica-Bold').text('NIT: ', rx + 4, ry, { continued: true });
    doc.font('Helvetica').text(receptor.numDocumento || receptor.nit || '-');
    ry += lineStep;

    doc.font('Helvetica-Bold').text('Correo electrónico: ', rx + 4, ry, { continued: true });
    doc.font('Helvetica').text(receptor.correo || '-');
    ry += lineStep;

    const depReceptor = DEPARTAMENTOS[receptor.direccion?.departamento] || '';
    const dirReceptorText = `${receptor.direccion?.complemento || ''}${depReceptor ? ', ' + depReceptor : ''}`;
    doc.font('Helvetica-Bold').text('Dirección: ', rx + 4, ry, { continued: true });
    doc.font('Helvetica').text(dirReceptorText, { width: partyBoxWidth - 20 });
    ry += lineStep + 6;

    doc.font('Helvetica-Bold').text('Número de teléfono: ', rx + 4, ry, { continued: true });
    doc.font('Helvetica').text(receptor.telefono || '-');

    // 5. Venta a Cuenta de Terceros (Y=226)
    y = 226;
    doc.rect(20, y, 572, 22).stroke('#000000');
    doc.fontSize(7).font('Helvetica-Bold').text('VENTA A CUENTA DE TERCEROS', 20, y + 2, { width: 572, align: 'center' });
    doc.moveTo(20, y + 11).lineTo(592, y + 11).stroke('#000000');
    doc.fontSize(6.5).font('Helvetica-Bold').text('NIT: ', 24, y + 13, { continued: true });
    doc.font('Helvetica').text(dteCompleto.ventaTercero?.nit || '-', { continued: true });
    doc.font('Helvetica-Bold').text('      Nombre, denominación o razón social: ', { continued: true });
    doc.font('Helvetica').text(dteCompleto.ventaTercero?.nombre || '-');

    // 6. Documentos Relacionados (Y=252)
    y = 252;
    doc.rect(20, y, 572, 22).stroke('#000000');
    doc.fontSize(7).font('Helvetica-Bold').text('DOCUMENTOS RELACIONADOS', 20, y + 2, { width: 572, align: 'center' });
    doc.moveTo(20, y + 11).lineTo(592, y + 11).stroke('#000000');
    
    // Tabla Header Doc Relacionados
    doc.fontSize(6).font('Helvetica-Bold');
    doc.text('Tipo de Documento', 20, y + 13, { width: 190, align: 'center' });
    doc.text('N° de Documento', 210, y + 13, { width: 190, align: 'center' });
    doc.text('Fecha de Documento', 400, y + 13, { width: 192, align: 'center' });

    // 7. Otros Documentos Asociados (Y=278)
    y = 278;
    doc.rect(20, y, 572, 22).stroke('#000000');
    doc.fontSize(7).font('Helvetica-Bold').text('OTROS DOCUMENTOS ASOCIADOS', 20, y + 2, { width: 572, align: 'center' });
    doc.moveTo(20, y + 11).lineTo(592, y + 11).stroke('#000000');
    doc.fontSize(6).font('Helvetica-Bold');
    doc.text('Identificación del documento', 20, y + 13, { width: 286, align: 'center' });
    doc.text('Descripción', 306, y + 13, { width: 286, align: 'center' });

    // 8. Tabla Cuerpo de Documento (Items) (Y=304)
    y = 304;
    const colWidths = [20, 36, 40, 140, 48, 48, 48, 48, 48, 48]; // Total = 574
    const colAligns: ('left' | 'center' | 'right')[] = [
      'center', 'center', 'center', 'left', 'right', 'right', 'right', 'right', 'right', 'right'
    ];
    const headers = [
      'N°', 'Cantidad', 'Unidad', 'Descripción', 'Precio Unitario',
      'Otros montos no afectos', 'Descuento por ítem', 'Ventas No Sujetas',
      'Ventas Exentas', 'Ventas Gravadas'
    ];

    const itemTableWidth = 572;
    const headerHeight = 18;

    doc.rect(20, y, itemTableWidth, headerHeight).stroke('#000000');

    let curX = 20;
    doc.fontSize(5.5).font('Helvetica-Bold');
    headers.forEach((h, i) => {
      doc.text(h, curX + 1, y + 2, { width: colWidths[i] - 2, align: 'center' });
      curX += colWidths[i];
      if (i < headers.length - 1) {
        doc.moveTo(curX, y).lineTo(curX, y + headerHeight).stroke('#000000');
      }
    });

    y += headerHeight;

    // Filas de Items
    const rowHeight = 14;
    cuerpo.forEach((item: any, idx: number) => {
      doc.rect(20, y, itemTableWidth, rowHeight).stroke('#000000');
      let ix = 20;
      const vals = [
        String(item.numItem || idx + 1),
        fmtNum(item.cantidad),
        UNIDADES_MEDIDA[item.uniMedida] || 'Unidad',
        String(item.descripcion || ''),
        fmtNum(item.precioUni || item.precioUnitario),
        fmtNum(item.noGravado || item.otrosMontos),
        fmtNum(item.montoDescu),
        fmtNum(item.ventaNoSuj),
        fmtNum(item.ventaExenta),
        fmtNum(item.ventaGravada)
      ];

      doc.fontSize(6).font('Helvetica');
      vals.forEach((v, i) => {
        doc.text(v, ix + 2, y + 3, { width: colWidths[i] - 4, align: colAligns[i] });
        ix += colWidths[i];
        if (i < vals.length - 1) {
          doc.moveTo(ix, y).lineTo(ix, y + rowHeight).stroke('#000000');
        }
      });
      y += rowHeight;
    });

    // Si no hay items, dibujar 1 fila vacia
    if (cuerpo.length === 0) {
      doc.rect(20, y, itemTableWidth, rowHeight).stroke('#000000');
      y += rowHeight;
    }

    // 9. Tabla Resumen / Totales (Bottom Right)
    const summaryWidth = 310;
    const summaryX = 592 - summaryWidth;

    const totalsRows = [
      { label: 'Suma de Ventas:', vals: [fmtNum(resumen.totalNoSuj), fmtNum(resumen.totalExenta), fmtNum(resumen.totalGravada)] },
      { label: 'Sumatoria de ventas:', val: fmtNum(resumen.subTotalVentas) },
      { label: 'Monto global Desc., Rebajas y otros a ventas no sujetas:', val: fmtNum(resumen.descuNoSuj) },
      { label: 'Monto global Desc., Rebajas y otros a ventas Exentas:', val: fmtNum(resumen.descuExenta) },
      { label: 'Monto global Desc., Rebajas y otros a ventas gravadas:', val: fmtNum(resumen.descuGravada) },
      { label: 'Sub-Total:', val: fmtNum(resumen.subTotal) },
      { label: 'IVA Retenido / Impuestos:', val: fmtNum(resumen.ivaRete1 || resumen.totalIva || 0) },
      { label: 'Monto Total de la Operación:', val: fmtNum(resumen.montoTotalOperacion) },
      { label: 'Total Otros Montos No Afectos:', val: fmtNum(resumen.totalNoGravado) },
      { label: 'Total a Pagar:', val: fmtNum(resumen.totalPagar || resumen.montoTotalOperacion) }
    ];

    const summaryRowHeight = 11;
    doc.fontSize(6);

    totalsRows.forEach((r, idx) => {
      doc.rect(summaryX, y, summaryWidth, summaryRowHeight).stroke('#000000');
      doc.font('Helvetica-Bold').text(r.label, summaryX + 4, y + 2, { width: summaryWidth - 110, align: 'right' });
      
      if (r.vals) {
        doc.font('Helvetica').text(`${r.vals[0]}      ${r.vals[1]}      ${r.vals[2]}`, summaryX + summaryWidth - 105, y + 2, { width: 100, align: 'right' });
      } else {
        doc.font('Helvetica').text(r.val || '0.00', summaryX + summaryWidth - 105, y + 2, { width: 100, align: 'right' });
      }
      y += summaryRowHeight;
    });

    doc.end();
  });
}
