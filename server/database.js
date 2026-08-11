const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.resolve(__dirname, 'registry.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Ошибка подключения к базе данных:', err.message);
  } else {
    console.log('Подключено к базе данных SQLite.');
  }
});

function initDB() {
  db.serialize(() => {
    // Таблица пользователей
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      role TEXT DEFAULT 'viewer',
      canViewFinances BOOLEAN DEFAULT 0,
      canEdit BOOLEAN DEFAULT 0
    )`);

    // Таблица проектов
    db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      mop TEXT,
      rp TEXT,
      name TEXT NOT NULL,
      bitrixLink TEXT,
      paymentStatus TEXT,
      projectStatus TEXT,
      signDate TEXT,
      deadline TEXT,
      transferDate TEXT,
      contractLink TEXT,
      contractFileName TEXT,
      signedContractLink TEXT,
      signedContractFileName TEXT,
      clientContact TEXT,
      clientName TEXT,
      revenue REAL DEFAULT 0,
      plannedMarginRub REAL DEFAULT 0,
      plannedMarginPct REAL DEFAULT 0,
      calcLink TEXT,
      updLink TEXT,
      closeDate TEXT,
      actualMarginRub REAL DEFAULT 0,
      actualMarginPct REAL DEFAULT 0,
      marginDiff REAL DEFAULT 0,
      createdAt TEXT,
      createdBy TEXT
    )`);

    // Миграции (добавление новых колонок, если их нет)
    db.run("ALTER TABLE projects ADD COLUMN isDeleted BOOLEAN DEFAULT 0", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN isVerified BOOLEAN DEFAULT 0", (err) => {});
    db.run("ALTER TABLE users ADD COLUMN verificationToken TEXT", (err) => {});

    // Создание директора по умолчанию, если его нет
    db.get("SELECT * FROM users WHERE email = 'director@smdled.ru'", async (err, row) => {
      if (!row) {
        const hash = await bcrypt.hash('admin123', 10);
        db.run(`INSERT INTO users (id, name, email, passwordHash, role, canViewFinances, canEdit, isVerified) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                ['director-uuid-0000', 'Директор', 'director@smdled.ru', hash, 'director', 1, 1, 1]);
        console.log('Пользователь по умолчанию (director@smdled.ru / admin123) создан.');
      } else {
        // Убедимся, что старый директор верифицирован
        db.run("UPDATE users SET isVerified = 1 WHERE email = 'director@smdled.ru'");
      }
    });
  });
}

module.exports = { db, initDB };
