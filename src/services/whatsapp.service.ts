import axios from 'axios';
import { config } from '../config';

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
export async function enviarWhatsappDteApi(params: enviarWhatsappDteParams): Promise<{ success: boolean; whatsappWebUrl?: string; message: string }> {
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

  try {
    console.log(`📱 Enviando mensaje por Meta WhatsApp Cloud API a "${telefonoFormatted}" para DTE: ${codigoGeneracion}...`);

    // 1. Enviar mensaje de texto informativo
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: telefonoFormatted,
        type: 'text',
        text: {
          preview_url: true,
          body: mensajeText
        }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    // 2. Enviar documento PDF como adjunto
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: telefonoFormatted,
        type: 'document',
        document: {
          link: params.pdfUrl,
          filename: `${codigoGeneracion}.pdf`,
          caption: `Representación Gráfica ${params.tipoDteNombre}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log(`✅ WhatsApp enviado con éxito vía Meta Cloud API a "${telefonoFormatted}".`);

    return {
      success: true,
      message: `¡Documento enviado por WhatsApp con éxito a ${telefonoFormatted}!`
    };
  } catch (error: any) {
    const errorDetails = error.response?.data?.error?.message || error.message || error;
    console.error(`❌ Error al enviar por Meta WhatsApp Cloud API:`, errorDetails);
    
    // Si falla la API de Meta, lanzar el error exacto de Meta para corregir la causa raíz
    throw new Error(`Error de Meta WhatsApp API: ${errorDetails}`);
  }
}
