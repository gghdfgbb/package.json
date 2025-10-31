/* Phistar Naming Server - With Strict 35-Second Heartbeat Monitoring */
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

// ==================== STRICT HEARTBEAT CONFIGURATION ====================
const HEARTBEAT_TIMEOUT = 17 * 1000; // 17 seconds - BOT MUST SEND HEARTBEAT WITHIN THIS TIME
const HEARTBEAT_CHECK_INTERVAL = 10 * 1000; // Check every 10 seconds for offline bots
const GRACE_PERIOD = 5 * 1000; // 5 second grace period

// Middleware
app.use(cors());
app.use(express.json());

// Global variables
let dbx = null;
let isDropboxInitialized = false;

// In-memory database
let botDatabase = {
    bots: new Map(),
    onlineBots: new Map(),
    heartbeatTimestamps: new Map(), // Track last heartbeat time for each bot
    globalCounter: 1, // GLOBAL counter for unique IDs across all prefixes
    prefixCounters: new Map(), // Keep track per prefix for display
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
 * Enhanced database restoration with data synchronization
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
        botDatabase.onlineBots = new Map(parsed.onlineBots || []);
        botDatabase.heartbeatTimestamps = new Map(parsed.heartbeatTimestamps || []);
        botDatabase.globalCounter = parsed.globalCounter || (botDatabase.bots.size + 1);
        botDatabase.prefixCounters = new Map(parsed.prefixCounters || []);
        
        // Synchronize data: ensure all online bots have heartbeat timestamps
        const now = Date.now();
        for (const [botId, bot] of botDatabase.onlineBots.entries()) {
            if (!botDatabase.heartbeatTimestamps.has(botId)) {
                botDatabase.heartbeatTimestamps.set(botId, now - 10000); // Set to 10 seconds ago
            }
        }
        
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
            botDatabase.onlineBots = new Map(parsed.onlineBots || []);
            botDatabase.heartbeatTimestamps = new Map(parsed.heartbeatTimestamps || []);
            botDatabase.globalCounter = parsed.globalCounter || 1;
            botDatabase.prefixCounters = new Map(parsed.prefixCounters || []);
            
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
            onlineBots: Array.from(botDatabase.onlineBots.entries()),
            heartbeatTimestamps: Array.from(botDatabase.heartbeatTimestamps.entries()),
            globalCounter: botDatabase.globalCounter,
            prefixCounters: Array.from(botDatabase.prefixCounters.entries()),
            lastBackup: new Date().toISOString(),
            serverDomain: SHORT_DOMAIN,
            heartbeatTimeout: HEARTBEAT_TIMEOUT
        };
        
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Local database save failed:', error);
        return false;
    }
}

// ==================== STRICT HEARTBEAT MONITORING SYSTEM ====================

/**
 * Check for bots that missed their heartbeat
 */
function checkHeartbeatCompliance() {
    const now = Date.now();
    let markedOffline = 0;
    
    for (const [botId, lastHeartbeat] of botDatabase.heartbeatTimestamps.entries()) {
        const timeSinceHeartbeat = now - lastHeartbeat;
        
        if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT) {
            // Bot missed heartbeat - mark as offline
            if (botDatabase.onlineBots.has(botId)) {
                botDatabase.onlineBots.delete(botId);
                markedOffline++;
                console.log(`🚨 Bot ${botId} marked OFFLINE - Missed heartbeat (${Math.floor(timeSinceHeartbeat/1000)}s)`);
            }
        }
    }
    
    if (markedOffline > 0) {
        saveLocalDatabase();
        console.log(`📊 Heartbeat check: ${markedOffline} bots marked offline`);
    }
    
    return markedOffline;
}

/**
 * Start strict heartbeat monitoring
 */
function startStrictHeartbeatMonitoring() {
    console.log(`🔍 Starting STRICT heartbeat monitoring (35-second timeout)`);
    
    // Check every 10 seconds for compliance
    setInterval(() => {
        checkHeartbeatCompliance();
    }, HEARTBEAT_CHECK_INTERVAL);
    
    // Initial check after 40 seconds
    setTimeout(() => {
        console.log('🔍 Running initial heartbeat compliance check...');
        checkHeartbeatCompliance();
    }, HEARTBEAT_TIMEOUT + 5000);
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

// ==================== HELPER FUNCTIONS ====================

function findOfflineBotByPrefix(prefix) {
    const now = Date.now();
    
    for (const [botId, bot] of botDatabase.bots.entries()) {
        const isOnline = botDatabase.onlineBots.has(botId);
        const hasMatchingPrefix = bot.prefix === prefix;
        const lastHeartbeat = botDatabase.heartbeatTimestamps.get(botId);
        const isCompliant = lastHeartbeat ? (now - lastHeartbeat <= HEARTBEAT_TIMEOUT) : false;
        
        // Return bot if it matches prefix AND is either offline OR non-compliant
        if (hasMatchingPrefix && (!isOnline || !isCompliant)) {
            return bot;
        }
    }
    return null;
}

function generateUniqueBotId(prefix) {
    // Use GLOBAL counter to ensure unique IDs across all prefixes
    const globalId = botDatabase.globalCounter++;
    
    // Also track prefix-specific counter for display purposes
    const prefixCounter = (botDatabase.prefixCounters.get(prefix) || 0) + 1;
    botDatabase.prefixCounters.set(prefix, prefixCounter);
    
    // Format: prefix_globalID (e.g., phistar_001, phistar_002, dot_003, etc.)
    return `${prefix}_${String(globalId).padStart(3, '0')}`;
}

function extractPrefixFromBotId(botId) {
    // Extract prefix from botId (format: prefix_001)
    const parts = botId.split('_');
    if (parts.length >= 2) {
        return parts[0];
    }
    return 'unknown';
}

/**
 * Synchronize database data to fix any inconsistencies
 */
function synchronizeDatabase() {
    console.log('🔄 Synchronizing database data...');
    
    const now = Date.now();
    let fixesApplied = 0;
    
    // Ensure all online bots exist in main bots database
    for (const [botId, onlineBot] of botDatabase.onlineBots.entries()) {
        if (!botDatabase.bots.has(botId)) {
            botDatabase.bots.set(botId, {
                botId: botId,
                prefix: extractPrefixFromBotId(botId),
                created: new Date().toISOString(),
                status: 'online',
                lastSeen: now,
                dropboxFolder: `${botId}_sessions`
            });
            fixesApplied++;
            console.log(`🔧 Fixed: Added missing bot ${botId} to main database`);
        }
    }
    
    // Ensure all bots with heartbeat timestamps exist in main database
    for (const [botId, timestamp] of botDatabase.heartbeatTimestamps.entries()) {
        if (!botDatabase.bots.has(botId)) {
            botDatabase.bots.set(botId, {
                botId: botId,
                prefix: extractPrefixFromBotId(botId),
                created: new Date().toISOString(),
                status: 'online',
                lastSeen: now,
                dropboxFolder: `${botId}_sessions`
            });
            fixesApplied++;
            console.log(`🔧 Fixed: Added missing bot ${botId} from heartbeat to main database`);
        }
    }
    
    if (fixesApplied > 0) {
        saveLocalDatabase();
        console.log(`✅ Database synchronization completed: ${fixesApplied} fixes applied`);
    }
    
    return fixesApplied;
}

// ==================== ENHANCED ENDPOINTS ====================

app.get('/', (req, res) => {
    const now = Date.now();
    
    // Get ALL bots from the main database (not just heartbeat timestamps)
    const allBots = Array.from(botDatabase.bots.values());
    const heartbeatStatus = allBots.map(bot => {
        const lastHeartbeat = botDatabase.heartbeatTimestamps.get(bot.botId);
        const timeSince = lastHeartbeat ? now - lastHeartbeat : Number.MAX_SAFE_INTEGER;
        const status = timeSince > HEARTBEAT_TIMEOUT ? 'OFFLINE' : 'ONLINE';
        const isActuallyOnline = botDatabase.onlineBots.has(bot.botId);
        
        return { 
            botId: bot.botId, 
            prefix: bot.prefix,
            lastHeartbeat: lastHeartbeat, 
            timeSince: Math.floor(timeSince/1000), 
            status: isActuallyOnline ? status : 'OFFLINE' // Use onlineBots as source of truth
        };
    });
    
    // Count bots by prefix for accurate statistics
    const prefixStats = {};
    allBots.forEach(bot => {
        if (!prefixStats[bot.prefix]) {
            prefixStats[bot.prefix] = { total: 0, online: 0 };
        }
        prefixStats[bot.prefix].total++;
        if (botDatabase.onlineBots.has(bot.botId)) {
            prefixStats[bot.prefix].online++;
        }
    });
    
    // Calculate accurate totals
    const totalBots = allBots.length;
    const onlineBots = Array.from(botDatabase.onlineBots.keys()).length;
    
    res.json({
        status: '✅ Phistar Naming Server Running',
        domain: SHORT_DOMAIN,
        totalBots: totalBots, // ACCURATE COUNT from bots Map
        onlineBots: onlineBots, // ACCURATE COUNT from onlineBots Map
        heartbeatTimeout: HEARTBEAT_TIMEOUT + 'ms',
        serverUptime: Math.floor((Date.now() - botDatabase.serverStartTime) / 1000),
        render: IS_RENDER,
        prefixStatistics: prefixStats,
        heartbeatStatus: heartbeatStatus,
        timestamp: new Date().toISOString()
    });
});

app.get('/ping', (req, res) => {
    res.json({
        status: 'pong',
        server: 'naming-server',
        domain: SHORT_DOMAIN,
        heartbeatTimeout: HEARTBEAT_TIMEOUT,
        totalBots: botDatabase.bots.size,
        onlineBots: botDatabase.onlineBots.size,
        time: new Date().toISOString()
    });
});

// Enhanced get-bot-id endpoint with proper data synchronization
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
        const now = Date.now();

        // Check if current bot exists and is compliant
        if (currentId && botDatabase.bots.has(currentId)) {
            const lastHeartbeat = botDatabase.heartbeatTimestamps.get(currentId);
            const isCompliant = lastHeartbeat && (now - lastHeartbeat <= HEARTBEAT_TIMEOUT + GRACE_PERIOD);
            
            if (isCompliant) {
                // Bot is compliant - reactivate or keep online
                const bot = botDatabase.bots.get(currentId);
                botDatabase.onlineBots.set(currentId, {
                    ...bot,
                    lastSeen: now,
                    status: 'online'
                });
                botDatabase.heartbeatTimestamps.set(currentId, now);
                
                botId = currentId;
                status = 'reconnected_compliant';
                console.log(`✅ Bot reconnected (compliant): ${currentId}`);
            }
        }

        // Find OFFLINE bot with same prefix (missed heartbeat)
        if (!botId) {
            const offlineBot = findOfflineBotByPrefix(prefix);
            
            if (offlineBot) {
                // Reactivate the offline bot
                botDatabase.onlineBots.set(offlineBot.botId, {
                    ...offlineBot,
                    lastSeen: now,
                    status: 'online'
                });
                botDatabase.heartbeatTimestamps.set(offlineBot.botId, now);
                
                botId = offlineBot.botId;
                status = 'reactivated_offline';
                console.log(`🔄 Reactivated OFFLINE bot: ${offlineBot.botId}`);
            }
        }

        // Create new bot if no available offline bots
        if (!botId) {
            botId = generateUniqueBotId(prefix);
            const newBot = {
                botId: botId,
                prefix: prefix,
                created: new Date().toISOString(),
                status: 'online',
                lastSeen: now,
                dropboxFolder: `${botId}_sessions`
            };

            botDatabase.bots.set(botId, newBot);
            botDatabase.onlineBots.set(botId, newBot);
            botDatabase.heartbeatTimestamps.set(botId, now);
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
            heartbeatRequired: 'Every 35 seconds',
            message: `Bot identity ${status} - Heartbeat required every 35 seconds`
        });

    } catch (error) {
        console.error('Get Bot ID error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// STRICT Heartbeat endpoint - Bot MUST call this every 35 seconds
app.post('/heartbeat', (req, res) => {
    try {
        const { botId, status = 'online', activeSessions = 0 } = req.body;
        
        if (!botId) {
            return res.status(400).json({
                success: false,
                error: 'botId is required'
            });
        }

        const now = Date.now();
        const lastHeartbeat = botDatabase.heartbeatTimestamps.get(botId);
        const timeSinceLast = lastHeartbeat ? now - lastHeartbeat : null;

        if (status === 'online') {
            // Update heartbeat timestamp
            botDatabase.heartbeatTimestamps.set(botId, now);
            
            // Ensure bot exists in main database
            if (!botDatabase.bots.has(botId)) {
                // Create bot entry if it doesn't exist (shouldn't happen but for safety)
                const newBot = {
                    botId: botId,
                    prefix: extractPrefixFromBotId(botId),
                    created: new Date().toISOString(),
                    status: 'online',
                    lastSeen: now,
                    dropboxFolder: `${botId}_sessions`
                };
                botDatabase.bots.set(botId, newBot);
                console.log(`⚠️ Created missing bot entry: ${botId}`);
            }
            
            // If bot was offline, reactivate it
            if (!botDatabase.onlineBots.has(botId)) {
                const bot = botDatabase.bots.get(botId);
                botDatabase.onlineBots.set(botId, {
                    ...bot,
                    lastSeen: now,
                    status: 'online',
                    activeSessions: activeSessions
                });
                console.log(`🔄 Bot ${botId} came back ONLINE after being offline`);
            } else {
                // Update existing online bot
                const bot = botDatabase.onlineBots.get(botId);
                bot.lastSeen = now;
                bot.activeSessions = activeSessions;
            }
            
            console.log(`💓 Heartbeat from ${botId} (${timeSinceLast ? Math.floor(timeSinceLast/1000) + 's ago' : 'first'}) - ${activeSessions} sessions`);
        } else {
            // Manual offline status
            botDatabase.onlineBots.delete(botId);
            console.log(`📴 Bot ${botId} manually set to offline`);
        }

        saveLocalDatabase();

        res.json({
            success: true,
            message: `Heartbeat received - Status: ${status}`,
            timeSinceLast: timeSinceLast ? Math.floor(timeSinceLast/1000) + 's' : 'first',
            nextHeartbeatRequired: 'Within 35 seconds',
            server: SHORT_DOMAIN,
            timestamp: now
        });

    } catch (error) {
        console.error('Heartbeat error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Enhanced bot status endpoint
app.get('/bot-status/:botId', (req, res) => {
    try {
        const { botId } = req.params;
        const now = Date.now();
        
        if (!botDatabase.bots.has(botId)) {
            return res.status(404).json({
                success: false,
                error: 'Bot not found'
            });
        }

        const bot = botDatabase.bots.get(botId);
        const lastHeartbeat = botDatabase.heartbeatTimestamps.get(botId);
        const isOnline = botDatabase.onlineBots.has(botId);
        const timeSinceHeartbeat = lastHeartbeat ? now - lastHeartbeat : null;
        const isCompliant = lastHeartbeat ? (now - lastHeartbeat <= HEARTBEAT_TIMEOUT) : false;

        res.json({
            success: true,
            botId: botId,
            prefix: bot.prefix,
            status: isOnline ? (isCompliant ? 'online_compliant' : 'online_late') : 'offline',
            lastHeartbeat: lastHeartbeat,
            timeSinceHeartbeat: timeSinceHeartbeat ? Math.floor(timeSinceHeartbeat/1000) + 's' : 'never',
            isCompliant: isCompliant,
            created: bot.created,
            dropboxFolder: bot.dropboxFolder
        });

    } catch (error) {
        console.error('Bot status error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// All bots endpoint with heartbeat status
app.get('/all-bots', (req, res) => {
    const now = Date.now();
    const bots = Array.from(botDatabase.bots.entries()).map(([botId, bot]) => {
        const lastHeartbeat = botDatabase.heartbeatTimestamps.get(botId);
        const isOnline = botDatabase.onlineBots.has(botId);
        const timeSinceHeartbeat = lastHeartbeat ? now - lastHeartbeat : null;
        const isCompliant = lastHeartbeat ? (now - lastHeartbeat <= HEARTBEAT_TIMEOUT) : false;
        
        return {
            botId,
            prefix: bot.prefix,
            status: isOnline ? (isCompliant ? 'online_compliant' : 'online_late') : 'offline',
            lastHeartbeat: lastHeartbeat,
            timeSinceHeartbeat: timeSinceHeartbeat ? Math.floor(timeSinceHeartbeat/1000) + 's' : 'never',
            isCompliant: isCompliant,
            created: bot.created,
            dropboxFolder: bot.dropboxFolder
        };
    });

    res.json({
        success: true,
        totalBots: bots.length,
        onlineCompliant: bots.filter(b => b.status === 'online_compliant').length,
        onlineLate: bots.filter(b => b.status === 'online_late').length,
        offline: bots.filter(b => b.status === 'offline').length,
        bots: bots,
        heartbeatTimeout: HEARTBEAT_TIMEOUT + 'ms'
    });
});

// Manual database backup endpoint
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

// Database status endpoint
app.get('/database-status', (req, res) => {
    const now = Date.now();
    const nonCompliantBots = Array.from(botDatabase.heartbeatTimestamps.entries())
        .filter(([botId, timestamp]) => now - timestamp > HEARTBEAT_TIMEOUT)
        .map(([botId, timestamp]) => ({
            botId,
            timeSince: Math.floor((now - timestamp)/1000) + 's'
        }));
    
    res.json({
        success: true,
        domain: SHORT_DOMAIN,
        totalBots: botDatabase.bots.size,
        onlineBots: botDatabase.onlineBots.size,
        heartbeatTimestamps: botDatabase.heartbeatTimestamps.size,
        nonCompliantBots: nonCompliantBots.length,
        nonCompliantList: nonCompliantBots,
        dropboxEnabled: !!dbx,
        heartbeatTimeout: HEARTBEAT_TIMEOUT + 'ms',
        lastBackup: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).mtime : null,
        render: IS_RENDER
    });
});

// Cleanup endpoint (manual trigger)
app.post('/cleanup', (req, res) => {
    try {
        const { authorization } = req.body;
        
        if (!authorization || authorization !== 'PhistarAdmin2025') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        const cleaned = checkHeartbeatCompliance();
        
        res.json({
            success: true,
            message: `Cleanup completed - ${cleaned} bots marked offline`,
            cleaned: cleaned,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== SERVER INITIALIZATION ====================

async function initializeServer() {
    console.log('🚀 Initializing Phistar Naming Server with STRICT 35-second heartbeat monitoring...');
    
    // Step 1: Try to restore from Dropbox first
    console.log('🔍 Attempting to restore database from Dropbox...');
    const restored = await restoreDatabaseFromDropbox();
    
    // Step 2: If Dropbox restore failed, try local file
    if (!restored) {
        console.log('🔍 Loading local database file...');
        loadLocalDatabase();
    }
    
    // Step 3: Synchronize database to fix any inconsistencies
    synchronizeDatabase();
    
    // Step 4: Start STRICT heartbeat monitoring
    startStrictHeartbeatMonitoring();
    
    // Step 5: Start other services
    startAutoPing();
    startAutoBackup();
    
    console.log(`✅ Server initialized with STRICT heartbeat monitoring (${HEARTBEAT_TIMEOUT}ms timeout)`);
}

// ==================== SERVER STARTUP ====================

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Phistar Naming Server running on port ${PORT}`);
    console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
    console.log(`🏠 Render: ${IS_RENDER}`);
    console.log(`🔒 STRICT Heartbeat Monitoring: ${HEARTBEAT_TIMEOUT}ms timeout`);
    
    await initializeServer();
    
    console.log(`📊 Database ready: ${botDatabase.bots.size} bots loaded`);
    console.log(`🔗 Online bots: ${botDatabase.onlineBots.size}`);
    console.log(`💓 Heartbeat timestamps: ${botDatabase.heartbeatTimestamps.size}`);
    console.log(`🎯 Auto-backup: Enabled`);
    console.log(`🔍 Heartbeat monitoring: STRICT (35 seconds)`);
    console.log(`🆔 Bot ID System: GLOBALLY UNIQUE (prefix_globalID)`);
    
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
