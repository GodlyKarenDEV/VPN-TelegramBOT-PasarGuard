const axios = require('axios');
const https = require('https');
require('dotenv').config();

const API_BASE = (process.env.PANEL_URL || '').replace(/\/+$/, '');

// عبور از خطای SSL برای سرورهایی با گواهینامه خودامضا (Self-Signed)
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedGroupIds = null;

// ورود به پنل پاسارگاد و دریافت توکن دسترسی
async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && tokenExpiresAt > now) {
        return cachedToken;
    }

    try {
        const username = process.env.PANEL_USER || process.env.PANEL_USERNAME;
        const password = process.env.PANEL_PASS || process.env.PANEL_PASSWORD;

        const params = new URLSearchParams();
        params.append('username', username);
        params.append('password', password);

        const response = await axios.post(API_BASE + '/api/admin/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            httpsAgent: httpsAgent,
            timeout: 10000
        });

        if (response.data && response.data.access_token) {
            cachedToken = response.data.access_token;
            tokenExpiresAt = now + 50 * 60 * 1000;
            return cachedToken;
        }
        return null;
    } catch (error) {
        console.error("خطا در ورود به پنل (دریافت توکن):", error.response?.data || error.message);
        cachedToken = null;
        return null;
    }
}

// دریافت شناسه‌های گروه فعال در پنل
async function getActiveGroupIds(token) {
    if (cachedGroupIds && cachedGroupIds.length > 0) {
        return cachedGroupIds;
    }

    try {
        const res = await axios.get(API_BASE + '/api/groups/simple', {
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
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
        console.warn("خطا در دریافت لیست گروه‌ها از پنل، تلاش برای استفاده از تنظیمات جایگزین:", err.message);
    }

    const envGroup = process.env.PANEL_GROUP_IDS || process.env.PANEL_GROUP_ID;
    if (envGroup) {
        const parsed = envGroup.toString().split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
        if (parsed.length > 0) {
            cachedGroupIds = parsed;
            return cachedGroupIds;
        }
    }

    return [2];
}

// ساخت یا به‌روزرسانی کاربر روی سرور پنل
async function upsertUser(token, payload, subName, allowUpdate = false) {
    try {
        return await axios.post(API_BASE + '/api/user', payload, {
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            httpsAgent: httpsAgent 
        });
    } catch (err) {
        if (err.response && err.response.status === 409 && allowUpdate) {
            return await axios.put(API_BASE + '/api/user/' + encodeURIComponent(subName), payload, {
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                httpsAgent: httpsAgent 
            });
        }
        throw err;
    }
}

// استعلام مشخصات کاربر (حجم و انقضا) از پنل پاسارگاد
async function getUserFromPanel(subName) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return null;

        let response;
        try {
            response = await axios.get(API_BASE + '/api/user/' + encodeURIComponent(subName), {
                headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                httpsAgent: httpsAgent 
            });
        } catch (err) {
            if (err.response && err.response.status === 401) {
                cachedToken = null;
                token = await getAccessToken();
                if (!token) return null;
                response = await axios.get(API_BASE + '/api/user/' + encodeURIComponent(subName), {
                    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
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

// ساخت کانفیگ جدید در پنل
async function createConfigOnPanel(subName, volumeGB, durationValue, durationType = 'days', usersCount = 1, isFreeTest = false, allowUpdate = false) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false, error: 'عدم احراز هویت در پنل' };

        const groupIds = await getActiveGroupIds(token);
        const numVol = Number(volumeGB) || 0;
        const numDuration = Number(durationValue) || 0;
        const numUsers = parseInt(usersCount, 10) || 1;

        const dataLimitBytes = numVol === 0 ? 0 : Math.round(numVol * 1024 * 1024 * 1024); 
        
        let expireTimestamp = 0;
        if (durationType === 'days' && numDuration > 0) {
            expireTimestamp = Math.floor(Date.now() / 1000) + (numDuration * 86400);
        } else if (durationType === 'minutes' && numDuration > 0) {
            expireTimestamp = Math.floor(Date.now() / 1000) + (numDuration * 60);
        }

        let configNote = isFreeTest 
            ? 'نوع: تست رایگان | کاربر: ' + numUsers + ' | حجم: نامحدود | زمان: ' + numDuration + ' دقیقه' 
            : (numVol === 0 
                ? 'نوع: نامحدود | کاربر: ' + numUsers + ' | زمان: ' + numDuration + ' روز' 
                : 'نوع: حجمی | کاربر: ' + numUsers + ' | حجم: ' + numVol + 'GB | زمان: ' + numDuration + ' روز');

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
        try {
            response = await upsertUser(token, payload, subName, allowUpdate);
        } catch (err) {
            if (err.response && err.response.status === 401) {
                cachedToken = null;
                token = await getAccessToken();
                if (!token) throw err;
                response = await upsertUser(token, payload, subName, allowUpdate);
            } else if (err.response && err.response.status === 409 && !allowUpdate) {
                return { success: false, error: 'این نام ساب‌اسکریپشن در حال حاضر در سرور موجود است.' };
            } else {
                throw err;
            }
        }
        
        const subUrl = response.data?.subscription_url || response.data?.links?.[0] || (API_BASE + '/sub/' + encodeURIComponent(subName));
        return { success: true, link: subUrl };
    } catch (error) {
        const detail = error.response?.data?.detail || error.message;
        console.error("خطا در اتصال به پنل پاسارگاد:", error.response?.data || error.message);
        return { success: false, error: detail || 'خطا در ارتباط با پنل' };
    }
}

// حذف کانفیگ از پنل
async function deleteConfigOnPanel(subName) {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false };
        let response;
        try {
            response = await axios.delete(API_BASE + '/api/user/' + encodeURIComponent(subName), {
                headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                httpsAgent: httpsAgent 
            });
        } catch (err) {
            if (err.response && err.response.status === 401) {
                cachedToken = null;
                token = await getAccessToken();
                if (!token) return { success: false };
                response = await axios.delete(API_BASE + '/api/user/' + encodeURIComponent(subName), {
                    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                    httpsAgent: httpsAgent 
                });
            } else {
                throw err;
            }
        }
        return { success: true };
    } catch (error) {
        return { success: false };
    }
}

// دریافت اطلاعات وضعیت سرور و پنل
async function getServerStatus() {
    try {
        let token = cachedToken || await getAccessToken();
        if (!token) return { success: false };

        let response;
        try {
            response = await axios.get(API_BASE + '/api/system', {
                headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                httpsAgent: httpsAgent 
            });
        } catch (err) {
            if (err.response && err.response.status === 401) {
                cachedToken = null;
                token = await getAccessToken();
                if (!token) throw err;
                response = await axios.get(API_BASE + '/api/system', {
                    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                    httpsAgent: httpsAgent 
                });
            } else {
                throw err;
            }
        }
        return { success: true, data: response.data };
    } catch (error) {
        return { success: false };
    }
}

module.exports = { createConfigOnPanel, deleteConfigOnPanel, getServerStatus, getUserFromPanel };