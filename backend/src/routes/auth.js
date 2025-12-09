import { Router } from 'express';
import { body } from 'express-validator';
import { handleValidation } from '../middleware/validate.js';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { signToken, requireAuth } from '../middleware/auth.js';

const prisma = new PrismaClient();
const router = Router();

router.post(
  '/login',
  body('username').isString(),
  body('password').isString().isLength({ min: 6 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const { username, password } = req.body;
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
      const token = signToken({ sub: user.id, username: user.username, role: user.role });
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (e) {
      next(e);
    }
  }
);

export default router;

// Cambiar contraseña del usuario autenticado
router.post(
  '/change-password',
  requireAuth,
  body('currentPassword').isString(),
  body('newPassword').isString().isLength({ min: 8 }),
  handleValidation,
  async (req, res, next) => {
    try {
      const userId = Number(req.user?.sub || req.user?.id);
      if (!userId) return res.status(401).json({ error: 'Usuario no autenticado' });
      const { currentPassword, newPassword } = req.body;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);
