import axios from 'axios';
import { config } from '../config';

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';

export interface enviarWhatsappDteParams {
  destinoTelefono: string;
  nombreReceptor: string;
  nombreEmisor: string;
  tipoDteNombre: string;
  numeroControl: string;
  codigoGeneracion: string;
  montoTotal: string;
  pdfUrl: string;
  jsonUrl: string;
  pdfBuffer: Buffer;
  jsonCompleto: any;
}

/**
 * Normaliza números de teléfono para El Salvador y formato E.164.
 * Ejemplos: "7777-8888" -> "50377778888", "+503 7777 8888" -> "50377778888"
 */
export function normalizarTelefonoSV(telefono: string): string {
  const soloNumeros = telefono.replace(/\D/g, '');
  if (!soloNumeros) return '';

  // Si ya incluye el código de país 503 (11 dígitos)
  if (soloNumeros.length === 11 && soloNumeros.startsWith('503')) {
    return soloNumeros;
  }

  // Si tiene 8 dígitos (ej: 78901234, 22223333)
  if (soloNumeros.length === 8) {
    return `503${soloNumeros}`;
  }

  return soloNumeros;
}

/**
 * Genera el enlace directo para enviar por WhatsApp Web / App
 */
export function generarEnlaceWhatsAppWeb(params: enviarWhatsappDteParams): { url: string; telefonoFormatted: string; mensajeText: string } {
  const telefonoFormatted = normalizarTelefonoSV(params.destinoTelefono);
  
  const mensajeText = `📄 *${params.tipoDteNombre} Electrónica*\n` +
    `*Emisor:* ${params.nombreEmisor}\n` +
    `*Cliente:* ${params.nombreReceptor}\n` +
    `*Número Control:* ${params.numeroControl}\n` +
    `*Código Generación:* ${params.codigoGeneracion}\n` +
    `*Monto Total:* $${params.montoTotal} USD\n\n` +
    `Descargue sus archivos oficiales en los siguientes enlaces:\n` +
    `🔴 *PDF:* ${params.pdfUrl}\n` +
    `🔵 *JSON:* ${params.jsonUrl}\n\n` +
    `_Mensaje generado automáticamente por el sistema DTE SaaS._`;

  const url = `https://api.whatsapp.com/send?phone=${telefonoFormatted}&text=${encodeURIComponent(mensajeText)}`;

  return { url, telefonoFormatted, mensajeText };
}

/**
 * Envía el mensaje y documento mediante Meta WhatsApp Cloud API (HTTPS Port 443)
 */
export async function enviarWhatsappDteApi(params: enviarWhatsappDteParams): Promise<{ success: boolean; whatsappWebUrl?: string; mensajesMeta?: string[]; message: string }> {
  const { destinoTelefono, codigoGeneracion } = params;

  const { url: whatsappWebUrl, telefonoFormatted, mensajeText } = generarEnlaceWhatsAppWeb(params);

  if (!telefonoFormatted) {
    throw new Error(`Número de teléfono inválido o no especificado: "${destinoTelefono}"`);
  }

  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  // Si no están configuradas las claves de la API oficial de Meta, retornamos el enlace de WhatsApp Web
  if (!token || !phoneNumberId) {
    console.warn(`⚠️ WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID no están configurados en Railway. Se utilizará apertura directa de WhatsApp.`);
    return {
      success: true,
      whatsappWebUrl,
      message: 'Credenciales de Meta API no configuradas. Se generó enlace directo para abrir WhatsApp.'
    };
  }

  const base = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const enviar = async (cuerpo: any): Promise<string> => {
    const res = await axios.post(
      `${base}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: telefonoFormatted, ...cuerpo },
      { headers, timeout: 15000 }
    );
    return res.data?.messages?.[0]?.id;
  };

  // Los archivos se suben a Meta: no dependen de que Meta pueda descargar un enlace.
  const subir = async (contenido: Buffer, tipo: string, nombre: string): Promise<string> => {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', tipo);
    form.append('file', new Blob([new Uint8Array(contenido)], { type: tipo }), nombre);
    const res = await fetch(`${base}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(30000)
    });
    const datos: any = await res.json();
    if (!res.ok || !datos.id) throw new Error(datos.error?.message || `Error ${res.status} al subir ${nombre}`);
    return datos.id;
  };

  try {
    console.log(`📱 Enviando DTE ${codigoGeneracion} por WhatsApp a "${telefonoFormatted}"...`);
    const nombreBase = params.numeroControl || codigoGeneracion;

    const textoId = await enviar({ type: 'text', text: { preview_url: false, body: mensajeText } });

    const pdfId = await subir(params.pdfBuffer, 'application/pdf', `${nombreBase}.pdf`);
    const pdfMsgId = await enviar({
      type: 'document',
      document: { id: pdfId, filename: `${nombreBase}.pdf`, caption: `📄 Representación Gráfica - ${params.tipoDteNombre}` }
    });

    // WhatsApp no admite application/json como documento; se sube como texto conservando la extensión.
    const jsonId = await subir(Buffer.from(JSON.stringify(params.jsonCompleto, null, 2), 'utf-8'), 'text/plain', `${nombreBase}.json`);
    const jsonMsgId = await enviar({
      type: 'document',
      document: { id: jsonId, filename: `${nombreBase}.json`, caption: `💾 Archivo JSON Oficial Firmado - ${params.tipoDteNombre}` }
    });

    console.log(`✅ WhatsApp aceptado por Meta para "${telefonoFormatted}": ${textoId}, ${pdfMsgId}, ${jsonMsgId}`);

    return {
      success: true,
      mensajesMeta: [textoId, pdfMsgId, jsonMsgId],
      // Meta confirma la entrega de forma asíncrona: un 200 no garantiza que el mensaje llegó.
      message: `Mensaje, PDF y JSON aceptados por Meta para ${telefonoFormatted}.`
    };
  } catch (error: any) {
    const errorDetails = error.response?.data?.error?.message || error.message || error;
    console.error(`❌ Error al enviar por Meta WhatsApp Cloud API:`, errorDetails);
    
    // Si falla la API de Meta, lanzar el error exacto de Meta para corregir la causa raíz
    throw new Error(`Error de Meta WhatsApp API: ${errorDetails}`);
  }
}
