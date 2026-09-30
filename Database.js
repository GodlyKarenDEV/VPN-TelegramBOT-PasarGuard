const mysql = require('mysql2/promise');
const crypto = require('crypto');
require('dotenv').config();

// استفاده از کلید ۳۲ بایتی متقارن از متغیر محیطی با فال‌بک امن ۳۲ بایتی
const rawKey = process.env.ENCRYPTION_KEY || 'SecretEncryptionKeyForCrypto32Ch';
const ENCRYPTION_KEY = Buffer.from(rawKey.padEnd(32, '0').slice(0, 32));
const IV_LENGTH = 12;

function encrypt(text) {
    if (!text) return text;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text.toString(), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + encrypted + ':' + authTag;
}

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
        return "خطا در رمزگشایی";
    }
}

// ساخت Pool اتصالات MySQL با تنظیمات از فایل .env
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'telegram_bot',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function addColumnIfNotExists(connection, table, column, definition) {
    try {
        const [cols] = await connection.query('SHOW COLUMNS FROM ' + table + ' LIKE ?', [column]);
        if (cols.length === 0) {
            await connection.query('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
        }
    } catch (err) {
        console.error('خطا در افزودن ستون ' + column + ' به جدول ' + table + ':', err.message);
    }
}

// اتصال و بررسی صحت ساختار جداول دیتابیس
async function connectDB() {
    let connection;
    try {
        connection = await pool.getConnection();

        await connection.query('CREATE TABLE IF NOT EXISTS system_status (is_initialized BOOLEAN DEFAULT true)');

        await connection.query('CREATE TABLE IF NOT EXISTS users (' +
            'id INT AUTO_INCREMENT PRIMARY KEY,' +
            'telegram_id VARCHAR(255) UNIQUE,' +
            'username VARCHAR(255),' +
            'wallet_balance INT DEFAULT 0,' +
            'role VARCHAR(50) DEFAULT "user",' +
            'referred_by VARCHAR(255) DEFAULT NULL,' +
            'referral_count INT DEFAULT 0,' +
            'claimed_gift TINYINT(1) DEFAULT 0,' +
            'has_used_freetest TINYINT(1) DEFAULT 0,' +
            'encrypted_data TEXT,' +
            'joined_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
        ')');

        await connection.query('CREATE TABLE IF NOT EXISTS configs (' +
            'id INT AUTO_INCREMENT PRIMARY KEY,' +
            'plan_type VARCHAR(50),' +
            'title VARCHAR(255),' +
            'volume INT,' +
            'users_count INT,' +
            'duration_days INT,' +
            'price INT,' +
            'status VARCHAR(50) DEFAULT "active"' +
        ')');

        await connection.query('CREATE TABLE IF NOT EXISTS discounts (' +
            'id INT AUTO_INCREMENT PRIMARY KEY,' +
            'code VARCHAR(50) UNIQUE,' +
            'amount INT,' +
            'discount_type VARCHAR(20) DEFAULT "fixed",' +
            'plan_id INT DEFAULT NULL,' +
            'used_by TEXT,' +
            'expires_at DATETIME DEFAULT NULL,' +
            'status VARCHAR(50) DEFAULT "active"' +
        ')');

        await connection.query('CREATE TABLE IF NOT EXISTS orders (' +
            'id INT AUTO_INCREMENT PRIMARY KEY,' +
            'telegram_id VARCHAR(255),' +
            'order_type VARCHAR(50) DEFAULT "config",' +
            'plan_id INT,' +
            'amount INT,' +
            'status VARCHAR(50),' +
            'sub_name VARCHAR(255),' +
            'sub_link TEXT,' +
            'receipt_file_id TEXT DEFAULT NULL,' +
            'warn_vol TINYINT DEFAULT 0,' +
            'warn_time TINYINT DEFAULT 0,' +
            'created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP' +
        ')');

        await connection.query('CREATE TABLE IF NOT EXISTS settings (' +
            'setting_key VARCHAR(100) PRIMARY KEY,' +
            'setting_value TEXT' +
        ')');

        await addColumnIfNotExists(connection, 'users', 'referred_by', "VARCHAR(255) DEFAULT NULL");
        await addColumnIfNotExists(connection, 'users', 'referral_count', "INT DEFAULT 0");
        await addColumnIfNotExists(connection, 'users', 'claimed_gift', "TINYINT(1) DEFAULT 0");
        await addColumnIfNotExists(connection, 'users', 'has_used_freetest', "TINYINT(1) DEFAULT 0");
        await addColumnIfNotExists(connection, 'discounts', 'discount_type', "VARCHAR(20) DEFAULT 'fixed'");
        await addColumnIfNotExists(connection, 'discounts', 'plan_id', "INT DEFAULT NULL");
        await addColumnIfNotExists(connection, 'discounts', 'used_by', "TEXT");
        await addColumnIfNotExists(connection, 'discounts', 'expires_at', "DATETIME DEFAULT NULL");
        await addColumnIfNotExists(connection, 'orders', 'order_type', "VARCHAR(50) DEFAULT 'config'");
        await addColumnIfNotExists(connection, 'orders', 'warn_vol', "TINYINT DEFAULT 0");
        await addColumnIfNotExists(connection, 'orders', 'warn_time', "TINYINT DEFAULT 0");

        // پاکسازی یک‌باره موجودی کاربران و سفارشات پیشین
        const [resetCheck] = await connection.query("SELECT setting_value FROM settings WHERE setting_key = 'initial_reset_v3'");
        if (resetCheck.length === 0) {
            await connection.query("UPDATE users SET wallet_balance = 0");
            await connection.query("DELETE FROM orders");
            await connection.query("INSERT INTO settings (setting_key, setting_value) VALUES ('initial_reset_v3', '1')");
            console.log("تمامی موجودی‌های کیف پول و سفارشات پیشین با موفقیت پاکسازی و ریست شدند.");
        }

        console.log("اتصال و ساختار دیتابیس با موفقیت تایید شد.");
    } catch (error) {
        console.error("خطا در اتصال به دیتابیس:", error.message);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

module.exports = { connectDB, pool, encrypt, decrypt };