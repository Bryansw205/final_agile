import { config } from './config.js';
import app from './app.js';

const PORT = config.port;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

console.log('🚀 Iniciando servidor...');
console.log('   PORT:', PORT);
console.log('   FRONTEND_URL:', FRONTEND_URL);
console.log('   NODE_ENV:', process.env.NODE_ENV || 'development');

app.listen(PORT, () => {
  console.log(`✅ Backend escuchando en puerto ${PORT}`);
  console.log(`   Acepta solicitudes desde: ${FRONTEND_URL}`);
});
