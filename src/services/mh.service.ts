import axios from 'axios';
import { getMHToken, invalidarTokenMH } from './auth.service';
import { firmarDocumento } from './firmador.service';

interface RecepcionResponse {
  version: number;
  ambiente: string;
  versionApp: number;
  estado: string;
  codigoGeneracion: string;
  selloRecibido?: string;
  fhProcesamiento: string;
  clasificaMsg: string;
  codigoMsg: string;
  descripcionMsg: string;
  observaciones?: string[];
}

type EmisorMH = { nit: string; pwd_mh: string; pwd_firmador: string; ambiente: string };

// Manual Técnico §3.3: tiempo de espera de 8 segundos antes de consultar el estado.
const MH_TIMEOUT_MS = Number(process.env.MH_TIMEOUT_MS) || 8000;

// El documento salió hacia MH y no hubo respuesta: pudo haberse recibido.
export class EnvioIndeterminadoError extends Error {}

const baseMh = (ambiente: string) =>
  ambiente === '01' ? 'https://api.dtes.mh.gob.sv' : 'https://apitest.dtes.mh.gob.sv';

export async function enviarAlMH(
  documentoBase: any,
  tipoDte: string,
  versionDte: number,
  emisor: EmisorMH
): Promise<RecepcionResponse & { documentoFirmado: string }> {
  // 1. Obtener Token
  console.log(`[MH SERVICE] Enviar DTE ${tipoDte} - numeroControl: "${documentoBase?.identificacion?.numeroControl}"`);
  let token = await getMHToken(emisor);

  // 2. Firmar Documento
  const nitEmisor = emisor.nit.replace(/-/g, '');
  const documentoFirmado = await firmarDocumento(nitEmisor, documentoBase, emisor.pwd_firmador || '');

  // 3. Preparar el Payload final para Recepción
  const payloadRecepcion = {
    ambiente: emisor.ambiente || '00',
    idEnvio: Math.floor(Date.now() / 1000),
    version: versionDte,
    tipoDte: tipoDte,
    documento: documentoFirmado,
    codigoGeneracion: documentoBase.identificacion.codigoGeneracion
  };

  console.log(`Enviando DTE ${tipoDte} al Ministerio de Hacienda para el emisor ${nitEmisor} en ambiente ${emisor.ambiente || '00'}...`);

  // 4. Enviar al Ministerio
  const enviar = () => axios.post<RecepcionResponse>(`${baseMh(emisor.ambiente)}/fesv/recepciondte`, payloadRecepcion, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
    },
    timeout: MH_TIMEOUT_MS
  });

  try {
    let response;
    try {
      response = await enviar();
    } catch (error: any) {
      if (error.response?.status !== 401) throw error;
      // Token vencido antes de lo previsto: un 401 garantiza que MH no procesó el documento.
      invalidarTokenMH(emisor);
      token = await getMHToken(emisor);
      response = await enviar();
    }
    console.log('Respuesta del MH:', response.data.estado);
    return { ...response.data, documentoFirmado };
  } catch (error: any) {
    if (error.response && error.response.status < 500 && error.response.data?.estado) {
      console.error('Rechazo MH:', error.response.data);
      return { ...error.response.data, documentoFirmado };
    }
    throw new EnvioIndeterminadoError(
      `Hacienda no confirmó la recepción (${error.response?.status || error.code || error.message})`
    );
  }
}

// Firma y transmite un evento. Sin respuesta de MH el resultado se desconoce: se reporta como pendiente.
export async function enviarEventoMh(
  ruta: 'anulardte' | 'contingencia',
  evento: any,
  emisor: EmisorMH,
  datosEnvio: Record<string, any>
): Promise<any> {
  const nit = emisor.nit.replace(/-/g, '');
  let token = await getMHToken(emisor);
  const documento = await firmarDocumento(nit, evento, emisor.pwd_firmador || '');
  const enviar = () => axios.post(`${baseMh(emisor.ambiente)}/fesv/${ruta}`, { ...datosEnvio, documento }, {
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    timeout: MH_TIMEOUT_MS
  });

  try {
    let response;
    try {
      response = await enviar();
    } catch (error: any) {
      if (error.response?.status !== 401) throw error;
      invalidarTokenMH(emisor);
      token = await getMHToken(emisor);
      response = await enviar();
    }
    return { ...response.data, documentoFirmado: documento };
  } catch (error: any) {
    if (error.response && error.response.status < 500 && error.response.data?.estado) {
      return { ...error.response.data, documentoFirmado: documento };
    }
    throw new EnvioIndeterminadoError(
      `Hacienda no confirmó la recepción (${error.response?.status || error.code || error.message})`
    );
  }
}

// Devuelve null si MH no conoce el documento o no se pudo consultar.
export async function consultarDteMh(
  codigoGeneracion: string,
  tipoDte: string,
  emisor: EmisorMH
): Promise<RecepcionResponse | null> {
  try {
    const token = await getMHToken(emisor);
    const response = await axios.post<RecepcionResponse>(
      `${baseMh(emisor.ambiente)}/fesv/recepcion/consultadte/`,
      // Postgres devuelve el UUID en minúsculas; MH lo registra en mayúsculas.
      { nitEmisor: emisor.nit.replace(/-/g, ''), tdte: tipoDte, codigoGeneracion: codigoGeneracion.toUpperCase() },
      { headers: { 'Content-Type': 'application/json', 'Authorization': token }, timeout: MH_TIMEOUT_MS }
    );
    return response.data?.estado ? response.data : null;
  } catch (error: any) {
    console.error(`No se pudo consultar ${codigoGeneracion} en MH:`, error.response?.status || error.message);
    return null;
  }
}
