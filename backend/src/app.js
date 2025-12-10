import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import loanRoutes from './routes/loans.js';
import paymentRoutes from './routes/payments.js';
import cashSessionRoutes from './routes/cashSessions.js';
import flowRoutes from './routes/flow.js';
import sunatRoutes from './routes/sunat.js';

const app = express();

// Configurar CORS para permitir tu dominio de Vercel
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/clients', clientRoutes);
app.use('/loans', loanRoutes);
app.use('/payments', paymentRoutes);
app.use('/cash-sessions', cashSessionRoutes);
app.use('/flow', flowRoutes);
app.use('/sunat', sunatRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

export default app;
