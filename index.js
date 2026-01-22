const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.static('public'));

const CONFIG = {
    FB_EMAIL: process.env.FB_EMAIL || '',
    FB_PASSWORD: process.env.FB_PASSWORD || '',
    BOT_NAME: process.env.BOT_NAME || 'StatsBot',
    COMMAND_PREFIX: process.env.COMMAND_PREFIX || '!',
    ADMIN_IDS: process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [],
    AUTO_REPLY: process.env.AUTO_REPLY !== 'false',
    PORT: process.env.PORT || 3000,
    DATA_FILE: path.join(__dirname, 'data', 'storage.json')
};

let stats = {
    messages: {},
    users: {},
    groups: {},
    global: {
        totalMessages: 0,
        startTime: Date.now(),
        uptime: 0
    }
};

let browser = null;
let page = null;
let botRunning = false;
const messageCache = new Map();

async function initData() {
    try {
        await fs.mkdir(path.dirname(CONFIG.DATA_FILE), { recursive: true });
        const data = await fs.readFile(CONFIG.DATA_FILE, 'utf8');
        stats = JSON.parse(data);
        console.log('✅ Đã tải dữ liệu');
    } catch {
        console.log('📁 Tạo dữ liệu mới');
        await saveData();
    }
}

async function saveData() {
    try {
        stats.global.uptime = Date.now() - stats.global.startTime;
        await fs.writeFile(CONFIG.DATA_FILE, JSON.stringify(stats, null, 2));
    } catch (err) {
        console.error('❌ Lỗi lưu dữ liệu:', err);
    }
}

function recordMessage(threadId, userId, userName, isGroup = false) {
    if (!stats.messages[threadId]) {
        stats.messages[threadId] = {
            total: 0,
            members: {},
            isGroup: isGroup,
            lastActivity: new Date().toISOString()
        };
    }
    
    if (!stats.messages[threadId].members[userId]) {
        stats.messages[threadId].members[userId] = {
            name: userName,
            count: 0,
            firstMessage: new Date().toISOString()
        };
    }
    
    stats.messages[threadId].members[userId].count++;
    stats.messages[threadId].total++;
    stats.messages[threadId].lastActivity = new Date().toISOString();
    
    if (!stats.users[userId]) {
        stats.users[userId] = {
            name: userName,
            totalMessages: 0,
            threads: [],
            lastSeen: new Date().toISOString()
        };
    }
    
    stats.users[userId].totalMessages++;
    stats.users[userId].lastSeen = new Date().toISOString();
    
    if (!stats.users[userId].threads.includes(threadId)) {
        stats.users[userId].threads.push(threadId);
    }
    
    if (isGroup && !stats.groups[threadId]) {
        stats.groups[threadId] = {
            name: `Group_${threadId.substring(0, 6)}`,
            created: new Date().toISOString()
        };
    }
    
    stats.global.totalMessages++;
    return stats.messages[threadId].members[userId].count;
}

function getThreadStats(threadId) {
    const thread = stats.messages[threadId];
    if (!thread) return null;
    
    const members = Object.entries(thread.members)
        .sort(([,a], [,b]) => b.count - a.count);
    
    return {
        totalMessages: thread.total,
        memberCount: members.length,
        topMembers: members.slice(0, 10),
        lastActivity: thread.lastActivity,
        isGroup: thread.isGroup
    };
}

function getTopUsers(threadId = null, limit = 5) {
    let users = [];
    
    if (threadId && stats.messages[threadId]) {
        const thread = stats.messages[threadId];
        users = Object.entries(thread.members)
            .map(([userId, data]) => ({
                userId,
                name: data.name,
                count: data.count
            }))
            .sort((a, b) => b.count - a.count);
    } else {
        users = Object.entries(stats.users)
            .map(([userId, data]) => ({
                userId,
                name: data.name,
                count: data.totalMessages
            }))
            .sort((a, b) => b.count - a.count);
    }
    
    return users.slice(0, limit);
}

function getGlobalStats() {
    const uptime = Date.now() - stats.global.startTime;
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    return {
        totalMessages: stats.global.totalMessages,
        totalUsers: Object.keys(stats.users).length,
        totalGroups: Object.keys(stats.groups).length,
        uptime: `${days} ngày ${hours} giờ`,
        startTime: new Date(stats.global.startTime).toLocaleString('vi-VN')
    };
}

async function sendReply(threadId, message) {
    try {
        if (!page) return false;
        
        await page.evaluate(async (threadId, text) => {
            const findThread = () => {
                const threads = document.querySelectorAll('[role="row"]');
                for (const thread of threads) {
                    const threadFbid = thread.getAttribute('data-thread-fbid');
                    if (threadFbid === threadId) {
                        thread.click();
                        return true;
                    }
                }
                return false;
            };
            
            if (findThread()) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                const input = document.querySelector('[contenteditable="true"]');
                if (input) {
                    input.focus();
                    
                    const pasteText = (text) => {
                        input.textContent = text;
                        input.dispatchEvent(new InputEvent('input', { bubbles: true }));
                    };
                    
                    pasteText(text);
                    
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    const sendButton = document.querySelector('[aria-label="Send"]') ||
                                       document.querySelector('[data-testid="mwthread-send-button"]');
                    
                    if (sendButton) {
                        sendButton.click();
                        return true;
                    }
                }
            }
            return false;
        }, threadId, message);
        
        console.log(`📤 Đã gửi: ${message.substring(0, 50)}...`);
        return true;
    } catch (err) {
        console.error('❌ Lỗi gửi tin nhắn:', err);
        return false;
    }
}

async function handleCommand(threadId, userId, userName, command, args = []) {
    const isAdmin = CONFIG.ADMIN_IDS.includes(userId);
    
    switch (command.toLowerCase()) {
        case 'help':
            const helpText = `📋 **CÁC LỆNH**\n` +
                           `${CONFIG.COMMAND_PREFIX}help - Hiển thị trợ giúp\n` +
                           `${CONFIG.COMMAND_PREFIX}stats - Thống kê nhóm\n` +
                           `${CONFIG.COMMAND_PREFIX}top [n] - Top n người nhắn nhiều\n` +
                           `${CONFIG.COMMAND_PREFIX}info - Thông tin bot\n` +
                           `${CONFIG.COMMAND_PREFIX}ping - Kiểm tra bot`;
            return helpText;
            
        case 'stats':
            const threadStats = getThreadStats(threadId);
            if (!threadStats) return '📊 Chưa có dữ liệu thống kê';
            
            let statsText = `📊 **THỐNG KÊ NHÓM**\n` +
                           `📈 Tổng tin nhắn: ${threadStats.totalMessages}\n` +
                           `👥 Thành viên: ${threadStats.memberCount}\n` +
                           `⏰ Hoạt động cuối: ${new Date(threadStats.lastActivity).toLocaleString('vi-VN')}\n\n` +
                           `🏆 **TOP 3**\n`;
            
            threadStats.topMembers.slice(0, 3).forEach(([id, data], index) => {
                statsText += `${index + 1}. ${data.name}: ${data.count} tin\n`;
            });
            
            return statsText;
            
        case 'top':
            const limit = parseInt(args[0]) || 5;
            const topUsers = getTopUsers(threadId, limit);
            
            if (topUsers.length === 0) return '📊 Chưa có dữ liệu';
            
            let topText = `🏆 **TOP ${topUsers.length}**\n`;
            topUsers.forEach((user, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
                topText += `${medal} ${user.name}: ${user.count} tin\n`;
            });
            
            return topText;
            
        case 'info':
            const globalStats = getGlobalStats();
            
            return `🤖 **${CONFIG.BOT_NAME}**\n` +
                   `📨 Tin nhắn: ${globalStats.totalMessages}\n` +
                   `👤 Người dùng: ${globalStats.totalUsers}\n` +
                   `👥 Nhóm: ${globalStats.totalGroups}\n` +
                   `⏱️ Uptime: ${globalStats.uptime}\n` +
                   `🚀 Hoạt động từ: ${globalStats.startTime}`;
            
        case 'ping':
            return '🏓 Pong! Bot đang hoạt động';
            
        case 'clean':
            if (!isAdmin) return '⛔ Cần quyền admin';
            stats.messages[threadId] = { total: 0, members: {}, lastActivity: new Date().toISOString() };
            await saveData();
            return '✅ Đã xóa thống kê nhóm này';
            
        default:
            return `❓ Lệnh không xác định. Dùng ${CONFIG.COMMAND_PREFIX}help`;
    }
}

async function processMessage(threadId, userId, userName, messageText, isGroup = false) {
    const messageCount = recordMessage(threadId, userId, userName, isGroup);
    
    console.log(`📨 [${userName}]: ${messageText.substring(0, 50)}... (${messageCount})`);
    
    if (!isGroup && CONFIG.AUTO_REPLY) {
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        
        const replies = [
            `👋 Chào ${userName}! Tôi là ${CONFIG.BOT_NAME}`,
            `💬 Bot đã nhận tin nhắn của bạn`,
            `📊 Gõ "${CONFIG.COMMAND_PREFIX}help" để xem lệnh`,
            `🤖 Tôi là bot thống kê tin nhắn`
        ];
        
        const randomReply = replies[Math.floor(Math.random() * replies.length)];
        await sendReply(threadId, randomReply);
        return;
    }
    
    if (messageText.startsWith(CONFIG.COMMAND_PREFIX)) {
        const parts = messageText.slice(CONFIG.COMMAND_PREFIX.length).trim().split(' ');
        const command = parts[0];
        const args = parts.slice(1);
        
        const response = await handleCommand(threadId, userId, userName, command, args);
        if (response) {
            await sendReply(threadId, response);
        }
    }
}

async function startMessageMonitoring() {
    console.log('👂 Bắt đầu theo dõi tin nhắn...');
    
    setInterval(async () => {
        if (!page || !botRunning) return;
        
        try {
            const messages = await page.evaluate(() => {
                const results = [];
                const threads = document.querySelectorAll('[role="row"]');
                
                threads.forEach(thread => {
                    const threadId = thread.getAttribute('data-thread-fbid');
                    if (!threadId) return;
                    
                    const messages = thread.querySelectorAll('[data-tooltip-position]');
                    const lastMsg = messages[messages.length - 1];
                    
                    if (lastMsg) {
                        const senderElem = thread.querySelector('[dir="auto"]');
                        const isGroup = thread.querySelector('[aria-label*="group"]') !== null;
                        
                        results.push({
                            threadId,
                            message: lastMsg.textContent.trim(),
                            sender: senderElem ? senderElem.textContent.trim() : 'Unknown',
                            isGroup,
                            timestamp: Date.now()
                        });
                    }
                });
                
                return results;
            });
            
            for (const msg of messages) {
                if (msg.sender === CONFIG.BOT_NAME) continue;
                
                const cacheKey = `${msg.threadId}_${msg.message}_${msg.timestamp}`;
                
                if (!messageCache.has(cacheKey)) {
                    messageCache.set(cacheKey, true);
                    
                    if (messageCache.size > 200) {
                        const keys = Array.from(messageCache.keys());
                        for (let i = 0; i < 100; i++) {
                            messageCache.delete(keys[i]);
                        }
                    }
                    
                    const userId = msg.sender.replace(/\s+/g, '_').toLowerCase();
                    await processMessage(msg.threadId, userId, msg.sender, msg.message, msg.isGroup);
                }
            }
        } catch (err) {
            console.error('❌ Lỗi theo dõi:', err);
        }
    }, 3000);
}

async function loginToFacebook() {
    try {
        console.log('🔐 Đang đăng nhập...');
        
        await page.goto('https://www.facebook.com/login', { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        const alreadyLoggedIn = await page.evaluate(() => {
            return document.querySelector('input[name="email"]') === null;
        });
        
        if (alreadyLoggedIn) {
            console.log('✅ Đã đăng nhập từ session cũ');
            return true;
        }
        
        await page.type('input[name="email"]', CONFIG.FB_EMAIL);
        await page.type('input[name="pass"]', CONFIG.FB_PASSWORD);
        
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('button[name="login"]')
        ]);
        
        await page.waitForTimeout(3000);
        
        const success = await page.evaluate(() => {
            return document.title.includes('Facebook') || 
                   window.location.href.includes('facebook.com/home');
        });
        
        if (success) {
            console.log('✅ Đăng nhập thành công');
            return true;
        }
        
        return false;
    } catch (err) {
        console.error('❌ Lỗi đăng nhập:', err);
        return false;
    }
}

async function startBot() {
    if (botRunning) {
        console.log('⚠️ Bot đang chạy');
        return;
    }
    
    try {
        console.log('🚀 Khởi động bot...');
        botRunning = true;
        
        await initData();
        
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1366,768'
            ],
            userDataDir: './user_data',
            defaultViewport: null
        });
        
        const pages = await browser.pages();
        page = pages[0] || await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const loggedIn = await loginToFacebook();
        if (!loggedIn) {
            console.error('❌ Đăng nhập thất bại');
            await stopBot();
            return;
        }
        
        await page.goto('https://www.messenger.com', { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        console.log('✅ Đã vào Messenger');
        
        await startMessageMonitoring();
        
        setInterval(() => saveData(), 300000);
        
        console.log('🤖 Bot đã sẵn sàng!');
        
    } catch (err) {
        console.error('❌ Lỗi khởi động:', err);
        await stopBot();
    }
}

async function stopBot() {
    try {
        console.log('🛑 Đang dừng bot...');
        botRunning = false;
        
        await saveData();
        
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        
        page = null;
        browser = null;
        
        console.log('✅ Bot đã dừng');
    } catch (err) {
        console.error('❌ Lỗi dừng bot:', err);
    }
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Nhận tín hiệu dừng...');
    await stopBot();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Nhận tín hiệu kết thúc...');
    await stopBot();
    process.exit(0);
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>${CONFIG.BOT_NAME} Control Panel</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
                .container { max-width: 1200px; margin: 0 auto; }
                .header { text-align: center; margin-bottom: 40px; color: white; }
                .header h1 { font-size: 3em; margin-bottom: 10px; }
                .header p { font-size: 1.2em; opacity: 0.9; }
                .card { background: white; border-radius: 15px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
                .status-badge { display: inline-block; padding: 8px 20px; border-radius: 50px; font-weight: bold; margin-left: 15px; }
                .status-running { background: #10b981; color: white; }
                .status-stopped { background: #ef4444; color: white; }
                .controls { display: flex; gap: 15px; flex-wrap: wrap; margin-top: 20px; }
                .btn { padding: 12px 30px; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; transition: all 0.3s; display: flex; align-items: center; gap: 10px; }
                .btn-start { background: #10b981; color: white; }
                .btn-stop { background: #ef4444; color: white; }
                .btn-refresh { background: #3b82f6; color: white; }
                .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-top: 20px; }
                .stat-card { background: #f8fafc; padding: 20px; border-radius: 10px; border-left: 5px solid #3b82f6; }
                .stat-title { color: #64748b; font-size: 14px; margin-bottom: 5px; }
                .stat-value { font-size: 28px; font-weight: bold; color: #1e293b; }
                pre { background: #1e293b; color: #e2e8f0; padding: 20px; border-radius: 10px; overflow-x: auto; max-height: 400px; margin-top: 20px; }
                @media (max-width: 768px) {
                    .container { padding: 10px; }
                    .header h1 { font-size: 2em; }
                    .controls { justify-content: center; }
                    .btn { width: 100%; justify-content: center; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>🤖 ${CONFIG.BOT_NAME}</h1>
                    <p>Bot Messenger với thống kê tin nhắn và tự động trả lời</p>
                </div>
                
                <div class="card">
                    <h2>Trạng thái hệ thống 
  
