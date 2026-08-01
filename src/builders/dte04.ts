import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo, obtenerIdentificacionBase } from './common';

export async function construirDte04(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen, documentoRelacionado } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  const codEstable = String(emisorSanitized.codEstableMH || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorSanitized.codPuntoVentaMH || "0000").trim().padStart(4, '0');

  // 1. Sanear Receptor para DTE 04 (Nota de Remisión)
  const receptorSanitized = {
    tipoDocumento: receptor?.tipoDocumento || "36",
    numDocumento: String(receptor?.numDocumento || receptor?.nit || "00000000000000").toUpperCase().trim(),
    nrc: receptor?.nrc || null,
    nombre: receptor?.nombre || "Receptor Nota Remision",
    nombreComercial: receptor?.nombreComercial || receptor?.nombre || "Receptor Nota Remision",
    codActividad: receptor?.codActividad || "10005",
    descActividad: receptor?.descActividad || "Otros",
    direccion: receptor?.direccion || { departamento: "01", municipio: "01", complemento: "San Salvador, El Salvador" },
    telefono: receptor?.telefono || "22222222",
    correo: receptor?.correo || "correo@ejemplo.com",
    bienTitulo: receptor?.bienTitulo ? String(receptor.bienTitulo).padStart(2, '0') : "01"
  };

  // 2. Sanear Cuerpo Documento para DTE 04
  const cuerpoSanitized = cuerpoDocumento.map((item: any, idx: number) => {
    const ventaGravada = round2(item.ventaGravada || 0);
    const numDocRel = item.numeroDocumento ? String(item.numeroDocumento).toUpperCase().trim() : null;

    return {
      numItem: idx + 1,
      tipoItem: item.tipoItem || 1,
      numeroDocumento: numDocRel,
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
      tributos: item.tributos && item.tributos.length > 0 ? item.tributos : null
    };
  });

  // 3. Sanear Resumen para DTE 04
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
  const montoTotalOperacion = subTotal;

  const resumenSanitized = {
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
    montoTotalOperacion,
    totalLetras: resumen?.totalLetras || "CERO DOLARES"
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '04',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('04', emisorDb.id, codEstable, codPunto, 1);
  }

  const codGeneracion = req.body.identificacion?.codigoGeneracion
    ? req.body.identificacion.codigoGeneracion.toUpperCase()
    : uuidv4().toUpperCase();

  const documentoRelacionadoSanitized = (documentoRelacionado && documentoRelacionado.length > 0)
    ? documentoRelacionado.map((doc: any) => ({
        tipoDocumento: doc.tipoDocumento || "03",
        tipoGeneracion: doc.tipoGeneracion ? Number(doc.tipoGeneracion) : 1,
        numeroDocumento: doc.numeroDocumento ? String(doc.numeroDocumento).toUpperCase().trim() : "",
        fechaEmision: doc.fechaEmision || fecEmi
      }))
    : null;

  const dteBase: any = {
    identificacion: {
      version: req.body.identificacion?.version || versionDte || 3,
      ambiente: emisorDb.ambiente || '00',
      tipoDte: '04',
      numeroControl: numControl,
      codigoGeneracion: codGeneracion,
      tipoModelo: req.body.identificacion?.tipoModelo || 1,
      tipoOperacion: req.body.identificacion?.tipoOperacion || 1,
      tipoContingencia: req.body.identificacion?.tipoContingencia || null,
      motivoContin: req.body.identificacion?.motivoContin || req.body.identificacion?.motivoContigencia || null,
      fecEmi: req.body.identificacion?.fecEmi || fecEmi,
      horEmi: req.body.identificacion?.horEmi || horEmi,
      tipoMoneda: req.body.identificacion?.tipoMoneda || 'USD'
    },
    documentoRelacionado: documentoRelacionadoSanitized,
    emisor: emisorSanitized,
    receptor: receptorSanitized,
    ventaTercero: null,
    cuerpoDocumento: cuerpoSanitized,
    resumen: resumenSanitized,
    extension: null,
    apendice: null
  };

  return dteBase;
}
