const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authenticateToken, requireEditRights, requireDirector, JWT_SECRET } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

function generateUUID() {
  return crypto.randomUUID();
}

// Вспомогательная функция для удаления файла с диска
function deleteFileSafely(filename) {
  if (!filename) return;
  const filePath = path.join(__dirname, '..', 'uploads', filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Ошибка при удалении файла:', filename, err);
    }
  });
}

// Получить все проекты
router.get('/', authenticateToken, (req, res) => {
  db.all(`SELECT * FROM projects ORDER BY createdAt DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Ошибка базы данных' });

    // Очистка финансовых данных для тех, у кого нет прав
    const user = req.user;
    const canView = user.canViewFinances || user.role === 'director';
    
    if (!canView) {
      rows = rows.map(p => ({
        ...p,
        revenue: null,
        plannedMarginRub: null,
        plannedMarginPct: null,
        calcLink: null,
        actualMarginRub: null,
        actualMarginPct: null,
        marginDiff: null
      }));
    }

    res.json(rows);
  });
});

// Создать проект
router.post('/', authenticateToken, requireEditRights, upload.fields([{ name: 'contractFile', maxCount: 1 }, { name: 'signedContractFile', maxCount: 1 }]), (req, res) => {
  const p = req.body;
  const id = generateUUID();
  
  const contractFileName = req.files['contractFile'] ? req.files['contractFile'][0].filename : null;
  const signedContractFileName = req.files['signedContractFile'] ? req.files['signedContractFile'][0].filename : null;

  db.run(`INSERT INTO projects (
    id, mop, rp, name, bitrixLink, paymentStatus, projectStatus, signDate, deadline, transferDate, 
    contractLink, contractFileName, signedContractLink, signedContractFileName, clientContact, clientName, 
    revenue, plannedMarginRub, plannedMarginPct, calcLink, updLink, closeDate, 
    actualMarginRub, actualMarginPct, marginDiff, createdAt, createdBy
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    id, p.mop, p.rp, p.name, p.bitrixLink, p.paymentStatus, p.projectStatus, p.signDate, p.deadline, p.transferDate,
    p.contractLink, contractFileName, p.signedContractLink, signedContractFileName, p.clientContact, p.clientName,
    p.revenue || 0, p.plannedMarginRub || 0, p.plannedMarginPct || 0, p.calcLink, p.updLink, p.closeDate,
    p.actualMarginRub || 0, p.actualMarginPct || 0, p.marginDiff || 0, new Date().toISOString(), req.user.email
  ], function (err) {
    if (err) return res.status(500).json({ error: 'Ошибка при создании проекта' });
    res.status(201).json({ id, message: 'Проект успешно создан' });
  });
});

// Обновить проект
router.put('/:id', authenticateToken, requireEditRights, upload.fields([{ name: 'contractFile', maxCount: 1 }, { name: 'signedContractFile', maxCount: 1 }]), (req, res) => {
  const { id } = req.params;
  const p = req.body;

  // Получаем текущие данные проекта, чтобы узнать старые имена файлов
  db.get(`SELECT contractFileName, signedContractFileName FROM projects WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(500).json({ error: 'Проект не найден' });

    let contractFileName = p.contractFileName; // Приходит с фронтенда если не менялся
    if (req.files['contractFile']) {
      contractFileName = req.files['contractFile'][0].filename;
      deleteFileSafely(row.contractFileName); // Удаляем старый файл
    }

    let signedContractFileName = p.signedContractFileName;
    if (req.files['signedContractFile']) {
      signedContractFileName = req.files['signedContractFile'][0].filename;
      deleteFileSafely(row.signedContractFileName); // Удаляем старый файл
    }

    db.run(`UPDATE projects SET
      mop=?, rp=?, name=?, bitrixLink=?, paymentStatus=?, projectStatus=?, signDate=?, deadline=?, transferDate=?, 
      contractLink=?, contractFileName=?, signedContractLink=?, signedContractFileName=?, clientContact=?, clientName=?, 
      revenue=?, plannedMarginRub=?, plannedMarginPct=?, calcLink=?, updLink=?, closeDate=?, 
      actualMarginRub=?, actualMarginPct=?, marginDiff=?
      WHERE id=?`,
    [
      p.mop, p.rp, p.name, p.bitrixLink, p.paymentStatus, p.projectStatus, p.signDate, p.deadline, p.transferDate,
      p.contractLink, contractFileName, p.signedContractLink, signedContractFileName, p.clientContact, p.clientName,
      p.revenue || 0, p.plannedMarginRub || 0, p.plannedMarginPct || 0, p.calcLink, p.updLink, p.closeDate,
      p.actualMarginRub || 0, p.actualMarginPct || 0, p.marginDiff || 0, id
    ], function (err) {
      if (err) return res.status(500).json({ error: 'Ошибка при обновлении проекта' });
      res.json({ success: true, message: 'Проект обновлен' });
    });
  });
});

// Удалить проект (Только директор)
router.delete('/:id', authenticateToken, requireDirector, (req, res) => {
  const { id } = req.params;
  
  db.get(`SELECT contractFileName, signedContractFileName FROM projects WHERE id = ?`, [id], (err, row) => {
    if (row) {
      deleteFileSafely(row.contractFileName);
      deleteFileSafely(row.signedContractFileName);
    }
    
    db.run(`DELETE FROM projects WHERE id = ?`, [id], function (err) {
      if (err) return res.status(500).json({ error: 'Ошибка при удалении' });
      res.json({ success: true });
    });
  });
});

// Генерация одноразовой защищенной ссылки (живет 1 минуту)
router.get('/generate-download/:filename', authenticateToken, (req, res) => {
  const { filename } = req.params;
  
  // Создаем токен, действительный 1 минуту, содержащий имя файла и email пользователя
  const downloadToken = jwt.sign(
    { filename, email: req.user.email }, 
    JWT_SECRET, 
    { expiresIn: '1m' }
  );

  res.json({ 
    url: `/api/projects/download/${encodeURIComponent(filename)}?t=${downloadToken}` 
  });
});

// Физическая отдача файла по одноразовой ссылке (работает из новой вкладки браузера)
router.get('/download/:filename', (req, res) => {
  const token = req.query.t;
  if (!token) return res.status(403).send('Отсутствует токен доступа. Доступ запрещен.');

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send('Ссылка устарела или недействительна. Вернитесь в реестр и нажмите на файл еще раз.');
    
    // Проверка, что токен был выдан именно для этого файла
    if (decoded.filename !== req.params.filename) {
      return res.status(403).send('Неверный файл.');
    }

    const filePath = path.join(__dirname, '..', 'uploads', req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Файл не найден на сервере (возможно, был удален).');
    }

    // Отдаем файл (браузер покажет PDF внутри вкладки)
    res.sendFile(filePath);
  });
});

module.exports = router;
