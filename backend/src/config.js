import dotenv from 'dotenv';
dotenv.config();

const DNI_API_TOKEN = process.env.DNI_API_TOKEN || '';

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 4000,
  jwtSecret: process.env.JWT_SECRET || 'change_me_secret',
  databaseUrl: process.env.DATABASE_URL,
  dni: {
    // Habilita automáticamente si hay token. Permite override con DNI_API_ENABLED.
    enabled: ((process.env.DNI_API_ENABLED || '').toLowerCase() === 'true') || (!!DNI_API_TOKEN),
    baseUrl: process.env.DNI_API_URL || 'https://api.decolecta.com/v1',
    token: DNI_API_TOKEN
  }
};
