import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import { IVA, round2, direccionObligatoria, emisorV2, identificacionSinContingencia, textoONull, validarYNumerar } from './v2';

const PERCEPCION = 0.02; // Manual Funcional V2.0: IVA percibido del 2%

// Lo emite el agente perceptor al afiliado. El cuerpo es un único objeto, no una lista de ítems.
export async function construirDte09(req: any, versionDte: number, emisorDb: any) {
  const { receptor, extension } = req.body;
  const c = req.body.cuerpoDocumento;
  if (!c || Array.isArray(c) || typeof c !== 'object') {
    throw new DteInvalidoError('El documento contable de liquidación requiere los datos del periodo liquidado.');
  }

  const valorOperaciones = round2(Number(c.valorOperaciones));
  const montoSinPercepcion = round2(Number(c.montoSinPercepcion) || 0);
  const subTotal = round2(valorOperaciones - montoSinPercepcion);
  if (!(subTotal > 0)) {
    throw new DteInvalidoError('El valor de las operaciones debe ser mayor que los montos no sujetos a percepción.');
  }
  const iva = round2(subTotal * IVA);
  const ivaPercibido = round2(subTotal * PERCEPCION);
  const comision = round2(Number(c.comision) || 0);
  const ivaComision = round2(comision * IVA);
  const liquidoApagar = round2(valorOperaciones + iva - ivaPercibido - comision - ivaComision);
  if (!(liquidoApagar > 0)) {
    throw new DteInvalidoError('La comisión no puede dejar el líquido a pagar en cero o negativo.');
  }

  const documento = {
    identificacion: identificacionSinContingencia(req, '09', versionDte, emisorDb),
    emisor: emisorV2(emisorDb),
    receptor: {
      nit: String(receptor?.numDocumento ?? receptor?.nit ?? '').replace(/-/g, '').trim(),
      nrc: textoONull(receptor?.nrc)?.replace(/-/g, '') ?? null,
      nombre: textoONull(receptor?.nombre),
      codActividad: textoONull(receptor?.codActividad),
      descActividad: textoONull(receptor?.descActividad),
      nombreComercial: textoONull(receptor?.nombreComercial),
      tipoEstablecimiento: textoONull(receptor?.tipoEstablecimiento),
      direccion: direccionObligatoria(receptor?.direccion, 'del receptor'),
      telefono: textoONull(receptor?.telefono),
      correo: textoONull(receptor?.correo)
    },
    cuerpoDocumento: {
      periodoLiquidacionFechaInicio: c.periodoLiquidacionFechaInicio,
      periodoLiquidacionFechaFin: c.periodoLiquidacionFechaFin,
      codLiquidacion: textoONull(c.codLiquidacion),
      cantidadDoc: Number(c.cantidadDoc) > 0 ? Number(c.cantidadDoc) : null,
      valorOperaciones,
      montoSinPercepcion,
      descripSinPercepcion: textoONull(c.descripSinPercepcion),
      subTotal,
      iva,
      montoSujetoPercepcion: subTotal,
      ivaPercibido,
      comision,
      porcentComision: round2(Number(c.porcentComision) || 0),
      ivaComision,
      liquidoApagar,
      totalLetras: montoEnLetras(liquidoApagar),
      observaciones: textoONull(c.observaciones)
    },
    extension: {
      nombEntrega: textoONull(extension?.nombEntrega),
      docuEntrega: textoONull(extension?.docuEntrega),
      codEmpleado: textoONull(extension?.codEmpleado)
    },
    apendice: null
  };

  return validarYNumerar(documento, '09', emisorDb);
}
