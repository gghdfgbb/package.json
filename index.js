/* Phistar Naming Server - Fixed Always-Online System */
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
app.use(express.urlencoded({ extended: true }));

// Global variables
let dbx = null;
let isDropboxInitialized = false;

// In-memory database - SIMPLIFIED: No heartbeat tracking
let botDatabase = {
    bots: new Map(),
    onlineBots: new Map(), // ALL BOTS ARE CONSIDERED ONLINE WHEN ACTIVE
    globalCounter: 1, // GLOBAL counter for unique IDs across all prefixes
    prefixCounters: new Map(), // Keep track per prefix for display
    serverStartTime: Date.now(),
    deletedBots: new Map() // Track deleted bots for history
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
        botDatabase.globalCounter = parsed.globalCounter || (botDatabase.bots.size + 1);
        botDatabase.prefixCounters = new Map(parsed.prefixCounters || []);
        botDatabase.deletedBots = new Map(parsed.deletedBots || []);
        
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
            botDatabase.globalCounter = parsed.globalCounter || 1;
            botDatabase.prefixCounters = new Map(parsed.prefixCounters || []);
            botDatabase.deletedBots = new Map(parsed.deletedBots || []);
            
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
            globalCounter: botDatabase.globalCounter,
            prefixCounters: Array.from(botDatabase.prefixCounters.entries()),
            deletedBots: Array.from(botDatabase.deletedBots.entries()),
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

// ==================== BOT DELETION SYSTEM ====================

/**
 * Delete a bot from all database collections
 */
function deleteBot(botId, reason = 'manual_deletion') {
    try {
        if (!botDatabase.bots.has(botId)) {
            return {
                success: false,
                error: 'Bot not found'
            };
        }

        const bot = botDatabase.bots.get(botId);
        const deletionInfo = {
            botId: botId,
            prefix: bot.prefix,
            created: bot.created,
            deletedAt: new Date().toISOString(),
            reason: reason,
            originalData: bot
        };

        // Store in deleted bots history
        botDatabase.deletedBots.set(botId, deletionInfo);

        // Remove from all active collections
        botDatabase.bots.delete(botId);
        botDatabase.onlineBots.delete(botId);

        console.log(`🗑️ Bot deleted: ${botId} - Reason: ${reason}`);
        
        // Save database after deletion
        saveLocalDatabase();

        return {
            success: true,
            message: `Bot ${botId} deleted successfully`,
            deletionInfo: deletionInfo
        };

    } catch (error) {
        console.error('❌ Bot deletion error:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Delete multiple bots at once
 */
function deleteMultipleBots(botIds, reason = 'bulk_deletion') {
    const results = {
        success: [],
        failed: []
    };

    botIds.forEach(botId => {
        const result = deleteBot(botId, reason);
        if (result.success) {
            results.success.push(botId);
        } else {
            results.failed.push({
                botId: botId,
                error: result.error
            });
        }
    });

    return results;
}

/**
 * Delete bots by prefix
 */
function deleteBotsByPrefix(prefix, reason = 'prefix_deletion') {
    const botsToDelete = Array.from(botDatabase.bots.values())
        .filter(bot => bot.prefix === prefix)
        .map(bot => bot.botId);

    return deleteMultipleBots(botsToDelete, reason);
}

// ==================== SIMPLIFIED BOT MANAGEMENT ====================

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
    
    if (fixesApplied > 0) {
        saveLocalDatabase();
        console.log(`✅ Database synchronization completed: ${fixesApplied} fixes applied`);
    }
    
    return fixesApplied;
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

// ==================== WEB INTERFACE FOR DELETION ====================

/**
 * Generate HTML for the deletion interface
 */
function generateDeletionInterface() {
    const allBots = Array.from(botDatabase.bots.values());
    
    const botRows = allBots.map(bot => {
        const isOnline = botDatabase.onlineBots.has(bot.botId);
        const status = isOnline ? '🟢 ONLINE' : '🔴 OFFLINE';
        
        return `
            <tr>
                <td>
                    <input type="checkbox" name="botIds" value="${bot.botId}" id="bot-${bot.botId}">
                </td>
                <td>${bot.botId}</td>
                <td>${bot.prefix}</td>
                <td>${status}</td>
                <td>${new Date(bot.created).toLocaleString()}</td>
                <td>
                    <button type="button" onclick="deleteSingleBot('${bot.botId}')" class="btn-delete-single">Delete</button>
                </td>
            </tr>
        `;
    }).join('');

    const deletedBots = Array.from(botDatabase.deletedBots.values());
    const deletedRows = deletedBots.map(deleted => `
        <tr>
            <td>${deleted.botId}</td>
            <td>${deleted.prefix}</td>
            <td>${deleted.reason}</td>
            <td>${new Date(deleted.deletedAt).toLocaleString()}</td>
        </tr>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot Management - ${SHORT_DOMAIN}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #333; line-height: 1.6; min-height: 100vh; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        .header { background: rgba(255,255,255,0.95); padding: 30px; border-radius: 15px; margin-bottom: 20px; box-shadow: 0 8px 32px rgba(0,0,0,0.1); }
        .header h1 { color: #4a5568; margin-bottom: 10px; font-size: 2.5em; }
        .header p { color: #718096; font-size: 1.1em; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-card { background: white; padding: 20px; border-radius: 10px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .stat-number { font-size: 2em; font-weight: bold; color: #4a5568; }
        .stat-label { color: #718096; margin-top: 5px; }
        .section { background: white; padding: 25px; border-radius: 15px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .section h2 { color: #4a5568; margin-bottom: 20px; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; margin: 15px 0; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { background: #f7fafc; font-weight: 600; color: #4a5568; }
        tr:hover { background: #f7fafc; }
        .btn { background: #e53e3e; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; margin: 5px; transition: background 0.3s; }
        .btn:hover { background: #c53030; }
        .btn-delete-single { background: #ed8936; padding: 6px 12px; font-size: 12px; }
        .btn-delete-single:hover { background: #dd6b20; }
        .btn-bulk { background: #e53e3e; padding: 12px 24px; font-size: 16px; }
        .btn-bulk:hover { background: #c53030; }
        .form-group { margin: 15px 0; }
        .checkbox-group { max-height: 400px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; }
        .actions { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }
        .prefix-delete { background: #d69e2e; }
        .prefix-delete:hover { background: #b7791f; }
        .alert { padding: 15px; border-radius: 6px; margin: 15px 0; }
        .alert-success { background: #c6f6d5; color: #22543d; border: 1px solid #9ae6b4; }
        .alert-error { background: #fed7d7; color: #742a2a; border: 1px solid #feb2b2; }
        .tab-container { margin: 20px 0; }
        .tabs { display: flex; border-bottom: 2px solid #e2e8f0; }
        .tab { padding: 12px 24px; cursor: pointer; border: none; background: none; font-size: 16px; }
        .tab.active { border-bottom: 3px solid #e53e3e; color: #e53e3e; font-weight: bold; }
        .tab-content { display: none; padding: 20px 0; }
        .tab-content.active { display: block; }
        input[type="text"], textarea { padding: 10px; border: 1px solid #cbd5e0; border-radius: 4px; font-size: 14px; }
        input[type="text"] { width: 200px; }
        textarea { width: 100%; resize: vertical; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Bot Management Panel</h1>
            <p>Server: ${SHORT_DOMAIN} | Total Bots: ${allBots.length} | Online: ${botDatabase.onlineBots.size}</p>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-number">${allBots.length}</div>
                <div class="stat-label">Total Bots</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${botDatabase.onlineBots.size}</div>
                <div class="stat-label">Online Bots</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${allBots.length - botDatabase.onlineBots.size}</div>
                <div class="stat-label">Offline Bots</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">${deletedBots.length}</div>
                <div class="stat-label">Deleted Bots</div>
            </div>
        </div>

        <div class="tab-container">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('active')">Active Bots</button>
                <button class="tab" onclick="switchTab('deleted')">Deleted History</button>
                <button class="tab" onclick="switchTab('bulk')">Bulk Operations</button>
            </div>

            <div id="active-tab" class="tab-content active">
                <div class="section">
                    <h2>Active Bots Management</h2>
                    <div class="actions">
                        <button class="btn btn-bulk" onclick="deleteSelectedBots()">Delete Selected Bots</button>
                        <button class="btn prefix-delete" onclick="showPrefixDelete()">Delete by Prefix</button>
                        <button class="btn" onclick="selectAllBots()">Select All</button>
                        <button class="btn" onclick="deselectAllBots()">Deselect All</button>
                    </div>
                    
                    <div class="checkbox-group">
                        <table>
                            <thead>
                                <tr>
                                    <th width="50px">Select</th>
                                    <th>Bot ID</th>
                                    <th>Prefix</th>
                                    <th>Status</th>
                                    <th>Created</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${botRows || '<tr><td colspan="6" style="text-align: center;">No bots found</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div id="deleted-tab" class="tab-content">
                <div class="section">
                    <h2>Deleted Bots History</h2>
                    ${deletedBots.length > 0 ? `
                        <table>
                            <thead>
                                <tr>
                                    <th>Bot ID</th>
                                    <th>Prefix</th>
                                    <th>Reason</th>
                                    <th>Deleted At</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${deletedRows}
                            </tbody>
                        </table>
                    ` : '<p>No deleted bots found.</p>'}
                </div>
            </div>

            <div id="bulk-tab" class="tab-content">
                <div class="section">
                    <h2>Bulk Operations</h2>
                    <div class="form-group">
                        <h3>Delete by Prefix</h3>
                        <input type="text" id="prefixToDelete" placeholder="Enter prefix (e.g., phistar)" style="padding: 10px; margin-right: 10px; border: 1px solid #ccc; border-radius: 4px;">
                        <button class="btn prefix-delete" onclick="deleteByPrefix()">Delete All with Prefix</button>
                    </div>
                    
                    <div class="form-group">
                        <h3>Delete Offline Bots</h3>
                        <p>This will delete all bots that are currently offline.</p>
                        <button class="btn" onclick="deleteOfflineBots()">Delete All Offline Bots</button>
                    </div>
                    
                    <div class="form-group">
                        <h3>Manual Bot ID Deletion</h3>
                        <textarea id="manualBotIds" placeholder="Enter bot IDs to delete, one per line" style="width: 100%; height: 100px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; margin-bottom: 10px;"></textarea>
                        <button class="btn btn-bulk" onclick="deleteManualBots()">Delete Listed Bots</button>
                    </div>
                </div>
            </div>
        </div>

        <div id="alert-container"></div>
    </div>

    <script>
        function switchTab(tabName) {
            // Hide all tabs
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // Show selected tab
            document.getElementById(tabName + '-tab').classList.add('active');
            event.target.classList.add('active');
        }

        function selectAllBots() {
            document.querySelectorAll('input[name="botIds"]').forEach(checkbox => {
                checkbox.checked = true;
            });
        }

        function deselectAllBots() {
            document.querySelectorAll('input[name="botIds"]').forEach(checkbox => {
                checkbox.checked = false;
            });
        }

        function showAlert(message, type) {
            const alertDiv = document.createElement('div');
            alertDiv.className = \`alert alert-\${type}\`;
            alertDiv.textContent = message;
            document.getElementById('alert-container').appendChild(alertDiv);
            setTimeout(() => alertDiv.remove(), 5000);
        }

        async function deleteSingleBot(botId) {
            if (!confirm(\`Are you sure you want to delete bot: \${botId}?\`)) return;
            
            try {
                const response = await fetch('/delete-bot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        botId: botId,
                        authorization: 'PhistarAdmin2025'
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showAlert(\`✅ Bot \${botId} deleted successfully\`, 'success');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    showAlert(\`❌ Failed to delete bot: \${result.error}\`, 'error');
                }
            } catch (error) {
                showAlert(\`❌ Error: \${error.message}\`, 'error');
            }
        }

        async function deleteSelectedBots() {
            const selectedBots = Array.from(document.querySelectorAll('input[name="botIds"]:checked'))
                .map(checkbox => checkbox.value);
            
            if (selectedBots.length === 0) {
                alert('Please select at least one bot to delete.');
                return;
            }
            
            if (!confirm(\`Are you sure you want to delete \${selectedBots.length} bot(s)?\`)) return;
            
            try {
                const response = await fetch('/delete-bots', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        botIds: selectedBots,
                        authorization: 'PhistarAdmin2025'
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showAlert(\`✅ \${result.deletedCount} bot(s) deleted successfully\`, 'success');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    showAlert(\`❌ Failed to delete bots: \${result.error}\`, 'error');
                }
            } catch (error) {
                showAlert(\`❌ Error: \${error.message}\`, 'error');
            }
        }

        async function deleteByPrefix() {
            const prefix = document.getElementById('prefixToDelete').value.trim();
            if (!prefix) {
                alert('Please enter a prefix');
                return;
            }
            
            if (!confirm(\`Are you sure you want to delete ALL bots with prefix "\${prefix}"?\`)) return;
            
            try {
                const response = await fetch('/delete-by-prefix', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        prefix: prefix,
                        authorization: 'PhistarAdmin2025'
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showAlert(\`✅ \${result.deletedCount} bot(s) with prefix "\${prefix}" deleted\`, 'success');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    showAlert(\`❌ Failed to delete bots: \${result.error}\`, 'error');
                }
            } catch (error) {
                showAlert(\`❌ Error: \${error.message}\`, 'error');
            }
        }

        async function deleteOfflineBots() {
            if (!confirm('Are you sure you want to delete ALL offline bots?')) return;
            
            try {
                const response = await fetch('/delete-offline-bots', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        authorization: 'PhistarAdmin2025'
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showAlert(\`✅ \${result.deletedCount} offline bot(s) deleted\`, 'success');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    showAlert(\`❌ Failed to delete offline bots: \${result.error}\`, 'error');
                }
            } catch (error) {
                showAlert(\`❌ Error: \${error.message}\`, 'error');
            }
        }

        async function deleteManualBots() {
            const manualInput = document.getElementById('manualBotIds').value.trim();
            if (!manualInput) {
                alert('Please enter at least one bot ID');
                return;
            }
            
            const botIds = manualInput.split('\\n').map(id => id.trim()).filter(id => id);
            
            if (!confirm(\`Are you sure you want to delete \${botIds.length} bot(s)?\`)) return;
            
            try {
                const response = await fetch('/delete-bots', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        botIds: botIds,
                        authorization: 'PhistarAdmin2025'
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    showAlert(\`✅ \${result.deletedCount} bot(s) deleted successfully\`, 'success');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    showAlert(\`❌ Failed to delete bots: \${result.error}\`, 'error');
                }
            } catch (error) {
                showAlert(\`❌ Error: \${error.message}\`, 'error');
            }
        }

        function showPrefixDelete() {
            switchTab('bulk');
            document.getElementById('prefixToDelete').focus();
        }
    </script>
</body>
</html>
    `;
}

// ==================== ENHANCED ENDPOINTS ====================

app.get('/', (req, res) => {
    const allBots = Array.from(botDatabase.bots.values());
    
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
        totalBots: totalBots,
        onlineBots: onlineBots,
        serverUptime: Math.floor((Date.now() - botDatabase.serverStartTime) / 1000),
        render: IS_RENDER,
        prefixStatistics: prefixStats,
        timestamp: new Date().toISOString(),
        system: 'SIMPLIFIED - No Heartbeat Monitoring'
    });
});

// Web interface for bot management
app.get('/manage', (req, res) => {
    try {
        const html = generateDeletionInterface();
        res.send(html);
    } catch (error) {
        console.error('Error generating management interface:', error);
        res.status(500).send(`
            <html>
                <body>
                    <h1>Error Loading Management Interface</h1>
                    <p>${error.message}</p>
                    <a href="/">Back to Home</a>
                </body>
            </html>
        `);
    }
});

app.get('/ping', (req, res) => {
    res.json({
        status: 'pong',
        server: 'naming-server',
        domain: SHORT_DOMAIN,
        totalBots: botDatabase.bots.size,
        onlineBots: botDatabase.onlineBots.size,
        time: new Date().toISOString()
    });
});

// FIXED get-bot-id endpoint - PROPERLY MARKS BOTS ONLINE
app.post('/get-bot-id', async (req, res) => {
    try {
        const { prefix } = req.body;
        
        if (!prefix) {
            return res.status(400).json({
                success: false,
                error: 'Prefix is required'
            });
        }

        console.log(`🔍 Bot requesting ANY available ID for prefix: ${prefix}`);
        console.log(`📊 Current state - Total bots: ${botDatabase.bots.size}, Online: ${botDatabase.onlineBots.size}`);

        let botId;
        let status;
        const now = Date.now();

        // STEP 1: Find ANY OFFLINE bot with the same prefix
        const offlineBots = Array.from(botDatabase.bots.entries())
            .filter(([id, bot]) => {
                const isOnline = botDatabase.onlineBots.has(id);
                const hasMatchingPrefix = bot.prefix === prefix;
                return hasMatchingPrefix && !isOnline;
            });

        console.log(`🔎 Found ${offlineBots.length} offline bots for prefix "${prefix}"`);

        if (offlineBots.length > 0) {
            // Use the first available offline bot
            const [selectedBotId, selectedBot] = offlineBots[0];
            
            // CRITICAL FIX: Properly mark the bot as online
            const updatedBot = {
                ...selectedBot,
                lastSeen: now,
                status: 'online'
            };
            
            // Update both onlineBots AND the main bots database
            botDatabase.onlineBots.set(selectedBotId, updatedBot);
            botDatabase.bots.set(selectedBotId, updatedBot);
            
            botId = selectedBotId;
            status = 'reused_offline';
            
            console.log(`✅ REACTIVATED offline bot: ${selectedBotId}`);
            console.log(`📝 Bot ${selectedBotId} is now in onlineBots: ${botDatabase.onlineBots.has(selectedBotId)}`);
        }

        // STEP 2: If no offline bots available, create new bot
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

            // Add to both databases
            botDatabase.bots.set(botId, newBot);
            botDatabase.onlineBots.set(botId, newBot);
            status = 'new';
            
            console.log(`🆕 Created NEW bot: ${botId} (no offline bots available for ${prefix})`);
        }

        // Save database immediately
        saveLocalDatabase();
        
        // Verify the bot is actually online
        const isActuallyOnline = botDatabase.onlineBots.has(botId);
        console.log(`✅ Final check - Bot ${botId} is online: ${isActuallyOnline}`);

        res.json({
            success: true,
            botId: botId,
            status: status,
            dropboxFolder: `${botId}_sessions`,
            namingServer: SHORT_DOMAIN,
            isOnline: isActuallyOnline,
            message: `Assigned ${botId} - ${status === 'reused_offline' ? 'Reused offline bot' : 'Created new bot'}`
        });

    } catch (error) {
        console.error('❌ Get Bot ID error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// CORRECTED offline endpoint - ONLY goes offline when explicitly called
app.post('/offline', (req, res) => {
    try {
        const { botId, reason = 'manual_offline' } = req.body;
        
        if (!botId) {
            return res.status(400).json({
                success: false,
                error: 'botId is required'
            });
        }

        if (!botDatabase.bots.has(botId)) {
            return res.status(404).json({
                success: false,
                error: 'Bot not found'
            });
        }

        console.log(`📴 Setting bot ${botId} to offline - Reason: ${reason}`);
        console.log(`📊 Before: Online bots count: ${botDatabase.onlineBots.size}`);

        // ONLY remove from onlineBots when explicitly called
        if (botDatabase.onlineBots.has(botId)) {
            botDatabase.onlineBots.delete(botId);
            console.log(`✅ Bot ${botId} explicitly set to OFFLINE`);
        } else {
            console.log(`ℹ️ Bot ${botId} was already offline`);
        }

        console.log(`📊 After: Online bots count: ${botDatabase.onlineBots.size}`);
        saveLocalDatabase();

        res.json({
            success: true,
            message: `Bot ${botId} set to offline`,
            reason: reason,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Offline endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== DELETION API ENDPOINTS ====================

// Delete single bot
app.post('/delete-bot', (req, res) => {
    try {
        const { botId, authorization } = req.body;
        
        if (!authorization || authorization !== 'PhistarAdmin2025') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        if (!botId) {
            return res.status(400).json({
                success: false,
                error: 'botId is required'
            });
        }

        const result = deleteBot(botId, 'manual_deletion');
        
        if (result.success) {
            res.json({
                success: true,
                message: `Bot ${botId} deleted successfully`,
                deletionInfo: result.deletionInfo
            });
        } else {
            res.status(404).json(result);
        }

    } catch (error) {
        console.error('Delete bot error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete multiple bots
app.post('/delete-bots', (req, res) => {
    try {
        const { botIds, authorization } = req.body;
        
        if (!authorization || authorization !== 'PhistarAdmin2025') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        if (!botIds || !Array.isArray(botIds) || botIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'botIds array is required'
            });
        }

        const result = deleteMultipleBots(botIds, 'bulk_deletion');
        
        res.json({
            success: true,
            message: `Deleted ${result.success.length} bot(s) successfully`,
            deletedCount: result.success.length,
            successful: result.success,
            failed: result.failed
        });

    } catch (error) {
        console.error('Delete bots error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete bots by prefix
app.post('/delete-by-prefix', (req, res) => {
    try {
        const { prefix, authorization } = req.body;
        
        if (!authorization || authorization !== 'PhistarAdmin2025') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        if (!prefix) {
            return res.status(400).json({
                success: false,
                error: 'prefix is required'
            });
        }

        const result = deleteBotsByPrefix(prefix, 'prefix_deletion');
        
        res.json({
            success: true,
            message: `Deleted ${result.success.length} bot(s) with prefix "${prefix}"`,
            deletedCount: result.success.length,
            prefix: prefix,
            successful: result.success,
            failed: result.failed
        });

    } catch (error) {
        console.error('Delete by prefix error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete all offline bots
app.post('/delete-offline-bots', (req, res) => {
    try {
        const { authorization } = req.body;
        
        if (!authorization || authorization !== 'PhistarAdmin2025') {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }

        const offlineBots = Array.from(botDatabase.bots.values())
            .filter(bot => !botDatabase.onlineBots.has(bot.botId))
            .map(bot => bot.botId);

        const result = deleteMultipleBots(offlineBots, 'offline_cleanup');
        
        res.json({
            success: true,
            message: `Deleted ${result.success.length} offline bot(s)`,
            deletedCount: result.success.length,
            successful: result.success,
            failed: result.failed
        });

    } catch (error) {
        console.error('Delete offline bots error:', error);
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
        
        if (!botDatabase.bots.has(botId)) {
            return res.status(404).json({
                success: false,
                error: 'Bot not found'
            });
        }

        const bot = botDatabase.bots.get(botId);
        const isOnline = botDatabase.onlineBots.has(botId);

        res.json({
            success: true,
            botId: botId,
            prefix: bot.prefix,
            status: isOnline ? 'online' : 'offline',
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

// All bots endpoint
app.get('/all-bots', (req, res) => {
    const bots = Array.from(botDatabase.bots.entries()).map(([botId, bot]) => {
        const isOnline = botDatabase.onlineBots.has(botId);
        
        return {
            botId,
            prefix: bot.prefix,
            status: isOnline ? 'online' : 'offline',
            created: bot.created,
            dropboxFolder: bot.dropboxFolder
        };
    });

    res.json({
        success: true,
        totalBots: bots.length,
        online: bots.filter(b => b.status === 'online').length,
        offline: bots.filter(b => b.status === 'offline').length,
        bots: bots
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
    res.json({
        success: true,
        domain: SHORT_DOMAIN,
        totalBots: botDatabase.bots.size,
        onlineBots: botDatabase.onlineBots.size,
        deletedBots: botDatabase.deletedBots.size,
        dropboxEnabled: !!dbx,
        render: IS_RENDER,
        system: 'SIMPLIFIED - No Heartbeat Monitoring'
    });
});

// ==================== SERVER INITIALIZATION ====================

async function initializeServer() {
    console.log('🚀 Initializing Phistar Naming Server with SIMPLIFIED always-online system...');
    
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
    
    // Step 4: Start other services
    startAutoPing();
    startAutoBackup();
    
    console.log(`✅ Server initialized with SIMPLIFIED always-online system`);
}

// ==================== SERVER STARTUP ====================

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Phistar Naming Server running on port ${PORT}`);
    console.log(`🌐 Domain: ${SHORT_DOMAIN}`);
    console.log(`🏠 Render: ${IS_RENDER}`);
    console.log(`🎯 System: SIMPLIFIED - No Heartbeat Monitoring`);
    console.log(`🗑️  Bot Deletion System: Enabled - Visit /manage to manage bots`);
    
    await initializeServer();
    
    console.log(`📊 Database ready: ${botDatabase.bots.size} bots loaded`);
    console.log(`🔗 Online bots: ${botDatabase.onlineBots.size}`);
    console.log(`🗑️  Deleted bots history: ${botDatabase.deletedBots.size}`);
    console.log(`🎯 Auto-backup: Enabled`);
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
