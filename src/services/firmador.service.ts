import axios from 'axios';
import { config } from '../config';

export async function firmarDocumento(nit: string, documentoJSON: any, pwdPri: string): Promise<any> {
  try {
    console.log(`Enviando documento al firmador local para el emisor ${nit}...`);
    
    // Formato exacto que requiere el firmador de MH en su versión local
    const payload = {
      nit: nit,
      activo: true,
      passwordPri: pwdPri || '', 
      dteJson: documentoJSON
    };

    const response = await axios.post(config.firmador.url, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data.status === 'ERROR') {
      throw new Error(response.data.body);
    }

    // El firmador retorna en body el documento firmado como string
    console.log(`Documento firmado correctamente para ${nit}`);
    return response.data.body;

  } catch (error: any) {
    console.error('Error en firmador local:', JSON.stringify(error.response?.data || error.message, null, 2));
    throw new Error(`Fallo al firmar el documento para ${nit}. Asegúrate de que el Firmador esté corriendo en ${config.firmador.url} y la contraseña de la llave privada (pwd_firmador) sea correcta.`);
  }
}
