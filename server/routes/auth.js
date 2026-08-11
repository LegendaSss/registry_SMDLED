const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../database');
const { authenticateToken, requireDirector, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

function generateUUID() {
  return crypto.randomUUID();
}

// Регистрация
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Заполните все поля.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const id = generateUUID();
    
    db.run(
      `INSERT INTO users (id, name, email, passwordHash, role, canViewFinances, canEdit) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, email.toLowerCase(), hash, 'viewer', 0, 0],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Пользователь с таким email уже существует.' });
          }
          return res.status(500).json({ error: 'Ошибка базы данных' });
        }
        
        const user = { id, name, email, role: 'viewer', canViewFinances: 0, canEdit: 0 };
        const token = jwt.sign(user, JWT_SECRET, { expiresIn: '12h' });
        res.status(201).json({ token, user });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Авторизация
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' });

  db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    if (!user) return res.status(400).json({ error: 'Неверный email или пароль' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Неверный email или пароль' });

    const payload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      canViewFinances: user.canViewFinances,
      canEdit: user.canEdit
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: payload });
  });
});

// Получить всех пользователей (Только для директора)
router.get('/users', authenticateToken, requireDirector, (req, res) => {
  db.all(`SELECT id, name, email, role, canViewFinances, canEdit FROM users`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    res.json(rows);
  });
});

// Обновить роль/права пользователя (Только для директора)
router.put('/users/:id', authenticateToken, requireDirector, (req, res) => {
  const { role, canViewFinances, canEdit } = req.body;
  const { id } = req.params;

  db.run(
    `UPDATE users SET role = ?, canViewFinances = ?, canEdit = ? WHERE id = ?`,
    [role, canViewFinances ? 1 : 0, canEdit ? 1 : 0, id],
    function (err) {
      if (err) return res.status(500).json({ error: 'Ошибка обновления' });
      res.json({ success: true });
    }
  );
});

// Удалить пользователя (Только для директора)
router.delete('/users/:id', authenticateToken, requireDirector, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM users WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: 'Ошибка удаления' });
    res.json({ success: true });
  });
});

module.exports = router;
