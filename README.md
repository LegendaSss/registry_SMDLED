# СМДЛЕД — Полный Реестр Проектов (Server-Side Enterprise Edition)

Современная клиент-серверная веб-платформа (SPA) для ведения учета проектов компании **СМДЛЕД**, управления финансовой маржинальностью, логирования изменений и безопасного администрирования пользователей.

Приложение переведено с локального IndexedDB хранилища на надежную серверную архитектуру с базой данных SQLite, защищенной JWT-авторизацией и обратным проксированием через Nginx на VPS.

---

## 🛠️ Стек технологий

*   **Frontend**: HTML5, Vanilla CSS3 (Glassmorphism, адаптивная верстка, микро-анимации), Vanilla JavaScript (ES6+, Fetch API).
*   **Backend**: Node.js, Express.js (REST API), SQLite3.
*   **Безопасность и сессии**: JSON Web Tokens (JWT), шифрование паролей через `bcrypt` на сервере.
*   **Загрузка файлов**: `multer` (серверное хранение файлов договоров во внутренней закрытой папке `uploads`).
*   **Почтовые отправления**: `nodemailer` (интеграция с SMTP Mail.ru для активации аккаунтов и восстановления паролей).
*   **Экспорт отчетов**: `exceljs` (генерация Excel на сервере), `jspdf` и `jspdf-autotable` (генерация PDF на клиенте).
*   **DevOps / VPS**: Nginx (обратный прокси, Gzip-сжатие, кэширование статики), PM2 (управление процессами Node.js), SSL Let's Encrypt (HTTPS).

---

## 🌟 Основной функционал

### 1. Ролевая модель доступа (RBAC)
*   👑 **Директор (director)**: Полные права на чтение, создание, редактирование и удаление проектов. Доступ к просмотру раздела пользователей, изменению их ролей и доступов к финансам/редактированию. Просмотр полной истории изменений любого проекта (аудит).
*   💼 **Менеджер (manager)**: Чтение проектов. Создание и редактирование проектов, если выдано разрешение `canEdit`. Видит финансовые показатели только при наличии флага `canViewFinances`.
*   👁️ **Наблюдатель (viewer)**: Только просмотр реестра. Финансы скрыты, если не выдан флаг `canViewFinances`. Не имеет доступа к созданию, редактированию или удалению.

### 2. Реестр проектов и CRUD
*   Создание, просмотр, редактирование и мягкое удаление проектов (удаленные проекты помечаются `isDeleted = 1` и скрываются).
*   Строгая валидация полей при сохранении:
    *   *ФИО менеджера/клиента*: только буквы (цифры не принимаются).
    *   *Контакт клиента*: только цифры, знаки `+`, `-`, пробелы и скобки.
    *   *Ссылки (Битрикс, расчет, УПД)*: строгая валидация формата URL.

### 3. Автоматический расчет маржинальности
*   При вводе Выручки и Плановой/Фактической маржи в рублях, система автоматически рассчитывает:
    *   Плановую маржу в % от выручки.
    *   Фактическую маржу в % от выручки.
    *   Разницу маржи в рублях (с визуальной индикацией: зеленая для прибыли, красная для просадки).

### 4. Поиск, сортировка и серверная пагинация
*   **Пагинация**: Постраничный вывод с возможностью выбора количества записей на странице (10, 25, 50, 100).
*   **Поиск с Debounce (400мс)**: Живой поиск по названию проекта, клиенту, МОП или РП. Запросы оптимизированы и не перегружают сервер при вводе.
*   **Серверная сортировка**: Сортировка всей базы данных по любому из столбцов таблицы (по датам, выручке, статусам и т.д.).

### 5. Безопасность файлов
*   Файлы договоров хранятся на сервере в закрытой директории `uploads`, которая **не отдается напрямую веб-сервером**.
*   Для скачивания файла генерируется зашифрованный JWT-токен с временем жизни **1 минута**.
*   Только авторизованный пользователь, кликнув на файл, может инициировать временную ссылку вида `/api/projects/download/filename?t=token` для физического скачивания.

### 6. Аудит изменений (История действий)
*   Любые изменения проектов (создание, смена статуса оплаты, корректировка бюджетов, загрузка новых файлов) фиксируются в таблице `audit_logs`.
*   Директор в один клик по иконке 🕒 может посмотреть подробный таймлайн изменений проекта: кто, когда и что именно изменил.

### 7. Сессионная безопасность
*   Время жизни JWT сессии составляет **30 минут**.
*   За **2 минуты** до окончания сессии пользователю показывается предупреждение вверху экрана: `⏰ Сессия истечет через 2 минуты. Любое действие продлит сессию.`
*   Любая активность пользователя (движение мыши, клик, прокрутка, нажатие клавиш) автоматически перезапускает таймер активности и продлевает токен.

### 8. Экспорт данных
*   **Excel (.xlsx)**: Генерация отчета на сервере с учетом фильтров и прав доступа (для сотрудников без прав на просмотр финансов финансовые колонки в файле будут пустыми).
*   **PDF (.pdf)**: Генерация таблицы на клиенте с автоподгонкой колонок в ландшафтном формате A3.
*   **CSV (.csv)**: Выгрузка с разделителями `;` и корректным UTF-8 BOM для Microsoft Excel.

---

## 🗄️ Схема базы данных (SQLite)

База данных состоит из трех связанных таблиц:

### Таблица `users`
*   `id`: UUID (TEXT, Primary Key)
*   `name`: Имя пользователя (TEXT)
*   `email`: Уникальный Email (TEXT, Unique)
*   `passwordHash`: Хэш пароля bcrypt (TEXT)
*   `role`: Роль `director`/`manager`/`viewer` (TEXT)
*   `canViewFinances`: Доступ к финансам `0`/`1` (INTEGER)
*   `canEdit`: Доступ к редактированию проектов `0`/`1` (INTEGER)
*   `isVerified`: Флаг подтверждения почты `0`/`1` (INTEGER)
*   `verificationToken`: Токен подтверждения / сброса пароля (TEXT)

### Таблица `projects`
*   `id`: UUID (TEXT, Primary Key)
*   `mop`, `rp`, `name`, `bitrixLink`: Текстовые поля проекта
*   `paymentStatus`, `projectStatus`: Статусы проекта и оплаты
*   `signDate`, `deadline`, `transferDate`, `closeDate`: Даты этапов (TEXT, YYYY-MM-DD)
*   `contractLink`, `contractFileName`: Данные договора
*   `signedContractLink`, `signedContractFileName`: Данные подписанного договора
*   `clientContact`, `clientName`: Контакты
*   `revenue`, `plannedMarginRub`, `plannedMarginPct`: Финансовые показатели плана (REAL)
*   `calcLink`, `updLink`: Дополнительные ссылки
*   `actualMarginRub`, `actualMarginPct`, `marginDiff`: Финансовые показатели факта (REAL)
*   `createdAt`, `createdBy`: Метаданные создания
*   `isDeleted`: Мягкое удаление (INTEGER, по умолчанию `0`)

### Таблица `audit_logs`
*   `id`: UUID (TEXT, Primary Key)
*   `projectId`: ID проекта (TEXT)
*   `userEmail`: Email изменившего пользователя (TEXT)
*   `action`: Действие (СОЗДАН/ИЗМЕНЕН/УДАЛЕН) (TEXT)
*   `details`: Детализация изменений (например, `Выручка: 10000 -> 15000`) (TEXT)
*   `timestamp`: Дата-время действия ISO8601 (TEXT)

---

## 🚀 Установка и развертывание

### 1. Локальная разработка

1.  Клонировать репозиторий:
    ```bash
    git clone https://github.com/LegendaSss/registry_SMDLED.git
    cd registry_SMDLED
    ```
2.  Установить зависимости в папке сервера:
    ```bash
    cd server
    npm install
    ```
3.  Создать файл `.env` в директории `server/`:
    ```env
    PORT=5000
    JWT_SECRET=your_super_secret_key_here
    SMTP_USER=smdled-registr@mail.ru
    SMTP_PASS=your_smtp_password
    ```
4.  Запустить локальный сервер:
    ```bash
    npm start
    ```
5.  Открыть в браузере `http://localhost:5000`.

---

### 2. Деплой на VPS (Ubuntu / Debian)

1.  Установить Nginx, Node.js и PM2:
    ```bash
    sudo apt update
    sudo apt install nginx nodejs npm git -y
    sudo npm install pm2 -g
    ```
2.  Настроить проект в `/var/www/registry_SMDLED/` и установить `.env`.
3.  Запустить сервер с помощью PM2:
    ```bash
    cd /var/www/registry_SMDLED/server
    pm2 start server.js --name "registry_SMDLED"
    pm2 save
    pm2 startup
    ```
4.  Сконфигурировать Nginx (файл `/etc/nginx/sites-enabled/smdled`):
    ```nginx
    server {
        listen 80;
        listen 443 ssl;
        server_name smdled-registr.ru www.smdled-registr.ru;

        ssl_certificate /etc/letsencrypt/live/smdled-registr.ru/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/smdled-registr.ru/privkey.pem;

        # Gzip сжатие
        gzip on;
        gzip_types text/plain text/css application/json application/javascript text/xml;
        gzip_min_length 256;
        gzip_vary on;

        root /var/www/registry_SMDLED;
        index index.html;

        # Кэширование статики
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1d;
            add_header Cache-Control "public, immutable";
            try_files $uri =404;
        }

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /api/ {
            proxy_pass http://localhost:5000/api/;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_cache_bypass $http_upgrade;
            client_max_body_size 50M;
        }
    }
    ```
5.  Проверить конфигурацию Nginx и перезагрузить его:
    ```bash
    sudo nginx -t
    sudo systemctl reload nginx
    ```
