import { Router } from 'express';
import { enviarAlMH, enviarEventoMh, consultarDteMh, EnvioIndeterminadoError } from '../services/mh.service';
import { construirEventoContingencia, construirEventoInvalidacion } from '../builders/eventos';
import { firmarDocumento } from '../services/firmador.service';
import { obtenerSiguienteCorrelativo } from '../builders/common';
import { hashPassword, esHash, verificarPassword } from '../utils/password';
import { crearTokenEnlace, leerTokenEnlace } from '../utils/enlace-publico';
import { config } from '../config';
import { firmaValida, verifyToken, generateToken } from '../utils/jwt';
import { generarJsonDteCompleto } from '../services/dte-json.service';
import { generarPdfDte } from '../services/pdf.service';
import { DteInvalidoError } from '../services/schema.service';
import fs from 'fs';
import path from 'path';
import { enviarCorreoDte, enviarCorreoConMotivo } from '../services/email.service';
import { enviarWhatsappDteApi } from '../services/whatsapp.service';
import { cifradoDisponible, cifrar } from '../utils/cifrado';
import { ConexionCorreoError, ejecutarImportacion, importacionVencida, probarConexion, servidorSugerido } from '../services/correo-compras.service';
import { TIPO_RETENCION_RECIBIDA } from '../services/compra-dte.service';
import { actualizarDatosContables, archivoAnexo, ContabilidadError, guardarAjustes, guardarConfiguracion, obtenerConfiguracion, reporteDelPeriodo } from '../services/contabilidad.service';
import { buscarPorCorreo, cambiarPassword, CuentaError, restablecerPassword, solicitarRecuperacion, validarToken } from '../services/cuenta.service';
import { certificadosParaFirmador } from '../services/empresas.service';
import { excedido, limpiarIntentos } from '../utils/limite';
import adminRoutes from './admin.routes';

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

    if (!emisor || !emisor.activo) {
      return res.status(401).json({ success: false, error: 'Perfil de emisor no encontrado' });
    }

    // Un cambio de contraseña cierra las sesiones abiertas antes de ese momento
    if (emisor.sesiones_desde && (decoded.iat || 0) < Math.floor(emisor.sesiones_desde.getTime() / 1000)) {
      return res.status(401).json({ success: false, error: 'La sesión ya no es válida. Ingrese de nuevo.' });
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

const MAX_INTENTOS_LOGIN = 10;
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;

// Solicitar el enlace de recuperación. Responde igual exista o no la cuenta.
router.post('/auth/recuperar', async (req: any, res: any) => {
  const correo = typeof req.body?.correo === 'string' ? req.body.correo.trim() : '';
  if (!correo.includes('@')) {
    return res.status(400).json({ success: false, error: 'Indique un correo válido.' });
  }
  if (excedido(`recuperar:${req.ip}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ success: false, error: 'Demasiadas solicitudes. Intente más tarde.' });
  }
  // No se espera el envío: el tiempo de respuesta no debe revelar si la cuenta existe.
  solicitarRecuperacion(correo, req.get('origin')).catch(error => console.error('Error al solicitar recuperación:', error.message));
  res.json({ success: true, message: 'Si el correo está registrado, recibirás un enlace para crear una nueva contraseña.' });
});

router.post('/auth/restablecer/validar', async (req: any, res: any) => {
  try {
    if (excedido(`restablecer:${req.ip}`, 30, VENTANA_INTENTOS_MS)) {
      return res.status(429).json({ success: false, error: 'Demasiados intentos. Intente más tarde.' });
    }
    const registro = await validarToken(String(req.body?.token || ''));
    res.json({ success: true, valido: !!registro, tipo: registro?.tipo || null });
  } catch (error: any) {
    console.error('Error al validar enlace:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo validar el enlace.' });
  }
});

router.post('/auth/restablecer', async (req: any, res: any) => {
  try {
    if (excedido(`restablecer:${req.ip}`, 30, VENTANA_INTENTOS_MS)) {
      return res.status(429).json({ success: false, error: 'Demasiados intentos. Intente más tarde.' });
    }
    await restablecerPassword(String(req.body?.token || ''), req.body?.password);
    res.json({ success: true, message: 'Contraseña actualizada. Ya puede ingresar.' });
  } catch (error: any) {
    if (error instanceof CuentaError) return res.status(422).json({ success: false, error: error.message });
    console.error('Error al restablecer contraseña:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo actualizar la contraseña.' });
  }
});

// Lo consulta el firmador para mantener los certificados de las empresas al día.
router.get('/internal/certificados', async (req: any, res: any) => {
  const esperado = process.env.FIRMADOR_SYNC_TOKEN || '';
  if (esperado.length < 32 || !firmaValida(String(req.get('x-firmador-token') || ''), esperado)) {
    return res.status(404).json({ success: false, error: 'No encontrado' });
  }
  try {
    res.type('text/plain').send(await certificadosParaFirmador());
  } catch (error: any) {
    console.error('Error al entregar certificados:', error.message);
    res.status(500).send('');
  }
});

// Login de Emisor (Cliente SaaS)
router.post('/auth/login', async (req: any, res: any) => {
  try {
    const { correo, password } = req.body;
    if (!correo || !password) {
      return res.status(400).json({ success: false, error: 'Correo y contraseña son requeridos' });
    }

    const claveIntentos = `login:${req.ip}:${String(correo).trim().toLowerCase()}`;
    if (excedido(claveIntentos, MAX_INTENTOS_LOGIN, VENTANA_INTENTOS_MS)) {
      return res.status(429).json({ success: false, error: 'Demasiados intentos. Espere 15 minutos o restablezca su contraseña.' });
    }

    const prisma = (await import('../db/prisma')).default;
    const emisor = await buscarPorCorreo(correo);

    if (!emisor || !verificarPassword(password.trim(), emisor.password)) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }

    if (!emisor.activo) {
      return res.status(403).json({ success: false, error: 'Esta cuenta está suspendida. Contacte a Nevora.' });
    }

    limpiarIntentos(claveIntentos);

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
        ambiente: emisor.ambiente || "00",
        esAdmin: emisor.es_admin
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
      codPuntoVentaMh: emisor.cod_punto_venta_mh || "0000",
      esAdmin: emisor.es_admin
    }
  });
});

// Cambiar la contraseña con la sesión abierta. Cierra las demás sesiones y entrega un token nuevo.
router.post('/auth/cambiar-password', authMiddleware, async (req: any, res: any) => {
  try {
    const emisor = req.emisor;
    if (excedido(`cambiar:${emisor.id}`, MAX_INTENTOS_LOGIN, VENTANA_INTENTOS_MS)) {
      return res.status(429).json({ success: false, error: 'Demasiados intentos. Espere 15 minutos.' });
    }
    if (!verificarPassword(String(req.body?.actual || '').trim(), emisor.password)) {
      return res.status(422).json({ success: false, error: 'La contraseña actual no es correcta.' });
    }
    await cambiarPassword(emisor.id, req.body?.nueva);
    limpiarIntentos(`cambiar:${emisor.id}`);
    res.json({ success: true, token: generateToken({ emisorId: emisor.id, correo: emisor.correo || '', nit: emisor.nit }) });
  } catch (error: any) {
    if (error instanceof CuentaError) return res.status(422).json({ success: false, error: error.message });
    console.error('Error al cambiar contraseña:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo cambiar la contraseña.' });
  }
});

const soloAdmin = (req: any, res: any, next: any) => {
  if (!req.emisor?.es_admin) return res.status(403).json({ success: false, error: 'Solo Nevora puede administrar empresas.' });
  next();
};
router.use('/admin', authMiddleware, soloAdmin, adminRoutes);

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
        // Los documentos autorizados los define la resolución de Hacienda: los cambia Nevora, no la empresa
        dtes_visibles: dtesVisibles !== undefined && emisor.es_admin ? dtesVisibles : emisor.dtes_visibles,
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

// Manual Funcional VIII: documentos que admiten contingencia.
const TIPOS_EN_CONTINGENCIA = ['01', '03', '04', '05', '06', '07', '11', '14'];
const ESTADO_CONTINGENCIA = 'CONTINGENCIA';
const ESTADO_INFORMADO = 'INFORMADO_MH';

// Cada tipo nombra distinto su monto: retención, liquidaciones y donación no tienen total a pagar.
const montosDelDte = (dte: any) => {
  const r = dte.resumen || {};
  const monto = r.totalIvaRetenido ?? r.total ?? r.valorTotal ?? dte.cuerpoDocumento?.liquidoApagar ?? 0;
  return {
    montoOperacion: r.montoTotalOperacion ?? r.totalCompra ?? monto,
    totalPagar: r.totalPagar ?? r.montoTotalOperacion ?? monto
  };
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
    else if (req.path === '/nota-credito') { tipoDte = '05'; versionDte = 4; }
    else if (req.path === '/nota-debito') { tipoDte = '06'; versionDte = 4; }
    else if (req.path === '/nota-remision') { tipoDte = '04'; versionDte = 4; }
    else if (req.path === '/comprobante-retencion') { tipoDte = '07'; versionDte = 2; }
    else if (req.path === '/comprobante-liquidacion') { tipoDte = '08'; versionDte = 2; }
    else if (req.path === '/documento-contable-liquidacion') { tipoDte = '09'; versionDte = 2; }
    else if (req.path === '/factura-exportacion') { tipoDte = '11'; versionDte = 3; }
    else if (req.path === '/factura-sujeto-excluido') { tipoDte = '14'; versionDte = 2; }
    else if (req.path === '/comprobante-donacion') { tipoDte = '15'; versionDte = 2; }

    // Pantalla "Pruebas Hacienda": cientos de documentos seguidos, sin correo y nunca en producción
    const soloPruebas = req.body.soloPruebas === true;
    if (soloPruebas && req.emisor.ambiente !== '00') {
      return res.status(403).json({ success: false, error: 'Las pruebas solo pueden enviarse en el ambiente 00.' });
    }

    // En producción solo se emite lo que Hacienda autorizó al emisor
    const autorizados = req.emisor.dtes_visibles;
    if (req.emisor.ambiente === '01' && Array.isArray(autorizados) && !autorizados.includes(tipoDte)) {
      return res.status(403).json({ success: false, error: 'Este tipo de documento no está autorizado para su empresa en producción.' });
    }

    const enContingencia = !!req.body.contingencia;
    if (enContingencia && !TIPOS_EN_CONTINGENCIA.includes(tipoDte)) {
      return res.status(422).json({ success: false, error: 'Este tipo de documento no se puede emitir en contingencia.' });
    }

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
    const { montoOperacion, totalPagar } = montosDelDte(documentoBase);
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
      // En contingencia el documento solo se firma; se transmite tras informar el evento.
      let envio: any = enContingencia
        ? {
            estado: ESTADO_CONTINGENCIA,
            descripcionMsg: 'Documento transitorio: pendiente de informar a Hacienda',
            observaciones: [],
            documentoFirmado: await firmarDocumento(emisorDb.nit.replace(/-/g, ''), documentoBase, emisorDb.pwd_firmador || '')
          }
        : await enviarAlMH(documentoBase, tipoDte, versionDte, emisorDb);

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
    // Retención y liquidación detallan documentos, no productos: no traen cantidad ni precio.
    const itemsData = (Array.isArray(documentoBase.cuerpoDocumento) ? documentoBase.cuerpoDocumento : []).map((item: any) => ({
      dte_id: dteRegistrado.id,
      num_item: item.numItem,
      cantidad: item.cantidad ?? 1,
      descripcion: String(item.descripcion || item.observaciones || item.numeroDocumento || '').slice(0, 255),
      precio_unitario: item.precioUni ?? item.valorUni ?? item.montoSujetoGrav ?? 0,
      venta_gravada: item.ventaGravada ?? item.compra ?? item.montoSujetoGrav ?? 0,
      venta_exenta: item.ventaExenta || 0,
      venta_nosujeta: item.ventaNoSuj || 0,
      iva_item: item.ivaItem ?? item.totalIva ?? item.ivaRetenido ?? 0,
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
              descripcion_rechazo: esProcesado || estadoFinal === ESTADO_CONTINGENCIA
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

    if (estadoFinal === ESTADO_CONTINGENCIA) {
      return res.json({
        success: true,
        estado: estadoFinal,
        codigoGeneracion: documentoBase.identificacion.codigoGeneracion,
        numeroControl: documentoBase.identificacion.numeroControl,
        resultado: resultadoMH,
        dteCompleto,
        pdfUrl: `/api/dtes/${documentoBase.identificacion.codigoGeneracion}/pdf`,
        jsonUrl: `/api/dtes/${documentoBase.identificacion.codigoGeneracion}/json`
      });
    }

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

    if (soloPruebas) return;

    // Proceso independiente e asíncrono en segundo plano (No bloquea la respuesta HTTP)
    setImmediate(async () => {
      try {
        const dtePdfObj = {
          ...dteCompleto,
          emisor: { ...dteCompleto.emisor, logoUrl: emisorDb.logo_url }
        };
        const pdfBuffer = await generarPdfDte(dtePdfObj);

        const tipoDteNombre = TIPOS_DTE_NOMBRES[documentoBase.identificacion?.tipoDte] || 'Factura';
        const destinoCorreo = documentoBase.receptor?.correo || emisorDb.correo;
        const nombreReceptor = documentoBase.receptor?.nombre || 'Cliente';
        const nombreEmisor = documentoBase.emisor?.nombre || emisorDb.razon_social || 'Emisor';
        const montoTotal = Number(montosDelDte(documentoBase).totalPagar).toFixed(2);

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

// Catálogos oficiales de MH que dependen de una lista larga (países, recintos, regímenes...)
let catalogosGenerales: any = null;
router.get('/catalogos/generales', (_req: any, res: any) => {
  if (!catalogosGenerales) {
    catalogosGenerales = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'catalogos', 'generales.json'), 'utf8'));
  }
  res.json({ success: true, ...catalogosGenerales });
});

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
// =========================================================================
// EVENTOS DE INVALIDACIÓN Y CONTINGENCIA
// =========================================================================
const crearEvento = async (emisorDb: any, tipo: string, evento: any, dteId: number | null) => {
  const prisma = (await import('../db/prisma')).default;
  return prisma.eventoDte.create({
    data: {
      emisor_id: emisorDb.id,
      dte_id: dteId,
      tipo,
      ambiente: emisorDb.ambiente || '00',
      codigo_generacion: evento.identificacion.codigoGeneracion,
      json_enviado: evento
    }
  });
};

// Un error de firma o autenticación implica que el evento no salió; sin respuesta de MH se desconoce.
const transmitirEvento = async (ruta: 'anulardte' | 'contingencia', evento: any, emisorDb: any, datosEnvio: any) => {
  try {
    const { documentoFirmado, ...respuesta } = await enviarEventoMh(ruta, evento, emisorDb, datosEnvio);
    return { respuesta, documentoFirmado };
  } catch (error: any) {
    const estado = error instanceof EnvioIndeterminadoError ? 'PENDIENTE_MH' : 'NO_ENVIADO';
    return { respuesta: { estado, descripcionMsg: error.message, observaciones: [] }, documentoFirmado: null };
  }
};

const motivoHacienda = (r: any) => {
  const obs = r.observaciones?.length ? ': ' + r.observaciones.join('; ') : '';
  return `${r.descripcionMsg || r.mensaje || 'Rechazado por Hacienda'}${obs}`;
};

router.post('/evento-invalidacion', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const codigo = String(req.body.codigoGeneracion || '');
    if (!UUID_REGEX.test(codigo)) {
      return res.status(400).json({ success: false, error: 'Código de generación inválido.' });
    }

    const dte = await prisma.dteEmitido.findFirst({ where: { codigo_generacion: codigo, emisor_id: emisorDb.id, ambiente: emisorDb.ambiente || '00' } });
    if (!dte) return res.status(404).json({ success: false, error: 'Documento no encontrado.' });
    if (dte.estado !== 'PROCESADO' || !dte.sello_recepcion_mh) {
      return res.status(409).json({ success: false, error: `Solo se puede invalidar un documento procesado. Estado actual: ${dte.estado}.` });
    }

    const reemplazo = req.body.codigoGeneracionR;
    if (reemplazo) {
      if (!UUID_REGEX.test(String(reemplazo)) || String(reemplazo).toLowerCase() === codigo.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'El documento de reemplazo no es válido.' });
      }
      const nuevo = await prisma.dteEmitido.findFirst({ where: { codigo_generacion: reemplazo, emisor_id: emisorDb.id } });
      if (!nuevo || nuevo.estado !== 'PROCESADO') {
        return res.status(422).json({ success: false, error: 'El documento de reemplazo debe estar emitido y procesado por Hacienda.' });
      }
    }

    const evento = construirEventoInvalidacion(dte, req.body, emisorDb);
    const registro = await crearEvento(emisorDb, 'INVALIDACION', evento, dte.id);
    const { respuesta, documentoFirmado } = await transmitirEvento('anulardte', evento, emisorDb, {
      ambiente: emisorDb.ambiente || '00',
      idEnvio: Math.floor(Date.now() / 1000),
      version: evento.identificacion.version
    });

    const aceptado = respuesta.estado === 'PROCESADO';
    await prisma.$transaction([
      prisma.eventoDte.update({
        where: { id: registro.id },
        data: {
          estado: respuesta.estado || 'RECHAZADO',
          sello_recepcion_mh: respuesta.selloRecibido || null,
          json_enviado: { ...evento, firmaElectronica: documentoFirmado },
          respuesta_mh: respuesta
        }
      }),
      ...(aceptado ? [prisma.dteEmitido.update({ where: { id: dte.id }, data: { estado: 'INVALIDADO' } })] : [])
    ]);

    if (!aceptado) {
      return res.json({ success: false, estado: respuesta.estado, error: motivoHacienda(respuesta), resultado: respuesta });
    }
    res.json({ success: true, codigoGeneracion: evento.identificacion.codigoGeneracion, selloRecibido: respuesta.selloRecibido, resultado: respuesta });
  } catch (error: any) {
    if (error instanceof DteInvalidoError) {
      return res.status(422).json({ success: false, error: error.message, detalles: error.detalles });
    }
    console.error('Error en invalidación:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Documentos transitorios y eventos de contingencia del emisor.
router.get('/contingencia/estado', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const ambiente = emisorDb.ambiente || '00';
    const documentos = await prisma.dteEmitido.findMany({
      where: { emisor_id: emisorDb.id, ambiente, estado: { in: [ESTADO_CONTINGENCIA, ESTADO_INFORMADO] } },
      orderBy: { id: 'asc' },
      select: { codigo_generacion: true, tipo_dte: true, numero_control: true, estado: true, fecha_emision: true, hora_emision: true, total_pagar: true }
    });
    const eventos = await prisma.eventoDte.findMany({
      where: { emisor_id: emisorDb.id, ambiente, tipo: 'CONTINGENCIA' },
      orderBy: { id: 'desc' },
      take: 10,
      select: { codigo_generacion: true, estado: true, sello_recepcion_mh: true, created_at: true, respuesta_mh: true }
    });
    res.json({ success: true, documentos, eventos });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Momento 2: informa a MH los documentos transitorios generados dentro del periodo.
router.post('/evento-contingencia', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const c = req.body;
    if (!c.fInicio || !c.hInicio || !c.fFin || !c.hFin) {
      throw new DteInvalidoError('Indique la fecha y hora de inicio y de fin de la contingencia.');
    }
    const inicio = `${c.fInicio} ${c.hInicio}`;
    const fin = `${c.fFin} ${c.hFin}`;
    if (inicio > fin) throw new DteInvalidoError('El inicio de la contingencia no puede ser posterior a su fin.');

    const transitorios = await prisma.dteEmitido.findMany({
      where: { emisor_id: emisorDb.id, ambiente: emisorDb.ambiente || '00', estado: ESTADO_CONTINGENCIA },
      orderBy: { id: 'asc' },
      take: 1000
    });
    // MH compara el periodo y el tipo de contingencia del evento con los de cada documento.
    const documentos = transitorios.filter((d: any) => {
      const id = d.json_enviado?.identificacion || {};
      const momento = `${id.fecEmi} ${id.horEmi}`;
      return momento >= inicio && momento <= fin && id.tipoContingencia === Number(c.tipoContingencia);
    });
    if (documentos.length === 0) {
      throw new DteInvalidoError('No hay documentos en contingencia de ese tipo dentro del periodo indicado.');
    }

    const evento = construirEventoContingencia(documentos, c, emisorDb);
    const registro = await crearEvento(emisorDb, 'CONTINGENCIA', evento, null);
    const { respuesta, documentoFirmado } = await transmitirEvento('contingencia', evento, emisorDb, {
      nit: emisorDb.nit.replace(/-/g, '')
    });

    const aceptado = respuesta.estado === 'RECIBIDO' && !!respuesta.selloRecibido;
    await prisma.$transaction([
      prisma.eventoDte.update({
        where: { id: registro.id },
        data: {
          estado: respuesta.estado || 'RECHAZADO',
          sello_recepcion_mh: respuesta.selloRecibido || null,
          json_enviado: { ...evento, firmaElectronica: documentoFirmado },
          respuesta_mh: respuesta
        }
      }),
      ...(aceptado ? [prisma.dteEmitido.updateMany({
        where: { id: { in: documentos.map((d: any) => d.id) } },
        data: { estado: ESTADO_INFORMADO }
      })] : [])
    ]);

    if (!aceptado) {
      return res.json({ success: false, estado: respuesta.estado, error: motivoHacienda(respuesta), resultado: respuesta });
    }
    res.json({
      success: true,
      codigoGeneracion: evento.identificacion.codigoGeneracion,
      selloRecibido: respuesta.selloRecibido,
      documentosInformados: documentos.length,
      omitidos: transitorios.length - documentos.length,
      resultado: respuesta
    });
  } catch (error: any) {
    if (error instanceof DteInvalidoError) {
      return res.status(422).json({ success: false, error: error.message, detalles: error.detalles });
    }
    console.error('Error en evento de contingencia:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Momento 3: transmite uno a uno los documentos informados, sin cambiar sus datos de origen.
router.post('/contingencia/transmitir', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const VERSIONES: Record<string, number> = { '01': 2, '03': 4, '04': 4, '05': 4, '06': 4, '07': 2, '11': 3, '14': 2 };
    const POR_LLAMADA = 20;

    const informados = await prisma.dteEmitido.findMany({
      where: { emisor_id: emisorDb.id, ambiente: emisorDb.ambiente || '00', estado: ESTADO_INFORMADO },
      orderBy: { id: 'asc' },
      take: POR_LLAMADA
    });

    const resultados: any[] = [];
    for (const dte of informados) {
      const { firmaElectronica, selloRecibido, ...original } = dte.json_enviado as any;
      let resultado: any;
      let firma: string | null = firmaElectronica || null;
      try {
        const { documentoFirmado, ...respuesta } = await enviarAlMH(original, dte.tipo_dte, VERSIONES[dte.tipo_dte], emisorDb);
        firma = documentoFirmado;
        resultado = respuesta;
      } catch (error: any) {
        // Sin respuesta de MH sigue informado y se reintenta en la siguiente llamada.
        resultados.push({ codigoGeneracion: dte.codigo_generacion, numeroControl: dte.numero_control, estado: ESTADO_INFORMADO, mensaje: error.message });
        continue;
      }

      const procesado = resultado.estado === 'PROCESADO';
      await prisma.dteEmitido.update({
        where: { id: dte.id },
        data: {
          estado: resultado.estado || 'RECHAZADO',
          sello_recepcion_mh: resultado.selloRecibido || null,
          descripcion_rechazo: procesado ? null : motivoHacienda(resultado),
          json_enviado: { ...original, firmaElectronica: firma },
          respuesta_mh: resultado
        }
      });
      resultados.push({
        codigoGeneracion: dte.codigo_generacion,
        numeroControl: dte.numero_control,
        estado: resultado.estado,
        selloRecibido: resultado.selloRecibido || null,
        mensaje: procesado ? null : motivoHacienda(resultado)
      });

      if (procesado && !(req.body.soloPruebas === true && emisorDb.ambiente === '00')) {
        const dteCompleto = generarJsonDteCompleto(original, firma, resultado.selloRecibido);
        setImmediate(async () => {
          try {
            await enviarCorreoDte({
              destinoCorreo: original.receptor?.correo || emisorDb.correo,
              nombreReceptor: original.receptor?.nombre || 'Cliente',
              nombreEmisor: emisorDb.razon_social || 'Emisor',
              tipoDteNombre: TIPOS_DTE_NOMBRES[dte.tipo_dte] || 'Documento',
              numeroControl: dte.numero_control,
              codigoGeneracion: String(dte.codigo_generacion).toUpperCase(),
              montoTotal: Number(dte.total_pagar).toFixed(2),
              pdfBuffer: await generarPdfDte({ ...dteCompleto, emisor: { ...dteCompleto.emisor, logoUrl: emisorDb.logo_url } }),
              jsonCompleto: dteCompleto
            });
          } catch (bgErr: any) {
            console.error('⚠️ Error al enviar correo de documento en contingencia:', bgErr.message || bgErr);
          }
        });
      }
    }

    const pendientes = await prisma.dteEmitido.count({
      where: { emisor_id: emisorDb.id, ambiente: emisorDb.ambiente || '00', estado: ESTADO_INFORMADO }
    });
    res.json({ success: true, resultados, pendientes });
  } catch (error: any) {
    console.error('Error al transmitir documentos en contingencia:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

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

    const { enviado, motivo } = await enviarCorreoConMotivo({
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
        error: `No se pudo enviar el correo a "${finalCorreo}". ${motivo || ''}`
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
    // MH sigue respondiendo PROCESADO tras invalidar: ese estado no debe sobrescribir la invalidación.
    if (dte.estado === 'INVALIDADO') {
      return res.json({ success: true, estado: dte.estado, selloRecibido: dte.sello_recepcion_mh });
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
    
    // Con código de generación se consulta el estado en Hacienda; sin él, el listado reciente.
    const { tipoDte, codigoGeneracion } = req.body || {};
    if (codigoGeneracion) {
      if (!UUID_REGEX.test(String(codigoGeneracion))) {
        return res.status(400).json({ success: false, error: 'Código de generación inválido.' });
      }
      const resultado = await consultarDteMh(String(codigoGeneracion), String(tipoDte || '01'), emisorDb);
      if (!resultado) {
        return res.json({ success: false, error: 'Hacienda no tiene registro de ese documento o no respondió.' });
      }
      const propio = await prisma.dteEmitido.findFirst({
        where: { codigo_generacion: String(codigoGeneracion), emisor_id: emisorDb.id },
        select: { estado: true }
      });
      // MH sigue respondiendo PROCESADO tras recibir la invalidación.
      return res.json({ success: true, resultado: propio?.estado === 'INVALIDADO' ? { ...resultado, estado: 'INVALIDADO' } : resultado });
    }

    const dtes = await prisma.dteEmitido.findMany({
      where: { emisor_id: emisorDb.id, ambiente: emisorDb.ambiente || '00' },
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
    // Los documentos de pruebas nunca se suman a los de producción
    const delAmbiente = { emisor_id: emisorDb.id, ambiente: emisorDb.ambiente || '00' };

    // Contar total de documentos del emisor
    const totalDocumentos = await prisma.dteEmitido.count({
      where: delAmbiente
    });

    // Sumar montos totales del emisor
    const aggregateMonto = await prisma.dteEmitido.aggregate({
      where: { ...delAmbiente, estado: 'PROCESADO' },
      _sum: {
        total_pagar: true
      }
    });
    const montoTotal = Number(aggregateMonto._sum.total_pagar || 0);

    // Agrupar por estado para obtener contadores específicos del emisor
    const countsByEstado = await prisma.dteEmitido.groupBy({
      by: ['estado'],
      where: delAmbiente,
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
      where: delAmbiente,
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
      where: delAmbiente,
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
      where: {
        emisor_id: emisorDb.id,
        tipo_documento: { not: TIPO_RETENCION_RECIBIDA },
        // En producción no se mezclan documentos de pruebas; las registradas a mano no tienen ambiente
        ...(emisorDb.ambiente === '01' ? { OR: [{ ambiente: null }, { ambiente: { not: '00' } }] } : {})
      },
      include: {
        items: true,
        archivos: { select: { tipo: true } }
      },
      orderBy: [{ fecha_compra: 'desc' }, { id: 'desc' }]
    });
    res.json({ success: true, compras });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =========================================================================
// LECTURA DE COMPRAS DESDE EL CORREO DEL EMISOR (Tenant-Safe)
// =========================================================================
const datosImportacion = (i: any) => i && ({
  id: i.id,
  periodo: i.periodo,
  estado: importacionVencida(i) ? 'ERROR' : i.estado,
  total: i.total,
  revisados: i.revisados,
  importadas: i.importadas,
  duplicadas: i.duplicadas,
  ignoradas: i.ignoradas,
  porRevisar: i.por_revisar,
  detalle: i.detalle || [],
  error: importacionVencida(i) ? 'La lectura se interrumpió. Puede volver a iniciarla sin riesgo de duplicar compras.' : i.error,
  fecha: i.created_at
});

router.get('/compras/correo/conexion', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const prisma = (await import('../db/prisma')).default;
    const conexion = await prisma.conexionCorreo.findUnique({ where: { emisor_id: emisorDb.id } });
    const ultima = await prisma.importacionCorreo.findFirst({ where: { emisor_id: emisorDb.id }, orderBy: { id: 'desc' } });
    const vigente = !!conexion && conexion.usuario.toLowerCase() === String(emisorDb.correo).toLowerCase();
    res.json({
      success: true,
      disponible: cifradoDisponible(),
      correo: emisorDb.correo,
      conectado: vigente,
      host: vigente ? conexion!.host : servidorSugerido(emisorDb.correo || ''),
      ultima: datosImportacion(ultima)
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/compras/correo/conexion', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    if (!cifradoDisponible()) {
      return res.status(503).json({ success: false, error: 'La lectura de correo aún no está habilitada en el servidor.' });
    }
    const host = String(req.body.host || '').trim().toLowerCase();
    // Las contraseñas de aplicación de Google se muestran con espacios que no forman parte de ellas
    const password = String(req.body.password || '').replace(/\s+/g, '');
    if (!emisorDb.correo || !host || !password) {
      return res.status(400).json({ success: false, error: 'El servidor de correo y la contraseña de aplicación son obligatorios.' });
    }

    await probarConexion(host, emisorDb.correo, password);

    const prisma = (await import('../db/prisma')).default;
    const datos = { host, usuario: emisorDb.correo, password_cifrada: cifrar(password) };
    await prisma.conexionCorreo.upsert({ where: { emisor_id: emisorDb.id }, create: { emisor_id: emisorDb.id, ...datos }, update: datos });
    res.json({ success: true, correo: emisorDb.correo, host });
  } catch (error: any) {
    if (error instanceof ConexionCorreoError) return res.status(422).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/compras/correo/conexion', authMiddleware, async (req: any, res: any) => {
  try {
    const prisma = (await import('../db/prisma')).default;
    await prisma.conexionCorreo.deleteMany({ where: { emisor_id: req.emisor.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/compras/correo/importar', authMiddleware, async (req: any, res: any) => {
  try {
    const emisorDb = req.emisor;
    const periodo = req.body.periodo;
    if (!['TODO', 'MES', 'DIA'].includes(periodo)) {
      return res.status(400).json({ success: false, error: 'Indique si desea leer toda la bandeja, el mes o el día.' });
    }

    const prisma = (await import('../db/prisma')).default;
    const conexion = await prisma.conexionCorreo.findUnique({ where: { emisor_id: emisorDb.id } });
    if (!cifradoDisponible() || !conexion || conexion.usuario.toLowerCase() !== String(emisorDb.correo).toLowerCase()) {
      return res.status(409).json({ success: false, error: 'Conecte primero el correo del emisor.' });
    }

    const enCurso = await prisma.importacionCorreo.findFirst({ where: { emisor_id: emisorDb.id, estado: 'EN_PROCESO' }, orderBy: { id: 'desc' } });
    if (enCurso && !importacionVencida(enCurso)) {
      return res.status(409).json({ success: false, error: 'Ya hay una lectura en curso.', importacion: datosImportacion(enCurso) });
    }
    if (enCurso) {
      await prisma.importacionCorreo.update({ where: { id: enCurso.id }, data: { estado: 'ERROR', error: 'La lectura se interrumpió.' } });
    }

    const importacion = await prisma.importacionCorreo.create({ data: { emisor_id: emisorDb.id, periodo } });
    // Una bandeja completa puede tardar varios minutos: la pantalla consulta el avance
    ejecutarImportacion(importacion.id, emisorDb, periodo).catch(e => console.error('Error en la lectura de correo:', e?.message));
    res.status(202).json({ success: true, importacion: datosImportacion(importacion) });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/compras/correo/importar/:id', authMiddleware, async (req: any, res: any) => {
  try {
    const prisma = (await import('../db/prisma')).default;
    const importacion = await prisma.importacionCorreo.findFirst({ where: { id: Number(req.params.id) || 0, emisor_id: req.emisor.id } });
    if (!importacion) return res.status(404).json({ success: false, error: 'Lectura no encontrada.' });
    res.json({ success: true, importacion: datosImportacion(importacion) });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/compras/:id/archivos/:tipo', authMiddleware, async (req: any, res: any) => {
  try {
    const tipo = String(req.params.tipo).toUpperCase();
    const prisma = (await import('../db/prisma')).default;
    const archivo = await prisma.compraArchivo.findFirst({
      where: { tipo, compra_id: Number(req.params.id) || 0, compra: { emisor_id: req.emisor.id } }
    });
    if (!archivo) return res.status(404).json({ success: false, error: 'Archivo no encontrado.' });
    // Lo envió un tercero: siempre como descarga, nunca para mostrarlo dentro de la aplicación
    res.setHeader('Content-Type', tipo === 'PDF' ? 'application/pdf' : 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${archivo.nombre}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(archivo.contenido));
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
// CONTABILIDAD: LIBROS DE IVA Y PAGO A CUENTA (Tenant-Safe)
// =========================================================================
const responderContabilidad = (accion: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
  try {
    await accion(req, res);
  } catch (error: any) {
    if (error instanceof ContabilidadError) return res.status(422).json({ success: false, error: error.message });
    console.error('Error en contabilidad:', error);
    res.status(500).json({ success: false, error: 'No se pudo procesar la información contable.' });
  }
};

router.get('/contabilidad/configuracion', authMiddleware, responderContabilidad(async (req, res) => {
  res.json({ success: true, configuracion: await obtenerConfiguracion(req.emisor.id) });
}));

router.put('/contabilidad/configuracion', authMiddleware, responderContabilidad(async (req, res) => {
  res.json({ success: true, configuracion: await guardarConfiguracion(req.emisor.id, req.body) });
}));

router.get('/contabilidad/:periodo', authMiddleware, responderContabilidad(async (req, res) => {
  res.json({ success: true, ...(await reporteDelPeriodo(req.emisor, req.params.periodo)) });
}));

router.put('/contabilidad/:periodo/ajustes', authMiddleware, responderContabilidad(async (req, res) => {
  await guardarAjustes(req.emisor.id, req.params.periodo, req.body);
  res.json({ success: true });
}));

router.get('/contabilidad/:periodo/anexos/:anexo', authMiddleware, responderContabilidad(async (req, res) => {
  const { nombre, contenido } = await archivoAnexo(req.emisor, req.params.periodo, req.params.anexo);
  res.setHeader('Content-Type', 'text/csv; charset=windows-1252');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(contenido);
}));

router.put('/compras/:id/contable', authMiddleware, responderContabilidad(async (req, res) => {
  await actualizarDatosContables(req.emisor.id, Number(req.params.id) || 0, req.body);
  res.json({ success: true });
}));

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
        receptor: (dte.json_enviado as any)?.receptor || null,
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
