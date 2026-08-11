const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-smdled-key-2026';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer TOKEN"

  if (!token) return res.status(401).json({ error: 'Доступ запрещен. Токен не предоставлен.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный или просроченный токен.' });
    req.user = user;
    next();
  });
}

function requireDirector(req, res, next) {
  if (req.user.role !== 'director') {
    return res.status(403).json({ error: 'Требуются права Директора.' });
  }
  next();
}

function requireEditRights(req, res, next) {
  if (req.user.role !== 'director' && !req.user.canEdit) {
    return res.status(403).json({ error: 'Нет прав на редактирование проектов.' });
  }
  next();
}

module.exports = { authenticateToken, requireDirector, requireEditRights, JWT_SECRET };
