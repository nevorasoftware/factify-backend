import crypto from 'crypto';

const PREFIJO = 'scrypt';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `${PREFIJO}$${salt}$${hash}`;
}

export function esHash(guardada: string): boolean {
  return guardada.startsWith(`${PREFIJO}$`);
}

// Acepta también contraseñas heredadas en texto plano; el login las convierte a hash.
export function verificarPassword(password: string, guardada: string | null | undefined): boolean {
  if (!guardada) return false;
  if (esHash(guardada)) {
    const [, salt, hash] = guardada.split('$');
    const esperado = Buffer.from(hash, 'base64url');
    const calculado = crypto.scryptSync(password, salt, 64);
    return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
  }
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(guardada).digest();
  return crypto.timingSafeEqual(a, b);
}
