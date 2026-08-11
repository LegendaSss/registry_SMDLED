const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { db } = require('../database');
const { authenticateToken, requireDirector, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// Настройка почтового сервера (Mail.ru)
const transporter = nodemailer.createTransport({
  host: 'smtp.mail.ru',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'smdled-registr@mail.ru',
    pass: process.env.SMTP_PASS || 'placeholder_password'
  }
});

function generateUUID() {
  return crypto.randomUUID();
}

// Регистрация
router.post('/register', async (req, res) => {
  let { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Заполните все поля.' });

  email = email.toLowerCase().trim();

  // Валидация Email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Неверный формат email.' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const id = generateUUID();
    const verificationToken = crypto.randomBytes(32).toString('hex');
    
    db.run(
      `INSERT INTO users (id, name, email, passwordHash, role, canViewFinances, canEdit, isVerified, verificationToken) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, email, hash, 'viewer', 0, 0, 0, verificationToken],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: 'Пользователь с таким email уже существует.' });
          }
          return res.status(500).json({ error: 'Ошибка базы данных' });
        }
        
        // Попытка отправить письмо
        const verifyUrl = `https://smdled-registr.ru/api/auth/verify/${verificationToken}`;
        const mailOptions = {
          from: `"СМДЛЕД Реестр" <${process.env.SMTP_USER || 'smdled-registr@mail.ru'}>`,
          to: email,
          subject: 'Подтверждение регистрации',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background: #f9f9f9; border-radius: 8px;">
              <h2 style="color: #3b82f6;">Добро пожаловать в СМДЛЕД Реестр!</h2>
              <p>Здравствуйте, ${name}!</p>
              <p>Для завершения регистрации и получения доступа к системе, пожалуйста, подтвердите ваш email, нажав на кнопку ниже:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${verifyUrl}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Подтвердить Email</a>
              </div>
              <p style="font-size: 12px; color: #777;">Если вы не регистрировались в системе, просто проигнорируйте это письмо.</p>
            </div>
          `
        };

        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error('Ошибка отправки письма:', error);
            // Если почта не настроена, мы просто логируем ошибку, но говорим пользователю что все ок
          }
        });

        // Возвращаем не токен (так как нельзя сразу пускать), а статус success
        res.status(201).json({ message: 'Регистрация успешна. Проверьте вашу почту для подтверждения аккаунта.', requireVerification: true });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Подтверждение почты
router.get('/verify/:token', (req, res) => {
  const { token } = req.params;
  
  db.get(`SELECT * FROM users WHERE verificationToken = ?`, [token], (err, user) => {
    if (err || !user) return res.status(400).send('Недействительная или устаревшая ссылка подтверждения.');
    
    db.run(`UPDATE users SET isVerified = 1, verificationToken = NULL WHERE id = ?`, [user.id], (err) => {
      if (err) return res.status(500).send('Ошибка при подтверждении.');
      
      // Показываем красивую страницу об успехе
      res.send(`
        <html>
          <body style="font-family: Arial; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0a0a0f; color: white; text-align: center;">
            <div>
              <h1 style="color: #10b981;">Email подтвержден! 🎉</h1>
              <p>Ваша учетная запись успешно активирована.</p>
              <a href="https://smdled-registr.ru" style="color: #3b82f6; text-decoration: none; font-weight: bold; border: 1px solid #3b82f6; padding: 10px 20px; border-radius: 5px; display: inline-block; margin-top: 20px;">Перейти к входу</a>
            </div>
          </body>
        </html>
      `);
    });
  });
});

// Авторизация
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль' });

  db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase()], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
    if (!user) return res.status(400).json({ error: 'Неверный email или пароль' });

    // Проверка на подтверждение (пропускаем директора, у него isVerified = 1 по дефолту)
    if (user.isVerified === 0) {
      return res.status(403).json({ error: 'Email не подтвержден. Проверьте вашу почту.' });
    }

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
  db.all(`SELECT id, name, email, role, canViewFinances, canEdit, isVerified FROM users`, [], (err, rows) => {
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

// Изменение профиля (Имя и Пароль)
router.put('/profile', authenticateToken, async (req, res) => {
  const { name, newPassword } = req.body;
  const user = req.user;

  try {
    if (name) {
      db.run(`UPDATE users SET name = ? WHERE id = ?`, [name, user.id]);
    }
    if (newPassword) {
      if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
      const hash = await bcrypt.hash(newPassword, 10);
      db.run(`UPDATE users SET passwordHash = ? WHERE id = ?`, [hash, user.id]);
    }
    res.json({ success: true, message: 'Профиль успешно обновлен' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка БД' });
  }
});

// Восстановление пароля (Запрос)
router.post('/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Введите email' });

  db.get(`SELECT * FROM users WHERE email = ?`, [email.toLowerCase().trim()], (err, user) => {
    if (err || !user) return res.json({ message: 'Если email существует, на него отправлено письмо' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    db.run(`UPDATE users SET verificationToken = ? WHERE id = ?`, [resetToken, user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД' });

      const resetLink = `https://smdled-registr.ru/reset-password.html?token=${resetToken}`;
      const mailOptions = {
        from: '"СМДЛЕД Реестр" <' + (process.env.SMTP_USER || 'smdled-registr@mail.ru') + '>',
        to: user.email,
        subject: 'Восстановление пароля',
        html: `
          <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px;">
            <h2 style="color: #3b82f6;">Восстановление пароля</h2>
            <p>Вы запросили сброс пароля. Если это были не вы, просто проигнорируйте письмо.</p>
            <p>Для создания нового пароля перейдите по ссылке:</p>
            <a href="${resetLink}" style="display: inline-block; padding: 10px 20px; color: white; background: #3b82f6; text-decoration: none; border-radius: 5px;">Сбросить пароль</a>
          </div>
        `
      };

      transporter.sendMail(mailOptions, (error) => {
        if (error) console.error('Email error:', error);
      });

      res.json({ message: 'Если email существует, на него отправлено письмо' });
    });
  });
});

// Сброс пароля (Установка нового)
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Неверные данные' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });

  db.get(`SELECT * FROM users WHERE verificationToken = ?`, [token], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Ссылка устарела или недействительна' });

    const hash = await bcrypt.hash(newPassword, 10);
    db.run(`UPDATE users SET passwordHash = ?, verificationToken = NULL WHERE id = ?`, [hash, user.id], (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД' });
      res.json({ message: 'Пароль успешно изменен' });
    });
  });
});

module.exports = router;
