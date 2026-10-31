import { Router } from 'express';
import { enviarEnlace } from '../services/cuenta.service';
import { actualizarEmpresa, crearEmpresa, EmpresaError, guardarCertificado, listarEmpresas, verificarEmpresa } from '../services/empresas.service';

// Administración de las empresas (tenants). Se monta detrás de authMiddleware y soloAdmin.
const router = Router();

const responder = (manejador: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
  try {
    await manejador(req, res);
  } catch (error: any) {
    if (error instanceof EmpresaError) {
      return res.status(error.estado).json({ success: false, error: error.message });
    }
    console.error('Error en administración de empresas:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo completar la operación.' });
  }
};

const idDe = (req: any) => Number(req.params.id) || 0;

router.get('/empresas', responder(async (_req, res) => {
  res.json({ success: true, empresas: await listarEmpresas() });
}));

router.post('/empresas', responder(async (req, res) => {
  const empresa = await crearEmpresa(req.body);
  res.json({ success: true, empresa });
}));

router.put('/empresas/:id', responder(async (req, res) => {
  res.json({ success: true, empresa: await actualizarEmpresa(idDe(req), req.body, req.emisor.id) });
}));

router.post('/empresas/:id/certificado', responder(async (req, res) => {
  res.json({ success: true, certificado: await guardarCertificado(idDe(req), req.body.contenido, req.body.clave) });
}));

router.post('/empresas/:id/verificar', responder(async (req, res) => {
  res.json({ success: true, ...(await verificarEmpresa(idDe(req))) });
}));

// Envía el enlace para crear la contraseña. Nunca se define ni se muestra una contraseña desde aquí.
router.post('/empresas/:id/invitar', responder(async (req, res) => {
  const prisma = (await import('../db/prisma')).default;
  const empresa = await prisma.emisor.findUnique({ where: { id: idDe(req) } });
  if (!empresa) throw new EmpresaError('Empresa no encontrada.', 404);
  if (!empresa.activo) throw new EmpresaError('La empresa está suspendida.');
  const enviado = await enviarEnlace(empresa, empresa.password ? 'RECUPERAR' : 'INVITACION', req.get('origin'));
  if (!enviado) throw new EmpresaError('No se pudo enviar el correo. Intente de nuevo.', 502);
  res.json({ success: true, correo: empresa.correo });
}));

export default router;
