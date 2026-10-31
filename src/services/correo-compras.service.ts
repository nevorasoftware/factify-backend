import dns from 'dns/promises';
import net from 'net';
import { ImapFlow } from 'imapflow';
import prisma from '../db/prisma';
import { descifrar } from '../utils/cifrado';
import { evaluarCompra, leerDte, DatosCompra } from './compra-dte.service';

const PUERTO_IMAP = 993;
const LOTE_MENSAJES = 200;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PDF = 10 * 1024 * 1024;
const MAX_TEXTO = 200 * 1024;
const MAX_DETALLE = 200;
const MINUTOS_SIN_AVANCE = 10;

const ASUNTO_DTE = /\bDTE\b|documento tributario|c[oó]digo de generaci[oó]n/i;
const TEXTO_DTE = /\bDTE\b|documento tributario|factura|cr[eé]dito fiscal|comprobante|c[oó]digo de generaci[oó]n/i;

const SERVIDORES: Record<string, string> = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com'
};
const DOMINIOS_SIN_CONTRASENA = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'];

export type Periodo = 'TODO' | 'MES' | 'DIA';

export class ConexionCorreoError extends Error {}

const dominioDe = (correo: string) => correo.split('@')[1]?.toLowerCase() || '';

export function servidorSugerido(correo: string): string | null {
  return SERVIDORES[dominioDe(correo)] || null;
}

const redesInternas = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16]
].forEach(([red, prefijo]) => redesInternas.addSubnet(red as string, prefijo as number, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fd00::', 8]]
  .forEach(([red, prefijo]) => redesInternas.addSubnet(red as string, prefijo as number, 'ipv6'));

// El servidor lo escribe el usuario: no debe poder apuntar a la red interna de Railway.
async function validarServidor(host: string): Promise<void> {
  const invalido = new ConexionCorreoError('El servidor de correo no es válido.');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host) || net.isIP(host) || /\.(internal|local)$/i.test(host)) {
    throw invalido;
  }
  let direcciones: { address: string; family: number }[];
  try {
    direcciones = await dns.lookup(host, { all: true });
  } catch {
    throw new ConexionCorreoError(`No se encontró el servidor de correo ${host}.`);
  }
  if (direcciones.some(d => redesInternas.check(d.address, d.family === 6 ? 'ipv6' : 'ipv4'))) throw invalido;
}

function errorDeConexion(error: any): ConexionCorreoError {
  if (error instanceof ConexionCorreoError) return error;
  if (error?.authenticationFailed) {
    return new ConexionCorreoError('El servidor de correo rechazó el acceso. Revise que sea una contraseña de aplicación vigente, no la contraseña normal del correo.');
  }
  if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ESOCKET'].includes(error?.code)) {
    return new ConexionCorreoError('No se pudo conectar con el servidor de correo. Revise el servidor o intente de nuevo.');
  }
  console.error('Error IMAP:', error?.code, error?.message);
  return new ConexionCorreoError('No se pudo leer el correo. Intente de nuevo.');
}

function crearCliente(host: string, usuario: string, password: string): ImapFlow {
  const cliente = new ImapFlow({
    host,
    port: PUERTO_IMAP,
    secure: true,
    auth: { user: usuario, pass: password },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 120000
  });
  // Sin este manejador, un corte de red tumbaría el proceso.
  cliente.on('error', (error: any) => console.error('Conexión IMAP interrumpida:', error?.code || error?.message));
  return cliente;
}

export async function probarConexion(host: string, usuario: string, password: string): Promise<void> {
  if (DOMINIOS_SIN_CONTRASENA.includes(dominioDe(usuario))) {
    throw new ConexionCorreoError('Microsoft no permite leer cuentas de Outlook o Hotmail con contraseña. Por ahora se admiten Gmail, Yahoo, iCloud y correos con acceso IMAP.');
  }
  await validarServidor(host);
  const cliente = crearCliente(host, usuario, password);
  try {
    await cliente.connect();
    const candado = await cliente.getMailboxLock('INBOX', { readOnly: true });
    candado.release();
    await cliente.logout();
  } catch (error) {
    cliente.close();
    throw errorDeConexion(error);
  }
}

// =========================================================================
// RECORRIDO DE LA BANDEJA
// =========================================================================
interface Adjunto {
  parte: string;
  nombre: string;
  tamano: number;
}

export interface MensajeLeido {
  uid: number;
  asunto: string;
  remitente: string;
  jsons: Adjunto[];
  pdfs: Adjunto[];
  textos: Adjunto[];
}

function clasificarPartes(nodo: any, mensaje: MensajeLeido): void {
  if (!nodo) return;
  if (nodo.childNodes?.length) {
    nodo.childNodes.forEach((hijo: any) => clasificarPartes(hijo, mensaje));
    return;
  }
  const tipo = String(nodo.type || '').toLowerCase();
  const nombre = String(nodo.dispositionParameters?.filename || nodo.parameters?.name || '');
  const parte = { parte: nodo.part || '1', nombre, tamano: Number(nodo.size) || 0 };
  if (/\.json$/i.test(nombre) || tipo === 'application/json') mensaje.jsons.push(parte);
  else if (/\.pdf$/i.test(nombre) || tipo === 'application/pdf') mensaje.pdfs.push(parte);
  else if (!nombre && (tipo === 'text/plain' || tipo === 'text/html')) mensaje.textos.push(parte);
}

async function descargar(cliente: ImapFlow, uid: number, parte: string, limite: number): Promise<Buffer | null> {
  const { content } = await cliente.download(String(uid), parte, { uid: true, maxBytes: limite });
  if (!content) return null;
  const trozos: Buffer[] = [];
  for await (const trozo of content) trozos.push(Buffer.from(trozo));
  return Buffer.concat(trozos);
}

export function desdeDePeriodo(periodo: Periodo, ahora = new Date()): Date | null {
  if (periodo === 'TODO') return null;
  const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/El_Salvador' });
  // IMAP compara solo la fecha: el mediodía evita que la zona horaria la mueva un día
  return new Date(`${periodo === 'MES' ? `${hoy.slice(0, 8)}01` : hoy}T12:00:00Z`);
}

export interface Avance {
  total: number;
  revisados: number;
  importadas: number;
  duplicadas: number;
  ignoradas: number;
  por_revisar: number;
  detalle: { resultado: string; documento?: string; proveedor?: string; asunto?: string; motivo: string }[];
}

export type GuardarCompra = (datos: DatosCompra, archivos: { json: { nombre: string; contenido: Buffer }; pdf: { nombre: string; contenido: Buffer } | null }) => Promise<'NUEVA' | 'DUPLICADA'>;

function anotar(avance: Avance, entrada: Avance['detalle'][number]) {
  if (avance.detalle.length < MAX_DETALLE) avance.detalle.push(entrada);
}

function elegirPdf(pdfs: Adjunto[], datos: DatosCompra): Adjunto | null {
  const aceptables = pdfs.filter(p => p.tamano <= MAX_PDF);
  const propio = aceptables.find(p => {
    const nombre = p.nombre.toLowerCase();
    return nombre.includes(datos.codigoGeneracion) || nombre.includes(datos.numeroControl.toLowerCase());
  });
  return propio || (aceptables.length === 1 ? aceptables[0] : null);
}

async function pareceDte(cliente: ImapFlow, mensaje: MensajeLeido): Promise<boolean> {
  if (TEXTO_DTE.test(mensaje.asunto) || mensaje.pdfs.some(p => TEXTO_DTE.test(p.nombre))) return true;
  for (const texto of mensaje.textos) {
    const contenido = await descargar(cliente, mensaje.uid, texto.parte, MAX_TEXTO);
    if (contenido && TEXTO_DTE.test(contenido.toString('utf8'))) return true;
  }
  return false;
}

async function procesarMensaje(cliente: ImapFlow, mensaje: MensajeLeido, emisor: { nit: string; ambiente?: string | null }, avance: Avance, guardar: GuardarCompra): Promise<void> {
  const contexto = { asunto: mensaje.asunto.slice(0, 150) };
  let hayDte = false;

  for (const adjunto of mensaje.jsons) {
    if (adjunto.tamano > MAX_JSON) continue;
    const contenido = await descargar(cliente, mensaje.uid, adjunto.parte, MAX_JSON);
    const leido = contenido && leerDte(contenido);
    if (!contenido || !leido) continue;
    hayDte = true;

    const evaluacion = evaluarCompra(leido, emisor);
    if (!evaluacion.ok) {
      avance.ignoradas++;
      anotar(avance, { resultado: 'IGNORADO', documento: leido.dte.identificacion?.numeroControl, proveedor: leido.dte.emisor?.nombre, motivo: evaluacion.motivo, ...contexto });
      continue;
    }

    const datos = evaluacion.compra;
    const pdf = elegirPdf(mensaje.pdfs, datos);
    const pdfContenido = pdf ? await descargar(cliente, mensaje.uid, pdf.parte, MAX_PDF) : null;
    const resultado = await guardar(datos, {
      json: { nombre: `${datos.codigoGeneracion}.json`, contenido },
      pdf: pdfContenido ? { nombre: `${datos.codigoGeneracion}.pdf`, contenido: pdfContenido } : null
    });
    if (resultado === 'NUEVA') avance.importadas++;
    else avance.duplicadas++;
  }

  if (hayDte) return;
  if (mensaje.pdfs.length > 0 && await pareceDte(cliente, mensaje)) {
    avance.por_revisar++;
    anotar(avance, { resultado: 'REVISAR', motivo: 'Trae PDF pero no el JSON del DTE: regístrela a mano.', ...contexto });
  } else if (mensaje.jsons.length === 0 && mensaje.pdfs.length === 0 && ASUNTO_DTE.test(mensaje.asunto)) {
    avance.por_revisar++;
    anotar(avance, { resultado: 'REVISAR', motivo: 'Menciona un DTE pero no trae archivos adjuntos.', ...contexto });
  }
}

// La bandeja se abre en solo lectura: no marca correos como leídos ni cambia nada.
export async function recorrerBandeja(
  cliente: ImapFlow,
  periodo: Periodo,
  emisor: { nit: string; ambiente?: string | null },
  avance: Avance,
  guardar: GuardarCompra,
  alAvanzar: () => Promise<void>
): Promise<void> {
  const candado = await cliente.getMailboxLock('INBOX', { readOnly: true });
  try {
    const desde = desdeDePeriodo(periodo);
    const uids = (await cliente.search(desde ? { since: desde } : { all: true }, { uid: true })) || [];
    avance.total = uids.length;
    await alAvanzar();

    for (let i = 0; i < uids.length; i += LOTE_MENSAJES) {
      const lote = uids.slice(i, i + LOTE_MENSAJES);
      const mensajes: MensajeLeido[] = [];
      // Durante el fetch no se puede enviar otro comando IMAP: primero se reúne el lote.
      for await (const dato of cliente.fetch(lote.join(','), { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
        const mensaje: MensajeLeido = {
          uid: dato.uid,
          asunto: dato.envelope?.subject || '(sin asunto)',
          remitente: dato.envelope?.from?.[0]?.address || '',
          jsons: [],
          pdfs: [],
          textos: []
        };
        clasificarPartes(dato.bodyStructure, mensaje);
        mensajes.push(mensaje);
      }

      for (const mensaje of mensajes) {
        try {
          await procesarMensaje(cliente, mensaje, emisor, avance, guardar);
        } catch (error: any) {
          // Una conexión caída no se resuelve con el siguiente correo
          if (!cliente.usable) throw error;
          console.error(`Error al procesar el correo UID ${mensaje.uid}:`, error?.message);
          avance.por_revisar++;
          anotar(avance, { resultado: 'ERROR', asunto: mensaje.asunto.slice(0, 150), motivo: 'No se pudo procesar este correo.' });
        }
      }
      avance.revisados = Math.min(i + lote.length, uids.length);
      await alAvanzar();
    }
  } finally {
    candado.release();
  }
}

// =========================================================================
// GUARDADO SIN DUPLICADOS
// =========================================================================
export function guardarCompraDe(emisorId: number): GuardarCompra {
  return async (datos, archivos) => {
    const adjuntos = [
      { tipo: 'JSON', nombre: archivos.json.nombre, contenido: archivos.json.contenido },
      ...(archivos.pdf ? [{ tipo: 'PDF', nombre: archivos.pdf.nombre, contenido: archivos.pdf.contenido }] : [])
    ];

    const existente = await prisma.compra.findFirst({
      where: {
        emisor_id: emisorId,
        OR: [
          { codigo_generacion: datos.codigoGeneracion },
          { numero_documento: datos.numeroControl, proveedor_documento: datos.proveedorDocumento }
        ]
      },
      select: { id: true, codigo_generacion: true, archivos: { select: { tipo: true } } }
    });

    if (existente) {
      // Ya registrada (a mano o en otra lectura): solo se completan los archivos que le falten.
      const presentes = existente.archivos.map(a => a.tipo);
      const faltantes = adjuntos.filter(a => !presentes.includes(a.tipo));
      if (faltantes.length > 0) {
        await prisma.compraArchivo.createMany({ data: faltantes.map(a => ({ ...a, compra_id: existente.id })), skipDuplicates: true });
      }
      if (!existente.codigo_generacion) {
        await prisma.compra.update({
          where: { id: existente.id },
          data: { codigo_generacion: datos.codigoGeneracion, sello_recepcion: datos.sello, ambiente: datos.ambiente }
        });
      }
      return 'DUPLICADA';
    }

    try {
      await prisma.compra.create({
        data: {
          emisor_id: emisorId,
          origen: 'CORREO',
          proveedor_nombre: datos.proveedorNombre,
          proveedor_documento: datos.proveedorDocumento,
          tipo_documento: datos.tipoDte,
          numero_documento: datos.numeroControl,
          fecha_compra: new Date(`${datos.fecha}T00:00:00Z`),
          monto_total: datos.monto,
          codigo_generacion: datos.codigoGeneracion,
          sello_recepcion: datos.sello,
          ambiente: datos.ambiente,
          observacion: datos.observacion,
          ...datos.desglose,
          items: { create: datos.items },
          archivos: { create: adjuntos }
        }
      });
      return 'NUEVA';
    } catch (error: any) {
      // Dos lecturas simultáneas: la restricción única de la base de datos decide cuál queda.
      if (error?.code === 'P2002') return 'DUPLICADA';
      throw error;
    }
  };
}

// =========================================================================
// PROCESO EN SEGUNDO PLANO
// =========================================================================
export function importacionVencida(importacion: { estado: string; updated_at: Date }): boolean {
  return importacion.estado === 'EN_PROCESO' && Date.now() - importacion.updated_at.getTime() > MINUTOS_SIN_AVANCE * 60000;
}

export async function ejecutarImportacion(importacionId: number, emisor: { id: number; nit: string; ambiente?: string | null }, periodo: Periodo): Promise<void> {
  const avance: Avance = { total: 0, revisados: 0, importadas: 0, duplicadas: 0, ignoradas: 0, por_revisar: 0, detalle: [] };
  const guardarAvance = (extra: Record<string, any> = {}) =>
    prisma.importacionCorreo.update({ where: { id: importacionId }, data: { ...avance, detalle: avance.detalle as any, ...extra } });

  let cliente: ImapFlow | null = null;
  try {
    const conexion = await prisma.conexionCorreo.findUnique({ where: { emisor_id: emisor.id } });
    if (!conexion) throw new ConexionCorreoError('Conecte primero el correo.');
    await validarServidor(conexion.host);
    cliente = crearCliente(conexion.host, conexion.usuario, descifrar(conexion.password_cifrada));
    await cliente.connect();
    await recorrerBandeja(cliente, periodo, emisor, avance, guardarCompraDe(emisor.id), async () => { await guardarAvance(); });
    await guardarAvance({ estado: 'TERMINADA' });
    await cliente.logout();
  } catch (error: any) {
    cliente?.close();
    await guardarAvance({ estado: 'ERROR', error: errorDeConexion(error).message }).catch(e => console.error('No se pudo guardar el error de la importación:', e?.message));
  }
}
