import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'antigravity-dte-multitenant-secret-key-2026';

export interface TokenPayload {
  emisorId: number;
  correo: string;
  nit: string;
}

export function generateToken(payload: TokenPayload): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
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
      
    if (signature !== expectedSignature) return null;
    
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch (e) {
    return null;
  }
}
