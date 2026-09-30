const { pool } = require('./Database');
const { getServerStatus, createConfigOnPanel } = require('./PanelApi');
require('dotenv').config();

// =============================================================
// توابع کمکی: تاریخ شمسی و سوپرادمین‌ها
// =============================================================

function getPersianDateTime() {
    const now = new Date();
    const dateStr = new Intl.DateTimeFormat('fa-IR', {
        timeZone: 'Asia/Tehran',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now);
    
    const timeStr = new Intl.DateTimeFormat('fa-IR', {
        timeZone: 'Asia/Tehran',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(now);

    return { dateStr: dateStr, timeStr: timeStr, full: '📅 تاریخ: ' + dateStr + ' | ⏰ ساعت: ' + timeStr };
}

// دریافت لیست سوپرادمین‌ها از فایل .env
function getSuperAdmins() {
    const rawAdmins = process.env.ADMIN_USERNAMES || '';
    return rawAdmins.split(',').map(u => u.trim().toLowerCase().replace('@', '')).filter(Boolean);
}

// =============================================================
// تعریف پلن‌های پیش‌فرض و تضمین وجود آن‌ها در دیتابیس
// =============================================================
const DEFAULT_PLANS = [
    { title: 'نامحدود یک ماهه', plan_type: 'unlimited', volume: 0, duration_days: 30, price: 100000 },
    { title: 'نامحدود دو ماهه', plan_type: 'unlimited', volume: 0, duration_days: 60, price: 190000 },
    { title: 'نامحدود سه ماهه', plan_type: 'unlimited', volume: 0, duration_days: 90, price: 270000 },
    { title: 'یک ماه | 25 گیگ', plan_type: 'volume', volume: 25, duration_days: 30, price: 50000 },
    { title: 'یک ماه | 35 گیگ', plan_type: 'volume', volume: 35, duration_days: 30, price: 70000 },
    { title: 'یک ماه | 100 گیگ', plan_type: 'volume', volume: 100, duration_days: 30, price: 150000 },
    { title: 'دو ماه | 50 گیگ', plan_type: 'volume', volume: 50, duration_days: 60, price: 95000 },
    { title: 'دو ماه | 70 گیگ', plan_type: 'volume', volume: 70, duration_days: 60, price: 130000 },
    { title: 'دو ماه | 200 گیگ', plan_type: 'volume', volume: 200, duration_days: 60, price: 280000 },
    { title: 'سه ماه | 120 گیگ', plan_type: 'volume', volume: 120, duration_days: 90, price: 220000 },
    { title: 'سه ماه | 160 گیگ', plan_type: 'volume', volume: 160, duration_days: 90, price: 290000 },
    { title: 'سه ماه | 230 گیگ', plan_type: 'volume', volume: 230, duration_days: 90, price: 390000 }
];

async function ensureDefaultPlans() {
    for (const plan of DEFAULT_PLANS) {
        const [existing] = await pool.query('SELECT id FROM configs WHERE title = ?', [plan.title]);
        if (existing.length === 0) {
            await pool.query(
                'INSERT INTO configs (plan_type, title, volume, users_count, duration_days, price, status) VALUES (?, ?, ?, 1, ?, ?, "active")',
                [plan.plan_type, plan.title, plan.volume, plan.duration_days, plan.price]
            );
        }
    }
}

// =============================================================
// منوهای ناوبری و دسته‌بندی پلن‌ها در پنل ادمین
// =============================================================
function sendAdminMenu(bot, chatId, username) {
    const keyboard = [
        ['⚙️ ویرایش کانفیگ‌ها', '📋 لیست موجودی کانفیگ'],
        ['🎫 مدیریت کدهای تخفیف', '👥 لیست کاربران'],
        ['💸 مدیریت کیف پول', '🛍 مشاهده سفارشات'],
        ['🖥 وضعیت سرور', '📢 ایجاد پست در چنل و ربات'],
        ['🛡 ایجاد یا حذف کاربر', '📝 تنظیم راهنمای اتصال'],
        ['🔄 استارت مجدد ربات']
    ];

    const validSuperAdmins = getSuperAdmins();
    if (username && validSuperAdmins.includes(username.toLowerCase())) {
        keyboard.push(['🔀 سوییچ به پنل کاربر']);
    }

    bot.sendMessage(chatId, "سلام مدیر عزیز! خسته نباشی 🌹\nبه پنل مدیریت ربات خوش اومدی. چه کاری می‌خوای انجام بدی؟", {
        reply_markup: { keyboard: keyboard, resize_keyboard: true }
    });
}

function sendPlanCategoryMenu(bot, chatId, messageId = null) {
    const inlineKeyboard = [
        [{ text: '📊 پلن‌های حجمی', callback_data: 'adm_show_vol_plans' }],
        [{ text: '♾ پلن‌های نامحدود', callback_data: 'adm_show_unlimit_plans' }],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]
    ];
    const text = "رفیق، دسته کانفیگی که می‌خوای تعرفه و قیمتش رو ویرایش کنی انتخاب کن:";

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: inlineKeyboard } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

async function renderSpecificPlansList(bot, chatId, planType, messageId = null) {
    await ensureDefaultPlans();
    const [configs] = await pool.query("SELECT * FROM configs WHERE plan_type = ? AND (status = 'active' OR status IS NULL) ORDER BY duration_days ASC, volume ASC", [planType]);

    const inlineKeyboard = [];
    const isVol = planType === 'volume';
    const typeLabel = isVol ? '📊' : '♾';

    for (const cfg of configs) {
        const priceLabel = Number(cfg.price).toLocaleString('fa-IR');
        inlineKeyboard.push([
            { text: typeLabel + ' ' + cfg.title + ' | ' + priceLabel + ' تومان', callback_data: 'ignore' },
            { text: '✏️ تغییر قیمت', callback_data: 'adm_edit_price_' + cfg.id }
        ]);
    }
    inlineKeyboard.push([{ text: '🔙 بازگشت به انتخاب دسته', callback_data: 'adm_back_to_plan_cats' }]);
    inlineKeyboard.push([{ text: '🏠 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]);

    const headerText = isVol ? "📊 **لیست کانفیگ‌های حجمی:**" : "♾ **لیست کانفیگ‌های نامحدود:**";
    const fullText = headerText + "\n\nبرای تغییر قیمت هر کانفیگ روی دکمه «✏️ تغییر قیمت» کنارش کلیک کن رفیق:";

    if (messageId) {
        bot.editMessageText(fullText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, fullText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

// =============================================================
// دستورات متنی اصلی پنل مدیریت
// =============================================================
async function handleAdminCommands(bot, msg, userStates) {
    const text = msg.text;
    const chatId = msg.chat.id;

    switch (text) {
        case '⚙️ ویرایش کانفیگ‌ها':
        case '➕ افزودن کانفیگ':
            sendPlanCategoryMenu(bot, chatId);
            break;
        case '📋 لیست موجودی کانفیگ':
            sendConfigList(bot, chatId, 0);
            break;
        case '🎫 مدیریت کدهای تخفیف':
            renderDiscountsDashboard(bot, chatId);
            break;
        case '👥 لیست کاربران':
            sendUsersList(bot, chatId, 0);
            break;
        case '💸 مدیریت کیف پول':
            renderWalletDashboard(bot, chatId);
            break;
        case '🛍 مشاهده سفارشات':
            renderOrdersDashboard(bot, chatId);
            break;
        case '🖥 وضعیت سرور':
            renderServerDashboard(bot, chatId);
            break;
        case '📢 ایجاد پست در چنل و ربات':
            bot.sendMessage(chatId, "کجا می‌خوای پیامت رو ارسال کنی رفیق؟", {
                reply_markup: { inline_keyboard: [
                    [{ text: 'پست در چنل 📢', callback_data: 'adm_post_channel' }],
                    [{ text: 'پست در ربات 🤖', callback_data: 'adm_post_bot' }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]
                ]}
            });
            break;
        case '🛡 ایجاد یا حذف کاربر':
            bot.sendMessage(chatId, "🛡 **مدیریت کاربران و ادمین‌های ربات:**\nعملیات مورد نظر خود را انتخاب کنید:", {
                reply_markup: { inline_keyboard: [
                    [{ text: '➕ اضافه کردن ادمین', callback_data: 'adm_add_admin' }],
                    [{ text: '➖ حذف ادمین', callback_data: 'adm_remove_admin' }],
                    [{ text: '❌ حذف کامل کاربر از ربات', callback_data: 'adm_del_user' }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]
                ]}
            });
            break;
        case '📝 تنظیم راهنمای اتصال':
            userStates[chatId] = { step: 'set_guide' };
            bot.sendMessage(chatId, "متن راهنمای اتصال مدنظرت رو برام ارسال کن (برای انصراف /cancel بفرست):", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]] }});
            break;
        case '🔄 استارت مجدد ربات':
            bot.sendMessage(chatId, "✅ ربات رفرش شد و با موفقیت آماده استفاده است.");
            sendAdminMenu(bot, chatId, msg.from.username);
            break;
    }
}

// =============================================================
// داشبوردهای آماری، مالی و سفارشات
// =============================================================
async function renderOrdersDashboard(bot, chatId, messageId = null) {
    const dt = getPersianDateTime();
    const [[{totalOrders}]] = await pool.query('SELECT COUNT(*) as totalOrders FROM orders');
    const [[{pendingOrders}]] = await pool.query('SELECT COUNT(*) as pendingOrders FROM orders WHERE status = "pending"');
    const [[{approvedOrders}]] = await pool.query('SELECT COUNT(*) as approvedOrders FROM orders WHERE status = "approved"');
    const [[{rejectedOrders}]] = await pool.query('SELECT COUNT(*) as rejectedOrders FROM orders WHERE status = "rejected"');

    const txt = '📊 **داشبورد هوشمند سفارشات:**\n\n' +
        dt.full + '\n\n' +
        '📦 **تعداد کل سفارشات:** ' + (Number(totalOrders) || 0) + ' عدد\n' +
        '⏳ **در حال بررسی:** ' + (Number(pendingOrders) || 0) + ' سفارش\n' +
        '✅ **تایید شده:** ' + (Number(approvedOrders) || 0) + ' سفارش\n' +
        '❌ **رد شده:** ' + (Number(rejectedOrders) || 0) + ' سفارش\n\n' +
        'جهت مشاهده لیست هر بخش، دسته مورد نظر خود را انتخاب کنید:';

    const inlineKeyboard = [
        [{ text: '🌐 سفارشات کانفیگ', callback_data: 'adm_list_orders_config_0' }],
        [{ text: '💳 سفارشات شارژ کیف پول', callback_data: 'adm_list_orders_wallet_0' }],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]
    ];

    if (messageId) {
        bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

async function sendFilteredOrdersList(bot, chatId, orderType, offset, messageId = null) {
    const numOffset = parseInt(offset, 10) || 0;
    const isConfig = orderType === 'config';
    const condition = isConfig ? "order_type = 'config' OR order_type IS NULL" : "order_type = 'wallet_charge'";

    const [orders] = await pool.query('SELECT * FROM orders WHERE ' + condition + ' ORDER BY id DESC LIMIT 5 OFFSET ?', [numOffset]);

    let buttons = orders.map(o => {
        let statusBadge = o.status === 'approved' ? '✅' : (o.status === 'pending' ? '⏳' : '❌');
        let orderTitle = isConfig ? (o.sub_name || 'کانفیگ') : ('شارژ ' + Number(o.amount).toLocaleString('fa-IR') + 'T');
        return [{ text: statusBadge + ' سفارش #' + o.id + ' | ' + orderTitle, callback_data: 'adm_view_ord_' + o.id }];
    });

    let nav = [];
    if (numOffset >= 5) nav.push({ text: '⬅️ صفحه قبل', callback_data: 'adm_list_orders_' + orderType + '_' + (numOffset - 5) });
    if (orders.length === 5) nav.push({ text: 'صفحه بعد ➡️', callback_data: 'adm_list_orders_' + orderType + '_' + (numOffset + 5) });
    if (nav.length > 0) buttons.push(nav);

    buttons.push([{ text: '🔙 بازگشت به داشبورد سفارشات', callback_data: 'adm_orders_dash' }]);
    buttons.push([{ text: '🏠 منوی اصلی', callback_data: 'adm_back_to_main' }]);

    const text = isConfig ? "📋 **لیست سفارشات خرید کانفیگ:**" : "💳 **لیست سفارشات شارژ کیف پول:**";

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
}

async function renderWalletDashboard(bot, chatId, messageId = null) {
    const dt = getPersianDateTime();
    const [[{totalWallet}]] = await pool.query('SELECT SUM(wallet_balance) as totalWallet FROM users');
    const [[{activeWallets}]] = await pool.query('SELECT COUNT(*) as activeWallets FROM users WHERE wallet_balance > 0');
    const [[{inactiveWallets}]] = await pool.query('SELECT COUNT(*) as inactiveWallets FROM users WHERE wallet_balance <= 0 OR wallet_balance IS NULL');
    const [[{chargedUsersCount}]] = await pool.query('SELECT COUNT(DISTINCT telegram_id) as chargedUsersCount FROM orders WHERE order_type = "wallet_charge" AND status = "approved"');

    const txt = '💰 **داشبورد هوشمند مدیریت کیف پول:**\n\n' +
        dt.full + '\n\n' +
        '💎 **مجموع نقدینگی کیف پول کاربران:** ' + (Number(totalWallet) || 0).toLocaleString('fa-IR') + ' تومان\n' +
        '🟢 **تعداد کیف پول‌های فعال (دارای موجودی):** ' + (Number(activeWallets) || 0) + ' کاربر\n' +
        '⚪️ **کیف پول‌های خالی یا صفر:** ' + (Number(inactiveWallets) || 0) + ' کاربر\n' +
        '👥 **کاربرانی که شارژ انجام داده‌اند:** ' + (Number(chargedUsersCount) || 0) + ' نفر\n\n' +
        'عملیات مالی مورد نظر خود را انتخاب کنید:';

    const inlineKeyboard = [
        [
            { text: '➕ واریز به کیف پول (شارژ)', callback_data: 'adm_wallet_action_deposit_0' },
            { text: '➖ برداشت از کیف پول (کسر)', callback_data: 'adm_wallet_action_withdraw_0' }
        ],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]
    ];

    if (messageId) {
        bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

async function sendUsersListForWalletAction(bot, chatId, actionType, offset, messageId = null) {
    const numOffset = parseInt(offset, 10) || 0;
    const [users] = await pool.query('SELECT telegram_id, username, wallet_balance FROM users LIMIT 5 OFFSET ?', [numOffset]);

    let buttons = users.map(u => [
        {
            text: (u.username ? '@' + u.username : u.telegram_id) + ' | ' + Number(u.wallet_balance || 0).toLocaleString('fa-IR') + 'T',
            callback_data: 'adm_waction_' + actionType + '_' + u.telegram_id
        }
    ]);

    let nav = [];
    if (numOffset >= 5) nav.push({ text: '⬅️️ صفحه قبل', callback_data: 'adm_wallet_action_' + actionType + '_' + (numOffset - 5) });
    if (users.length === 5) nav.push({ text: 'صفحه بعد ➡️', callback_data: 'adm_wallet_action_' + actionType + '_' + (numOffset + 5) });
    if (nav.length > 0) buttons.push(nav);

    buttons.push([{ text: '🔙 بازگشت به داشبورد کیف پول', callback_data: 'adm_wallet_dash' }]);
    buttons.push([{ text: '🏠 منوی اصلی', callback_data: 'adm_back_to_main' }]);

    const titleText = actionType === 'deposit' ? '➕ **انتخاب کاربر جهت واریز وجه:**' : '➖ **انتخاب کاربر جهت کسر وجه:**';
    const fullText = titleText + '\nروی کاربر مورد نظر کلیک کنید:';

    if (messageId) {
        bot.editMessageText(fullText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, fullText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
}

async function renderServerDashboard(bot, chatId) {
    const dt = getPersianDateTime();
    bot.sendMessage(chatId, "⏳ در حال دریافت آمار لحظه‌ای و ارزیابی سرورها...");
    const serverInfo = await getServerStatus();

    let cpu = 'نامشخص';
    let mem = 'نامشخص';
    let onlineUsers = '۰';
    let panelVersion = '5.4.1';

    if (serverInfo.success && serverInfo.data) {
        const d = serverInfo.data;
        cpu = d.cpu_usage !== undefined ? d.cpu_usage + '%' : 'نامشخص';
        if (d.mem_used && d.mem_total) {
            mem = Math.round(d.mem_used / 1024 / 1024) + 'MB / ' + Math.round(d.mem_total / 1024 / 1024) + 'MB';
        }
        onlineUsers = d.online_users !== undefined ? Number(d.online_users).toLocaleString('fa-IR') : '۰';
        panelVersion = d.version || '5.4.1';
    }

    const [[{dbPing}]] = await pool.query('SELECT 1 as dbPing');

    const txt = '🖥 **داشبورد وضعیت یکپارچه سرور و اتصالات:**\n\n' +
        dt.full + '\n\n' +
        '🌐 **وضعیت اینترنت سرور:** آنلاین و پایدار 🟢\n' +
        '🗄 **ارتباط با دیتابیس:** متصل 🟢 (' + (dbPing ? 'پاسخ فوری' : 'عادی') + ')\n' +
        '⚡️ **اتصال به پنل پاسارگاد:** ' + (serverInfo.success ? 'متصل و عملیاتی 🟢' : 'قطع یا در انتظار 🔴') + '\n\n' +
        '⚙️ **منابع سخت‌افزاری سرور:**\n' +
        '▪️️ نسخه پنل پاسارگاد: ' + panelVersion + '\n' +
        '▪️ مصرف پردازنده (CPU): ' + cpu + '\n' +
        '▪️ مصرف حافظه رم (RAM): ' + mem + '\n' +
        '▪️ کاربران آنلاین متصل: ' + onlineUsers + ' نفر';

    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
}

async function renderDiscountsDashboard(bot, chatId, messageId = null) {
    const dt = getPersianDateTime();
    const now = new Date();

    const [allDiscounts] = await pool.query('SELECT * FROM discounts');
    let activeCount = 0;
    let expiredCount = 0;

    for (const d of allDiscounts) {
        if (d.status === 'expired' || (d.expires_at && new Date(d.expires_at) < now)) {
            expiredCount++;
        } else {
            activeCount++;
        }
    }

    const txt = '🎫 **داشبورد هوشمند کدهای تخفیف:**\n\n' +
        dt.full + '\n\n' +
        '🎁 **مجموع کل کدهای تخفیف:** ' + allDiscounts.length + ' کد\n' +
        '🟢 **کدهای فعال و دارای اعتبار:** ' + activeCount + ' کد\n' +
        '🔴 **کدهای منقضی شده یا تمام‌شده:** ' + expiredCount + ' کد\n\n' +
        'یک گزینه را برای مدیریت انتخاب کنید:';

    const inlineKeyboard = [
        [{ text: '➕ ایجاد کد تخفیف جدید', callback_data: 'adm_create_discount_start' }],
        [{ text: '⚙️ مدیریت و مشاهده کدهای تخفیف', callback_data: 'adm_manage_discounts_list' }],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]
    ];

    if (messageId) {
        bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

async function sendDiscountsManagementList(bot, chatId, messageId = null) {
    const [discounts] = await pool.query('SELECT * FROM discounts ORDER BY id DESC');
    const now = new Date();

    if (discounts.length === 0) {
        const emptyBtns = [[{ text: '🔙 بازگشت به داشبورد تخفیف', callback_data: 'adm_discounts_dash' }]];
        const emptyMsg = "هیچ کد تخفیفی در دیتابیس ثبت نشده است.";
        if (messageId) {
            return bot.editMessageText(emptyMsg, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: emptyBtns } }).catch(() => {});
        }
        return bot.sendMessage(chatId, emptyMsg, { reply_markup: { inline_keyboard: emptyBtns } });
    }

    let buttons = discounts.map(d => {
        const isExp = d.status === 'expired' || (d.expires_at && new Date(d.expires_at) < now);
        const statusLabel = isExp ? 'منقضی 🔴' : 'فعال 🟢';
        const typeStr = d.discount_type === 'percent' ? (d.amount + '٪') : (Number(d.amount).toLocaleString('fa-IR') + 'T');
        return [
            { text: d.code + ' (' + typeStr + ') | ' + statusLabel, callback_data: 'ignore' },
            { text: '❌ حذف', callback_data: 'adm_del_single_disc_' + d.id }
        ];
    });

    buttons.push([{ text: '🗑 حذف تمام کدهای تخفیف', callback_data: 'adm_del_all_discounts_confirm' }]);
    buttons.push([{ text: '🔙 بازگشت به داشبورد تخفیف', callback_data: 'adm_discounts_dash' }]);

    const text = "📋 **لیست تمام کدهای تخفیف ثبت‌شده:**\nبرای حذف روی دکمه مربوطه کلیک کنید:";

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    }
}

// =============================================================
// مدیریت حالت‌ها و استیت‌های متنی ادمین
// =============================================================
async function handleAdminStates(bot, msg, userStates, chatId) {
    const state = userStates[chatId];
    const text = msg.text;

    if (text === '/cancel') {
        delete userStates[chatId];
        return bot.sendMessage(chatId, "عملیات با موفقیت لغو شد رفیق.");
    }

    switch (state.step) {
        case 'wait_edit_price':
            const newPrice = parseInt(text.replace(/[^0-9]/g, ''), 10);
            if (isNaN(newPrice) || newPrice < 0) {
                return bot.sendMessage(chatId, "❌ لطفاً مبلغ معتبر رو به صورت عدد انگلیسی وارد کن:");
            }
            await pool.query('UPDATE configs SET price = ? WHERE id = ?', [newPrice, state.configId]);
            const targetPlanType = state.planType || 'volume';
            delete userStates[chatId];
            await bot.sendMessage(chatId, '✅ عالیه! قیمت کانفیگ با موفقیت به ' + newPrice.toLocaleString('fa-IR') + ' تومان به‌روزرسانی شد.');
            await renderSpecificPlansList(bot, chatId, targetPlanType);
            break;

        case 'set_guide':
            await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ("connection_guide", ?) ON DUPLICATE KEY UPDATE setting_value = ?', [text, text]);
            bot.sendMessage(chatId, "✅ راهنمای اتصال جدید با موفقیت ذخیره شد.");
            delete userStates[chatId];
            break;

        case 'add_disc_code':
            const codeInput = text.trim().toUpperCase();
            if (codeInput.length > 8) {
                return bot.sendMessage(chatId, "❌ نام کد تخفیف حداکثر باید ۸ کاراکتر باشد. لطفاً مجدداً وارد کنید:");
            }
            userStates[chatId] = { step: 'add_disc_amount', code: codeInput };
            bot.sendMessage(chatId, "مبلغ یا درصد تخفیف را وارد کنید:\nاگر درصدی است علامت % بگذارید (مثال: `20%`)\nاگر تومانی است فقط عدد بنویسید (مثال: `30000`):", { parse_mode: 'Markdown' });
            break;

        case 'add_disc_amount':
            const isPercent = text.includes('%');
            const cleanAmt = parseInt(text.replace(/[^0-9]/g, ''), 10);
            if (isNaN(cleanAmt) || cleanAmt <= 0) {
                return bot.sendMessage(chatId, "❌ لطفاً مقدار تخفیف را به عدد معتبر وارد کنید:");
            }
            userStates[chatId] = {
                step: 'add_disc_days',
                code: state.code,
                amount: cleanAmt,
                discount_type: isPercent ? 'percent' : 'fixed'
            };
            bot.sendMessage(chatId, "کد تخفیف چند روز مهلت استفاده داشته باشد؟ (تعداد روز به عدد، مثال: `7`):", { parse_mode: 'Markdown' });
            break;

        case 'add_disc_days':
            const days = parseInt(text.replace(/[^0-9]/g, ''), 10);
            if (isNaN(days) || days <= 0) {
                return bot.sendMessage(chatId, "❌ لطفاً تعداد روزها را به عدد معتبر وارد کنید:");
            }
            const expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + days);

            await pool.query(
                'INSERT INTO discounts (code, amount, discount_type, expires_at, status) VALUES (?, ?, ?, ?, "active")',
                [state.code, state.amount, state.discount_type, expireDate]
            );

            delete userStates[chatId];
            bot.sendMessage(chatId, '✅ کد تخفیف `' + state.code + '` با موفقیت ساخته شد و به مدت ' + days + ' روز فعال خواهد بود.', { parse_mode: 'Markdown' });
            renderDiscountsDashboard(bot, chatId);
            break;

        case 'wallet_deposit_amount':
            const depositAmount = parseInt(text.replace(/[^0-9]/g, ''), 10);
            if (isNaN(depositAmount) || depositAmount <= 0) {
                return bot.sendMessage(chatId, "❌ لطفاً مبلغ واریزی معتبر را به عدد وارد کنید:");
            }
            await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE telegram_id = ?', [depositAmount, state.targetUserId]);
            bot.sendMessage(chatId, '✅ مبلغ ' + depositAmount.toLocaleString('fa-IR') + ' تومان با موفقیت به کیف پول کاربر اضافه شد.');
            try {
                bot.sendMessage(state.targetUserId, '🎁 کاربر گرامی، مبلغ ' + depositAmount.toLocaleString('fa-IR') + ' تومان توسط مدیریت به کیف پول شما واریز شد.');
            } catch (e) {}
            delete userStates[chatId];
            renderWalletDashboard(bot, chatId);
            break;

        case 'wallet_withdraw_amount':
            const withdrawAmount = parseInt(text.replace(/[^0-9]/g, ''), 10);
            if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
                return bot.sendMessage(chatId, "❌ لطفاً مبلغ برداشت معتبر را به عدد وارد کنید:");
            }
            await pool.query('UPDATE users SET wallet_balance = GREATEST(0, wallet_balance - ?) WHERE telegram_id = ?', [withdrawAmount, state.targetUserId]);
            bot.sendMessage(chatId, '✅ مبلغ ' + withdrawAmount.toLocaleString('fa-IR') + ' تومان از کیف پول کاربر کسر گردید.');
            try {
                bot.sendMessage(state.targetUserId, '⚠️ کاربر گرامی، مبلغ ' + withdrawAmount.toLocaleString('fa-IR') + ' تومان توسط مدیریت از کیف پول شما کسر شد.');
            } catch (e) {}
            delete userStates[chatId];
            renderWalletDashboard(bot, chatId);
            break;

        case 'post_bot':
            const [users] = await pool.query('SELECT telegram_id FROM users');
            bot.sendMessage(chatId, 'در حال ارسال پیام به ' + users.length + ' کاربر...');
            for (let u of users) {
                try { 
                    await bot.copyMessage(u.telegram_id, chatId, msg.message_id); 
                    await new Promise(res => setTimeout(res, 40));
                } catch(e) {}
            }
            bot.sendMessage(chatId, "✅ پیام همگانی با موفقیت برای کاربران ارسال شد.");
            delete userStates[chatId];
            break;
            
        case 'post_channel':
            try {
                const botUsername = (process.env.BOT_USERNAME || 'bot').replace('@', '');
                await bot.copyMessage(process.env.CHANNEL_ID, chatId, msg.message_id, {
                    reply_markup: { inline_keyboard: [[{ text: 'ورود به ربات 🤖', url: 'https://t.me/' + botUsername }]] }
                });
                bot.sendMessage(chatId, "✅ پست در کانال قرار گرفت.");
            } catch(e) { 
                bot.sendMessage(chatId, "❌ خطا در ارسال به کانال. لطفاً مطمئن شو ربات در کانال ادمین باشه."); 
            }
            delete userStates[chatId];
            break;
            
        case 'add_admin_id':
            const targetAdmin = text.trim().replace('@', '');
            const [updateAdminRes] = await pool.query('UPDATE users SET role = "admin" WHERE telegram_id = ? OR username = ?', [targetAdmin, targetAdmin]);
            if (updateAdminRes.affectedRows > 0) {
                bot.sendMessage(chatId, "✅ کاربر مورد نظر با موفقیت به لیست ادمین‌ها اضافه شد.");
            } else {
                bot.sendMessage(chatId, "❌ کاربری با این مشخصات در ربات پیدا نشد.");
            }
            delete userStates[chatId];
            break;

        case 'remove_admin_id':
            const targetRemAdmin = text.trim().replace('@', '');
            const [remAdminRes] = await pool.query('UPDATE users SET role = "user" WHERE (telegram_id = ? OR username = ?) AND role = "admin"', [targetRemAdmin, targetRemAdmin]);
            if (remAdminRes.affectedRows > 0) {
                bot.sendMessage(chatId, "✅ دسترسی ادمینی این کاربر با موفقیت لغو شد.");
            } else {
                bot.sendMessage(chatId, "❌ کاربری با این مشخصات در لیست ادمین‌ها یافت نشد.");
            }
            delete userStates[chatId];
            break;
            
        case 'del_user_id':
            const targetDelete = text.trim().replace('@', '');
            const [deleteRes] = await pool.query('DELETE FROM users WHERE telegram_id = ? OR username = ?', [targetDelete, targetDelete]);
            if (deleteRes.affectedRows > 0) {
                bot.sendMessage(chatId, "✅ کاربر با موفقیت از ربات حذف شد.");
            } else {
                bot.sendMessage(chatId, "❌ کاربر پیدا نشد.");
            }
            delete userStates[chatId];
            break;
    }
}

// =============================================================
// مدیریت رویدادهای کلیک دکمه‌های شیشه‌ای (Callbacks)
// =============================================================
async function handleAdminCallbacks(bot, query, userStates) {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (data === 'adm_back_to_main' || data === 'back_to_main') {
        if (userStates[chatId]) delete userStates[chatId];
        bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        return sendAdminMenu(bot, chatId, query.from.username);
    }
    else if (data === 'adm_orders_dash') {
        return renderOrdersDashboard(bot, chatId, query.message.message_id);
    }
    else if (data === 'adm_wallet_dash') {
        return renderWalletDashboard(bot, chatId, query.message.message_id);
    }
    else if (data === 'adm_discounts_dash') {
        return renderDiscountsDashboard(bot, chatId, query.message.message_id);
    }
    else if (data.startsWith('adm_list_orders_config_')) {
        const offset = parseInt(data.split('_')[4], 10);
        return sendFilteredOrdersList(bot, chatId, 'config', offset, query.message.message_id);
    }
    else if (data.startsWith('adm_list_orders_wallet_')) {
        const offset = parseInt(data.split('_')[4], 10);
        return sendFilteredOrdersList(bot, chatId, 'wallet_charge', offset, query.message.message_id);
    }
    else if (data.startsWith('adm_wallet_action_deposit_')) {
        const offset = parseInt(data.split('_')[4], 10);
        return sendUsersListForWalletAction(bot, chatId, 'deposit', offset, query.message.message_id);
    }
    else if (data.startsWith('adm_wallet_action_withdraw_')) {
        const offset = parseInt(data.split('_')[4], 10);
        return sendUsersListForWalletAction(bot, chatId, 'withdraw', offset, query.message.message_id);
    }
    else if (data.startsWith('adm_waction_')) {
        const parts = data.split('_');
        const act = parts[2];
        const uid = parts[3];
        userStates[chatId] = { step: act === 'deposit' ? 'wallet_deposit_amount' : 'wallet_withdraw_amount', targetUserId: uid };
        const actTitle = act === 'deposit' ? 'واریز به' : 'برداشت از';
        bot.sendMessage(chatId, 'مبلغ مورد نظر برای ' + actTitle + ' کیف پول این کاربر را به تومان وارد کنید:\n(برای انصراف: /cancel)');
        return;
    }
    else if (data === 'adm_create_discount_start') {
        userStates[chatId] = { step: 'add_disc_code' };
        bot.sendMessage(chatId, "نام کد تخفیف را وارد کنید (حداکثر ۸ کاراکتر انگلیسی، مثال: `NOWRUZ`):", { parse_mode: 'Markdown' });
        return;
    }
    else if (data === 'adm_manage_discounts_list') {
        return sendDiscountsManagementList(bot, chatId, query.message.message_id);
    }
    else if (data.startsWith('adm_del_single_disc_')) {
        const dId = data.split('_')[4];
        await pool.query('DELETE FROM discounts WHERE id = ?', [dId]);
        bot.answerCallbackQuery(query.id, { text: 'کد تخفیف حذف شد.' });
        return sendDiscountsManagementList(bot, chatId, query.message.message_id);
    }
    else if (data === 'adm_del_all_discounts_confirm') {
        await pool.query('DELETE FROM discounts');
        bot.answerCallbackQuery(query.id, { text: 'تمام کدهای تخفیف با موفقیت حذف شدند.' });
        return renderDiscountsDashboard(bot, chatId, query.message.message_id);
    }
    else if (data.startsWith('adm_quick_del_user_')) {
        const targetUserId = data.split('_')[4];
        await pool.query('DELETE FROM users WHERE telegram_id = ?', [targetUserId]);
        bot.answerCallbackQuery(query.id, { text: 'کاربر با موفقیت از سیستم حذف شد.' });
        return sendUsersList(bot, chatId, 0, query.message.message_id);
    }
    else if (data === 'adm_remove_admin') {
        userStates[chatId] = { step: 'remove_admin_id' };
        bot.sendMessage(chatId, "آیدی عددی یا یوزرنیم تلگرام ادمینی که می‌خواهید عزل کنید را ارسال نمایید:\n(برای انصراف: /cancel)");
        return;
    }
    else if (data === 'adm_back_to_plan_cats') {
        return sendPlanCategoryMenu(bot, chatId, query.message.message_id);
    }
    else if (data === 'adm_show_vol_plans') {
        return renderSpecificPlansList(bot, chatId, 'volume', query.message.message_id);
    }
    else if (data === 'adm_show_unlimit_plans') {
        return renderSpecificPlansList(bot, chatId, 'unlimited', query.message.message_id);
    }
    else if (data.startsWith('adm_edit_price_')) {
        const configId = parseInt(data.split('_')[3], 10);
        const [cfgs] = await pool.query('SELECT title, price, plan_type FROM configs WHERE id = ?', [configId]);
        if (cfgs.length === 0) {
            return bot.answerCallbackQuery(query.id, { text: 'پلن پیدا نشد!', show_alert: true });
        }

        userStates[chatId] = { step: 'wait_edit_price', configId: configId, planType: cfgs[0].plan_type };
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, 'قیمت فعلی پلن **' + cfgs[0].title + '** برابر با ' + parseInt(cfgs[0].price, 10).toLocaleString('fa-IR') + ' تومان است.\n\nلطفاً قیمت جدید دلخواهت رو به تومان (فقط عدد) ارسال کن رفیق:\n(برای انصراف: /cancel)', { parse_mode: 'Markdown' });
        return;
    }
    else if (data.startsWith('adm_conf_next_')) {
        return sendConfigList(bot, chatId, parseInt(data.split('_')[3], 10), query.message.message_id);
    }
    else if (data.startsWith('adm_usr_next_')) {
        return sendUsersList(bot, chatId, parseInt(data.split('_')[3], 10), query.message.message_id);
    }
    else if (data.startsWith('adm_chrg_next_')) {
        return sendUsersListForCharge(bot, chatId, parseInt(data.split('_')[3], 10), query.message.message_id);
    }
    else if (data.startsWith('adm_ord_next_')) {
        return sendOrdersList(bot, chatId, parseInt(data.split('_')[3], 10), query.message.message_id);
    }

    if (data === 'adm_charge_user') {
        sendUsersListForCharge(bot, chatId, 0);
    } else if (data.startsWith('adm_chargebtn_')) {
        const uid = data.split('_')[2];
        userStates[chatId] = { step: 'charge_user_amount', targetUserId: uid };
        bot.sendMessage(chatId, "مبلغ مورد نیاز برای شارژ کیف پول این کاربر را بفرستید:", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]] }});
    } else if (data === 'adm_post_channel') {
        userStates[chatId] = { step: 'post_channel' };
        bot.sendMessage(chatId, "متن یا عکس دلخواهت رو ارسال کن تا در کانال پست بشه:", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]] }});
    } else if (data === 'adm_post_bot') {
        userStates[chatId] = { step: 'post_bot' };
        bot.sendMessage(chatId, "متن یا پیام دلخواهت رو بفرست تا برای همه کاربران ربات بفرستم:", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]] }});
    } else if (data === 'adm_add_admin') {
        userStates[chatId] = { step: 'add_admin_id' };
        bot.sendMessage(chatId, "آیدی عددی یا یوزرنیم تلگرام فرد مورد نظر رو برام بفرست:", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]] }});
    } else if (data === 'adm_del_user') {
        userStates[chatId] = { step: 'del_user_id' };
        bot.sendMessage(chatId, "آیدی عددی یا یوزرنیم تلگرام کاربری که می‌خوای حذف کنی رو بفرست:", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]] }});
    } else if (data.startsWith('adm_del_conf_')) {
        const confId = data.split('_')[3];
        await pool.query('DELETE FROM configs WHERE id = ?', [confId]);
        bot.sendMessage(chatId, "✅ کانفیگ مورد نظر از لیست حذف شد.");
    }
    else if (data.startsWith('adm_approve_order_')) {
        const orderId = data.split('_')[3];
        const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
        
        if (orders.length > 0) {
            const order = orders[0];
            if (order.status !== 'pending') {
                return bot.sendMessage(chatId, "⚠️ وضعیت این سفارش قبلاً تعیین شده است.");
            }

            if (order.order_type === 'wallet_charge') {
                await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE telegram_id = ?', [order.amount, order.telegram_id]);
                await pool.query('UPDATE orders SET status = "approved" WHERE id = ?', [orderId]);
                bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ شارژ تایید گردید', callback_data: 'ignore' }]] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
                bot.sendMessage(chatId, "✅ درخواست شارژ کیف پول تایید و مبلغ به حساب کاربر افزوده شد.");
                bot.sendMessage(order.telegram_id, '🎉 تراکنش تایید شد! مبلغ ' + Number(order.amount).toLocaleString('fa-IR') + ' تومان به کیف پولت افزوده شد دوست من.');
                return;
            }

            let vol = 0, duration = 30, unit = 'days', users = 1;
            
            if (order.plan_id === -1) {
                duration = 15;
                unit = 'minutes';
            } else {
                const [plans] = await pool.query('SELECT * FROM configs WHERE id = ?', [order.plan_id]);
                if (plans.length > 0) {
                    const plan = plans[0];
                    vol = plan.volume || 0;
                    duration = plan.duration_days;
                    users = plan.users_count || 1;
                }
            }

            const panelRes = await createConfigOnPanel(order.sub_name, vol, duration, unit, users, order.plan_id === -1, true);
            
            if (panelRes.success) {
                await pool.query('UPDATE orders SET status = "approved", sub_link = ? WHERE id = ?', [panelRes.link, orderId]);
                bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ تایید شده', callback_data: 'ignore' }]] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
                bot.sendMessage(chatId, "✅ سفارش تایید شد و کانفیگ روی سرور پاسارگاد فعال گردید.");
                bot.sendMessage(order.telegram_id, '🎉 دوست من، سفارشت با موفقیت تایید شد!\n\n🌐 لینک ساب شما:\n`' + panelRes.link + '`\n\nامیدواریم از سرعت لذت ببری ❤️', { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, '❌ خطا در ساخت کانفیگ در پنل: ' + (panelRes.error || 'خطای سرور'));
            }
        }
    }
    else if (data.startsWith('adm_reject_order_')) {
        const orderId = data.split('_')[3];
        const [orders] = await pool.query('SELECT telegram_id, status FROM orders WHERE id = ?', [orderId]);
        if (orders.length > 0 && orders[0].status === 'pending') {
            await pool.query('UPDATE orders SET status = "rejected" WHERE id = ?', [orderId]);
            bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ رد شده', callback_data: 'ignore' }]] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
            bot.sendMessage(chatId, "❌ سفارش رد شد.");
            bot.sendMessage(orders[0].telegram_id, "متاسفانه فیش واریزی شما تایید نشد. اگر مشکلی هست به پشتیبانی پیام بده رفیق 🌹");
        } else {
            bot.sendMessage(chatId, "⚠️ وضعیت این سفارش قبلاً تعیین شده است.");
        }
    }
    else if (data.startsWith('adm_approve_charge_')) {
        const parts = data.split('_');
        const amount = parseInt(parts[3], 10);
        const targetId = parts[4];
        
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE telegram_id = ?', [amount, targetId]);
        await pool.query('UPDATE orders SET status = "approved" WHERE telegram_id = ? AND amount = ? AND status = "pending" LIMIT 1', [targetId, amount]);
        bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ شارژ تایید گردید', callback_data: 'ignore' }]] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
        bot.sendMessage(chatId, "✅ تراکنش تایید شد و کیف پول کاربر شارژ گردید.");
        bot.sendMessage(targetId, '🎉 ایول! واریزی شما تایید شد و مبلغ ' + amount.toLocaleString('fa-IR') + ' تومان به کیف پولت اضافه شد.');
    }
    else if (data.startsWith('adm_reject_charge_')) {
        const targetId = data.split('_')[3];
        await pool.query('UPDATE orders SET status = "rejected" WHERE telegram_id = ? AND status = "pending" LIMIT 1', [targetId]);
        bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ شارژ رد شد', callback_data: 'ignore' }]] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
        bot.sendMessage(chatId, "❌ تراکنش شارژ رد شد.");
        bot.sendMessage(targetId, "متاسفانه درخواست شارژ کیف پول شما تایید نشد. در صورت مغایرت به پشتیبانی پیام بدید 🌹");
    }
    else if (data.startsWith('adm_view_ord_')) {
        const oId = data.split('_')[3];
        const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [oId]);
        if (orders.length > 0) {
            const o = orders[0];
            const [users] = await pool.query('SELECT username FROM users WHERE telegram_id = ?', [o.telegram_id]);
            const uName = users.length > 0 ? users[0].username : 'بدون_نام';
            const isWallet = o.order_type === 'wallet_charge';

            const txt = '🛍 **اطلاعات دقیق سفارش:**\n\n' +
                '🔹 شناسه سفارش: ' + o.id + '\n' +
                '📂 نوع سفارش: ' + (isWallet ? 'شارژ کیف پول 💳' : 'خرید کانفیگ 🌐') + '\n' +
                '👤 آیدی عددی کاربر: ' + o.telegram_id + '\n' +
                '🆔 یوزرنیم تلگرام: @' + uName + '\n' +
                '💰 مبلغ: ' + (o.amount ? Number(o.amount).toLocaleString('fa-IR') : 0) + ' تومان\n' +
                '📊 وضعیت: ' + o.status + '\n' +
                '🏷 عنوان/ساب: ' + (o.sub_name || (isWallet ? 'شارژ حساب' : 'نامشخص'));
            
            let inline_keyboard = [];
            if (o.status === 'pending') {
                inline_keyboard.push([
                    { text: '✅ تایید سفارش', callback_data: 'adm_approve_order_' + o.id },
                    { text: '❌ رد سفارش', callback_data: 'adm_reject_order_' + o.id }
                ]);
            }
            inline_keyboard.push([{ text: '🔙 بازگشت به لیست سفارشات', callback_data: 'adm_orders_dash' }]);

            if (o.receipt_file_id) {
                bot.sendPhoto(chatId, o.receipt_file_id, { caption: txt, reply_markup: { inline_keyboard }});
            } else {
                bot.sendMessage(chatId, txt, { reply_markup: { inline_keyboard }});
            }
        }
    }
}

// =============================================================
// فهرست‌بندی و پیجینیشن کاربران و کانفیگ‌ها
// =============================================================
async function sendConfigList(bot, chatId, offset, messageId = null) {
    const numOffset = parseInt(offset, 10) || 0;
    const [configs] = await pool.query('SELECT * FROM configs LIMIT 5 OFFSET ?', [numOffset]);
    let buttons = configs.map(c => [
        {text: c.title + ' - ' + Number(c.price).toLocaleString('fa-IR') + 'T', callback_data: 'ignore'},
        {text: '❌ حذف', callback_data: 'adm_del_conf_' + c.id}
    ]);
    
    let nav = [];
    if (numOffset >= 5) nav.push({text: '⬅️ صفحه قبل', callback_data: 'adm_conf_next_' + (numOffset - 5)});
    if (configs.length === 5) nav.push({text: 'صفحه بعد ➡️', callback_data: 'adm_conf_next_' + (numOffset + 5)});
    if (nav.length > 0) buttons.push(nav);
    
    buttons.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]);
    
    const text = "لیست کانفیگ‌ها (برای حذف روی دکمه مربوطه کلیک کنید):";
    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons }}).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons }});
    }
}

async function sendUsersList(bot, chatId, offset, messageId = null) {
    const numOffset = parseInt(offset, 10) || 0;
    const dt = getPersianDateTime();

    const [[{totalUsersCount}]] = await pool.query('SELECT COUNT(*) as totalUsersCount FROM users');
    const [[{totalAdminsCount}]] = await pool.query('SELECT COUNT(*) as totalAdminsCount FROM users WHERE role = "admin"');
    
    let channelMembersCount = 'نامشخص';
    try {
        if (process.env.CHANNEL_ID) {
            const count = await bot.getChatMemberCount(process.env.CHANNEL_ID);
            channelMembersCount = Number(count).toLocaleString('fa-IR');
        }
    } catch (e) {}

    const [users] = await pool.query('SELECT telegram_id, username FROM users LIMIT 5 OFFSET ?', [numOffset]);
    let buttons = users.map(u => [
        { text: (u.username ? '@' + u.username : 'بدون نام') + ' | ' + u.telegram_id, url: 'tg://user?id=' + u.telegram_id },
        { text: '❌ حذف', callback_data: 'adm_quick_del_user_' + u.telegram_id }
    ]);
    
    let nav = [];
    if (numOffset >= 5) nav.push({text: '⬅️ صفحه قبل', callback_data: 'adm_usr_next_' + (numOffset - 5)});
    if (users.length === 5) nav.push({text: 'صفحه بعد ➡️', callback_data: 'adm_usr_next_' + (numOffset + 5)});
    if (nav.length > 0) buttons.push(nav);
    
    buttons.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]);
    
    const text = '👥 **داشبورد هوشمند اعضا و کاربران ربات:**\n\n' +
        dt.full + '\n\n' +
        '👤 **تعداد کاربران ثبت‌شده در ربات:** ' + (Number(totalUsersCount) || 0) + ' نفر\n' +
        '📢 **تعداد اعضای چنل رسمی تلگرام:** ' + channelMembersCount + '\n' +
        '🛡 **تعداد ادمین‌های ربات:** ' + (Number(totalAdminsCount) || 0) + ' نفر\n\n' +
        'جهت انتقال به پروفایل روی اسم کاربر، یا جهت حذف مستقیم روی دکمه «❌ حذف» کلیک کنید:';

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons }}).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons }});
    }
}

async function sendUsersListForCharge(bot, chatId, offset, messageId = null) {
    const numOffset = parseInt(offset, 10) || 0;
    const [users] = await pool.query('SELECT telegram_id, username FROM users LIMIT 5 OFFSET ?', [numOffset]);
    let buttons = users.map(u => [
        {text: (u.username ? u.username : 'بدون نام') + ' | ' + u.telegram_id, callback_data: 'adm_chargebtn_' + u.telegram_id}
    ]);
    
    let nav = [];
    if (numOffset >= 5) nav.push({text: '⬅️ صفحه قبل', callback_data: 'adm_chrg_next_' + (numOffset - 5)});
    if (users.length === 5) nav.push({text: 'صفحه بعد ➡️', callback_data: 'adm_chrg_next_' + (numOffset + 5)});
    if (nav.length > 0) buttons.push(nav);
    
    buttons.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'adm_back_to_main' }]);
    
    const text = "کاربر را برای شارژ انتخاب کنید:";
    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: buttons }}).catch(() => {});
    } else {
        bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons }});
    }
}

async function sendOrdersList(bot, chatId, offset, messageId = null) {
    renderOrdersDashboard(bot, chatId, messageId);
}

module.exports = { sendAdminMenu, handleAdminCommands, handleAdminCallbacks, handleAdminStates, ensureDefaultPlans };