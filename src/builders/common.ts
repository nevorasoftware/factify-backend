import { v4 as uuidv4 } from 'uuid';

export const round2 = (num: number) => Number((Math.round((num + Number.EPSILON) * 100) / 100).toFixed(2));

export function formatearCodEstableMH(cod: string | undefined | null): string {
  if (!cod) return "M001";
  const str = String(cod).trim().toUpperCase();
  if (/^(M|B|S|P)[0-9]{3}$/.test(str)) {
    return str;
  }
  const digits = str.replace(/[^0-9]/g, '');
  const num = parseInt(digits, 10);
  if (isNaN(num) || num === 0) {
    return "M001";
  }
  const letterMatch = str.match(/^[MBSP]/);
  const prefix = letterMatch ? letterMatch[0] : (num === 1 ? "M" : "S");
  return `${prefix}${num.toString().padStart(3, '0')}`;
}

export function formatearCodPuntoVentaMH(cod: string | undefined | null): string {
  if (!cod) return "P001";
  const str = String(cod).trim().toUpperCase();
  if (/^P[0-9]{3}$/.test(str)) {
    return str;
  }
  const digits = str.replace(/[^0-9]/g, '');
  const num = parseInt(digits, 10);
  if (isNaN(num) || num === 0) {
    return "P001";
  }
  return `P${num.toString().padStart(3, '0')}`;
}

export function obtenerEmisorBase(emisorDb: any) {
  const dirEmisor = (emisorDb.direccion as any) || { departamento: "01", municipio: "01", complemento: "San Salvador, El Salvador" };
  const estFormatted = formatearCodEstableMH(emisorDb.cod_establecimiento_mh);
  const ptoFormatted = formatearCodPuntoVentaMH(emisorDb.cod_punto_venta_mh);
  return {
    nit: emisorDb.nit,
    nrc: emisorDb.nrc || "000000",
    nombre: emisorDb.razon_social || "Emisor SaaS",
    codActividad: emisorDb.cod_actividad || "46900",
    descActividad: emisorDb.desc_actividad || "Otros servicios",
    nombreComercial: emisorDb.nombre_comercial || null,
    tipoEstablecimiento: "01",
    direccion: {
      departamento: dirEmisor.departamento || "01",
      municipio: dirEmisor.municipio || "01",
      complemento: dirEmisor.complemento || "San Salvador, El Salvador"
    },
    telefono: emisorDb.telefono || "22222222",
    correo: emisorDb.correo || "correo@empresa.com",
    codEstableMH: estFormatted,
    codEstable: estFormatted,
    codPuntoVentaMH: ptoFormatted,
    codPuntoVenta: ptoFormatted,
  };
}

export function sanearNumeroControl(
  numControl: string | undefined,
  tipoDte: string,
  codEstable: string,
  codPunto: string,
  emisorId: number
): { numControl: string; needsGeneration: boolean; codEstableUsed: string; codPuntoUsed: string } {
  const estFormatted = formatearCodEstableMH(codEstable);
  const ptoFormatted = formatearCodPuntoVentaMH(codPunto);
  const expectedPattern = new RegExp(`^DTE-${tipoDte}-(M|B|S|P)[0-9]{3}P[0-9]{3}-[0-9]{15}$`);

  if (!numControl) {
    return { numControl: '', needsGeneration: true, codEstableUsed: estFormatted, codPuntoUsed: ptoFormatted };
  }

  let cleaned = String(numControl).trim().toUpperCase();
  cleaned = cleaned.replace(new RegExp(`^DTE-${tipoDte}-`), '').replace(/^DTE-/, '');
  const parts = cleaned.split('-');
  const cleanParts = parts.map(p => p.replace(/[^A-Z0-9]/g, '')).filter(p => p.length > 0);

  if (cleanParts.length >= 2) {
    const rawCorrelativo = cleanParts[cleanParts.length - 1];
    const rawEstablePunto = cleanParts.slice(0, cleanParts.length - 1).join('');
    let estUsed = estFormatted;
    let ptoUsed = ptoFormatted;

    if (rawEstablePunto.length === 8) {
      estUsed = formatearCodEstableMH(rawEstablePunto.substring(0, 4));
      ptoUsed = formatearCodPuntoVentaMH(rawEstablePunto.substring(4, 8));
    }

    const establePunto = `${estUsed}${ptoUsed}`;
    const correlativoNum = parseInt(rawCorrelativo, 10);
    if (!isNaN(correlativoNum) && correlativoNum > 0) {
      const correlativo = correlativoNum.toString().padStart(15, '0');
      const finalNum = `DTE-${tipoDte}-${establePunto}-${correlativo}`;
      return {
        numControl: finalNum,
        needsGeneration: !expectedPattern.test(finalNum),
        codEstableUsed: estUsed,
        codPuntoUsed: ptoUsed
      };
    }
  } else if (cleanParts.length === 1 && /^[0-9]+$/.test(cleanParts[0])) {
    const correlativoNum = parseInt(cleanParts[0], 10);
    if (!isNaN(correlativoNum) && correlativoNum > 0) {
      const correlativo = correlativoNum.toString().padStart(15, '0');
      const establePunto = `${estFormatted}${ptoFormatted}`;
      const finalNum = `DTE-${tipoDte}-${establePunto}-${correlativo}`;
      return {
        numControl: finalNum,
        needsGeneration: !expectedPattern.test(finalNum),
        codEstableUsed: estFormatted,
        codPuntoUsed: ptoFormatted
      };
    }
  }

  return { numControl: '', needsGeneration: true, codEstableUsed: estFormatted, codPuntoUsed: ptoFormatted };
}

export async function obtenerSiguienteCorrelativo(
  tipoDte: string,
  emisorId: number,
  codEstable: string,
  codPunto: string,
  correlativoInicial: number
): Promise<string> {
  const estFormatted = formatearCodEstableMH(codEstable);
  const ptoFormatted = formatearCodPuntoVentaMH(codPunto);
  const establePunto = `${estFormatted}${ptoFormatted}`;

  let correlativoNum = correlativoInicial;
  try {
    const prisma = (await import('../db/prisma')).default;
    const lastDte = await prisma.dteEmitido.findFirst({
      where: { tipo_dte: tipoDte, emisor_id: emisorId },
      orderBy: { id: 'desc' }
    });
    if (lastDte && lastDte.numero_control) {
      const parts = lastDte.numero_control.split('-');
      const lastNumStr = parts[parts.length - 1];
      if (lastNumStr) {
        const lastNum = parseInt(lastNumStr, 10);
        if (!isNaN(lastNum) && lastNum >= correlativoInicial) {
          correlativoNum = lastNum + 1;
        }
      }
    }
  } catch (e) {
    console.error(`⚠️ No se pudo obtener secuencial de BD para DTE ${tipoDte}, usando ${correlativoInicial}`);
  }
  const correlativo = correlativoNum.toString().padStart(15, '0');
  return `DTE-${tipoDte}-${establePunto}-${correlativo}`;
}

export function obtenerIdentificacionBase(identificacionOriginal: any, tipoDte: string, numControl: string, codGeneracion: string, fecEmi: string, horEmi: string, emisorDb: any) {
  return {
    version: identificacionOriginal.version || 1,
    ambiente: emisorDb.ambiente || '00',
    tipoDte: tipoDte,
    numeroControl: numControl,
    codigoGeneracion: codGeneracion,
    tipoModelo: identificacionOriginal.tipoModelo || 1,
    tipoOperacion: identificacionOriginal.tipoOperacion || 1,
    tipoContingencia: identificacionOriginal.tipoContingencia || null,
    motivoContin: identificacionOriginal.motivoContin || identificacionOriginal.motivoContigencia || null,
    fecEmi: identificacionOriginal.fecEmi || fecEmi,
    horEmi: identificacionOriginal.horEmi || horEmi,
    tipoMoneda: identificacionOriginal.tipoMoneda || 'USD'
  };
}
