import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import loanRoutes from './routes/loans.js';
import paymentRoutes from './routes/payments.js';
import cashSessionRoutes from './routes/cashSessions.js';
import flowRoutes from './routes/flow.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/clients', clientRoutes);
app.use('/loans', loanRoutes);
app.use('/payments', paymentRoutes);
app.use('/cash-sessions', cashSessionRoutes);
app.use('/flow', flowRoutes);

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
