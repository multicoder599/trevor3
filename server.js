require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Bot, session, InlineKeyboard } = require('grammy');
const { conversations, createConversation } = require('@grammyjs/conversations');

const app = express();
app.use(express.json());
app.get('/api/health', (req, res) => res.json({ ok: true, file: 'server.js' }));
// ==========================================
// ENV VALIDATION
// ==========================================
const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'MONGODB_URI', 'MEGAPAY_API_KEY', 'MEGAPAY_EMAIL', 'APP_URL', 'VIP_CHANNEL_ID', 'ADMIN_IDS'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Missing required env var: ${key}`);
        process.exit(1);
    }
}

const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())).filter(Boolean);
const VIP_CHANNEL_ID = process.env.VIP_CHANNEL_ID;
const VIP_CHANNEL_ID_BACKUP = process.env.VIP_CHANNEL_ID_BACKUP || VIP_CHANNEL_ID;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || null;
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID || null;

const CRYPTO_USDT = process.env.CRYPTO_USDT_ADDRESS || 'TRC20_ADDRESS_NOT_SET';
const CRYPTO_BTC = process.env.CRYPTO_BTC_ADDRESS || 'BTC_ADDRESS_NOT_SET';
const SUPPORT_USER = process.env.SUPPORT_USERNAME || 'trends250';

// ==========================================
// DATABASE
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => {
        console.error('❌ MongoDB Error:', err);
        process.exit(1);
    });

const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    phone: String,
    isActive: { type: Boolean, default: true },
    subscriptions: [{
        category: String,
        categoryKey: String,
        plan: String,
        amount: Number,
        startDate: Date,
        endDate: Date,
        status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active' },
        receiptNumber: String,
        inviteLink: String,
        reminderLevel: { type: Number, default: 0 },
        renewed: { type: Boolean, default: false }
    }],
    lastPromo: Date,
    bannedFromChannel: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const promoLogSchema = new mongoose.Schema({
    type: String,
    sentAt: { type: Date, default: Date.now },
    recipients: Number,
    success: Number,
    failed: Number,
    message: String
});

const userActionLogSchema = new mongoose.Schema({
    telegramId: Number,
    action: String,
    source: String,
    metadata: mongoose.Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now }
});

const channelPostSchema = new mongoose.Schema({
    messageId: { type: Number, required: true },
    channelId: { type: String, required: true },
    caption: { type: String, default: '' },
    captionLength: Number,
    emojiCount: Number,
    hasVideo: { type: Boolean, default: false },
    hasPhoto: { type: Boolean, default: false },
    hasText: { type: Boolean, default: false },
    keywords: [String],
    postedAt: { type: Date, default: Date.now },
    hour: Number,
    dayOfWeek: Number,
    views: { type: Number, default: null },
    botStarts30m: { type: Number, default: 0 },
    botStarts1h: { type: Number, default: 0 },
    botStarts3h: { type: Number, default: 0 },
    sales1h: { type: Number, default: 0 },
    sales3h: { type: Number, default: 0 },
    sales24h: { type: Number, default: 0 },
    revenue1h: { type: Number, default: 0 },
    revenue3h: { type: Number, default: 0 },
    revenue24h: { type: Number, default: 0 },
    analyzed: { type: Boolean, default: false }
});
channelPostSchema.index({ postedAt: -1 });
channelPostSchema.index({ channelId: 1, postedAt: -1 });

const User = mongoose.model('User', userSchema);
const PromoLog = mongoose.model('PromoLog', promoLogSchema);
const UserActionLog = mongoose.model('UserActionLog', userActionLogSchema);
const ChannelPost = mongoose.model('ChannelPost', channelPostSchema);

const pendingTransactionSchema = new mongoose.Schema({
    phone: { type: String, required: true, index: true },
    chatId: Number,
    userId: { type: Number, required: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    amount: Number,
    category: String,
    categoryKey: String,
    plan: String,
    reference: String,
    date: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});
const PendingTransaction = mongoose.model('PendingTransaction', pendingTransactionSchema);

// ==========================================
// BOT SETUP
// ==========================================
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const pendingTransactions = new Map();
const userIntent = new Map();
const pendingIntlPayments = new Map();
const abandonedCarts = new Map();

bot.use(session({
    initial: () => ({
        selectedCategory: null,
        categoryKey: null,
        planName: null,
        amount: 0
    })
}));

bot.use(conversations());

bot.on('callback_query:data', async (ctx, next) => {
    let answered = false;
    const originalAnswer = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = async (...args) => {
        answered = true;
        return originalAnswer(...args);
    };

    const timeout = setTimeout(async () => {
        if (!answered) {
            try {
                await originalAnswer();
                answered = true;
            } catch (e) {}
        }
    }, 8000);

    try {
        await next();
    } finally {
        clearTimeout(timeout);
        if (!answered) {
            try { await originalAnswer(); } catch (e) {}
        }
    }
});

// ==========================================
// ASSETS & MENUS
// ==========================================
const IMG_MAIN_BANNER = process.env.IMG_MAIN_BANNER || "https://i.imgur.com/iNaOiyf.jpg";
const IMG_MPESA_BANNER = process.env.IMG_MPESA_BANNER || "https://i.imgur.com/iNaOiyf.jpg";

const CATEGORIES = {
    'cat_1': '📺🔞KENYAN PORN🥵',
    'cat_2': '📺🍆TRENDING LEAKS💦',
    'cat_3': '📺🥵SOMALIA PORN🔞',
    'cat_4': '❤CHEPTOO LEAKS💦',
    'cat_all': '💎ALL ACCESS PASS💎'
};

const CATEGORY_PRICES = {
    'cat_1': { 'WEEKLY': 1, 'MONTHLY': 399, 'QUARTERLY': 999, 'LIFETIME': 1299 },
    'cat_2': { 'WEEKLY': 299, 'MONTHLY': 499, 'QUARTERLY': 899, 'LIFETIME': 1199 },
    'cat_3': { 'WEEKLY': 199, 'MONTHLY': 399, 'QUARTERLY': 499, 'LIFETIME': 1199 },
    'cat_4': { 'WEEKLY': 199, 'MONTHLY': 299, 'QUARTERLY': 899, 'LIFETIME': 1299 },
    'cat_all': { 'WEEKLY': 399, 'MONTHLY': 999, 'QUARTERLY':1599, 'LIFETIME': 1999 }
};

const PLAN_LABELS = {
    'WEEKLY': '7 Days',
    'MONTHLY': '30 Days',
    'QUARTERLY': '90 Days',
    'LIFETIME': 'Lifetime'
};

const USD_RATE = 130;

// ==========================================
// HELPERS
// ==========================================
function getPlanDays(plan) {
    const plans = { 'WEEKLY': 7, 'MONTHLY': 30, 'QUARTERLY': 90, 'LIFETIME': 36500 };
    return plans[plan] || 30;
}

function getPlanDisplay(plan) {
    const displays = { 'WEEKLY': "7 days", 'MONTHLY': "30 days", 'QUARTERLY': "90 days", 'LIFETIME': "Lifetime access" };
    return displays[plan] || "30 days";
}

function getCategoryKeyFromSub(sub) {
    if (sub.categoryKey) return sub.categoryKey;
    for (const [key, name] of Object.entries(CATEGORIES)) {
        if (name === sub.category) return key;
    }
    return 'cat_1';
}

function md(text) {
    if (!text) return '';
    return text.toString()
        .replace(/[*_`]/g, '')
        .replace(/\[/g, '(')
        .replace(/\]/g, ')')
        .replace(/\\/g, '/');
}

async function getOrCreateUser(ctx) {
    const from = ctx.from;
    let user = await User.findOne({ telegramId: from.id });
    if (!user) {
        user = new User({
            telegramId: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
            isActive: true
        });
        await user.save();
    } else if (user.isActive === false) {
        user.isActive = true;
        await user.save();
    }
    return user;
}

async function unbanUserFromChannel(userId, channelId = VIP_CHANNEL_ID) {
    try {
        await bot.api.unbanChatMember(channelId, userId);
        await User.findOneAndUpdate({ telegramId: userId }, { bannedFromChannel: false });
        return true;
    } catch (err) {
        return false;
    }
}

async function banUserFromChannel(userId, channelId = VIP_CHANNEL_ID) {
    try {
        await bot.api.banChatMember(channelId, userId);
        await User.findOneAndUpdate({ telegramId: userId }, { bannedFromChannel: true });
        return true;
    } catch (err) {
        return false;
    }
}

async function safeEditMessage(ctx, text, replyMarkup, parseMode = "Markdown") {
    try {
        if (ctx.callbackQuery?.message?.photo && ctx.callbackQuery.message.photo.length > 0) {
            await ctx.editMessageCaption({ caption: text, reply_markup: replyMarkup, parse_mode: parseMode });
        } else {
            await ctx.editMessageText(text, { reply_markup: replyMarkup, parse_mode: parseMode });
        }
    } catch (err) {
        if (err.message?.includes('bot was blocked') || err.message?.includes('403')) {
            return;
        }
        if (err.message && err.message.includes("message is not modified")) {
            return;
        }
        if (err.message && (err.message.includes("can't parse entities") || err.message.includes("Can't find end"))) {
            const cleanText = text.replace(/[*_`]/g, '');
            try {
                if (ctx.callbackQuery?.message?.photo && ctx.callbackQuery.message.photo.length > 0) {
                    await ctx.editMessageCaption({ caption: cleanText, reply_markup: replyMarkup });
                } else {
                    await ctx.editMessageText(cleanText, { reply_markup: replyMarkup });
                }
            } catch (err2) {
                console.error("safeEditMessage plain fallback failed:", err2.message);
                try { await ctx.reply(cleanText, { reply_markup: replyMarkup }); } catch (e) {}
            }
        } else {
            console.error("safeEditMessage error:", err.message);
            try { await ctx.reply(text, { reply_markup: replyMarkup }); } catch (e) {}
        }
    }
}

async function logAction(telegramId, action, source = 'organic', metadata = {}) {
    try { await UserActionLog.create({ telegramId, action, source, metadata }); } catch (e) {}
}

function getAccountText(user) {
    const activeSubs = user.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date());
    let text = `👤 *MY ACCOUNT*\n━━━━━━━━━━━━━━━\n`;
    text += `Welcome back, *${md(user.firstName) || 'VIP Member'}*${user.username ? ' (@' + md(user.username) + ')' : ''}!\n\n`;

    if (activeSubs.length === 0) {
        text += `❌ You have no active subscriptions.\n\nTap below to subscribe or renew 👇`;
    } else {
        text += `📦 *ACTIVE SUBSCRIPTIONS*\n━━━━━━━━━━━━━━━\n`;
        activeSubs.forEach((sub, i) => {
            const daysLeft = Math.ceil((sub.endDate - new Date()) / (1000 * 60 * 60 * 24));
            text += `\n${i + 1}. *${md(sub.category)}*\n`;
            text += `   📅 Plan: ${md(sub.plan)} (${getPlanDisplay(sub.plan)})\n`;
            text += `   💵 Amount: KES ${sub.amount}\n`;
            text += `   ⏳ Expires in: *${daysLeft} days*\n`;
            text += `   📆 Expiry Date: ${sub.endDate.toLocaleDateString()}\n`;
        });
    }

    if (text.length > 900) {
        text = text.substring(0, 900) + '\n\n...';
    }
    return text;
}

function getAccountMenu(user) {
    const menu = new InlineKeyboard();
    const activeSubs = user.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date());

    if (activeSubs.length > 0) {
        activeSubs.forEach(sub => {
            const catKey = getCategoryKeyFromSub(sub);
            const prices = CATEGORY_PRICES[catKey];
            if (prices && prices[sub.plan]) {
                menu.text(`♻️ Renew ${md(sub.category)} — ${md(sub.plan)}`, `renew_${sub.plan}_${prices[sub.plan]}_${catKey}`).row();
            }
        });

        if (activeSubs.length >= 1) {
            const sub = activeSubs[0];
            const catKey = getCategoryKeyFromSub(sub);
            const prices = CATEGORY_PRICES[catKey];
            const planOrder = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'LIFETIME'];
            const rank = { WEEKLY: 1, MONTHLY: 2, QUARTERLY: 3, LIFETIME: 4 };
            const currentRank = rank[sub.plan] || 0;

            planOrder.forEach(plan => {
                if (!prices || !prices[plan] || plan === sub.plan) return;
                const amount = prices[plan];
                const isUpgrade = rank[plan] > currentRank;
                const prefix = isUpgrade ? '🚀' : '⭐';
                menu.text(`${prefix} ${PLAN_LABELS[plan]} | ${amount}/-`, `renew_${plan}_${amount}_${catKey}`).row();
            });
        }
    } else {
        menu.text("💎 Get VIP Access", "back_home").row();
    }

    menu.text("🏠 Home", "back_home");
    return menu;
}

async function notifyAdminNewSubscription(user, sub) {
    const planDetail = `${sub.category} — ${sub.plan}`;
    const text = `💰 *NEW SALE: ${md(planDetail)}*\n━━━━━━━━━━━━━━━\n👤 ${md(user.firstName) || 'Unknown'} (@${md(user.username) || 'N/A'})\n🆔 ${user.telegramId}\n📱 ${md(user.phone) || 'N/A'}\n📦 ${md(sub.category)}\n📅 ${md(sub.plan)}\n💵 KES ${sub.amount}\n🕐 ${sub.startDate.toLocaleString()}`;

    if (ADMIN_CHANNEL_ID) {
        try {
            await bot.api.sendMessage(ADMIN_CHANNEL_ID, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error('Admin channel notify (new) failed:', e.message);
        }
    }

    for (const adminId of ADMIN_IDS) {
        try {
            await bot.api.sendMessage(adminId, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error(`Admin DM notify (new) failed for ${adminId}:`, e.message);
        }
    }
}

async function notifyAdminRemoval(user, sub) {
    const planDetail = `${sub.category} — ${sub.plan}`;
    const text = `🚫 *REMOVED: ${md(planDetail)}*\n━━━━━━━━━━━━━━━\n👤 ${md(user.firstName) || 'Unknown'} (@${md(user.username) || 'N/A'})\n🆔 ${user.telegramId}\n📦 ${md(sub.category)}\n📅 ${md(sub.plan)} (expired)\n🕐 ${new Date().toLocaleString()}`;

    if (ADMIN_CHANNEL_ID) {
        try {
            await bot.api.sendMessage(ADMIN_CHANNEL_ID, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error('Admin channel notify (removal) failed:', e.message);
        }
    }

    for (const adminId of ADMIN_IDS) {
        try {
            await bot.api.sendMessage(adminId, text, { parse_mode: "Markdown" });
        } catch (e) {
            console.error(`Admin DM notify (removal) failed for ${adminId}:`, e.message);
        }
    }
}

// ==========================================
// SOCIAL PROOF & URGENCY HELPERS
// ==========================================
async function getSocialProofText() {
    try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recentSales = await UserActionLog.countDocuments({
            action: 'payment_success',
            createdAt: { $gte: oneHourAgo }
        });
        if (recentSales > 0) {
            return `🔥 *${recentSales}* member${recentSales > 1 ? 's' : ''} joined in the last hour\n`;
        }
    } catch (e) {}
    return `🔥 *Join 2,000+ satisfied members*\n`;
}

function getUrgencyText() {
    const hoursLeft = 24 - new Date().getHours();
    return `⏳ *Flash pricing ends in ${hoursLeft}h*\n`;
}

// ==========================================
// FIXED PLAN MENU — OUTCOME FOCUSED, NO DAILY COST
// ==========================================
function getDurationMenu(categoryKey) {
    const prices = CATEGORY_PRICES[categoryKey];
    const menu = new InlineKeyboard();

    if (!prices) {
        menu.text("🏠 Home", "back_home");
        return menu;
    }

    if (prices['WEEKLY']) {
        menu.text(`🚀 ${PLAN_LABELS['WEEKLY']} | ${prices['WEEKLY']}/- ✅ Instant`, `plan_WEEKLY_${prices['WEEKLY']}`).row();
    }

    if (prices['MONTHLY']) {
        const weeklyCost = prices['WEEKLY'] ? prices['WEEKLY'] * 4 : 0;
        const savings = weeklyCost > prices['MONTHLY'] ? Math.round(weeklyCost - prices['MONTHLY']) : 0;
        const savingsText = savings > 0 ? ` ⭐ SAVE ${savings}` : '';
        menu.text(`🔥 ${PLAN_LABELS['MONTHLY']} | ${prices['MONTHLY']}/-${savingsText}`, `plan_MONTHLY_${prices['MONTHLY']}`).row();
    }

    if (prices['QUARTERLY']) {
        menu.text(`⭐ ${PLAN_LABELS['QUARTERLY']} | ${prices['QUARTERLY']}/- 🔒 Lock Price`, `plan_QUARTERLY_${prices['QUARTERLY']}`).row();
    }

    if (prices['LIFETIME']) {
        menu.text(`👑 ${PLAN_LABELS['LIFETIME']} | ${prices['LIFETIME']}/- 💎 Forever`, `plan_LIFETIME_${prices['LIFETIME']}`).row();
    }

    menu.text("🔙 Back", "back_home");
    return menu;
}

const mainMenu = new InlineKeyboard()
    .text("📺🔞KENYAN PORN🥵💦", "cat_1").row()
    .text("📺💦TRENDING LEAKS🍆", "cat_2").row()
    .text("📺🥵SOMALI PORN🍆", "cat_3").row()
    .text("❤🍆CHEPTOO LEAKS🔞", "cat_4").row()
    .text("💎ALL ACCESS💎", "cat_all").row()
    .text("👤 My Account", "my_account").row()
    .url("💬 Support", `https://t.me/${SUPPORT_USER}`).row()
    .text("ℹ️ About", "about")
    .text("📋 Menu", "menu");

const cancelMenu = new InlineKeyboard()
    .text("🔙 Cancel", "back_home")
    .text("🏠 Home", "back_home");

function psychologyRenewMenu(categoryKey, currentPlan) {
    const prices = CATEGORY_PRICES[categoryKey];
    const menu = new InlineKeyboard();

    if (!prices) {
        menu.text("🏠 Home", "back_home");
        return menu;
    }

    const planOrder = ['LIFETIME', 'QUARTERLY', 'MONTHLY', 'WEEKLY'];
    const rank = { WEEKLY: 1, MONTHLY: 2, QUARTERLY: 3, LIFETIME: 4 };
    const currentRank = rank[currentPlan] || 0;

    planOrder.forEach(plan => {
        if (!prices[plan]) return;
        const amount = prices[plan];
        const isCurrent = plan === currentPlan;
        const isUpgrade = rank[plan] > currentRank;

        let prefix = '';
        if (isCurrent) prefix = '♻️ ';
        else if (plan === 'LIFETIME') prefix = '👑 ';
        else if (plan === 'QUARTERLY') prefix = '🔥 ';
        else if (plan === 'MONTHLY') prefix = '⭐ ';
        else if (plan === 'WEEKLY') prefix = '🚀 ';

        let suffix = '';
        if (isCurrent) suffix = ' (Current)';
        else if (isUpgrade) suffix = ' 🚀 UPGRADE';

        menu.text(`${prefix}${PLAN_LABELS[plan]} | ${amount}/-${suffix}`, `renew_${plan}_${amount}_${categoryKey}`).row();
    });

    menu.text("🏠 Home", "back_home");
    return menu;
}

// ==========================================
// STK PUSH HELPER — WITH 503 RETRY ONLY
// ==========================================
async function fireSTK(phone, amount, reference, categoryName, planName, callbackUrl, ctx) {
    console.log(`[STK] Firing for ${phone} - KES ${amount} (${categoryName} ${planName}) ref:${reference}`);

    const payload = {
        api_key: process.env.MEGAPAY_API_KEY,
        email: process.env.MEGAPAY_EMAIL,
        amount: amount,
        msisdn: phone,
        callback_url: callbackUrl,
        description: `${categoryName} — ${planName}`,
        reference: reference
    };

    const makeRequest = () => axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);

    try {
        let stkRes = await makeRequest();

        // Retry once on 503 timeout
        const resultCode = stkRes.data?.ResultCode || stkRes.data?.ResponseCode || stkRes.data?.resultCode || stkRes.data?.responseCode;
        if (resultCode === "503" || resultCode === 503) {
            console.log(`[STK] Got 503, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            stkRes = await makeRequest();
        }

        console.log(`[STK] API Response:`, JSON.stringify(stkRes.data));

        const stkResult = stkRes.data?.ResultCode || stkRes.data?.ResponseCode || stkRes.data?.resultCode || stkRes.data?.responseCode;
        const stkSuccess = stkRes.data?.success || stkRes.data?.Success;

        if (stkResult !== undefined && stkResult !== "0" && stkResult !== 0) {
            console.error(`[STK] API returned error code: ${stkResult}`, JSON.stringify(stkRes.data));
            await ctx.reply(`❌ M-Pesa failed: ${stkRes.data?.message || stkRes.data?.ResultDesc || stkRes.data?.ResponseDescription || 'Error ' + stkResult}\n\nType /start to try again.`);
            return false;
        } else if (stkSuccess === false) {
            console.error(`[STK] API returned success=false:`, JSON.stringify(stkRes.data));
            await ctx.reply(`❌ M-Pesa failed: ${stkRes.data?.message || 'Unknown error'}\n\nType /start to try again.`);
            return false;
        }
        return true;
    } catch (axiosErr) {
        const status = axiosErr.response?.status;
        const isTimeout = status === 503 || axiosErr.code === 'ECONNABORTED' || axiosErr.code === 'ETIMEDOUT';

        if (isTimeout) {
            console.log(`[STK] HTTP timeout/503, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            try {
                const stkRes = await makeRequest();
                const stkResult = stkRes.data?.ResultCode || stkRes.data?.ResponseCode || stkRes.data?.resultCode || stkRes.data?.responseCode;
                const stkSuccess = stkRes.data?.success || stkRes.data?.Success;

                if ((stkResult !== undefined && stkResult !== "0" && stkResult !== 0) || stkSuccess === false) {
                    throw new Error('Retry failed');
                }
                return true;
            } catch (retryErr) {
                console.error(`[STK] Retry failed:`, retryErr.message);
                await ctx.reply("❌ M-Pesa service is temporarily unavailable. Please try again in a few minutes.\n\nType /start to restart.");
                return false;
            }
        }

        console.error(`[STK] HTTP ERROR:`, status, axiosErr.response?.data || axiosErr.message);
        await ctx.reply("❌ M-Pesa service is temporarily unavailable. Please try again in a few minutes.\n\nType /start to restart.");
        return false;
    }
}

async function cleanupPending(phone, userId) {
    await PendingTransaction.deleteOne({ phone, userId }).catch(() => {});
    pendingTransactions.delete(phone);
}

// ==========================================
// CHANNEL ANALYTICS & ADVISOR ENGINE
// ==========================================
function analyzeCaption(caption) {
    if (!caption) return { length: 0, emojiCount: 0, keywords: [], hasQuestion: false, hasCTA: false };

    const emojis = caption.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu) || [];
    const lower = caption.toLowerCase();

    const powerWords = ['free', 'leak', 'viral', 'exclusive', 'hot', 'new', 'now', 'today', 'limited', 'urgent', 'dm', 'link', 'watch', 'video', 'full', 'uncut', 'premium', 'vip', 'sale', 'discount', 'offer'];
    const keywords = powerWords.filter(w => lower.includes(w));

    const ctas = ['link in bio', 'dm me', 'tap', 'click', 'join', 'subscribe', 'buy', 'pay', 'get', 'access', 'comment', 'share'];
    const hasCTA = ctas.some(c => lower.includes(c));

    return {
        length: caption.length,
        emojiCount: emojis.length,
        keywords,
        hasQuestion: lower.includes('?'),
        hasCTA,
        hasNumbers: /\d/.test(caption)
    };
}

async function trackChannelPost(ctx) {
    try {
        const msg = ctx.channelPost || ctx.msg;
        if (!msg) return;

        const chatId = msg.chat.id.toString();
        if (MAIN_CHANNEL_ID && chatId !== MAIN_CHANNEL_ID && chatId !== VIP_CHANNEL_ID) return;

        const caption = msg.caption || msg.text || '';
        const analysis = analyzeCaption(caption);

        const postedAt = new Date(msg.date * 1000);

        const post = new ChannelPost({
            messageId: msg.message_id,
            channelId: chatId,
            caption: caption.substring(0, 500),
            captionLength: analysis.length,
            emojiCount: analysis.emojiCount,
            hasVideo: !!msg.video,
            hasPhoto: !!msg.photo,
            hasText: !!msg.text && !msg.caption,
            keywords: analysis.keywords,
            postedAt: postedAt,
            hour: postedAt.getHours(),
            dayOfWeek: postedAt.getDay()
        });

        await post.save();
        console.log(`[ADVISOR] Tracked post ${msg.message_id} from channel ${chatId} at ${postedAt.toISOString()}`);
    } catch (err) {
        console.error('[ADVISOR] Track post error:', err.message);
    }
}

async function analyzePostPerformance() {
    const unanalyzed = await ChannelPost.find({ analyzed: false }).limit(50);

    for (const post of unanalyzed) {
        const postTime = post.postedAt;
        const window1h = new Date(postTime.getTime() + 60 * 60 * 1000);
        const window3h = new Date(postTime.getTime() + 3 * 60 * 60 * 1000);
        const window24h = new Date(postTime.getTime() + 24 * 60 * 60 * 1000);

        post.botStarts1h = await UserActionLog.countDocuments({
            action: 'start',
            createdAt: { $gte: postTime, $lte: window1h }
        });

        post.botStarts3h = await UserActionLog.countDocuments({
            action: 'start',
            createdAt: { $gte: postTime, $lte: window3h }
        });

        const sales1h = await UserActionLog.find({
            action: 'payment_success',
            createdAt: { $gte: postTime, $lte: window1h }
        });
        post.sales1h = sales1h.length;
        post.revenue1h = sales1h.reduce((sum, s) => sum + (s.metadata?.amount || 0), 0);

        const sales3h = await UserActionLog.find({
            action: 'payment_success',
            createdAt: { $gte: postTime, $lte: window3h }
        });
        post.sales3h = sales3h.length;
        post.revenue3h = sales3h.reduce((sum, s) => sum + (s.metadata?.amount || 0), 0);

        const sales24h = await UserActionLog.find({
            action: 'payment_success',
            createdAt: { $gte: postTime, $lte: window24h }
        });
        post.sales24h = sales24h.length;
        post.revenue24h = sales24h.reduce((sum, s) => sum + (s.metadata?.amount || 0), 0);

        post.analyzed = true;
        await post.save();
    }

    if (unanalyzed.length > 0) {
        console.log(`[ADVISOR] Analyzed ${unanalyzed.length} posts`);
    }
}

async function generateAdvisorReport() {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const posts = await ChannelPost.find({ postedAt: { $gte: since } });

    if (posts.length < 5) {
        return `📊 *POSTING ADVISOR*\n━━━━━━━━━━━━━━━\n\nNot enough data yet. I've tracked *${posts.length}* posts.\n\n*To use this feature:*\n1️⃣ Add this bot as ADMIN to your main channel\n2️⃣ Post normally\n3️⃣ Check back after 5+ posts\n\nThe advisor learns from your posting times vs sales performance.`;
    }

    const hourStats = {};
    const dayStats = {};
    const captionStats = { short: [], medium: [], long: [] };
    const emojiStats = { none: [], low: [], high: [] };
    const keywordStats = {};

    for (const p of posts) {
        if (!hourStats[p.hour]) hourStats[p.hour] = { count: 0, sales: 0, revenue: 0, starts: 0 };
        hourStats[p.hour].count++;
        hourStats[p.hour].sales += p.sales3h;
        hourStats[p.hour].revenue += p.revenue3h;
        hourStats[p.hour].starts += p.botStarts3h;

        const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][p.dayOfWeek];
        if (!dayStats[dayName]) dayStats[dayName] = { count: 0, sales: 0, revenue: 0 };
        dayStats[dayName].count++;
        dayStats[dayName].sales += p.sales3h;
        dayStats[dayName].revenue += p.revenue3h;

        const bucket = p.captionLength < 100 ? 'short' : p.captionLength < 300 ? 'medium' : 'long';
        captionStats[bucket].push({ sales: p.sales3h, revenue: p.revenue3h });

        const emoBucket = p.emojiCount === 0 ? 'none' : p.emojiCount < 5 ? 'low' : 'high';
        emojiStats[emoBucket].push({ sales: p.sales3h, revenue: p.revenue3h });

        for (const kw of p.keywords) {
            if (!keywordStats[kw]) keywordStats[kw] = { count: 0, sales: 0 };
            keywordStats[kw].count++;
            keywordStats[kw].sales += p.sales3h;
        }
    }

    let bestHour = null, bestHourScore = -1;
    for (const [h, data] of Object.entries(hourStats)) {
        if (data.count < 2) continue;
        const score = (data.sales / data.count) * 10 + (data.revenue / data.count / 100);
        if (score > bestHourScore) {
            bestHourScore = score;
            bestHour = parseInt(h);
        }
    }

    let bestDay = null, bestDayScore = -1;
    for (const [d, data] of Object.entries(dayStats)) {
        if (data.count < 2) continue;
        const score = (data.sales / data.count) * 10 + (data.revenue / data.count / 100);
        if (score > bestDayScore) {
            bestDayScore = score;
            bestDay = d;
        }
    }

    const avgSales = (bucket) => {
        const arr = captionStats[bucket];
        return arr.length ? (arr.reduce((s, a) => s + a.sales, 0) / arr.length).toFixed(1) : 0;
    };
    const bestCaptionLen = ['short','medium','long'].reduce((a, b) => parseFloat(avgSales(a)) > parseFloat(avgSales(b)) ? a : b);

    const avgEmoSales = (bucket) => {
        const arr = emojiStats[bucket];
        return arr.length ? (arr.reduce((s, a) => s + a.sales, 0) / arr.length).toFixed(1) : 0;
    };
    const bestEmoji = ['none','low','high'].reduce((a, b) => parseFloat(avgEmoSales(a)) > parseFloat(avgEmoSales(b)) ? a : b);

    const topKeywords = Object.entries(keywordStats)
        .filter(([_, d]) => d.count >= 2)
        .sort((a, b) => (b[1].sales / b[1].count) - (a[1].sales / a[1].count))
        .slice(0, 3)
        .map(([k, d]) => `${k} (${(d.sales/d.count).toFixed(1)} sales/post)`);

    const now = new Date();
    const last7Start = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const prev7Start = new Date(now - 14 * 24 * 60 * 60 * 1000);

    const last7Sales = posts.filter(p => p.postedAt >= last7Start).reduce((s, p) => s + p.sales3h, 0);
    const prev7Sales = posts.filter(p => p.postedAt >= prev7Start && p.postedAt < last7Start).reduce((s, p) => s + p.sales3h, 0);
    const trend = last7Sales > prev7Sales ? '📈 IMPROVING' : last7Sales < prev7Sales ? '📉 DECLINING' : '➡️ STABLE';

    const nextRec = getNextRecommendation(bestHour, bestDay, posts);

    let text = `🧠 *POSTING ADVISOR — 30 DAY REPORT*\n━━━━━━━━━━━━━━━\n`;
    text += `📊 Posts analyzed: *${posts.length}*\n`;
    text += `💰 Total tracked revenue: *KES ${posts.reduce((s, p) => s + p.revenue3h, 0)}*\n`;
    text += `📈 Trend: *${trend}* (${last7Sales} vs ${prev7Sales} sales)\n\n`;

    text += `*⏰ BEST POSTING TIME*\n━━━━━━━━━━━━━━━\n`;
    if (bestHour !== null) {
        const timeStr = `${bestHour.toString().padStart(2,'0')}:00`;
        const hourData = hourStats[bestHour];
        text += `🔥 Optimal hour: *${timeStr}*\n`;
        text += `   📊 ${hourData.count} posts | ${hourData.sales} sales | KES ${hourData.revenue}\n`;
        text += `   📈 Avg: ${(hourData.sales/hourData.count).toFixed(1)} sales/post\n`;
    } else {
        text += `⏳ Still collecting hourly data...\n`;
    }

    if (bestDay) {
        const dayData = dayStats[bestDay];
        text += `📅 Best day: *${bestDay}* (${(dayData.sales/dayData.count).toFixed(1)} sales/post)\n`;
    }

    text += `\n*📝 CAPTION INSIGHTS*\n━━━━━━━━━━━━━━━\n`;
    text += `✂️ Best length: *${bestCaptionLen.toUpperCase()}* captions\n`;
    text += `   (Short: ${avgSales('short')} | Med: ${avgSales('medium')} | Long: ${avgSales('long')} avg sales)\n`;
    text += `😀 Emoji usage: *${bestEmoji.toUpperCase()}* performs best\n`;
    text += `   (None: ${avgEmoSales('none')} | Low: ${avgEmoSales('low')} | High: ${avgEmoSales('high')} avg sales)\n`;

    if (topKeywords.length > 0) {
        text += `\n*🏆 TOP POWER WORDS*\n━━━━━━━━━━━━━━━\n`;
        topKeywords.forEach(k => text += `• ${k}\n`);
    }

    text += `\n*💡 RECOMMENDATION*\n━━━━━━━━━━━━━━━\n`;
    text += `${nextRec}\n`;

    text += `\n*⚡ QUICK TIPS*\n━━━━━━━━━━━━━━━\n`;
    if (bestHour !== null) {
        const avoidHours = Object.entries(hourStats)
            .filter(([h, d]) => d.count >= 2 && parseInt(h) !== bestHour)
            .sort((a, b) => (a[1].sales/a[1].count) - (b[1].sales/b[1].count))
            .slice(0, 2)
            .map(([h, _]) => `${h}:00`);
        if (avoidHours.length) text += `❌ Avoid posting at: ${avoidHours.join(', ')}\n`;
    }
    text += `✅ Post ${bestCaptionLen} captions with ${bestEmoji} emoji usage\n`;
    text += `✅ Include power words: ${topKeywords.slice(0, 3).map(k => k.split(' ')[0]).join(', ') || 'leak, hot, exclusive'}\n`;
    text += `✅ Always include a CTA (call-to-action) like "Tap link in bio"`;

    return text;
}

function getNextRecommendation(bestHour, bestDay, posts) {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let rec = `🎯 *Next optimal post:*\n`;

    if (bestHour !== null && bestDay) {
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const tomorrowDay = days[tomorrow.getDay()];
        const timeStr = `${bestHour.toString().padStart(2,'0')}:00`;
        rec += `📅 *${tomorrowDay} at ${timeStr}* (your proven best slot)\n`;
    } else if (bestHour !== null) {
        rec += `📅 *Tomorrow at ${bestHour.toString().padStart(2,'0')}:00*\n`;
    } else {
        rec += `📅 *Tomorrow 8:00 PM* (default prime time)\n`;
    }

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayPosts = posts.filter(p => p.postedAt >= todayStart);

    if (todayPosts.length === 0) {
        rec += `\n⚠️ You haven't posted *today*!`;
        rec += `\n🔥 Post *now* to maintain momentum.`;
    } else if (todayPosts.length === 1) {
        rec += `\n✅ Good: 1 post today.`;
        rec += `\n💡 For max sales, aim for *2 posts/day* (morning + evening).`;
    } else if (todayPosts.length >= 3) {
        rec += `\n⚠️ You've posted *${todayPosts.length} times* today.`;
        rec += `\n📉 Risk of audience fatigue. Consider 1-2 posts max.`;
    } else {
        rec += `\n✅ Perfect posting frequency today.`;
    }

    if (todayPosts.length > 0) {
        const lastPost = todayPosts.sort((a, b) => b.postedAt - a.postedAt)[0];
        const hoursSince = Math.floor((now - lastPost.postedAt) / (1000 * 60 * 60));
        if (hoursSince < 3) {
            rec += `\n⏳ Last post was ${hoursSince}h ago. Wait *${3 - hoursSince} more hours* before next post.`;
        } else {
            rec += `\n✅ ${hoursSince}h since last post. Safe to post now.`;
        }
    }

    return rec;
}

// ==========================================
// BAN NOTICE / CHANNEL RECOVERY
// ==========================================
async function sendBanNoticeToActiveVIPs(targetChannelId = null) {
    const channelId = targetChannelId || VIP_CHANNEL_ID_BACKUP || VIP_CHANNEL_ID;
    const now = new Date();
    const users = await User.find({
        isActive: { $ne: false },
        'subscriptions.status': 'active',
        'subscriptions.endDate': { $gt: now }
    });

    let sent = 0, failed = 0, skipped = 0;

    for (const user of users) {
        try {
            const activeSub = user.subscriptions
                .filter(s => s.status === 'active' && s.endDate > now)
                .sort((a, b) => b.startDate - a.startDate)[0];
            if (!activeSub) { skipped++; continue; }

            await unbanUserFromChannel(user.telegramId, channelId);
            await new Promise(r => setTimeout(r, 2000));

            const invite = await bot.api.createChatInviteLink(channelId, {
                member_limit: 1,
                name: `Recovery: ${activeSub.category} ${activeSub.plan}`,
                expire_date: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
            });

            activeSub.inviteLink = invite.invite_link;
            await user.save();

            const text = `🚨 *CHANNEL MIGRATION NOTICE*\n━━━━━━━━━━━━━━━\n\nMheshimiwa *${md(user.firstName) || 'VIP'}*,\n\nOur VIP channel has been migrated to a new secure location. Your subscription is **still active**.\n\n📦 *YOUR ACTIVE PLAN*\n▪️ ${md(activeSub.category)} — ${md(activeSub.plan)}\n▪️ Expires: ${activeSub.endDate.toLocaleDateString()}\n▪️ Amount Paid: KES ${activeSub.amount}\n\n🔗 *NEW VIP CHANNEL*\nClick below to join. This link expires in 7 days and can only be used once.`;

            const recoveryMenu = new InlineKeyboard()
                .url(`🔗 JOIN NEW VIP CHANNEL`, invite.invite_link).row()
                .url("💬 Support", `https://t.me/${SUPPORT_USER}`);

            await bot.api.sendMessage(user.telegramId, text, {
                parse_mode: "Markdown",
                reply_markup: recoveryMenu
            });
            sent++;
        } catch (err) {
            failed++;
            if (err.description?.includes('Too Many Requests')) {
                const retryAfter = err.parameters?.retry_after || 35;
                console.log(`[RECOVERY] Rate limited. Sleeping ${retryAfter}s...`);
                await new Promise(r => setTimeout(r, retryAfter * 1000));
                try {
                    const activeSub = user.subscriptions.filter(s => s.status === 'active')[0];
                    if (!activeSub) { skipped++; continue; }
                    const invite = await bot.api.createChatInviteLink(channelId, {
                        member_limit: 1,
                        name: `Recovery: ${activeSub.category} ${activeSub.plan}`,
                        expire_date: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
                    });
                    const recoveryMenu = new InlineKeyboard()
                        .url(`🔗 JOIN NEW VIP CHANNEL`, invite.invite_link).row()
                        .url("💬 Support", `https://t.me/${SUPPORT_USER}`);
                    await bot.api.sendMessage(user.telegramId, text, {
                        parse_mode: "Markdown",
                        reply_markup: recoveryMenu
                    });
                    sent++; failed--;
                } catch (e2) {}
            } else if (err.description === "Forbidden: bot was blocked by the user") {
                user.isActive = false;
                await user.save();
            }
        }
    }
    return { sent, failed, skipped, total: users.length };
}

// ==========================================
// CONVERSATION: M-PESA STK PUSH
// ==========================================
async function mpesaPrompt(conversation, ctx) {
    try {
        const intent = userIntent.get(ctx.from.id);
        if (!intent) {
            await ctx.reply("❌ Session expired. Type /start to restart.");
            return;
        }

        const categoryName = intent.category || "VIP Access";
        const planName = intent.plan || "Subscription";
        let amountToPay = parseFloat(intent.amount || 0);
        const catKey = intent.categoryKey || "cat_1";

        if (amountToPay === 0) amountToPay = 99;

        const numberCtx = await conversation.wait();
        const rawPhone = numberCtx.message?.text;

        if (!rawPhone) {
            await ctx.reply("❌ Invalid input. Type /start to try again.");
            userIntent.delete(ctx.from.id);
            return;
        }

        try { await numberCtx.deleteMessage(); } catch (e) {}

        let phone = rawPhone.replace(/\D/g, '');
        if (phone.startsWith('0')) phone = '254' + phone.slice(1);
        else if (!phone.startsWith('254')) phone = '254' + phone;

        if (phone.length !== 12) {
            await ctx.reply("❌ Invalid phone number. Type /start to try again.");
            userIntent.delete(ctx.from.id);
            return;
        }

        // Save phone for future 1-click checkout
        await User.findOneAndUpdate(
            { telegramId: ctx.from.id },
            { phone: phone },
            { upsert: true }
        );

        // Check for recent duplicate session BEFORE creating new one
        const recentPending = await PendingTransaction.findOne({
            phone,
            userId: ctx.from.id,
            createdAt: { $gte: new Date(Date.now() - 90 * 1000) }
        });
        if (recentPending) {
            await ctx.reply("⏳ You already have a pending M-Pesa request. Please check your phone for the STK push, or wait 90 seconds before trying again.");
            userIntent.delete(ctx.from.id);
            return;
        }

        await ctx.reply("⏳ Sending M-Pesa prompt to your phone...\n\n📱 Check for STK push & enter your PIN.", {
            reply_markup: cancelMenu
        });

        const reference = 'DEP' + Date.now();
        const txData = {
            phone,
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
            amount: amountToPay,
            category: categoryName,
            categoryKey: catKey,
            plan: planName,
            reference: reference,
            date: new Date().toLocaleString()
        };

        await PendingTransaction.findOneAndUpdate(
            { phone, userId: ctx.from.id },
            txData,
            { upsert: true }
        );
        pendingTransactions.set(phone, txData);

        const success = await fireSTK(phone, amountToPay, reference, categoryName, planName, `${process.env.APP_URL}/api/megapay/webhook`, ctx);
        if (!success) {
            await cleanupPending(phone, ctx.from.id);
            userIntent.delete(ctx.from.id);
        }

    } catch (err) {
        const isBlocked = err.message?.includes('bot was blocked') || err.message?.includes('403');
        if (isBlocked) {
            console.log(`[BLOCKED] User ${ctx.from.id} blocked bot during payment.`);
            await PendingTransaction.deleteOne({ userId: ctx.from.id }).catch(() => {});
            return;
        }
        console.error('🛑 CONVERSATION ERROR:', err.message);
        try { await ctx.reply("❌ Payment failed. Type /start to try again."); } catch (e) {}
    } finally {
        userIntent.delete(ctx.from.id);
    }
}

bot.use(createConversation(mpesaPrompt));

// ==========================================
// MEGAPAY WEBHOOK
app.post('/api/megapay/webhook', async (req, res) => {
    // 1. Acknowledge webhook immediately to keep gateway happy
    res.status(200).json({ status: 'OK' });

    try {
        // 2. Unencapsulate payload if wrapped inside nested objects (e.g., Body.stkCallback)
        let data = req.body || {};
        if (data.Body?.stkCallback) data = data.Body.stkCallback;
        if (data.data) data = data.data;

        console.log('[WEBHOOK] Raw body:', JSON.stringify(data));

        function getField(obj, ...names) {
            if (!obj || typeof obj !== 'object') return undefined;
            for (const name of names) {
                if (obj[name] !== undefined) return obj[name];
                const lower = name.toLowerCase();
                if (obj[lower] !== undefined) return obj[lower];
                const camel = lower.charAt(0) + name.slice(1);
                if (obj[camel] !== undefined) return obj[camel];
            }
            return undefined;
        }

        const responseCode = getField(data, 'ResultCode', 'ResponseCode', 'resultCode', 'responseCode');
        const resultDesc = getField(data, 'ResultDesc', 'ResponseDescription', 'resultDesc', 'responseDescription') || '';
        const amount = parseFloat(getField(data, 'TransactionAmount', 'amount', 'Amount', 'transactionAmount') || 0);
        const receipt = getField(data, 'TransactionReceipt', 'MpesaReceiptNumber', 'ReceiptNo', 'transactionReceipt', 'mpesaReceiptNumber', 'receiptNo') || 'N/A';
        const rawCallbackPhone = (getField(data, 'Msisdn', 'phone', 'PhoneNumber', 'msisdn', 'phoneNumber') || "").toString();
        const last9 = rawCallbackPhone.replace(/\D/g, '').slice(-9);
        const callbackRef = getField(data, 'reference', 'Reference', 'TransactionReference', 'transactionReference', 'ref', 'Ref');

        console.log(`[WEBHOOK] Parsed: code=${responseCode}, desc=${resultDesc}, receipt=${receipt}, phoneLast9=${last9}, ref=${callbackRef}`);

        if (responseCode === undefined) {
            console.log('[WEBHOOK] Warning: Could not find ResultCode/ResponseCode in payload keys:', Object.keys(data));
            return;
        }

        // Handle Payment Failure
        if (parseInt(responseCode) !== 0) {
            console.log(`[WEBHOOK] Payment failed with code: ${responseCode} — ${resultDesc}`);

            let failedTx = null;
            if (last9.length >= 9) {
                const dbTxs = await PendingTransaction.find({});
                for (const tx of dbTxs) {
                    if (tx.phone && tx.phone.replace(/\D/g, '').endsWith(last9)) {
                        failedTx = tx;
                        break;
                    }
                }
            }

            if (!failedTx && last9.length >= 9) {
                for (const [phone, txData] of pendingTransactions.entries()) {
                    if (phone.replace(/\D/g, '').endsWith(last9)) {
                        failedTx = txData;
                        break;
                    }
                }
            }

            if (failedTx) {
                let failMsg = `❌ *Payment Failed*\n\n`;
                const code = parseInt(responseCode);
                if (code === 1032) {
                    failMsg += `You cancelled the M-Pesa prompt on your phone.\n\nNo money was deducted. Tap below to try again 👇`;
                } else if (code === 1037) {
                    failMsg += `M-Pesa session timed out. You didn't enter your PIN in time.\n\nTap below to try again 👇`;
                } else if (code === 2035) {
                    failMsg += `M-Pesa could not complete this transaction. Usually means:\n• Wrong PIN entered\n• Insufficient balance\n• You cancelled the prompt\n\nNo money was deducted. Tap below to try again 👇`;
                } else {
                    failMsg += `Reason: ${resultDesc || 'Unknown error'}\n\nTap below to try again 👇`;
                }

                const retryMenu = new InlineKeyboard()
                    .text("🔄 Try Again", "back_home").row()
                    .text("🌍 Pay with Crypto", `payment_intl_${failedTx.plan}_${failedTx.amount}_${failedTx.categoryKey || 'cat_1'}`).row()
                    .url("💬 Support", `https://t.me/${SUPPORT_USER}`);

                try {
                    await bot.api.sendMessage(failedTx.chatId || failedTx.userId, failMsg, {
                        parse_mode: "Markdown",
                        reply_markup: retryMenu
                    });
                } catch (e) {
                    console.error('[WEBHOOK] Error sending failure message:', e.message);
                }

                await PendingTransaction.deleteOne({ _id: failedTx._id || failedTx.id }).catch(() => {});
                if (failedTx.phone) pendingTransactions.delete(failedTx.phone);
            }
            return;
        }

        if (last9.length < 9) {
            console.log('[WEBHOOK] Invalid phone in callback');
            return;
        }

        let transaction = null;
        let matchedPhone = null;

        const dbTxs = await PendingTransaction.find({});
        for (const tx of dbTxs) {
            if (tx.phone && tx.phone.replace(/\D/g, '').endsWith(last9)) {
                transaction = tx;
                matchedPhone = tx.phone;
                console.log(`[WEBHOOK] MongoDB matched by phone: ${tx.phone}`);
                break;
            }
        }

        if (!transaction && callbackRef) {
            for (const tx of dbTxs) {
                if (tx.reference === callbackRef) {
                    transaction = tx;
                    matchedPhone = tx.phone;
                    console.log(`[WEBHOOK] MongoDB matched by reference: ${callbackRef}`);
                    break;
                }
            }
        }

        if (!transaction) {
            for (const [phone, txData] of pendingTransactions.entries()) {
                if (phone.replace(/\D/g, '').endsWith(last9)) {
                    matchedPhone = phone;
                    transaction = txData;
                    console.log(`[WEBHOOK] Memory matched by phone: ${phone}`);
                    break;
                }
            }
        }

        if (!transaction && callbackRef) {
            for (const [phone, txData] of pendingTransactions.entries()) {
                if (txData.reference === callbackRef) {
                    matchedPhone = phone;
                    transaction = txData;
                    console.log(`[WEBHOOK] Memory matched by reference: ${callbackRef}`);
                    break;
                }
            }
        }

        if (!transaction && pendingTransactions.size === 1) {
            const [phone, txData] = pendingTransactions.entries().next().value;
            matchedPhone = phone;
            transaction = txData;
            console.log(`[WEBHOOK] Memory fallback matched (only 1 pending): ${phone}`);
        }

        if (!transaction) {
            console.log(`[WEBHOOK] No pending transaction found for phone ending: ${last9}, ref: ${callbackRef}, dbCount: ${dbTxs.length}, memCount: ${pendingTransactions.size}`);
            return;
        }

        console.log(`[WEBHOOK] Match found for user ${transaction.userId} — ${transaction.category} ${transaction.plan}`);

        await unbanUserFromChannel(transaction.userId);

        const invite = await bot.api.createChatInviteLink(VIP_CHANNEL_ID, {
            member_limit: 1,
            name: `${transaction.category} ${transaction.plan} — ${receipt}`,
            expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
        });

        const endDate = new Date();
        endDate.setDate(endDate.getDate() + getPlanDays(transaction.plan));

        const user = await User.findOneAndUpdate(
            { telegramId: transaction.userId },
            {
                $set: {
                    username: transaction.username,
                    firstName: transaction.firstName,
                    lastName: transaction.lastName,
                    phone: transaction.phone,
                    bannedFromChannel: false,
                    isActive: true
                },
                $push: {
                    subscriptions: {
                        category: transaction.category,
                        categoryKey: transaction.categoryKey,
                        plan: transaction.plan,
                        amount: amount,
                        startDate: new Date(),
                        endDate: endDate,
                        status: 'active',
                        receiptNumber: receipt,
                        inviteLink: invite.invite_link,
                        reminderLevel: 0,
                        renewed: false
                    }
                }
            },
            { upsert: true, returnDocument: 'after' }
        );

        await logAction(transaction.userId, 'payment_success', 'organic', { plan: transaction.plan, amount, receipt });

        const successText = `🎉 *PAYMENT SUCCESSFUL!*\n\nThank you for your payment! Your premium access is now ready.\n\n💰 *PAYMENT DETAILS*\n━━━━━━━━━━━━━━━\n▪️ Amount: KES ${amount}\n▪️ M-Pesa Receipt: ${receipt}\n▪️ Phone: ${rawCallbackPhone}\n▪️ Date: ${transaction.date || new Date().toISOString()}\n\n🔗 *CHANNEL ACCESS*\n━━━━━━━━━━━━━━━\n▪️ Channel: ${md(transaction.category)}\n▪️ Plan: ${md(transaction.plan)}\n▪️ Expires: ${endDate.toLocaleDateString()}\n\n⚠️ *ONE-TIME LINK:* This link can only be used *ONCE*. Once you click and join, it dies immediately. Do NOT share it.\n\nNeed help? Contact our support team.`;

        const linkMenu = new InlineKeyboard()
            .url(`🔗 JOIN ${md(transaction.category)} 🔗`, invite.invite_link).row()
            .url("💬 Support ↗️", `https://t.me/${SUPPORT_USER}`);

        await bot.api.sendMessage(transaction.chatId, successText, {
            reply_markup: linkMenu,
            parse_mode: "Markdown"
        });

        const newSub = user.subscriptions[user.subscriptions.length - 1];
        await notifyAdminNewSubscription(user, newSub);

        await PendingTransaction.deleteOne({ _id: transaction._id || transaction.id }).catch(() => {});
        if (matchedPhone) pendingTransactions.delete(matchedPhone);
        console.log(`✅ Subscription activated: ${transaction.category} ${transaction.plan} for ${transaction.userId} until ${endDate.toISOString()}`);

    } catch (err) {
        console.error("[WEBHOOK] Fatal Error:", err.stack || err.message);
    }
});

// ==========================================
// BOT COMMANDS & NAVIGATION
// ==========================================

bot.command("start", async (ctx) => {
    const source = ctx.match || 'organic';
    const user = await getOrCreateUser(ctx);
    await logAction(user.telegramId, 'start', source);
    const welcomeText = `Hello ${md(ctx.from.first_name) || ''}\n🔥 Welcome to TRENDS LEAKS VIP ACCESS\nChoose your subscription package below 👇`;
    await ctx.replyWithPhoto(IMG_MAIN_BANNER, { caption: welcomeText, reply_markup: mainMenu });
});

bot.command("status", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const activeSubs = user.subscriptions.filter(s => s.status === 'active' && s.endDate > new Date());

    if (activeSubs.length === 0) {
        return ctx.reply("❌ You have no active subscriptions.\n\nTap below to subscribe:", { reply_markup: mainMenu });
    }

    let text = `📊 *YOUR SUBSCRIPTIONS*\n━━━━━━━━━━━━━━━\n`;
    activeSubs.forEach((sub, i) => {
        const daysLeft = Math.ceil((sub.endDate - new Date()) / (1000 * 60 * 60 * 24));
        text += `\n${i + 1}. ${md(sub.category)}\n   📅 Plan: ${md(sub.plan)}\n   ⏳ ${daysLeft} days remaining\n   📆 Expires: ${sub.endDate.toLocaleDateString()}\n`;
    });

    ctx.reply(text, { parse_mode: "Markdown", reply_markup: mainMenu });
});

bot.command("account", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const text = getAccountText(user);
    const menu = getAccountMenu(user);
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: menu });
});

bot.command("advisor", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");
    await ctx.reply("⏳ Crunching your channel data...");
    const report = await generateAdvisorReport();
    await ctx.reply(report, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔄 Refresh", "advisor_refresh") });
});

bot.command("logview", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");
    const args = ctx.match?.split(' ') || [];
    if (args.length < 2) return ctx.reply("Usage: /logview <message_id> <views>\nExample: /logview 12345 2500");

    const msgId = parseInt(args[0]);
    const views = parseInt(args[1]);

    const post = await ChannelPost.findOneAndUpdate(
        { messageId: msgId },
        { views: views },
        { returnDocument: 'after' }
    );

    if (!post) return ctx.reply("❌ Post not found. Make sure the bot is admin in your channel.");
    ctx.reply(`✅ Updated views for post ${msgId}: ${views.toLocaleString()}`);
});

bot.command("admin", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");

    const menu = new InlineKeyboard()
        .text("📊 Stats + Breakdown", "admin_stats").row()
        .text("📢 Broadcast Promo", "admin_broadcast").row()
        .text("👥 24H Sales Report", "admin_users").row()
        .text("🔄 Force Reminder", "admin_remind").row()
        .text("🚨 Send Ban Notice", "admin_ban_notice").row()
        .text("📉 Funnel Analytics", "admin_funnel").row()
        .text("🧠 Posting Advisor", "advisor_refresh").row();

    ctx.reply("🔧 *ADMIN PANEL*", { parse_mode: "Markdown", reply_markup: menu });
});

bot.command("broadcast", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");

    const message = ctx.match;
    if (!message) return ctx.reply("Usage: /broadcast Your promotional message here");

    await sendPromoToAll(message, 'manual');
    ctx.reply("✅ Broadcast initiated!");
});

bot.command("approve", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Unauthorized");
    const args = ctx.match?.split(' ') || [];
    if (args.length < 2) return ctx.reply("Usage: /approve <user_id> <plan>\nExample: /approve 123456789 WEEKLY");

    const targetUserId = parseInt(args[0]);
    const plan = args[1].toUpperCase();

    if (!PLAN_LABELS[plan]) return ctx.reply(`❌ Invalid plan. Available: ${Object.keys(PLAN_LABELS).join(', ')}`);

    try {
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + getPlanDays(plan));

        await unbanUserFromChannel(targetUserId);

        const invite = await bot.api.createChatInviteLink(VIP_CHANNEL_ID, {
            member_limit: 1,
            name: `VIP ${plan} — ADMIN_APPROVED`,
            expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
        });

        const user = await User.findOneAndUpdate(
            { telegramId: targetUserId },
            {
                $setOnInsert: {
                    telegramId: targetUserId,
                    isActive: true,
                    createdAt: new Date()
                },
                $push: {
                    subscriptions: {
                        category: 'VIP Access',
                        categoryKey: 'cat_all',
                        plan: plan,
                        amount: 0,
                        startDate: new Date(),
                        endDate: endDate,
                        status: 'active',
                        receiptNumber: 'ADMIN_APPROVED',
                        inviteLink: invite.invite_link,
                        reminderLevel: 0,
                        renewed: false
                    }
                }
            },
            { upsert: true, returnDocument: 'after' }
        );

        const successText = `🎉 *VIP ACCESS ACTIVATED!*\n\nYour subscription has been approved by admin.\n\n🔗 *CHANNEL ACCESS*\n━━━━━━━━━━━━━━━\n▪️ Plan: ${plan}\n▪️ Expires: ${endDate.toLocaleDateString()}\n\n⚠️ *ONE-TIME LINK:* This link can only be used *ONCE*.`;

        const linkMenu = new InlineKeyboard()
            .url(`🔗 JOIN VIP CHANNEL 🔗`, invite.invite_link).row()
            .url("💬 Support ↗️", `https://t.me/${SUPPORT_USER}`);

        await bot.api.sendMessage(targetUserId, successText, {
            parse_mode: "Markdown",
            reply_markup: linkMenu
        });

        await logAction(targetUserId, 'payment_success', 'admin_approved', { plan, amount: 0 });

        ctx.reply(`✅ Approved ${plan} for user ${targetUserId}. Invite sent.`);
    } catch (err) {
        ctx.reply(`❌ Failed to approve: ${err.message}`);
    }
});

bot.callbackQuery("admin_stats", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Loading stats...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;

    const totalUsers = await User.countDocuments();
    const activeSubs = await User.countDocuments({ 'subscriptions.status': 'active', 'subscriptions.endDate': { $gt: new Date() } });

    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);

    const todayUsers = await User.find({ 'subscriptions.startDate': { $gte: todayStart } });
    let todayCount = 0;
    let todayRevenue = 0;

    const categoryBreakdown = {};
    const planBreakdown = {};

    todayUsers.forEach(u => {
        u.subscriptions.forEach(s => {
            if (s.startDate >= todayStart) {
                todayCount++;
                todayRevenue += s.amount || 0;

                if (!categoryBreakdown[s.category]) {
                    categoryBreakdown[s.category] = { count: 0, revenue: 0 };
                }
                categoryBreakdown[s.category].count++;
                categoryBreakdown[s.category].revenue += s.amount;

                const planKey = `${s.category} — ${s.plan}`;
                if (!planBreakdown[planKey]) {
                    planBreakdown[planKey] = { count: 0, revenue: 0 };
                }
                planBreakdown[planKey].count++;
                planBreakdown[planKey].revenue += s.amount;
            }
        });
    });

    let breakdownText = '';
    const sortedPlans = Object.entries(planBreakdown).sort((a, b) => b[1].count - a[1].count);
    sortedPlans.forEach(([plan, data]) => {
        breakdownText += `\n${plan}: ${data.count} sales — KES ${data.revenue}`;
    });

    let text = `📊 *TODAY'S STATS*\n━━━━━━━━━━━━━━━\n`;
    text += `👥 Total Users: ${totalUsers}\n`;
    text += `✅ Active Subs: ${activeSubs}\n`;
    text += `💰 Today: ${todayCount} subs — KES ${todayRevenue}\n`;
    text += `📅 ${todayStart.toLocaleDateString()}\n`;

    if (sortedPlans.length > 0) {
        text += `\n🏆 *TOP PERFORMERS TODAY*\n━━━━━━━━━━━━━━━${breakdownText}\n`;
    }

    await ctx.editMessageText(text, { parse_mode: "Markdown" });
});

bot.callbackQuery("admin_broadcast", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    await ctx.reply("Send your broadcast message now or use:\n/broadcast Your message here");
});

bot.callbackQuery("admin_users", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Loading report...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const users = await User.find({
        'subscriptions.startDate': { $gte: twentyFourHoursAgo }
    }).sort({ 'subscriptions.startDate': -1 });

    const planBreakdown = {};
    let totalAmount = 0;
    let count = 0;
    let userList = '';

    users.forEach(u => {
        const recentSubs = u.subscriptions.filter(s => s.startDate >= twentyFourHoursAgo);
        recentSubs.forEach(sub => {
            count++;
            totalAmount += sub.amount || 0;

            const planKey = `${sub.category} — ${sub.plan}`;
            if (!planBreakdown[planKey]) {
                planBreakdown[planKey] = { count: 0, revenue: 0, users: [] };
            }
            planBreakdown[planKey].count++;
            planBreakdown[planKey].revenue += sub.amount;
            planBreakdown[planKey].users.push({
                name: u.firstName || 'Unknown',
                username: u.username || 'N/A',
                id: u.telegramId,
                time: sub.startDate.toLocaleString()
            });

            userList += `\n${count}. ${md(u.firstName) || 'Unknown'} (@${md(u.username) || 'N/A'})\n`;
            userList += `   📦 ${md(sub.category)} — ${md(sub.plan)}\n`;
            userList += `   💵 KES ${sub.amount} | 🕐 ${sub.startDate.toLocaleString()}\n`;
        });
    });

    let breakdownText = '';
    const sortedPlans = Object.entries(planBreakdown).sort((a, b) => b[1].count - a[1].count);
    let rank = 1;
    sortedPlans.forEach(([plan, data]) => {
        breakdownText += `\n${rank}. ${plan}\n   📊 ${data.count} sold | 💰 KES ${data.revenue}`;
        rank++;
    });

    let text = `📋 *24H SALES REPORT*\n━━━━━━━━━━━━━━━\n`;
    text += `👥 Total Subscriptions: ${count}\n`;
    text += `💰 Total Revenue: KES ${totalAmount}\n`;

    if (sortedPlans.length > 0) {
        text += `\n🏆 *SALES BY PLAN (Ranked)*\n━━━━━━━━━━━━━━━${breakdownText}\n`;
    }

    text += `\n━━━━━━━━━━━━━━━\n👤 *DETAILED LIST*\n━━━━━━━━━━━━━━━${userList || '\nNo sales in last 24 hours.'}`;

    if (text.length > 4000) {
        text = text.substring(0, 4000) + '\n\n... (truncated)';
    }

    await ctx.editMessageText(text, { parse_mode: "Markdown" });
});

bot.callbackQuery("admin_remind", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Running reminders...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    await runReminders();
    await ctx.reply("✅ Reminders sent!");
});

bot.callbackQuery("admin_funnel", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Loading funnel...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const totalStarts = await UserActionLog.countDocuments({ action: 'start', createdAt: { $gte: sevenDaysAgo } });
    const showCat = await UserActionLog.countDocuments({ action: { $regex: '^show_cat' }, createdAt: { $gte: sevenDaysAgo } });
    const planMenuShown = await UserActionLog.countDocuments({ action: { $regex: '^plan_menu_shown' }, createdAt: { $gte: sevenDaysAgo } });
    const clickPlan = await UserActionLog.countDocuments({ action: { $regex: '^plan_clicked_' }, createdAt: { $gte: sevenDaysAgo } });
    const payments = await UserActionLog.countDocuments({ action: 'payment_success', createdAt: { $gte: sevenDaysAgo } });
    const conversionRate = totalStarts > 0 ? ((payments / totalStarts) * 100).toFixed(2) : 0;
    let text = `📉 *7-DAY FUNNEL ANALYTICS*\n━━━━━━━━━━━━━━━\n👥 Bot Starts: ${totalStarts}\n🔥 Clicked Category: ${showCat} (${totalStarts > 0 ? ((showCat/totalStarts)*100).toFixed(1) : 0}%)\n📋 Plan Menu Shown: ${planMenuShown} (${showCat > 0 ? ((planMenuShown/showCat)*100).toFixed(1) : 0}%)\n📅 Clicked Plan: ${clickPlan} (${planMenuShown > 0 ? ((clickPlan/planMenuShown)*100).toFixed(1) : 0}%)\n💰 Successful Payments: ${payments} (${conversionRate}%)\n\n`;
    text += `*DIAGNOSIS:*\n`;
    if (planMenuShown < showCat * 0.8) text += `🚨 Plan menu is NOT rendering for ${showCat - planMenuShown} users. Technical issue.`;
    else if (payments === 0 && clickPlan > 0) text += `⚠️ Users click plans but don't pay. Check M-Pesa STK flow or add international payment.`;
    else if (clickPlan === 0 && planMenuShown > 0) text += `⚠️ Users see plans but don't click. Price too high or trust too low.`;
    else if (planMenuShown === 0 && showCat > 0) text += `🚨 Users click categories but plan menu fails to render.`;
    else if (showCat === 0 && totalStarts > 0) text += `🚨 Users start but don't click categories. Welcome screen too confusing.`;
    else if (conversionRate < 2) text += `🔴 CRITICAL: Conversion below 2%.`;
    else if (conversionRate < 5) text += `🟡 LOW: Conversion 2-5%.`;
    else text += `🟢 HEALTHY: Conversion above 5%.`;
    await ctx.editMessageText(text, { parse_mode: "Markdown" });
});

bot.callbackQuery("admin_ban_notice", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const confirmMenu = new InlineKeyboard()
        .text("✅ YES, SEND TO ALL ACTIVE VIPs", "confirm_ban_notice").row()
        .text("❌ Cancel", "admin_back");
    const activeCount = await User.countDocuments({
        isActive: { $ne: false },
        'subscriptions.status': 'active',
        'subscriptions.endDate': { $gt: new Date() }
    });
    await ctx.editMessageText(`🚨 *SEND BAN NOTICE / RECOVERY LINKS*\n━━━━━━━━━━━━━━━\n\nThis will send a new channel invite link to *${activeCount} active VIP members* via DM.\n\n⚠️ *Target Channel:* ${VIP_CHANNEL_ID_BACKUP}\n\nAre you sure?`, { parse_mode: "Markdown", reply_markup: confirmMenu });
});

bot.callbackQuery("confirm_ban_notice", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Sending recovery links...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const { sent, failed, skipped, total } = await sendBanNoticeToActiveVIPs();
    const resultMenu = new InlineKeyboard().text("🔙 Back to Admin", "admin_back");
    await ctx.editMessageText(`📢 *RECOVERY NOTICES SENT*\n━━━━━━━━━━━━━━━\n👥 Active VIPs Targeted: ${total}\n✅ Successfully Sent: ${sent}\n❌ Failed / Blocked: ${failed}\n⏭️ Skipped (no active sub): ${skipped}\n\nAll active members have been notified with new channel links.`, { parse_mode: "Markdown", reply_markup: resultMenu });
    if (ADMIN_CHANNEL_ID) {
        try { await bot.api.sendMessage(ADMIN_CHANNEL_ID, `🚨 *BAN NOTICE EXECUTED*\n━━━━━━━━━━━━━━━\nAdmin: ${ctx.from.id}\nSent: ${sent}\nFailed: ${failed}\nTotal: ${total}`, { parse_mode: "Markdown" }); } catch (e) {}
    }
});

bot.callbackQuery("admin_back", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const menu = new InlineKeyboard()
        .text("📊 Stats + Breakdown", "admin_stats").row()
        .text("📢 Broadcast Promo", "admin_broadcast").row()
        .text("👥 24H Sales Report", "admin_users").row()
        .text("🔄 Force Reminder", "admin_remind").row()
        .text("🚨 Send Ban Notice", "admin_ban_notice").row()
        .text("📉 Funnel Analytics", "admin_funnel").row()
        .text("🧠 Posting Advisor", "advisor_refresh").row();
    await ctx.editMessageText("🔧 *ADMIN PANEL*", { parse_mode: "Markdown", reply_markup: menu });
});

bot.callbackQuery("advisor_refresh", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Analyzing channel data...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;
    const report = await generateAdvisorReport();
    await ctx.editMessageText(report, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔄 Refresh", "advisor_refresh").text("🔙 Admin", "admin_back")
    });
});

bot.callbackQuery("my_account", async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Loading account...");
    const user = await getOrCreateUser(ctx);
    const text = getAccountText(user);
    const menu = getAccountMenu(user);
    await safeEditMessage(ctx, text, menu, "Markdown");
});

// FIXED CATEGORY HANDLER — TRUST BAR + SILENT "NOT MODIFIED" HANDLING
bot.callbackQuery(/^cat_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const catKey = ctx.callbackQuery.data;

    if (!CATEGORY_PRICES[catKey]) {
        console.error(`[CAT] Invalid catKey received: ${catKey} from user ${ctx.from.id}`);
        return ctx.reply("❌ Invalid selection. Please type /start to restart.");
    }

    ctx.session.selectedCategory = CATEGORIES[catKey];
    ctx.session.categoryKey = catKey;
    await logAction(ctx.from.id, 'show_cat_' + catKey);

    const socialProof = await getSocialProofText();
    const urgency = getUrgencyText();

    const durationText = `🔥 *${CATEGORIES[catKey]}*\n━━━━━━━━━━━━━━━\n\n${socialProof}${urgency}✅ 2,000+ members | 🔄 24h refund | ⚡ Instant delivery\n\n📦 *What you get:*\n• 50+ fresh videos *EVERY DAY*\n• Zero teasers — full content only\n• Direct to your Telegram, no downloads\n• Not satisfied? We swap your category or extend your time *FREE*\n\n⚡ *Tap your plan below. Payment is instant.*`;

    try {
        if (ctx.callbackQuery.message?.photo && ctx.callbackQuery.message.photo.length > 0) {
            await ctx.editMessageMedia({
                type: 'photo',
                media: IMG_MPESA_BANNER,
                caption: durationText
            }, {
                reply_markup: getDurationMenu(catKey),
                parse_mode: "Markdown"
            });
        } else {
            try { await ctx.deleteMessage(); } catch(e) {}
            await ctx.replyWithPhoto(IMG_MPESA_BANNER, {
                caption: durationText,
                reply_markup: getDurationMenu(catKey),
                parse_mode: "Markdown"
            });
        }
    } catch (err) {
        if (err.message?.includes('message is not modified')) {
            return;
        }
        console.error(`[CAT] editMessageMedia failed for ${ctx.from.id}:`, err.message);
        try {
            await ctx.replyWithPhoto(IMG_MPESA_BANNER, {
                caption: durationText,
                reply_markup: getDurationMenu(catKey),
                parse_mode: "Markdown"
            });
        } catch (e) {}
    }

    await logAction(ctx.from.id, 'plan_menu_shown_' + catKey);
});

// FIXED PLAN CLICK — SHOW CONFIRMATION WITH "PAY NOW" BUTTON
bot.callbackQuery(/^plan_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    const match = data.match(/^plan_([A-Z]+)_(\d+)$/);
    if (!match) return;

    const plan = match[1];
    const amount = parseInt(match[2]);
    await logAction(ctx.from.id, 'plan_clicked_' + plan);

    userIntent.set(ctx.from.id, {
        category: ctx.session.selectedCategory,
        categoryKey: ctx.session.categoryKey || 'cat_1',
        plan: plan,
        amount: amount
    });

    ctx.session.planName = plan;
    ctx.session.amount = amount;

    const user = await User.findOne({ telegramId: ctx.from.id });

    // If saved phone exists → Show confirmation with PAY NOW button
    if (user?.phone && user.phone.length >= 10) {
        const planDisplay = getPlanDisplay(plan);
        const confirmText = `💳 *Almost Done!*\n\n${ctx.session.selectedCategory}\n📅 Plan: ${planDisplay}\n💵 Amount: *KES ${amount}*\n📱 M-Pesa: ${user.phone}\n\nTap below to get M-Pesa prompt instantly 👇`;

        const quickMenu = new InlineKeyboard()
            .text(`⚡ PAY KES ${amount} NOW`, `pay_existing_${plan}_${amount}`).row()
            .text("📝 Use Different Number", "enter_new_phone").row()
            .text("🔙 Back", `back_to_plans_${ctx.session.categoryKey}`);

        await safeEditMessage(ctx, confirmText, quickMenu, "Markdown");
        return;
    }

    // No saved phone → Ask for phone number input
    const planDisplay = getPlanDisplay(plan);
    const confirmText = `📱 *One Last Step*\n\n${ctx.session.selectedCategory}\n📅 Plan: ${planDisplay} — KES ${amount}\n\nWe need your M-Pesa number to send the STK push.\n\n✅ *Type your number below:* 07XXXXXXXX or 01XXXXXXXX`;

    const mpesaMenu = new InlineKeyboard()
        .text("🌍 No M-Pesa? Pay with Crypto", `payment_intl_${plan}_${amount}_${ctx.session.categoryKey}`).row()
        .text("🔙 Back", `back_to_plans_${ctx.session.categoryKey}`);

    await safeEditMessage(ctx, confirmText, mpesaMenu, "Markdown");
    await ctx.conversation.enter("mpesaPrompt");
});

// PAY WITH SAVED PHONE — WITH DUPLICATE GUARD BEFORE CREATING TX
bot.callbackQuery(/^pay_existing_/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Sending STK push...");
    const data = ctx.callbackQuery.data;
    const match = data.match(/^pay_existing_([A-Z]+)_(\d+)$/);
    if (!match) return;

    const plan = match[1];
    const amount = parseInt(match[2]);

    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user?.phone) {
        await ctx.reply("❌ No saved phone found. Please enter your number.");
        await ctx.conversation.enter("mpesaPrompt");
        return;
    }

    const phone = user.phone;
    const categoryName = ctx.session.selectedCategory || "VIP Access";
    const catKey = ctx.session.categoryKey || "cat_1";

    // Check for recent duplicate session BEFORE creating new one
    const recentPending = await PendingTransaction.findOne({
        phone,
        userId: ctx.from.id,
        createdAt: { $gte: new Date(Date.now() - 90 * 1000) }
    });
    if (recentPending) {
        await ctx.reply("⏳ You already have a pending M-Pesa request. Please check your phone for the STK push, or wait 90 seconds before trying again.");
        return;
    }

    const reference = 'DEP' + Date.now();

    const txData = {
        phone,
        chatId: ctx.chat.id,
        userId: ctx.from.id,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        lastName: ctx.from.last_name,
        amount: amount,
        category: categoryName,
        categoryKey: catKey,
        plan: plan,
        reference: reference,
        date: new Date().toLocaleString()
    };

    await PendingTransaction.findOneAndUpdate(
        { phone, userId: ctx.from.id },
        txData,
        { upsert: true }
    );
    pendingTransactions.set(phone, txData);

    abandonedCarts.set(ctx.from.id, {
        plan, amount, categoryKey: catKey, timestamp: Date.now()
    });

    const success = await fireSTK(phone, amount, reference, categoryName, plan, `${process.env.APP_URL}/api/megapay/webhook`, ctx);
    if (!success) {
        await cleanupPending(phone, ctx.from.id);
    } else {
        await ctx.reply("⏳ Please check your phone for the M-Pesa STK push and enter your PIN.", {
            reply_markup: cancelMenu
        });
    }
});

// USE DIFFERENT NUMBER
bot.callbackQuery("enter_new_phone", async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = ctx.session.planName;
    const amount = ctx.session.amount;
    const planDisplay = getPlanDisplay(plan);
    const confirmText = `${ctx.session.selectedCategory}\n\n📅 Plan: ${planDisplay} — KES ${amount}\n\n📱 *Enter your M-Pesa number:*\nFormat: 07XXXXXXXX or 01XXXXXXXX\n\nType your number in the chat below 👇`;

    const mpesaMenu = new InlineKeyboard()
        .text("🔙 Back", `back_to_plans_${ctx.session.categoryKey}`);

    await safeEditMessage(ctx, confirmText, mpesaMenu, "Markdown");
    await ctx.conversation.enter("mpesaPrompt");
});

// INTERNATIONAL PAYMENT (triggered from M-Pesa screen)
bot.callbackQuery(/^payment_intl_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.exit();

    const data = ctx.callbackQuery.data;
    const match = data.match(/^payment_intl_([A-Z]+)_(\d+)_(cat_.+)$/);
    if (!match) return;

    const plan = match[1];
    const amount = parseInt(match[2]);
    const usdAmount = (amount / USD_RATE).toFixed(2);

    const text = `🌍 *INTERNATIONAL PAYMENT*\n━━━━━━━━━━━━━━━\n\n📅 Plan: ${getPlanDisplay(plan)}\n💰 Amount: *$${usdAmount} USDT* (or equivalent)\n\n*Payment Options:*\n\n✅ *USDT (TRC20)*\n\`${CRYPTO_USDT}\`\n\n✅ *BTC*\n\`${CRYPTO_BTC}\`\n\n*How to pay:*\n1️⃣ Send *exact* amount to address above\n2️⃣ Tap "✅ I've Paid" below\n3️⃣ Reply with your Transaction ID or screenshot\n4️⃣ Admin activates your VIP within 10 minutes\n\n⚠️ *Send exact amount. Network fees not included.*`;

    const intlMenu = new InlineKeyboard()
        .text("✅ I've Paid", `intl_paid_${plan}_${amount}`).row()
        .url("💬 Need Help?", `https://t.me/${SUPPORT_USER}`).row()
        .text("🔙 Back", `back_to_plans_${ctx.session.categoryKey}`);

    await safeEditMessage(ctx, text, intlMenu, "Markdown");
});

bot.callbackQuery(/^intl_paid_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    const match = data.match(/^intl_paid_([A-Z]+)_(\d+)$/);
    if (!match) return;

    const plan = match[1];
    const amount = parseInt(match[2]);

    pendingIntlPayments.set(ctx.from.id, {
        plan: plan,
        amount: amount,
        timestamp: Date.now()
    });

    await ctx.reply("✅ Great! Please *reply to this message* with your Transaction ID or upload a screenshot of your payment.\n\nAdmin will verify and activate your VIP access within 10 minutes.", {
        parse_mode: "Markdown"
    });
});

// HANDLE INTERNATIONAL PAYMENT PROOF
bot.on('message', async (ctx) => {
    const pending = pendingIntlPayments.get(ctx.from.id);
    if (!pending) return;

    if (Date.now() - pending.timestamp > 30 * 60 * 1000) {
        pendingIntlPayments.delete(ctx.from.id);
        return;
    }

    const txId = ctx.message.text || (ctx.message.caption ? ctx.message.caption : 'Screenshot attached');
    const usdAmount = (pending.amount / USD_RATE).toFixed(2);

    const adminText = `🌍 *INTERNATIONAL PAYMENT RECEIVED*\n━━━━━━━━━━━━━━━\n\n👤 User: ${md(ctx.from.first_name) || 'Unknown'} (@${md(ctx.from.username) || 'N/A'})\n🆔 ID: ${ctx.from.id}\n📅 Plan: ${pending.plan}\n💰 Amount: KES ${pending.amount} (~$${usdAmount})\n🔗 Tx ID / Screenshot: ${txId}\n\n👇 Approve or Reject:`;

    const adminMenu = new InlineKeyboard()
        .text("✅ Approve", `approve_intl_${ctx.from.id}_${pending.plan}_${pending.amount}`).row()
        .text("❌ Reject", `reject_intl_${ctx.from.id}`).row()
        .url("💬 DM User", `tg://user?id=${ctx.from.id}`);

    for (const adminId of ADMIN_IDS) {
        try {
            if (ctx.message.photo) {
                await bot.api.forwardMessage(adminId, ctx.chat.id, ctx.message.message_id);
            }
            await bot.api.sendMessage(adminId, adminText, {
                parse_mode: "Markdown",
                reply_markup: adminMenu
            });
        } catch (e) {
            console.error(`Failed to notify admin ${adminId}:`, e.message);
        }
    }

    if (ADMIN_CHANNEL_ID) {
        try {
            if (ctx.message.photo) {
                await bot.api.forwardMessage(ADMIN_CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
            }
            await bot.api.sendMessage(ADMIN_CHANNEL_ID, adminText, {
                parse_mode: "Markdown",
                reply_markup: adminMenu
            });
        } catch (e) {}
    }

    await ctx.reply(`⏳ *Payment received!* Admin is reviewing your transaction.\n\nYou will get your VIP link within 10 minutes.\n\nIf delayed, contact @${SUPPORT_USER}`, {
        parse_mode: "Markdown"
    });

    pendingIntlPayments.delete(ctx.from.id);
});

// ADMIN APPROVE INTERNATIONAL
bot.callbackQuery(/^approve_intl_/, async (ctx) => {
    await ctx.answerCallbackQuery("✅ Activating...");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;

    const data = ctx.callbackQuery.data;
    const match = data.match(/^approve_intl_(\d+)_([A-Z]+)_(\d+)$/);
    if (!match) return;

    const targetUserId = parseInt(match[1]);
    const plan = match[2];
    const amount = parseInt(match[3]);

    try {
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + getPlanDays(plan));

        await unbanUserFromChannel(targetUserId);

        const invite = await bot.api.createChatInviteLink(VIP_CHANNEL_ID, {
            member_limit: 1,
            name: `VIP ${plan} — INTL_APPROVED`,
            expire_date: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
        });

        const user = await User.findOneAndUpdate(
            { telegramId: targetUserId },
            {
                $setOnInsert: {
                    telegramId: targetUserId,
                    isActive: true,
                    createdAt: new Date()
                },
                $push: {
                    subscriptions: {
                        category: 'VIP Access',
                        categoryKey: 'cat_all',
                        plan: plan,
                        amount: amount,
                        startDate: new Date(),
                        endDate: endDate,
                        status: 'active',
                        receiptNumber: 'INTL_APPROVED',
                        inviteLink: invite.invite_link,
                        reminderLevel: 0,
                        renewed: false
                    }
                }
            },
            { upsert: true, returnDocument: 'after' }
        );

        const successText = `🎉 *VIP ACCESS ACTIVATED!*\n\nYour international payment has been approved!\n\n🔗 *CHANNEL ACCESS*\n━━━━━━━━━━━━━━━\n▪️ Plan: ${plan}\n▪️ Expires: ${endDate.toLocaleDateString()}\n\n⚠️ *ONE-TIME LINK:* This link can only be used *ONCE*.`;

        const linkMenu = new InlineKeyboard()
            .url(`🔗 JOIN VIP CHANNEL 🔗`, invite.invite_link).row()
            .url("💬 Support ↗️", `https://t.me/${SUPPORT_USER}`);

        await bot.api.sendMessage(targetUserId, successText, {
            parse_mode: "Markdown",
            reply_markup: linkMenu
        });

        await logAction(targetUserId, 'payment_success', 'intl_approved', { plan, amount });

        await ctx.editMessageText(`✅ *APPROVED* — User ${targetUserId} activated for ${plan}.`, { parse_mode: "Markdown" });
    } catch (err) {
        await ctx.reply(`❌ Failed to approve: ${err.message}`);
    }
});

// ADMIN REJECT INTERNATIONAL
bot.callbackQuery(/^reject_intl_/, async (ctx) => {
    await ctx.answerCallbackQuery("❌ Rejected");
    if (!ADMIN_IDS.includes(ctx.from.id)) return;

    const data = ctx.callbackQuery.data;
    const match = data.match(/^reject_intl_(\d+)$/);
    if (!match) return;

    const targetUserId = parseInt(match[1]);

    try {
        await bot.api.sendMessage(targetUserId, `❌ *Payment Rejected*\n\nYour transaction could not be verified. Please contact @${SUPPORT_USER} for assistance.`, {
            parse_mode: "Markdown"
        });
        await ctx.editMessageText(`❌ *REJECTED* — User ${targetUserId} notified.`, { parse_mode: "Markdown" });
    } catch (err) {
        await ctx.reply(`❌ Failed to notify user: ${err.message}`);
    }
});

bot.callbackQuery(/^back_to_plans_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.exit();

    const data = ctx.callbackQuery.data;
    const match = data.match(/^back_to_plans_(cat_.+)$/);
    const catKey = match ? match[1] : (ctx.session.categoryKey || 'cat_1');

    if (!CATEGORY_PRICES[catKey]) {
        return ctx.reply("❌ Session expired. Please type /start to restart.");
    }

    const socialProof = await getSocialProofText();
    const urgency = getUrgencyText();

    const durationText = `🔥 *${CATEGORIES[catKey]}*\n━━━━━━━━━━━━━━━\n\n${socialProof}${urgency}✅ 2,000+ members | 🔄 24h refund | ⚡ Instant delivery\n\n📦 *What you get:*\n• 50+ fresh videos *EVERY DAY*\n• Zero teasers — full content only\n• Direct to your Telegram, no downloads\n• Not satisfied? We swap your category or extend your time *FREE*\n\n⚡ *Tap your plan below. Payment is instant.*`;

    try {
        if (ctx.callbackQuery.message?.photo && ctx.callbackQuery.message.photo.length > 0) {
            await ctx.editMessageMedia({
                type: 'photo',
                media: IMG_MPESA_BANNER,
                caption: durationText
            }, {
                reply_markup: getDurationMenu(catKey),
                parse_mode: "Markdown"
            });
        } else {
            try { await ctx.deleteMessage(); } catch(e) {}
            await ctx.replyWithPhoto(IMG_MPESA_BANNER, {
                caption: durationText,
                reply_markup: getDurationMenu(catKey),
                parse_mode: "Markdown"
            });
        }
    } catch (err) {
        if (err.message?.includes('message is not modified')) {
            return;
        }
        try {
            await ctx.replyWithPhoto(IMG_MPESA_BANNER, {
                caption: durationText,
                reply_markup: getDurationMenu(catKey),
                parse_mode: "Markdown"
            });
        } catch (e) {}
    }
});

// FIXED RENEW — SHOW CONFIRMATION WITH PAY BUTTON
bot.callbackQuery(/^renew_/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    const match = data.match(/^renew_([A-Z]+)_(\d+)_(cat_.+)$/);
    if (!match) return;

    const plan = match[1];
    const amount = parseInt(match[2]);
    const categoryKey = match[3];

    userIntent.set(ctx.from.id, {
        category: CATEGORIES[categoryKey],
        categoryKey: categoryKey,
        plan: plan,
        amount: amount
    });

    ctx.session.planName = plan;
    ctx.session.amount = amount;
    ctx.session.selectedCategory = CATEGORIES[categoryKey];

    // Check saved phone for renewals too — show confirmation
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (user?.phone && user.phone.length >= 10) {
        const planDisplay = getPlanDisplay(plan);
        const confirmText = `♻️ *RENEW SUBSCRIPTION*\n\n${ctx.session.selectedCategory}\n📅 Plan: ${planDisplay} — KES ${amount}\n📱 Phone: ${user.phone}\n\nTap Pay to renew instantly 👇`;

        const quickMenu = new InlineKeyboard()
            .text(`✅ Pay KES ${amount}`, `pay_existing_${plan}_${amount}`).row()
            .text("📝 Use Different Number", "enter_new_phone").row()
            .text("🔙 Back", `back_to_plans_${categoryKey}`);

        await safeEditMessage(ctx, confirmText, quickMenu, "Markdown");
        return;
    }

    const planDisplay = getPlanDisplay(plan);
    const confirmText = `♻️ *RENEW SUBSCRIPTION*\n\n${ctx.session.selectedCategory}\n📅 Plan: ${planDisplay} — KES ${amount}\n\n📱 *Enter your M-Pesa number:*\nFormat: 07XXXXXXXX or 01XXXXXXXX`;

    await safeEditMessage(ctx, confirmText, cancelMenu, "Markdown");
    await ctx.conversation.enter("mpesaPrompt");
});

bot.callbackQuery("back_home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.conversation.exit();
    userIntent.delete(ctx.from.id);
    pendingIntlPayments.delete(ctx.from.id);
    abandonedCarts.delete(ctx.from.id);
    const welcomeText = `Hello ${md(ctx.from.first_name) || ''}\n🔥 Welcome to TRENDS LEAKS VIP ACCESS\nChoose your subscription package below 👇`;

    try {
        if (ctx.callbackQuery.message?.photo && ctx.callbackQuery.message.photo.length > 0) {
            await ctx.editMessageMedia({
                type: 'photo', media: IMG_MAIN_BANNER, caption: welcomeText
            }, { reply_markup: mainMenu });
        } else {
            try { await ctx.deleteMessage(); } catch (e) {}
            await ctx.replyWithPhoto(IMG_MAIN_BANNER, { caption: welcomeText, reply_markup: mainMenu });
        }
    } catch (err) {
        if (err.message?.includes('message is not modified')) {
            return;
        }
        console.error("back_home error:", err.message);
        await ctx.replyWithPhoto(IMG_MAIN_BANNER, { caption: welcomeText, reply_markup: mainMenu });
    }
});

bot.callbackQuery(["about", "menu"], async (ctx) => {
    await ctx.answerCallbackQuery({ text: "This feature is coming soon!" });
});

bot.on('channel_post', async (ctx) => {
    await trackChannelPost(ctx);
});

bot.on('msg', async (ctx) => {
    if (ctx.chat?.type === 'channel') {
        await trackChannelPost(ctx);
    }
});

// ==========================================
// PROMOTIONAL SYSTEM
// ==========================================
async function sendPromoToAll(message, type = 'promo') {
    const users = await User.find({ isActive: { $ne: false } });
    let sent = 0, failed = 0;

    for (const user of users) {
        try {
            await bot.api.sendMessage(user.telegramId, `📢 *${type === 'manual' ? 'ANNOUNCEMENT' : 'SPECIAL OFFER'}*\n\n${message}\n\n🔥 Tap /start to subscribe!`, {
                parse_mode: 'Markdown',
                reply_markup: mainMenu
            });
            sent++;
            await new Promise(r => setTimeout(r, 50));
        } catch (e) {
            failed++;
            if (e.description === "Forbidden: bot was blocked by the user") {
                console.log(`User ${user.telegramId} blocked the bot during promo. Marking inactive.`);
                await User.updateOne({ telegramId: user.telegramId }, { isActive: false });
            }
        }
    }

    await PromoLog.create({ type, recipients: users.length, success: sent, failed, message });
    console.log(`📢 Promo sent: ${sent} success, ${failed} failed`);
    return { sent, failed };
}

// ==========================================
// CRON JOBS
// ==========================================

async function runReminders() {
    const now = new Date();

    const twoDaysStart = new Date(now);
    twoDaysStart.setDate(twoDaysStart.getDate() + 2);
    twoDaysStart.setHours(0, 0, 0, 0);
    const twoDaysEnd = new Date(now);
    twoDaysEnd.setDate(twoDaysEnd.getDate() + 2);
    twoDaysEnd.setHours(23, 59, 59, 999);

    const users2Days = await User.find({
        isActive: { $ne: false },
        subscriptions: {
            $elemMatch: {
                status: 'active',
                endDate: { $gte: twoDaysStart, $lte: twoDaysEnd },
                $or: [{ reminderLevel: { $exists: false } }, { reminderLevel: { $lt: 1 } }]
            }
        }
    });

    for (const user of users2Days) {
        let saved = false;
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active') continue;
            if (sub.endDate < twoDaysStart || sub.endDate > twoDaysEnd) continue;
            if ((sub.reminderLevel || 0) >= 1) continue;

            try {
                const catKey = getCategoryKeyFromSub(sub);
                const text = `⏰ *SUBSCRIPTION EXPIRING SOON*\n\nYour ${md(sub.category)} (${md(sub.plan)}) expires in *2 days* (${sub.endDate.toLocaleDateString()}).\n\n💡 *Smart move:* Most VIP members upgrade to longer plans. Why? Better value, zero interruptions, and you lock in today's price.\n\n🔥 *Popular upgrades:*\n• 3 Months — save 40% vs weekly\n• Lifetime — never pay again\n\n👇 Renew or upgrade below:`;

                await bot.api.sendMessage(user.telegramId, text, {
                    parse_mode: "Markdown",
                    reply_markup: psychologyRenewMenu(catKey, sub.plan)
                });

                sub.reminderLevel = 1;
                saved = true;
                console.log(`⏰ 2-day reminder sent to ${user.telegramId}`);
            } catch (err) {
                if (err.description === "Forbidden: bot was blocked by the user" || err.message?.includes('user is deactivated')) {
                    console.log(`User ${user.telegramId} blocked bot or deactivated. Marking inactive.`);
                    user.isActive = false;
                    saved = true;
                } else {
                    console.error(`Failed 2-day remind ${user.telegramId}:`, err.message);
                }
            }
        }
        if (saved) await user.save();
    }

    const oneDayStart = new Date(now);
    oneDayStart.setDate(oneDayStart.getDate() + 1);
    oneDayStart.setHours(0, 0, 0, 0);
    const oneDayEnd = new Date(now);
    oneDayEnd.setDate(oneDayEnd.getDate() + 1);
    oneDayEnd.setHours(23, 59, 59, 999);

    const users1Day = await User.find({
        isActive: { $ne: false },
        subscriptions: {
            $elemMatch: {
                status: 'active',
                endDate: { $gte: oneDayStart, $lte: oneDayEnd },
                $or: [{ reminderLevel: { $exists: false } }, { reminderLevel: { $lt: 2 } }]
            }
        }
    });

    for (const user of users1Day) {
        let saved = false;
        for (const sub of user.subscriptions) {
            if (sub.status !== 'active') continue;
            if (sub.endDate < oneDayStart || sub.endDate > oneDayEnd) continue;
            if ((sub.reminderLevel || 0) >= 2) continue;

            try {
                const catKey = getCategoryKeyFromSub(sub);
                const text = `⏰ *FINAL NOTICE — EXPIRES TOMORROW!*\n\nYour ${md(sub.category)} (${md(sub.plan)}) ends *tomorrow* (${sub.endDate.toLocaleDateString()}).\n\n⚠️ This is your *final warning*. Once expired, you'll be removed from the channel and lose access to all content.\n\n💎 *Don't just renew — upgrade!* Longer plans = bigger savings.\n\n👇 This is your last chance 👇`;

                await bot.api.sendMessage(user.telegramId, text, {
                    parse_mode: "Markdown",
                    reply_markup: psychologyRenewMenu(catKey, sub.plan)
                });

                sub.reminderLevel = 2;
                saved = true;
                console.log(`⏰ 1-day (tomorrow) reminder sent to ${user.telegramId}`);
            } catch (err) {
                if (err.description === "Forbidden: bot was blocked by the user" || err.message?.includes('user is deactivated')) {
                    console.log(`User ${user.telegramId} blocked bot or deactivated. Marking inactive.`);
                    user.isActive = false;
                    saved = true;
                } else {
                    console.error(`Failed 1-day remind ${user.telegramId}:`, err.message);
                }
            }
        }
        if (saved) await user.save();
    }
}

cron.schedule('0 9 * * *', runReminders);

cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const users = await User.find({
        isActive: { $ne: false },
        subscriptions: {
            $elemMatch: {
                status: 'active',
                endDate: { $lt: now }
            }
        }
    });

    for (const user of users) {
        let saved = false;

        for (const sub of user.subscriptions) {
            if (sub.status !== 'active' || sub.endDate >= now) continue;

            sub.status = 'expired';
            sub.reminderLevel = 3;
            saved = true;

            await banUserFromChannel(user.telegramId);
            await notifyAdminRemoval(user, sub);

            try {
                const expiryText = `⏰ *ACCESS REVOKED*\n\nYour ${md(sub.category)} subscription has expired. You've been removed from the VIP channel.\n\n😢 You're missing out! Fresh content drops daily and thousands of members are enjoying it right now.\n\n🔥 *Come back stronger:* Choose any plan below and rejoin instantly 👇`;

                await bot.api.sendMessage(user.telegramId, expiryText, {
                    parse_mode: "Markdown",
                    reply_markup: mainMenu
                });
            } catch (err) {
                if (err.description === "Forbidden: bot was blocked by the user" || err.message?.includes('user is deactivated')) {
                    console.log(`User ${user.telegramId} blocked bot or deactivated. Marking inactive.`);
                    user.isActive = false;
                } else {
                    console.error(`Failed to notify expiry ${user.telegramId}:`, err.message);
                }
            }
        }

        if (saved) await user.save();
    }
});

cron.schedule('0 14 */3 * *', async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const users = await User.find({
        isActive: { $ne: false },
        'subscriptions.status': 'expired',
        'subscriptions.endDate': { $gte: threeDaysAgo, $lt: new Date() },
        $or: [{ lastPromo: { $lt: threeDaysAgo } }, { lastPromo: { $exists: false } }]
    });

    for (const user of users) {
        try {
            await bot.api.sendMessage(user.telegramId,
                `🔥 *WE MISS YOU!*\n\nYour VIP access expired recently. Here's an exclusive offer:\n\n✅ Renew ANY plan today\n✅ Get instant channel access\n✅ New content dropped daily!\n\nTap /start to grab your spot back!`,
                { parse_mode: "Markdown", reply_markup: mainMenu }
            );
            user.lastPromo = new Date();
            await user.save();
        } catch (e) {
            if (e.description === "Forbidden: bot was blocked by the user" || e.message?.includes('user is deactivated')) {
                console.log(`User ${user.telegramId} blocked bot on win-back. Marking inactive.`);
                await User.updateOne({ telegramId: user.telegramId }, { isActive: false });
            }
        }
    }
});

cron.schedule('*/30 * * * *', async () => {
    console.log('[ADVISOR] Running post-sales correlation...');
    await analyzePostPerformance();
});

cron.schedule('0 8 * * *', async () => {
    if (!ADMIN_IDS.length) return;
    const report = await generateAdvisorReport();
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.api.sendMessage(adminId, `📬 *DAILY ADVISOR DIGEST*\n\n${report}`, { parse_mode: "Markdown" });
        } catch (e) {}
    }
});

// ==========================================
// ABANDONED CART RECOVERY — UPDATED TIMING
// ==========================================
cron.schedule('*/2 * * * *', async () => {
    const now = Date.now();
    for (const [userId, cart] of abandonedCarts.entries()) {
        const elapsed = now - cart.timestamp;

        // Nudge 1 at 3 minutes
        if (elapsed > 3 * 60 * 1000 && elapsed < 4 * 60 * 1000 && !cart.reminded1) {
            cart.reminded1 = true;
            try {
                await bot.api.sendMessage(userId,
                    `⏳ *Your spot is reserved*\n\n${cart.plan} — KES ${cart.amount}\n\nComplete payment now for instant access 👇`,
                    {
                        parse_mode: "Markdown",
                        reply_markup: new InlineKeyboard()
                            .text("💳 Pay Now", `plan_${cart.plan}_${cart.amount}`).row()
                            .text("❌ Cancel", "back_home")
                    }
                );
            } catch (e) { abandonedCarts.delete(userId); }
        }

        // Nudge 2 at 10 minutes with social proof
        if (elapsed > 10 * 60 * 1000 && elapsed < 11 * 60 * 1000 && !cart.reminded2) {
            cart.reminded2 = true;
            try {
                await bot.api.sendMessage(userId,
                    `🔥 *3 people joined while you were away*\n\nYour ${cart.plan} spot is still open. Prices refresh soon.\n\nGrab it now 👇`,
                    {
                        parse_mode: "Markdown",
                        reply_markup: new InlineKeyboard()
                            .text("💳 Complete Payment", `plan_${cart.plan}_${cart.amount}`).row()
                            .text("🌍 Pay with Crypto", `payment_intl_${cart.plan}_${cart.amount}_${cart.categoryKey}`).row()
                            .text("❌ Cancel", "back_home")
                    }
                );
            } catch (e) { abandonedCarts.delete(userId); }
        }

        // Expire after 30 minutes
        if (elapsed > 30 * 60 * 1000) {
            abandonedCarts.delete(userId);
        }
    }
});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    const desc = e?.description || "";
    const msg = err.message || "";

    if (
        desc.includes("bot was blocked") ||
        desc.includes("user is deactivated") ||
        desc.includes("query is too old") ||
        desc.includes("message is not modified") ||
        msg.includes("bot was blocked") ||
        msg.includes("user is deactivated")
    ) {
        return;
    }

    console.error(`Error while handling update ${ctx?.update?.update_id}:`);
    if (desc) console.error("Telegram API Error:", desc);
    else console.error("Unknown Error:", e?.message || e);
});

// ==========================================
// START
// ==========================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));
bot.start({ onStart: (botInfo) => console.log(`🤖 Bot @${botInfo.username} started!`) })