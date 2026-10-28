/**
 * ====================================================================
 * User.js - ماژول مدیریت رابط کاربری و تعاملات کاربران ربات تلگرام
 * ====================================================================
 * این فایل کلیه فرایندهای مربوط به کاربران را پوشش می‌دهد:
 * - موتور لحن‌های سه‌گانه (دوستانه، رسمی، حرفه‌ای)
 * - خرید پلن‌های حجمی و نامحدود (کارت‌به‌کارت و پرداخت مستقیم از کیف پول)
 * - ثبت تمدید تجمیعی (با درج نوع renewal در دیتابیس)
 * - صدور اشتراک تست ۱ ساعته (۶۰ دقیقه)
 * - سیستم رفرال و پورسانت نقدی ۱۰ درصدی دائمی
 * - درخواست تسویه حساب بالای ۵۰ هزار تومان و ارسال به ادمین‌ها
 * - انتقال امن اشتراک با ابطال قطعی لینک قبلی
 * - گارد امنیتی ضد کرش برای استیت‌ها پس از راه‌اندازی مجدد سرور
 */

const { pool } = require('./Database');
const { createConfigOnPanel, deleteConfigOnPanel, getUserFromPanel, transferConfigOnPanel } = require('./PanelApi');
const { ensureDefaultPlans, getSuperAdmins } = require('./Admin');
require('dotenv').config();

async function getBotTone() {
    try {
        const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "bot_tone"');
        return rows.length > 0 ? rows[0].setting_value : 'friendly';
    } catch (e) {
        return 'friendly';
    }
}

const TONE_MESSAGES = {
    welcome: {
        friendly: "سلام دوست من! خیلی خوش اومدی ❤️\nیک گزینه رو انتخاب کن تا با هم بریم جلو:",
        formal: "با سلام و احترام، به سامانه مدیریت اشتراک خوش آمدید.\nلطفاً یکی از گزینه‌های زیر را جهت ادامه انتخاب فرمایید:",
        professional: "سامانه فعال است.\nعملیات مورد نظر را از منوی زیر انتخاب نمایید:"
    },
    choose_category: {
        friendly: "رفیق، دسته کانفیگ مورد نظرت رو انتخاب کن:",
        formal: "کاربر گرامی، لطفاً دسته‌بندی اشتراک مورد نظر را انتخاب نمایید:",
        professional: "انتخاب دسته‌بندی سرویس:"
    },
    already_used_trial: {
        friendly: "رفیق، شما قبلاً یک‌بار از اشتراک تست رایگان استفاده کردی 🌹\nمی‌تونی از بخش «🚀 خرید کانفیگ» پلن دلخواهت رو انتخاب کنی.",
        formal: "کاربر گرامی، شما پیش از این سهمیه تست رایگان ۱ ساعته خود را دریافت نموده‌اید.\nجهت دسترسی دائم لطفاً از بخش «خرید کانفیگ» اقدام فرمایید.",
        professional: "سهمیه تست رایگان قبلاً مصرف شده است.\nجهت اتصال، اشتراک تجاری تهیه فرمایید."
    },
    trial_name_prompt: {
        friendly: "یک اسم انگلیسی دلخواه (حداکثر ۱۲ کاراکتر) برای کانفیگ تست ۱ ساعته‌ت بفرست:\n(مثال: `mytest123`)",
        formal: "لطفاً یک شناسه انگلیسی معتبر (حداکثر ۱۲ کاراکتر) جهت راه‌اندازی اشتراک تست ۱ ساعته ارسال فرمایید:\n(مثال: `mytest123`)",
        professional: "شناسه کاربری اشتراک تست (حداکثر ۱۲ کاراکتر انگلیسی) را وارد نمایید:"
    },
    trial_success: {
        friendly: "🎉 ایول! کانفیگ تست ۱ ساعته شما با موفقیت فعال شد:\n\n🌐 لینک ساب شما:\n`{link}`\n\nنکته: بعد از ۶۰ دقیقه سرویس به طور خودکار غیرفعال می‌شه.",
        formal: "🎉 اشتراک تست ۱ ساعته شما با موفقیت ایجاد و فعال گردید:\n\n🌐 لینک اتصال ساب‌اسکریپشن:\n`{link}`\n\nتوجه: سرویس پس از اتمام زمان ۶۰ دقیقه به صورت خودکار منقضی می‌گردد.",
        professional: "اشتراک تست ۱ ساعته فعال شد.\n\n🌐 آدرس ساب‌اسکریپشن:\n`{link}`\n\nمدت اعتبار: ۶۰ دقیقه."
    },
    support_prompt: {
        friendly: "هر سوال یا مشکلی داشتی، تیم پشتیبانی با عشق در کنارته ❤️\nروی دکمه زیر کلیک کن تا ارتباط برقرار بشه:",
        formal: "کاربر گرامی، تیم پشتیبانی آماده پاسخگویی به سوالات و مشکلات شما می‌باشد.\nجهت ارتباط روی دکمه زیر کلیک فرمایید:",
        professional: "واحد پشتیبانی فنی آماده پاسخگویی است.\nاز دکمه زیر جهت ارتباط مستقیم استفاده نمایید:"
    }
};

function t(key, tone, replacements = {}) {
    let msg = (TONE_MESSAGES[key] && TONE_MESSAGES[key][tone]) ? TONE_MESSAGES[key][tone] : (TONE_MESSAGES[key]?.friendly || key);
    for (const [k, v] of Object.entries(replacements)) {
        msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    return msg;
}

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

    return { dateStr: dateStr, timeStr: timeStr, full: `📅 تاریخ: ${dateStr} | ⏰ ساعت: ${timeStr}` };
}

function formatRemainingTime(rawExpire, planId = null) {
    if (planId === -1) {
        return 'تست رایگان (۱ ساعت)';
    }
    if (!rawExpire || rawExpire === 0 || rawExpire === '0') {
        return 'نامحدود (بدون انقضا)';
    }

    let expireSec = 0;
    if (typeof rawExpire === 'number') {
        expireSec = rawExpire > 10000000000 ? Math.floor(rawExpire / 1000) : rawExpire;
    } else if (typeof rawExpire === 'string') {
        const clean = rawExpire.trim();
        if (/^\d+$/.test(clean)) {
            const num = Number(clean);
            expireSec = num > 10000000000 ? Math.floor(num / 1000) : num;
        } else {
            const parsed = Date.parse(clean.replace(' ', 'T'));
            if (!isNaN(parsed)) {
                expireSec = Math.floor(parsed / 1000);
            }
        }
    }

    if (!expireSec || isNaN(expireSec)) {
        return 'نامشخص';
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const diffSec = expireSec - nowSec;

    if (diffSec <= 0) {
        return 'منقضی شده';
    }

    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);

    if (days > 0) {
        return `${days} روز و ${hours} ساعت و ${mins} دقیقه`;
    } else if (hours > 0) {
        return `${hours} ساعت و ${mins} دقیقه`;
    } else {
        return `${mins} دقیقه`;
    }
}

async function checkChannelMembership(bot, chatId, userId) {
    try {
        if (!process.env.CHANNEL_ID) return true;
        const chatMember = await bot.getChatMember(process.env.CHANNEL_ID, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        return false;
    }
}

async function notifyAllAdmins(bot, messageText, media = null) {
    try {
        const [dbAdmins] = await pool.query('SELECT telegram_id FROM users WHERE role = "admin"');
        const adminIds = new Set(dbAdmins.map(a => a.telegram_id.toString()));

        const superAdmins = getSuperAdmins();
        if (superAdmins.length > 0) {
            const [superRows] = await pool.query('SELECT telegram_id FROM users WHERE username IN (?)', [superAdmins]);
            superRows.forEach(r => adminIds.add(r.telegram_id.toString()));
        }

        for (const adminId of adminIds) {
            try {
                if (media && media.photo) {
                    await bot.sendPhoto(adminId, media.photo, { caption: messageText, parse_mode: 'Markdown', reply_markup: media.reply_markup });
                } else if (media && media.document) {
                    await bot.sendDocument(adminId, media.document, { caption: messageText, parse_mode: 'Markdown', reply_markup: media.reply_markup });
                } else {
                    await bot.sendMessage(adminId, messageText, { parse_mode: 'Markdown', reply_markup: media ? media.reply_markup : undefined });
                }
            } catch (e) {}
        }
    } catch (err) {
        console.error('[User.js] خطا در ارسال اعلان به مدیران:', err.message);
    }
}

async function sendUserMenu(bot, chatId, isAdmin = false) {
    const tone = await getBotTone();
    const keyboard = [
        ['🚀 خرید کانفیگ', '🎁 تست رایگان'],
        ['🔗 لینک رفرال', '📖 راهنمای اتصال'],
        ['📜 تاریخچه تراکنش ها', '💰 کیف پول'],
        ['👨‍💻 پشتیبانی', '🔄 استارت مجدد']
    ];
    if (isAdmin) keyboard.push(['🔀👑 سوییچ به پنل ادمین']);

    bot.sendMessage(chatId, t('welcome', tone), {
        reply_markup: { keyboard: keyboard, resize_keyboard: true }
    });
}

async function handleUserCommands(bot, msg, isAdmin, userStates) {
    const text = msg.text;
    const chatId = msg.chat.id;
    const tone = await getBotTone();
    const botUsername = (process.env.BOT_USERNAME || 'bot').replace('@', '');
    const channelId = process.env.CHANNEL_ID || '@Channel';
    const supportId = (process.env.SUPPORT_USERNAME || 'support').replace('@', '');

    switch (text) {
        case '🚀 خرید کانفیگ':
            await ensureDefaultPlans();
            bot.sendMessage(chatId, t('choose_category', tone), {
                reply_markup: { inline_keyboard: [
                    [{ text: '📊 خرید پلن حجمی', callback_data: 'usr_buy_vol' }],
                    [{ text: '♾ خرید پلن نامحدود', callback_data: 'usr_buy_unlimit' }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
                ]}
            });
            break;

        case '🎁 تست رایگان':
            const [userDataCheck] = await pool.query('SELECT has_used_freetest FROM users WHERE telegram_id = ?', [chatId]);
            const hasUsed = userDataCheck.length > 0 ? userDataCheck[0].has_used_freetest : 0;
            const [existTest] = await pool.query('SELECT id FROM orders WHERE telegram_id = ? AND plan_id = -1', [chatId]);

            if (hasUsed || existTest.length > 0) {
                return bot.sendMessage(chatId, t('already_used_trial', tone));
            }
            userStates[chatId] = { step: 'wait_freetest_subname' };
            bot.sendMessage(chatId, t('trial_name_prompt', tone), {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
            break;

        case '🔗 لینک رفرال':
            const [userData] = await pool.query('SELECT referral_count, wallet_balance FROM users WHERE telegram_id = ?', [chatId]);
            const refCount = userData.length > 0 ? (userData[0].referral_count || 0) : 0;
            const refLink = `https://t.me/${botUsername}?start=${chatId}`;
            const dtRef = getPersianDateTime();

            let refText = `${dtRef.full}\n📢 کانال رسمی ما: ${channelId}\n\n` +
                `🔗 **لینک دعوت اختصاصی شما:**\n\`${refLink}\`\n\n` +
                `👥 **تعداد کاربران جذب‌شده:** ${refCount} نفر\n\n` +
                `💎 **طرح ویژه نمایندگی و کسب درآمد:**\n` +
                `با ارسال لینک دعوت به دوستان خود، **۱۰٪ از مبلغ هر خرید آن‌ها** به شکل دائمی و نقدی به کیف پول شما واریز خواهد شد!`;

            let refButtons = [
                [{ text: '📋 کپی لینک رفرال', callback_data: 'usr_copy_ref' }],
                [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
            ];

            bot.sendMessage(chatId, refText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: refButtons }
            });
            break;

        case '📖 راهنمای اتصال':
            const [settings] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "connection_guide"');
            bot.sendMessage(chatId, settings.length > 0 ? settings[0].setting_value : "هنوز راهنمایی برای اتصال تنظیم نشده است.");
            break;

        case '📜 تاریخچه تراکنش ها':
            bot.sendMessage(chatId, "بخش گزارش مورد نظر خود را انتخاب نمایید:", {
                reply_markup: { inline_keyboard: [
                    [{ text: '🌐 مشاهده کانفیگ‌های من', callback_data: 'usr_hist_conf' }],
                    [{ text: '💳 تراکنش‌های شارژ کیف پول', callback_data: 'usr_hist_wallet_tx' }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
                ]}
            });
            break;

        case '💰 کیف پول':
            renderUserWalletDashboard(bot, chatId);
            break;

        case '👨‍💻 پشتیبانی':
            bot.sendMessage(chatId, t('support_prompt', tone), {
                reply_markup: { inline_keyboard: [
                    [{ text: '🟢 ارتباط مستقیم با پشتیبانی', url: `https://t.me/${supportId}` }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
                ] }
            });
            break;

        case '🔄 استارت مجدد':
            bot.sendMessage(chatId, "ربات با موفقیت رفرش شد.");
            sendUserMenu(bot, chatId, isAdmin);
            break;
    }
}

async function renderUserWalletDashboard(bot, chatId, messageId = null) {
    const dt = getPersianDateTime();
    const [uWallet] = await pool.query('SELECT username, wallet_balance FROM users WHERE telegram_id = ?', [chatId]);
    const balance = uWallet.length > 0 ? (uWallet[0].wallet_balance || 0) : 0;
    const uName = uWallet.length > 0 && uWallet[0].username ? '@' + uWallet[0].username : 'ثبت‌نشده';

    const [[{chargeSuccessCount}]] = await pool.query('SELECT COUNT(*) as chargeSuccessCount FROM orders WHERE telegram_id = ? AND order_type = "wallet_charge" AND status = "approved"', [chatId]);
    const [[{chargePendingCount}]] = await pool.query('SELECT COUNT(*) as chargePendingCount FROM orders WHERE telegram_id = ? AND order_type = "wallet_charge" AND status = "pending"', [chatId]);

    const txt = '💰 **داشبورد هوشمند کیف پول شما:**\n\n' +
        `👤 **آیدی کاربری:** ${uName} (\`${chatId}\`)\n` +
        `${dt.full}\n\n` +
        `💎 **موجودی فعلی شما:** **${Number(balance).toLocaleString('fa-IR')} تومان**\n` +
        `✅ **تعداد دفعات شارژ موفق:** ${(Number(chargeSuccessCount) || 0).toLocaleString('fa-IR')} مرتبه\n` +
        `⏳ **شارژهای در حال بررسی:** ${(Number(chargePendingCount) || 0).toLocaleString('fa-IR')} تراکنش\n\n` +
        'جهت شارژ موجودی، درخواست تسویه درآمد رفرال یا مشاهده فاکتورها، یکی از گزینه‌های زیر را انتخاب کنید:';

    const inlineKeyboard = [
        [
            { text: '💳 شارژ کیف پول', callback_data: 'usr_charge_wallet_menu' },
            { text: '💸 درخواست تسویه حساب (برداشت وجه)', callback_data: 'usr_request_payout' }
        ],
        [{ text: '📜 مشاهده تراکنش‌های شارژ', callback_data: 'usr_hist_wallet_tx' }],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
    ];

    if (messageId) {
        bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } })
            .catch(async () => {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            });
    } else {
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

function renderInvoiceMessage(state) {
    const dt = getPersianDateTime();
    let finalPrice = state.planPrice;
    let discText = "";

    if (state.activeDiscount) {
        const d = state.activeDiscount;
        let discAmount = 0;
        if (d.discount_type === 'percent') {
            discAmount = Math.floor((state.planPrice * d.amount) / 100);
            discText = `\n🎁 تخفیف اعمال شده (${d.amount}٪): ${discAmount.toLocaleString('fa-IR')} تومان`;
        } else {
            discAmount = d.amount;
            discText = `\n🎁 تخفیف اعمال شده: ${Number(discAmount).toLocaleString('fa-IR')} تومان`;
        }
        finalPrice -= discAmount;
        if (finalPrice < 0) finalPrice = 0;
    }

    state.finalPrice = finalPrice;

    const titlePrefix = state.isRenewal ? 'تمدید اشتراک' : 'خرید کانفیگ';
    const inv = `🧾 **پیش‌فاکتور ${titlePrefix}:**\n\n` +
        `${dt.full}\n` +
        `🔹 **پروفایل ساب‌اسکریپشن:** \`${state.subName}\`\n` +
        `📦 **پلن انتخابی:** ${state.planTitle}\n` +
        `💰 **قیمت اصلی پلن:** ${Number(state.planPrice).toLocaleString('fa-IR')} تومان${discText}\n` +
        `💳 **مبلغ نهایی قابل پرداخت:** ${Number(finalPrice).toLocaleString('fa-IR')} تومان\n\n` +
        'روش پرداخت خود را انتخاب کنید یا کد تخفیف را وارد نمایید:';

    const keyboard = [
        [{ text: '🎁 اعمال کد تخفیف', callback_data: 'usr_apply_discount_code' }],
        [{ text: '💳 پرداخت کارت به کارت', callback_data: 'usr_paycard' }],
        [{ text: '💰 پرداخت از کیف پول', callback_data: 'usr_paywallet' }],
        [{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]
    ];

    return { text: inv, keyboard: keyboard };
}

async function handleUserStates(bot, msg, userStates, chatId) {
    const state = userStates[chatId];
    if (!state) return;

    const text = msg.text ? msg.text.trim() : '';
    const tone = await getBotTone();
    const cardNumber = process.env.CARD_NUMBER || '0000000000000000';
    const cardHolder = process.env.CARD_HOLDER || 'صاحب حساب';

    if (text === '/cancel') {
        delete userStates[chatId];
        return bot.sendMessage(chatId, "عملیات با موفقیت لغو شد.", { reply_markup: { inline_keyboard: [[{ text: 'بازگشت به منو', callback_data: 'back_to_main' }]] } });
    }

    if (state.step === 'wait_freetest_subname') {
        const subName = text;
        if (!/^[a-zA-Z0-9_]{1,12}$/.test(subName)) {
            return bot.sendMessage(chatId, "❌ نام ساب باید فقط شامل حروف یا اعداد انگلیسی (حداکثر ۱۲ کاراکتر) باشد. مجدداً ارسال کنید:");
        }

        const [existingOrders] = await pool.query('SELECT id FROM orders WHERE sub_name = ?', [subName]);
        if (existingOrders.length > 0) {
            return bot.sendMessage(chatId, "❌ این نام قبلاً ثبت شده است. لطفاً شناسه دیگری انتخاب فرمایید:");
        }

        bot.sendMessage(chatId, "⏳ اشتراک تست ۱ ساعته شما در حال صدور می‌باشد، لطفاً شکیبا باشید...");
        
        const panelRes = await createConfigOnPanel(subName, 0, 60, 'minutes', 1, true);
        
        if (panelRes.success) {
            await pool.query(
                'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, sub_link, order_type) VALUES (?, -1, 0, "approved", ?, ?, "config")',
                [chatId, subName, panelRes.link]
            );
            await pool.query('UPDATE users SET has_used_freetest = 1 WHERE telegram_id = ?', [chatId]);
            bot.sendMessage(chatId, t('trial_success', tone, { link: panelRes.link }), { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `❌ خطا در اتصال به سرور: ${panelRes.error || 'لطفاً مجدداً تلاش کنید'}`);
        }
        delete userStates[chatId];
    }

    else if (state.step === 'wait_payout_amount') {
        const cleanAmount = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (isNaN(cleanAmount) || cleanAmount < 50000) {
            return bot.sendMessage(chatId, "⚠️ حداقل مبلغ مجاز برای تسویه حساب **۵۰,۰۰۰ تومان** می‌باشد. لطفاً مبلغ معتبر را مجدداً وارد فرمایید:\n(جهت انصراف: /cancel)", { parse_mode: 'Markdown' });
        }
        if (cleanAmount > state.maxBalance) {
            return bot.sendMessage(chatId, `⚠️ مبلغ واردشده بیشتر از مانده حساب شما است!\nحداکثر موجودی قابل تسویه: **${Number(state.maxBalance).toLocaleString('fa-IR')} تومان**\nمبلغ دیگری وارد نمایید:`, { parse_mode: 'Markdown' });
        }

        userStates[chatId] = {
            step: 'wait_payout_details',
            amount: cleanAmount
        };

        bot.sendMessage(chatId, `💰 مبلغ درخواستی: **${Number(cleanAmount).toLocaleString('fa-IR')} تومان**\n\nلطفاً **شماره کارت یا شماره شبا** به همراه **نام و نام خانوادگی صاحب حساب** را در یک پیام ارسال فرمایید:\n\nمثال:\n\`60379981... بنام علی محمدی\`\n(جهت لغو: /cancel)`, { parse_mode: 'Markdown' });
    }

    else if (state.step === 'wait_payout_details') {
        if (text.length < 5) {
            return bot.sendMessage(chatId, "❌ لطفاً شماره شبا/کارت و نام کامل صاحب حساب را به شکل دقیق ارسال نمایید:");
        }

        await pool.query('UPDATE users SET wallet_balance = wallet_balance - ? WHERE telegram_id = ?', [state.amount, chatId]);
        const [wRes] = await pool.query(
            'INSERT INTO withdrawals (telegram_id, amount, card_or_sheba, full_name, status) VALUES (?, ?, ?, ?, "pending")',
            [chatId, state.amount, text, msg.from.first_name || 'کاربر']
        );

        const dt = getPersianDateTime();
        const userTag = msg.from.username ? '@' + msg.from.username : 'بدون_یوزرنیم';

        bot.sendMessage(chatId, `✅ **درخواست تسویه حساب شما ثبت گردید!**\n\n` +
            `🔹 شناسه پیگیری: #${wRes.insertId}\n` +
            `💰 مبلغ: **${Number(state.amount).toLocaleString('fa-IR')} تومان**\n` +
            `💳 مشخصات حساب: ${text}\n` +
            `${dt.full}\n\n` +
            `درخواست شما به مدیریت ارسال شد و پس از واریز بانکی، نتیجه به شما اعلام خواهد شد.`, { parse_mode: 'Markdown' });

        const adminPayoutNotice = `🔔 **درخواست جدید تسویه حساب کاربر:**\n\n` +
            `🔹 کد پیگیری: #${wRes.insertId}\n` +
            `👤 کاربر: ${userTag} (\`${chatId}\`)\n` +
            `💰 مبلغ: **${Number(state.amount).toLocaleString('fa-IR')} تومان**\n` +
            `💳 مشخصات بانکی: \`${text}\`\n` +
            `${dt.full}`;

        const adminMarkup = {
            inline_keyboard: [
                [
                    { text: '✅ تایید و تسویه شد', callback_data: `adm_approve_withdraw_${wRes.insertId}` },
                    { text: '❌ رد و برگشت وجه', callback_data: `adm_reject_withdraw_${wRes.insertId}` }
                ]
            ]
        };

        notifyAllAdmins(bot, adminPayoutNotice, { reply_markup: adminMarkup });
        delete userStates[chatId];
    }

    else if (state.step === 'wait_custom_wallet_amount') {
        const cleanAmount = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (isNaN(cleanAmount) || cleanAmount < 10000) {
            return bot.sendMessage(chatId, "❌ حداقل مبلغ شارژ ۱۰,۰۰۰ تومان می‌باشد. لطفاً مجدداً مبلغ را ارسال فرمایید:\n(انصراف: /cancel)");
        }

        userStates[chatId] = { step: 'wait_charge_receipt', amount: cleanAmount };
        const dt = getPersianDateTime();

        const payMsg = '🧾 **پیش‌فاکتور شارژ کیف پول:**\n\n' +
            `${dt.full}\n` +
            `💰 **مبلغ واریزی:** ${Number(cleanAmount).toLocaleString('fa-IR')} تومان\n\n` +
            `💳 **شماره کارت جهت واریز:**\n\`${cardNumber}\`\nبه نام: ${cardHolder}\n\n` +
            '📸 لطفاً تصویر رسید، فایل پی‌دی‌اف یا **شماره پیگیری متنی** خود را ارسال فرمایید:';

        bot.sendMessage(chatId, payMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]] }});
    }

    else if (state.step === 'wait_invoice_discount_code') {
        const inputCode = text.toUpperCase();
        const [discs] = await pool.query('SELECT * FROM discounts WHERE code = ?', [inputCode]);

        if (discs.length === 0) {
            bot.sendMessage(chatId, "❌ این کد تخفیف معتبر نمی‌باشد.");
        } else {
            const disc = discs[0];
            const now = new Date();

            if (disc.status === 'expired' || (disc.expires_at && new Date(disc.expires_at) < now)) {
                bot.sendMessage(chatId, "⚠️ مهلت استفاده از این کد تخفیف به پایان رسیده است.");
            } else {
                let usedByArr = [];
                try {
                    usedByArr = disc.used_by ? JSON.parse(disc.used_by) : [];
                } catch (e) {
                    usedByArr = [];
                }

                if (usedByArr.includes(chatId)) {
                    bot.sendMessage(chatId, "⚠️ شما قبلاً یک‌بار از این کد تخفیف استفاده کرده‌اید.");
                } else {
                    state.activeDiscount = disc;
                    bot.sendMessage(chatId, "✅ کد تخفیف با موفقیت روی فاکتور شما اعمال گردید.");
                }
            }
        }

        state.step = 'buy_plan_invoice';
        const invData = renderInvoiceMessage(state);
        bot.sendMessage(chatId, invData.text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: invData.keyboard } });
    }

    else if (state.step === 'wait_transfer_target') {
        const targetInput = text.replace('@', '');
        const [targetUser] = await pool.query(
            'SELECT telegram_id, username FROM users WHERE telegram_id = ? OR username = ?',
            [targetInput, targetInput]
        );

        if (targetUser.length === 0) {
            return bot.sendMessage(chatId, "❌ کاربر مقصد پیدا نشد. مطمئن شوید که ایشان حداقل یک‌بار ربات را استارت کرده باشند:\n(انصراف: /cancel)");
        }

        const targetId = targetUser[0].telegram_id;
        if (String(targetId) === String(chatId)) {
            return bot.sendMessage(chatId, "❌ امکان انتقال اشتراک به حساب خودتان وجود ندارد!");
        }

        const [orders] = await pool.query(
            'SELECT o.*, c.title as plan_title, c.plan_type FROM orders o LEFT JOIN configs c ON o.plan_id = c.id WHERE o.id = ?',
            [state.orderId]
        );

        if (orders.length === 0) {
            delete userStates[chatId];
            return bot.sendMessage(chatId, "❌ اطلاعات این اشتراک یافت نشد.");
        }

        const order = orders[0];
        bot.sendMessage(chatId, "⏳ در حال ابطال لینک قبلی و صدور لینک جدید برای دریافت‌کننده...");

        const newSubName = `sub_${Math.random().toString(36).substring(2, 8)}_${targetId.toString().slice(-4)}`;
        const transferRes = await transferConfigOnPanel(order.sub_name, newSubName);

        if (!transferRes.success) {
            delete userStates[chatId];
            return bot.sendMessage(chatId, `❌ انتقال اشتراک با خطا مواجه شد: ${transferRes.error}`);
        }

        await pool.query('UPDATE orders SET telegram_id = ?, sub_name = ?, sub_link = ? WHERE id = ?', [targetId, newSubName, transferRes.link, state.orderId]);

        const dt = getPersianDateTime();
        const planName = order.plan_title || (order.plan_id === -1 ? 'تست رایگان' : (order.plan_id === 0 ? 'هدیه دعوت' : 'کانفیگ سفارشی'));
        const configType = order.plan_type === 'volume' ? 'حجمی (کاربر نامحدود)' : (order.plan_type === 'unlimited' ? 'نامحدود (۵ کاربره)' : 'سفارشی');
        
        const senderUsername = msg.from.username ? '@' + msg.from.username : 'بدون یوزرنیم';
        const receiverUsername = targetUser[0].username ? '@' + targetUser[0].username : 'بدون یوزرنیم';

        const successReceipt = '✅ **انتقال امن اشتراک با موفقیت انجام شد!**\n\n' +
            '🔒 **توجه امنیتی:** اشتراک قبلی شما غیرفعال و لینک قدیمی آن باطل گردید.\n\n' +
            '📋 **رسید انتقال اشتراک:**\n' +
            `${dt.full}\n\n` +
            `🏷 **نام ساب‌اسکریپشن جدید:** \`${newSubName}\`\n` +
            `📦 **پلن:** ${planName}\n` +
            `🌐 **نوع اشتراک:** ${configType}\n\n` +
            '🎯 **اطلاعات دریافت‌کننده (مالک جدید):**\n' +
            `▪️ آیدی تلگرام: \`${targetId}\`\n` +
            `▪️ یوزرنیم: ${receiverUsername}`;

        bot.sendMessage(chatId, successReceipt, { parse_mode: 'Markdown' });

        const recipientNotice = '🎁 **کاربر گرامی، یک اشتراک فعال به حساب شما منتقل گردید!**\n\n' +
            '📋 **مشخصات اشتراک دریافتی:**\n' +
            `${dt.full}\n\n` +
            `🏷 **نام ساب‌اسکریپشن:** \`${newSubName}\`\n` +
            `📦 **پلن:** ${planName}\n` +
            `🌐 **نوع اشتراک:** ${configType}\n` +
            `👤 **انتقال‌دهنده:** ${senderUsername} (\`${chatId}\`)\n\n` +
            `🌐 **لینک اختصاصی اتصال شما:**\n\`${transferRes.link}\``;

        try {
            bot.sendMessage(targetId, recipientNotice, { parse_mode: 'Markdown' });
        } catch (e) {}

        delete userStates[chatId];
    }

    else if (state.step === 'buy_plan_subname') {
        const subName = text;
        if (!/^[a-zA-Z0-9_]{3,30}$/.test(subName)) {
            return bot.sendMessage(chatId, "❌ نام ساب باید فقط حروف انگلیسی و عدد (بین ۳ تا ۳۰ کاراکتر) باشد. مجدداً ارسال فرمایید:");
        }

        const [existingOrders] = await pool.query('SELECT id FROM orders WHERE sub_name = ? AND status != "deleted"', [subName]);
        if (existingOrders.length > 0) {
            return bot.sendMessage(chatId, "❌ این نام قبلاً ثبت شده است. لطفاً نام دیگری انتخاب فرمایید:");
        }
        
        state.subName = subName;
        state.step = 'buy_plan_invoice';
        
        const invData = renderInvoiceMessage(state);
        bot.sendMessage(chatId, invData.text, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: invData.keyboard }
        });
    }

    // ثبت فیش پرداختی با نگهداری دقیق نوع سفارش (تمدید تجمیعی یا خرید)
    else if (state.step === 'wait_plan_receipt') {
        const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : (msg.document ? msg.document.file_id : null);
        const receiptText = (!fileId && text) ? text : null;

        if (fileId || receiptText) {
            const orderType = state.isRenewal ? 'renewal' : 'config';
            const [ins] = await pool.query(
                'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, receipt_file_id, receipt_text, order_type) VALUES (?, ?, ?, "pending", ?, ?, ?, ?)',
                [chatId, state.planId, state.finalPrice, state.subName, fileId, receiptText, orderType]
            );
            
            if (state.activeDiscount) {
                let usedArr = [];
                try {
                    usedArr = state.activeDiscount.used_by ? JSON.parse(state.activeDiscount.used_by) : [];
                } catch (e) {
                    usedArr = [];
                }
                usedArr.push(chatId);
                await pool.query('UPDATE discounts SET used_by = ? WHERE id = ?', [JSON.stringify(usedArr), state.activeDiscount.id]);
            }

            const senderUser = msg.from.username ? '@' + msg.from.username : 'بدون_یوزرنیم';
            const orderTitle = state.isRenewal ? '🔄 **فیش واریزی تمدید اشتراک:**' : '🧾 **فیش واریزی خرید کانفیگ جدید:**';

            let adminMsg = `${orderTitle}\n\n` +
                `👤 کاربر: ${senderUser} | \`${chatId}\`\n` +
                `📦 پلن: ${state.planTitle}\n` +
                `🏷 نام ساب: \`${state.subName}\`\n` +
                `💰 مبلغ: **${Number(state.finalPrice).toLocaleString('fa-IR')} تومان**`;

            if (receiptText) {
                adminMsg += `\n\n📝 شماره پیگیری / متن فیش:\n\`${receiptText}\``;
            }

            const markup = { inline_keyboard: [[{ text: '✅ تایید سفارش', callback_data: `adm_approve_order_${ins.insertId}` }, { text: '❌ رد سفارش', callback_data: `adm_reject_order_${ins.insertId}` }]] };
            const mediaPayload = msg.photo ? { photo: fileId, reply_markup: markup } : (msg.document ? { document: fileId, reply_markup: markup } : { reply_markup: markup });
            notifyAllAdmins(bot, adminMsg, mediaPayload);
            
            bot.sendMessage(chatId, "رسید پرداخت با موفقیت ثبت شد. پس از تایید مدیریت، اشتراک فعال/تمدید خواهد شد.");
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "لطفاً عکس فیش، فایل پی‌دی‌اف یا شماره پیگیری متنی را ارسال فرمایید:");
        }
    }
    
    else if (state.step === 'wait_charge_receipt') {
        const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : (msg.document ? msg.document.file_id : null);
        const receiptText = (!fileId && text) ? text : null;

        if (fileId || receiptText) {
            const dt = getPersianDateTime();
            const userTag = msg.from.username ? '@' + msg.from.username : 'بدون_یوزرنیم';

            const [ins] = await pool.query(
                'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, receipt_file_id, receipt_text, order_type) VALUES (?, -2, ?, "pending", "شارژ کیف پول", ?, ?, "wallet_charge")',
                [chatId, state.amount, fileId, receiptText]
            );

            let adminMsg = '📥 **درخواست جدید شارژ کیف پول:**\n\n' +
                `👤 کاربر: ${userTag} (\`${chatId}\`)\n` +
                `💰 مبلغ درخواستی: **${parseInt(state.amount, 10).toLocaleString('fa-IR')} تومان**\n` +
                `${dt.full}`;

            if (receiptText) {
                adminMsg += `\n\n📝 شماره پیگیری / رسید متنی:\n\`${receiptText}\``;
            }

            const inlineBtns = [
                [
                    { text: '✅ تایید شارژ', callback_data: `adm_approve_order_${ins.insertId}` },
                    { text: '❌ رد شارژ', callback_data: `adm_reject_order_${ins.insertId}` }
                ]
            ];

            const mediaPayload = msg.photo ? { photo: fileId, reply_markup: { inline_keyboard: inlineBtns } } : (msg.document ? { document: fileId, reply_markup: { inline_keyboard: inlineBtns } } : { reply_markup: { inline_keyboard: inlineBtns } });
            notifyAllAdmins(bot, adminMsg, mediaPayload);

            bot.sendMessage(chatId, "رسید واریزی برای پشتیبانی ارسال گردید. پس از تایید، موجودی شما افزایش خواهد یافت.");
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "لطفاً تصویر فیش واریزی یا شماره پیگیری متنی را ارسال فرمایید.");
        }
    }
}

async function handleUserCallbacks(bot, query, userStates) {
    const data = query.data;
    const chatId = query.message.chat.id;
    const botUsername = (process.env.BOT_USERNAME || 'bot').replace('@', '');
    const channelId = process.env.CHANNEL_ID || '@Channel';
    const cardNumber = process.env.CARD_NUMBER || '0000000000000000';
    const cardHolder = process.env.CARD_HOLDER || 'صاحب حساب';

    bot.answerCallbackQuery(query.id).catch(() => {});

    if (data === 'back_to_main') {
        if (userStates[chatId]) delete userStates[chatId];
        bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        const [u] = await pool.query('SELECT role, username FROM users WHERE telegram_id = ?', [chatId]);
        const validSuperAdmins = getSuperAdmins();
        const isSuper = (u.length > 0 && u[0].role === 'admin') || (u.length > 0 && u[0].username && validSuperAdmins.includes(u[0].username.toLowerCase()));
        return sendUserMenu(bot, chatId, isSuper); 
    }

    if (data === 'usr_copy_ref') {
        const refLink = `https://t.me/${botUsername}?start=${chatId}`;
        const shareText = `🚀 تجربه اینترنت پایدار و پرسرعت با ربات ما:\n${refLink}\n\n📢 کانال رسمی: ${channelId}`;
        bot.sendMessage(chatId, `📋 متن آماده دعوت (جهت کپی روی کادر زیر بزنید):\n\n\`${shareText}\``, { parse_mode: 'Markdown' });
    }

    else if (data === 'usr_request_payout') {
        const [uRows] = await pool.query('SELECT wallet_balance FROM users WHERE telegram_id = ?', [chatId]);
        const currentBalance = uRows.length > 0 ? (uRows[0].wallet_balance || 0) : 0;

        if (currentBalance < 50000) {
            return bot.sendMessage(chatId, `⚠️ **موجودی ناکافی جهت تسویه حساب:**\n\nحداقل موجودی مجاز برای تسویه **۵۰,۰۰۰ تومان** می‌باشد.\nموجودی فعلی شما: **${Number(currentBalance).toLocaleString('fa-IR')} تومان** است.`, { parse_mode: 'Markdown' });
        }

        userStates[chatId] = {
            step: 'wait_payout_amount',
            maxBalance: currentBalance
        };

        bot.sendMessage(chatId, `💳 **درخواست تسویه حساب و برداشت موجودی:**\n\nموجودی در دسترس: **${Number(currentBalance).toLocaleString('fa-IR')} تومان**\n\nلطفاً مبلغ مورد نظر را به تومان وارد فرمایید (حداقل ۵۰,۰۰۰ تومان):\n(جهت انصراف: /cancel)`, { parse_mode: 'Markdown' });
    }

    else if (data === 'usr_charge_wallet_menu') {
        bot.sendMessage(chatId, "مبلغ مورد نظر جهت افزایش موجودی را انتخاب فرمایید یا گزینه دلخواه را بزنید:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '۱۰۰,۰۰۰ تومان', callback_data: 'usr_wallet_amt_100000' }, { text: '۲۰۰,۰۰۰ تومان', callback_data: 'usr_wallet_amt_200000' }],
                    [{ text: '۳۰۰,۰۰۰ تومان', callback_data: 'usr_wallet_amt_300000' }, { text: '۵۰۰,۰۰۰ تومان', callback_data: 'usr_wallet_amt_500000' }],
                    [{ text: '✏️ مبلغ دلخواه', callback_data: 'usr_wallet_custom_amount' }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
                ]
            }
        });
    }

    else if (data === 'usr_wallet_custom_amount') {
        userStates[chatId] = { step: 'wait_custom_wallet_amount' };
        bot.sendMessage(chatId, "لطفاً مبلغ مورد نظر خود را به تومان (حداقل ۱۰,۰۰۰ تومان) ارسال نمایید:\n(جهت انصراف: /cancel)");
    }

    else if (data.startsWith('usr_wallet_amt_')) {
        const selectedAmt = data.split('_')[3];
        const dt = getPersianDateTime();

        const invoiceMsg = '🧾 **پیش‌فاکتور شارژ کیف پول:**\n\n' +
            `${dt.full}\n` +
            `💰 **مبلغ درخواستی:** ${Number(selectedAmt).toLocaleString('fa-IR')} تومان\n\n` +
            `💳 **شماره کارت جهت واریز:**\n\`${cardNumber}\`\nبه نام: ${cardHolder}\n\n` +
            'جهت ارسال رسید یا شماره پیگیری روی دکمه زیر کلیک نمایید:';
        
        bot.sendMessage(chatId, invoiceMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📸 ارسال فیش و پرداخت', callback_data: `usr_pay_card_charge_${selectedAmt}` }],
                    [{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]
                ]
            }
        });
    }

    else if (data.startsWith('usr_pay_card_charge_')) {
        const amt = data.split('_')[4];
        userStates[chatId] = { step: 'wait_charge_receipt', amount: amt };

        const payMsg = `💳 **شماره کارت جهت واریز:**\n\`${cardNumber}\`\nبه نام: ${cardHolder}\n\n💰 **مبلغ قابل واریز:** ${Number(amt).toLocaleString('fa-IR')} تومان\n\n📸 لطفاً تصویر رسید، فایل یا شماره پیگیری متنی خود را ارسال فرمایید:`;
        bot.sendMessage(chatId, payMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_buy_vol') {
        await ensureDefaultPlans();
        const [plans] = await pool.query("SELECT * FROM configs WHERE plan_type='volume' AND (status='active' OR status IS NULL) ORDER BY duration_days ASC, volume ASC");
        if (plans.length === 0) {
            return bot.sendMessage(chatId, "در حال حاضر هیچ پلن حجمی فعالی تعریف نشده است.", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
        }
        let btns = plans.map(p => [{
            text: `📊 ${p.title} | کاربر نامحدود | ${Number(p.price).toLocaleString('fa-IR')} تومان`,
            callback_data: `usr_selplan_${p.id}`
        }]);
        btns.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);
        bot.sendMessage(chatId, "📊 **لیست پلن‌های حجمی:**\nروی پلن مورد نظر کلیک فرمایید:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns }});
    } 

    else if (data === 'usr_buy_unlimit') {
        await ensureDefaultPlans();
        const [plans] = await pool.query("SELECT * FROM configs WHERE plan_type='unlimited' AND (status='active' OR status IS NULL) ORDER BY duration_days ASC");
        if (plans.length === 0) {
            return bot.sendMessage(chatId, "در حال حاضر هیچ پلن نامحدود فعالی تعریف نشده است.", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
        }
        let btns = plans.map(p => [{
            text: `♾ ${p.title} | 5 کاربره | ${Number(p.price).toLocaleString('fa-IR')} تومان`,
            callback_data: `usr_selplan_${p.id}`
        }]);
        btns.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);
        bot.sendMessage(chatId, "♾ **لیست پلن‌های نامحدود:**\nروی پلن مورد نظر کلیک فرمایید:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns }});
    }

    else if (data.startsWith('usr_selplan_')) {
        const pId = data.split('_')[2];
        const [plan] = await pool.query('SELECT * FROM configs WHERE id = ?', [pId]);
        if (plan.length === 0) return bot.sendMessage(chatId, "❌ متاسفانه پلن انتخابی یافت نشد.");
        
        userStates[chatId] = { step: 'buy_plan_subname', planId: pId, planTitle: plan[0].title, planPrice: plan[0].price, activeDiscount: null, isRenewal: false };
        bot.sendMessage(chatId, "یک نام انگلیسی دلخواه برای ساب‌اسکریپشن خود وارد فرمایید:\n(مثال: `myvpn123`)", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_apply_discount_code') {
        if (!userStates[chatId] || !userStates[chatId].planId) {
            return bot.sendMessage(chatId, "⚠️ نشست خرید شما منقضی شده است. لطفاً ابتدا پلن مورد نظر را انتخاب فرمایید.", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
        }
        userStates[chatId].step = 'wait_invoice_discount_code';
        bot.sendMessage(chatId, "کد تخفیف خود را ارسال فرمایید:\n(جهت انصراف /cancel بفرستید)", { reply_markup: { inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_hist_conf') {
        const [orders] = await pool.query(
            'SELECT id, sub_name, status, created_at FROM orders WHERE telegram_id = ? AND (order_type = "config" OR order_type = "renewal" OR order_type IS NULL) AND status = "approved" ORDER BY id DESC',
            [chatId]
        );
        if (orders.length === 0) {
            return bot.sendMessage(chatId, "در حال حاضر هیچ کانفیگ فعالی در حساب شما ثبت نشده است.", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
        }
        let btns = orders.map(o => [{
            text: `🌐 کانفیگ: ${o.sub_name}`,
            callback_data: `usr_view_conf_${o.id}`
        }]);
        btns.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);
        bot.sendMessage(chatId, "لیست اشتراک‌های فعال شما (جهت مشاهده جزئیات کلیک کنید):", {
            reply_markup: { inline_keyboard: btns }
        });
    }

    else if (data === 'usr_hist_wallet_tx') {
        const [walletOrders] = await pool.query(
            'SELECT id, amount, status, created_at FROM orders WHERE telegram_id = ? AND order_type = "wallet_charge" ORDER BY id DESC LIMIT 10',
            [chatId]
        );

        if (walletOrders.length === 0) {
            return bot.sendMessage(chatId, "شما هنوز هیچ تراکنش شارژ کیف پولی ثبت نکرده‌اید.", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
        }

        let btns = walletOrders.map(o => {
            const statusLabel = o.status === 'approved' ? 'تایید شده 🟢' : (o.status === 'pending' ? 'در انتظار 🟡' : 'رد شده 🔴');
            return [{
                text: `سفارش #${o.id} | ${Number(o.amount).toLocaleString('fa-IR')}T | ${statusLabel}`,
                callback_data: `usr_view_wtx_${o.id}`
            }];
        });
        btns.push([{ text: '🔙 بازگشت به کیف پول', callback_data: 'usr_wallet_dash_btn' }]);

        bot.sendMessage(chatId, "📜 **لیست آخرین تراکنش‌های شارژ کیف پول شما:**", {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: btns }
        });
    }

    else if (data === 'usr_wallet_dash_btn') {
        renderUserWalletDashboard(bot, chatId, query.message.message_id);
    }

    else if (data.startsWith('usr_view_wtx_')) {
        const orderId = data.split('_')[3];
        const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND telegram_id = ?', [orderId, chatId]);

        if (rows.length > 0) {
            const o = rows[0];
            const dateStr = o.created_at ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(o.created_at)) : 'نامشخص';
            const statusFa = o.status === 'approved' ? 'موفق و تایید شده 🟢' : (o.status === 'pending' ? 'در حال بررسی توسط ادمین 🟡' : 'رد شده 🔴');

            const txt = '🧾 **فاکتور تراکنش شارژ کیف پول:**\n\n' +
                `🔹 کد پیگیری سفارش: #${o.id}\n` +
                `👤 آیدی کاربری: \`${o.telegram_id}\`\n` +
                `💰 مبلغ شارژ: ${Number(o.amount).toLocaleString('fa-IR')} تومان\n` +
                `📅 تاریخ ثبت: ${dateStr}\n` +
                `📊 وضعیت: ${statusFa}`;

            bot.sendMessage(chatId, txt, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به تراکنش‌ها', callback_data: 'usr_hist_wallet_tx' }]] }
            });
        }
    }

    else if (data.startsWith('usr_view_conf_')) {
        const orderId = data.split('_')[3];
        const [rows] = await pool.query(
            'SELECT o.*, u.username, u.joined_date, c.title as plan_title, c.duration_days FROM orders o LEFT JOIN users u ON o.telegram_id = u.telegram_id LEFT JOIN configs c ON o.plan_id = c.id WHERE o.id = ? AND o.telegram_id = ?',
            [orderId, chatId]
        );

        if (rows.length > 0) {
            const o = rows[0];
            const firstName = query.from.first_name || 'کاربر';
            const usernameTag = o.username ? '@' + o.username : 'بدون_یوزرنیم';
            
            const joinDate = o.joined_date ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(o.joined_date)) : 'نامشخص';
            const buyDate = o.created_at ? new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(o.created_at)) : 'نامشخص';

            const pData = await getUserFromPanel(o.sub_name);
            const remainingStr = formatRemainingTime(pData?.expire, o.plan_id);

            const planTitleStr = o.plan_title || (o.plan_id === -1 ? 'تست رایگان ۱ ساعته' : (o.plan_id === 0 ? 'هدیه دعوت' : 'کانفیگ سفارشی'));

            const cardText = '👤 **اطلاعات حساب کاربر:**\n' +
                `▪️ نام: ${firstName}\n` +
                `▪️ یوزرنیم: ${usernameTag}\n` +
                `📅 تاریخ عضویت: ${joinDate}\n` +
                `🛒 تاریخ خرید: ${buyDate}\n\n` +
                '⚙️ **اطلاعات کانفیگ:**\n' +
                `📦 پلن: ${planTitleStr}\n` +
                `🏷 نام ساب: \`${o.sub_name}\`\n` +
                `⏳ زمان باقی‌مانده: ${remainingStr}\n\n` +
                `🌐 **لینک اتصال ساب:**\n\`${o.sub_link || 'موجود نیست'}\``;

            const inlineBtns = [
                [{ text: '🔄 تمدید افزایشی اشتراک', callback_data: `usr_renew_sub_${o.id}` }],
                [{ text: '❌ حذف اشتراک', callback_data: `usr_delete_sub_${o.id}` }],
                [{ text: '🔀 انتقال امن اشتراک به دوست', callback_data: `usr_transfer_sub_${o.id}` }],
                [{ text: '🔙 بازگشت به لیست', callback_data: 'usr_hist_conf' }]
            ];

            bot.sendMessage(chatId, cardText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineBtns }
            });
        }
    }

    else if (data.startsWith('usr_renew_sub_')) {
        const oId = data.split('_')[3];
        const [orders] = await pool.query('SELECT * FROM orders WHERE id = ? AND telegram_id = ?', [oId, chatId]);
        if (orders.length > 0) {
            const o = orders[0];
            if (o.plan_id === -1 || o.plan_id === 0) {
                return bot.sendMessage(chatId, "پلن‌های رایگان یا هدیه قابل تمدید مستقیم نمی‌باشند. لطفاً اشتراک تجاری تهیه فرمایید.");
            }
            const [plans] = await pool.query('SELECT * FROM configs WHERE id = ?', [o.plan_id]);
            if (plans.length === 0) return bot.sendMessage(chatId, "❌ پلن مربوطه یافت نشد.");
            const plan = plans[0];

            userStates[chatId] = {
                step: 'buy_plan_invoice',
                planId: plan.id,
                planTitle: `تمدید تجمیعی: ${plan.title}`,
                planPrice: plan.price,
                finalPrice: plan.price,
                subName: o.sub_name,
                isRenewal: true,
                orderId: o.id
            };

            const dt = getPersianDateTime();
            const inv = '🧾 **پیش‌فاکتور تمدید تجمیعی اشتراک:**\n\n' +
                `${dt.full}\n` +
                `🏷 **نام ساب‌اسکریپشن:** \`${o.sub_name}\`\n` +
                `📦 **پلن تمدید:** ${plan.title}\n` +
                `⏳ **مدت اضافه شونده:** ${plan.duration_days} روز\n` +
                '💡 **نکته:** زمان و ترافیک این پلن به مانده فعلی اشتراک شما اضافه خواهد شد.\n' +
                `💳 **مبلغ قابل پرداخت:** ${Number(plan.price).toLocaleString('fa-IR')} تومان`;

            bot.sendMessage(chatId, inv, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 پرداخت با شماره کارت', callback_data: 'usr_paycard' }],
                        [{ text: '💰 پرداخت از کیف پول', callback_data: 'usr_paywallet' }],
                        [{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]
                    ]
                }
            });
        }
    }

    else if (data.startsWith('usr_delete_sub_')) {
        const oId = data.split('_')[3];
        const [orders] = await pool.query('SELECT * FROM orders WHERE id = ? AND telegram_id = ?', [oId, chatId]);
        if (orders.length > 0) {
            const o = orders[0];
            await deleteConfigOnPanel(o.sub_name);
            await pool.query('UPDATE orders SET status = "deleted" WHERE id = ?', [oId]);
            bot.sendMessage(chatId, `✅ اشتراک \`${o.sub_name}\` با موفقیت از سرور و لیست شما حذف شد.`, { parse_mode: 'Markdown' });
        }
    }

    else if (data.startsWith('usr_transfer_sub_')) {
        const oId = data.split('_')[3];
        userStates[chatId] = { step: 'wait_transfer_target', orderId: oId };

        const transPrompt = '🔀 **انتقال امن اشتراک به کاربر دیگر:**\n\n' +
            '🔒 **نکته امنیتی بسیار مهم:** پس از انتقال، لینک فعلی در دستگاه شما باطل و غیرفعال خواهد شد و لینک کاملاً جدیدی برای کاربر مقصد صادر می‌گردد.\n\n' +
            'لطفاً **آیدی عددی** یا **یوزرنیم تلگرام** کاربر دریافت‌کننده را ارسال فرمایید:\n(جهت انصراف: /cancel)';

        bot.sendMessage(chatId, transPrompt, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]] }
        });
    }

    else if (data === 'usr_paycard') {
        const state = userStates[chatId];
        if (!state || !state.planId) {
            return bot.sendMessage(chatId, "⚠️ نشست خرید شما منقضی شده است.\nلطفاً پلن مورد نظر را مجدداً از منوی «🚀 خرید کانفیگ» انتخاب فرمایید.", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
        }
        state.step = 'wait_plan_receipt';
        bot.sendMessage(chatId, `💳 **شماره کارت جهت واریز:**\n\`${cardNumber}\`\nبه نام: ${cardHolder}\n\nلطفاً پس از واریز، عکس فیش، فایل پی‌دی‌اف یا **شماره پیگیری متنی** خود را ارسال فرمایید:\n(انصراف: /cancel)`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_paywallet') {
        const state = userStates[chatId];
        if (!state || !state.planId) {
            return bot.sendMessage(chatId, "⚠️ نشست خرید شما منقضی شده است.\nلطفاً پلن مورد نظر را مجدداً از منوی «🚀 خرید کانفیگ» انتخاب فرمایید.", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
        }
        const [user] = await pool.query('SELECT wallet_balance, referred_by FROM users WHERE telegram_id = ?', [chatId]);
        const bal = user.length > 0 ? user[0].wallet_balance : 0;

        if (bal >= state.finalPrice) {
            await pool.query('UPDATE users SET wallet_balance = wallet_balance - ? WHERE telegram_id = ?', [state.finalPrice, chatId]);
            
            if (state.activeDiscount) {
                let usedArr = [];
                try {
                    usedArr = state.activeDiscount.used_by ? JSON.parse(state.activeDiscount.used_by) : [];
                } catch (e) {
                    usedArr = [];
                }
                usedArr.push(chatId);
                await pool.query('UPDATE discounts SET used_by = ? WHERE id = ?', [JSON.stringify(usedArr), state.activeDiscount.id]);
            }

            const [pInfo] = await pool.query('SELECT * FROM configs WHERE id = ?', [state.planId]);
            const plan = pInfo[0];
            const isRenewal = !!state.isRenewal;
            
            const panelRes = await createConfigOnPanel(state.subName, plan.volume || 0, plan.duration_days, 'days', plan.users_count || 1, false, true, isRenewal);
            
            if (panelRes.success) {
                if (state.isRenewal && state.orderId) {
                    await pool.query('UPDATE orders SET status = "approved", sub_link = ? WHERE id = ?', [panelRes.link, state.orderId]);
                } else {
                    const orderType = isRenewal ? 'renewal' : 'config';
                    await pool.query('INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, sub_link, order_type) VALUES (?, ?, ?, "approved", ?, ?, ?)', [chatId, state.planId, state.finalPrice, state.subName, panelRes.link, orderType]);
                }

                const successMsg = isRenewal 
                    ? `🎉 پرداخت با موفقیت از کیف پول کسر شد و روزها و حجم پلن جدید به مانده اعتبار اشتراک \`${state.subName}\` شما افزوده گردید! ❤️`
                    : `🎉 پرداخت با موفقیت از کیف پول کسر شد و کانفیگ فعال گردید!\n\n🌐 **لینک اتصال ساب‌اسکریپشن شما:**\n\`${panelRes.link}\`\n\nامیدواریم از سرعت سرویس نهایت لذت را ببرید ❤️`;

                bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });

                // محاسبه و واریز خودکار ۱۰٪ پورسانت معرف
                if (user.length > 0 && user[0].referred_by) {
                    const referrerId = user[0].referred_by;
                    const commission = Math.floor(Number(state.finalPrice) * 0.10);
                    if (commission > 0) {
                        await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE telegram_id = ?', [commission, referrerId]);
                        bot.sendMessage(referrerId, `🎁 **تبریک! واریز پورسانت نقدی دعوت:**\nیکی از کاربران دعوت‌شده توسط شما خریدی به مبلغ **${Number(state.finalPrice).toLocaleString('fa-IR')} تومان** انجام داد و ۱۰٪ آن یعنی **${Number(commission).toLocaleString('fa-IR')} تومان** به موجودی کیف پول شما واریز گردید! 🌹`, { parse_mode: 'Markdown' }).catch(() => {});
                    }
                }

            } else {
                await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE telegram_id = ?', [state.finalPrice, chatId]);
                bot.sendMessage(chatId, `❌ خطا در پنل سرور: ${panelRes.error || 'عملیات ناموفق بود'}\nمبلغ به موجودی کیف پول شما بازگردانده شد.`);
            }
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "❌ موجودی کیف پول شما برای این خرید کافی نیست. لطفاً ابتدا از بخش «💰 کیف پول» نسبت به شارژ حساب اقدام نمایید.", { reply_markup: { inline_keyboard:[[{text:'🔙 بازگشت به منوی اصلی', callback_data:'back_to_main'}]]}});
        }
    }
}

module.exports = {
    checkChannelMembership,
    sendUserMenu,
    handleUserCommands,
    handleUserCallbacks,
    handleUserStates,
    notifyAllAdmins
};