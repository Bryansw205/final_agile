import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(payload, options = {}) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '12h', ...options });
}

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  let token = auth.startsWith('Bearer ') ? auth.substring(7) : null;
  // Permite token por query param para descargas directas (?token=...)
  if (!token && req.query && typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    // Normalizar: el token usa 'sub' para el ID, pero las rutas esperan 'id'
    req.user = {
      ...decoded,
      id: decoded.sub || decoded.id,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
