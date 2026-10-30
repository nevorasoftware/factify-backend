import { Router } from 'express';
import { enviarAlMH, consultarDteMh, EnvioIndeterminadoError } from '../services/mh.service';
import { obtenerSiguienteCorrelativo } from '../builders/common';
import { hashPassword, esHash, verificarPassword } from '../utils/password';
import { crearTokenEnlace, leerTokenEnlace } from '../utils/enlace-publico';
import { config } from '../config';
import { verifyToken, generateToken } from '../utils/jwt';
import { generarJsonDteCompleto } from '../services/dte-json.service';
import { generarPdfDte } from '../services/pdf.service';
import { DteInvalidoError } from '../services/schema.service';
import fs from 'fs';
import path from 'path';
import { enviarCorreoDte } from '../services/email.service';
import { enviarWhatsappDteApi } from '../services/whatsapp.service';

const router = Router();

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const round2 = (num: number) => Number((Math.round((num + Number.EPSILON) * 100) / 100).toFixed(2));

// =========================================================================
// MIDDLEWARE DE AUTENTICACIÓN
// =========================================================================
export const authMiddleware = async (req: any, res: any, next: any) => {
  try {
    let token: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (req.query && req.query.token) {
      token = String(req.query.token);
    }

    if (!token) {
      return res.status(401).json({ success: false, error: 'Token de acceso no proporcionado' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
    }

    const prisma = (await import('../db/prisma')).default;
    const emisor = await prisma.emisor.findUnique({
      where: { id: decoded.emisorId }
    });

    if (!emisor) {
      return res.status(401).json({ success: false, error: 'Perfil de emisor no encontrado' });
    }

    // Adjuntar el emisor autenticado a la petición
    req.emisor = emisor;
    next();
  } catch (error: any) {
    console.error('Auth Middleware Error:', error);
    res.status(500).json({ success: false, error: 'Error de autenticación en el servidor' });
  }
};

// =========================================================================
// RUTAS DE AUTENTICACIÓN Y PERFIL
// =========================================================================

// Login de Emisor (Cliente SaaS)
router.post('/auth/login', async (req: any, res: any) => {
  try {
    const { correo, password } = req.body;
    if (!correo || !password) {
      return res.status(400).json({ success: false, error: 'Correo y contraseña son requeridos' });
    }

    const prisma = (await import('../db/prisma')).default;
    const emisor = await prisma.emisor.findFirst({
      where: {
        correo: {
          equals: correo.trim(),
          mode: 'insensitive'
        }
      }
    });

    if (!emisor || !verificarPassword(password.trim(), emisor.password)) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    // Contraseña heredada en texto plano: se reemplaza por su hash en el primer login correcto
    if (!esHash(emisor.password || '')) {
      await prisma.emisor.update({ where: { id: emisor.id }, data: { password: hashPassword(password.trim()) } });
    }

    console.log(`✅ [LOGIN] Login exitoso para emisor ID: ${emisor.id}`);

    // Generar token JWT stateless
    const token = generateToken({
      emisorId: emisor.id,
      correo: emisor.correo || '',
      nit: emisor.nit
    });

    res.json({
      success: true,
      token,
      emisor: {
        id: emisor.id,
        nit: emisor.nit,
        nrc: emisor.nrc,
        razonSocial: emisor.razon_social,
        nombreComercial: emisor.nombre_comercial,
        correo: emisor.correo,
        logoUrl: emisor.logo_url,
        dtesVisibles: emisor.dtes_visibles || ["01", "03", "11"], // Default fallback
        ambiente: emisor.ambiente || "00"
      }
    });
  } catch (error: any) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener datos del emisor actual
router.get('/auth/me', authMiddleware, async (req: any, res: any) => {
  const emisor = req.emisor;
  res.json({
    success: true,
    emisor: {
      id: emisor.id,
      nit: emisor.nit,
      nrc: emisor.nrc,
      razonSocial: emisor.razon_social,
      nombreComercial: emisor.nombre_comercial,
      codActividad: emisor.cod_actividad,
      descActividad: emisor.desc_actividad,
      direccion: emisor.direccion,
      telefono: emisor.telefono,
      correo: emisor.correo,
      logoUrl: emisor.logo_url,
      dtesVisibles: emisor.dtes_visibles || ["01", "03", "11"],
      ambiente: emisor.ambiente || "00",
      codEstablecimientoMh: emisor.cod_establecimiento_mh || "0000",
      codPuntoVentaMh: emisor.cod_punto_venta_mh || "0000"
    }
  });
});

// Actualizar configuración del perfil del emisor
router.put('/auth/config', authMiddleware, async (req: any, res: any) => {
  try {
    const emisor = req.emisor;
    const { 
      nrc, razonSocial, nombreComercial, codActividad, descActividad,
      direccion, telefono, pwdMh, pwdFirmador, dtesVisibles, ambiente,
      codEstablecimientoMh, codPuntoVentaMh, logoUrl
    } = req.body;

    if (ambiente !== undefined && ambiente !== emisor.ambiente && process.env.PERMITIR_CAMBIO_AMBIENTE !== 'true') {
      return res.status(403).json({ success: false, error: 'El cambio de ambiente debe solicitarse a Nevora.' });
    }

    const prisma = (await import('../db/prisma')).default;

    const updated = await prisma.emisor.update({
      where: { id: emisor.id },
      data: {
        nrc: nrc !== undefined ? nrc : emisor.nrc,
        razon_social: razonSocial !== undefined ? razonSocial : emisor.razon_social,
        nombre_comercial: nombreComercial !== undefined ? nombreComercial : emisor.nombre_comercial,
        cod_actividad: codActividad !== undefined ? codActividad : emisor.cod_actividad,
        desc_actividad: descActividad !== undefined ? descActividad : emisor.desc_actividad,
        direccion: direccion !== undefined ? direccion : emisor.direccion,
        telefono: telefono !== undefined ? telefono : emisor.telefono,
        pwd_mh: pwdMh !== undefined ? pwdMh : emisor.pwd_mh,
        pwd_firmador: pwdFirmador !== undefined ? pwdFirmador : emisor.pwd_firmador,
        dtes_visibles: dtesVisibles !== undefined ? dtesVisibles : emisor.dtes_visibles,
        ambiente: ambiente !== undefined ? ambiente : emisor.ambiente,
        cod_establecimiento_mh: codEstablecimientoMh !== undefined ? codEstablecimientoMh : emisor.cod_establecimiento_mh,
        cod_punto_venta_mh: codPuntoVentaMh !== undefined ? codPuntoVentaMh : emisor.cod_punto_venta_mh,
        logo_url: logoUrl !== undefined ? logoUrl : emisor.logo_url
      }
    });

    res.json({
      success: true,
      message: 'Configuración actualizada exitosamente',
      emisor: {
        id: updated.id,
        nit: updated.nit,
        nrc: updated.nrc,
        razonSocial: updated.razon_social,
        nombreComercial: updated.nombre_comercial,
        logoUrl: updated.logo_url,
        dtesVisibles: updated.dtes_visibles || ["01", "03", "11"],
        ambiente: updated.ambiente || "00"
      }
    });
  } catch (error: any) {
    console.error('Update Config Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// =========================================================================
// FUNCIÓN AUXILIAR PARA CONSTRUIR DTE BASE SANEADO POR PERFIL EMISOR
// =========================================================================
const construirDteBase = async (req: any, tipoDte: string, versionDte: number, emisorDb: any) => {
  const { construirDte } = await import('../builders');
  return construirDte(req, tipoDte, versionDte, emisorDb);
};

// =========================================================================
// CONTROLADOR CENTRAL DE ENVÍO DE DTE
// =========================================================================
const enviarDTEController = async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor; // Recuperado por authMiddleware
    let tipoDte = '01';
    let versionDte = 2;

    if (req.path === '/ccf') { tipoDte = '03'; versionDte = 4; }
    else if (req.path === '/nota-credito') { tipoDte = '05'; versionDte = 3; }
    else if (req.path === '/nota-debito') { tipoDte = '06'; versionDte = 3; }
    else if (req.path === '/nota-remision') { tipoDte = '04'; versionDte = 3; }
    else if (req.path === '/comprobante-retencion') { tipoDte = '07'; versionDte = 1; }
    else if (req.path === '/comprobante-liquidacion') { tipoDte = '08'; versionDte = 1; }
    else if (req.path === '/documento-contable-liquidacion') { tipoDte = '09'; versionDte = 1; }
    else if (req.path === '/factura-exportacion') { tipoDte = '11'; versionDte = 1; }
    else if (req.path === '/factura-sujeto-excluido') { tipoDte = '14'; versionDte = 1; }
    else if (req.path === '/comprobante-donacion') { tipoDte = '15'; versionDte = 1; }

    // Reconstruir y sanear el documento utilizando estrictamente los datos de perfil del emisorDb
    const documentoBase = await construirDteBase(req, tipoDte, versionDte, emisorDb);

    // Forzar la versión vigente del tipo de documento, sin importar lo recibido
    documentoBase.identificacion.version = versionDte;

    const prisma = (await import('../db/prisma')).default;
    const ambiente = emisorDb.ambiente || '00';

    // Idempotencia: el mismo codigoGeneracion nunca se transmite dos veces
    if (!UUID_REGEX.test(documentoBase.identificacion.codigoGeneracion || '')) {
      return res.status(400).json({ success: false, error: 'codigoGeneracion inválido. Debe ser un UUID.' });
    }
    const existente = await prisma.dteEmitido.findUnique({
      where: { codigo_generacion: documentoBase.identificacion.codigoGeneracion.toUpperCase() }
    });
    if (existente) {
      if (existente.emisor_id === emisorDb.id && existente.estado === 'PROCESADO') {
        return res.json({
          success: true,
          idempotente: true,
          codigoGeneracion: documentoBase.identificacion.codigoGeneracion,
          numeroControl: existente.numero_control,
          selloRecibido: existente.sello_recepcion_mh,
          resultado: existente.respuesta_mh,
          dteCompleto: generarJsonDteCompleto(existente.json_enviado as any, null, existente.sello_recepcion_mh)
        });
      }
      return res.status(409).json({ success: false, error: 'Ya existe un documento con ese codigoGeneracion.' });
    }

    // Guardar o recuperar el cliente asociado al DTE
    let clienteId = null;
    const receptorOrSujeto = documentoBase.receptor || documentoBase.sujetoExcluido || documentoBase.donante;

    if (receptorOrSujeto && (receptorOrSujeto.numDocumento || receptorOrSujeto.nit)) {
      const numDoc = receptorOrSujeto.numDocumento || receptorOrSujeto.nit;
      let cliente = await prisma.cliente.findUnique({
        where: {
          emisor_id_num_documento: {
            emisor_id: emisorDb.id,
            num_documento: numDoc
          }
        }
      });

      if (!cliente) {
        console.log(`👤 Cliente nuevo para el emisor ${emisorDb.id}. Creándolo...`);
        cliente = await prisma.cliente.create({
          data: {
            emisor_id: emisorDb.id,
            tipo_documento: receptorOrSujeto.tipoDocumento || (tipoDte === '03' ? '36' : '13'),
            num_documento: numDoc,
            nrc: receptorOrSujeto.nrc || null,
            nombre: receptorOrSujeto.nombre || "Consumidor Final",
            nombre_comercial: receptorOrSujeto.nombreComercial || null,
            cod_actividad: receptorOrSujeto.codActividad || null,
            desc_actividad: receptorOrSujeto.descActividad || null,
            correo: receptorOrSujeto.correo || null,
            telefono: receptorOrSujeto.telefono || null,
            direccion: receptorOrSujeto.direccion || null
          }
        });
      }
      clienteId = cliente.id;
    }

    // Registrar el DTE antes de transmitir: si algo falla después, el documento no se pierde.
    const montoOperacion = documentoBase.resumen ? (documentoBase.resumen.montoTotalOperacion || documentoBase.resumen.valorTotal || 0) : 0;
    const totalPagar = documentoBase.resumen ? (documentoBase.resumen.totalPagar || documentoBase.resumen.valorTotal || 0) : 0;
    const dteRegistrado = await prisma.dteEmitido.create({
      data: {
        emisor_id: emisorDb.id,
        cliente_id: clienteId,
        tipo_dte: tipoDte,
        ambiente,
        codigo_generacion: documentoBase.identificacion.codigoGeneracion.toUpperCase(),
        numero_control: documentoBase.identificacion.numeroControl,
        estado: 'PROCESANDO',
        fecha_emision: new Date(documentoBase.identificacion.fecEmi + 'T00:00:00Z'),
        hora_emision: new Date('1970-01-01T' + documentoBase.identificacion.horEmi + 'Z'),
        monto_total_operacion: montoOperacion,
        total_pagar: totalPagar,
        json_enviado: documentoBase as any
      }
    });

    // Enviar al MH
    let resultadoMH: any;
    let errorOcurrido: any = null;
    let firmaElectronica: string | null = null;
    try {
      let envio = await enviarAlMH(documentoBase, tipoDte, versionDte, emisorDb);

      // Número de control ya usado en MH (código 004): pedir el siguiente correlativo. Si el
      // duplicado fuera el codigoGeneracion, no se reintenta: podría duplicar un documento fiscal.
      let intentos = 0;
      while (
        envio.estado === 'RECHAZADO' &&
        (envio.codigoMsg === '004' || (envio.descripcionMsg && envio.descripcionMsg.includes('YA EXISTE UN REGISTRO CON ESE VALOR'))) &&
        !String(envio.descripcionMsg || '').toLowerCase().includes('codigogeneracion') &&
        intentos < 5
      ) {
        intentos++;
        const actual: string = documentoBase.identificacion.numeroControl;
        const establePunto = actual.split('-')[2];
        console.log(`⚠️ [DTE RETRY] MH reporta ${actual} como duplicado. Intento ${intentos}/5.`);

        documentoBase.identificacion.numeroControl = await obtenerSiguienteCorrelativo(
          tipoDte, emisorDb.id, establePunto.substring(0, 4), establePunto.substring(4, 8), 1
        );
        await prisma.dteEmitido.update({
          where: { id: dteRegistrado.id },
          data: { numero_control: documentoBase.identificacion.numeroControl, json_enviado: documentoBase as any }
        });
        envio = await enviarAlMH(documentoBase, tipoDte, versionDte, emisorDb);
      }

      const { documentoFirmado, ...respuesta } = envio;
      firmaElectronica = documentoFirmado;
      resultadoMH = respuesta;
    } catch (error: any) {
      console.error('⚠️ [DTE ERROR] Falló el envío al MH:', error.message || error);
      errorOcurrido = error;
      if (error instanceof EnvioIndeterminadoError) {
        // Puede haberse recibido: se consulta, nunca se marca como rechazado a ciegas.
        const consulta = await consultarDteMh(documentoBase.identificacion.codigoGeneracion, tipoDte, emisorDb);
        resultadoMH = consulta || { estado: 'PENDIENTE_MH', descripcionMsg: error.message, observaciones: [] };
        if (consulta) errorOcurrido = null;
      } else {
        // Falló la autenticación o la firma: el documento no salió hacia MH.
        resultadoMH = { estado: 'NO_ENVIADO', descripcionMsg: error.message || 'Error de firma o autenticación', observaciones: [] };
      }
    }

    if (firmaElectronica) documentoBase.firmaElectronica = firmaElectronica;

    // Guardar el resultado (reintenta: un sello de MH no puede perderse por un fallo momentáneo de BD)
    const estadoFinal = resultadoMH.estado || 'RECHAZADO';
    const esProcesado = estadoFinal === 'PROCESADO';
    const itemsData = (Array.isArray(documentoBase.cuerpoDocumento) ? documentoBase.cuerpoDocumento : []).map((item: any) => ({
      dte_id: dteRegistrado.id,
      num_item: item.numItem,
      cantidad: item.cantidad,
      descripcion: item.descripcion,
      precio_unitario: item.precioUni !== undefined ? item.precioUni : (item.valorUni !== undefined ? item.valorUni : (item.valorDonacion || 0)),
      venta_gravada: item.ventaGravada || 0,
      venta_exenta: item.ventaExenta || 0,
      venta_nosujeta: item.ventaNoSuj || 0,
      iva_item: item.ivaItem || 0,
      tributos: item.tributos || null
    }));

    let guardado = false;
    for (let intento = 1; intento <= 3 && !guardado; intento++) {
      try {
        await prisma.$transaction([
          prisma.dteEmitido.update({
            where: { id: dteRegistrado.id },
            data: {
              sello_recepcion_mh: resultadoMH.selloRecibido || null,
              estado: estadoFinal,
              descripcion_rechazo: esProcesado
                ? null
                : `${resultadoMH.descripcionMsg || 'Rechazado por el MH'}${resultadoMH.observaciones && resultadoMH.observaciones.length > 0 ? ': ' + resultadoMH.observaciones.join('; ') : ''}`,
              json_enviado: documentoBase as any,
              respuesta_mh: resultadoMH as any
            }
          }),
          prisma.dteItem.createMany({ data: itemsData })
        ]);
        guardado = true;
      } catch (dbError: any) {
        console.error(`⚠️ Error guardando resultado del DTE ${dteRegistrado.id} (intento ${intento}/3):`, dbError.message || dbError);
        await new Promise(resolve => setTimeout(resolve, 500 * intento));
      }
    }
    if (!guardado) {
      console.error(`🚨 [DTE SIN GUARDAR] id=${dteRegistrado.id} codigo=${documentoBase.identificacion.codigoGeneracion} estado=${estadoFinal} sello=${resultadoMH.selloRecibido || 'n/a'}`);
    }

    const dteCompleto = generarJsonDteCompleto(
      documentoBase,
      firmaElectronica,
      resultadoMH.selloRecibido || null
    );

    if (!esProcesado) {
      return res.json({
        success: false,
        estado: estadoFinal,
        error: errorOcurrido ? `Fallo al procesar/enviar el DTE: ${errorOcurrido.message}` : 'Rechazado por el MH',
        resultado: resultadoMH,
        dteCompleto
      });
    }

    // Responder INMEDIATAMENTE al cliente para finalizar la transacción DTE
    res.json({
      success: true,
      codigoGeneracion: documentoBase.identificacion.codigoGeneracion,
      numeroControl: documentoBase.identificacion.numeroControl,
      selloRecibido: resultadoMH.selloRecibido || null,
      resultado: resultadoMH,
      dteCompleto,
      pdfUrl: `/api/dtes/${documentoBase.identificacion.codigoGeneracion}/pdf`,
      jsonUrl: `/api/dtes/${documentoBase.identificacion.codigoGeneracion}/json`
    });

    // Proceso independiente e asíncrono en segundo plano (No bloquea la respuesta HTTP)
    setImmediate(async () => {
      try {
        const dtePdfObj = {
          ...dteCompleto,
          emisor: { ...dteCompleto.emisor, logoUrl: emisorDb.logo_url }
        };
        const pdfBuffer = await generarPdfDte(dtePdfObj);
        const TIPOS_DTE_NOMBRES: Record<string, string> = {
          '01': 'Factura',
          '03': 'Comprobante de Crédito Fiscal',
          '04': 'Nota de Remisión',
          '05': 'Nota de Crédito',
          '06': 'Nota de Débito',
          '07': 'Comprobante de Retención',
          '08': 'Comprobante de Liquidación',
          '09': 'Documento Contable de Liquidación',
          '11': 'Factura de Exportación',
          '14': 'Factura de Sujeto Excluido',
          '15': 'Comprobante de Donación'
        };

        const tipoDteNombre = TIPOS_DTE_NOMBRES[documentoBase.identificacion?.tipoDte] || 'Factura';
        const destinoCorreo = documentoBase.receptor?.correo || emisorDb.correo;
        const nombreReceptor = documentoBase.receptor?.nombre || 'Cliente';
        const nombreEmisor = documentoBase.emisor?.nombre || emisorDb.razon_social || 'Emisor';
        const montoTotal = Number(documentoBase.resumen?.totalPagar || documentoBase.resumen?.montoTotalOperacion || 0).toFixed(2);

        await enviarCorreoDte({
          destinoCorreo,
          nombreReceptor,
          nombreEmisor,
          tipoDteNombre,
          numeroControl: documentoBase.identificacion.numeroControl,
          codigoGeneracion: documentoBase.identificacion.codigoGeneracion,
          montoTotal,
          pdfBuffer,
          jsonCompleto: dteCompleto
        });
      } catch (bgErr: any) {
        console.error('⚠️ Error en segundo plano al preparar/enviar correo:', bgErr.message || bgErr);
      }
    });

  } catch (error: any) {
    if (error instanceof DteInvalidoError) {
      return res.status(422).json({ success: false, error: error.message, detalles: error.detalles });
    }
    console.error('Controller Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Catálogos oficiales de MH (CAT-012, CAT-013 y CAT-008)
let territorio: any = null;
router.get('/catalogos/territorio', (_req: any, res: any) => {
  if (!territorio) {
    territorio = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'catalogos', 'territorio.json'), 'utf8'));
  }
  res.json({ success: true, departamentos: territorio });
});

// =========================================================================
// RUTAS DTE PROTEGIDAS
// =========================================================================
router.post('/factura', authMiddleware, enviarDTEController);
router.post('/ccf', authMiddleware, enviarDTEController);
router.post('/nota-credito', authMiddleware, enviarDTEController);
router.post('/nota-debito', authMiddleware, enviarDTEController);
router.post('/nota-remision', authMiddleware, enviarDTEController);
router.post('/comprobante-retencion', authMiddleware, enviarDTEController);
router.post('/comprobante-liquidacion', authMiddleware, enviarDTEController);
router.post('/documento-contable-liquidacion', authMiddleware, enviarDTEController);
router.post('/factura-exportacion', authMiddleware, enviarDTEController);
router.post('/factura-sujeto-excluido', authMiddleware, enviarDTEController);
router.post('/comprobante-donacion', authMiddleware, enviarDTEController);

// Rutas de eventos e historial de DTEs
router.post('/evento-invalidacion', authMiddleware, (req, res) => res.json({ success: false, error: 'Not implemented real events yet' }));
router.post('/evento-contingencia', authMiddleware, (req, res) => res.json({ success: false, error: 'Not implemented real events yet' }));

// =========================================================================
// RUTAS PÚBLICAS PARA DESCARGA DIRECTA DE ARCHIVOS (Para WhatsApp API y Clientes)
// =========================================================================
router.get('/public/dtes/:token/json', async (req: any, res: any) => {
  try {
    const codigoGeneracion = leerTokenEnlace(req.params.token);
    if (!codigoGeneracion || !UUID_REGEX.test(codigoGeneracion)) {
      return res.status(403).json({ success: false, error: 'Enlace inválido o vencido' });
    }
    const prisma = (await import('../db/prisma')).default;

    const dte = await prisma.dteEmitido.findFirst({
      where: { codigo_generacion: codigoGeneracion, estado: 'PROCESADO' }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    const jsonEnviado = (dte.json_enviado as any) || {};
    const respuestaMH = (dte.respuesta_mh as any) || {};
    const selloRecibido = dte.sello_recepcion_mh || respuestaMH.selloRecibido || null;

    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado,
      jsonEnviado.firmaElectronica || null,
      selloRecibido
    );

    const fileName = `${dte.codigo_generacion || codigoGeneracion}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(dteCompleto, null, 2));
  } catch (error: any) {
    console.error('Error enviando JSON DTE público:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/public/dtes/:token/pdf', async (req: any, res: any) => {
  try {
    const codigoGeneracion = leerTokenEnlace(req.params.token);
    if (!codigoGeneracion || !UUID_REGEX.test(codigoGeneracion)) {
      return res.status(403).json({ success: false, error: 'Enlace inválido o vencido' });
    }
    const prisma = (await import('../db/prisma')).default;

    const dte = await prisma.dteEmitido.findFirst({
      where: { codigo_generacion: codigoGeneracion, estado: 'PROCESADO' },
      include: { emisor: true }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    const jsonEnviado = (dte.json_enviado as any) || {};
    const respuestaMH = (dte.respuesta_mh as any) || {};
    const selloRecibido = dte.sello_recepcion_mh || respuestaMH.selloRecibido || null;

    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado,
      jsonEnviado.firmaElectronica || null,
      selloRecibido
    );
    if (dte.emisor?.logo_url) {
      dteCompleto.emisor = dteCompleto.emisor || {};
      dteCompleto.emisor.logoUrl = dte.emisor.logo_url;
    }

    const pdfBuffer = await generarPdfDte(dteCompleto);

    const fileName = `${dte.codigo_generacion || codigoGeneracion}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('Error generando PDF DTE público:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener JSON Completo ({codigoGeneracion}.json) por Codigo de Generacion o por ID (Con auth)
router.get('/dtes/:codigoGeneracion/json', authMiddleware, async (req: any, res: any) => {
  try {
    const { codigoGeneracion } = req.params;
    const prisma = (await import('../db/prisma')).default;

    // Permitir buscar por UUID o por ID numérico
    const isNum = /^[0-9]+$/.test(codigoGeneracion);
    const dte = await prisma.dteEmitido.findFirst({
      where: isNum
        ? { id: parseInt(codigoGeneracion, 10), emisor_id: req.emisor.id }
        : { codigo_generacion: codigoGeneracion.toUpperCase(), emisor_id: req.emisor.id }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    const jsonEnviado = (dte.json_enviado as any) || {};
    const respuestaMH = (dte.respuesta_mh as any) || {};
    const selloRecibido = dte.sello_recepcion_mh || respuestaMH.selloRecibido || null;

    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado,
      jsonEnviado.firmaElectronica || null,
      selloRecibido
    );

    const fileName = `${dte.codigo_generacion || codigoGeneracion}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(dteCompleto, null, 2));
  } catch (error: any) {
    console.error('Error enviando JSON DTE:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Obtener PDF ({codigoGeneracion}.pdf) por Codigo de Generacion o por ID
router.get('/dtes/:codigoGeneracion/pdf', authMiddleware, async (req: any, res: any) => {
  try {
    const { codigoGeneracion } = req.params;
    const prisma = (await import('../db/prisma')).default;

    const isNum = /^[0-9]+$/.test(codigoGeneracion);
    const dte = await prisma.dteEmitido.findFirst({
      where: isNum
        ? { id: parseInt(codigoGeneracion, 10), emisor_id: req.emisor.id }
        : { codigo_generacion: codigoGeneracion.toUpperCase(), emisor_id: req.emisor.id },
      include: { emisor: true }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    const jsonEnviado = (dte.json_enviado as any) || {};
    const respuestaMH = (dte.respuesta_mh as any) || {};
    const selloRecibido = dte.sello_recepcion_mh || respuestaMH.selloRecibido || null;

    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado,
      jsonEnviado.firmaElectronica || null,
      selloRecibido
    );
    if (dte.emisor?.logo_url || req.emisor?.logo_url) {
      dteCompleto.emisor = dteCompleto.emisor || {};
      dteCompleto.emisor.logoUrl = dte.emisor?.logo_url || req.emisor?.logo_url;
    }

    const pdfBuffer = await generarPdfDte(dteCompleto);

    const fileName = `${dte.codigo_generacion || codigoGeneracion}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('Error generando PDF DTE:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para reenviar correo con PDF y JSON adjuntos
router.post('/dtes/:codigoGeneracion/reenviar-correo', authMiddleware, async (req: any, res: any) => {
  try {
    const { codigoGeneracion } = req.params;
    const { correoDestino } = req.body || {};
    const prisma = (await import('../db/prisma')).default;

    const isNum = /^[0-9]+$/.test(codigoGeneracion);
    const dte = await prisma.dteEmitido.findFirst({
      where: isNum
        ? { id: parseInt(codigoGeneracion, 10), emisor_id: req.emisor.id }
        : { codigo_generacion: codigoGeneracion.toUpperCase(), emisor_id: req.emisor.id },
      include: { emisor: true }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    if (dte.estado !== 'PROCESADO') {
      return res.status(409).json({ success: false, error: 'Solo se pueden reenviar documentos procesados por Hacienda.' });
    }

    const jsonEnviado = (dte.json_enviado as any) || {};
    const respuestaMH = (dte.respuesta_mh as any) || {};
    const selloRecibido = dte.sello_recepcion_mh || respuestaMH.selloRecibido || null;

    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado,
      jsonEnviado.firmaElectronica || null,
      selloRecibido
    );

    const dtePdfObj = {
      ...dteCompleto,
      emisor: { ...dteCompleto.emisor, logoUrl: dte.emisor?.logo_url || req.emisor?.logo_url }
    };
    const pdfBuffer = await generarPdfDte(dtePdfObj);

    const TIPOS_DTE_NOMBRES: Record<string, string> = {
      '01': 'Factura',
      '03': 'Comprobante de Crédito Fiscal',
      '05': 'Nota de Crédito',
      '06': 'Nota de Débito',
      '07': 'Comprobante de Retención',
      '08': 'Comprobante de Liquidación',
      '09': 'Documento Contable de Liquidación',
      '11': 'Factura de Exportación',
      '14': 'Factura de Sujeto Excluido',
      '15': 'Comprobante de Donación'
    };

    const tipoDteNombre = TIPOS_DTE_NOMBRES[dteCompleto.identificacion?.tipoDte] || 'Factura';
    const finalCorreo = correoDestino || dteCompleto.receptor?.correo || req.emisor.correo;
    const nombreReceptor = dteCompleto.receptor?.nombre || 'Cliente';
    const nombreEmisor = dteCompleto.emisor?.nombre || req.emisor.razon_social || 'Emisor';
    const montoTotal = Number(dteCompleto.resumen?.totalPagar || dteCompleto.resumen?.montoTotalOperacion || 0).toFixed(2);

    const enviado = await enviarCorreoDte({
      destinoCorreo: finalCorreo,
      nombreReceptor,
      nombreEmisor,
      tipoDteNombre,
      numeroControl: dteCompleto.identificacion?.numeroControl || dte.numero_control,
      codigoGeneracion: dteCompleto.identificacion?.codigoGeneracion || dte.codigo_generacion,
      montoTotal,
      pdfBuffer,
      jsonCompleto: dteCompleto
    });

    if (enviado) {
      return res.json({
        success: true,
        message: `Correo reenviado exitosamente a "${finalCorreo}"`,
        destinoCorreo: finalCorreo
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `No se pudo enviar el correo a "${finalCorreo}". Verifica las credenciales SMTP.`
      });
    }
  } catch (error: any) {
    console.error('Error al reenviar correo de DTE:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para reenviar DTE por WhatsApp (A demanda)
router.post('/dtes/:codigoGeneracion/reenviar-whatsapp', authMiddleware, async (req: any, res: any) => {
  try {
    const { codigoGeneracion } = req.params;
    const { telefonoDestino } = req.body || {};
    const prisma = (await import('../db/prisma')).default;

    const isNum = /^[0-9]+$/.test(codigoGeneracion);
    const dte = await prisma.dteEmitido.findFirst({
      where: isNum
        ? { id: parseInt(codigoGeneracion, 10), emisor_id: req.emisor.id }
        : { codigo_generacion: codigoGeneracion.toUpperCase(), emisor_id: req.emisor.id },
      include: { cliente: true }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    if (dte.estado !== 'PROCESADO') {
      return res.status(409).json({ success: false, error: 'Solo se pueden reenviar documentos procesados por Hacienda.' });
    }

    const jsonEnviado = (dte.json_enviado as any) || {};
    const respuestaMH = (dte.respuesta_mh as any) || {};
    const selloRecibido = dte.sello_recepcion_mh || respuestaMH.selloRecibido || null;

    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado,
      jsonEnviado.firmaElectronica || null,
      selloRecibido
    );

    const TIPOS_DTE_NOMBRES: Record<string, string> = {
      '01': 'Factura',
      '03': 'Comprobante de Crédito Fiscal',
      '05': 'Nota de Crédito',
      '06': 'Nota de Débito',
      '07': 'Comprobante de Retención',
      '08': 'Comprobante de Liquidación',
      '09': 'Documento Contable de Liquidación',
      '11': 'Factura de Exportación',
      '14': 'Factura de Sujeto Excluido',
      '15': 'Comprobante de Donación'
    };

    const tipoDteNombre = TIPOS_DTE_NOMBRES[dteCompleto.identificacion?.tipoDte] || 'Factura';
    const finalTelefono = telefonoDestino || dteCompleto.receptor?.telefono || dte.cliente?.telefono;

    if (!finalTelefono) {
      return res.status(400).json({
        success: false,
        error: 'El cliente no tiene un número de teléfono registrado. Por favor especifique un número válido.'
      });
    }

    const nombreReceptor = dteCompleto.receptor?.nombre || dte.cliente?.nombre || 'Cliente';
    const nombreEmisor = dteCompleto.emisor?.nombre || req.emisor.razon_social || 'Emisor';
    const montoTotal = Number(dteCompleto.resumen?.totalPagar || dteCompleto.resumen?.montoTotalOperacion || 0).toFixed(2);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const baseUrl = process.env.PUBLIC_BASE_URL || `${protocol}://${req.get('host')}`;

    const tokenEnlace = crearTokenEnlace(dte.codigo_generacion);
    const pdfUrl = `${baseUrl}/api/public/dtes/${tokenEnlace}/pdf`;
    const jsonUrl = `${baseUrl}/api/public/dtes/${tokenEnlace}/json`;

    const pdfBuffer = await generarPdfDte({
      ...dteCompleto,
      emisor: { ...dteCompleto.emisor, logoUrl: req.emisor?.logo_url }
    });

    const resultadoWa = await enviarWhatsappDteApi({
      destinoTelefono: finalTelefono,
      nombreReceptor,
      nombreEmisor,
      tipoDteNombre,
      numeroControl: dteCompleto.identificacion?.numeroControl || dte.numero_control,
      codigoGeneracion: dteCompleto.identificacion?.codigoGeneracion || dte.codigo_generacion,
      montoTotal,
      pdfUrl,
      jsonUrl,
      pdfBuffer,
      jsonCompleto: dteCompleto
    });

    res.json({
      success: true,
      message: resultadoWa.message,
      whatsappWebUrl: resultadoWa.whatsappWebUrl,
      mensajesMeta: resultadoWa.mensajesMeta,
      destinoTelefono: finalTelefono
    });
  } catch (error: any) {
    console.error('Error al reenviar DTE por WhatsApp:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Consulta en MH un documento cuyo envío quedó sin confirmar
router.post('/dtes/:codigoGeneracion/verificar-mh', authMiddleware, async (req: any, res: any) => {
  try {
    const { codigoGeneracion } = req.params;
    if (!UUID_REGEX.test(codigoGeneracion)) {
      return res.status(400).json({ success: false, error: 'Código de generación inválido' });
    }
    const prisma = (await import('../db/prisma')).default;
    const dte = await prisma.dteEmitido.findFirst({
      where: { codigo_generacion: codigoGeneracion.toUpperCase(), emisor_id: req.emisor.id }
    });
    if (!dte) {
      return res.status(404).json({ success: false, error: 'DTE no encontrado' });
    }

    const consulta = await consultarDteMh(dte.codigo_generacion, dte.tipo_dte, req.emisor);
    if (!consulta) {
      return res.json({ success: false, estado: dte.estado, error: 'Hacienda no reporta este documento o no respondió.' });
    }

    const actualizado = await prisma.dteEmitido.update({
      where: { id: dte.id },
      data: {
        estado: consulta.estado,
        sello_recepcion_mh: consulta.selloRecibido || dte.sello_recepcion_mh,
        respuesta_mh: consulta as any
      }
    });
    res.json({ success: true, estado: actualizado.estado, selloRecibido: actualizado.sello_recepcion_mh });
  } catch (error: any) {
    console.error('Error al verificar DTE en MH:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint POST para generar PDF al vuelo pasando el JSON del DTE
router.post('/dtes/generar-pdf', authMiddleware, async (req: any, res: any) => {
  try {
    const dteCompleto = req.body;
    if (!dteCompleto || !dteCompleto.identificacion) {
      return res.status(400).json({ success: false, error: 'Estructura JSON de DTE inválida' });
    }
    const pdfBuffer = await generarPdfDte(dteCompleto);
    const fileName = `${dteCompleto.identificacion.codigoGeneracion || 'dte'}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('Error generando PDF al vuelo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint POST para generar JSON Completo al vuelo
router.post('/dtes/generar-json', authMiddleware, async (req: any, res: any) => {
  try {
    const { jsonEnviado, firmaElectronica, selloRecibido } = req.body;
    const dteCompleto = generarJsonDteCompleto(
      jsonEnviado || req.body,
      firmaElectronica || req.body.firmaElectronica || null,
      selloRecibido || req.body.selloRecibido || null
    );
    const fileName = `${dteCompleto.identificacion?.codigoGeneracion || 'dte'}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(dteCompleto, null, 2));
  } catch (error: any) {
    console.error('Error generando JSON al vuelo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Consulta e historial filtrado por emisor
router.post('/consulta-dte', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    
    const dtes = await prisma.dteEmitido.findMany({
      where: { emisor_id: emisorDb.id },
      orderBy: { id: 'desc' },
      take: 100 // Retornar últimos 100
    });

    res.json({ success: true, dtes });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Estadísticas del dashboard filtradas estrictamente por el emisor logueado
router.get('/dashboard/stats', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;

    // Contar total de documentos del emisor
    const totalDocumentos = await prisma.dteEmitido.count({
      where: { emisor_id: emisorDb.id }
    });

    // Sumar montos totales del emisor
    const aggregateMonto = await prisma.dteEmitido.aggregate({
      where: { emisor_id: emisorDb.id, estado: 'PROCESADO' },
      _sum: {
        total_pagar: true
      }
    });
    const montoTotal = Number(aggregateMonto._sum.total_pagar || 0);

    // Agrupar por estado para obtener contadores específicos del emisor
    const countsByEstado = await prisma.dteEmitido.groupBy({
      by: ['estado'],
      where: { emisor_id: emisorDb.id },
      _count: {
        _all: true
      }
    });

    const stats = {
      total: totalDocumentos,
      montoTotal: montoTotal,
      procesados: 0,
      pendientes: 0,
      borrador: 0,
      enviado: 0,
      rechazado: 0,
      invalidado: 0
    };

    countsByEstado.forEach((group: any) => {
      const estado = (group.estado || '').toUpperCase();
      const count = group._count._all;
      if (estado === 'PROCESADO') stats.procesados = count;
      else if (estado === 'PROCESANDO' || estado === 'PENDIENTE_MH') stats.pendientes += count;
      else if (estado === 'BORRADOR') stats.borrador = count;
      else if (estado === 'ENVIADO') stats.enviado = count;
      else if (estado === 'RECHAZADO' || estado === 'NO_ENVIADO') stats.rechazado += count;
      else if (estado === 'INVALIDADO') stats.invalidado = count;
    });

    // Obtener los 5 documentos más recientes con información resumida del cliente
    const dtesRecientes = await prisma.dteEmitido.findMany({
      where: { emisor_id: emisorDb.id },
      orderBy: { id: 'desc' },
      take: 5,
      include: {
        cliente: {
          select: {
            nombre: true,
            num_documento: true
          }
        }
      }
    });

    // Agrupar por tipo_dte para obtener el conteo por tipo de documento
    const countsByTipoDte = await prisma.dteEmitido.groupBy({
      by: ['tipo_dte'],
      where: { emisor_id: emisorDb.id },
      _count: {
        _all: true
      }
    });

    const conteoPorTipo: Record<string, number> = {
      '01': 0, // Factura
      '03': 0, // Crédito Fiscal
      '04': 0, // Nota de Remisión
      '05': 0, // Nota de Crédito
      '06': 0, // Nota de Débito
      '07': 0, // Comprobante de Retención
      '08': 0, // Comprobante de Liquidación
      '09': 0, // Documento Contable de Liquidación
      '11': 0, // Factura de Exportación
      '14': 0, // Factura de Sujeto Excluido
      '15': 0  // Comprobante de Donación
    };

    countsByTipoDte.forEach((group: any) => {
      const tipo = group.tipo_dte;
      if (tipo && conteoPorTipo[tipo] !== undefined) {
        conteoPorTipo[tipo] = group._count._all;
      }
    });

    res.json({
      success: true,
      stats,
      conteoPorTipo,
      dtesRecientes
    });
  } catch (error: any) {
    console.error('Error al cargar estadísticas de dashboard:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// RUTAS DE CRUD CLIENTES (Tenant-Safe)
// =========================================================================
router.get('/clientes', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const clientes = await prisma.cliente.findMany({
      where: { emisor_id: emisorDb.id },
      orderBy: { nombre: 'asc' }
    });
    res.json({ success: true, clientes });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/clientes', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const { tipoDocumento, numDocumento, nrc, nombre, nombreComercial, codActividad, descActividad, correo, telefono, direccion } = req.body;

    if (!tipoDocumento || !numDocumento || !nombre) {
      return res.status(400).json({ success: false, error: 'Tipo de documento, número de documento y nombre son requeridos.' });
    }

    const prisma = (await import('../db/prisma')).default;

    // Verificar si el cliente ya existe para este emisor
    const clienteExistente = await prisma.cliente.findFirst({
      where: {
        emisor_id: emisorDb.id,
        num_documento: numDocumento.trim()
      }
    });

    if (clienteExistente) {
      return res.status(400).json({ success: false, error: 'Ya existe un cliente registrado con ese número de documento.' });
    }

    const nuevoCliente = await prisma.cliente.create({
      data: {
        emisor_id: emisorDb.id,
        tipo_documento: tipoDocumento,
        num_documento: numDocumento.trim(),
        nrc: nrc ? nrc.trim() : null,
        nombre: nombre.trim(),
        nombre_comercial: nombreComercial ? nombreComercial.trim() : null,
        cod_actividad: codActividad ? codActividad.trim() : null,
        desc_actividad: descActividad ? descActividad.trim() : null,
        correo: correo ? correo.trim() : null,
        telefono: telefono ? telefono.trim() : null,
        direccion: direccion || null
      }
    });

    res.json({ success: true, cliente: nuevoCliente });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/clientes/:id', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const id = parseInt(req.params.id, 10);
    const { tipoDocumento, numDocumento, nrc, nombre, nombreComercial, codActividad, descActividad, correo, telefono, direccion } = req.body;

    const prisma = (await import('../db/prisma')).default;

    const clienteExistente = await prisma.cliente.findFirst({
      where: { id, emisor_id: emisorDb.id }
    });

    if (!clienteExistente) {
      return res.status(404).json({ success: false, error: 'Cliente no encontrado o no pertenece a este emisor.' });
    }

    const clienteActualizado = await prisma.cliente.update({
      where: { id },
      data: {
        tipo_documento: tipoDocumento !== undefined ? tipoDocumento : clienteExistente.tipo_documento,
        num_documento: numDocumento !== undefined ? numDocumento.trim() : clienteExistente.num_documento,
        nrc: nrc !== undefined ? (nrc ? nrc.trim() : null) : clienteExistente.nrc,
        nombre: nombre !== undefined ? nombre.trim() : clienteExistente.nombre,
        nombre_comercial: nombreComercial !== undefined ? (nombreComercial ? nombreComercial.trim() : null) : clienteExistente.nombre_comercial,
        cod_actividad: codActividad !== undefined ? (codActividad ? codActividad.trim() : null) : clienteExistente.cod_actividad,
        desc_actividad: descActividad !== undefined ? (descActividad ? descActividad.trim() : null) : clienteExistente.desc_actividad,
        correo: correo !== undefined ? (correo ? correo.trim() : null) : clienteExistente.correo,
        telefono: telefono !== undefined ? (telefono ? telefono.trim() : null) : clienteExistente.telefono,
        direccion: direccion !== undefined ? direccion : clienteExistente.direccion
      }
    });

    res.json({ success: true, cliente: clienteActualizado });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/clientes/:id', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const id = parseInt(req.params.id, 10);

    const prisma = (await import('../db/prisma')).default;

    const clienteExistente = await prisma.cliente.findFirst({
      where: { id, emisor_id: emisorDb.id }
    });

    if (!clienteExistente) {
      return res.status(404).json({ success: false, error: 'Cliente no encontrado o no pertenece a este emisor.' });
    }

    await prisma.cliente.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Cliente eliminado correctamente.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// RUTAS DE CRUD PRODUCTOS/INVENTARIO (Tenant-Safe)
// =========================================================================
router.get('/productos', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const productos = await prisma.producto.findMany({
      where: { emisor_id: emisorDb.id },
      orderBy: { codigo: 'asc' }
    });
    res.json({ success: true, productos });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/productos', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const { codigo, descripcion, precioUnitario, tipoItem, uniMedida } = req.body;

    if (!codigo || !descripcion || precioUnitario === undefined) {
      return res.status(400).json({ success: false, error: 'Código, descripción y precio unitario son requeridos.' });
    }

    const prisma = (await import('../db/prisma')).default;
    const nuevoProducto = await prisma.producto.create({
      data: {
        emisor_id: emisorDb.id,
        codigo: codigo.trim(),
        descripcion: descripcion.trim(),
        precio_unitario: Number(precioUnitario),
        tipo_item: tipoItem ? Number(tipoItem) : 1,
        uni_medida: uniMedida ? Number(uniMedida) : 59
      }
    });

    res.json({ success: true, producto: nuevoProducto });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/productos/:id', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const id = parseInt(req.params.id, 10);
    const { codigo, descripcion, precioUnitario, tipoItem, uniMedida } = req.body;

    const prisma = (await import('../db/prisma')).default;

    const productoExistente = await prisma.producto.findFirst({
      where: { id, emisor_id: emisorDb.id }
    });

    if (!productoExistente) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado o no pertenece a este emisor.' });
    }

    const productoActualizado = await prisma.producto.update({
      where: { id },
      data: {
        codigo: codigo !== undefined ? codigo.trim() : productoExistente.codigo,
        descripcion: descripcion !== undefined ? descripcion.trim() : productoExistente.descripcion,
        precio_unitario: precioUnitario !== undefined ? Number(precioUnitario) : productoExistente.precio_unitario,
        tipo_item: tipoItem !== undefined ? Number(tipoItem) : productoExistente.tipo_item,
        uni_medida: uniMedida !== undefined ? Number(uniMedida) : productoExistente.uni_medida
      }
    });

    res.json({ success: true, producto: productoActualizado });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/productos/:id', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const id = parseInt(req.params.id, 10);

    const prisma = (await import('../db/prisma')).default;

    const productoExistente = await prisma.producto.findFirst({
      where: { id, emisor_id: emisorDb.id }
    });

    if (!productoExistente) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado o no pertenece a este emisor.' });
    }

    await prisma.producto.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Producto eliminado correctamente.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// RUTAS DE COMPRAS (Tenant-Safe)
// =========================================================================
router.get('/compras', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const compras = await prisma.compra.findMany({
      where: { emisor_id: emisorDb.id },
      include: {
        items: true
      },
      orderBy: { id: 'desc' }
    });
    res.json({ success: true, compras });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/compras', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const { proveedorNombre, proveedorDocumento, tipoDocumento, numeroDocumento, fechaCompra, items } = req.body;

    if (!proveedorNombre || !proveedorDocumento || !tipoDocumento || !numeroDocumento || !fechaCompra || !items || !items.length) {
      return res.status(400).json({ success: false, error: 'Todos los campos de la compra y al menos un ítem son obligatorios.' });
    }

    const prisma = (await import('../db/prisma')).default;

    // Calcular el monto total sumando los subtotales de cada ítem
    const totalMonto = items.reduce((acc: number, item: any) => {
      const cantidad = Number(item.cantidad || 0);
      const precio = Number(item.precioUnitario || 0);
      return acc + (cantidad * precio);
    }, 0);

    const nuevaCompra = await prisma.compra.create({
      data: {
        emisor_id: emisorDb.id,
        proveedor_nombre: proveedorNombre.trim(),
        proveedor_documento: proveedorDocumento.trim(),
        tipo_documento: tipoDocumento,
        numero_documento: numeroDocumento.trim(),
        fecha_compra: new Date(fechaCompra + 'T00:00:00Z'),
        monto_total: totalMonto,
        items: {
          create: items.map((item: any) => {
            const cantidad = Number(item.cantidad);
            const precio = Number(item.precioUnitario);
            return {
              descripcion: item.descripcion.trim(),
              cantidad: cantidad,
              precio_unitario: precio,
              total: cantidad * precio
            };
          })
        }
      },
      include: {
        items: true
      }
    });

    res.json({ success: true, compra: nuevaCompra });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// RUTA PARA OBTENER INFORMACIÓN DE UN DTE RELACIONADO (Tenant-Safe)
// =========================================================================
router.get('/dte-info/:codigoGeneracion', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const { codigoGeneracion } = req.params;

    // Validar formato UUID
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!uuidRegex.test(codigoGeneracion)) {
      return res.status(400).json({ success: false, error: 'Código de generación inválido. Debe ser un UUID válido.' });
    }

    const prisma = (await import('../db/prisma')).default;
    const dte = await prisma.dteEmitido.findFirst({
      where: {
        codigo_generacion: codigoGeneracion.toLowerCase(),
        emisor_id: emisorDb.id
      },
      include: {
        cliente: true
      }
    });

    if (!dte) {
      return res.status(404).json({ success: false, error: 'Documento no encontrado o no pertenece a este emisor.' });
    }

    res.json({
      success: true,
      dte: {
        tipoDte: dte.tipo_dte,
        numeroControl: dte.numero_control,
        codigoGeneracion: dte.codigo_generacion,
        fechaEmision: dte.fecha_emision.toISOString().split('T')[0],
        montoTotal: Number(dte.monto_total_operacion),
        estado: dte.estado,
        selloRecepcionMh: dte.sello_recepcion_mh,
        cliente: dte.cliente ? {
          nombre: dte.cliente.nombre,
          numDocumento: dte.cliente.num_documento,
          correo: dte.cliente.correo,
          telefono: dte.cliente.telefono
        } : null
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
