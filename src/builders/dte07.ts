import { montoEnLetras } from '../utils/letras';
import { DteInvalidoError } from '../services/schema.service';
import { IVA, round2, emisorV2, identificacionV2, receptorConDocumento, textoONull, validarYNumerar } from './v2';

// CAT-006: 22 y C4 tienen tasa fija; C9 (casos especiales) trae el valor retenido.
const TASAS_RETENCION: Record<string, number> = { '22': 0.01, C4: 0.13 };

function lineaRetencion(item: any, idx: number) {
  const montoSujetoGrav = round2(Number(item.montoSujetoGrav));
  const codigoRetencionMH = String(item.codigoRetencionMH || '').toUpperCase();
  if (!(montoSujetoGrav > 0)) {
    throw new DteInvalidoError(`El ítem ${idx + 1} debe tener un monto sujeto a retención mayor que cero.`);
  }
  if (!['22', 'C4', 'C9'].includes(codigoRetencionMH)) {
    throw new DteInvalidoError(`El ítem ${idx + 1} tiene un código de retención inválido.`);
  }
  const tasa = TASAS_RETENCION[codigoRetencionMH];
  const ivaRetenido = tasa ? round2(montoSujetoGrav * tasa) : round2(Number(item.ivaRetenido));
  if (!(ivaRetenido > 0)) {
    throw new DteInvalidoError(`El ítem ${idx + 1} debe tener un IVA retenido mayor que cero.`);
  }
  return {
    numItem: idx + 1,
    tipoDte: String(item.tipoDte || ''),
    tipoGeneracion: Number(item.tipoGeneracion),
    numeroDocumento: String(item.numeroDocumento || '').toUpperCase().trim(),
    fechaEmision: item.fechaEmision,
    montoSujetoGrav,
    codigoRetencionMH,
    ivaRetenido,
    descripcion: textoONull(item.descripcion)
  };
}

export async function construirDte07(req: any, versionDte: number, emisorDb: any) {
  const { receptor, cuerpoDocumento, resumen } = req.body;
  if (!Array.isArray(cuerpoDocumento) || cuerpoDocumento.length === 0) {
    throw new DteInvalidoError('El comprobante debe tener al menos un documento retenido.');
  }

  const lineas = cuerpoDocumento.map(lineaRetencion);
  const totalSujetoRetencion = round2(lineas.reduce((a: number, l: any) => a + l.montoSujetoGrav, 0));
  const totalIvaRetenido = round2(lineas.reduce((a: number, l: any) => a + l.ivaRetenido, 0));

  const documento = {
    identificacion: identificacionV2(req, '07', versionDte, emisorDb),
    emisor: emisorV2(emisorDb),
    receptor: receptorConDocumento(receptor, { direccionRequerida: true }),
    cuerpoDocumento: lineas,
    resumen: {
      totalSujetoRetencion,
      totalIva: round2(totalSujetoRetencion * IVA),
      totalIvaRetenido,
      totalLetras: montoEnLetras(totalIvaRetenido),
      observaciones: textoONull(resumen?.observaciones)
    },
    apendice: null
  };

  return validarYNumerar(documento, '07', emisorDb);
}
