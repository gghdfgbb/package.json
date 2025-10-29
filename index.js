/* Phistar Naming Server - With Auto-Ping & Dropbox Backup */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== DROPBOX CONFIGURATION ====================
const DROPBOX_CONFIG = {
    APP_KEY: 'ho5ep3i58l3tvgu',
    APP_SECRET: '9fy0w0pgaafyk3e', 
    REFRESH_TOKEN: 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3'
};

// ==================== RENDER DETECTION ====================
const IS_RENDER = process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL !== undefined;
const RENDER_DOMAIN = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

function getShortDomainName() {
    if (!IS_RENDER) return 'naming-server-local';
    
    let domain = RENDER_DOMAIN.replace(/^https?:\/\//, '');
    domain = domain.replace(/\.render\.com$/, '');
    domain = domain.replace(/\.onrender\.com$/, '');
    domain = domain.split('.')[0];
    
    return domain || 'naming-server';
}

const SHORT_DOMAIN = getShortDomainName();
console.log(`🚀 Render Domain: ${SHORT_DOMAIN}`);

// Middleware
app.use(cors());
app.use(express.json());

// Global variables
let dbx = null;
let isDropboxInitialized = false;

// In-memory database
let botDatabase = {
    bots: new Map(),
    prefixCounters: new Map(),
    onlineBots: new Map(),
    serverStartTime: Date.now()
};

// Database file paths
const DB_FILE = path.join(__dirname, 'bot-database.json');
const DB_BACKUP_FILE = path.join(__dirname, 'database-backup.json');

// ==================== DROPBOX FUNCTIONS ====================

/**
 * Initialize Dropbox
 */
async function initializeDropbox() {
    try {
        if (isDropboxInitialized && dbx) return dbx;

        console.log('🔄 Initializing Dropbox for database backup...');
        
        const accessToken = await getDropboxAccessToken();
        if (!accessToken) {
            console.log('❌ Failed to get Dropbox access token');
            return null;
        }
        
        dbx = new Dropbox({ 
            accessToken: accessToken,
            clientId: DROPBOX_CONFIG.APP_KEY
        });
        
        // Test connection
        await dbx.usersGetCurrentAccount();
        console.log('✅ Dropbox initialized successfully');
        isDropboxInitialized = true;
        return dbx;
        
    } catch (error) {
        console.error('❌ Dropbox initialization failed:', error.message);
        return null;
    }
}

/**
 * Get Dropbox access token
 */
async function getDropboxAccessToken() {
    try {
        const response = await axios.post(
            'https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: DROPBOX_CONFIG.REFRESH_TOKEN,
                client_id: DROPBOX_CONFIG.APP_KEY,
                client_secret: DROPBOX_CONFIG.APP_SECRET
            }),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            }
        );

        return response.data.access_token;
    } catch (error) {
        console.error('❌ Dropbox token error:', error.message);
        return null;
    }
}

/**
 * Backup database to Dropbox
 */
async function backupDatabaseToDropbox() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                console.log('❌ Dropbox not available for backup');
                return false;
            }
        }

        // Save local backup first
        saveLocalDatabase();
        
        // Read the database file
        const dbData = fs.readFileSync(DB_FILE, 'utf8');
        
        // Upload to Dropbox
        await dbx.filesUpload({
            path: `/${SHORT_DOMAIN}/naming-server-database.json`,
            contents: dbData,
            mode: { '.tag': 'overwrite' },
            autorename: false
        });
        
        console.log(`✅ Database backed up to Dropbox: /${SHORT_DOMAIN}/naming-server-database.json`);
        return true;
        
    } catch (error) {
        console.error('❌ Database backup failed:', error.message);
        return false;
    }
}

/**
 * Restore database from Dropbox
 */
async function restoreDatabaseFromDropbox() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                console.log('❌ Dropbox not available for restore');
                return false;
            }
        }

        console.log(`🔍 Looking for database backup in Dropbox: /${SHORT_DOMAIN}/naming-server-database.json`);
        
        // Download from Dropbox
        const response = await dbx.filesDownload({
            path: `/${SHORT_DOMAIN}/naming-server-database.json`
        });

        const dbData = response.result.fileBinary;
        
        // Save to local file
        fs.writeFileSync(DB_BACKUP_FILE, dbData);
        
        // Load into memory
        const parsed = JSON.parse(dbData.toString());
        botDatabase.bots = new Map(parsed.bots || []);
        botDatabase.prefixCounters = new Map(parsed.prefixCounters || []);
        botDatabase.onlineBots = new Map(parsed.onlineBots || []);
        
        console.log(`✅ Database restored from Dropbox: ${botDatabase.bots.size} bots loaded`);
        return true;
        
    } catch (error) {
        if (error.status === 409) {
            console.log('📭 No existing database backup found in Dropbox, starting fresh');
        } else {
            console.error('❌ Database restore failed:', error.message);
        }
        return false;
    }
}

// ==================== DATABASE MANAGEMENT ====================

/**
 * Load database from local file
 */
function loadLocalDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(data);
            
            botDatabase.bots = new Map(parsed.bots || []);
            botDatabase.prefixCounters = new Map(parsed.prefixCounters || []);
            botDatabase.onlineBots = new Map(parsed.onlineBots || []);
            
            console.log(`✅ Local database loaded: ${botDatabase.bots.size} bots`);
            return true;
        }
    } catch (error) {
        console.log('❌ Local database load failed, starting fresh');
    }
    return false;
}

/**
 * Save database to local file
 */
function saveLocalDatabase() {
    try {
        const data = {
            bots: Array.from(botDatabase.bots.entries()),
            prefixCounters: Array.from(botDatabase.prefixCounters.entries()),
            onlineBots: Array.from(botDatabase.onlineBots.entries()),
            lastBackup: new Date().toISOString(),
            serverDomain: SHORT_DOMAIN
        };
        
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Local database save failed:', error);
        return false;
    }
}

// ==================== AUTO-PING SYSTEM ====================

/**
 * Self-ping to keep Render alive
 */
async function selfPing() {
    if (!IS_RENDER) return;
    
    try {
        const pingUrl = `${RENDER_DOMAIN}/ping`;
        const response = await axios.get(pingUrl, { timeout: 10000 });
        
        console.log(`💓 Self-ping successful: ${response.data.status} at ${new Date().toISOString()}`);
    } catch (error) {
        console.warn(`⚠️ Self-ping failed: ${error.message}`);
    }
}

/**
 * Start auto-ping system
 */
function startAutoPing() {
    if (!IS_RENDER) {
        console.log('🖥️  Running locally - auto-ping disabled');
        return;
    }

    console.log('🔄 Starting auto-ping system (every 5 minutes)');
    
    // Initial ping after 30 seconds
    setTimeout(selfPing, 30000);
    
    // Regular pings every 5 minutes
    setInterval(selfPing, 5 * 60 * 1000);
}

/**
 * Start automatic database backups
 */
function startAutoBackup() {
    console.log('🔄 Starting automatic database backups (every 30 minutes)');
    
    // Initial backup after 2 minutes
    setTimeout(() => {
        backupDatabaseToDropbox().catch(console.error);
    }, 2 * 60 * 1000);
    
    // Regular backups every 30 minutes
    setInterval(() => {
        console.log('🔄 Running scheduled database backup...');
        backupDatabaseToDropbox().catch(console.error);
    }, 30 * 60 * 1000);
}

// ==================== ENHANCED ENDPOINTS ====================

app.get('/', (req, res) => {
    res.json({
        status: '✅ Phistar Naming Server Running',
        domain: SHORT_DOMAIN,
        totalBots: botDatabase.bots.size,
        onlineBots: botDatabase.onlineBots.size,
        serverUptime: Math.floor((Date.now() - botDatabase.serverStartTime) / 1000),
        render: IS_RENDER,
        timestamp: new Date().toISOString()
    });
});

app.get('/ping', (req, res) => {
    res.json({
        status: 'pong',
        server: 'naming-server',
        domain: SHORT_DOMAIN,
        time: new Date().toISOString()
    });
});

// Enhanced get-bot-id endpoint with auto-backup
app.post('/get-bot-id', async (req, res) => {
    try {
        const { prefix, currentId } = req.body;
        
        if (!prefix) {
            return res.status(400).json({
                success: false,
                error: 'Prefix is required'
            });
        }

        console.log(`🔍 Bot requesting ID - Prefix: ${prefix}, Current: ${currentId}`);

        let botId;
        let status;

        // Reconnection logic
        if (currentId && botDatabase.bots.has(currentId)) {
            const bot = botDatabase.bots.get(currentId);
            
            if (!botDatabase.onlineBots.has(currentId)) {
                botDatabase.onlineBots.set(currentId, {
                    ...bot,
                    lastSeen: Date.now(),
                    status: 'online'
                });
                
                botId = currentId;
                status = 'reconnected';
                console.log(`✅ Bot reconnected: ${currentId}`);
            }
        }

        // Find inactive bot
        if (!botId) {
            const inactiveBot = findInactiveBot(prefix);
            
            if (inactiveBot) {
                botDatabase.onlineBots.set(inactiveBot.botId, {
                    ...inactiveBot,
                    lastSeen: Date.now(),
                    status: 'online'
                });
                
                botId = inactiveBot.botId;
                status = 'reactivated';
                console.log(`🔄 Reactivated inactive bot: ${inactiveBot.botId}`);
            }
        }

        // Create new bot
        if (!botId) {
            botId = generateNewBotId(prefix);
            const newBot = {
                botId: botId,
                prefix: prefix,
                created: new Date().toISOString(),
                status: 'online',
                lastSeen: Date.now(),
                dropboxFolder: `${botId}_sessions`
            };

            botDatabase.bots.set(botId, newBot);
            botDatabase.onlineBots.set(botId, newBot);
            status = 'new';
            console.log(`🎯 New bot created: ${botId}`);
        }

        // Auto-backup on new bot creation
        if (status === 'new') {
            setTimeout(() => {
                backupDatabaseToDropbox().catch(console.error);
            }, 5000);
        }

        saveLocalDatabase();

        res.json({
            success: true,
            botId: botId,
            status: status,
            dropboxFolder: `${botId}_sessions`,
            namingServer: SHORT_DOMAIN,
            message: `Bot identity ${status}`
        });

    } catch (error) {
        console.error('Get Bot ID error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Enhanced heartbeat with auto-cleanup
app.post('/heartbeat', (req, res) => {
    try {
        const { botId, status = 'online' } = req.body;
        
        if (!botId) {
            return res.status(400).json({
                success: false,
                error: 'botId is required'
            });
        }

        if (status === 'online') {
            if (botDatabase.bots.has(botId)) {
                const bot = botDatabase.bots.get(botId);
                botDatabase.onlineBots.set(botId, {
                    ...bot,
                    lastSeen: Date.now(),
                    status: 'online'
                });
            }
        } else {
            botDatabase.onlineBots.delete(botId);
        }

        saveLocalDatabase();

        res.json({
            success: true,
            message: `Status updated to: ${status}`,
            server: SHORT_DOMAIN
        });

    } catch (error) {
        console.error('Heartbeat error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// New endpoint: Manual database backup
app.post('/backup-database', async (req, res) => {
    try {
        const { authorization } = req.body;
        
        if (!authorization || authorization !== 'PhistarAdmin2025') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        const success = await backupDatabaseToDropbox();
        
        res.json({
            success: success,
            message: success ? 'Database backup completed' : 'Backup failed',
            domain: SHORT_DOMAIN,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Manual backup error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// New endpoint: Database status
app.get('/database-status', (req, res) => {
    res.json({
        success: true,
        domain: SHORT_DOMAIN,
        localBots: botDatabase.bots.size,
        onlineBots: botDatabase.onlineBots.size,
        dropboxEnabled: !!dbx,
        lastBackup: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).mtime : null,
        render: IS_RENDER
    });
});

// Keep existing endpoints: /bot-status, /all-bots, /cleanup

// ==================== HELPER FUNCTIONS ====================

function findInactiveBot(prefix) {
    for (const [botId, bot] of botDatabase.bots.entries()) {
        const isOnline = botDatabase.onlineBots.has(botId);
        const hasMatchingPrefix = bot.prefix === prefix;
        
        if (hasMatchingPrefix && !isOnline) {
            return bot;
        }
    }
    return null;
}

function generateNewBotId(prefix) {
    const counter = (botDatabase.prefixCounters.get(prefix) || 0) + 1;
    botDatabase.prefixCounters.set(prefix, counter);
    return `${prefix}_${String(counter).padStart(3, '0')}`;
}

// ==================== SERVER INITIALIZATION ====================

async function initializeServer() {
    console.log('🚀 Initializing Phistar Naming Server...');
    
    // Step 1: Try to restore from Dropbox first
    console.log('🔍 Attempting to restore database from Dropbox...');
    const restored = await restoreDatabaseFromDropbox();
    
    // Step 2: If Dropbox restore failed, try local file
    if (!restored) {
        console.log('🔍 Loading local database file...');
        loadLocalDatabase();
    }
    
    // Step 3: Start services
    startAutoPing();
    startAutoBackup();
    
    // Step 4: Auto-cleanup every hour
    setInterval(() => {
        const now = Date.now();
        const OFFLINE_THRESHOLD = 6 * 60 * 60 * 1000; // 6 hours
        
        let cleaned = 0;
        for (const [botId, bot] of botDatabase.onlineBots.entries()) {
            const timeSinceLastSeen = now - (bot.lastSeen || 0);
            if (timeSinceLastSeen > OFFLINE_THRESHOLD) {
                botDatabase.onlineBots.delete(botId);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            saveLocalDatabase();
            console.log(`🧹 Auto-cleanup removed ${cleaned} offline bots`);
        }
    }, 60 * 60 * 1000);
}

// ==================== SERVER STARTUP ====================

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Phistar Naming Server running on port ${PORT}`);
    console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
    console.log(`🏠 Render: ${IS_RENDER}`);
    
    await initializeServer();
    
    console.log(`📊 Database ready: ${botDatabase.bots.size} bots loaded`);
    console.log(`🔗 Online bots: ${botDatabase.onlineBots.size}`);
    console.log(`🎯 Auto-backup: Enabled`);
    console.log(`💓 Auto-ping: ${IS_RENDER ? 'Enabled' : 'Disabled'}`);
    
    // Save database on exit
    process.on('SIGINT', async () => {
        console.log('💾 Saving database before exit...');
        saveLocalDatabase();
        await backupDatabaseToDropbox();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('💾 Saving database before termination...');
        saveLocalDatabase();
        await backupDatabaseToDropbox();
        process.exit(0);
    });
});

module.exports = app;
