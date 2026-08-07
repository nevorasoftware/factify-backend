import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 4001,
  mh: {
    ambiente: process.env.MH_AMBIENTE || '00',
    user: process.env.MH_USER || '',
    pwd: process.env.MH_PWD || '',
    pwdPri: process.env.MH_PWD_PRI || '',
    urlAuth: process.env.MH_URL_AUTH || 'https://apitest.dtes.mh.gob.sv/seguridad/auth',
    urlRecepcion: process.env.MH_URL_RECEPCION || 'https://apitest.dtes.mh.gob.sv/fesv/recepciondte',
    urlConsulta: process.env.MH_URL_CONSULTA || 'https://apitest.dtes.mh.gob.sv/fesv/consultadte'
  },
  firmador: {
    url: process.env.FIRMADOR_URL || 'http://localhost:8113/firmardocumento/'
  },
  email: {
    smtpHost: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    smtpPort: parseInt((process.env.SMTP_PORT || '465').trim(), 10),
    smtpSecure: process.env.SMTP_SECURE ? (process.env.SMTP_SECURE.trim() === 'true') : true,
    smtpUser: (process.env.SMTP_USER || '').trim(),
    smtpPass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
    emailFrom: (process.env.EMAIL_FROM || '"Nevora Software DTE" <softwarenevora@gmail.com>').trim()
  }
};
