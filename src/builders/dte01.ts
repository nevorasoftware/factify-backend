import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo, obtenerIdentificacionBase } from './common';

export async function construirDte01(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  const codEstable = String(emisorSanitized.codEstableMH || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorSanitized.codPuntoVentaMH || "0000").trim().padStart(4, '0');

  // 1. Sanear Receptor
  let receptorSanitized: any = null;
  if (receptor && receptor.nombre) {
    receptorSanitized = {
      tipoDocumento: receptor.tipoDocumento || "36",
      numDocumento: String(receptor.numDocumento || receptor.nit || "00000000000000").toUpperCase().trim(),
      nrc: receptor.nrc || null,
      nombre: receptor.nombre,
      codActividad: receptor.codActividad || null,
      descActividad: receptor.descActividad || null,
      direccion: receptor.direccion || null,
      telefono: receptor.telefono || null,
      correo: receptor.correo || null
    };
  } else {
    receptorSanitized = {
      tipoDocumento: "13",
      numDocumento: "00000000-0",
      nrc: null,
      nombre: "Consumidor Final",
      codActividad: null,
      descActividad: null,
      direccion: null,
      telefono: null,
      correo: null
    };
  }

  // 2. Sanear Cuerpo Documento
  const cuerpoSanitized = cuerpoDocumento.map((item: any, idx: number) => {
    const ventaGravada = round2(item.ventaGravada || 0);
    const ivaCalculado = item.ivaItem ? Number(item.ivaItem) : round2(ventaGravada - (ventaGravada / 1.13));

    return {
      numItem: idx + 1,
      tipoItem: item.tipoItem || 1,
      numeroDocumento: item.numeroDocumento || null,
      codigo: item.codigo || null,
      codTributo: item.codTributo || null,
      descripcion: item.descripcion || "Item",
      cantidad: Number(item.cantidad || 1),
      uniMedida: item.uniMedida || 59,
      precioUni: round2(item.precioUni || 0),
      montoDescu: round2(item.montoDescu || 0),
      ventaNoSuj: round2(item.ventaNoSuj || 0),
      ventaExenta: round2(item.ventaExenta || 0),
      ventaGravada: ventaGravada,
      tributos: item.tributos && item.tributos.length > 0 ? item.tributos : null,
      psv: round2(item.psv || 0),
      noGravado: round2(item.noGravado || 0),
      ivaItem: round2(ivaCalculado)
    };
  });

  // 3. Sanear Resumen
  const totalNoSuj = round2(resumen?.totalNoSuj || 0);
  const totalExenta = round2(resumen?.totalExenta || 0);
  const totalGravada = round2(resumen?.totalGravada || 0);
  const totalDescu = round2(resumen?.totalDescu || 0);

  let tributosSanitized = null;
  if (resumen?.tributos && resumen.tributos.length > 0) {
    const validTributos = resumen.tributos.filter((t: any) => t.codigo !== '20');
    if (validTributos.length > 0) {
      tributosSanitized = validTributos;
    }
  }

  const subTotalVentas = round2(totalNoSuj + totalExenta + totalGravada);
  const subTotal = round2(subTotalVentas - totalDescu);
  const totalIva = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ivaItem || 0), 0));
  
  const ivaPerci1 = round2(resumen?.ivaPerci1 || 0);
  const ivaRete1 = round2(resumen?.ivaRete1 || 0);
  const reteRenta = round2(resumen?.reteRenta || 0);
  const totalNoGravado = round2(resumen?.totalNoGravado || 0);
  const saldoFavor = round2(resumen?.saldoFavor || 0);

  const montoTotalOperacion = round2(subTotal + ivaPerci1);
  let totalPagar = round2(montoTotalOperacion - ivaRete1 - reteRenta + totalNoGravado - saldoFavor);
  if (totalPagar < 0) totalPagar = 0;

  const resumenSanitized: any = {
    totalNoSuj,
    totalExenta,
    totalGravada,
    subTotalVentas,
    descuNoSuj: round2(resumen?.descuNoSuj || 0),
    descuExenta: round2(resumen?.descuExenta || 0),
    descuGravada: round2(resumen?.descuGravada || 0),
    porcentajeDescuento: round2(resumen?.porcentajeDescuento || 0),
    totalDescu,
    tributos: tributosSanitized,
    subTotal,
    ivaRete1,
    reteRenta,
    montoTotalOperacion,
    totalNoGravado,
    totalPagar,
    totalLetras: resumen?.totalLetras || "CERO DOLARES",
    saldoFavor,
    condicionOperacion: resumen?.condicionOperacion || 1,
    pagos: (resumen?.pagos && resumen.pagos.length > 0) ? resumen.pagos.map((p: any) => ({
      codigo: p.codigo || "01",
      montoPago: round2(p.montoPago || totalPagar),
      referencia: p.referencia || null,
      plazo: p.plazo || null,
      periodo: p.periodo || null
    })) : [{ codigo: "01", montoPago: totalPagar, referencia: null, plazo: null, periodo: null }],
    numPagoElectronico: resumen?.numPagoElectronico || null,
    totalIva
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration, codEstableUsed, codPuntoUsed } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '01',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('01', emisorDb.id, codEstable, codPunto, 1);
    codEstableUsed = codEstable;
    codPuntoUsed = codPunto;
  }

  emisorSanitized.codEstableMH = codEstableUsed;
  emisorSanitized.codEstable = codEstableUsed;
  emisorSanitized.codPuntoVentaMH = codPuntoUsed;
  emisorSanitized.codPuntoVenta = codPuntoUsed;

  const codGeneracion = req.body.identificacion?.codigoGeneracion
    ? req.body.identificacion.codigoGeneracion.toUpperCase()
    : uuidv4().toUpperCase();

  const documentoRelacionadoSanitized = (req.body.documentoRelacionado && req.body.documentoRelacionado.length > 0)
    ? req.body.documentoRelacionado.map((doc: any) => ({
        tipoDocumento: doc.tipoDocumento || "03", 
        tipoGeneracion: doc.tipoGeneracion ? Number(doc.tipoGeneracion) : 1, 
        numeroDocumento: doc.numeroDocumento ? String(doc.numeroDocumento).toUpperCase().trim() : "",
        fechaEmision: doc.fechaEmision || fecEmi
      }))
    : null;

  const dteBase: any = {
    identificacion: obtenerIdentificacionBase(
      req.body.identificacion || {},
      '01',
      numControl,
      codGeneracion,
      fecEmi,
      horEmi,
      emisorDb
    ),
    documentoRelacionado: documentoRelacionadoSanitized,
    emisor: emisorSanitized,
    receptor: receptorSanitized,
    otrosDocumentos: null,
    ventaTercero: null,
    cuerpoDocumento: cuerpoSanitized,
    resumen: resumenSanitized,
    extension: null,
    apendice: null
  };

  return dteBase;
}
