import crypto from 'crypto';
import prisma from '../db/prisma';
import { cifradoDisponible, cifrar, descifrar } from '../utils/cifrado';
import { getMHToken, invalidarTokenMH } from './auth.service';
import { firmarDocumento } from './firmador.service';
import { buscarPorCorreo } from './cuenta.service';

export const TIPOS_DTE = ['01', '03', '04', '05', '06', '07', '08', '09', '11', '14', '15'];

const CORREO_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TAMANO_MAXIMO_CERTIFICADO = 128 * 1024;

export class EmpresaError extends Error {
  constructor(mensaje: string, public estado = 422) {
    super(mensaje);
  }
}

const texto = (valor: unknown) => (typeof valor === 'string' ? valor.trim() : '');

const etiqueta = (contenido: string, nombre: string) => (contenido.match(new RegExp(`<${nombre}>([^<]*)</${nombre}>`)) || [])[1];

// Nunca incluye contraseñas ni el certificado: solo si están configurados.
function vista(e: any, documentos: Record<string, number> = {}) {
  return {
    id: e.id,
    nit: e.nit,
    nrc: e.nrc,
    razonSocial: e.razon_social,
    nombreComercial: e.nombre_comercial,
    codActividad: e.cod_actividad,
    descActividad: e.desc_actividad,
    direccion: e.direccion,
    telefono: e.telefono,
    correo: e.correo,
    ambiente: e.ambiente || '00',
    codEstablecimientoMh: e.cod_establecimiento_mh,
    codPuntoVentaMh: e.cod_punto_venta_mh,
    dtesVisibles: e.dtes_visibles || [],
    activo: e.activo,
    esAdmin: e.es_admin,
    cuentaActivada: !!e.password,
    tienePwdMh: !!e.pwd_mh,
    tienePwdFirmador: !!e.pwd_firmador,
    certificado: e.certificado ? { huella: e.certificado.huella, venceAt: e.certificado.vence_at, cargadoAt: e.certificado.cargado_at } : null,
    documentos
  };
}

export async function listarEmpresas() {
  const empresas = await prisma.emisor.findMany({
    orderBy: { id: 'asc' },
    include: { certificado: { select: { huella: true, vence_at: true, cargado_at: true } } }
  });
  const totales = await prisma.dteEmitido.groupBy({ by: ['emisor_id', 'ambiente'], _count: { _all: true } });
  return empresas.map(e => {
    const documentos: Record<string, number> = {};
    for (const t of totales) if (t.emisor_id === e.id) documentos[t.ambiente || '00'] = t._count._all;
    return vista(e, documentos);
  });
}

async function datosValidados(d: any, actual?: any) {
  const datos: any = {};
  const correo = texto(d.correo).toLowerCase();
  if (d.correo !== undefined || !actual) {
    if (!CORREO_REGEX.test(correo) || correo.length > 100) throw new EmpresaError('Indique un correo válido para el acceso de la empresa.');
    const otro = await buscarPorCorreo(correo);
    if (otro && otro.id !== actual?.id) throw new EmpresaError('Ese correo ya lo usa otra empresa: cada acceso necesita uno propio.', 409);
    datos.correo = correo;
  }

  const obligatorios: [string, string, string, number][] = [
    ['razonSocial', 'razon_social', 'la razón social', 150],
    ['codActividad', 'cod_actividad', 'el código de actividad', 6],
    ['descActividad', 'desc_actividad', 'la descripción de actividad', 150],
    ['telefono', 'telefono', 'el teléfono', 20],
    ['codEstablecimientoMh', 'cod_establecimiento_mh', 'el código de establecimiento', 4],
    ['codPuntoVentaMh', 'cod_punto_venta_mh', 'el código de punto de venta', 4]
  ];
  for (const [campo, columna, nombre, largo] of obligatorios) {
    if (d[campo] === undefined && actual) continue;
    const valor = texto(d[campo]);
    if (!valor || valor.length > largo) throw new EmpresaError(`Indique ${nombre} (máximo ${largo} caracteres).`);
    datos[columna] = valor;
  }

  if (d.nrc !== undefined || !actual) {
    const nrc = texto(d.nrc).replace(/-/g, '');
    if (!/^[0-9]{1,8}$/.test(nrc)) throw new EmpresaError('El NRC debe tener solo números, hasta 8 dígitos.');
    datos.nrc = nrc;
  }
  if (d.nombreComercial !== undefined) datos.nombre_comercial = texto(d.nombreComercial).slice(0, 150) || null;
  if (d.direccion !== undefined || !actual) {
    const { departamento, municipio, distrito, complemento } = d.direccion || {};
    if (!departamento || !municipio || !texto(complemento)) throw new EmpresaError('Complete la dirección de la empresa.');
    datos.direccion = { departamento, municipio, distrito: distrito || null, complemento: texto(complemento) };
  }
  if (d.dtesVisibles !== undefined || !actual) {
    const lista = Array.isArray(d.dtesVisibles) ? d.dtesVisibles.filter((t: string) => TIPOS_DTE.includes(t)) : [];
    if (lista.length === 0) throw new EmpresaError('Seleccione al menos un documento autorizado.');
    datos.dtes_visibles = lista;
  }
  if (texto(d.pwdMh)) datos.pwd_mh = texto(d.pwdMh);
  if (texto(d.pwdFirmador)) datos.pwd_firmador = texto(d.pwdFirmador);
  return datos;
}

export async function crearEmpresa(d: any) {
  const nit = texto(d.nit).replace(/-/g, '');
  if (!/^([0-9]{14}|[0-9]{9})$/.test(nit)) throw new EmpresaError('El NIT debe tener 14 o 9 dígitos.');
  if (await prisma.emisor.findUnique({ where: { nit } })) throw new EmpresaError('Ya existe una empresa con ese NIT.', 409);
  const datos = await datosValidados(d);
  // Toda empresa nueva inicia en pruebas: pasar a producción exige verificar sus credenciales.
  return vista(await prisma.emisor.create({ data: { nit, ...datos, ambiente: '00', activo: true, es_admin: false } }));
}

async function buscar(id: number) {
  const empresa = await prisma.emisor.findUnique({ where: { id } });
  if (!empresa) throw new EmpresaError('Empresa no encontrada.', 404);
  return empresa;
}

export async function actualizarEmpresa(id: number, d: any, adminId: number) {
  const actual = await buscar(id);
  const datos = await datosValidados(d, actual);

  if (d.activo !== undefined) {
    if (id === adminId && d.activo === false) throw new EmpresaError('No puede suspender la cuenta con la que está administrando.');
    datos.activo = !!d.activo;
  }

  if (d.ambiente !== undefined && d.ambiente !== actual.ambiente) {
    if (!['00', '01'].includes(d.ambiente)) throw new EmpresaError('Ambiente no válido.');
    if (d.confirmarAmbiente !== true) throw new EmpresaError('Confirme el cambio de ambiente.');
    if (d.ambiente === '01') {
      const verificacion = await verificarEmpresa(id, { ...datos, ambiente: '01' });
      if (!verificacion.firma.ok || !verificacion.hacienda.ok) {
        throw new EmpresaError(`No se puede pasar a producción. Firma: ${verificacion.firma.mensaje} Hacienda: ${verificacion.hacienda.mensaje}`);
      }
    }
    datos.ambiente = d.ambiente;
  }

  const actualizada = await prisma.emisor.update({
    where: { id },
    data: datos,
    include: { certificado: { select: { huella: true, vence_at: true, cargado_at: true } } }
  });
  if (datos.pwd_mh || datos.ambiente) invalidarTokenMH(actualizada as any);
  return vista(actualizada);
}

// Rechaza aquí lo que después fallaría al firmar: otro NIT, certificado vencido o clave equivocada.
export async function guardarCertificado(id: number, contenido: unknown, clave: unknown) {
  if (!cifradoDisponible()) throw new EmpresaError('Falta configurar CORREO_CIFRADO_KEY en el servidor.', 503);
  const empresa = await buscar(id);
  const certificado = typeof contenido === 'string' ? contenido.trim() : '';
  if (!certificado.startsWith('<CertificadoMH>') || certificado.length > TAMANO_MAXIMO_CERTIFICADO) {
    throw new EmpresaError('El archivo no es un certificado de Hacienda (.crt).');
  }

  const nit = etiqueta(certificado, 'nit');
  if (nit !== empresa.nit) throw new EmpresaError('El certificado pertenece a otro NIT.');
  if (etiqueta(certificado, 'activo') !== 'true') throw new EmpresaError('El certificado no está activo.');

  const vencimiento = Number(etiqueta(certificado, 'notAfter'));
  const venceAt = Number.isFinite(vencimiento) && vencimiento > 0 ? new Date(vencimiento * 1000) : null;
  if (venceAt && venceAt < new Date()) throw new EmpresaError('El certificado está vencido.');

  const privada = (certificado.match(/<privateKey>([\s\S]*?)<\/privateKey>/) || [])[1] || '';
  const huellaClave = etiqueta(privada, 'clave');
  if (!huellaClave) throw new EmpresaError('El archivo no incluye la llave privada.');
  const claveFinal = texto(clave) || empresa.pwd_firmador || '';
  if (crypto.createHash('sha512').update(claveFinal).digest('hex') !== huellaClave.toLowerCase()) {
    throw new EmpresaError('La contraseña de la llave privada no corresponde a este certificado.');
  }

  const huella = crypto.createHash('sha256').update(certificado).digest('hex').slice(0, 16);
  const datos = { contenido: cifrar(certificado), huella, vence_at: venceAt, cargado_at: new Date() };
  await prisma.$transaction([
    prisma.certificadoEmisor.upsert({ where: { emisor_id: id }, create: { emisor_id: id, ...datos }, update: datos }),
    prisma.emisor.update({ where: { id }, data: { pwd_firmador: claveFinal } })
  ]);
  return { huella, venceAt };
}

// Firma una muestra y pide un token. No transmite nada a Hacienda.
export async function verificarEmpresa(id: number, cambios: any = {}) {
  const empresa = { ...(await buscar(id)), ...cambios };
  const credenciales = { nit: empresa.nit, pwd_mh: empresa.pwd_mh || '', ambiente: empresa.ambiente || '00' };

  const firma = { ok: false, mensaje: '' };
  try {
    if (!empresa.pwd_firmador) throw new Error('Falta la contraseña de la llave privada.');
    await firmarDocumento(empresa.nit, { verificacion: 'SIN VALOR', fecha: new Date().toISOString() }, empresa.pwd_firmador);
    firma.ok = true;
    firma.mensaje = 'El firmador firmó una muestra con este certificado.';
  } catch (error: any) {
    firma.mensaje = /No such file|llave publica/i.test(error.message)
      ? 'El firmador aún no tiene el certificado. Si lo acabas de cargar, espera un minuto y vuelve a verificar.'
      : `No se pudo firmar: ${String(error.message).split('Detalle: ').pop()}`;
  }

  const hacienda = { ok: false, mensaje: '' };
  try {
    if (!credenciales.pwd_mh) throw new Error('Falta la contraseña de la API de Hacienda.');
    invalidarTokenMH(credenciales);
    await getMHToken(credenciales);
    hacienda.ok = true;
    hacienda.mensaje = `Hacienda aceptó la contraseña en ${credenciales.ambiente === '01' ? 'producción' : 'pruebas'}.`;
  } catch (error: any) {
    hacienda.mensaje = String(error.message);
  }
  return { ambiente: credenciales.ambiente, firma, hacienda };
}

// Una línea por empresa: "<nit> <certificado en base64>". Lo consume el firmador.
export async function certificadosParaFirmador(): Promise<string> {
  const certificados = await prisma.certificadoEmisor.findMany({
    where: { emisor: { activo: true } },
    include: { emisor: { select: { nit: true } } }
  });
  return certificados
    .map(c => `${c.emisor.nit} ${Buffer.from(descifrar(c.contenido), 'utf8').toString('base64')}`)
    .join('\n') + '\n';
}
