import express from 'express';
import cors from 'cors';
import routes from './routes/index.routes';

const app = express();
const port = process.env.PORT || 4001;

// Middleware
app.use(cors());
app.use(express.json());

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
