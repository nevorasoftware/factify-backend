import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import { round2, direccionObligatoria, emisorV2, identificacionSinContingencia, redondear, textoONull, validarYNumerar } from './v2';

function lineaDonacion(item: any, idx: number) {
  const cantidad = Number(item.cantidad);
  const valorUni = redondear(Number(item.valorUni ?? item.precioUni), 8);
  if (!(cantidad > 0) || !(valorUni >= 0)) {
    throw new DteInvalidoError(`El ítem ${idx + 1} tiene cantidad o valor inválidos.`);
  }
  return {
    numItem: idx + 1,
    tipoDonacion: Number(item.tipoDonacion) || 1,
    cantidad,
    codigo: textoONull(item.codigo),
    uniMedida: Number(item.uniMedida) || 59,
    descripcion: String(item.descripcion || '').trim(),
    tipoDepreciacion: redondear(Number(item.tipoDepreciacion) || 0, 8),
    valorUni,
    valor: redondear(cantidad * valorUni, 8)
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
  const dir = receptor?.direccion;

  const documento = {
    identificacion: identificacionSinContingencia(req, '15', versionDte, emisorDb),
    emisor: { tipoDocumento: '36', numDocumento: nit, ...datosEmisor },
    receptor: {
      tipoDocumento: textoONull(receptor?.tipoDocumento),
      numDocumento: textoONull(receptor?.numDocumento ?? receptor?.nit),
      nrc: textoONull(receptor?.nrc)?.replace(/-/g, '') ?? null,
      nombre: textoONull(receptor?.nombre),
      codActividad: textoONull(receptor?.codActividad),
      descActividad: textoONull(receptor?.descActividad),
      direccion: dir?.distrito ? direccionObligatoria(dir, 'del donante') : null,
      telefono: textoONull(receptor?.telefono),
      correo: textoONull(receptor?.correo),
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
