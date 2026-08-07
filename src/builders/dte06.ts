import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo } from './common';

export async function construirDte06(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen, documentoRelacionado } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  // Hacienda no permite codEstable ni codPuntoVenta en emisor para DTE 06
  delete (emisorSanitized as any).codEstableMH;
  delete (emisorSanitized as any).codPuntoVentaMH;
  delete (emisorSanitized as any).codEstable;
  delete (emisorSanitized as any).codPuntoVenta;

  const codEstable = String(emisorDb.cod_establecimiento_mh || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorDb.cod_punto_venta_mh || "0000").trim().padStart(4, '0');

  // 1. Sanear Receptor
  const receptorSanitized = {
    nit: String(receptor?.nit || "00000000000000").toUpperCase().trim(),
    nrc: receptor?.nrc || "000000",
    nombre: receptor?.nombre || "Receptor Nota Debito",
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
    const ventaGravada = round2(item.ventaGravada || 0);

    let numDocRel = item.numeroDocumento;
    if (!numDocRel && documentoRelacionado && documentoRelacionado[0]) {
      numDocRel = documentoRelacionado[0].numeroDocumento || documentoRelacionado[0].numDoc || documentoRelacionado[0].codigoGeneracion;
    }
    if (!numDocRel) numDocRel = "00000000-0000-0000-0000-000000000000";

    return {
      numItem: idx + 1,
      tipoItem: item.tipoItem || 1,
      numeroDocumento: String(numDocRel).toUpperCase().trim(),
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
      tributos: ventaGravada > 0 ? ["20"] : null
    };
  });

  // 3. Sanear Resumen
  const totalNoSuj = round2(resumen?.totalNoSuj || 0);
  const totalExenta = round2(resumen?.totalExenta || 0);
  const totalGravada = round2(resumen?.totalGravada || 0);
  const totalDescu = round2(resumen?.totalDescu || 0);

  let tributosSanitized = null;
  let sumaTributos = 0;
  if (resumen?.tributos && resumen.tributos.length > 0) {
    const validTributos = resumen.tributos.filter((t: any) => t.codigo !== '20');
    if (validTributos.length > 0) {
      tributosSanitized = validTributos;
      sumaTributos = validTributos.reduce((acc: number, curr: any) => acc + round2(curr.valor), 0);
    }
  }

  const subTotalVentas = round2(totalNoSuj + totalExenta + totalGravada);
  const subTotal = round2(subTotalVentas - totalDescu);

  const totalIva = round2(
    cuerpoDocumento.reduce((acc: number, item: any) => {
      const vG = round2(item.ventaGravada || 0);
      const iva = item.ivaItem ? Number(item.ivaItem) : round2(vG * 0.13);
      return acc + iva;
    }, 0)
  );

  if (totalIva > 0) {
    if (!tributosSanitized) tributosSanitized = [];
    const hasIva = tributosSanitized.find((t: any) => t.codigo === '20');
    if (!hasIva) {
      tributosSanitized.push({
        codigo: "20",
        descripcion: "Impuesto al Valor Agregado 13%",
        valor: totalIva
      });
      sumaTributos = round2(sumaTributos + totalIva);
    }
  }

  const ivaPerci1 = round2(resumen?.ivaPerci1 || 0);
  const ivaRete1 = round2(resumen?.ivaRete1 || 0);
  const reteRenta = round2(resumen?.reteRenta || 0);
  const montoTotalOperacion = round2(subTotal + sumaTributos + ivaPerci1);

  const resumenSanitized = {
    totalNoSuj,
    totalExenta,
    totalGravada,
    subTotalVentas,
    descuNoSuj: round2(resumen?.descuNoSuj || 0),
    descuExenta: round2(resumen?.descuExenta || 0),
    descuGravada: round2(resumen?.descuGravada || 0),
    totalDescu,
    tributos: tributosSanitized,
    subTotal,
    ivaPerci1,
    ivaRete1,
    reteRenta,
    montoTotalOperacion,
    totalLetras: resumen?.totalLetras || "CERO DOLARES",
    condicionOperacion: resumen?.condicionOperacion || 1,
    numPagoElectronico: resumen?.numPagoElectronico || null
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '06',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('06', emisorDb.id, codEstable, codPunto, 1);
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
      tipoDte: '06',
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
