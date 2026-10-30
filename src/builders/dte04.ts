import { montoEnLetras } from '../utils/letras';
import {
  IVA, round2, documentosRelacionadosV2, emisorV2, identificacionV2, lineasBase,
  receptorConDocumento, sumarLineas, textoONull, validarYNumerar
} from './v2';

// La nota de remisión ampara el traslado de bienes: no lleva pagos ni total a pagar.
export async function construirDte04(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const identificacion = identificacionV2(req, '04', versionDte, emisorDb);
  const lineas = lineasBase(cuerpoDocumento).map(({ psv, noGravado, ...l }: any) => ({
    ...l,
    tributos: l.ventaGravada > 0 ? ['20'] : null
  }));

  const sumas = sumarLineas(lineas);
  const iva = round2(sumas.totalGravada * IVA);
  const subTotal = sumas.subTotalVentas;
  const montoTotalOperacion = round2(subTotal + iva);

  const documento = {
    identificacion,
    documentoRelacionado: documentosRelacionadosV2(req.body.documentoRelacionado, identificacion.fecEmi),
    emisor: emisorV2(emisorDb),
    receptor: {
      ...receptorConDocumento(receptor),
      bienTitulo: String(receptor?.bienTitulo || '').padStart(2, '0')
    },
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
      montoTotalOperacion,
      totalLetras: montoEnLetras(montoTotalOperacion),
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '04', emisorDb);
}
