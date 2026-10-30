import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import {
  IVA, round2, emisorSinEstablecimiento, identificacionV2, lineasBase,
  receptorConDocumento, sumarLineas, textoONull, validarYNumerar
} from './v2';

function documentosRelacionadosNota(documentos: any) {
  if (!Array.isArray(documentos) || documentos.length === 0) {
    throw new DteInvalidoError('La nota debe indicar el documento que ajusta.');
  }
  return documentos.map((doc: any, idx: number) => {
    const numeroDocumento = String(doc.numeroDocumento || '').toUpperCase().trim();
    if (!numeroDocumento || !doc.fechaEmision) {
      throw new DteInvalidoError(`El documento relacionado ${idx + 1} debe tener número y fecha de emisión.`);
    }
    return {
      tipoDocumento: doc.tipoDocumento || '03',
      tipoGeneracion: Number(doc.tipoGeneracion) || 2,
      numeroDocumento,
      fechaEmision: doc.fechaEmision
    };
  });
}

// Estructura común de la nota de crédito (05) y de débito (06). El precio no incluye IVA.
export async function construirNota(req: any, tipoDte: '05' | '06', versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;

  const identificacion = identificacionV2(req, tipoDte, versionDte, emisorDb);
  const relacionados = documentosRelacionadosNota(req.body.documentoRelacionado);

  const lineas = lineasBase(cuerpoDocumento).map(({ psv, ...l }: any, idx: number) => {
    // Con un solo documento relacionado todos los ítems le corresponden.
    const numeroDocumento = String(cuerpoDocumento[idx].numeroDocumento || relacionados[0].numeroDocumento).toUpperCase().trim();
    if (!relacionados.some((d: any) => d.numeroDocumento === numeroDocumento)) {
      throw new DteInvalidoError(`El ítem ${idx + 1} no corresponde a ningún documento relacionado.`);
    }
    return {
      ...l,
      numeroDocumento,
      tributos: l.ventaGravada > 0 ? ['20'] : null,
      ivaPerci: 0,
      totalIva: round2(l.ventaGravada * IVA),
      ivaRete: 0
    };
  });

  const { subTotalVentas, ...sumas } = sumarLineas(lineas);
  const totalIva = round2(lineas.reduce((a: number, l: any) => a + l.totalIva, 0));
  const ivaPerci = round2(Number(resumen?.ivaPerci) || 0);
  const ivaRete = round2(Number(resumen?.ivaRete) || 0);
  const montoTotalOperacion = round2(subTotalVentas + totalIva);
  const totalPagar = round2(montoTotalOperacion + ivaPerci - ivaRete);

  const documento: any = {
    identificacion: { ...identificacion, fusion: null },
    documentoRelacionado: relacionados,
    emisor: emisorSinEstablecimiento(emisorDb),
    receptor: receptorConDocumento(receptor, { direccionRequerida: true }),
    ventaTercero: null,
    cuerpoDocumento: lineas,
    resumen: {
      ...sumas,
      subTotalVentas,
      tributos: totalIva > 0 ? [{ codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: totalIva }] : null,
      montoTotalOperacion,
      ivaPerci,
      totalIva,
      ivaRete,
      totalNoGravado: 0,
      totalPagar,
      totalLetras: montoEnLetras(totalPagar),
      condicionOperacion: Number(resumen?.condicionOperacion) || 1,
      observaciones: textoONull(resumen?.observaciones),
      codigoRetencionMH: textoONull(resumen?.codigoRetencionMH)
    },
    apendice: null
  };
  if (tipoDte === '06') documento.resumen.numPagoElectronico = textoONull(resumen?.numPagoElectronico);

  return validarYNumerar(documento, tipoDte, emisorDb);
}
