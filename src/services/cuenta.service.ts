import crypto from 'crypto';
import prisma from '../db/prisma';
import { config } from '../config';
import { hashPassword } from '../utils/password';
import { enviarCorreoCuenta } from './email.service';

export type TipoToken = 'RECUPERAR' | 'INVITACION';

const MINUTO = 60 * 1000;
const VIGENCIA: Record<TipoToken, number> = { RECUPERAR: 60 * MINUTO, INVITACION: 72 * 60 * MINUTO };
const MAXIMO_POR_HORA = 3;

export class CuentaError extends Error {}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const escapar = (texto: string) => texto.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function validarPassword(password: unknown): string {
  const limpia = typeof password === 'string' ? password.trim() : '';
  if (limpia.length < 10 || limpia.length > 128 || !/[A-Za-zÀ-ÿ]/.test(limpia) || !/[0-9]/.test(limpia)) {
    throw new CuentaError('La contraseña debe tener al menos 10 caracteres, con letras y números.');
  }
  return limpia;
}

export function buscarPorCorreo(correo: string) {
  return prisma.emisor.findFirst({ where: { correo: { equals: correo.trim(), mode: 'insensitive' } } });
}

// El enlace vuelve al frontend que lo pidió, solo si está autorizado en CORS_ORIGINS.
export function frontendDe(origen?: string): string {
  const autorizados = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  if (origen && autorizados.includes(origen)) return origen;
  return (process.env.FRONTEND_URL || autorizados[0] || 'https://factify-frontend-production.up.railway.app').replace(/\/$/, '');
}

function plantilla(titulo: string, parrafo: string, boton: string, enlace: string, pie: string) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #0f172a;">
      <h2 style="margin-top: 0; color: #0d9488;">${titulo}</h2>
      <p style="line-height: 1.5;">${parrafo}</p>
      <p style="text-align: center; margin: 28px 0;">
        <a href="${enlace}" style="background: #0d9488; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">${boton}</a>
      </p>
      <p style="font-size: 13px; color: #475569; line-height: 1.5;">${pie}</p>
      <p style="font-size: 12px; color: #94a3b8; word-break: break-all;">Si el botón no funciona, copia este enlace en tu navegador:<br />${enlace}</p>
    </div>
  `;
}

// Devuelve false si no se pudo enviar. Un enlace nuevo anula los anteriores de la misma cuenta.
export async function enviarEnlace(emisor: { id: number; correo: string | null; razon_social: string | null }, tipo: TipoToken, origen?: string): Promise<boolean> {
  if (!emisor.correo) return false;
  const token = crypto.randomBytes(32).toString('base64url');
  const ahora = new Date();
  await prisma.$transaction([
    prisma.tokenCuenta.updateMany({ where: { emisor_id: emisor.id, usado_at: null }, data: { usado_at: ahora } }),
    prisma.tokenCuenta.create({
      data: { emisor_id: emisor.id, token_hash: hashToken(token), tipo, expira_at: new Date(ahora.getTime() + VIGENCIA[tipo]) }
    })
  ]);

  // En el fragmento (#) el token no llega a los registros del servidor ni a sitios externos.
  const enlace = `${frontendDe(origen)}/restablecer#token=${token}`;
  const empresa = escapar(emisor.razon_social || 'tu empresa');
  if (tipo === 'INVITACION') {
    return enviarCorreoCuenta(emisor.correo, 'Activa tu cuenta de facturación electrónica', plantilla(
      'Activa tu cuenta',
      `Se creó el acceso de <strong>${empresa}</strong> al sistema de facturación electrónica. Crea tu contraseña para entrar.`,
      'Crear contraseña', enlace,
      'El enlace vence en 72 horas y solo se puede usar una vez.'
    ));
  }
  return enviarCorreoCuenta(emisor.correo, 'Restablece tu contraseña', plantilla(
    'Restablece tu contraseña',
    `Recibimos una solicitud para cambiar la contraseña de <strong>${empresa}</strong>.`,
    'Crear nueva contraseña', enlace,
    'El enlace vence en 60 minutos y solo se puede usar una vez. Si no lo pediste, ignora este correo: tu contraseña sigue igual.'
  ));
}

// La respuesta al usuario es siempre la misma, exista o no la cuenta.
export async function solicitarRecuperacion(correo: string, origen?: string): Promise<void> {
  const emisor = await buscarPorCorreo(correo);
  if (!emisor || !emisor.activo) return;
  const haceUnaHora = new Date(Date.now() - 60 * MINUTO);
  const recientes = await prisma.tokenCuenta.count({ where: { emisor_id: emisor.id, tipo: 'RECUPERAR', created_at: { gte: haceUnaHora } } });
  if (recientes >= MAXIMO_POR_HORA) return;
  await enviarEnlace(emisor, 'RECUPERAR', origen);
}

export async function validarToken(token: string) {
  const registro = await prisma.tokenCuenta.findUnique({
    where: { token_hash: hashToken(token) },
    include: { emisor: { select: { activo: true } } }
  });
  if (!registro || registro.usado_at || registro.expira_at < new Date() || !registro.emisor.activo) return null;
  return registro;
}

// Marca primero el token: dos envíos simultáneos no pueden usarlo dos veces.
export async function restablecerPassword(token: string, password: unknown): Promise<void> {
  const limpia = validarPassword(password);
  const registro = await validarToken(token);
  if (!registro) throw new CuentaError('El enlace ya no es válido. Solicita uno nuevo.');

  const ahora = new Date();
  const emisor = await prisma.$transaction(async tx => {
    const marcado = await tx.tokenCuenta.updateMany({ where: { id: registro.id, usado_at: null }, data: { usado_at: ahora } });
    if (marcado.count !== 1) throw new CuentaError('El enlace ya no es válido. Solicita uno nuevo.');
    return tx.emisor.update({
      where: { id: registro.emisor_id },
      data: { password: hashPassword(limpia), sesiones_desde: ahora }
    });
  });

  if (emisor.correo) await avisarCambio(emisor.correo);
}

export async function cambiarPassword(emisorId: number, nueva: unknown): Promise<string | null> {
  const limpia = validarPassword(nueva);
  const emisor = await prisma.emisor.update({
    where: { id: emisorId },
    data: { password: hashPassword(limpia), sesiones_desde: new Date() }
  });
  await prisma.tokenCuenta.updateMany({ where: { emisor_id: emisorId, usado_at: null }, data: { usado_at: new Date() } });
  if (emisor.correo) await avisarCambio(emisor.correo);
  return emisor.correo;
}

function avisarCambio(correo: string) {
  return enviarCorreoCuenta(correo, 'Tu contraseña cambió', `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #0f172a;">
      <h2 style="margin-top: 0; color: #0d9488;">Tu contraseña cambió</h2>
      <p style="line-height: 1.5;">La contraseña de tu cuenta se cambió el ${new Date().toLocaleString('es-SV', { timeZone: 'America/El_Salvador' })} (hora de El Salvador) y se cerraron las demás sesiones.</p>
      <p style="line-height: 1.5;">Si no fuiste tú, usa "¿Olvidaste tu contraseña?" de inmediato y avisa a Nevora.</p>
    </div>
  `);
}
