import crypto from 'crypto';

const SESSION_TTL_SECONDS = 12 * 60 * 60;

function cargarSecreto(): string {
  const secreto = process.env.JWT_SECRET;
  if (secreto && secreto.length >= 32) return secreto;
  // Nunca un valor fijo: estaría en el repo y cualquiera podría falsificar sesiones.
  console.warn('⚠️ JWT_SECRET ausente o menor a 32 caracteres. Se usa uno temporal: las sesiones y enlaces públicos se invalidan al reiniciar.');
  return crypto.randomBytes(48).toString('hex');
}

const JWT_SECRET = cargarSecreto();

export interface TokenPayload {
  emisorId: number;
  correo: string;
  nit: string;
}

export function firmarHmac(contenido: string, proposito: string): string {
  return crypto.createHmac('sha256', `${proposito}:${JWT_SECRET}`).update(contenido).digest('base64url');
}

export function firmaValida(recibida: string, esperada: string): boolean {
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function generateToken(payload: TokenPayload): string {
  const ahora = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: ahora, exp: ahora + SESSION_TTL_SECONDS })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const [header, body, signature] = token.split('.');
    if (!header || !body || !signature) return null;

    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');

    if (!firmaValida(signature, expectedSignature)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload as TokenPayload;
  } catch (e) {
    return null;
  }
}
