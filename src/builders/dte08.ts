import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import { IVA, round2, emisorV2, identificacionSinContingencia, receptorConDocumento, redondear, textoONull, validarYNumerar } from './v2';

function lineaLiquidacion(item: any, idx: number) {
  const numero = (v: any) => redondear(Number(v) || 0, 8);
  const ventaGravada = numero(item.ventaGravada);
  const exportaciones = numero(item.exportaciones);
  // La venta local lleva IVA (20); la exportación, IVA al 0% (C3).
  const tributos = [...(ventaGravada !== 0 ? ["20"] : []), ...(exportaciones !== 0 ? ["C3"] : [])];
  const numeroDocumento = String(item.numeroDocumento || '').toUpperCase().trim();
  if (!numeroDocumento || !item.fechaEmision) {
    throw new DteInvalidoError(`El ítem ${idx + 1} debe indicar el documento liquidado y su fecha.`);
  }
  return {
    numItem: idx + 1,
    tipoDte: String(item.tipoDte || ''),
    tipoGeneracion: Number(item.tipoGeneracion),
    numeroDocumento,
    fechaEmision: item.fechaEmision,
    ventaNoSuj: numero(item.ventaNoSuj),
    ventaExenta: numero(item.ventaExenta),
    ventaGravada,
    exportaciones,
    tributos: tributos.length > 0 ? tributos : null,
    ivaItem: round2(ventaGravada * IVA),
    observaciones: textoONull(item.observaciones)
  };
}

// El comprobante lo emite el comisionista al mandante por las ventas hechas a su nombre.
export async function construirDte08(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;
  if (!Array.isArray(cuerpoDocumento) || cuerpoDocumento.length === 0) {
    throw new DteInvalidoError('El comprobante debe tener al menos un documento liquidado.');
  }

  const lineas = cuerpoDocumento.map(lineaLiquidacion);
  const suma = (campo: string) => round2(lineas.reduce((a: number, l: any) => a + l[campo], 0));
  const totalNoSuj = suma('ventaNoSuj');
  const totalExenta = suma('ventaExenta');
  const totalGravada = suma('ventaGravada');
  const exportacion = suma('exportaciones');
  const iva = suma('ivaItem');
  const subTotalVentas = round2(totalNoSuj + totalExenta + totalGravada + exportacion);
  const montoTotalOperacion = round2(subTotalVentas + iva);
  const ivaPerci = round2(Number(resumen?.ivaPerci) || 0);
  const total = round2(montoTotalOperacion + ivaPerci);

  const tributosResumen = [
    ...(iva !== 0 ? [{ codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: iva }] : []),
    ...(exportacion !== 0 ? [{ codigo: 'C3', descripcion: 'Impuesto al Valor Agregado (exportaciones) 0%', valor: 0 }] : [])
  ];

  const documento = {
    identificacion: { ...identificacionSinContingencia(req, '08', versionDte, emisorDb), fusion: null },
    emisor: emisorV2(emisorDb),
    receptor: {
      ...receptorConDocumento(receptor, { direccionRequerida: true }),
      codDomiciliado: Number(receptor?.codDomiciliado) || 1
    },
    cuerpoDocumento: lineas,
    resumen: {
      totalNoSuj,
      totalExenta,
      totalGravada,
      exportacion,
      subTotalVentas,
      tributos: tributosResumen.length > 0 ? tributosResumen : null,
      montoTotalOperacion,
      ivaPerci,
      total,
      totalLetras: montoEnLetras(total),
      condicionOperacion: Number(resumen?.condicionOperacion) || 1,
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '08', emisorDb);
}
