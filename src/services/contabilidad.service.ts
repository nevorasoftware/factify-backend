// Libros de IVA y pago a cuenta. Las columnas y sus reglas siguen los manuales del Ministerio de Hacienda:
// carga de anexos del F-07 v14 (enero 2025) y anexo de retenciones del F-14 v16 (octubre 2025).
import prisma from '../db/prisma';
import { desgloseDte, leerDte, TIPO_RETENCION_RECIBIDA } from './compra-dte.service';

export class ContabilidadError extends Error {}

const PAISES_CENTROAMERICA = ['SV', 'GT', 'HN', 'NI', 'CR'];
const CODIGO_PAIS_EL_SALVADOR = '9300';
// F-14, apéndice: 11 = servicios sin dependencia laboral. Es el caso normal de un sujeto excluido.
const CODIGO_INGRESO_SUJETO_EXCLUIDO = '11';

const CODIGOS = {
  tipoOperacion: [1, 2, 3, 4, 8, 9],
  clasificacion: [1, 2, 8, 9],
  sector: [1, 2, 3, 4, 8, 9],
  tipoCostoGasto: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  tipoIngreso: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]
};

export const num = (valor: any) => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
};
export const redondear = (valor: number) => Math.round((valor + Number.EPSILON) * 100) / 100;
const monto = (valor: any) => redondear(num(valor)).toFixed(2);
const sinGuiones = (valor: any) => String(valor ?? '').replace(/-/g, '').toUpperCase();
const soloDigitos = (valor: any) => String(valor ?? '').replace(/\D/g, '');
const fechaHacienda = (fecha: string) => `${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}`;
const fechaIso = (fecha: Date) => fecha.toISOString().slice(0, 10);

export function validarPeriodo(periodo: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodo))) throw new ContabilidadError('Indique un periodo válido (AAAA-MM).');
}

const mesesEntre = (desde: string, hasta: string) =>
  (Number(hasta.slice(0, 4)) - Number(desde.slice(0, 4))) * 12 + Number(hasta.slice(5, 7)) - Number(desde.slice(5, 7));

// Hacienda identifica con NIT (14) o DUI (9) y la columna vacía depende de cuál sea
function identificacion(documento: any): { nit: string; dui: string } {
  const digitos = soloDigitos(documento);
  return digitos.length === 9 ? { nit: '', dui: digitos } : { nit: digitos, dui: '' };
}

export interface Fila {
  valores: string[];
  compraId?: number;
  alertas?: string[];
  datos?: any;
}

export interface Libro {
  clave: string;
  titulo: string;
  formulario: 'F-07' | 'F-14';
  anexo: string;
  casilla?: string;
  columnas: string[];
  vista: number[];
  filas: Fila[];
  totales: { etiqueta: string; valor: number }[];
}

export interface VentaContable {
  tipo: string;
  codigo: string;
  control: string;
  sello: string | null;
  fecha: string;
  hora: string;
  json: any;
}

export interface CompraContable {
  id: number;
  tipo: string;
  numero: string;
  codigo: string | null;
  sello: string | null;
  fecha: string;
  proveedor: string;
  documento: string;
  total: number;
  gravada: number | null;
  exenta: number | null;
  iva: number | null;
  percibido: number;
  retenido: number;
  periodoIva: string | null;
  tipoOperacion: number | null;
  clasificacion: number | null;
  sector: number | null;
  tipoCostoGasto: number | null;
}

export interface InvalidadoContable {
  tipo: string;
  codigo: string;
  control: string;
  sello: string | null;
  fecha: string;
}

export interface Configuracion {
  tipoIngreso: number;
  tipoOperacion: number;
  clasificacion: number;
  sector: number;
  tipoCostoGasto: number;
  tasaPagoCuenta: number;
}

export interface Ajustes {
  remanenteIva: number;
  excedentePagoCuenta: number;
  ingresosConRetencion: number;
}

const resumenDe = (dte: any) => dte?.resumen || {};

// R y U del F-07: gravada, exenta o mixta según lo que traiga el documento
function tipoOperacionVenta(gravada: number, exenta: number): number {
  if (gravada > 0 && exenta > 0) return 4;
  return exenta > 0 ? 2 : 1;
}

function ventasContribuyentes(ventas: VentaContable[], config: Configuracion): Libro {
  const filas: Fila[] = [];
  const t = { gravada: 0, debito: 0, exenta: 0, total: 0 };

  for (const v of ventas.filter(x => ['03', '05', '06'].includes(x.tipo))) {
    const d = desgloseDte(v.json);
    const receptor = v.json?.receptor || {};
    const id = identificacion(receptor.nit ?? receptor.numDocumento);
    const r = resumenDe(v.json);
    const exentas = num(r.totalExenta) - num(r.descuExenta);
    const noSujetas = num(r.totalNoSuj) - num(r.descuNoSux);
    const total = d.gravada + exentas + noSujetas + d.iva;
    // El archivo no admite negativos: la nota de crédito va en positivo y se resta solo en los totales
    const signo = v.tipo === '05' ? -1 : 1;
    t.gravada += signo * d.gravada;
    t.debito += signo * d.iva;
    t.exenta += signo * (exentas + noSujetas);
    t.total += signo * total;
    filas.push({
      valores: [
        fechaHacienda(v.fecha), '4', v.tipo, sinGuiones(v.control), v.sello || '', sinGuiones(v.codigo), '',
        id.nit, String(receptor.nombre ?? ''), monto(exentas), monto(noSujetas), monto(d.gravada), monto(d.iva),
        '0.00', '0.00', monto(total), id.dui, String(tipoOperacionVenta(d.gravada, exentas + noSujetas)), String(config.tipoIngreso), '1'
      ],
      alertas: v.sello ? [] : ['Sin sello de recepción']
    });
  }

  return {
    clave: 'ventas-contribuyentes',
    titulo: 'Libro de Ventas a Contribuyentes',
    formulario: 'F-07',
    anexo: '1',
    columnas: ['Fecha', 'Clase', 'Tipo', 'Resolución', 'Serie', 'Número de documento', 'Control interno', 'NIT o NRC', 'Cliente', 'Exentas', 'No sujetas', 'Gravadas', 'Débito fiscal', 'Terceros', 'Débito terceros', 'Total', 'DUI', 'Tipo operación', 'Tipo ingreso', 'Anexo'],
    vista: [0, 2, 5, 7, 16, 8, 9, 10, 11, 12, 15],
    filas,
    totales: [
      { etiqueta: 'Exentas y no sujetas', valor: redondear(t.exenta) },
      { etiqueta: 'Gravadas', valor: redondear(t.gravada) },
      { etiqueta: 'Débito fiscal', valor: redondear(t.debito) },
      { etiqueta: 'Total', valor: redondear(t.total) }
    ]
  };
}

function ventasConsumidor(ventas: VentaContable[], config: Configuracion): Libro {
  // Hacienda pide agrupar los DTE por día, con el primer y el último código de generación
  const grupos = new Map<string, VentaContable[]>();
  const tipoIngresoDe = (v: VentaContable) => {
    if (v.tipo !== '11') return config.tipoIngreso;
    return v.json?.emisor?.tipoItemExpor === 2 ? 9 : 7;
  };
  for (const v of ventas.filter(x => ['01', '11'].includes(x.tipo)).sort((a, b) => `${a.fecha}${a.hora}`.localeCompare(`${b.fecha}${b.hora}`))) {
    const clave = `${v.fecha}|${v.tipo}|${tipoIngresoDe(v)}`;
    grupos.set(clave, [...(grupos.get(clave) || []), v]);
  }

  const t = { gravada: 0, iva: 0, exenta: 0, exportaciones: 0, total: 0 };
  const filas: Fila[] = [];
  for (const [clave, documentos] of grupos) {
    const [fecha, tipo, tipoIngreso] = clave.split('|');
    const suma = { exenta: 0, noSujeta: 0, gravada: 0, iva: 0, expCa: 0, expFuera: 0, expServicios: 0 };
    for (const v of documentos) {
      const r = resumenDe(v.json);
      if (tipo === '11') {
        const valor = num(r.montoTotalOperacion ?? r.totalGravada);
        if (v.json?.emisor?.tipoItemExpor === 2) suma.expServicios += valor;
        else if (PAISES_CENTROAMERICA.includes(String(v.json?.receptor?.codPais))) suma.expCa += valor;
        else suma.expFuera += valor;
      } else {
        suma.exenta += num(r.totalExenta) - num(r.descuExenta);
        suma.noSujeta += num(r.totalNoSuj) - num(r.descuNoSux);
        suma.gravada += num(r.totalGravada) - num(r.descuGravada); // En factura el manual la pide con IVA incluido
        suma.iva += num(r.totalIva);
      }
    }
    const exportaciones = suma.expCa + suma.expFuera + suma.expServicios;
    const total = suma.exenta + suma.noSujeta + suma.gravada + exportaciones;
    t.gravada += suma.gravada;
    t.iva += suma.iva;
    t.exenta += suma.exenta + suma.noSujeta;
    t.exportaciones += exportaciones;
    t.total += total;
    filas.push({
      valores: [
        fechaHacienda(fecha), '4', tipo, 'N/A', 'N/A', 'N/A', 'N/A',
        sinGuiones(documentos[0].codigo), sinGuiones(documentos[documentos.length - 1].codigo), '',
        monto(suma.exenta), '0.00', monto(suma.noSujeta), monto(suma.gravada), monto(suma.expCa), monto(suma.expFuera), monto(suma.expServicios),
        '0.00', '0.00', monto(total), String(tipoOperacionVenta(suma.gravada + exportaciones, suma.exenta + suma.noSujeta)), tipoIngreso, '2'
      ],
      alertas: documentos.some(d => !d.sello) ? ['Hay documentos sin sello de recepción'] : [],
      datos: { documentos: documentos.length }
    });
  }

  return {
    clave: 'ventas-consumidor',
    titulo: 'Libro de Ventas a Consumidor Final',
    formulario: 'F-07',
    anexo: '2',
    columnas: ['Fecha', 'Clase', 'Tipo', 'Resolución', 'Serie', 'Control del', 'Control al', 'Documento del', 'Documento al', 'Máquina', 'Exentas', 'Exentas sin proporcionalidad', 'No sujetas', 'Gravadas (con IVA)', 'Export. Centroamérica', 'Export. fuera de CA', 'Export. servicios', 'Zonas francas', 'Terceros', 'Total', 'Tipo operación', 'Tipo ingreso', 'Anexo'],
    vista: [0, 2, 7, 8, 10, 12, 13, 14, 15, 16, 19],
    filas,
    totales: [
      { etiqueta: 'Exentas y no sujetas', valor: redondear(t.exenta) },
      { etiqueta: 'Gravadas con IVA', valor: redondear(t.gravada) },
      { etiqueta: 'Débito fiscal incluido', valor: redondear(t.iva) },
      { etiqueta: 'Exportaciones', valor: redondear(t.exportaciones) },
      { etiqueta: 'Total', valor: redondear(t.total) }
    ]
  };
}

function compras(lista: CompraContable[], config: Configuracion): Libro {
  const t = { gravada: 0, exenta: 0, credito: 0, total: 0 };
  const filas: Fila[] = [];

  // La factura de consumidor final no da derecho a crédito fiscal: el anexo solo admite 03, 05 y 06
  for (const c of lista.filter(x => ['03', '05', '06'].includes(x.tipo))) {
    const alertas: string[] = [];
    const esDte = !!c.codigo || c.numero.startsWith('DTE-');
    if (c.gravada === null) alertas.push('Falta el desglose de gravado, exento e IVA');
    if (esDte && !c.sello) alertas.push('Sin sello de recepción');
    const gravada = c.gravada ?? 0;
    const exenta = c.exenta ?? 0;
    const iva = c.iva ?? 0;
    if (Math.abs(iva - gravada * 0.13) > 0.05) alertas.push('El crédito fiscal no equivale al 13% de lo gravado');
    const id = identificacion(c.documento);
    const total = gravada + exenta;
    const signo = c.tipo === '05' ? -1 : 1;
    t.gravada += signo * gravada;
    t.exenta += signo * exenta;
    t.credito += signo * iva;
    t.total += signo * total;

    const tipoOperacion = c.tipoOperacion ?? config.tipoOperacion;
    const clasificacion = c.clasificacion ?? config.clasificacion;
    const sector = c.sector ?? config.sector;
    const tipoCostoGasto = c.tipoCostoGasto ?? config.tipoCostoGasto;
    filas.push({
      compraId: c.id,
      valores: [
        fechaHacienda(c.fecha), esDte ? '4' : '1', c.tipo, c.codigo ? sinGuiones(c.codigo) : sinGuiones(c.numero),
        id.nit, c.proveedor, monto(exenta), '0.00', '0.00', monto(gravada), '0.00', '0.00', '0.00', monto(iva), monto(total), id.dui,
        String(tipoOperacion), String(clasificacion), String(sector), String(tipoCostoGasto), '3'
      ],
      alertas,
      datos: { gravada: c.gravada, exenta: c.exenta, iva: c.iva, tipoOperacion, clasificacion, sector, tipoCostoGasto, periodoIva: c.periodoIva, fecha: c.fecha }
    });
  }

  return {
    clave: 'compras',
    titulo: 'Libro de Compras',
    formulario: 'F-07',
    anexo: '3',
    columnas: ['Fecha', 'Clase', 'Tipo', 'Número de documento', 'NIT o NRC', 'Proveedor', 'Exentas y no sujetas', 'Internaciones exentas', 'Importaciones exentas', 'Gravadas', 'Internaciones gravadas', 'Importaciones gravadas', 'Importación de servicios', 'Crédito fiscal', 'Total', 'DUI', 'Tipo operación', 'Clasificación', 'Sector', 'Tipo costo/gasto', 'Anexo'],
    vista: [0, 2, 3, 4, 15, 5, 6, 9, 13, 14],
    filas,
    totales: [
      { etiqueta: 'Exentas y no sujetas', valor: redondear(t.exenta) },
      { etiqueta: 'Gravadas', valor: redondear(t.gravada) },
      { etiqueta: 'Crédito fiscal', valor: redondear(t.credito) },
      { etiqueta: 'Total', valor: redondear(t.total) }
    ]
  };
}

function sujetosExcluidos(ventas: VentaContable[], config: Configuracion): Libro {
  let total = 0;
  const filas = ventas.filter(v => v.tipo === '14').map((v): Fila => {
    const receptor = v.json?.receptor || {};
    const digitos = soloDigitos(receptor.numDocumento);
    const tipoDocumento = receptor.tipoDocumento === '36' ? '1' : receptor.tipoDocumento === '13' ? '2' : '3';
    const valor = num(resumenDe(v.json).totalCompra);
    total += valor;
    return {
      valores: [
        tipoDocumento, digitos, String(receptor.nombre ?? ''), fechaHacienda(v.fecha), v.sello || '', sinGuiones(v.codigo), monto(valor), '0.00',
        String(config.tipoOperacion), String(config.clasificacion), String(config.sector), String(config.tipoCostoGasto), '5'
      ]
    };
  });
  return {
    clave: 'sujetos-excluidos',
    titulo: 'Compras a Sujetos Excluidos',
    formulario: 'F-07',
    anexo: '5',
    casilla: '66',
    columnas: ['Tipo doc.', 'Documento', 'Proveedor', 'Fecha', 'Serie', 'Número de documento', 'Monto', 'Retención 13%', 'Tipo operación', 'Clasificación', 'Sector', 'Tipo costo/gasto', 'Anexo'],
    vista: [3, 1, 2, 5, 6, 7],
    filas,
    totales: [{ etiqueta: 'Monto', valor: redondear(total) }]
  };
}

function retencionesRecibidas(lista: CompraContable[]): Libro {
  let sujeto = 0;
  let retenido = 0;
  const filas = lista.filter(c => c.tipo === TIPO_RETENCION_RECIBIDA && c.retenido > 0).map((c): Fila => {
    const id = identificacion(c.documento);
    sujeto += c.gravada ?? 0;
    retenido += c.retenido;
    return {
      valores: [id.nit, fechaHacienda(c.fecha), c.tipo, c.sello || '', sinGuiones(c.codigo), monto(c.gravada), monto(c.retenido), id.dui, '7'],
      datos: { proveedor: c.proveedor }
    };
  });
  return {
    clave: 'retencion-recibida',
    titulo: 'Retención 1% IVA efectuada al declarante',
    formulario: 'F-07',
    anexo: '7',
    casilla: '162',
    columnas: ['NIT agente', 'Fecha', 'Tipo', 'Serie', 'Número de documento', 'Monto sujeto', 'Retención 1%', 'DUI agente', 'Anexo'],
    vista: [1, 0, 7, 4, 5, 6],
    filas,
    totales: [{ etiqueta: 'Monto sujeto', valor: redondear(sujeto) }, { etiqueta: 'Retención 1%', valor: redondear(retenido) }]
  };
}

function percepcionesRecibidas(lista: CompraContable[]): Libro {
  let sujeto = 0;
  let percibido = 0;
  const filas = lista.filter(c => ['03', '05', '06'].includes(c.tipo) && c.percibido > 0).map((c): Fila => {
    const id = identificacion(c.documento);
    const signo = c.tipo === '05' ? -1 : 1;
    sujeto += signo * (c.gravada ?? 0);
    percibido += signo * c.percibido;
    return { valores: [id.nit, fechaHacienda(c.fecha), c.tipo, c.sello || '', sinGuiones(c.codigo), monto(c.gravada), monto(c.percibido), id.dui, '8'] };
  });
  return {
    clave: 'percepcion-recibida',
    titulo: 'Percepción 1% IVA efectuada al declarante',
    formulario: 'F-07',
    anexo: '8',
    casilla: '163',
    columnas: ['NIT agente', 'Fecha', 'Tipo', 'Serie', 'Número de documento', 'Monto sujeto', 'Percepción 1%', 'DUI agente', 'Anexo'],
    vista: [1, 0, 7, 4, 5, 6],
    filas,
    totales: [{ etiqueta: 'Monto sujeto', valor: redondear(sujeto) }, { etiqueta: 'Percepción 1%', valor: redondear(percibido) }]
  };
}

function percepcionesEfectuadas(ventas: VentaContable[]): Libro {
  let sujeto = 0;
  let percibido = 0;
  const filas: Fila[] = [];
  for (const v of ventas.filter(x => ['03', '05', '06'].includes(x.tipo))) {
    const d = desgloseDte(v.json);
    if (d.iva_percibido <= 0) continue;
    const receptor = v.json?.receptor || {};
    const id = identificacion(receptor.nit ?? receptor.numDocumento);
    const signo = v.tipo === '05' ? -1 : 1;
    sujeto += signo * d.gravada;
    percibido += signo * d.iva_percibido;
    filas.push({ valores: [id.nit, fechaHacienda(v.fecha), v.tipo, sinGuiones(v.control), v.sello || '', sinGuiones(v.codigo), monto(d.gravada), monto(d.iva_percibido), id.dui, '9'] });
  }
  return {
    clave: 'percepcion-efectuada',
    titulo: 'Percepción 1% IVA efectuada por el declarante',
    formulario: 'F-07',
    anexo: '9',
    casilla: '169',
    columnas: ['NIT sujeto', 'Fecha', 'Tipo', 'Resolución', 'Serie', 'Número de documento', 'Monto sujeto', 'Percepción 1%', 'DUI sujeto', 'Anexo'],
    vista: [1, 0, 8, 5, 6, 7],
    filas,
    totales: [{ etiqueta: 'Monto sujeto', valor: redondear(sujeto) }, { etiqueta: 'Percepción 1%', valor: redondear(percibido) }]
  };
}

function retencionesEfectuadas(ventas: VentaContable[], codigo: '22' | 'C4'): Libro {
  const es1 = codigo === '22';
  let sujeto = 0;
  let retenido = 0;
  const filas: Fila[] = [];
  for (const v of ventas.filter(x => x.tipo === '07')) {
    const lineas = (Array.isArray(v.json?.cuerpoDocumento) ? v.json.cuerpoDocumento : []).filter((l: any) => l?.codigoRetencionMH === codigo);
    if (lineas.length === 0) continue;
    const base = lineas.reduce((a: number, l: any) => a + num(l.montoSujetoGrav), 0);
    const valor = lineas.reduce((a: number, l: any) => a + num(l.ivaRetenido), 0);
    const receptor = v.json?.receptor || {};
    const id = identificacion(receptor.nit ?? receptor.numDocumento);
    sujeto += base;
    retenido += valor;
    // Las columnas de resolución y serie están en distinto orden en los anexos 10 y 12
    const documento = es1 ? [sinGuiones(v.control), v.sello || ''] : [v.sello || '', sinGuiones(v.control)];
    filas.push({ valores: [id.nit, fechaHacienda(v.fecha), v.tipo, ...documento, sinGuiones(v.codigo), monto(base), monto(valor), id.dui, es1 ? '10' : '12'] });
  }
  const etiqueta = es1 ? 'Retención 1%' : 'Retención 13%';
  return {
    clave: es1 ? 'retencion-efectuada-1' : 'retencion-efectuada-13',
    titulo: `${etiqueta} IVA efectuada por el declarante`,
    formulario: 'F-07',
    anexo: es1 ? '10' : '12',
    casilla: es1 ? '170' : '172',
    columnas: ['NIT sujeto', 'Fecha', 'Tipo', es1 ? 'Resolución' : 'Serie', es1 ? 'Serie' : 'Resolución', 'Número de documento', 'Monto sujeto', etiqueta, 'DUI sujeto', 'Anexo'],
    vista: [1, 0, 8, 5, 6, 7],
    filas,
    totales: [{ etiqueta: 'Monto sujeto', valor: redondear(sujeto) }, { etiqueta, valor: redondear(retenido) }]
  };
}

function invalidados(lista: InvalidadoContable[]): Libro {
  return {
    clave: 'invalidados',
    titulo: 'Documentos invalidados',
    formulario: 'F-07',
    anexo: 'Anulados',
    columnas: ['Resolución', 'Clase', 'Desde preimpreso', 'Hasta preimpreso', 'Tipo', 'Tipo de detalle', 'Serie', 'Desde', 'Hasta', 'Código de generación'],
    vista: [4, 0, 6, 9],
    filas: lista.map((i): Fila => ({
      // Único anexo donde el manual pide el código con guiones (36 caracteres)
      valores: [i.control, '4', '0', '0', i.tipo, 'D', i.sello || '', '0', '0', i.codigo.toUpperCase()],
      alertas: i.sello ? [] : ['Sin sello de recepción']
    })),
    totales: [{ etiqueta: 'Documentos', valor: lista.length }]
  };
}

function retencionesRenta(ventas: VentaContable[], periodo: string, config: Configuracion): Libro {
  let base = 0;
  let retenido = 0;
  const filas: Fila[] = [];
  for (const v of ventas.filter(x => x.tipo === '14')) {
    const r = resumenDe(v.json);
    const impuesto = num(r.reteRenta);
    if (impuesto <= 0) continue;
    const receptor = v.json?.receptor || {};
    const id = identificacion(receptor.numDocumento);
    const devengado = num(r.totalCompra);
    base += devengado;
    retenido += impuesto;
    filas.push({
      valores: [
        '1', CODIGO_PAIS_EL_SALVADOR, String(receptor.nombre ?? '').toUpperCase().slice(0, 100), id.nit, id.dui, CODIGO_INGRESO_SUJETO_EXCLUIDO,
        monto(devengado), '0.00', monto(impuesto), '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00',
        String(config.tipoOperacion), String(config.clasificacion), String(config.sector), String(config.tipoCostoGasto),
        `${periodo.slice(5, 7)}${periodo.slice(0, 4)}`
      ]
    });
  }
  return {
    clave: 'retenciones-renta',
    titulo: 'Retenciones de renta a sujetos excluidos',
    formulario: 'F-14',
    anexo: 'Retenciones',
    columnas: ['Domiciliado', 'País', 'Nombre', 'NIT', 'DUI', 'Código de ingreso', 'Monto devengado', 'Bonificaciones', 'Impuesto retenido', 'Aguinaldo exento', 'Aguinaldo gravado', 'AFP', 'ISSS', 'INPEP', 'IPSFA', 'CEFAFA', 'Bienestar Magisterial', 'ISSS IVM', 'Tipo operación', 'Clasificación', 'Sector', 'Tipo costo/gasto', 'Periodo'],
    vista: [2, 3, 4, 5, 6, 8],
    filas,
    totales: [{ etiqueta: 'Monto devengado', valor: redondear(base) }, { etiqueta: 'Impuesto retenido', valor: redondear(retenido) }]
  };
}

const totalDe = (libro: Libro, etiqueta: string) => libro.totales.find(t => t.etiqueta === etiqueta)?.valor ?? 0;

export function construirReporte(
  periodo: string,
  ventas: VentaContable[],
  listaCompras: CompraContable[],
  listaInvalidados: InvalidadoContable[],
  config: Configuracion,
  ajustes: Ajustes
) {
  const libros = [
    ventasContribuyentes(ventas, config),
    ventasConsumidor(ventas, config),
    compras(listaCompras, config),
    sujetosExcluidos(ventas, config),
    retencionesRecibidas(listaCompras),
    percepcionesRecibidas(listaCompras),
    percepcionesEfectuadas(ventas),
    retencionesEfectuadas(ventas, '22'),
    retencionesEfectuadas(ventas, 'C4'),
    invalidados(listaInvalidados),
    retencionesRenta(ventas, periodo, config)
  ];
  const libro = (clave: string) => libros.find(l => l.clave === clave)!;

  // F-07: los montos retenidos solo reducen un impuesto positivo; lo que sobre pasa al siguiente mes
  const debitoContribuyentes = totalDe(libro('ventas-contribuyentes'), 'Débito fiscal');
  const debitoConsumidor = totalDe(libro('ventas-consumidor'), 'Débito fiscal incluido');
  const debito = redondear(debitoContribuyentes + debitoConsumidor);
  const credito = totalDe(libro('compras'), 'Crédito fiscal');
  const diferencia = redondear(debito - credito - ajustes.remanenteIva);
  const impuestoDeterminado = Math.max(diferencia, 0);
  const remanenteSiguiente = Math.max(-diferencia, 0);
  const montosRecibidos = redondear(totalDe(libro('retencion-recibida'), 'Retención 1%') + totalDe(libro('percepcion-recibida'), 'Percepción 1%'));
  const aplicados = Math.min(montosRecibidos, impuestoDeterminado);
  const montosEfectuados = redondear(
    totalDe(libro('percepcion-efectuada'), 'Percepción 1%') + totalDe(libro('retencion-efectuada-1'), 'Retención 1%') + totalDe(libro('retencion-efectuada-13'), 'Retención 13%')
  );

  // Pago a cuenta: ingresos brutos del mes, sin IVA
  const ingresosContribuyentes = redondear(totalDe(libro('ventas-contribuyentes'), 'Total') - debitoContribuyentes);
  const ingresosConsumidor = redondear(totalDe(libro('ventas-consumidor'), 'Total') - debitoConsumidor);
  const ingresosBrutos = redondear(ingresosContribuyentes + ingresosConsumidor);
  const baseGravable = Math.max(redondear(ingresosBrutos - ajustes.ingresosConRetencion), 0);
  const computado = redondear(baseGravable * config.tasaPagoCuenta / 100);
  const pagoCuenta = Math.max(redondear(computado - ajustes.excedentePagoCuenta), 0);
  const retencionRenta = totalDe(libro('retenciones-renta'), 'Impuesto retenido');

  const advertencias: string[] = [];
  const exentasVenta = totalDe(libro('ventas-contribuyentes'), 'Exentas y no sujetas') + totalDe(libro('ventas-consumidor'), 'Exentas y no sujetas');
  if (exentasVenta > 0 && debito > 0) advertencias.push('Hay ventas gravadas y exentas: revise si debe aplicar proporcionalidad al crédito fiscal; este cálculo no la aplica.');
  const sinCredito = listaCompras.filter(c => c.tipo === '01').length;
  if (sinCredito > 0) advertencias.push(`${sinCredito} compra(s) con factura de consumidor final no entran al libro porque no dan crédito fiscal.`);
  const incompletas = libro('compras').filas.filter(f => f.alertas?.length).length;
  if (incompletas > 0) advertencias.push(`${incompletas} compra(s) del libro requieren revisión antes de declarar.`);
  const fueraDelPeriodo = listaInvalidados.filter(i => i.fecha.slice(0, 7) !== periodo).length;
  if (fueraDelPeriodo > 0) advertencias.push(`${fueraDelPeriodo} documento(s) invalidados corresponden a otro mes: revise si la declaración de ese mes necesita ajuste.`);

  return {
    periodo,
    libros,
    advertencias,
    iva: {
      debitoContribuyentes,
      debitoConsumidor,
      debito,
      credito,
      remanenteAnterior: ajustes.remanenteIva,
      impuestoDeterminado,
      remanenteSiguiente,
      montosRecibidos,
      montosRecibidosAplicados: aplicados,
      excedenteRetenciones: redondear(montosRecibidos - aplicados),
      montosEfectuados,
      aPagar: redondear(impuestoDeterminado - aplicados + montosEfectuados)
    },
    pagoCuenta: {
      ingresosBrutos,
      ingresosConRetencion: ajustes.ingresosConRetencion,
      baseGravable,
      tasa: config.tasaPagoCuenta,
      computado,
      excedenteAnterior: ajustes.excedentePagoCuenta,
      pagoCuenta,
      excedenteSiguiente: Math.max(redondear(ajustes.excedentePagoCuenta - computado), 0),
      retencionRenta,
      aPagar: redondear(pagoCuenta + retencionRenta)
    }
  };
}

// Hacienda carga CSV con punto y coma, sin encabezados, y el nombre no puede pasar de 25 caracteres.
export function csvDeLibro(libro: Libro): Buffer {
  const celda = (valor: string) => valor.replace(/[;"\s]+/g, ' ').trim();
  const texto = libro.filas.map(f => f.valores.map(celda).join(';')).join('\r\n');
  // Excel en Windows guarda estos CSV como ANSI: la Ñ y las tildes deben llegar igual
  const conservable = texto.replace(/[^\x00-\xFF]/g, '?');
  return Buffer.from(libro.filas.length ? `${conservable}\r\n` : '', 'latin1');
}

export function nombreArchivo(libro: Libro, periodo: string): string {
  const mes = `${periodo.slice(5, 7)}${periodo.slice(0, 4)}`;
  return `${libro.formulario.replace('-', '')}_${libro.anexo.slice(0, 6)}_${mes}.csv`;
}

// =========================================================================
// ACCESO A DATOS
// =========================================================================
export async function obtenerConfiguracion(emisorId: number): Promise<Configuracion> {
  const c = await prisma.configuracionContable.findUnique({ where: { emisor_id: emisorId } });
  return {
    tipoIngreso: c?.tipo_ingreso ?? 2,
    tipoOperacion: c?.tipo_operacion ?? 1,
    clasificacion: c?.clasificacion ?? 2,
    sector: c?.sector ?? 4,
    tipoCostoGasto: c?.tipo_costo_gasto ?? 2,
    tasaPagoCuenta: c ? Number(c.tasa_pago_cuenta) : 1.75
  };
}

function validarClasificacion(d: { tipoOperacion: number; clasificacion: number; sector: number; tipoCostoGasto: number }) {
  if (!CODIGOS.tipoOperacion.includes(d.tipoOperacion) || !CODIGOS.clasificacion.includes(d.clasificacion) || !CODIGOS.sector.includes(d.sector) || !CODIGOS.tipoCostoGasto.includes(d.tipoCostoGasto)) {
    throw new ContabilidadError('Los códigos de renta no son válidos.');
  }
  const especiales = [d.tipoOperacion, d.clasificacion, d.sector, d.tipoCostoGasto];
  // 8 y 9 tienen un significado único en el manual y van en las cuatro columnas a la vez
  for (const codigo of [8, 9]) {
    if (especiales.includes(codigo) && !especiales.every(v => v === codigo)) {
      throw new ContabilidadError(`El código ${codigo} debe usarse en las cuatro clasificaciones de renta.`);
    }
  }
  if (d.clasificacion === 1 && ![4, 5, 6, 7].includes(d.tipoCostoGasto)) throw new ContabilidadError('Un costo debe usar un tipo de costo (4 a 7).');
  if (d.clasificacion === 2 && ![1, 2, 3].includes(d.tipoCostoGasto)) throw new ContabilidadError('Un gasto debe usar un tipo de gasto (1 a 3).');
}

export async function guardarConfiguracion(emisorId: number, cuerpo: any): Promise<Configuracion> {
  const d = {
    tipoIngreso: Number(cuerpo.tipoIngreso),
    tipoOperacion: Number(cuerpo.tipoOperacion),
    clasificacion: Number(cuerpo.clasificacion),
    sector: Number(cuerpo.sector),
    tipoCostoGasto: Number(cuerpo.tipoCostoGasto),
    tasaPagoCuenta: Number(cuerpo.tasaPagoCuenta)
  };
  if (!CODIGOS.tipoIngreso.includes(d.tipoIngreso)) throw new ContabilidadError('El tipo de ingreso no es válido.');
  if (!Number.isFinite(d.tasaPagoCuenta) || d.tasaPagoCuenta < 0 || d.tasaPagoCuenta > 100) throw new ContabilidadError('La tasa de pago a cuenta no es válida.');
  validarClasificacion(d);
  const datos = {
    tipo_ingreso: d.tipoIngreso,
    tipo_operacion: d.tipoOperacion,
    clasificacion: d.clasificacion,
    sector: d.sector,
    tipo_costo_gasto: d.tipoCostoGasto,
    tasa_pago_cuenta: d.tasaPagoCuenta
  };
  await prisma.configuracionContable.upsert({ where: { emisor_id: emisorId }, create: { emisor_id: emisorId, ...datos }, update: datos });
  return d;
}

const noNegativo = (valor: any, nombre: string) => {
  const n = Number(valor ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new ContabilidadError(`${nombre} no puede ser negativo.`);
  return redondear(n);
};

export async function guardarAjustes(emisorId: number, periodo: string, cuerpo: any): Promise<void> {
  validarPeriodo(periodo);
  const datos = {
    remanente_iva: noNegativo(cuerpo.remanenteIva, 'El remanente de crédito fiscal'),
    excedente_pago_cuenta: noNegativo(cuerpo.excedentePagoCuenta, 'El excedente de pago a cuenta'),
    ingresos_con_retencion: noNegativo(cuerpo.ingresosConRetencion, 'Los ingresos con retención')
  };
  await prisma.periodoContable.upsert({
    where: { emisor_id_periodo: { emisor_id: emisorId, periodo } },
    create: { emisor_id: emisorId, periodo, ...datos },
    update: datos
  });
}

export async function actualizarDatosContables(emisorId: number, compraId: number, cuerpo: any): Promise<void> {
  const compra = await prisma.compra.findFirst({ where: { id: compraId, emisor_id: emisorId } });
  if (!compra) throw new ContabilidadError('Compra no encontrada.');

  const clasificacion = {
    tipoOperacion: Number(cuerpo.tipoOperacion),
    clasificacion: Number(cuerpo.clasificacion),
    sector: Number(cuerpo.sector),
    tipoCostoGasto: Number(cuerpo.tipoCostoGasto)
  };
  validarClasificacion(clasificacion);

  const periodoIva = cuerpo.periodoIva ? String(cuerpo.periodoIva) : null;
  if (periodoIva) {
    validarPeriodo(periodoIva);
    const atraso = mesesEntre(fechaIso(compra.fecha_compra).slice(0, 7), periodoIva);
    // Art. 63 de la Ley de IVA, citado en el manual: hasta tres periodos después de la emisión
    if (atraso < 0 || atraso > 3) throw new ContabilidadError('La compra solo puede declararse en su mes o en los tres siguientes.');
  }

  await prisma.compra.update({
    where: { id: compra.id },
    data: {
      gravada: noNegativo(cuerpo.gravada, 'El monto gravado'),
      exenta: noNegativo(cuerpo.exenta, 'El monto exento'),
      iva: noNegativo(cuerpo.iva, 'El crédito fiscal'),
      periodo_iva: periodoIva,
      tipo_operacion: clasificacion.tipoOperacion,
      clasificacion: clasificacion.clasificacion,
      sector: clasificacion.sector,
      tipo_costo_gasto: clasificacion.tipoCostoGasto
    }
  });
}

// Las compras leídas antes de existir estas columnas se completan desde el JSON que ya tienen guardado.
async function completarDesgloses(emisorId: number): Promise<void> {
  const pendientes = await prisma.compra.findMany({
    where: { emisor_id: emisorId, gravada: null, archivos: { some: { tipo: 'JSON' } } },
    select: { id: true, archivos: { where: { tipo: 'JSON' }, select: { contenido: true } } }
  });
  for (const compra of pendientes) {
    const leido = leerDte(Buffer.from(compra.archivos[0].contenido));
    if (leido) await prisma.compra.update({ where: { id: compra.id }, data: desgloseDte(leido.dte) });
  }

  // Corrige las calculadas antes de restar el descuento global; una compra editada a mano no se toca.
  const calculadas = await prisma.compra.findMany({
    where: { emisor_id: emisorId, gravada: { not: null }, tipo_operacion: null, archivos: { some: { tipo: 'JSON' } } },
    select: { id: true, gravada: true, iva: true }
  });
  for (const compra of calculadas.filter(c => Math.abs(Number(c.iva) - Number(c.gravada) * 0.13) > 0.05)) {
    const archivo = await prisma.compraArchivo.findFirst({ where: { compra_id: compra.id, tipo: 'JSON' }, select: { contenido: true } });
    const leido = archivo && leerDte(Buffer.from(archivo.contenido));
    if (leido) await prisma.compra.update({ where: { id: compra.id }, data: desgloseDte(leido.dte) });
  }
}

const rangoDelMes = (periodo: string) => {
  const inicio = new Date(`${periodo}-01T00:00:00Z`);
  const fin = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 1));
  return { inicio, fin };
};

export async function reporteDelPeriodo(emisor: any, periodo: string) {
  validarPeriodo(periodo);
  await completarDesgloses(emisor.id);
  const { inicio, fin } = rangoDelMes(periodo);
  const ambiente = emisor.ambiente || '00';

  const [dtes, filasCompras, eventos, config, ajustes] = await Promise.all([
    prisma.dteEmitido.findMany({
      where: { emisor_id: emisor.id, ambiente, estado: 'PROCESADO', fecha_emision: { gte: inicio, lt: fin } },
      orderBy: [{ fecha_emision: 'asc' }, { hora_emision: 'asc' }],
      select: { tipo_dte: true, codigo_generacion: true, numero_control: true, sello_recepcion_mh: true, fecha_emision: true, hora_emision: true, json_enviado: true }
    }),
    prisma.compra.findMany({
      where: {
        emisor_id: emisor.id,
        ...(ambiente === '01' ? { NOT: { ambiente: '00' } } : {}),
        OR: [{ periodo_iva: periodo }, { periodo_iva: null, fecha_compra: { gte: inicio, lt: fin } }]
      },
      orderBy: [{ fecha_compra: 'asc' }, { id: 'asc' }]
    }),
    // El evento se fecha en hora de El Salvador (UTC-6)
    prisma.eventoDte.findMany({
      where: {
        emisor_id: emisor.id, ambiente, tipo: 'INVALIDACION', estado: 'PROCESADO',
        created_at: { gte: new Date(inicio.getTime() + 6 * 3600000), lt: new Date(fin.getTime() + 6 * 3600000) }
      },
      select: { dte_id: true }
    }),
    obtenerConfiguracion(emisor.id),
    prisma.periodoContable.findUnique({ where: { emisor_id_periodo: { emisor_id: emisor.id, periodo } } })
  ]);

  const documentosInvalidados = await prisma.dteEmitido.findMany({
    where: { id: { in: eventos.map(e => e.dte_id).filter((id): id is number => id !== null) }, emisor_id: emisor.id },
    select: { tipo_dte: true, codigo_generacion: true, numero_control: true, sello_recepcion_mh: true, fecha_emision: true }
  });

  const ventas: VentaContable[] = dtes.map(d => ({
    tipo: d.tipo_dte,
    codigo: d.codigo_generacion,
    control: d.numero_control,
    sello: d.sello_recepcion_mh,
    fecha: fechaIso(d.fecha_emision),
    hora: d.hora_emision.toISOString().slice(11, 19),
    json: d.json_enviado
  }));

  const listaCompras: CompraContable[] = filasCompras.map(c => ({
    id: c.id,
    tipo: c.tipo_documento,
    numero: c.numero_documento,
    codigo: c.codigo_generacion,
    sello: c.sello_recepcion,
    fecha: fechaIso(c.fecha_compra),
    proveedor: c.proveedor_nombre,
    documento: c.proveedor_documento,
    total: Number(c.monto_total),
    gravada: c.gravada === null ? null : Number(c.gravada),
    exenta: c.exenta === null ? null : Number(c.exenta),
    iva: c.iva === null ? null : Number(c.iva),
    percibido: Number(c.iva_percibido ?? 0),
    retenido: Number(c.iva_retenido ?? 0),
    periodoIva: c.periodo_iva,
    tipoOperacion: c.tipo_operacion,
    clasificacion: c.clasificacion,
    sector: c.sector,
    tipoCostoGasto: c.tipo_costo_gasto
  }));

  const listaInvalidados: InvalidadoContable[] = documentosInvalidados.map(d => ({
    tipo: d.tipo_dte,
    codigo: d.codigo_generacion,
    control: d.numero_control,
    sello: d.sello_recepcion_mh,
    fecha: fechaIso(d.fecha_emision)
  }));

  const reporte = construirReporte(periodo, ventas, listaCompras, listaInvalidados, config, {
    remanenteIva: Number(ajustes?.remanente_iva ?? 0),
    excedentePagoCuenta: Number(ajustes?.excedente_pago_cuenta ?? 0),
    ingresosConRetencion: Number(ajustes?.ingresos_con_retencion ?? 0)
  });

  return {
    ...reporte,
    configuracion: config,
    emisor: { nit: emisor.nit, nrc: emisor.nrc, razonSocial: emisor.razon_social, ambiente }
  };
}

export async function archivoAnexo(emisor: any, periodo: string, clave: string): Promise<{ nombre: string; contenido: Buffer }> {
  const { libros } = await reporteDelPeriodo(emisor, periodo);
  const libro = libros.find(l => l.clave === clave);
  if (!libro) throw new ContabilidadError('El anexo solicitado no existe.');
  return { nombre: nombreArchivo(libro, periodo), contenido: csvDeLibro(libro) };
}
