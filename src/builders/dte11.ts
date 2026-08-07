import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo } from './common';

export async function construirDte11(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const fechaActual = new Date();
  const fecEmi = fechaActual.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  const horEmi = fechaActual.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false });

  const emisorSanitized = obtenerEmisorBase(emisorDb);
  const codEstable = String(emisorSanitized.codEstableMH || "0000").trim().padStart(4, '0');
  const codPunto = String(emisorSanitized.codPuntoVentaMH || "0000").trim().padStart(4, '0');

  // Configuración de exportación del emisor
  emisorSanitized.tipoEstablecimiento = "01";
  (emisorSanitized as any).tipoItemExpor = req.body.emisor?.tipoItemExpor ? Number(req.body.emisor.tipoItemExpor) : 1;
  (emisorSanitized as any).recintoFiscal = req.body.emisor?.recintoFiscal || "01";
  (emisorSanitized as any).regimen = req.body.emisor?.regimen || "RE";

  // 1. Sanear Receptor para DTE 11 (Exportaciones)
  const receptorSanitized: any = {
    tipoPersona: receptor?.tipoPersona ? Number(receptor.tipoPersona) : 2,
    tipoDocumento: receptor?.tipoDocumento || "37",
    numDocumento: String(receptor?.numDocumento || receptor?.nit || "99999999").toUpperCase().trim(),
    nombre: receptor?.nombre || "Receptor de Exportacion",
    nombreComercial: receptor?.nombreComercial || receptor?.nombre || "Receptor Comercial",
    codPais: (() => {
      const rawPais = String(receptor?.pais || receptor?.codPais || "9450").trim().toUpperCase();
      const countryMap: Record<string, string> = {
        'US': '9450', 'USA': '9450', '840': '9450', 'ESTADOS UNIDOS': '9450',
        'ESTADOS UNIDOS DE AMERICA': '9450', 'ESTADOS UNIDOS DE AMÉRICA': '9450',
        'UNITED STATES': '9450', 'UNITED STATES OF AMERICA': '9450',
        'SV': '9300', 'SLV': '9300', 'EL SALVADOR': '9300', '068': '9300', '9300': '9300',
        'GT': '9320', 'GTM': '9320', 'GUATEMALA': '9320', '320': '9320', '9320': '9320',
        'HN': '9501', 'HND': '9501', 'HONDURAS': '9501', '340': '9501', '9501': '9501',
        'NI': '9558', 'NIC': '9558', 'NICARAGUA': '9558', '558': '9558', '9558': '9558',
        'PA': '9591', 'PAN': '9591', 'PANAMA': '9591', 'PANAMÁ': '9591', '591': '9591', '9591': '9591'
      };
      if (countryMap[rawPais]) return countryMap[rawPais];
      for (const [key, val] of Object.entries(countryMap)) {
        if (isNaN(Number(key)) && (rawPais.includes(key) || key.includes(rawPais))) return val;
      }
      if (/^9\d{3}$/.test(rawPais)) return rawPais;
      return '9999';
    })(),
    nombrePais: receptor?.nombrePais || "ESTADOS UNIDOS",
    complemento: (receptor?.complemento && receptor.complemento.trim().length >= 10)
      ? receptor.complemento.trim()
      : (receptor?.direccion?.complemento && receptor.direccion.complemento.trim().length >= 10)
        ? receptor.direccion.complemento.trim()
        : "Miami, Florida, USA",
    descActividad: receptor?.descActividad || "Otros",
    telefono: receptor?.telefono || null,
    correo: receptor?.correo || null
  };

  if (!receptorSanitized.telefono) delete receptorSanitized.telefono;
  if (!receptorSanitized.correo) delete receptorSanitized.correo;

  // 2. Sanear Cuerpo Documento para DTE 11
  const cuerpoSanitized = cuerpoDocumento.map((item: any, idx: number) => {
    const precioUni = round2(item.precioUni || item.precioUnitario || 0);
    const cantidad = Number(item.cantidad || 1);
    const montoSujetoExporRaw = round2(precioUni * cantidad);
    const montoDescu = round2(item.montoDescu || 0);
    const ventaGravada = round2(montoSujetoExporRaw - montoDescu);

    return {
      numItem: idx + 1,
      codigo: item.codigo || "EXP-001",
      uniMedida: item.uniMedida ? Number(item.uniMedida) : 59,
      descripcion: item.descripcion || "Exportacion de bienes/servicios",
      cantidad: cantidad,
      precioUni: precioUni,
      montoDescu: montoDescu,
      ventaGravada: ventaGravada,
      tributos: null,
      noGravado: round2(item.noGravado || 0)
    };
  });

  // 3. Sanear Resumen para DTE 11
  const totalGravada = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ventaGravada || 0), 0));
  const totalDescu = round2(resumen?.totalDescu || resumen?.descuento || 0);
  const flete = resumen?.flete !== undefined && resumen?.flete !== null ? round2(resumen.flete) : 0;
  const seguro = resumen?.seguro !== undefined && resumen?.seguro !== null ? round2(resumen.seguro) : 0;
  const totalNoGravado = round2(resumen?.totalNoGravado || 0);
  const montoTotalOperacion = round2(totalGravada + flete + seguro);
  const totalPagar = round2(montoTotalOperacion - totalDescu);

  const resumenSanitized = {
    totalGravada,
    descuento: totalDescu,
    porcentajeDescuento: round2(resumen?.porcentajeDescuento || 0),
    totalDescu,
    montoTotalOperacion,
    totalNoGravado,
    totalPagar,
    totalLetras: resumen?.totalLetras || "CERO DOLARES",
    condicionOperacion: resumen?.condicionOperacion !== undefined ? Number(resumen.condicionOperacion) : 1,
    pagos: (resumen?.pagos && Array.isArray(resumen.pagos) && resumen.pagos.length > 0) ? resumen.pagos.map((p: any) => ({
      codigo: p.codigo || "01",
      montoPago: round2(p.montoPago || totalPagar),
      referencia: p.referencia !== undefined ? p.referencia : null,
      plazo: p.plazo !== undefined ? p.plazo : null,
      periodo: p.periodo !== undefined ? p.periodo : null
    })) : null,
    codIncoterms: resumen?.codIncoterms !== undefined ? resumen.codIncoterms : null,
    descIncoterms: resumen?.descIncoterms !== undefined ? resumen.descIncoterms : null,
    flete,
    seguro,
    observaciones: resumen?.observaciones !== undefined ? resumen.observaciones : null,
    numPagoElectronico: resumen?.numPagoElectronico !== undefined ? resumen.numPagoElectronico : null
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration, codEstableUsed, codPuntoUsed } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '11',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('11', emisorDb.id, codEstable, codPunto, 1);
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

  const dteBase: any = {
    identificacion: {
      version: req.body.identificacion?.version || versionDte || 1,
      ambiente: emisorDb.ambiente || '00',
      tipoDte: '11',
      numeroControl: numControl,
      codigoGeneracion: codGeneracion,
      tipoModelo: req.body.identificacion?.tipoModelo || 1,
      tipoOperacion: req.body.identificacion?.tipoOperacion || 1,
      tipoContingencia: req.body.identificacion?.tipoContingencia || null,
      motivoContigencia: req.body.identificacion?.motivoContigencia || req.body.identificacion?.motivoContin || null,
      fecEmi: req.body.identificacion?.fecEmi || fecEmi,
      horEmi: req.body.identificacion?.horEmi || horEmi,
      tipoMoneda: req.body.identificacion?.tipoMoneda || 'USD'
    },
    emisor: emisorSanitized,
    receptor: receptorSanitized,
    otrosDocumentos: req.body.otrosDocumentos || null,
    ventaTercero: null,
    cuerpoDocumento: cuerpoSanitized,
    resumen: resumenSanitized,
    apendice: null
  };

  return dteBase;
}
