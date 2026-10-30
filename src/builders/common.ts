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

// El número de control lo asigna siempre el backend; el valor recibido del cliente se ignora.
export function sanearNumeroControl(
  _numControl: string | undefined,
  _tipoDte: string,
  codEstable: string,
  codPunto: string,
  _emisorId: number
): { numControl: string; needsGeneration: boolean; codEstableUsed: string; codPuntoUsed: string } {
  return {
    numControl: '',
    needsGeneration: true,
    codEstableUsed: formatearCodEstableMH(codEstable),
    codPuntoUsed: formatearCodPuntoVentaMH(codPunto)
  };
}

// Reserva atómica: dos emisiones simultáneas nunca reciben el mismo correlativo.
export async function obtenerSiguienteCorrelativo(
  tipoDte: string,
  emisorId: number,
  codEstable: string,
  codPunto: string,
  correlativoInicial: number
): Promise<string> {
  const establePunto = `${formatearCodEstableMH(codEstable)}${formatearCodPuntoVentaMH(codPunto)}`;
  const prefijo = `DTE-${tipoDte}-${establePunto}-`;

  const prisma = (await import('../db/prisma')).default;
  const emisor = await prisma.emisor.findUnique({ where: { id: emisorId }, select: { ambiente: true } });
  const ambiente = emisor?.ambiente || '00';

  const filas = await prisma.$queryRaw<{ ultimo: bigint }[]>`
    INSERT INTO correlativos (emisor_id, ambiente, tipo_dte, establecimiento_punto, ultimo)
    VALUES (
      ${emisorId}, ${ambiente}, ${tipoDte}, ${establePunto},
      GREATEST(
        ${correlativoInicial}::bigint,
        COALESCE((
          SELECT MAX(CAST(RIGHT(numero_control, 15) AS BIGINT)) + 1
          FROM dtes_emitidos
          WHERE emisor_id = ${emisorId} AND ambiente = ${ambiente} AND numero_control LIKE ${prefijo + '%'}
        ), 1)
      )
    )
    ON CONFLICT (emisor_id, ambiente, tipo_dte, establecimiento_punto)
    DO UPDATE SET ultimo = correlativos.ultimo + 1
    RETURNING ultimo`;

  return `${prefijo}${filas[0].ultimo.toString().padStart(15, '0')}`;
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
    fecEmi: fecEmi,
    horEmi: horEmi,
    tipoMoneda: identificacionOriginal.tipoMoneda || 'USD'
  };
}
