import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import { round2, documentosRelacionadosV2, emisorV2, identificacionV2, lineasBase, pagosV2, redondear, textoONull, validarYNumerar } from './v2';

function datosExportacion(req: any) {
  const datos = req.body.exportacion || {};
  const tipoItemExpor = Number(datos.tipoItemExpor);
  if (![1, 2, 3].includes(tipoItemExpor)) {
    throw new DteInvalidoError('Indique si exporta bienes, servicios o ambos.');
  }
  // Los servicios no pasan por aduana: no llevan recinto ni régimen.
  if (tipoItemExpor === 2) return { tipoItemExpor, recintoFiscal: null, tipoRegimen: null, regimen: null };
  const recintoFiscal = textoONull(datos.recintoFiscal);
  const tipoRegimen = textoONull(datos.tipoRegimen);
  const regimen = textoONull(datos.regimen);
  if (!recintoFiscal || !tipoRegimen || !regimen) {
    throw new DteInvalidoError('La exportación de bienes requiere recinto fiscal, tipo de régimen y régimen.');
  }
  return { tipoItemExpor, recintoFiscal, tipoRegimen, regimen };
}

// La exportación no lleva IVA: tributo C3 al 0%.
export async function construirDte11(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const identificacion = identificacionV2(req, '11', versionDte, emisorDb);
  const lineas = lineasBase(cuerpoDocumento).map((l: any) => ({
    numItem: l.numItem,
    tipoItem: l.tipoItem,
    numeroDocumento: l.numeroDocumento,
    cantidad: l.cantidad,
    codigo: l.codigo,
    codTributo: null,
    uniMedida: l.uniMedida,
    descripcion: l.descripcion,
    precioUni: l.precioUni,
    montoDescu: l.montoDescu,
    ventaGravada: redondear(l.ventaGravada + l.ventaExenta + l.ventaNoSuj, 8),
    tributos: ['C3'],
    noGravado: 0
  }));

  const totalGravada = round2(lineas.reduce((a: number, l: any) => a + l.ventaGravada, 0));
  const totalDescu = round2(lineas.reduce((a: number, l: any) => a + l.montoDescu, 0));
  const seguro = round2(Number(resumen?.seguro) || 0);
  const flete = round2(Number(resumen?.flete) || 0);
  const montoTotalOperacion = round2(totalGravada + seguro + flete);
  const totalPagar = montoTotalOperacion;

  const documento = {
    identificacion,
    documentoRelacionado: documentosRelacionadosV2(req.body.documentoRelacionado, identificacion.fecEmi),
    emisor: { ...emisorV2(emisorDb), ...datosExportacion(req) },
    receptor: {
      nombre: textoONull(receptor?.nombre),
      tipoDocumento: textoONull(receptor?.tipoDocumento),
      numDocumento: textoONull(receptor?.numDocumento ?? receptor?.nit),
      descActividad: textoONull(receptor?.descActividad),
      nombreComercial: textoONull(receptor?.nombreComercial),
      codPais: textoONull(receptor?.codPais),
      nombrePais: textoONull(receptor?.nombrePais),
      complemento: textoONull(receptor?.complemento),
      tipoPersona: Number(receptor?.tipoPersona),
      telefono: textoONull(receptor?.telefono),
      correo: textoONull(receptor?.correo)
    },
    otrosDocumentos: null,
    ventaTercero: null,
    compraTercero: null,
    cuerpoDocumento: lineas,
    resumen: {
      totalGravada,
      descuGravada: 0,
      porcentajeDescuento: 0,
      totalDescu,
      seguro,
      flete,
      tributos: [{ codigo: 'C3', descripcion: 'Impuesto al Valor Agregado (exportaciones) 0%', valor: 0 }],
      montoTotalOperacion,
      totalNoGravado: 0,
      totalNoOnerosas: 0,
      totalPagar,
      totalLetras: montoEnLetras(totalPagar),
      saldoFavor: 0,
      condicionOperacion: Number(resumen?.condicionOperacion) || 1,
      pagos: pagosV2(resumen, totalPagar),
      codIncoterms: textoONull(resumen?.codIncoterms),
      descIncoterms: textoONull(resumen?.descIncoterms),
      numPagoElectronico: textoONull(resumen?.numPagoElectronico),
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '11', emisorDb);
}
