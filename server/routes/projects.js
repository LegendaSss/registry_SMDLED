const express = require('express');
const crypto = require('crypto');
const { db } = require('../database');
const { authenticateToken, requireEditRights, requireDirector } = require('../middleware/auth');
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

  // Если были загружены новые файлы, обновляем их имена, иначе оставляем старые
  const contractFileName = req.files['contractFile'] ? req.files['contractFile'][0].filename : p.contractFileName;
  const signedContractFileName = req.files['signedContractFile'] ? req.files['signedContractFile'][0].filename : p.signedContractFileName;

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

// Удалить проект (Только директор)
router.delete('/:id', authenticateToken, requireDirector, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM projects WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: 'Ошибка при удалении' });
    res.json({ success: true });
  });
});

module.exports = router;
