import express from 'express';
import cors from 'cors';
import routes from './routes/index.routes';

const app = express();
const port = process.env.PORT || 4001;

// Middleware
// CORS_ORIGINS: frontends autorizados, separados por comas. Sin definir queda abierto.
const origenes = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
// Expone el nombre oficial de los archivos descargados a los frontends de otros dominios
app.use(cors({ ...(origenes.length > 0 ? { origin: origenes } : {}), exposedHeaders: ['Content-Disposition'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get('/health', async (_req, res) => {
  try {
    const prisma = (await import('./db/prisma')).default;
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', commit: process.env.RAILWAY_GIT_COMMIT_SHA || null });
  } catch {
    res.status(503).json({ status: 'error' });
  }
});

// Routes
app.use('/api', routes);
app.use('/', routes); // Por si el frontend lo busca en la raiz directamente

// Error handling
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Error interno del servidor' });
});

app.listen(port, () => {
  console.log(`🚀 Backend corriendo en http://localhost:${port}`);
  console.log(`Rutas habilitadas en http://localhost:${port}/api/factura etc...`);
});
