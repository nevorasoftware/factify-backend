import { v4 as uuidv4 } from 'uuid';
import { round2, obtenerEmisorBase, sanearNumeroControl, obtenerSiguienteCorrelativo, obtenerIdentificacionBase } from './common';

export async function construirDte09(req: any, versionDte: number, emisorDb: any) {
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
    nombre: receptor?.nombre || "Receptor Liquidacion Contable",
    nombreComercial: receptor?.nombreComercial || receptor?.nombre || "Receptor Comercial",
    codActividad: receptor?.codActividad || "46900",
    descActividad: receptor?.descActividad || "Comercio al por mayor no especializado",
    tipoEstablecimiento: receptor?.tipoEstablecimiento || "01",
    codigoMH: receptor?.codigoMH || "0000",
    puntoVentaMH: receptor?.puntoVentaMH || "0000",
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
    const montoSujetoGrav = round2(item.montoSujetoGrav || item.montoGravado || item.montoTotal || item.ventaGravada || 0);
    const ivaPercibido = round2(item.ivaPercibido || item.montoPercepcionIVA || item.montoRetencion || (montoSujetoGrav ? montoSujetoGrav * 0.01 : 0));

    return {
      numItem: idx + 1,
      tipoDte: item.tipoDte || item.tipoDocumento || "03", 
      tipoDoc: item.tipoDoc ? Number(item.tipoDoc) : (item.tipoGeneracion ? Number(item.tipoGeneracion) : 1), 
      numDocumento: String(item.codigoGeneracion || item.numDocumento || item.numeroDocumento || "00000000-0000-0000-0000-000000000000").toUpperCase().trim(),
      fechaEmision: item.fechaEmision || item.fechaGeneracion || item.fechaDocumento || fecEmi,
      montoSujetoGrav: montoSujetoGrav,
      ivaPercibido: ivaPercibido, 
      descripcion: item.descripcion || "Percepcion de IVA"
    };
  });

  // 3. Sanear Resumen
  const totalSujetoRetencion = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.montoSujetoGrav || 0), 0));
  const totalIVAretenido = round2(cuerpoSanitized.reduce((acc: number, curr: any) => acc + (curr.ivaPercibido || 0), 0));

  const resumenSanitized = {
    totalSujetoRetencion,
    totalIVAretenido,
    totalIVAretenidoLetras: resumen?.totalIVAretenidoLetras || "CERO DOLARES"
  };

  // 4. Secuencial de Control
  let { numControl, needsGeneration, codEstableUsed, codPuntoUsed } = sanearNumeroControl(
    req.body.identificacion?.numeroControl,
    '09',
    codEstable,
    codPunto,
    emisorDb.id
  );

  if (needsGeneration) {
    numControl = await obtenerSiguienteCorrelativo('09', emisorDb.id, codEstable, codPunto, 1);
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
    identificacion: obtenerIdentificacionBase(
      req.body.identificacion || {},
      '09',
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
