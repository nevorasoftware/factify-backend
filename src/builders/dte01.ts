import { montoEnLetras } from '../utils/letras';
import {
  IVA, round2, direccionObligatoria, documentosRelacionadosV2, emisorV2, identificacionV2,
  lineasBase, numeroDocumentoMH, pagosV2, sumarLineas, textoONull, tipoDocumentoReceptor, validarYNumerar
} from './v2';

function receptorFactura(receptor: any) {
  const nombre = textoONull(receptor?.nombre);
  const documento = textoONull(receptor?.numDocumento ?? receptor?.nit);

  // Consumidor final sin identificar
  if (!nombre && !documento) {
    return {
      tipoDocumento: null, numDocumento: null, nrc: null, nombre: null, codActividad: null,
      descActividad: null, direccion: null, telefono: null, correo: textoONull(receptor?.correo)
    };
  }

  const tipo = textoONull(receptor?.tipoDocumento) || (documento ? tipoDocumentoReceptor(documento) : null);
  const numDocumento = numeroDocumentoMH(tipo, documento);
  const dir = receptor?.direccion;

  return {
    tipoDocumento: tipo,
    numDocumento,
    nrc: textoONull(receptor?.nrc)?.replace(/-/g, '') ?? null,
    nombre,
    codActividad: textoONull(receptor?.codActividad),
    descActividad: textoONull(receptor?.descActividad),
    direccion: dir?.distrito ? direccionObligatoria(dir, 'del receptor') : null,
    telefono: textoONull(receptor?.telefono),
    correo: textoONull(receptor?.correo)
  };
}

// En la factura el precio incluye IVA; el IVA contenido se informa aparte.
export async function construirDte01(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const identificacion = identificacionV2(req, '01', versionDte, emisorDb);
  const lineas = lineasBase(cuerpoDocumento).map((l: any) => ({
    ...l,
    tributos: null,
    ivaItem: round2(l.ventaGravada * IVA / (1 + IVA))
  }));

  const sumas = sumarLineas(lineas);
  const totalIva = round2(lineas.reduce((a: number, l: any) => a + l.ivaItem, 0));
  const ivaRete = round2(Number(resumen?.ivaRete ?? resumen?.ivaRete1) || 0);

  const subTotal = sumas.subTotalVentas;
  const montoTotalOperacion = subTotal;
  const totalPagar = round2(montoTotalOperacion - ivaRete);

  const documento = {
    identificacion,
    documentoRelacionado: documentosRelacionadosV2(req.body.documentoRelacionado, identificacion.fecEmi),
    emisor: emisorV2(emisorDb),
    receptor: receptorFactura(receptor),
    otrosDocumentos: null,
    ventaTercero: null,
    cuerpoDocumento: lineas,
    resumen: {
      ...sumas,
      descuNoSuj: 0,
      descuExenta: 0,
      descuGravada: 0,
      porcentajeDescuento: 0,
      tributos: null,
      subTotal,
      ivaRete,
      montoTotalOperacion,
      totalNoGravado: 0,
      totalPagar,
      totalLetras: montoEnLetras(totalPagar),
      totalIva,
      saldoFavor: 0,
      condicionOperacion: Number(resumen?.condicionOperacion) || 1,
      pagos: pagosV2(resumen, totalPagar),
      numPagoElectronico: textoONull(resumen?.numPagoElectronico),
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '01', emisorDb);
}
