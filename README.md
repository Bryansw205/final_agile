Proyecto: Sistema de Gestión de Préstamos

Resumen
- Backend: Node.js (Express) + Prisma (SQLite en dev; compatible con MySQL/PostgreSQL)
- Frontend: React (Vite)
- Autenticación: JWT (rol único)
- Integración: Servicio para consulta de DNI (APIs Perú o similar)
- Funciones clave: Registro de préstamos, cálculo de cronograma, exportación a PDF, módulo de clientes con búsqueda/filtrado.

Inicio rápido
1) Backend (MySQL)
   - Crea la base de datos: `CREATE DATABASE loans;`
   - Copia `backend/.env.example` a `backend/.env` y actualiza `DATABASE_URL` a tu conexión MySQL.
   - `cd backend`
   - `npm install`
   - `npx prisma migrate dev --name init`
   - (Opcional) `npm run seed` para crear usuario admin por defecto
   - `npm run dev`

2) Frontend
   - `cd frontend`
   - `npm install`
   - Copiar `.env.example` a `.env` y ajustar `VITE_API_URL` si es necesario.
   - `npm run dev`

Notas
- Ahora el datasource está configurado para MySQL. Asegúrate de que `DATABASE_URL` apunte a tu instancia y que la DB exista.
- El servicio de DNI está desacoplado y soporta modo "mock" si no configuras credenciales.

Configuración DNI (Decolecta)
- Solo necesitas el token.
- Variables en `backend/.env`:
  - `DNI_API_TOKEN=tu_token`
  - Opcional: `DNI_API_URL=https://api.decolecta.com/v1` (por defecto ya está así)
  - Opcional: `DNI_API_ENABLED=true` (por defecto se habilita si hay token)
  - Endpoint usado: `GET {DNI_API_URL}/reniec/dni?numero={dni}` con header `Authorization: Bearer <token>`

Endpoints principales (backend)
- `POST /auth/login` → JWT
- `POST /clients/lookup { dni }` → Crea/actualiza cliente consultando API de DNI
- `GET /clients?q=...&dni=...` → Lista y filtra clientes
- `POST /loans` → Crea préstamo y cronograma
- `GET /loans/:id` → Detalle de préstamo con cronograma
- `GET /loans/:id/schedule.pdf` → PDF descargable del cronograma

Validaciones clave
- Fecha de inicio no puede ser pasada (se valida contra la fecha actual).
- Monto, tasa y plazo deben ser números válidos y positivos (tasa > 0).
- DNI debe tener 8 dígitos; se consulta API de terceros (o mock).

Notas de cálculo de cronograma
- Tasa provista es anual. Se prorratea por periodo según la unidad del plazo:
  - Meses: tasa/12; Días: tasa/365; Años: tasa/1.
- Cuota fija por periodo mediante fórmula de anualidad (si tasa > 0); si tasa = 0, cuotas iguales a capital/periodos.
