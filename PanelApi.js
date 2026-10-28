/**
 * ====================================================================
 * PanelApi.js - ماژول یکپارچه‌ساز وب‌سرویس و API پنل پاسارگاد (v5.4.1)
 * ====================================================================
 * این ماژول ارتباط امن با پنل سرور پاسارگاد را مدیریت می‌کند:
 * - احراز هویت ادمین و تولید/کش توکن دسترسی Bearer
 * - ایجاد اشتراک جدید با تفکیک نوع (حجمی، نامحدود، تست ۱ ساعته)
 * - تمدید تجمیعی (Cumulative Renewal) با محاسبه مانده ترافیک و روزهای باقی‌مانده
 * - انتقال امن اشتراک با ابطال قطعی لینک در دستگاه مالک قبلی
 * - دریافت وضعیت سخت‌افزاری سرور (CPU, RAM, اتصالات آنلاین)
 */

const axios = require('axios');
const https = require('https');
require('dotenv').config();

// دریافت آدرس پنل از متغیرهای محیطی و حذف اسلش پایانی جهت یکنواختی مسیرها
const API_BASE = (process.env.PANEL_URL || '').replace(/\/+$/, '');

// ایجنت HTTPS با غیرفعال‌سازی بررسی سخت‌گیرانه گواهینامه‌های خودامضا (Self-Signed)
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// کش در حافظه رم سرور برای توکن دسترسی و شناسه‌های گروه‌ها
let cachedToken = null;
let tokenExpiresAt = 0;
let cachedGroupIds = null;

/**
 * دریافت توکن دسترسی Bearer از وب‌سرویس پاسارگاد
 * @returns {Promise<string|null>} توکن معتبر دسترسی یا null
 */
async function getAccessToken() {
    const now = Date.now();
    // بررسی اعتبار ۵۰ دقیقه‌ای توکن ذخیره‌شده
    if (cachedToken && tokenExpiresAt > now) {
        return cachedToken;
    }

    try {
        const username = process.env.PANEL_USER || process.env.PANEL_USERNAME;
        const password = process.env.PANEL_PASS || process.env.PANEL_PASSWORD;

        if (!username || !password || !API_BASE) {
            console.error('[PanelApi.js] خطای پیکربندی: مشخصات PANEL_USER، PANEL_PASS یا PANEL_URL در فایل .env تنظیم نشده است.');
            return null;
        }

        const params = new URLSearchParams();
        params.append('username', username);
        params.append('password', password);

        const response = await axios.post(`${API_BASE}/api/admin/token`, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: httpsAgent,
            timeout: 10000
        });

        if (response.data && response.data.access_token) {
            cachedToken = response.data.access_token;
            tokenExpiresAt = now + 50 * 60 * 1000; // ذخیره اعتبار توکن به مدت ۵۰ دقیقه
            return cachedToken;
        }
        return null;
    } catch (error) {
        console.error('[PanelApi.js] خطا در دریافت توکن پنل پاسارگاد:', error.response?.data || error.message);
        cachedToken = null;
        return null;
    }
}

/**
 * دریافت شناسه‌های گروه‌های فعال سرور
 * @param {string} token - توکن دسترسی ادمین
 * @returns {Promise<Array<number>>} آرایه‌ای از شناسه‌های عددی گروه
 */
async function getActiveGroupIds(token) {
    if (cachedGroupIds && cachedGroupIds.length > 0) {
        return cachedGroupIds;
    }

    // ۱. استعلام از API پنل
    try {
        const res = await axios.get(`${API_BASE}/api/groups/simple`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
            httpsAgent: httpsAgent,
            timeout: 7000
        });

        if (res.data) {
            const list = Array.isArray(res.data) ? res.data : (Array.isArray(res.data.groups) ? res.data.groups : []);
            if (list.length > 0) {
                cachedGroupIds = list.map(g => g.id).filter(id => id != null);
                if (cachedGroupIds.length > 0) return cachedGroupIds;
            }
        }
    } catch (err) {
        console.warn('[PanelApi.js] عدم دریافت خودکار گروه‌ها از API، بررسی مقادیر فایل .env:', err.message);
    }

    // ۲. بررسی مقدار تنظیم‌شده در فایل .env
    const envGroup = process.env.PANEL_GROUP_IDS || process.env.PANEL_GROUP_ID || process.env.GROUP_IDS;
    if (envGroup) {
        const parsed = envGroup.toString().replace(/[\[\]]/g, '').split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        if (parsed.length > 0) {
            cachedGroupIds = parsed;
            return cachedGroupIds;
        }
    }

    return [1]; // شناسه گروه پیش‌فرض
}

/**
 * استعلام وضعیت و اطلاعات اشتراک از سرور پاسارگاد
 * @param {string} subName - نام ساب‌اسکریپشن
 * @returns {Promise<object|null>} اطلاعات کاربر یا null
 */
async function getUserFromPanel(subName) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return null;

        let response;
        try {
            response = await axios.get(`${API_BASE}/api/user/${encodeURIComponent(subName)}`, {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                httpsAgent: httpsAgent
            });
        } catch (err) {
            // تجدید خودکار توکن در صورت دریافت خطای ۴۰۱
            if (err.response && err.response.status === 401) {
                cachedToken = null;
                token = await getAccessToken();
                if (!token) return null;
                response = await axios.get(`${API_BASE}/api/user/${encodeURIComponent(subName)}`, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                    httpsAgent: httpsAgent
                });
            } else {
                return null;
            }
        }
        return response.data;
    } catch (error) {
        return null;
    }
}

/**
 * ایجاد یا تمدید تجمیعی کانفیگ روی سرور پاسارگاد
 * @param {string} subName - شناسه ساب‌اسکریپشن
 * @param {number} volumeGB - ترافیک پلن به گیگابایت (۰ به معنای نامحدود)
 * @param {number} durationValue - مدت اعتبار
 * @param {string} durationType - واحد مدت ('days' | 'hours' | 'minutes')
 * @param {number} usersCount - محدودیت اتصال کاربر همزمان
 * @param {boolean} isFreeTest - آیا کانفیگ تست رایگان است؟
 * @param {boolean} allowUpdate - مجوز بروزرسانی در صورت وجود
 * @param {boolean} isRenewal - آیا تمدید تجمیعی است؟ (افزودن زمان و حجم به مانده قبلی)
 * @returns {Promise<{success: boolean, link?: string, error?: string}>}
 */
async function createConfigOnPanel(subName, volumeGB, durationValue, durationType = 'days', usersCount = 1, isFreeTest = false, allowUpdate = false, isRenewal = false) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false, error: 'عدم احراز هویت در پنل پاسارگاد' };

        const groupIds = await getActiveGroupIds(token);
        const numVol = Number(volumeGB) || 0;
        const numDuration = Number(durationValue) || 0;
        const numUsers = parseInt(usersCount, 10) || 1;
        const now = Math.floor(Date.now() / 1000);

        let dataLimitBytes = numVol === 0 ? 0 : Math.round(numVol * 1024 * 1024 * 1024);
        let expireTimestamp = 0;

        // محاسبه بازه زمانی افزوده شونده
        let additionalSec = 0;
        if (durationType === 'days' && numDuration > 0) {
            additionalSec = numDuration * 86400;
        } else if (durationType === 'hours' && numDuration > 0) {
            additionalSec = numDuration * 3600;
        } else if (durationType === 'minutes' && numDuration > 0) {
            additionalSec = numDuration * 60;
        }

        expireTimestamp = now + additionalSec;

        // استعلام اطلاعات کاربر جهت ارزیابی تمدید تجمیعی
        const currentData = await getUserFromPanel(subName);

        if (currentData && (isRenewal || allowUpdate)) {
            let currentExpire = 0;
            if (currentData.expire) {
                const rawExp = currentData.expire;
                if (typeof rawExp === 'number') {
                    currentExpire = rawExp > 10000000000 ? Math.floor(rawExp / 1000) : rawExp;
                } else if (typeof rawExp === 'string') {
                    const clean = rawExp.trim();
                    if (/^\d+$/.test(clean)) {
                        const num = Number(clean);
                        currentExpire = num > 10000000000 ? Math.floor(num / 1000) : num;
                    } else {
                        const parsed = Date.parse(clean.replace(' ', 'T'));
                        if (!isNaN(parsed)) {
                            currentExpire = Math.floor(parsed / 1000);
                        }
                    }
                }
            }

            // ۱. تمدید تجمیعی زمان انقضا
            if (currentExpire > now) {
                expireTimestamp = currentExpire + additionalSec;
            } else {
                expireTimestamp = now + additionalSec;
            }

            // ۲. تمدید تجمیعی حجم ترافیک
            if (numVol > 0) {
                const currentLimit = Number(currentData.data_limit) || 0;
                dataLimitBytes = currentLimit + (numVol * 1024 * 1024 * 1024);
            } else {
                dataLimitBytes = 0; // در پلن نامحدود، سقف حجم صفر منظور می‌شود
            }
        }

        const unitFa = durationType === 'hours' ? 'ساعت' : (durationType === 'minutes' ? 'دقیقه' : 'روز');
        const configNote = isFreeTest 
            ? `نوع: تست رایگان | کاربر: ${numUsers} | حجم: نامحدود | زمان: ${numDuration} ${unitFa}` 
            : (numVol === 0 
                ? `نوع: نامحدود | کاربر: ${numUsers} | زمان: ${numDuration} ${unitFa}` 
                : `نوع: حجمی | کاربر: ${numUsers} | حجم: ${numVol}GB | زمان: ${numDuration} ${unitFa}`);

        const payload = {
            username: subName,
            status: "active",
            data_limit: dataLimitBytes,
            expire: expireTimestamp,
            data_limit_reset_strategy: "no_reset",
            group_ids: groupIds,
            hwid_limit: numUsers > 0 ? numUsers : 1,
            note: configNote
        };

        let response;
        if (currentData) {
            // رکورد از قبل وجود دارد: فراخوانی متد PUT
            try {
                response = await axios.put(`${API_BASE}/api/user/${encodeURIComponent(subName)}`, payload, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    httpsAgent: httpsAgent
                });
            } catch (err) {
                if (err.response && err.response.status === 401) {
                    cachedToken = null;
                    token = await getAccessToken();
                    response = await axios.put(`${API_BASE}/api/user/${encodeURIComponent(subName)}`, payload, {
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        httpsAgent: httpsAgent
                    });
                } else {
                    throw err;
                }
            }
        } else {
            // کاربر جدید: فراخوانی متد POST
            try {
                response = await axios.post(`${API_BASE}/api/user`, payload, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    httpsAgent: httpsAgent
                });
            } catch (err) {
                if (err.response && err.response.status === 401) {
                    cachedToken = null;
                    token = await getAccessToken();
                    response = await axios.post(`${API_BASE}/api/user`, payload, {
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        httpsAgent: httpsAgent
                    });
                } else {
                    throw err;
                }
            }
        }

        const subUrl = response.data?.subscription_url || response.data?.links?.[0] || `${API_BASE}/sub/${encodeURIComponent(subName)}`;
        return { success: true, link: subUrl };
    } catch (error) {
        const detail = error.response?.data?.detail || error.message;
        console.error('[PanelApi.js] خطا در ثبت یا تمدید کانفیگ:', error.response?.data || error.message);
        return { success: false, error: detail || 'خطا در ارتباط با سرور پاسارگاد' };
    }
}

/**
 * انتقال امن اشتراک: ابطال لینک قبلی با حذف از سرور و صدور کانفیگ جدید با مانده حجم و زمان واقعی
 * @param {string} oldSubName - نام ساب قبلی متعلق به فرستنده
 * @param {string} newSubName - نام ساب جدید متعلق به گیرنده
 * @returns {Promise<{success: boolean, link?: string, error?: string}>}
 */
async function transferConfigOnPanel(oldSubName, newSubName) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false, error: 'عدم احراز هویت در پنل پاسارگاد' };

        const currentData = await getUserFromPanel(oldSubName);
        if (!currentData) {
            return { success: false, error: 'مشخصات اشتراک در سرور پاسارگاد یافت نشد.' };
        }

        const now = Math.floor(Date.now() / 1000);
        let currentExpire = 0;
        if (currentData.expire) {
            const raw = currentData.expire;
            currentExpire = typeof raw === 'number' ? (raw > 10000000000 ? Math.floor(raw / 1000) : raw) : Number(raw);
        }

        if (currentExpire > 0 && currentExpire <= now) {
            return { success: false, error: 'این اشتراک منقضی شده است و امکان انتقال آن وجود ندارد.' };
        }

        const totalLimit = Number(currentData.data_limit) || 0;
        const usedTraffic = Number(currentData.used_traffic) || 0;
        let remainingBytes = 0;

        if (totalLimit > 0) {
            remainingBytes = Math.max(0, totalLimit - usedTraffic);
            if (remainingBytes <= 0) {
                return { success: false, error: 'حجم مجاز این اشتراک به پایان رسیده است.' };
            }
        }

        const groupIds = currentData.group_ids && currentData.group_ids.length > 0
            ? currentData.group_ids
            : await getActiveGroupIds(token);

        const usersLimit = currentData.hwid_limit || currentData.user_limit || 1;

        // ۱. حذف ساب‌اسکریپشن قبلی جهت ابطال قطعی لینک در دستگاه کاربر فرستنده
        await deleteConfigOnPanel(oldSubName);

        // ۲. ساخت ساب جدید برای کاربر مقصد با مانده اعتبار واقعی
        const payload = {
            username: newSubName,
            status: "active",
            data_limit: remainingBytes,
            expire: currentExpire,
            data_limit_reset_strategy: "no_reset",
            group_ids: groupIds,
            hwid_limit: usersLimit,
            note: `انتقال امن از ساب ${oldSubName}`
        };

        const response = await axios.post(`${API_BASE}/api/user`, payload, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            httpsAgent: httpsAgent
        });

        const newSubUrl = response.data?.subscription_url || response.data?.links?.[0] || `${API_BASE}/sub/${encodeURIComponent(newSubName)}`;
        return { success: true, link: newSubUrl };
    } catch (error) {
        console.error('[PanelApi.js] خطا در انتقال امن اشتراک:', error.response?.data || error.message);
        return { success: false, error: error.response?.data?.detail || error.message };
    }
}

/**
 * حذف کامل اشتراک از روی سرور پاسارگاد
 * @param {string} subName - نام ساب‌اسکریپشن
 * @returns {Promise<{success: boolean}>}
 */
async function deleteConfigOnPanel(subName) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false };

        await axios.delete(`${API_BASE}/api/user/${encodeURIComponent(subName)}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
            httpsAgent: httpsAgent
        });
        return { success: true };
    } catch (error) {
        return { success: false };
    }
}

/**
 * دریافت آمار منابع سرور (CPU, RAM, نسخه‌ پنل و کاربران آنلاین)
 * @returns {Promise<{success: boolean, data?: object}>}
 */
async function getServerStatus() {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false };

        const response = await axios.get(`${API_BASE}/api/system`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
            httpsAgent: httpsAgent
        });
        return { success: true, data: response.data };
    } catch (error) {
        return { success: false };
    }
}

module.exports = {
    createConfigOnPanel,
    deleteConfigOnPanel,
    getServerStatus,
    getUserFromPanel,
    transferConfigOnPanel
};