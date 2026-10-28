<div align="center">

# 🤖 TelegramBot-BB (v2.0.0)

[![Telegram Bot](https://img.shields.io/badge/Bot-@Bv2ray_Bot-2CA5E0?logo=telegram&logoColor=white)](https://t.me/Bv2ray_Bot)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/Database-MySQL-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com/)
[![Panel](https://img.shields.io/badge/Panel-Pasargad_v5.4.1-orange)](#)
[![Status](https://img.shields.io/badge/Status-Active-brightgreen.svg)](#)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](#)

یک ربات فروشگاهی و مدیریتی هوشمند تلگرام متصل به پنل پاسارگاد (v5.4.1) با دیتابیس MySQL و رابط کاربری فارسی.

👉 **[ورود به ربات تلگرام (@Bv2ray_Bot)](https://t.me/Bv2ray_Bot)** 👈

</div>

---

## 📌 قابلیت‌های کلیدی

- ⚡️ **اتصال هوشمند به پنل پاسارگاد:** دریافت خودکار شناسه‌های گروه فعال (`group_ids`) و رفع کامل خطای `Group not found`.
- 📊 **۱۲ پلن فروش متنوع:** ۳ پلن نامحدود و ۹ پلن حجمی با امکان ویرایش قیمت‌ها به تومان در پنل ادمین.
- 💰 **کیف پول هوشمند:** شارژ حساب به صورت کارت‌به‌کارت با مبالغ پیش‌فرض یا دلخواه، تایید واریزی توسط ادمین و پیش‌فاکتور پرداخت.
- 🎁 **تست رایگان ۱۵ دقیقه‌ای:** ساخت آنی اشتراک تست و حذف خودکار کانفیگ منقضی‌شده از پنل پس از پایان زمان.
- 🔗 **سیستم رفرال و پاداش:** شمارش خودکار دعوت‌ها و اعطای پلن نامحدود ۷ روزه پس از ثبت ۳ کاربر جدید.
- 🎫 **کدهای تخفیف زمان‌دار:** تعریف تخفیف‌های درصدی یا تومانی با مهلت استفاده مشخص بر حسب روز.
- 🛡 **امنیت بالا:** رمزنگاری متقارن داده‌ها بر پایه الگوریتم `AES-256-GCM` و ایگنور کردن فایل‌های محرمانه با `.gitignore`.
- ⏱ **پایش خودکار (Cron Monitoring):** بررسی وضعیت اشتراک‌ها و ارسال هشدار خودکار اتمام حجم (زیر ۱۰٪) و انقضای زمان (کمتر از ۳ روز).

---

## 🛠 پیش‌نیازها

- **Node.js** نسخه ۱۸ یا بالاتر
- سرور دیتابیس **MySQL** یا **MariaDB**
- دسترسی به **پنل پاسارگاد (Pasargad Panel v5.4.1)**
- توکن ربات از طریق [@BotFather](https://t.me/BotFather)

---

## 🚀 راهنمای جامع نصب و پیکربندی پروژه

### ۱. ساخت ربات تلگرام
- در تلگرام وارد ربات [@BotFather](https://t.me/BotFather) شوید و دستور `/newbot` را ارسال کنید.
- نام و یوزرنیم ربات را تعیین کرده و توکن دریافتی (API Token) را کپی کنید.
- کانال تلگرام خود را ایجاد کرده و ربات را به عنوان مدیر (Admin) در آن عضو کنید تا قفل جوین فعال شود.

### ۲. کلون مخزن و نصب پکیج‌ها
ترمینال سرور را باز کرده و دستورات زیر را وارد کنید:
```bash
git clone [https://github.com/RezaRasti79/TelegramBot-BB.git](https://github.com/RezaRasti79/TelegramBot-BB.git)
cd TelegramBot-BB
npm install
```

### ۳. آماده‌سازی دیتابیس MySQL
دیتابیس پروژه را در MySQL بسازید (جداول به صورت خودکار در استارت اول ساخته می‌شوند):
```sql
CREATE DATABASE IF NOT EXISTS godly950_manuel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### ۴. تنظیم فایل متغیرهای محیطی (`.env`)
فایل `.env` را در ریشه اصلی پروژه ساخته و اطلاعات زیر را در آن وارد کنید:
```env
BOT_TOKEN=YOUR_BOT_TOKEN_HERE
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_db_user
DB_NAME=godly950_manuel
DB_PASS=your_db_password
ENCRYPTION_KEY=RezaVPNSecretKeyForCrypto1234567
CHANNEL_ID=@B312V2ray
PANEL_URL=https://your-panel-domain:8000
PANEL_USER=your_panel_username
PANEL_PASS=your_panel_password
PANEL_GROUP_IDS=2
```

### ۵. راه‌اندازی و اجرای ربات
اجرای آزمایشی در ترمینال:
```bash
node Bot.js
```

اجرای دائمی و بدون قطعی با PM2 روی سرور:
```bash
npm install -g pm2
pm2 start Bot.js --name "bv2ray-bot"
pm2 save
pm2 startup
```

---

## 📁 ساختار ماژولار پروژه

```text
├── Bot.js          # هسته اصلی، پردازش پیام‌ها، کالبک‌ها و جاب‌های مانیتورینگ
├── Admin.js        # پنل مدیریت، داشبوردها، تنظیمات پلن‌ها و کدهای تخفیف
├── User.js         # فرایند خرید، پیش‌فاکتورها، تراکنش‌ها و شارژ کیف پول
├── PanelApi.js     # توابع ارتباطی و تعامل با API پنل پاسارگاد
├── Database.js     # اتصال به MySQL، تولید جداول و توابع رمزنگاری
├── .gitignore      # جلوگیری از انتشار فایل‌های حساس و پوشه node_modules
└── package.json    # تعریف پکیج‌ها و متادیتای پروژه
```

---

## 👨‍💻 پشتیبانی

در صورت وجود هرگونه سوال یا نیاز به پشتیبانی فنی:
- ارتباط در تلگرام: [@Karenggr](https://t.me/Karenggr)
