import { v4 as uuidv4 } from 'uuid';
import { DteInvalidoError, validarContraSchema } from '../services/schema.service';
import { formatearCodEstableMH, formatearCodPuntoVentaMH } from './common';
import { textoONull } from './v2';

const ahoraSV = () => {
  const ahora = new Date();
  return {
    fecha: ahora.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' }),
    hora: ahora.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false })
  };
};

const sinGuiones = (tipo: string, numero: any) => {
  const valor = String(numero || '').trim();
  return tipo === '36' ? valor.replace(/-/g, '') : valor;
};

// Manual Funcional VII: estos tipos solo admiten la misma fecha del documento como fecha del evento.
const FECHA_EVENTO_LIBRE = ['01', '11', '14'];
// Manual Funcional VII: estos documentos no llevan documento de reemplazo.
const SIN_REEMPLAZO = ['05', '08'];

export function construirEventoInvalidacion(dte: any, cuerpo: any, emisorDb: any) {
  const original = dte.json_enviado || {};
  const receptor = original.receptor || {};
  const tipoAnulacion = Number(cuerpo.tipoAnulacion);
  const m = cuerpo;

  if (![1, 2, 3].includes(tipoAnulacion)) {
    throw new DteInvalidoError('Seleccione el motivo de la invalidación.');
  }
  if (tipoAnulacion === 3 && !textoONull(m.motivoAnulacion)) {
    throw new DteInvalidoError('Describa el motivo de la invalidación.');
  }

  const reemplazo = textoONull(m.codigoGeneracionR);
  const requiereReemplazo = tipoAnulacion !== 2 && !SIN_REEMPLAZO.includes(dte.tipo_dte);
  if (requiereReemplazo && !reemplazo) {
    throw new DteInvalidoError('Primero emita el documento que reemplaza al invalidado e indique su código de generación.');
  }

  const { fecha, hora } = ahoraSV();
  const fecEmiOriginal = original.identificacion?.fecEmi;
  const evento = {
    identificacion: {
      version: 3,
      ambiente: emisorDb.ambiente || '00',
      codigoGeneracion: uuidv4().toUpperCase(),
      fecEmi: FECHA_EVENTO_LIBRE.includes(dte.tipo_dte) ? fecha : fecEmiOriginal,
      horEmi: hora,
      fusion: null
    },
    emisor: {
      nit: emisorDb.nit,
      nombre: emisorDb.razon_social,
      codEstableMH: formatearCodEstableMH(emisorDb.cod_establecimiento_mh),
      codEstable: null,
      codPuntoVentaMH: formatearCodPuntoVentaMH(emisorDb.cod_punto_venta_mh),
      codPuntoVenta: null,
      telefono: emisorDb.telefono,
      correo: emisorDb.correo
    },
    documento: {
      tipoDte: dte.tipo_dte,
      codigoGeneracion: String(dte.codigo_generacion).toUpperCase(),
      selloRecibido: dte.sello_recepcion_mh,
      numeroControl: dte.numero_control,
      fecEmi: fecEmiOriginal,
      codigoGeneracionR: requiereReemplazo ? reemplazo!.toUpperCase() : null,
      tipoDocumento: receptor.tipoDocumento || (receptor.nit ? '36' : null),
      numDocumento: receptor.numDocumento || receptor.nit || null,
      nombre: receptor.nombre || null,
      telefono: receptor.telefono || null,
      correo: receptor.correo || null
    },
    motivo: {
      tipoAnulacion,
      motivoAnulacion: textoONull(m.motivoAnulacion),
      nombreResponsable: textoONull(m.nombreResponsable),
      tipDocResponsable: textoONull(m.tipDocResponsable),
      numDocResponsable: sinGuiones(m.tipDocResponsable, m.numDocResponsable),
      nombreSolicita: textoONull(m.nombreSolicita),
      tipDocSolicita: textoONull(m.tipDocSolicita),
      numDocSolicita: sinGuiones(m.tipDocSolicita, m.numDocSolicita)
    }
  };

  validarContraSchema(evento, 'INVALIDACION');
  return evento;
}

export function construirEventoContingencia(documentos: any[], cuerpo: any, emisorDb: any) {
  const { fecha, hora } = ahoraSV();
  const evento = {
    identificacion: {
      version: 4,
      ambiente: emisorDb.ambiente || '00',
      codigoGeneracion: uuidv4().toUpperCase(),
      fTransmision: fecha,
      hTransmision: hora
    },
    emisor: {
      nit: emisorDb.nit,
      nombre: emisorDb.razon_social,
      nombreResponsable: textoONull(cuerpo.nombreResponsable),
      tipoDocResponsable: textoONull(cuerpo.tipoDocResponsable),
      numeroDocResponsable: sinGuiones(cuerpo.tipoDocResponsable, cuerpo.numeroDocResponsable),
      tipoEstablecimiento: textoONull(cuerpo.tipoEstablecimiento),
      codEstableMH: formatearCodEstableMH(emisorDb.cod_establecimiento_mh),
      codPuntoVentaMH: formatearCodPuntoVentaMH(emisorDb.cod_punto_venta_mh),
      telefono: emisorDb.telefono,
      correo: emisorDb.correo
    },
    detalleDTE: documentos.map((d: any, idx: number) => ({
      noItem: idx + 1,
      tipoDoc: d.tipo_dte,
      codigoGeneracion: String(d.codigo_generacion).toUpperCase()
    })),
    motivo: {
      fInicio: cuerpo.fInicio,
      fFin: cuerpo.fFin,
      hInicio: cuerpo.hInicio,
      hFin: cuerpo.hFin,
      tipoContingencia: Number(cuerpo.tipoContingencia),
      motivoContingencia: textoONull(cuerpo.motivoContingencia)
    }
  };

  validarContraSchema(evento, 'CONTINGENCIA');
  return evento;
}
