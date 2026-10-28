/**
 * =============================================================
 * Database.js - ماژول مدیریت پایگاه داده MySQL و رمزنگاری داده‌ها
 * =============================================================
 * این ماژول وظیفه برقراری ارتباط با MySQL، ساخت خودکار جداول موردنیاز،
 * اعمال تغییرات ساختاری (Migrations) و رمزنگاری/رمزگشایی داده‌های حساس را دارد.
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');
require('dotenv').config();

// =============================================================
// ۱. پیکربندی ماژول رمزنگاری داده‌ها (AES-256-GCM)
// =============================================================

// دریافت کلید رمزنگاری از متغیرهای محیطی و تنظیم طول دقیق ۳۲ بایت
const rawKey = process.env.ENCRYPTION_KEY || 'DefaultSecretEncryptionKey32Chars';
const ENCRYPTION_KEY = Buffer.from(rawKey.padEnd(32, '0').slice(0, 32));
const IV_LENGTH = 12; // طول بردار مقداردهی اولیه استاندارد برای GCM

/**
 * رمزنگاری متقارن رشته ورودی با الگوریتم امن AES-256-GCM
 * @param {string|number} text - متن آشکار ورودی
 * @returns {string|null} رشته رمزنگاری شده با فرمت (IV:Ciphertext:AuthTag)
 */
function encrypt(text) {
    if (!text && text !== 0) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        let encrypted = cipher.update(text.toString(), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return iv.toString('hex') + ':' + encrypted + ':' + authTag;
    } catch (err) {
        console.error('[Database.js] خطا در رمزنگاری داده:', err.message);
        return text;
    }
}

/**
 * رمزگشایی رشته رمزنگاری شده
 * @param {string} text - رشته رمزنگاری شده با فرمت ساختاریافته
 * @returns {string} متن آشکار اولیه
 */
function decrypt(text) {
    if (!text) return text;
    try {
        const textParts = text.split(':');
        if (textParts.length !== 3) return text; 
        const iv = Buffer.from(textParts[0], 'hex');
        const encryptedText = Buffer.from(textParts[1], 'hex');
        const authTag = Buffer.from(textParts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        return "خطا در رمزگشایی داده";
    }
}

// =============================================================
// ۲. استخر اتصالات MySQL (Connection Pool)
// =============================================================

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'telegram_bot',
    waitForConnections: true,
    connectionLimit: 15, // حداکثر تعداد اتصالات هم‌زمان
    queueLimit: 0
});

/**
 * بررسی و افزودن ستون جدید به جدول در صورت عدم وجود (Safe Migration)
 * @param {object} connection - شیء اتصال پایگاه داده
 * @param {string} table - نام جدول
 * @param {string} column - نام ستون
 * @param {string} definition - نوع داده و محدودیت‌های ستون
 */
async function addColumnIfNotExists(connection, table, column, definition) {
    try {
        const [cols] = await connection.query('SHOW COLUMNS FROM ' + table + ' LIKE ?', [column]);
        if (cols.length === 0) {
            await connection.query('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
        }
    } catch (err) {
        console.error(`[Database.js] خطا در افزودن ستون ${column} به جدول ${table}:`, err.message);
    }
}

// =============================================================
// ۳. راه‌اندازی و مقداردهی اولیه پایگاه داده
// =============================================================

async function connectDB() {
    let connection;
    try {
        connection = await pool.getConnection();

        // ۱. جدول بررسی وضعیت کلی سیستم
        await connection.query('CREATE TABLE IF NOT EXISTS system_status (is_initialized BOOLEAN DEFAULT true)');

        // ۲. جدول کاربران (نگهداری اطلاعات حساب، موجودی کیف پول و رفرال)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                wallet_balance BIGINT DEFAULT 0,
                role ENUM('user', 'admin') DEFAULT 'user',
                referred_by BIGINT DEFAULT NULL,
                referral_count INT DEFAULT 0,
                claimed_gift TINYINT(1) DEFAULT 0,
                has_used_freetest TINYINT(1) DEFAULT 0,
                encrypted_data TEXT,
                joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // ۳. جدول پلن‌ها و کانفیگ‌ها
        await connection.query(`
            CREATE TABLE IF NOT EXISTS configs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                plan_type ENUM('volume', 'unlimited') NOT NULL,
                title VARCHAR(255) NOT NULL,
                volume INT DEFAULT 0,
                users_count INT DEFAULT 1,
                duration_days INT NOT NULL,
                price BIGINT NOT NULL,
                status ENUM('active', 'inactive') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // ۴. جدول کدهای تخفیف
        await connection.query(`
            CREATE TABLE IF NOT EXISTS discounts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                amount BIGINT NOT NULL,
                discount_type VARCHAR(20) DEFAULT 'percent',
                plan_id INT DEFAULT NULL,
                used_by TEXT,
                expires_at DATETIME DEFAULT NULL,
                status ENUM('active', 'expired') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // ۵. جدول سفارشات و تراکنش‌ها (خرید، تمدید و شارژ کیف پول)
        await connection.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegram_id BIGINT NOT NULL,
                order_type VARCHAR(50) DEFAULT 'config',
                plan_id INT NOT NULL,
                amount BIGINT NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                sub_name VARCHAR(255),
                sub_link TEXT,
                receipt_file_id TEXT DEFAULT NULL,
                receipt_text TEXT DEFAULT NULL,
                warn_vol TINYINT DEFAULT 0,
                warn_time TINYINT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // ۶. جدول درخواست‌های تسویه حساب و برداشت وجه کاربران
        await connection.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegram_id BIGINT NOT NULL,
                amount BIGINT NOT NULL,
                card_or_sheba VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
                admin_note TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // ۷. جدول تنظیمات سراسری ربات
        await connection.query(`
            CREATE TABLE IF NOT EXISTS settings (
                setting_key VARCHAR(100) PRIMARY KEY,
                setting_value TEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // اعمال مایگریشن‌ها برای دیتابیس‌های موجود
        await addColumnIfNotExists(connection, 'users', 'referred_by', "BIGINT DEFAULT NULL");
        await addColumnIfNotExists(connection, 'users', 'referral_count', "INT DEFAULT 0");
        await addColumnIfNotExists(connection, 'users', 'claimed_gift', "TINYINT(1) DEFAULT 0");
        await addColumnIfNotExists(connection, 'users', 'has_used_freetest', "TINYINT(1) DEFAULT 0");
        await addColumnIfNotExists(connection, 'orders', 'order_type', "VARCHAR(50) DEFAULT 'config'");
        await addColumnIfNotExists(connection, 'orders', 'receipt_text', "TEXT DEFAULT NULL");
        await addColumnIfNotExists(connection, 'orders', 'warn_vol', "TINYINT DEFAULT 0");
        await addColumnIfNotExists(connection, 'orders', 'warn_time', "TINYINT DEFAULT 0");

        // تنظیم مقدار پیش‌فرض لحن ربات در جدول settings
        const [existingTone] = await connection.query('SELECT setting_value FROM settings WHERE setting_key = "bot_tone"');
        if (existingTone.length === 0) {
            await connection.query('INSERT INTO settings (setting_key, setting_value) VALUES ("bot_tone", "friendly")');
        }

        // تنظیم متن راهنمای اتصال پیش‌فرض در صورت عدم وجود
        const [existingGuide] = await connection.query('SELECT setting_value FROM settings WHERE setting_key = "connection_guide"');
        if (existingGuide.length === 0) {
            const defaultGuide = '📱 **راهنمای اتصال به سرور:**\n' +
                '۱. نرم‌افزار مورد نیاز سیستم‌عامل خود (v2rayNG برای اندروید / Streisand برای iOS / v2rayN برای ویندوز) را نصب کنید.\n' +
                '۲. لینک ساب‌اسکریپشن خریداری شده را کپی کرده و در برنامه وارد نمایید.\n' +
                '۳. اشتراک را بروزرسانی کرده و متصل شوید.';
            await connection.query('INSERT INTO settings (setting_key, setting_value) VALUES ("connection_guide", ?)', [defaultGuide]);
        }

        console.log("✅ [Database.js] پایگاه داده با موفقیت متصل و ساختار جداول تایید شد.");
    } catch (error) {
        console.error("❌ [Database.js] خطا در اتصال به پایگاه داده:", error.message);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

module.exports = {
    connectDB,
    initDatabase: connectDB,
    pool,
    encrypt,
    decrypt
};