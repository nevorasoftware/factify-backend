import { v4 as uuidv4 } from 'uuid';
import { formatearCodEstableMH, formatearCodPuntoVentaMH, obtenerSiguienteCorrelativo } from './common';
import { DteInvalidoError, validarContraSchema } from '../services/schema.service';

export const IVA = 0.13;

export const redondear = (n: number, decimales: number): number => {
  const factor = 10 ** decimales;
  return Math.round((n + Number.EPSILON) * factor) / factor;
};
export const round2 = (n: number) => redondear(n, 2);
const round8 = (n: number) => redondear(n, 8);

const textoONull = (v: any): string | null => {
  const t = v === undefined || v === null ? '' : String(v).trim();
  return t.length > 0 ? t : null;
};

export function direccionObligatoria(dir: any, quien: string) {
  if (!dir?.departamento || !dir?.municipio || !dir?.distrito || !textoONull(dir?.complemento)) {
    throw new DteInvalidoError(`La dirección de ${quien} debe tener departamento, municipio, distrito y complemento vigentes.`);
  }
  return {
    departamento: String(dir.departamento),
    municipio: String(dir.municipio),
    distrito: String(dir.distrito),
    complemento: String(dir.complemento).trim()
  };
}

export function emisorV2(emisorDb: any) {
  return {
    nit: emisorDb.nit,
    nrc: emisorDb.nrc,
    nombre: emisorDb.razon_social,
    codActividad: emisorDb.cod_actividad,
    descActividad: emisorDb.desc_actividad,
    nombreComercial: emisorDb.nombre_comercial || null,
    direccion: direccionObligatoria(emisorDb.direccion, 'el emisor'),
    telefono: emisorDb.telefono,
    correo: emisorDb.correo,
    codEstable: formatearCodEstableMH(emisorDb.cod_establecimiento_mh),
    codPuntoVenta: formatearCodPuntoVentaMH(emisorDb.cod_punto_venta_mh)
  };
}

export function identificacionV2(req: any, tipoDte: string, version: number, emisorDb: any) {
  const ahora = new Date();
  const codigo = req.body.identificacion?.codigoGeneracion;
  return {
    version,
    ambiente: emisorDb.ambiente || '00',
    tipoDte,
    numeroControl: `DTE-${tipoDte}-M001P001-000000000000000`, // Se reemplaza al reservar el correlativo
    codigoGeneracion: codigo ? String(codigo).toUpperCase() : uuidv4().toUpperCase(),
    tipoModelo: 1,
    tipoOperacion: 1,
    tipoContingencia: null,
    motivoContin: null,
    fecEmi: ahora.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' }),
    horEmi: ahora.toLocaleTimeString('en-GB', { timeZone: 'America/El_Salvador', hour12: false }),
    tipoMoneda: 'USD'
  };
}

export function documentosRelacionadosV2(documentos: any, fecEmi: string) {
  if (!Array.isArray(documentos) || documentos.length === 0) return null;
  return documentos.map((doc: any) => ({
    tipoDocumento: doc.tipoDocumento,
    tipoGeneracion: Number(doc.tipoGeneracion) || 1,
    numeroDocumento: String(doc.numeroDocumento || '').toUpperCase().trim(),
    fechaEmision: doc.fechaEmision || fecEmi
  }));
}

// El monto de cada línea sale de cantidad × precio − descuento; lo calculado por el cliente se ignora.
export function lineasBase(cuerpoDocumento: any) {
  if (!Array.isArray(cuerpoDocumento) || cuerpoDocumento.length === 0) {
    throw new DteInvalidoError('El documento debe tener al menos un ítem.');
  }
  return cuerpoDocumento.map((item: any, idx: number) => {
    const cantidad = Number(item.cantidad);
    const precioUni = round8(Number(item.precioUni));
    const montoDescu = round8(Number(item.montoDescu) || 0);
    if (!(cantidad > 0) || !(precioUni >= 0) || montoDescu < 0) {
      throw new DteInvalidoError(`El ítem ${idx + 1} tiene cantidad, precio o descuento inválidos.`);
    }
    const venta = round8(cantidad * precioUni - montoDescu);
    if (venta < 0) throw new DteInvalidoError(`El descuento del ítem ${idx + 1} supera su valor.`);

    const esNoSujeta = Number(item.ventaNoSuj) > 0;
    const esExenta = !esNoSujeta && Number(item.ventaExenta) > 0;
    return {
      numItem: idx + 1,
      tipoItem: Number(item.tipoItem) || 1,
      numeroDocumento: textoONull(item.numeroDocumento),
      codigo: textoONull(item.codigo),
      codTributo: null,
      descripcion: String(item.descripcion || '').trim(),
      cantidad,
      uniMedida: Number(item.uniMedida) || 59,
      precioUni,
      montoDescu,
      ventaNoSuj: esNoSujeta ? venta : 0,
      ventaExenta: esExenta ? venta : 0,
      ventaGravada: !esNoSujeta && !esExenta ? venta : 0,
      psv: 0,
      noGravado: 0
    };
  });
}

export function sumarLineas(lineas: any[]) {
  const totalNoSuj = round2(lineas.reduce((a, l) => a + l.ventaNoSuj, 0));
  const totalExenta = round2(lineas.reduce((a, l) => a + l.ventaExenta, 0));
  const totalGravada = round2(lineas.reduce((a, l) => a + l.ventaGravada, 0));
  const totalDescu = round2(lineas.reduce((a, l) => a + l.montoDescu, 0));
  const subTotalVentas = round2(totalNoSuj + totalExenta + totalGravada);
  return { totalNoSuj, totalExenta, totalGravada, totalDescu, subTotalVentas };
}

export function pagosV2(resumen: any, total: number) {
  const entrada = Array.isArray(resumen?.pagos) ? resumen.pagos : [];
  const normalizar = (p: any, montoPago: number) => ({
    codigo: p.codigo || '01',
    montoPago,
    referencia: textoONull(p.referencia),
    plazo: textoONull(p.plazo),
    periodo: p.periodo === undefined || p.periodo === null || p.periodo === '' ? null : Number(p.periodo)
  });

  if (entrada.length <= 1) return [normalizar(entrada[0] || {}, total)];

  const pagos = entrada.map((p: any) => normalizar(p, round2(Number(p.montoPago) || 0)));
  const suma = round2(pagos.reduce((a: number, p: any) => a + p.montoPago, 0));
  if (suma !== total) {
    throw new DteInvalidoError(`La suma de los pagos ($${suma.toFixed(2)}) no coincide con el total a pagar ($${total.toFixed(2)}).`);
  }
  return pagos;
}

// Valida antes de reservar: un documento rechazado aquí no consume correlativo.
export async function validarYNumerar(documento: any, tipoDte: string, emisorDb: any) {
  validarContraSchema(documento, tipoDte);
  documento.identificacion.numeroControl = await obtenerSiguienteCorrelativo(
    tipoDte, emisorDb.id, documento.emisor.codEstable, documento.emisor.codPuntoVenta, 1
  );
  return documento;
}

export { textoONull };
