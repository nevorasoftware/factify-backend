import { montoEnLetras } from '../utils/letras';
import {
  IVA, round2, direccionObligatoria, documentosRelacionadosV2, emisorV2, identificacionV2,
  lineasBase, pagosV2, sumarLineas, textoONull, validarYNumerar
} from './v2';

// En el crédito fiscal el precio no incluye IVA; se suma como tributo 20.
export async function construirDte03(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const identificacion = identificacionV2(req, '03', versionDte, emisorDb);
  const lineas = lineasBase(cuerpoDocumento).map((l: any) => ({
    ...l,
    tributos: l.ventaGravada > 0 ? ['20'] : null
  }));

  const sumas = sumarLineas(lineas);
  const iva = round2(sumas.totalGravada * IVA);
  const ivaPerci = round2(Number(resumen?.ivaPerci ?? resumen?.ivaPerci1) || 0);
  const ivaRete = round2(Number(resumen?.ivaRete ?? resumen?.ivaRete1) || 0);

  const subTotal = sumas.subTotalVentas;
  const montoTotalOperacion = round2(subTotal + iva);
  const totalPagar = round2(montoTotalOperacion + ivaPerci - ivaRete);

  const documento = {
    identificacion,
    documentoRelacionado: documentosRelacionadosV2(req.body.documentoRelacionado, identificacion.fecEmi),
    emisor: emisorV2(emisorDb),
    receptor: {
      nit: String(receptor?.numDocumento ?? receptor?.nit ?? '').replace(/-/g, '').trim(),
      nrc: textoONull(receptor?.nrc)?.replace(/-/g, '') ?? null,
      nombre: textoONull(receptor?.nombre),
      codActividad: textoONull(receptor?.codActividad),
      descActividad: textoONull(receptor?.descActividad),
      nombreComercial: textoONull(receptor?.nombreComercial),
      direccion: direccionObligatoria(receptor?.direccion, 'el receptor'),
      telefono: textoONull(receptor?.telefono),
      correo: textoONull(receptor?.correo)
    },
    otrosDocumentos: null,
    ventaTercero: null,
    cuerpoDocumento: lineas,
    resumen: {
      ...sumas,
      descuNoSuj: 0,
      descuExenta: 0,
      descuGravada: 0,
      porcentajeDescuento: 0,
      tributos: iva > 0 ? [{ codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: iva }] : null,
      subTotal,
      ivaPerci,
      ivaRete,
      montoTotalOperacion,
      totalNoGravado: 0,
      totalPagar,
      totalLetras: montoEnLetras(totalPagar),
      saldoFavor: 0,
      condicionOperacion: Number(resumen?.condicionOperacion) || 1,
      pagos: pagosV2(resumen, totalPagar),
      numPagoElectronico: textoONull(resumen?.numPagoElectronico),
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '03', emisorDb);
}
