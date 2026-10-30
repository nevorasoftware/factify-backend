import fs from 'fs';
import path from 'path';
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

// Schemas oficiales de MH, copiados sin cambios de svfe-json-schemas.
const SCHEMAS: Record<string, string> = {
  '01': 'v2/fe-f-v2.json',
  '03': 'v4/fe-ccf-v4.json',
  '04': 'v4/fe-nr-v4.json',
  '05': 'v4/fe-nc-v4.json',
  '06': 'v4/fe-nd-v4.json',
  '07': 'v2/fe-cr-v2.json',
  '08': 'v2/fe-cl-v2.json',
  '09': 'v2/fe-dcl-v2.json',
  '11': 'v3/fe-fex-v3.json',
  '14': 'v2/fe-fse-v2.json',
  '15': 'v2/fe-cd-v2.json'
};

export class DteInvalidoError extends Error {
  constructor(message: string, public detalles: string[] = []) {
    super(message);
  }
}

const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 6 });
addFormats(ajv);

const compilados = new Map<string, ValidateFunction>();

function obtenerValidador(tipoDte: string): ValidateFunction {
  let validar = compilados.get(tipoDte);
  if (!validar) {
    const ruta = path.join(process.cwd(), 'schemas', SCHEMAS[tipoDte]);
    validar = ajv.compile(JSON.parse(fs.readFileSync(ruta, 'utf8')));
    compilados.set(tipoDte, validar);
  }
  return validar;
}

export function validarContraSchema(documento: any, tipoDte: string): void {
  const validar = obtenerValidador(tipoDte);
  if (!validar(documento)) {
    const detalles = (validar.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`);
    throw new DteInvalidoError('El documento no cumple el formato oficial de Hacienda', detalles);
  }
}
