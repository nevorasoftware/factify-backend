import nodemailer from 'nodemailer';
import dns from 'dns';
import { config } from '../config';

// Preferir IPv4 para evitar errores ENETUNREACH en contenedores sin soporte IPv6
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {
  // Ignorar si no está soportado en la versión de Node
}

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

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter) {
    const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, clientId, clientSecret, refreshToken } = config.email;

    // Si se configuran credenciales OAuth2 para Gmail API (vía HTTPS)
    if (clientId && clientSecret && refreshToken) {
      console.log('📧 Utilizando Gmail API via OAuth2 (HTTPS)...');
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: smtpUser,
          clientId: clientId,
          clientSecret: clientSecret,
          refreshToken: refreshToken
        }
      });
      return transporter;
    }

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
    const mailTransporter = getTransporter();
    if (!mailTransporter) {
      console.warn(`⚠️ No se pudo enviar correo para DTE ${params.codigoGeneracion}: Credenciales SMTP no configuradas.`);
      return false;
    }

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

    if (!destinoCorreo || !destinoCorreo.includes('@')) {
      console.warn(`⚠️ Correo destino inválido: "${destinoCorreo}". No se enviará notificación por email.`);
      return false;
    }

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

    const info = await mailTransporter.sendMail({
      from: config.email.emailFrom,
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

    console.log(`📧 Correo enviado con éxito a "${destinoCorreo}" para DTE: ${codigoGeneracion}. MessageId: ${info.messageId}`);
    return true;
  } catch (error: any) {
    console.error(`❌ Error al enviar correo de DTE ${params.codigoGeneracion}:`, error.message || error);
    transporter = null;
    return false;
  }
}
