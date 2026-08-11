require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./database');
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Статические файлы (загруженные документы)
// Доступ к папке uploads теперь закрыт и осуществляется только через API

// Маршруты API
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);

// Базовый маршрут для проверки
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'СМДЛЕД Сервер работает' });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  initDB(); // Инициализация базы данных
});
