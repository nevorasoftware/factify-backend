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
    smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: parseInt(process.env.SMTP_PORT || '465', 10),
    smtpSecure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    emailFrom: process.env.EMAIL_FROM || '"Nevora Software DTE" <softwarenevora@gmail.com>'
  }
};
