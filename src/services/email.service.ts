import nodemailer from 'nodemailer';
import dns from 'dns';
import axios from 'axios';
import { config } from '../config';

// Preferir IPv4 para evitar errores ENETUNREACH en contenedores sin soporte IPv6
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

export interface enviarCorreoDteParams {
  destinoCorreo: string;
  nombreReceptor: string;
  nombreEmisor: string;
  tipoDteNombre: string;
  numeroControl: string;
  codigoGeneracion: string;
  montoTotal: string;
  pdfBuffer: Buffer;
  jsonCompleto: any;
}

/**
 * Envía un correo utilizando la REST API oficial de Gmail mediante HTTPS (Puerto 443).
 * Evita cualquier bloqueo de puertos SMTP (25/465/587) en Railway o proveedores Cloud.
 */
async function enviarCorreoGmailApiHttp(params: enviarCorreoDteParams, emailFrom: string, clientId: string, clientSecret: string, refreshToken: string): Promise<boolean> {
  const {
    destinoCorreo,
    nombreReceptor,
    nombreEmisor,
    tipoDteNombre,
    numeroControl,
    codigoGeneracion,
    montoTotal,
    pdfBuffer,
    jsonCompleto
  } = params;

  console.log(`🌐 Obteniendo Access Token de Google OAuth2 vía HTTPS (Port 443)...`);

  // 1. Obtener Access Token refrescado vía HTTPS POST
  const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  }, { timeout: 15000 });

  const accessToken = tokenRes.data.access_token;
  if (!accessToken) {
    throw new Error('No se pudo obtener el Access Token de Google OAuth2');
  }

  // 2. Construir la estructura MIME con adjuntos en memoria
  const jsonString = JSON.stringify(jsonCompleto, null, 2);
  const jsonBuffer = Buffer.from(jsonString, 'utf-8');
  const subject = `${tipoDteNombre} Electrónica ${numeroControl} - ${nombreEmisor}`;
  
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <h2 style="color: #1a56db; margin-top: 0;">Estimado(a) ${nombreReceptor},</h2>
      <p>Adjunto a este correo encontrará su <strong>${tipoDteNombre} Electrónica</strong> emitida por <strong>${nombreEmisor}</strong> en cumplimiento con la normativa tributaria del Ministerio de Hacienda de El Salvador.</p>
      
      <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #64748b;"><strong>Tipo de Documento:</strong></td>
            <td style="padding: 6px 0; color: #0f172a;">${tipoDteNombre}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;"><strong>Número de Control:</strong></td>
            <td style="padding: 6px 0; color: #0f172a;">${numeroControl}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;"><strong>Código de Generación:</strong></td>
            <td style="padding: 6px 0; font-family: monospace; color: #0f172a;">${codigoGeneracion}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;"><strong>Monto Total:</strong></td>
            <td style="padding: 6px 0; color: #16a34a; font-weight: bold;">$${montoTotal} USD</td>
          </tr>
        </table>
      </div>

      <p style="font-size: 13px; color: #475569;">
        Se adjuntan los siguientes archivos oficiales:
        <ul>
          <li><strong>${codigoGeneracion}.pdf</strong> (Representación Gráfica del DTE)</li>
          <li><strong>${codigoGeneracion}.json</strong> (Documento Tributario Electrónico firmado)</li>
        </ul>
      </p>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0;" />
      <p style="font-size: 11px; color: #94a3b8; text-align: center;">
        Este es un correo automático generado por el sistema de Facturación Electrónica. Por favor no responda a este mensaje.
      </p>
    </div>
  `;

  const dummyTransporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'windows',
    buffer: true
  });

  const info = await dummyTransporter.sendMail({
    from: emailFrom,
    to: destinoCorreo,
    subject: subject,
    html: htmlBody,
    attachments: [
      {
        filename: `${codigoGeneracion}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      },
      {
        filename: `${codigoGeneracion}.json`,
        content: jsonBuffer,
        contentType: 'application/json'
      }
    ]
  });

  const rawMessageBuffer = info.message as Buffer;

  // 3. Encode a base64url (RFC 4648 §5)
  const rawBase64Url = rawMessageBuffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // 4. Enviar mediante HTTP POST a la REST API de Gmail
  const sendRes = await axios.post(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { raw: rawBase64Url },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  );

  console.log(`📧 Correo enviado con éxito vía Gmail REST API (HTTPS) a "${destinoCorreo}" para DTE: ${codigoGeneracion}. MessageId/ID: ${sendRes.data.id}`);
  return true;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter) {
    const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass } = config.email;
    const cleanHost = (smtpHost || 'smtp.gmail.com').trim().replace(/[^a-zA-Z0-9\.-]/g, '');
    if (!smtpUser || !smtpPass) {
      console.warn('⚠️ SMTP_USER o SMTP_PASS no están configurados en las variables de entorno. El envío de correos estará deshabilitado hasta configurarlos.');
      return null;
    }

    const isSecure = smtpPort === 465 ? true : (smtpPort === 587 ? false : smtpSecure);

    transporter = nodemailer.createTransport({
      host: cleanHost,
      port: smtpPort,
      secure: isSecure,
      lookup: (hostname: string, _options: any, callback: any) => {
        dns.lookup(hostname, { family: 4 }, callback);
      },
      connectionTimeout: 15000,
      socketTimeout: 20000,
      auth: {
        user: smtpUser.trim(),
        pass: smtpPass.replace(/\s+/g, '')
      }
    } as any);
  }
  return transporter;
}

/**
 * Envia por correo electrónico la representación gráfica en PDF y el archivo JSON oficial del DTE.
 */
export async function enviarCorreoDte(params: enviarCorreoDteParams): Promise<boolean> {
  try {
    const { destinoCorreo, codigoGeneracion } = params;

    if (!destinoCorreo || !destinoCorreo.includes('@')) {
      console.warn(`⚠️ Correo destino inválido: "${destinoCorreo}". No se enviará notificación por email.`);
      return false;
    }

    const { clientId, clientSecret, refreshToken, emailFrom } = config.email;

    // Si existen las credenciales OAuth2 de Google, usar la REST API HTTP (Puerto 443 - Imposible de bloquear)
    if (clientId && clientSecret && refreshToken) {
      return await enviarCorreoGmailApiHttp(params, emailFrom, clientId, clientSecret, refreshToken);
    }

    // Fallback a SMTP si no hay OAuth2
    const mailTransporter = getTransporter();
    if (!mailTransporter) {
      console.warn(`⚠️ No se pudo enviar correo para DTE ${codigoGeneracion}: Credenciales de correo no configuradas.`);
      return false;
    }

    const jsonString = JSON.stringify(params.jsonCompleto, null, 2);
    const jsonBuffer = Buffer.from(jsonString, 'utf-8');
    const subject = `${params.tipoDteNombre} Electrónica ${params.numeroControl} - ${params.nombreEmisor}`;

    const info = await mailTransporter.sendMail({
      from: emailFrom,
      to: destinoCorreo,
      subject: subject,
      html: `...`,
      attachments: [
        { filename: `${codigoGeneracion}.pdf`, content: params.pdfBuffer, contentType: 'application/pdf' },
        { filename: `${codigoGeneracion}.json`, content: jsonBuffer, contentType: 'application/json' }
      ]
    });

    console.log(`📧 Correo enviado con éxito vía SMTP a "${destinoCorreo}" para DTE: ${codigoGeneracion}. MessageId: ${info.messageId}`);
    return true;
  } catch (error: any) {
    console.error(`❌ Error al enviar correo de DTE ${params.codigoGeneracion}:`, error.response?.data || error.message || error);
    transporter = null;
    return false;
  }
}
