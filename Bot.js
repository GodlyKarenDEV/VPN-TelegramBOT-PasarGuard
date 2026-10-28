/**
 * ====================================================================
 * Bot.js - هسته اجرایی و پردازشگر مرکزی ربات تلگرام
 * ====================================================================
 * وظایف اصلی این ماژول:
 * ۱. اتصال اولیه و مقداردهی پایگاه داده MySQL
 * ۲. راه‌اندازی ربات با متد Long Polling
 * ۳. سیستم هوشمند رفرال و انتساب دائمی معرف در دستور /start
 * ۴. بررسی قفل عضویت اجباری در کانال رسمی
 * ۵. مدیریت سوییچ دسترسی میان پنل مدیریت و کاربری برای سوپرادمین‌ها
 * ۶. هدایت پیام‌ها به ماشین وضعیت (State Machine) و کنترلرها
 * ۷. پایش مداوم (Cron Job) جهت حذف تست‌های ۱ ساعته و ارسال هشدارهای حجم/انقضا
 * ۸. پاسخ‌دهی فوری به Callback Queries جهت آزادسازی انیمیشن لودینگ کلاینت
 */

const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// واردسازی ماژول‌های داخلی پروژه
const { connectDB, pool } = require('./Database');
const { checkChannelMembership, sendUserMenu, handleUserCommands, handleUserCallbacks, handleUserStates } = require('./User');
const { sendAdminMenu, handleAdminCommands, handleAdminCallbacks, handleAdminStates, getSuperAdmins } = require('./Admin');
const { getUserFromPanel, deleteConfigOnPanel } = require('./PanelApi');

// اعتبارسنجی توکن ربات تلگرام
const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ [Bot.js] خطای بحرانی: BOT_TOKEN در فایل .env تعریف نشده است.');
    process.exit(1);
}

// ساخت نمونه ربات تلگرام با فعال‌سازی Polling
const bot = new TelegramBot(token, { polling: true });

// مخازن حافظه موقت (In-Memory) جهت مدیریت گام‌های ورودی کاربران و ادمین‌ها
const adminStates = {}; 
const userStates = {}; 

/**
 * بررسی سطح دسترسی مدیریت برای یک کاربر
 * @param {string} username - نام کاربری تلگرام (بدون @)
 * @param {number|string} chatId - آیدی عددی چت کاربر
 * @returns {Promise<boolean>} آیا کاربر ادمین است یا خیر
 */
async function isUserAdmin(username, chatId) {
    try {
        // ۱. بررسی نقش کاربر در جدول پایگاه داده
        const [rows] = await pool.query('SELECT role FROM users WHERE telegram_id = ?', [chatId]);
        if (rows.length > 0 && rows[0].role === 'admin') return true;
        
        // ۲. بررسی نام کاربری در لیست سوپرادمین‌های فایل .env
        const superAdmins = getSuperAdmins();
        if (username && superAdmins.includes(username.toLowerCase())) return true;
        
        return false;
    } catch (e) {
        console.error('[Bot.js] خطا در ارزیابی سطح دسترسی ادمین:', e.message);
        return false;
    }
}

/**
 * پردازشگر مانیتورینگ خودکار دوره‌ای (هر ۲ دقیقه یک‌بار)
 * پایش انقضای سرویس‌ها، حذف اکانت تست ۱ ساعته و ارسال اخطارهای اتمام حجم/زمان
 */
function startMonitoringTask() {
    setInterval(async () => {
        try {
            const [orders] = await pool.query(
                'SELECT * FROM orders WHERE status = "approved" AND (order_type = "config" OR order_type IS NULL)'
            );
            const now = Math.floor(Date.now() / 1000);

            for (const o of orders) {
                try {
                    const pData = await getUserFromPanel(o.sub_name);
                    if (!pData) continue;

                    const expire = pData.expire || 0;

                    // ۱. مدیریت انقضای پلن تست رایگان ۱ ساعته (حذف خودکار از سرور)
                    if (o.plan_id === -1) {
                        if (expire > 0 && expire <= now) {
                            await deleteConfigOnPanel(o.sub_name);
                            await pool.query('UPDATE orders SET status = "expired" WHERE id = ?', [o.id]);
                            bot.sendMessage(
                                o.telegram_id,
                                `⚠️ مشترک گرامی، مهلت استفاده از اشتراک تست رایگان ۱ ساعته شما (\`${o.sub_name}\`) به پایان رسید و سرویس از سرور حذف گردید.\n\nجهت برقراری مجدد اتصال، می‌توانید از بخش «🚀 خرید کانفیگ» پلن تجاری تهیه فرمایید.`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        }
                        continue; 
                    }

                    // ۲. پایش حجم مصرفی: اخطار در صورت باقی ماندن کمتر از ۱۰٪ حجم کل
                    const totalVol = pData.data_limit || 0;
                    if (totalVol > 0) {
                        const usedVol = pData.used_traffic || 0;
                        const remainingRatio = (totalVol - usedVol) / totalVol;
                        if (remainingRatio <= 0.10 && remainingRatio > 0 && !o.warn_vol) {
                            await pool.query('UPDATE orders SET warn_vol = 1 WHERE id = ?', [o.id]);
                            bot.sendMessage(
                                o.telegram_id,
                                `⚠️ مشترک گرامی، کمتر از ۱۰٪ از حجم مجاز اشتراک شما (\`${o.sub_name}\`) باقی مانده است.\nجهت جلوگیری از قطعی اتصال، نسبت به تمدید آن اقدام فرمایید.`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        }
                    }
                    
                    // ۳. پایش زمان انقضا: اخطار در ۳ روز پایانی یا اعلام قطعی انقضا
                    if (expire > 0) {
                        if (expire <= now) {
                            await pool.query('UPDATE orders SET status = "expired" WHERE id = ?', [o.id]);
                            bot.sendMessage(
                                o.telegram_id,
                                `⚠️ مشترک گرامی، اعتبار زمانی اشتراک \`${o.sub_name}\` شما به پایان رسید.\nجهت فعال‌سازی مجدد، از بخش «تاریخچه تراکنش‌ها» نسبت به تمدید آن اقدام نمایید.`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        } else {
                            const daysLeft = (expire - now) / 86400;
                            if (daysLeft <= 3 && daysLeft > 0 && !o.warn_time) {
                                await pool.query('UPDATE orders SET warn_time = 1 WHERE id = ?', [o.id]);
                                bot.sendMessage(
                                    o.telegram_id,
                                    `⚠️ مشترک گرامی، کمتر از ۳ روز تا انقضای زمان اشتراک \`${o.sub_name}\` شما باقی مانده است.\nپیشنهاد می‌شود جهت استمرار سرویس، آن را تمدید فرمایید.`,
                                    { parse_mode: 'Markdown' }
                                ).catch(() => {});
                            }
                        }
                    }
                } catch (singleOrderErr) {
                    console.error(`[Bot.js] خطا در بررسی وضعیت سفارش #${o.id}:`, singleOrderErr.message);
                }
            }
        } catch (error) {
            console.error('[Bot.js] خطا در اجرای جاب مانیتورینگ دوره‌ای:', error.message);
        }
    }, 2 * 60 * 1000);
}

/**
 * پیکربندی رویدادها و اجرای برنامه
 */
async function startBot() {
    try {
        // اتصال پایگاه داده و استقرار اولیه جداول
        await connectDB();
        console.log("✅ پایگاه داده MySQL متصل و همگام گردید.");
        console.log("🚀 ربات با موفقیت فعال شد و آماده دریافت پیام‌ها می‌باشد.");
        
        // فعال‌سازی تسک پس‌زمینه
        startMonitoringTask();

        // =============================================================
        // شنونده پیام‌های متنی، تصویری و فایل‌ها (bot.on('message'))
        // =============================================================
        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username || "بدون_یوزرنیم";
                const text = msg.text || '';

                // نادیده گرفتن آپدیت‌های خالی از محتوا
                if (!text && !msg.photo && !msg.document) return;

                // مدیریت دستور شروع (/start) و سیستم رفرال هوشمند
                if (text && text.startsWith('/start')) {
                    if (userStates[chatId]) delete userStates[chatId];

                    const parts = text.split(' ');
                    if (parts.length > 1 && parts[1]) {
                        const referrerId = parts[1].trim();
                        const [existingUser] = await pool.query('SELECT id, referred_by FROM users WHERE telegram_id = ?', [chatId]);
                        
                        // انتساب معرف فقط برای اعضای جدید و عدم امکان خود-دعوتی
                        if (existingUser.length === 0 && referrerId !== String(chatId)) {
                            const [referrerExists] = await pool.query('SELECT id FROM users WHERE telegram_id = ?', [referrerId]);
                            if (referrerExists.length > 0) {
                                await pool.query(
                                    'INSERT INTO users (telegram_id, username, referred_by) VALUES (?, ?, ?)',
                                    [chatId, username, referrerId]
                                );
                                await pool.query(
                                    'UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = ?',
                                    [referrerId]
                                );
                                bot.sendMessage(
                                    referrerId,
                                    `🎉 **تبریک! یک کاربر جدید با لینک دعوت شما وارد ربات شد.**\nاز این پس ۱۰٪ از تمامی خریدهای این کاربر به کیف پول شما واریز می‌گردد.`,
                                    { parse_mode: 'Markdown' }
                                ).catch(() => {});
                            }
                        }
                    }

                    // اطمینان از ثبت کاربر در جدول
                    await pool.query('INSERT IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [chatId, username]);

                    const isAdmin = await isUserAdmin(username, chatId);
                    const isMember = await checkChannelMembership(bot, chatId, userId);
                    
                    // بررسی قفل عضویت اجباری
                    if (!isMember) {
                        return bot.sendMessage(
                            chatId,
                            `کاربر گرامی، جهت استفاده از سرویس‌های ربات لطفاً ابتدا در کانال رسمی ما عضو شوید:\n${process.env.CHANNEL_ID || '@Channel'}\n\nسپس روی دکمه زیر کلیک نمایید:`,
                            { reply_markup: { inline_keyboard: [[{ text: 'عضو شدم ✔️', callback_data: 'check_join' }]] } }
                        );
                    }

                    if (isAdmin) {
                        adminStates[chatId] = 'admin';
                        return sendAdminMenu(bot, chatId, username);
                    } else {
                        return sendUserMenu(bot, chatId, false);
                    }
                }

                // ثبت کاربر در دیتابیس در صورت ارسال پیام‌های غیر از /start
                await pool.query('INSERT IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [chatId, username]);

                const isAdmin = await isUserAdmin(username, chatId);
                const superAdmins = getSuperAdmins();
                const isSuperAdmin = username && superAdmins.includes(username.toLowerCase());

                const currentAdminMode = adminStates[chatId] || (isAdmin ? 'admin' : 'user');

                // قابلیت سوییچ میان پنل‌ها برای سوپرادمین‌ها
                if (isSuperAdmin && text === '🔀 سوییچ به پنل کاربر') {
                    if (userStates[chatId]) delete userStates[chatId];
                    adminStates[chatId] = 'user';
                    bot.sendMessage(chatId, "با موفقیت به منوی کاربری منتقل شدید.");
                    return sendUserMenu(bot, chatId, true);
                }
                
                if (isSuperAdmin && text === '🔀👑 سوییچ به پنل ادمین') {
                    if (userStates[chatId]) delete userStates[chatId];
                    adminStates[chatId] = 'admin';
                    bot.sendMessage(chatId, "با موفقیت به پنل مدیریت منتقل شدید.");
                    return sendAdminMenu(bot, chatId, username);
                }

                // هدایت پیام‌ها به ماشین وضعیت (State Handlers) در صورت انتظار برای ورودی
                if (userStates[chatId]) {
                    if (isAdmin && currentAdminMode === 'admin') {
                        return handleAdminStates(bot, msg, userStates, chatId);
                    } else {
                        return handleUserStates(bot, msg, userStates, chatId);
                    }
                }

                // هدایت دستورات متنی
                if (isAdmin && currentAdminMode === 'admin') {
                    handleAdminCommands(bot, msg, userStates);
                } else {
                    const isMember = await checkChannelMembership(bot, chatId, userId);
                    if (!isMember) {
                        return bot.sendMessage(
                            chatId,
                            `کاربر گرامی، جهت استفاده از امکانات ربات ابتدا در کانال رسمی ما عضو شوید:\n${process.env.CHANNEL_ID || '@Channel'}\n\nسپس روی دکمه زیر کلیک نمایید:`,
                            { reply_markup: { inline_keyboard: [[{ text: 'عضو شدم ✔️', callback_data: 'check_join' }]] } }
                        );
                    }
                    handleUserCommands(bot, msg, (isSuperAdmin && currentAdminMode === 'user'), userStates);
                }
            } catch (error) {
                console.error('[Bot.js] خطا در پردازش پیام ورودی:', error.message);
            }
        });

        // =============================================================
        // شنونده کلیک‌های دکمه‌های شیشه‌ای (bot.on('callback_query'))
        // =============================================================
        bot.on('callback_query', async (query) => {
            try {
                const chatId = query.message.chat.id;
                const userId = query.from.id;
                const data = query.data;

                // پاسخ آنی جهت پایان حالت چرخش لودینگ تلگرام روی کلاینت
                bot.answerCallbackQuery(query.id).catch(() => {});

                // اعتبارسنجی عضویت در کانال
                if (data === 'check_join') {
                    const isMember = await checkChannelMembership(bot, chatId, userId);
                    if (isMember) {
                        const username = query.from.username;
                        const isAdmin = await isUserAdmin(username, chatId);
                        if (isAdmin) {
                            adminStates[chatId] = 'admin';
                            sendAdminMenu(bot, chatId, username);
                        } else {
                            sendUserMenu(bot, chatId, false);
                        }
                    } else {
                        bot.sendMessage(chatId, "⚠️ شما هنوز عضو کانال رسمی نشده‌اید! لطفاً ابتدا عضو شوید و مجدداً کلیک نمایید.");
                    }
                    return;
                }

                if (data === 'ignore') return;

                // تفکیک کالبک‌های مدیریت و کاربر
                if (data.startsWith('adm_')) {
                    const username = query.from.username;
                    const isAdmin = await isUserAdmin(username, chatId);
                    if (!isAdmin) return;
                    handleAdminCallbacks(bot, query, userStates);
                } else {
                    handleUserCallbacks(bot, query, userStates);
                }
            } catch (error) {
                console.error('[Bot.js] خطا در پردازش Callback Query:', error.message);
            }
        });

    } catch (err) {
        console.error('❌ [Bot.js] خطای راهبری در اجرای اولیه برنامه:', err.message);
    }
}

// استارت پروژه
startBot();