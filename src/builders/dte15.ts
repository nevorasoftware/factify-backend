import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import { round2, emisorV2, identificacionSinContingencia, receptorConDocumento, redondear, textoONull, validarYNumerar } from './v2';

// Manual Funcional, sección XX. CAT-026: 1 efectivo, 2 bien, 3 servicio.
function lineaDonacion(item: any, idx: number) {
  const tipoDonacion = Number(item.tipoDonacion) || 1;
  const esBien = tipoDonacion === 2;
  const cantidad = tipoDonacion === 1 ? 1 : Number(item.cantidad);
  const valorUni = redondear(Number(item.valorUni ?? item.precioUni), 8);
  const depreciacion = esBien ? redondear(Number(item.tipoDepreciacion) || 0, 8) : 0;
  const valor = redondear(cantidad * valorUni - depreciacion, 8);
  if (!(cantidad > 0) || !(valorUni >= 0) || valor < 0) {
    throw new DteInvalidoError(`El ítem ${idx + 1} tiene cantidad, valor o depreciación inválidos.`);
  }
  return {
    numItem: idx + 1,
    tipoDonacion,
    cantidad,
    codigo: textoONull(item.codigo),
    uniMedida: esBien ? Number(item.uniMedida) || 59 : 99,
    descripcion: String(item.descripcion || '').trim(),
    tipoDepreciacion: depreciacion,
    valorUni,
    valor
  };
}

// El emisor es el donatario, autorizado para recibir donaciones; el receptor es el donante.
export async function construirDte15(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, otrosDocumentos, resumen } = req.body;
  if (!Array.isArray(cuerpoDocumento) || cuerpoDocumento.length === 0) {
    throw new DteInvalidoError('El comprobante debe tener al menos un ítem donado.');
  }
  if (!Array.isArray(otrosDocumentos) || otrosDocumentos.length === 0) {
    throw new DteInvalidoError('Indique el documento que respalda la donación.');
  }

  const lineas = cuerpoDocumento.map(lineaDonacion);
  const valorTotal = round2(lineas.reduce((a: number, l: any) => a + l.valor, 0));
  const { nit, ...datosEmisor } = emisorV2(emisorDb);
  const pagoEntrada = Array.isArray(resumen?.pagos) ? resumen.pagos[0] : null;
  const { nombreComercial, ...donante } = receptorConDocumento(receptor);

  const documento = {
    identificacion: identificacionSinContingencia(req, '15', versionDte, emisorDb),
    emisor: { tipoDocumento: '36', numDocumento: nit, ...datosEmisor },
    receptor: {
      ...donante,
      codDomiciliado: Number(receptor?.codDomiciliado) || 1,
      codPais: textoONull(receptor?.codPais) || 'SV'
    },
    otrosDocumentos: otrosDocumentos.map((d: any) => ({
      codDocAsociado: Number(d.codDocAsociado) || null,
      descDocumento: textoONull(d.descDocumento),
      detalleDocumento: textoONull(d.detalleDocumento)
    })),
    cuerpoDocumento: lineas,
    resumen: {
      valorTotal,
      totalLetras: montoEnLetras(valorTotal),
      pagos: [{ codigo: pagoEntrada?.codigo || '01', montoPago: valorTotal, referencia: textoONull(pagoEntrada?.referencia) }]
    },
    apendice: null
  };

  return validarYNumerar(documento, '15', emisorDb);
}
