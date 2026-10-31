// Interpreta el JSON de un DTE recibido por correo y decide si es una compra del emisor.
// El archivo viene de un remitente cualquiera: nada de su contenido se da por válido sin revisarlo.

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TIPOS_COMPRA = ['01', '03', '05', '06'];
const CONTENEDORES = ['dteJson', 'jsonDte', 'dteFirmado', 'dte', 'documento', 'json', 'data', 'body'];
const RESPUESTAS = ['respuestaHacienda', 'respuestaMH', 'respuestaMh', 'responseMH', 'respuesta', 'resultado', 'hacienda'];

export interface DteLeido {
  dte: any;
  sello: string | null;
}

export interface ItemCompra {
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  total: number;
}

export interface DatosCompra {
  codigoGeneracion: string;
  numeroControl: string;
  tipoDte: string;
  ambiente: string;
  fecha: string;
  proveedorNombre: string;
  proveedorDocumento: string;
  monto: number;
  sello: string | null;
  observacion: string | null;
  items: ItemCompra[];
}

export type Evaluacion = { ok: true; compra: DatosCompra } | { ok: false; motivo: string };

const soloDigitos = (valor: any) => String(valor ?? '').replace(/\D/g, '');
const redondear = (valor: number) => Math.round((valor + Number.EPSILON) * 100) / 100;
const numero = (valor: any) => {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
};

function selloEn(objeto: any): string | null {
  for (const clave of ['selloRecibido', 'selloRecepcion', 'sello']) {
    if (typeof objeto?.[clave] === 'string' && objeto[clave].trim()) return objeto[clave].trim();
  }
  for (const clave of RESPUESTAS) {
    const sello = objeto?.[clave] && typeof objeto[clave] === 'object' ? selloEn(objeto[clave]) : null;
    if (sello) return sello;
  }
  return null;
}

function buscarDte(valor: any, profundidad = 0): DteLeido | null {
  if (profundidad > 3) return null;

  if (typeof valor === 'string') {
    const texto = valor.trim();
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(texto)) {
      // Documento firmado (JWS) sin desempaquetar: el DTE es la parte central
      try {
        return buscarDte(JSON.parse(Buffer.from(texto.split('.')[1], 'base64url').toString('utf8')), profundidad + 1);
      } catch {
        return null;
      }
    }
    if (texto.startsWith('{')) {
      try {
        return buscarDte(JSON.parse(texto), profundidad + 1);
      } catch {
        return null;
      }
    }
    return null;
  }

  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null;

  if (valor.identificacion?.tipoDte && valor.identificacion?.codigoGeneracion) {
    return { dte: valor, sello: selloEn(valor) };
  }
  for (const clave of CONTENEDORES) {
    if (valor[clave] === undefined) continue;
    const encontrado = buscarDte(valor[clave], profundidad + 1);
    if (encontrado) return { dte: encontrado.dte, sello: encontrado.sello || selloEn(valor) };
  }
  return null;
}

export function leerDte(contenido: Buffer): DteLeido | null {
  return buscarDte(contenido.toString('utf8').replace(/^﻿/, ''));
}

function itemsDe(cuerpo: any): ItemCompra[] {
  if (!Array.isArray(cuerpo)) return [];
  return cuerpo.map((item: any) => ({
    descripcion: String(item?.descripcion ?? 'Sin descripción').slice(0, 255),
    cantidad: redondear(numero(item?.cantidad)),
    precio_unitario: redondear(numero(item?.precioUni)),
    total: redondear(numero(item?.ventaGravada) + numero(item?.ventaExenta) + numero(item?.ventaNoSuj) + numero(item?.noGravado))
  }));
}

export function evaluarCompra(leido: DteLeido, emisor: { nit: string; ambiente?: string | null }): Evaluacion {
  const { dte, sello } = leido;
  const id = dte.identificacion;
  const nitEmisor = soloDigitos(emisor.nit);
  const nitProveedor = soloDigitos(dte.emisor?.nit ?? dte.emisor?.numDocumento);
  const documentoReceptor = soloDigitos(dte.receptor?.nit ?? dte.receptor?.numDocumento);

  if (!TIPOS_COMPRA.includes(String(id.tipoDte))) {
    return { ok: false, motivo: `El tipo de documento ${id.tipoDte} no se registra como compra.` };
  }
  if (!UUID_REGEX.test(String(id.codigoGeneracion))) return { ok: false, motivo: 'El código de generación no es válido.' };
  if (typeof id.numeroControl !== 'string' || !/^DTE-\d{2}-/.test(id.numeroControl)) return { ok: false, motivo: 'El número de control no es válido.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(id.fecEmi)) || Number.isNaN(Date.parse(`${id.fecEmi}T00:00:00Z`))) return { ok: false, motivo: 'La fecha de emisión no es válida.' };
  if (!nitProveedor) return { ok: false, motivo: 'El documento no identifica al proveedor.' };
  if (nitProveedor === nitEmisor) return { ok: false, motivo: 'Es un documento emitido por usted, no una compra.' };
  if (emisor.ambiente === '01' && id.ambiente !== '01') return { ok: false, motivo: 'Es un documento de pruebas, sin validez fiscal.' };
  if (documentoReceptor && documentoReceptor !== nitEmisor) return { ok: false, motivo: 'El documento está dirigido a otra persona o empresa.' };
  if (!documentoReceptor && id.tipoDte !== '01') return { ok: false, motivo: 'El documento no identifica al comprador.' };

  const monto = Number(dte.resumen?.totalPagar ?? dte.resumen?.montoTotalOperacion);
  if (!Number.isFinite(monto) || monto < 0) return { ok: false, motivo: 'El documento no indica un monto válido.' };

  const observaciones = [
    !sello ? 'Sin sello de Hacienda' : null,
    !documentoReceptor ? 'No identifica al comprador' : null
  ].filter(Boolean);

  return {
    ok: true,
    compra: {
      codigoGeneracion: id.codigoGeneracion.toLowerCase(),
      numeroControl: id.numeroControl.slice(0, 50),
      tipoDte: id.tipoDte,
      ambiente: String(id.ambiente ?? '').slice(0, 2),
      fecha: id.fecEmi,
      proveedorNombre: String(dte.emisor?.nombre ?? dte.emisor?.nombreComercial ?? 'Proveedor sin nombre').slice(0, 200),
      proveedorDocumento: nitProveedor.slice(0, 20),
      monto: redondear(monto),
      sello: sello ? sello.slice(0, 60) : null,
      observacion: observaciones.length ? observaciones.join('. ') : null,
      items: itemsDe(dte.cuerpoDocumento)
    }
  };
}
