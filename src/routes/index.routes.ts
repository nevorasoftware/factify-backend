import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { enviarAlMH } from '../services/mh.service';
import { config } from '../config';
import { verifyToken, generateToken } from '../utils/jwt';

const router = Router();

const round2 = (num: number) => Number((Math.round((num + Number.EPSILON) * 100) / 100).toFixed(2));

// =========================================================================
// MIDDLEWARE DE AUTENTICACIÓN
// =========================================================================
export const authMiddleware = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token de acceso no proporcionado' });
    }

    const token = authHeader.split(' ')[1];
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

    if (!emisor) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas (usuario no registrado)' });
    }

    // Validación de contraseña simple/plana para facilitar el mantenimiento por script SQL
    if (emisor.password !== password.trim()) {
      return res.status(401).json({ success: false, error: 'Credenciales inválidas (contraseña incorrecta)' });
    }

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
      codEstablecimientoMh, codPuntoVentaMh
    } = req.body;

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
        cod_punto_venta_mh: codPuntoVentaMh !== undefined ? codPuntoVentaMh : emisor.cod_punto_venta_mh
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
    let versionDte = 1;

    if (req.path === '/ccf') { tipoDte = '03'; versionDte = 3; }
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

    // Enviar al MH y gestionar la auto-recuperación
    let resultadoMH: any;
    let errorOcurrido: any = null;
    try {
      resultadoMH = await enviarAlMH(documentoBase, tipoDte, versionDte, emisorDb);

      // Auto-recuperación ante rechazo por número de control duplicado (código 004)
      let intentos = 0;
      while (
        resultadoMH.estado === 'RECHAZADO' &&
        (resultadoMH.codigoMsg === '004' || (resultadoMH.descripcionMsg && resultadoMH.descripcionMsg.includes('YA EXISTE UN REGISTRO CON ESE VALOR'))) &&
        intentos < 5
      ) {
        intentos++;
        const currentNumControl = documentoBase.identificacion.numeroControl;
        console.log(`⚠️ [DTE RETRY] MH rechazó por duplicado de número de control (${currentNumControl}). Intento de auto-recuperación ${intentos}/5. Incrementando correlativo...`);
        
        const parts = currentNumControl.split('-');
        const lastPart = parts[parts.length - 1];
        const correlativoNum = parseInt(lastPart, 10);
        
        if (!isNaN(correlativoNum)) {
          const nextCorrelativoNum = correlativoNum + 1;
          const nextCorrelativoStr = nextCorrelativoNum.toString().padStart(15, '0');
          
          parts[parts.length - 1] = nextCorrelativoStr;
          const nuevoNumControl = parts.join('-');
          
          // Actualizar el documento base con el nuevo correlativo y un nuevo UUID para el intento
          documentoBase.identificacion.numeroControl = nuevoNumControl;
          documentoBase.identificacion.codigoGeneracion = uuidv4().toUpperCase();
          
          console.log(`🔄 [DTE RETRY] Re-intentando envío con nuevo numeroControl: "${nuevoNumControl}" y codigoGeneracion: "${documentoBase.identificacion.codigoGeneracion}"`);
          resultadoMH = await enviarAlMH(documentoBase, tipoDte, versionDte, emisorDb);
        } else {
          break;
        }
      }
    } catch (error: any) {
      console.error('⚠️ [DTE ERROR] Falló el envío al MH:', error.message || error);
      errorOcurrido = error;
      resultadoMH = {
        estado: 'RECHAZADO',
        descripcionMsg: error.message || 'Error de conexión o firma al enviar al MH',
        observaciones: []
      };
    }

    // Guardar en la Base de Datos asociando el DTE al emisorDb actual o guardando el fallo
    let clienteId = null;
    try {
      const prisma = (await import('../db/prisma')).default;

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
          console.log(`👤 Cliente con documento ${numDoc} no encontrado para este emisor. Creándolo...`);
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

      // Guardar el DTE Emitido principal (sea procesado o rechazado)
      const newDte = await prisma.dteEmitido.create({
        data: {
          emisor_id: emisorDb.id,
          cliente_id: clienteId,
          tipo_dte: tipoDte,
          codigo_generacion: (documentoBase.identificacion.codigoGeneracion || '').toUpperCase(),
          numero_control: documentoBase.identificacion.numeroControl,
          sello_recepcion_mh: resultadoMH.selloRecibido || null,
          estado: resultadoMH.estado || 'RECHAZADO',
          descripcion_rechazo: resultadoMH.estado === 'RECHAZADO'
            ? `${resultadoMH.descripcionMsg || 'Rechazado por el MH'}${resultadoMH.observaciones && resultadoMH.observaciones.length > 0 ? ': ' + resultadoMH.observaciones.join('; ') : ''}`
            : null,
          fecha_emision: new Date(documentoBase.identificacion.fecEmi + 'T00:00:00Z'),
          hora_emision: new Date('1970-01-01T' + documentoBase.identificacion.horEmi + 'Z'),
          monto_total_operacion: documentoBase.resumen ? (documentoBase.resumen.montoTotalOperacion || documentoBase.resumen.valorTotal || 0) : 0,
          total_pagar: documentoBase.resumen ? (documentoBase.resumen.totalPagar || documentoBase.resumen.valorTotal || 0) : 0,
          json_enviado: documentoBase as any,
          respuesta_mh: resultadoMH as any
        }
      });
      console.log(`💾 DTE Guardado en PostgreSQL (Estado: ${newDte.estado}) para Emisor ID: ${emisorDb.id} con DTE ID: ${newDte.id}`);

      // Guardar los ítems
      if (documentoBase.cuerpoDocumento && documentoBase.cuerpoDocumento.length > 0) {
        const itemsData = documentoBase.cuerpoDocumento.map((item: any) => ({
          dte_id: newDte.id,
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

        await prisma.dteItem.createMany({
          data: itemsData
        });
      }

    } catch (dbError: any) {
      console.error('⚠️ Error guardando en BD (Prisma):', dbError.message || dbError);
    }

    if (resultadoMH.estado === 'RECHAZADO') {
      res.json({
        success: false,
        error: errorOcurrido ? `Fallo al procesar/enviar el DTE: ${errorOcurrido.message}` : 'Rechazado por el MH',
        resultado: resultadoMH
      });
    } else {
      res.json({
        success: true,
        codigoGeneracion: documentoBase.identificacion.codigoGeneracion,
        resultado: resultadoMH
      });
    }

  } catch (error: any) {
    console.error('Controller Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

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
      where: { emisor_id: emisorDb.id },
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
      else if (estado === 'PROCESANDO') stats.pendientes = count;
      else if (estado === 'BORRADOR') stats.borrador = count;
      else if (estado === 'ENVIADO') stats.enviado = count;
      else if (estado === 'RECHAZADO') stats.rechazado = count;
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
