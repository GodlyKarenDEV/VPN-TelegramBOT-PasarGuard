const { pool } = require('./Database');
const { createConfigOnPanel, deleteConfigOnPanel, getUserFromPanel } = require('./PanelApi');
const { ensureDefaultPlans } = require('./Admin');
require('dotenv').config();

// تاریخ و ساعت رسمی به وقت تهران
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

// تبدیل هوشمند زمان انقضا و رفع خطای NaN
function formatRemainingTime(rawExpire, planId = null) {
    if (planId === -1) {
        return 'تست رایگان (۱۵ دقیقه)';
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
        return days + ' روز و ' + hours + ' ساعت و ' + mins + ' دقیقه';
    } else if (hours > 0) {
        return hours + ' ساعت و ' + mins + ' دقیقه';
    } else {
        return mins + ' دقیقه';
    }
}

// بررسی قفل عضویت اجباری در کانال تلگرام
async function checkChannelMembership(bot, chatId, userId) {
    try {
        if (!process.env.CHANNEL_ID) return true;
        const chatMember = await bot.getChatMember(process.env.CHANNEL_ID, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) { return false; }
}

// ارسال کیبورد منوی اصلی کاربر
function sendUserMenu(bot, chatId, isAdmin = false) {
    const keyboard = [
        ['🚀 خرید کانفیگ', '🎁 تست رایگان'],
        ['🔗 لینک رفرال', '📖 راهنمای اتصال'],
        ['📜 تاریخچه تراکنش ها', '💰 کیف پول'],
        ['👨‍💻 پشتیبانی', '🔄 استارت مجدد']
    ];
    if (isAdmin) keyboard.push(['🔀👑 سوییچ به پنل ادمین']);

    bot.sendMessage(chatId, "سلام دوست من! خیلی خوش اومدی ❤️\nیک گزینه رو انتخاب کن تا با هم بریم جلو:", {
        reply_markup: { keyboard: keyboard, resize_keyboard: true }
    });
}

// پردازش دستورات متنی منوی کاربر
async function handleUserCommands(bot, msg, isAdmin, userStates) {
    const text = msg.text;
    const chatId = msg.chat.id;
    const botUsername = (process.env.BOT_USERNAME || 'bot').replace('@', '');
    const channelId = process.env.CHANNEL_ID || '@Channel';
    const supportId = (process.env.SUPPORT_USERNAME || 'support').replace('@', '');

    switch (text) {
        case '🚀 خرید کانفیگ':
            await ensureDefaultPlans();
            bot.sendMessage(chatId, "رفیق، دسته کانفیگ مورد نظرت رو انتخاب کن:", {
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
                return bot.sendMessage(chatId, "رفیق، شما قبلاً یک‌بار از اشتراک تست رایگان استفاده کردی 🌹\nمی‌تونی از بخش «🚀 خرید کانفیگ» پلن دلخواهت رو انتخاب کنی.");
            }
            userStates[chatId] = { step: 'wait_freetest_subname' };
            bot.sendMessage(chatId, "یک اسم انگلیسی دلخواه (حداکثر ۱۲ کاراکتر) برای کانفیگ تست رایگانت بفرست:\n(مثال: `mytest123`)", {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
            break;

        case '🔗 لینک رفرال':
            const [userData] = await pool.query('SELECT referral_count, claimed_gift FROM users WHERE telegram_id = ?', [chatId]);
            const refCount = userData.length > 0 ? (userData[0].referral_count || 0) : 0;
            const claimedGift = userData.length > 0 ? userData[0].claimed_gift : 0;
            const refLink = 'https://t.me/' + botUsername + '?start=' + chatId;
            const dtRef = getPersianDateTime();

            let refText = dtRef.full + '\n📢 کانال رسمی ما: ' + channelId + '\n\n🔗 لینک دعوت اختصاصی شما:\n' + refLink + '\n\n👥 تعداد دوستان دعوت‌شده توسط شما: ' + refCount + ' نفر\n\n🎁 مژده: با دعوت ۳ نفر از دوستات، یک پلن نامحدود ۷ روزه هدیه می‌گیری رفیق!';

            let refButtons = [
                [{ text: '📋 کپی لینک رفرال', callback_data: 'usr_copy_ref' }]
            ];

            if (refCount >= 3 && !claimedGift) {
                refButtons.push([{ text: '🎁 دریافت هدیه رایگان', callback_data: 'usr_claim_gift' }]);
            }
            refButtons.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);

            bot.sendMessage(chatId, refText, {
                reply_markup: { inline_keyboard: refButtons }
            });
            break;

        case '📖 راهنمای اتصال':
            const [settings] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "connection_guide"');
            bot.sendMessage(chatId, settings.length > 0 ? settings[0].setting_value : "هنوز راهنمایی برای اتصال تنظیم نشده است.");
            break;

        case '📜 تاریخچه تراکنش ها':
            bot.sendMessage(chatId, "چه گزارشی رو می‌خوای ببینی رفیق؟", {
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
            bot.sendMessage(chatId, "هر سوال یا مشکلی داشتی، تیم پشتیبانی با عشق در کنارته ❤️\nروی دکمه زیر کلیک کن تا ارتباط برقرار بشه:", {
                reply_markup: { inline_keyboard: [
                    [{ text: '🟢 ارتباط مستقیم با پشتیبانی', url: 'https://t.me/' + supportId }],
                    [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
                ] }
            });
            break;

        case '🔄 استارت مجدد':
            bot.sendMessage(chatId, "ربات رفرش شد دوست من.");
            sendUserMenu(bot, chatId, isAdmin);
            break;
    }
}

// نمایش وضعیت کیف پول به کاربر
async function renderUserWalletDashboard(bot, chatId, messageId = null) {
    const dt = getPersianDateTime();
    const [uWallet] = await pool.query('SELECT username, wallet_balance FROM users WHERE telegram_id = ?', [chatId]);
    const balance = uWallet.length > 0 ? (uWallet[0].wallet_balance || 0) : 0;
    const uName = uWallet.length > 0 && uWallet[0].username ? '@' + uWallet[0].username : 'ثبت‌نشده';

    const [[{chargeSuccessCount}]] = await pool.query('SELECT COUNT(*) as chargeSuccessCount FROM orders WHERE telegram_id = ? AND order_type = "wallet_charge" AND status = "approved"', [chatId]);
    const [[{chargePendingCount}]] = await pool.query('SELECT COUNT(*) as chargePendingCount FROM orders WHERE telegram_id = ? AND order_type = "wallet_charge" AND status = "pending"', [chatId]);

    const txt = '💰 **داشبورد هوشمند کیف پول شما:**\n\n' +
        '👤 **آیدی کاربری:** ' + uName + ' (' + chatId + ')\n' +
        dt.full + '\n\n' +
        '💎 **موجودی فعلی شما:** ' + Number(balance).toLocaleString('fa-IR') + ' تومان\n' +
        '✅ **تعداد دفعات شارژ موفق:** ' + (Number(chargeSuccessCount) || 0) + ' مرتبه\n' +
        '⏳ **سفارشات شارژ در حال بررسی:** ' + (Number(chargePendingCount) || 0) + ' تراکنش\n\n' +
        'برای افزایش موجودی یا دیدن فاکتورها، یکی از گزینه‌های زیر را انتخاب کنید:';

    const inlineKeyboard = [
        [{ text: '💳 شارژ کیف پول', callback_data: 'usr_charge_wallet_menu' }],
        [{ text: '📜 مشاهده تراکنش‌های شارژ', callback_data: 'usr_hist_wallet_tx' }],
        [{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]
    ];

    if (messageId) {
        bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(() => {});
    } else {
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

// ساخت و نمایش پیش‌فاکتور خرید کانفیگ
function renderInvoiceMessage(state) {
    const dt = getPersianDateTime();
    let finalPrice = state.planPrice;
    let discText = "";

    if (state.activeDiscount) {
        const d = state.activeDiscount;
        let discAmount = 0;
        if (d.discount_type === 'percent') {
            discAmount = Math.floor((state.planPrice * d.amount) / 100);
            discText = '\n🎁 تخفیف اعمال شده (' + d.amount + '٪): ' + discAmount.toLocaleString('fa-IR') + ' تومان';
        } else {
            discAmount = d.amount;
            discText = '\n🎁 تخفیف اعمال شده: ' + Number(discAmount).toLocaleString('fa-IR') + ' تومان';
        }
        finalPrice -= discAmount;
        if (finalPrice < 0) finalPrice = 0;
    }

    state.finalPrice = finalPrice;

    const inv = '🧾 **پیش‌فاکتور خرید کانفیگ:**\n\n' +
        dt.full + '\n' +
        '🔹 **پروفایل ساب‌اسکریپشن:** `' + state.subName + '`\n' +
        '📦 **پلن انتخابی:** ' + state.planTitle + '\n' +
        '💰 **قیمت اصلی پلن:** ' + Number(state.planPrice).toLocaleString('fa-IR') + ' تومان' + discText + '\n' +
        '💳 **مبلغ نهایی قابل پرداخت:** ' + Number(finalPrice).toLocaleString('fa-IR') + ' تومان\n\n' +
        'روش پرداخت خود را انتخاب کنید یا کد تخفیف را وارد نمایید:';

    const keyboard = [
        [{ text: '🎁 اعمال کد تخفیف', callback_data: 'usr_apply_discount_code' }],
        [{ text: '💳 پرداخت کارت به کارت', callback_data: 'usr_paycard' }],
        [{ text: '💰 پرداخت از کیف پول', callback_data: 'usr_paywallet' }],
        [{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]
    ];

    return { text: inv, keyboard: keyboard };
}

// مدیریت مراحل تعاملی کاربر
async function handleUserStates(bot, msg, userStates, chatId) {
    const state = userStates[chatId];
    const text = msg.text;
    const cardNumber = process.env.CARD_NUMBER || '0000000000000000';
    const cardHolder = process.env.CARD_HOLDER || 'صاحب حساب';

    if (text === '/cancel') {
        delete userStates[chatId];
        return bot.sendMessage(chatId, "عملیات لغو شد دوست من.", { reply_markup: { inline_keyboard: [[{ text: 'بازگشت', callback_data: 'back_to_main' }]] } });
    }

    if (state.step === 'wait_freetest_subname') {
        const subName = text.trim();
        if (!/^[a-zA-Z0-9_]{1,12}$/.test(subName)) {
            return bot.sendMessage(chatId, "❌ نام ساب باید فقط حروف یا اعداد انگلیسی (حداکثر ۱۲ کاراکتر) باشه. دوباره امتحان کن:");
        }

        const [existingOrders] = await pool.query('SELECT id FROM orders WHERE sub_name = ?', [subName]);
        if (existingOrders.length > 0) {
            return bot.sendMessage(chatId, "❌ این نام قبلاً رزرو شده رفیق. یه اسم دیگه انتخاب کن:");
        }

        bot.sendMessage(chatId, "⏳ چند لحظه صبر کن، کانفیگ تستت در حال ساخته شدنه...");
        
        const panelRes = await createConfigOnPanel(subName, 0, 15, 'minutes', 1, true);
        
        if (panelRes.success) {
            await pool.query(
                'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, sub_link, order_type) VALUES (?, -1, 0, "approved", ?, ?, "config")',
                [chatId, subName, panelRes.link]
            );
            await pool.query('UPDATE users SET has_used_freetest = 1 WHERE telegram_id = ?', [chatId]);
            bot.sendMessage(chatId, '🎉 ایول! کانفیگ تست ۱۵ دقیقه‌ای شما با موفقیت فعال شد:\n\n🌐 لینک ساب شما:\n`' + panelRes.link + '`\n\nنکته: بعد از ۱۵ دقیقه سرویس به طور خودکار غیرفعال می‌شه.', { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ خطا در اتصال به سرور: ' + (panelRes.error || 'لطفاً دوباره تلاش کن'));
        }
        delete userStates[chatId];
    }

    else if (state.step === 'wait_custom_wallet_amount') {
        const cleanAmount = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (isNaN(cleanAmount) || cleanAmount < 10000) {
            return bot.sendMessage(chatId, "❌ حداقل مبلغ شارژ دلخواه ۱۰,۰۰۰ تومان می‌باشد. لطفاً مجدداً مبلغ را به عدد ارسال کنید:\n(برای انصراف: /cancel)");
        }

        userStates[chatId] = { step: 'wait_charge_receipt', amount: cleanAmount };
        const dt = getPersianDateTime();

        const payMsg = '🧾 **پیش‌فاکتور شارژ کیف پول (مبلغ دلخواه):**\n\n' +
            dt.full + '\n' +
            '💰 **مبلغ واریزی:** ' + Number(cleanAmount).toLocaleString('fa-IR') + ' تومان\n\n' +
            '💳 **شماره کارت جهت واریز:**\n`' + cardNumber + '`\nبه نام: ' + cardHolder + '\n\n' +
            '📸 لطفاً پس از واریز، عکس رسید یا فیش پرداختی خود را ارسال نمایید:';

        bot.sendMessage(chatId, payMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]] }});
    }

    else if (state.step === 'wait_invoice_discount_code') {
        const inputCode = text.trim().toUpperCase();
        const [discs] = await pool.query('SELECT * FROM discounts WHERE code = ?', [inputCode]);

        if (discs.length === 0) {
            bot.sendMessage(chatId, "❌ متاسفانه این کد تخفیف معتبر نیست دوست من.");
        } else {
            const disc = discs[0];
            const now = new Date();

            if (disc.status === 'expired' || (disc.expires_at && new Date(disc.expires_at) < now)) {
                bot.sendMessage(chatId, "⚠️ رفیق، مهلت استفاده از این کد تخفیف به پایان رسیده و منقضی شده است.");
            } else {
                let usedByArr = [];
                try {
                    usedByArr = disc.used_by ? JSON.parse(disc.used_by) : [];
                } catch (e) {
                    usedByArr = [];
                }

                if (usedByArr.includes(chatId)) {
                    bot.sendMessage(chatId, "⚠️️ شما قبلاً یک‌بار از این کد تخفیف برای خرید استفاده کرده‌اید و مجاز به استفاده مجدد نیستید.");
                } else {
                    state.activeDiscount = disc;
                    bot.sendMessage(chatId, "✅ کد تخفیف با موفقیت روی فاکتور شما اعمال شد!");
                }
            }
        }

        state.step = 'buy_plan_invoice';
        const invData = renderInvoiceMessage(state);
        bot.sendMessage(chatId, invData.text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: invData.keyboard } });
    }

    else if (state.step === 'wait_transfer_target') {
        const targetInput = text.trim().replace('@', '');
        const [targetUser] = await pool.query(
            'SELECT telegram_id, username FROM users WHERE telegram_id = ? OR username = ?',
            [targetInput, targetInput]
        );

        if (targetUser.length === 0) {
            return bot.sendMessage(chatId, "❌ کاربر مقصد پیدا نشد. مطمئن شو که اون هم حداقل یک‌بار ربات رو استارت کرده باشه:\n(برای انصراف: /cancel)");
        }

        const targetId = targetUser[0].telegram_id;
        if (String(targetId) === String(chatId)) {
            return bot.sendMessage(chatId, "❌ نمی‌‌تونی اشتراک رو به خودت منتقل کنی رفیق!");
        }

        const [orders] = await pool.query(
            'SELECT o.*, c.title as plan_title, c.plan_type FROM orders o LEFT JOIN configs c ON o.plan_id = c.id WHERE o.id = ?',
            [state.orderId]
        );

        if (orders.length === 0) {
            delete userStates[chatId];
            return bot.sendMessage(chatId, "❌ متاسفانه اطلاعات این سفارش یافت نشد.");
        }

        const order = orders[0];
        const pData = await getUserFromPanel(order.sub_name);
        const remainingStr = formatRemainingTime(pData?.expire, order.plan_id);

        await pool.query('UPDATE orders SET telegram_id = ? WHERE id = ?', [targetId, state.orderId]);

        const dt = getPersianDateTime();
        const planName = order.plan_title || (order.plan_id === -1 ? 'تست رایگان' : (order.plan_id === 0 ? 'هدیه دعوت' : 'کانفیگ سفارشی'));
        const configType = order.plan_type === 'volume' ? 'حجمی (کاربر نامحدود)' : (order.plan_type === 'unlimited' ? 'نامحدود (۵ کاربره)' : 'سفارشی');
        
        const senderUsername = msg.from.username ? '@' + msg.from.username : 'بدون یوزرنیم';
        const receiverUsername = targetUser[0].username ? '@' + targetUser[0].username : 'بدون یوزرنیم';

        const successReceipt = '✅ **انتقال اشتراک با موفقیت انجام شد!**\n\n' +
            '📋 **رسید هوشمند انتقال اشتراک:**\n' +
            dt.full + '\n\n' +
            '🏷 **نام ساب‌اسکریپشن:** `' + order.sub_name + '`\n' +
            '📦 **اسم پلن:** ' + planName + '\n' +
            '🌐 **نوع کانفیگ:** ' + configType + '\n' +
            '⏳ **زمان باقی‌مانده اشتراک:** ' + remainingStr + '\n\n' +
            '👤 **اطلاعات مالک قبلی:**\n' +
            '▪️ آیدی تلگرام: ' + chatId + '\n' +
            '▪️ یوزرنیم: ' + senderUsername + '\n\n' +
            '🎯 **اطلاعات دریافت‌کننده (مالک جدید):**\n' +
            '▪️ آیدی تلگرام: ' + targetId + '\n' +
            '▪️️ یوزرنیم: ' + receiverUsername;

        bot.sendMessage(chatId, successReceipt, { parse_mode: 'Markdown' });

        const recipientNotice = '🎁 **کاربر گرامی، یک اشتراک جدید به حساب شما منتقل گردید!**\n\n' +
            '📋 **مشخصات اشتراک دریافتی:**\n' +
            dt.full + '\n\n' +
            '🏷 **نام ساب‌اسکریپشن:** `' + order.sub_name + '`\n' +
            '📦 **اسم پلن:** ' + planName + '\n' +
            '🌐 **نوع کانفیگ:** ' + configType + '\n' +
            '⏳ **زمان باقی‌مانده:** ' + remainingStr + '\n\n' +
            '👤 **انتقال‌دهنده:** ' + senderUsername + ' (' + chatId + ')\n' +
            '🌐 **لینک اتصال ساب:**\n`' + (order.sub_link || 'در بخش کانفیگ‌های من موجود است') + '`';

        try {
            bot.sendMessage(targetId, recipientNotice, { parse_mode: 'Markdown' });
        } catch (e) {}

        delete userStates[chatId];
    }

    else if (state.step === 'buy_plan_subname') {
        const subName = text.trim();
        
        if (!/^[a-zA-Z0-9_]{3,30}$/.test(subName)) {
            return bot.sendMessage(chatId, "❌ نام ساب باید فقط حروف انگلیسی و عدد (بدون فاصله) و بین ۳ تا ۳۰ کاراکتر باشه. دوباره بفرست:");
        }

        const [existingOrders] = await pool.query('SELECT id FROM orders WHERE sub_name = ? AND status != "deleted"', [subName]);
        if (existingOrders.length > 0) {
            return bot.sendMessage(chatId, "❌ این نام قبلاً رزرو شده است. لطفاً یک اسم دیگر انتخاب کن:");
        }
        
        state.subName = subName;
        state.step = 'buy_plan_invoice';
        
        const invData = renderInvoiceMessage(state);
        bot.sendMessage(chatId, invData.text, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: invData.keyboard }
        });
    }

    else if (state.step === 'wait_plan_receipt') {
        if (msg.photo || msg.document) {
            const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
            const [ins] = await pool.query(
                'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, receipt_file_id, order_type) VALUES (?, ?, ?, "pending", ?, ?, "config")',
                [chatId, state.planId, state.finalPrice, state.subName, fileId]
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

            const senderUser = msg.from.username ? '@' + msg.from.username : 'بدون_آیدی';
            const adminMsg = '🧾 **فیش واریزی خرید کانفیگ:**\n\n' +
                '👤 کاربر: ' + senderUser + ' | ' + chatId + '\n' +
                '📦 پلن: ' + state.planTitle + '\n' +
                '🏷 نام ساب: `' + state.subName + '`\n' +
                '💰 مبلغ: ' + Number(state.finalPrice).toLocaleString('fa-IR') + ' تومان';
            const [admins] = await pool.query('SELECT telegram_id FROM users WHERE role="admin"');

            if (admins.length > 0) {
                for (const adm of admins) {
                    try {
                        const markup = { inline_keyboard: [[{ text: '✅ تایید', callback_data: 'adm_approve_order_' + ins.insertId }, { text: '❌ رد', callback_data: 'adm_reject_order_' + ins.insertId }]] };
                        if (msg.photo) {
                            await bot.sendPhoto(adm.telegram_id, fileId, { caption: adminMsg, parse_mode: 'Markdown', reply_markup: markup });
                        } else if (msg.document) {
                            await bot.sendDocument(adm.telegram_id, fileId, { caption: adminMsg, parse_mode: 'Markdown', reply_markup: markup });
                        }
                    } catch (e) {}
                }
            }
            
            bot.sendMessage(chatId, "رسید با موفقیت برامون ارسال شد رفیق! 🙌\nبه محض تایید ادمین، کانفیگ برات فرستاده می‌شه.");
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "لطفا فقط عکس یا فایل فیش واریزی رو بفرست دوست من:");
        }
    }
    
    else if (state.step === 'wait_charge_receipt') {
        if (msg.photo || msg.document) {
            const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
            const dt = getPersianDateTime();
            const userTag = msg.from.username ? '@' + msg.from.username : 'بدون_یوزرنیم';

            const [ins] = await pool.query(
                'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, receipt_file_id, order_type) VALUES (?, -2, ?, "pending", "شارژ کیف پول", ?, "wallet_charge")',
                [chatId, state.amount, fileId]
            );

            const adminMsg = '📥 **درخواست شارژ کیف پول جدید:**\n\n' +
                '👤 کاربر: ' + userTag + ' (' + chatId + ')\n' +
                '💰 مبلغ درخواستی: ' + parseInt(state.amount, 10).toLocaleString('fa-IR') + ' تومان\n' +
                dt.full;
            
            const [admins] = await pool.query('SELECT telegram_id FROM users WHERE role="admin"');

            if (admins.length > 0) {
                const inlineBtns = [
                    [
                        { text: '✅ تایید شارژ', callback_data: 'adm_approve_order_' + ins.insertId },
                        { text: '❌ رد شارژ', callback_data: 'adm_reject_order_' + ins.insertId }
                    ]
                ];

                for (const adm of admins) {
                    try {
                        if (msg.photo) {
                            await bot.sendPhoto(adm.telegram_id, fileId, { caption: adminMsg, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineBtns } });
                        } else if (msg.document) {
                            await bot.sendDocument(adm.telegram_id, fileId, { caption: adminMsg, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineBtns } });
                        }
                    } catch (e) {}
                }
            }

            bot.sendMessage(chatId, "فیش واریزی شما برای پشتیبانی ارسال شد. پس از بررسی کیف پولتون شارژ می‌شه رفیق 🌹");
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "لطفاً عکس یا فایل رسید پرداخت رو ارسال کن دوست خوبم.");
        }
    }
}

// مدیریت کلیک دکمه‌های شیشه‌ای کاربر
async function handleUserCallbacks(bot, query, userStates) {
    const data = query.data;
    const chatId = query.message.chat.id;
    const botUsername = (process.env.BOT_USERNAME || 'bot').replace('@', '');
    const channelId = process.env.CHANNEL_ID || '@Channel';
    const cardNumber = process.env.CARD_NUMBER || '0000000000000000';
    const cardHolder = process.env.CARD_HOLDER || 'صاحب حساب';

    const rawAdmins = process.env.ADMIN_USERNAMES || '';
    const validSuperAdmins = rawAdmins.split(',').map(u => u.trim().toLowerCase().replace('@', '')).filter(Boolean);

    if (data === 'back_to_main') {
        if (userStates[chatId]) delete userStates[chatId];
        bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
        const [u] = await pool.query('SELECT role, username FROM users WHERE telegram_id = ?', [chatId]);
        const isSuper = (u.length > 0 && u[0].role === 'admin') || (u.length > 0 && u[0].username && validSuperAdmins.includes(u[0].username.toLowerCase()));
        return sendUserMenu(bot, chatId, isSuper); 
    }

    if (data === 'usr_copy_ref') {
        const refLink = 'https://t.me/' + botUsername + '?start=' + chatId;
        const shareText = '🚀 اینترنت پرسرعت و بدون قطعی رو با ربات ما تجربه کن:\n' + refLink + '\n\n📢 کانال رسمی: ' + channelId;
        bot.sendMessage(chatId, '📋 متن آماده دعوت (برای کپی روش بزن):\n\n`' + shareText + '`', { parse_mode: 'Markdown' });
    }
    
    else if (data === 'usr_claim_gift') {
        const [uData] = await pool.query('SELECT referral_count, claimed_gift FROM users WHERE telegram_id = ?', [chatId]);
        const refCount = uData.length > 0 ? uData[0].referral_count : 0;
        const claimed = uData.length > 0 ? uData[0].claimed_gift : 0;

        if (refCount >= 3 && !claimed) {
            const giftSubName = 'gift_' + chatId + '_' + Math.floor(Math.random() * 1000);
            const panelRes = await createConfigOnPanel(giftSubName, 0, 7, 'days', 1);
            
            if (panelRes.success) {
                await pool.query('UPDATE users SET claimed_gift = 1 WHERE telegram_id = ?', [chatId]);
                await pool.query(
                    'INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, sub_link, order_type) VALUES (?, 0, 0, "approved", ?, ?, "config")',
                    [chatId, giftSubName, panelRes.link]
                );
                bot.sendMessage(chatId, '🎉 تبریک! ۳ دعوتت تکمیل شد.\n\n🎁 هدیه شما (پلن نامحدود ۷ روزه):\n`' + panelRes.link + '`\nنوش جونت رفیق ❤️', { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, "❌ خطایی در ساخت هدیه در سرور رخ داد. به پشتیبانی پیام بده تا برات ثبتش کنه.");
            }
        } else if (claimed) {
            bot.sendMessage(chatId, "⚠️ شما قبلاً این هدیه رو دریافت کردی دوست من.");
        } else {
            bot.sendMessage(chatId, '⚠️ تا الان ' + refCount + ' نفر رو دعوت کردی. برای دریافت هدیه باید حداقل ۳ نفر دعوت بشن رفیق!');
        }
    }

    else if (data === 'usr_charge_wallet_menu') {
        bot.sendMessage(chatId, "مبلغی که می‌خوای کیف پولت شارژ بشه رو انتخاب کن یا مبلغ دلخواهت رو بزن رفیق:", {
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
        bot.sendMessage(chatId, "لطفاً مبلغ مورد نظر خود را به تومان (فقط عدد انگلیسی، حداقل ۱۰,۰۰۰ تومان) ارسال کنید:\n(برای انصراف: /cancel)");
    }

    else if (data.startsWith('usr_wallet_amt_')) {
        const selectedAmt = data.split('_')[3];
        const dt = getPersianDateTime();

        const invoiceMsg = '🧾 **پیش‌فاکتور شارژ کیف پول:**\n\n' +
            dt.full + '\n' +
            '💰 **مبلغ درخواستی:** ' + Number(selectedAmt).toLocaleString('fa-IR') + ' تومان\n\n' +
            '💳 **شماره کارت جهت واریز:**\n`' + cardNumber + '`\nبه نام: ' + cardHolder + '\n\n' +
            'برای ارسال فیش پرداختی روی دکمه زیر بزنید:';
        
        bot.sendMessage(chatId, invoiceMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📸 ارسال فیش و پرداخت', callback_data: 'usr_pay_card_charge_' + selectedAmt }],
                    [{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]
                ]
            }
        });
    }

    else if (data.startsWith('usr_pay_card_charge_')) {
        const amt = data.split('_')[4];
        userStates[chatId] = { step: 'wait_charge_receipt', amount: amt };

        const payMsg = '💳 **شماره کارت برای واریز:**\n`' + cardNumber + '`\nبه نام: ' + cardHolder + '\n\n💰 **مبلغ قابل واریز:** ' + Number(amt).toLocaleString('fa-IR') + ' تومان\n\n📸 لطفاً عکس رسید یا فیش پرداختی خود را همین‌جا ارسال کنید رفیق:';
        bot.sendMessage(chatId, payMsg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_buy_vol') {
        await ensureDefaultPlans();
        const [plans] = await pool.query("SELECT * FROM configs WHERE plan_type='volume' AND (status='active' OR status IS NULL) ORDER BY duration_days ASC, volume ASC");
        if (plans.length === 0) {
            return bot.sendMessage(chatId, "در حال حاضر هیچ پلن حجمی فعالی موجود نیست رفیق. به زودی اضافه می‌شه!", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
        }
        let btns = plans.map(p => [{
            text: '📊 ' + p.title + ' | کاربر نامحدود | ' + Number(p.price).toLocaleString('fa-IR') + ' تومان',
            callback_data: 'usr_selplan_' + p.id
        }]);
        btns.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);
        bot.sendMessage(chatId, "📊 **لیست پلن‌های حجمی:**\nروی پلن مورد نظرت کلیک کن دوست خوبم:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns }});
    } 
    else if (data === 'usr_buy_unlimit') {
        await ensureDefaultPlans();
        const [plans] = await pool.query("SELECT * FROM configs WHERE plan_type='unlimited' AND (status='active' OR status IS NULL) ORDER BY duration_days ASC");
        if (plans.length === 0) {
            return bot.sendMessage(chatId, "در حال حاضر هیچ پلن نامحدود فعالی موجود نیست رفیق. به زودی اضافه می‌شه!", { reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
        }
        let btns = plans.map(p => [{
            text: '♾ ' + p.title + ' | 5 کاربره | ' + Number(p.price).toLocaleString('fa-IR') + ' تومان',
            callback_data: 'usr_selplan_' + p.id
        }]);
        btns.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);
        bot.sendMessage(chatId, "♾ **لیست پلن‌های نامحدود:**\nروی پلن مورد نظرت کلیک کن دوست خوبم:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns }});
    }
    else if (data.startsWith('usr_selplan_')) {
        const pId = data.split('_')[2];
        const [plan] = await pool.query('SELECT * FROM configs WHERE id = ?', [pId]);
        if (plan.length === 0) return bot.sendMessage(chatId, "❌ متاسفانه این پلن پیدا نشد.");
        
        userStates[chatId] = { step: 'buy_plan_subname', planId: pId, planTitle: plan[0].title, planPrice: plan[0].price, activeDiscount: null };
        bot.sendMessage(chatId, "یک اسم انگلیسی دلخواه برای ساب‌اسکریپشن خودت وارد کن:\n(مثال: `myvpn123`)", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
    }
    else if (data === 'usr_apply_discount_code') {
        if (!userStates[chatId] || !userStates[chatId].planId) {
            return bot.sendMessage(chatId, "لطفاً ابتدا یک پلن انتخاب کنید.");
        }
        userStates[chatId].step = 'wait_invoice_discount_code';
        bot.sendMessage(chatId, "کد تخفیف خود را ارسال کنید:\n(برای انصراف /cancel بفرستید)", { reply_markup: { inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_hist_conf') {
        const [orders] = await pool.query(
            'SELECT id, sub_name, status, created_at FROM orders WHERE telegram_id = ? AND (order_type = "config" OR order_type IS NULL) AND status = "approved" ORDER BY id DESC',
            [chatId]
        );
        if (orders.length === 0) {
            return bot.sendMessage(chatId, "در حال حاضر هیچ کانفیگ فعالی در حسابت نداری دوست من. هر زمان خواستی می‌تونی از بخش «خرید کانفیگ» تهیه کنی 🌹", {
                reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }
            });
        }
        let btns = orders.map(o => [{
            text: '🌐 کانفیگ: ' + o.sub_name,
            callback_data: 'usr_view_conf_' + o.id
        }]);
        btns.push([{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]);
        bot.sendMessage(chatId, "لیست اشتراک‌های خریداری‌شده شما (برای دیدن جزئیات کلیک کن):", {
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
                text: 'سفارش #' + o.id + ' | ' + Number(o.amount).toLocaleString('fa-IR') + 'T | ' + statusLabel,
                callback_data: 'usr_view_wtx_' + o.id
            }];
        });
        btns.push([{ text: '🔙 بازگشت به کیف پول', callback_data: 'usr_wallet_dash_btn' }]);

        bot.sendMessage(chatId, "📜 **لیست آخرین تراکنش‌های شارژ کیف پول شما:**\nروی تراکنش مورد نظر کلیک کنید:", {
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
                '🔹 **کد پیگیری سفارش:** #' + o.id + '\n' +
                '👤 **آیدی تلگرام:** ' + o.telegram_id + '\n' +
                '💰 **مبلغ شارژ:** ' + Number(o.amount).toLocaleString('fa-IR') + ' تومان\n' +
                '📅 **زمان ثبت تراکنش:** ' + dateStr + '\n' +
                '📊 **وضعیت نهایی:** ' + statusFa;

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

            const planTitleStr = o.plan_title || (o.plan_id === -1 ? 'تست رایگان' : (o.plan_id === 0 ? 'هدیه دعوت' : 'کانفیگ سفارشی'));

            const cardText = '👤 **اطلاعات حساب کاربر:**\n' +
                '▪️ نام: ' + firstName + '\n' +
                '▪️ یوزرنیم: ' + usernameTag + '\n' +
                '📅 تاریخ عضویت: ' + joinDate + '\n' +
                '🛒 تاریخ خرید: ' + buyDate + '\n\n' +
                '⚙️ **اطلاعات کانفیگ:**\n' +
                '📦 پلن: ' + planTitleStr + '\n' +
                '🏷 نام ساب: `' + o.sub_name + '`\n' +
                '⏳ زمان باقی‌مانده: ' + remainingStr + '\n\n' +
                '🌐 **لینک اتصال ساب:**\n`' + (o.sub_link || 'موجود نیست') + '`';

            const inlineBtns = [
                [{ text: '🔄 تمدید اشتراک', callback_data: 'usr_renew_sub_' + o.id }],
                [{ text: '❌ حذف اشتراک', callback_data: 'usr_delete_sub_' + o.id }],
                [{ text: '🔀 انتقال اشتراک به دوست', callback_data: 'usr_transfer_sub_' + o.id }],
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
                return bot.sendMessage(chatId, "پلن‌های رایگان یا هدیه قابل تمدید مستقیم نیستن رفیق. لطفاً یک پلن جدید از منو تهیه کن 🌹");
            }
            const [plans] = await pool.query('SELECT * FROM configs WHERE id = ?', [o.plan_id]);
            if (plans.length === 0) return bot.sendMessage(chatId, "❌ متاسفانه پلن مربوطه پیدا نشد.");
            const plan = plans[0];

            userStates[chatId] = {
                step: 'buy_plan_invoice',
                planId: plan.id,
                planTitle: 'تمدید: ' + plan.title,
                planPrice: plan.price,
                finalPrice: plan.price,
                subName: o.sub_name,
                isRenewal: true,
                orderId: o.id
            };

            const dt = getPersianDateTime();
            const inv = '🧾 **پیش‌فاکتور تمدید اشتراک:**\n\n' +
                dt.full + '\n' +
                '🏷 **نام ساب‌‌اسکریپشن:** `' + o.sub_name + '`\n' +
                '📦 **پلن تمدید:** ' + plan.title + '\n' +
                '⏳ **مدت اضافه شونده:** ' + plan.duration_days + ' روز\n' +
                '💳 **مبلغ قابل پرداخت:** ' + Number(plan.price).toLocaleString('fa-IR') + ' تومان';

            bot.sendMessage(chatId, inv, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 پرداخت با شماره کارت', callback_data: 'usr_paycard' }],
                        [{ text: '💰 پرداخت با کیف پول', callback_data: 'usr_paywallet' }],
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
            bot.sendMessage(chatId, '✅ اشتراک `' + o.sub_name + '` با موفقیت از سرور و لیست شما حذف شد.', { parse_mode: 'Markdown' });
        }
    }

    else if (data.startsWith('usr_transfer_sub_')) {
        const oId = data.split('_')[3];
        userStates[chatId] = { step: 'wait_transfer_target', orderId: oId };

        const transPrompt = '🔀 **پیش‌فاکتور و راهنمای انتقال اشتراک:**\n\n' +
            '⚠️ **نکته امنیتی:** با انتقال این کانفیگ، دسترسی شما قطع شده و به کاربر مقصد واگذار می‌گردد.\n\n' +
            'لطفاً آیدی عددی یا یوزرنیم تلگرام دوست خود را ارسال کنید:\n(برای انصراف: /cancel)';

        bot.sendMessage(chatId, transPrompt, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 انصراف و بازگشت', callback_data: 'back_to_main' }]] }
        });
    }

    else if (data === 'usr_paycard') {
        const state = userStates[chatId];
        state.step = 'wait_plan_receipt';
        bot.sendMessage(chatId, "💳 شماره کارت جهت واریز:\n`" + cardNumber + "`\nبه نام: " + cardHolder + "\n\nلطفاً بعد از واریز، عکس فیش رو برامون بفرست رفیق 🙌 (انصراف: /cancel)", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 بازگشت به منوی اصلی', callback_data: 'back_to_main' }]] }});
    }

    else if (data === 'usr_paywallet') {
        const state = userStates[chatId];
        const [user] = await pool.query('SELECT wallet_balance FROM users WHERE telegram_id = ?', [chatId]);
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
            
            const panelRes = await createConfigOnPanel(state.subName, plan.volume || 0, plan.duration_days, 'days', plan.users_count || 1, false, !!state.isRenewal);
            
            if (panelRes.success) {
                if (state.isRenewal && state.orderId) {
                    await pool.query('UPDATE orders SET status = "approved", sub_link = ? WHERE id = ?', [panelRes.link, state.orderId]);
                } else {
                    await pool.query('INSERT INTO orders (telegram_id, plan_id, amount, status, sub_name, sub_link, order_type) VALUES (?, ?, ?, "approved", ?, ?, "config")', [chatId, state.planId, state.finalPrice, state.subName, panelRes.link]);
                }
                bot.sendMessage(chatId, '🎉 پرداخت با موفقیت از کیف پولت کسر شد و کانفیگت آماده‌ست!\n\n🌐 لینک ساب شما:\n`' + panelRes.link + '`\n\nامیدوارم نهایت لذت رو از وب‌گردی ببری ❤️', { parse_mode: 'Markdown' });
            } else {
                await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE telegram_id = ?', [state.finalPrice, chatId]);
                bot.sendMessage(chatId, '❌ خطا در سرور پاسارگاد: ' + (panelRes.error || 'عملیات ناموفق بود') + '\nنگران نباش، مبلغ به کیف پولت برگشت داده شد.');
            }
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, "❌ متاسفانه موجودی کیف پولت کافی نیست دوست من. می‌تونی از بخش «💰 کیف پول» اون رو شارژ کنی.", { reply_markup: { inline_keyboard:[[{text:'🔙 بازگشت به منوی اصلی', callback_data:'back_to_main'}]]}});
        }
    }
}

module.exports = { checkChannelMembership, sendUserMenu, handleUserCommands, handleUserCallbacks, handleUserStates };