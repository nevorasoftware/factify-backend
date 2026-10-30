const UNIDADES = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUN', 'VEINTIDOS', 'VEINTITRES', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISEIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

function menorQueMil(n: number): string {
  if (n === 100) return 'CIEN';
  const partes: string[] = [];
  if (n >= 100) partes.push(CENTENAS[Math.floor(n / 100)]);
  const resto = n % 100;
  if (resto < 30) {
    if (resto > 0) partes.push(UNIDADES[resto]);
  } else {
    const unidad = resto % 10;
    partes.push(unidad > 0 ? `${DECENAS[Math.floor(resto / 10)]} Y ${UNIDADES[unidad]}` : DECENAS[Math.floor(resto / 10)]);
  }
  return partes.join(' ');
}

function enteroALetras(n: number): string {
  if (n === 0) return 'CERO';
  const partes: string[] = [];
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const resto = n % 1000;
  if (millones > 0) partes.push(millones === 1 ? 'UN MILLON' : `${enteroALetras(millones)} MILLONES`);
  if (miles > 0) partes.push(miles === 1 ? 'MIL' : `${menorQueMil(miles)} MIL`);
  if (resto > 0) partes.push(menorQueMil(resto));
  return partes.join(' ');
}

// Ej.: 1.13 -> "UN DOLAR CON 13/100 USD"
export function montoEnLetras(monto: number): string {
  const centavosTotales = Math.round(monto * 100);
  const entero = Math.floor(centavosTotales / 100);
  const centavos = centavosTotales % 100;
  const moneda = entero === 1 ? 'DOLAR' : 'DOLARES';
  return `${enteroALetras(entero)} ${moneda} CON ${String(centavos).padStart(2, '0')}/100 USD`;
}
