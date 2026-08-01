import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo, obtenerIdentificacionBase } from './common';

export async function construirDte08(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  const codEstable = String(emisorSanitized.codEstableMH || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorSanitized.codPuntoVentaMH || "0000").trim().padStart(4, '0');

  // 1. Sanear Receptor
  const receptorSanitized = {
    nit: String(receptor?.nit || "00000000000000").toUpperCase().trim(),
    nrc: receptor?.nrc || "000000",
    nombre: receptor?.nombre || "Receptor Liquidacion",
    codActividad: receptor?.codActividad || "46900",
    descActividad: receptor?.descActividad || "Comercio al por mayor no especializado",
    nombreComercial: receptor?.nombreComercial || receptor?.nombre || "Receptor Comercial",
    direccion: receptor?.direccion ? {
      departamento: receptor.direccion.departamento || "01",
      municipio: receptor.direccion.municipio || "01",
      complemento: (receptor.direccion.complemento && receptor.direccion.complemento.trim().length >= 10) 
        ? receptor.direccion.complemento.trim() 
        : "San Salvador, El Salvador"
    } : { departamento: "01", municipio: "01", complemento: "San Salvador, El Salvador" },
    telefono: receptor?.telefono || "22222222",
    correo: receptor?.correo || "correo@ejemplo.com"
  };

  // 2. Sanear Cuerpo Documento
  const cuerpoSanitized = cuerpoDocumento.map((item: any, idx: number) => {
    const docType = item.tipoDte || item.tipoDocumento || "03";
    const isExport = docType === '11';
    const grossAmt = round2(item.montoTotal || item.exportaciones || 0);

    const exportaciones = isExport ? grossAmt : 0;
    const ventaGravada = !isExport ? grossAmt : 0;
    const ivaItem = round2(item.ivaItem || 0);

    return {
      numItem: idx + 1,
      tipoDte: docType, 
      tipoGeneracion: item.tipoGeneracion ? Number(item.tipoGeneracion) : 1, 
      numeroDocumento: String(item.numeroDocumento || item.codigoGeneracion || "00000000-0000-0000-0000-000000000000").toUpperCase().trim(),
      fechaGeneracion: item.fechaGeneracion || item.fechaDocumento || fecEmi,
      exportaciones: exportaciones,
      ivaItem: ivaItem,
      obsItem: item.obsItem || "Liquidacion de operacion",
      ventaNoSuj: 0,
      ventaExenta: 0,
      ventaGravada: ventaGravada,
      tributos: []
    };
  });

  // 3. Sanear Resumen
  const totalExportacion = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.exportaciones || 0), 0));
  const ivaPerci = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ivaItem || 0), 0));
  const totalNoSuj = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ventaNoSuj || 0), 0));
  const totalExenta = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ventaExenta || 0), 0));
  const totalGravada = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ventaGravada || 0), 0));
  const subTotalVentas = round2(totalNoSuj + totalExenta + totalGravada);
  const totalVal = round2(totalExportacion + subTotalVentas + ivaPerci);

  const resumenSanitized = {
    totalExportacion,
    ivaPerci,
    total: totalVal,
    totalNoSuj,
    totalExenta,
    totalGravada,
    subTotalVentas,
    tributos: [],
    montoTotalOperacion: totalVal,
    totalLetras: resumen?.totalLetras || "CERO DOLARES",
    condicionOperacion: resumen?.condicionOperacion || 1
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '08',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('08', emisorDb.id, codEstable, codPunto, 1);
  }

  const codGeneracion = req.body.identificacion?.codigoGeneracion
    ? req.body.identificacion.codigoGeneracion.toUpperCase()
    : uuidv4().toUpperCase();

  const dteBase: any = {
    identificacion: obtenerIdentificacionBase(
      req.body.identificacion || {},
      '08',
      numControl,
      codGeneracion,
      fecEmi,
      horEmi,
      emisorDb
    ),
    emisor: emisorSanitized,
    receptor: receptorSanitized,
    cuerpoDocumento: cuerpoSanitized,
    resumen: resumenSanitized,
    apendice: null
  };

  return dteBase;
}
