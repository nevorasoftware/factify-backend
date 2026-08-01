import axios from 'axios';
import { getMHToken } from './auth.service';
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

export async function enviarAlMH(
  documentoBase: any,
  tipoDte: string,
  versionDte: number,
  emisor: { nit: string; pwd_mh: string; pwd_firmador: string; ambiente: string }
): Promise<RecepcionResponse> {
  // 1. Obtener Token
  console.log(`[MH SERVICE] Enviar DTE ${tipoDte} - numeroControl: "${documentoBase?.identificacion?.numeroControl}"`);
  if (tipoDte === '11') {
    console.log('[DEBUG DTE 11 RESUMEN]:', JSON.stringify(documentoBase.resumen, null, 2));
  }
  const token = await getMHToken(emisor);

  // 2. Firmar Documento
  const nitEmisor = emisor.nit.replace(/-/g, '');
  const documentoFirmadoStr = await firmarDocumento(nitEmisor, documentoBase, emisor.pwd_firmador || '');

  // 3. Preparar el Payload final para Recepción
  const payloadRecepcion = {
    ambiente: emisor.ambiente || '00',
    idEnvio: 1, 
    version: versionDte,
    tipoDte: tipoDte,
    documento: documentoFirmadoStr
  };

  console.log(`Enviando DTE ${tipoDte} al Ministerio de Hacienda para el emisor ${nitEmisor} en ambiente ${emisor.ambiente || '00'}...`);

  // 4. Enviar al Ministerio
  try {
    const urlRecepcion = emisor.ambiente === '01'
      ? 'https://api.dtes.mh.gob.sv/fesv/recepciondte'
      : 'https://apitest.dtes.mh.gob.sv/fesv/recepciondte';

    const response = await axios.post<RecepcionResponse>(urlRecepcion, payloadRecepcion, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token, 
      }
    });

    console.log('Respuesta del MH:', response.data.estado);
    return response.data;
  } catch (error: any) {
    if (error.response) {
      console.error('Error MH (400/500):', error.response.data);
      return error.response.data as RecepcionResponse;
    }
    throw new Error('Fallo de red al conectar con MH: ' + error.message);
  }
}
