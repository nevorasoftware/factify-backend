import crypto from 'crypto';
import { config } from '../config';

const clave = () => crypto.createHash('sha256').update(config.correoCompras.clave).digest();

export function cifradoDisponible(): boolean {
  return config.correoCompras.clave.length >= 32;
}

export function cifrar(texto: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clave(), iv);
  const datos = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), datos].map(parte => parte.toString('base64url')).join('.');
}

export function descifrar(cifrado: string): string {
  const [iv, tag, datos] = cifrado.split('.').map(parte => Buffer.from(parte, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', clave(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(datos), decipher.final()]).toString('utf8');
}
