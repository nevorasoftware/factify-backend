// Límite de intentos en memoria. Alcanza mientras el backend corra en una sola instancia.
const intentos = new Map<string, { cuenta: number; vence: number }>();

export function excedido(clave: string, maximo: number, ventanaMs: number): boolean {
  const ahora = Date.now();
  const actual = intentos.get(clave);
  if (actual && actual.vence > ahora) {
    actual.cuenta += 1;
    return actual.cuenta > maximo;
  }
  if (intentos.size > 10000) {
    for (const [k, v] of intentos) if (v.vence <= ahora) intentos.delete(k);
  }
  intentos.set(clave, { cuenta: 1, vence: ahora + ventanaMs });
  return false;
}

export function limpiarIntentos(clave: string): void {
  intentos.delete(clave);
}
