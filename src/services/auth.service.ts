import axios from 'axios';

interface AuthResponse {
  status: string;
  body: {
    user: string;
    token: string;
    rol: string;
    roles: string[];
    tokenType: string;
  };
}

// Caché de tokens por emisor (llave: `${nit}_${ambiente}`)
const cachedTokens = new Map<string, { token: string; expiration: number }>();

export async function getMHToken(emisor: { nit: string; pwd_mh: string; ambiente: string }): Promise<string> {
  const nitSanitized = emisor.nit.replace(/-/g, '');
  const cacheKey = `${nitSanitized}_${emisor.ambiente || '00'}`;

  // Si el token está en caché y aún le falta para expirar (margen de 5 minutos)
  const cached = cachedTokens.get(cacheKey);
  if (cached && Date.now() < cached.expiration - 300000) {
    return cached.token;
  }

  try {
    console.log(`Solicitando nuevo token de autenticación a MH para emisor ${nitSanitized} en ambiente ${emisor.ambiente || '00'}...`);
    
    const form = new URLSearchParams();
    form.append('user', nitSanitized); // El NIT del emisor es el usuario MH
    form.append('pwd', emisor.pwd_mh || '');

    const urlAuth = emisor.ambiente === '01'
      ? 'https://api.dtes.mh.gob.sv/seguridad/auth'
      : 'https://apitest.dtes.mh.gob.sv/seguridad/auth';

    const response = await axios.post<AuthResponse>(urlAuth, form, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.data.status !== 'OK') {
      throw new Error(`Error de autenticación MH: ${response.data.status}`);
    }

    const token = response.data.body.token;
    // Los tokens suelen durar 24 horas, definiremos 23 horas de seguridad
    const expiration = Date.now() + (23 * 60 * 60 * 1000); 

    cachedTokens.set(cacheKey, { token, expiration });
    console.log(`Token de MH obtenido exitosamente para emisor ${nitSanitized}`);
    return token;
  } catch (error: any) {
    const status = error.response?.status;
    const errorData = error.response?.data;
    console.error(`Error al obtener token MH para ${nitSanitized}:`, errorData || error.message);
    
    if (status && status >= 500) {
      throw new Error(`El servidor del Ministerio de Hacienda experimentó un error temporal (HTTP ${status}). Por favor, intenta de nuevo en unos momentos.`);
    } else if (error.code || !error.response) {
      throw new Error(`No se pudo conectar con el servidor del Ministerio de Hacienda (Error de red: ${error.message}). Verifica tu conexión o el estado de los servidores de MH.`);
    }
    
    throw new Error(`Fallo al autenticar con el Ministerio de Hacienda. Verifica el NIT y la contraseña API MH (pwd_mh) para el emisor ${nitSanitized}.`);
  }
}
