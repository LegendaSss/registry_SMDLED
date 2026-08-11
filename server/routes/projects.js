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

function deleteFileSafely(filename) {
  if (!filename) return;
  const filePath = path.join(__dirname, '..', 'uploads', filename);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Ошибка при удалении файла:', filename, err);
    }
  });
}

function logAudit(projectId, userEmail, action, details) {
  const id = generateUUID();
  const timestamp = new Date().toISOString();
  db.run(
    `INSERT INTO audit_logs (id, projectId, userEmail, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, projectId, userEmail, action, details, timestamp],
    (err) => { if (err) console.error('Ошибка записи аудита:', err); }
  );
}

// Получить историю проекта (Только директор)
router.get('/:id/audit', authenticateToken, requireDirector, (req, res) => {
  const { id } = req.params;
  db.all(`SELECT * FROM audit_logs WHERE projectId = ? ORDER BY timestamp DESC`, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Ошибка БД' });
    res.json(rows);
  });
});

// Получить все активные проекты (Серверная пагинация и Поиск)
router.get('/', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;
  const search = req.query.search || '';
  const sortBy = req.query.sortBy || 'createdAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const paymentStatus = req.query.paymentStatus || '';
  const projectStatus = req.query.projectStatus || '';
  const offset = (page - 1) * limit;

  const allowedSortCols = ['mop', 'rp', 'name', 'paymentStatus', 'projectStatus', 'signDate', 'deadline', 'transferDate', 'clientContact', 'clientName', 'revenue', 'plannedMarginRub', 'plannedMarginPct', 'actualMarginRub', 'actualMarginPct', 'marginDiff', 'createdAt', 'closeDate'];
  const actualSortBy = allowedSortCols.includes(sortBy) ? sortBy : 'createdAt';

  let whereClause = 'WHERE isDeleted = 0';
  const params = [];

  if (search) {
    whereClause += ` AND (name LIKE ? OR clientName LIKE ? OR mop LIKE ? OR rp LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (paymentStatus) {
    whereClause += ` AND paymentStatus = ?`;
    params.push(paymentStatus);
  }

  if (projectStatus) {
    whereClause += ` AND projectStatus = ?`;
    params.push(projectStatus);
  }

  const countQuery = `SELECT COUNT(*) as count FROM projects ${whereClause}`;
  const dataQuery = `SELECT * FROM projects ${whereClause} ORDER BY ${actualSortBy} ${sortOrder} LIMIT ? OFFSET ?`;
  
  db.get(countQuery, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: 'Ошибка подсчета' });
    
    const total = countRow.count;
    
    db.all(dataQuery, [...params, limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Ошибка получения данных' });

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

      res.json({ data: rows, total });
    });
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
    parseFloat(p.revenue) || 0, parseFloat(p.plannedMarginRub) || 0, parseFloat(p.plannedMarginPct) || 0, p.calcLink, p.updLink, p.closeDate,
    parseFloat(p.actualMarginRub) || 0, parseFloat(p.actualMarginPct) || 0, parseFloat(p.marginDiff) || 0, new Date().toISOString(), req.user.email
  ], function (err) {
    if (err) return res.status(500).json({ error: 'Ошибка при создании проекта' });
    
    logAudit(id, req.user.email, 'СОЗДАН', 'Проект успешно создан');
    res.status(201).json({ id, message: 'Проект успешно создан' });
  });
});

// Обновить проект
router.put('/:id', authenticateToken, requireEditRights, upload.fields([{ name: 'contractFile', maxCount: 1 }, { name: 'signedContractFile', maxCount: 1 }]), (req, res) => {
  const { id } = req.params;
  const p = req.body;

  db.get(`SELECT * FROM projects WHERE id = ?`, [id], (err, row) => {
    if (err || !row) return res.status(500).json({ error: 'Проект не найден' });

    let contractFileName = p.contractFileName;
    if (req.files['contractFile']) {
      contractFileName = req.files['contractFile'][0].filename;
      deleteFileSafely(row.contractFileName);
    }

    let signedContractFileName = p.signedContractFileName;
    if (req.files['signedContractFile']) {
      signedContractFileName = req.files['signedContractFile'][0].filename;
      deleteFileSafely(row.signedContractFileName);
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
      parseFloat(p.revenue) || 0, parseFloat(p.plannedMarginRub) || 0, parseFloat(p.plannedMarginPct) || 0, p.calcLink, p.updLink, p.closeDate,
      parseFloat(p.actualMarginRub) || 0, parseFloat(p.actualMarginPct) || 0, parseFloat(p.marginDiff) || 0, id
    ], function (err) {
      if (err) return res.status(500).json({ error: 'Ошибка при обновлении проекта' });

      // Подготовка деталей аудита
      const changes = [];
      if (row.revenue !== (parseFloat(p.revenue) || 0)) changes.push(`Выручка: ${row.revenue} -> ${p.revenue}`);
      if (row.projectStatus !== p.projectStatus) changes.push(`Статус: ${p.projectStatus}`);
      if (row.paymentStatus !== p.paymentStatus) changes.push(`Оплата: ${p.paymentStatus}`);
      if (req.files['contractFile']) changes.push(`Загружен новый Договор`);
      if (req.files['signedContractFile']) changes.push(`Загружен подписанный Договор`);
      
      const details = changes.length > 0 ? changes.join(', ') : 'Обновлены текстовые поля';
      logAudit(id, req.user.email, 'ИЗМЕНЕН', details);

      res.json({ success: true, message: 'Проект обновлен' });
    });
  });
});

// Удалить проект (Мягкое удаление - Только директор)
router.delete('/:id', authenticateToken, requireDirector, (req, res) => {
  const { id } = req.params;
  
  db.run(`UPDATE projects SET isDeleted = 1 WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: 'Ошибка при удалении' });
    
    logAudit(id, req.user.email, 'УДАЛЕН', 'Проект отправлен в корзину');
    res.json({ success: true, message: 'Проект отправлен в корзину' });
  });
});

// Генерация одноразовой защищенной ссылки (живет 1 минуту)
router.get('/generate-download/:filename', authenticateToken, (req, res) => {
  const { filename } = req.params;
  const downloadToken = jwt.sign(
    { filename, email: req.user.email }, 
    JWT_SECRET, 
    { expiresIn: '1m' }
  );

  res.json({ 
    url: `/api/projects/download/${encodeURIComponent(filename)}?t=${downloadToken}` 
  });
});

// Физическая отдача файла по одноразовой ссылке
router.get('/download/:filename', (req, res) => {
  const token = req.query.t;
  if (!token) return res.status(403).send('Отсутствует токен доступа. Доступ запрещен.');

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send('Ссылка устарела или недействительна. Вернитесь в реестр и нажмите на файл еще раз.');
    if (decoded.filename !== req.params.filename) return res.status(403).send('Неверный файл.');

    const filePath = path.join(__dirname, '..', 'uploads', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Файл не найден на сервере (возможно, был удален).');

    res.sendFile(filePath);
  });
});

module.exports = router;
