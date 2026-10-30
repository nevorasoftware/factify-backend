import { firmarHmac, firmaValida } from './jwt';

const PROPOSITO = 'enlace-publico-dte';
const TTL_SEGUNDOS = 7 * 24 * 60 * 60;

export function crearTokenEnlace(codigoGeneracion: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEGUNDOS;
  const contenido = `${codigoGeneracion.toUpperCase()}.${exp}`;
  return `${contenido}.${firmarHmac(contenido, PROPOSITO)}`;
}

export function leerTokenEnlace(token: string): string | null {
  const [codigoGeneracion, exp, firma] = String(token).split('.');
  if (!codigoGeneracion || !exp || !firma) return null;
  if (!firmaValida(firma, firmarHmac(`${codigoGeneracion}.${exp}`, PROPOSITO))) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return codigoGeneracion;
}
