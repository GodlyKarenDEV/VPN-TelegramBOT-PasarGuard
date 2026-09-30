const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const { connectDB, pool } = require('./Database');
const { checkChannelMembership, sendUserMenu, handleUserCommands, handleUserCallbacks, handleUserStates } = require('./User');
const { sendAdminMenu, handleAdminCommands, handleAdminCallbacks, handleAdminStates } = require('./Admin');
const { getUserFromPanel, deleteConfigOnPanel } = require('./PanelApi');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const adminStates = {}; 
const userStates = {}; 

// دریافت لیست سوپرادمین‌ها از فایل .env
function getSuperAdmins() {
    const rawAdmins = process.env.ADMIN_USERNAMES || '';
    return rawAdmins.split(',').map(u => u.trim().toLowerCase().replace('@', '')).filter(Boolean);
}

// بررسی سطح دسترسی کاربر
async function isUserAdmin(username, chatId) {
    try {
        const [rows] = await pool.query('SELECT role FROM users WHERE telegram_id = ?', [chatId]);
        if (rows.length > 0 && rows[0].role === 'admin') return true;
        const validSuperAdmins = getSuperAdmins();
        if (username && validSuperAdmins.includes(username.toLowerCase())) return true;
        return false;
    } catch (e) {
        console.error("خطا در بررسی سطح دسترسی ادمین:", e);
        return false;
    }
}

// تسک مانیتورینگ دوره‌ای اشتراک‌ها (بررسی انقضا، تست رایگان و اخطار حجم زیر ۱۰٪)
function startMonitoringTask() {
    setInterval(async () => {
        if (typeof getUserFromPanel !== 'function') {
            console.error("❌ خطا: getUserFromPanel به درستی از PanelApi.js ایمپورت نشده است.");
            return;
        }

        try {
            const [orders] = await pool.query('SELECT * FROM orders WHERE status = "approved"');
            const now = Math.floor(Date.now() / 1000);

            for (let o of orders) {
                try {
                    const pData = await getUserFromPanel(o.sub_name);
                    if (!pData) continue;

                    const expire = pData.expire || 0;

                    // بررسی پلن تست رایگان
                    if (o.plan_id === -1) {
                        if (expire > 0 && expire <= now) {
                            if (typeof deleteConfigOnPanel === 'function') {
                                await deleteConfigOnPanel(o.sub_name);
                            }
                            await pool.query('UPDATE orders SET status = "expired" WHERE id = ?', [o.id]);
                            bot.sendMessage(o.telegram_id, '⚠️ زمان تست رایگان شما (`' + o.sub_name + '`) به اتمام رسید و سرویس از سرور حذف گردید.', { parse_mode: 'Markdown' }).catch(() => {});
                        }
                        continue; 
                    }

                    // بررسی پلن‌های خریداری‌شده عادی (هشدار مصرف حجم زیر ۱۰٪)
                    const totalVol = pData.data_limit || 0;
                    if (totalVol > 0) {
                        const usedVol = pData.used_traffic || 0;
                        const remainingRatio = (totalVol - usedVol) / totalVol;
                        if (remainingRatio <= 0.10 && remainingRatio > 0 && !o.warn_vol) {
                            await pool.query('UPDATE orders SET warn_vol = 1 WHERE id = ?', [o.id]);
                            bot.sendMessage(o.telegram_id, '⚠️ کاربر گرامی، حجم باقی‌مانده اشتراک (`' + o.sub_name + '`) شما کمتر از ۱۰٪ می‌باشد. لطفاً جهت جلوگیری از قطعی، نسبت به تمدید اشتراک خود اقدام کنید.', { parse_mode: 'Markdown' }).catch(() => {});
                        }
                    }
                    
                    // بررسی تاریخ انقضای سرویس و هشدار ۳ روز پایانی
                    if (expire > 0) {
                        if (expire <= now) {
                            await pool.query('UPDATE orders SET status = "expired" WHERE id = ?', [o.id]);
                            bot.sendMessage(o.telegram_id, '⚠️ کاربر گرامی، زمان اشتراک شما (`' + o.sub_name + '`) به پایان رسید. جهت اتصال مجدد، نسبت به تمدید آن اقدام نمایید.', { parse_mode: 'Markdown' }).catch(() => {});
                        } else {
                            const daysLeft = (expire - now) / 86400;
                            if (daysLeft <= 3 && daysLeft > 0 && !o.warn_time) {
                                await pool.query('UPDATE orders SET warn_time = 1 WHERE id = ?', [o.id]);
                                bot.sendMessage(o.telegram_id, '⚠️ کاربر گرامی، زمان باقی‌مانده اشتراک (`' + o.sub_name + '`) شما کمتر از ۳ روز است. لطفاً جهت جلوگیری از قطعی، نسبت به تمدید اشتراک خود اقدام کنید.', { parse_mode: 'Markdown' }).catch(() => {});
                            }
                        }
                    }
                } catch (singleOrderErr) {
                    console.error('خطا در پردازش سفارش ' + o.id + ':', singleOrderErr);
                }
            }
        } catch (error) {
            console.error("خطا در سیستم پایش خودکار:", error);
        }
    }, 2 * 60 * 1000); 
}

// تابع اصلی راه‌اندازی و اجرای ربات
async function startBot() {
    try {
        await connectDB();
        console.log("اتصال موفق به دیتابیس.");
        console.log("Bot is ready to work!");
        
        startMonitoringTask();

        bot.on('message', async (msg) => {
            try {
                const chatId = msg.chat.id;
                const userId = msg.from.id;
                const username = msg.from.username || "بدون_آیدی";
                const text = msg.text;

                if (!text && !msg.photo && !msg.document) return;

                // مدیریت دستور /start و سیستم رفرال
                if (text && text.startsWith('/start')) {
                    if (userStates[chatId]) delete userStates[chatId];

                    const parts = text.split(' ');
                    if (parts.length > 1) {
                        const referrerId = parts[1].trim();
                        const [existingUser] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [chatId]);
                        
                        if (existingUser.length === 0 && referrerId !== String(chatId)) {
                            const [referrerExists] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [referrerId]);
                            if (referrerExists.length > 0) {
                                await pool.query('INSERT INTO users (telegram_id, username, referred_by) VALUES (?, ?, ?)', [chatId, username, referrerId]);
                                await pool.query('UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = ?', [referrerId]);
                                bot.sendMessage(referrerId, '🎉 یک کاربر جدید با لینک اختصاصی شما وارد ربات شد!').catch(() => {});
                            }
                        }
                    }

                    await pool.query('INSERT IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [chatId, username]);

                    const isAdmin = await isUserAdmin(username, chatId);
                    const isMember = await checkChannelMembership(bot, chatId, userId);
                    
                    if (!isMember) {
                        return bot.sendMessage(chatId, 'کاربر گرامی، برای استفاده از ربات ابتدا وارد چنل زیر شوید:\n' + process.env.CHANNEL_ID + '\n\nسپس روی دکمه زیر کلیک کنید:', {
                            reply_markup: { inline_keyboard: [[{ text: 'عضو شدم ✔️', callback_data: 'check_join' }]] }
                        });
                    }

                    if (isAdmin) {
                        adminStates[chatId] = 'admin';
                        return sendAdminMenu(bot, chatId, username);
                    } else {
                        return sendUserMenu(bot, chatId, false);
                    }
                }

                await pool.query('INSERT IGNORE INTO users (telegram_id, username) VALUES (?, ?)', [chatId, username]);

                const isAdmin = await isUserAdmin(username, chatId);
                const isSuperAdmin = getSuperAdmins().includes(username.toLowerCase());

                // تنظیم حالت ادمین
                const currentAdminMode = adminStates[chatId] || (isAdmin ? 'admin' : 'user');

                if (isSuperAdmin && text === '🔀 سوییچ به پنل کاربر') {
                    if (userStates[chatId]) delete userStates[chatId];
                    adminStates[chatId] = 'user';
                    bot.sendMessage(chatId, "با موفقیت به پنل کاربری منتقل شدید.");
                    return sendUserMenu(bot, chatId, true);
                }
                
                if (isSuperAdmin && text === '🔀👑 سوییچ به پنل ادمین') {
                    if (userStates[chatId]) delete userStates[chatId];
                    adminStates[chatId] = 'admin';
                    bot.sendMessage(chatId, "با موفقیت به پنل مدیریت منتقل شدید.");
                    return sendAdminMenu(bot, chatId, username);
                }

                if (userStates[chatId]) {
                    if (isAdmin && currentAdminMode === 'admin') {
                        return handleAdminStates(bot, msg, userStates, chatId);
                    } else {
                        return handleUserStates(bot, msg, userStates, chatId);
                    }
                }

                if (isAdmin && currentAdminMode === 'admin') {
                    handleAdminCommands(bot, msg, userStates);
                } else {
                    const isMember = await checkChannelMembership(bot, chatId, userId);
                    if (!isMember) {
                        return bot.sendMessage(chatId, 'کاربر گرامی، برای استفاده از ربات ابتدا وارد چنل زیر شوید:\n' + process.env.CHANNEL_ID + '\n\nسپس روی دکمه زیر کلیک کنید:', {
                            reply_markup: { inline_keyboard: [[{ text: 'عضو شدم ✔️', callback_data: 'check_join' }]] }
                        });
                    }
                    handleUserCommands(bot, msg, (isSuperAdmin && currentAdminMode === 'user'), userStates);
                }
            } catch (error) {
                console.error("خطا در پردازش پیام:", error);
            }
        });

        // مدیریت کال‌بک‌های شیشه‌ای
        bot.on('callback_query', async (query) => {
            try {
                const chatId = query.message.chat.id;
                const userId = query.from.id;
                const data = query.data;

                if (data === 'check_join') {
                    const isMember = await checkChannelMembership(bot, chatId, userId);
                    if (isMember) {
                        bot.answerCallbackQuery(query.id, { text: 'عضویت شما تایید شد.' });
                        const username = query.from.username;
                        const isAdmin = await isUserAdmin(username, chatId);
                        if (isAdmin) {
                            adminStates[chatId] = 'admin';
                            sendAdminMenu(bot, chatId, username);
                        } else {
                            sendUserMenu(bot, chatId, false);
                        }
                    } else {
                        bot.answerCallbackQuery(query.id, { text: 'هنوز عضو چنل نشده‌اید!', show_alert: true });
                    }
                    return;
                }

                if (data === 'ignore') {
                    bot.answerCallbackQuery(query.id);
                    return;
                }

                if (data.startsWith('adm_')) {
                    const username = query.from.username;
                    const isAdmin = await isUserAdmin(username, chatId);
                    if (!isAdmin) {
                        bot.answerCallbackQuery(query.id, { text: 'شما دسترسی ندارید!', show_alert: true });
                        return;
                    }
                    handleAdminCallbacks(bot, query, userStates);
                } else {
                    handleUserCallbacks(bot, query, userStates);
                }
                
                bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (error) {
                console.error("خطا در پردازش callback_query:", error);
            }
        });

    } catch (err) {
        console.error("Critical Start Error:", err);
    }
}

startBot();