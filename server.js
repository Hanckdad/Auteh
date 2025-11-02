require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const path = require('path');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs-extra');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// Ensure temp-sessions directory exists
const tempSessionsDir = './temp-sessions';
fs.ensureDirSync(tempSessionsDir);

// Store active sessions
const activeSessions = new Map();

// Cleanup function untuk session lama
function cleanupOldSessions() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    activeSessions.forEach((session, sessionId) => {
        if (session.createdAt < oneHourAgo) {
            console.log(`Cleaning up old session: ${sessionId}`);
            cleanupSession(sessionId);
        }
    });
}

// Cleanup individual session
async function cleanupSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        try {
            if (session.sock) {
                await session.sock.logout();
                session.sock.ws.close();
            }
        } catch (error) {
            console.log(`Error cleaning up session ${sessionId}:`, error.message);
        }
        
        // Delete session files
        try {
            await fs.remove(`./temp-sessions/${sessionId}`);
        } catch (error) {
            console.log(`Error deleting session files ${sessionId}:`, error.message);
        }
        
        activeSessions.delete(sessionId);
    }
}

// API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/send-pairing', async (req, res) => {
    const { phoneNumber, count = 1 } = req.body;
    
    console.log(`Received request: ${phoneNumber}, count: ${count}`);
    
    if (!phoneNumber) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nomor WhatsApp harus diisi' 
        });
    }

    // Validasi nomor
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNumber.length < 10 || cleanNumber.length > 15) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nomor harus 10-15 digit angka' 
        });
    }

    if (count < 1 || count > 5) {
        return res.status(400).json({ 
            success: false, 
            message: 'Jumlah pengiriman harus 1-5' 
        });
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    try {
        // Setup session directory
        const sessionDir = path.join(tempSessionsDir, sessionId);
        await fs.ensureDir(sessionDir);
        
        // Initialize WhatsApp connection
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: {
                level: 'silent'
            },
            browser: ['WhatsApp Pairing', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        let pairingCode = generatePairingCode();
        let connectionTimeout;
        let isCompleted = false;

        const sessionData = {
            sock,
            phoneNumber: cleanNumber,
            count,
            pairingCode,
            status: 'initializing',
            createdAt: Date.now(),
            messagesSent: 0
        };

        activeSessions.set(sessionId, sessionData);

        // Handle connection events
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, isNewLogin, lastDisconnect } = update;
            
            console.log(`Session ${sessionId} connection update:`, connection);
            
            if (qr && !isCompleted) {
                sessionData.status = 'qr_received';
                console.log(`QR received for session ${sessionId}`);
                
                // Set timeout untuk connection
                connectionTimeout = setTimeout(async () => {
                    if (!isCompleted) {
                        console.log(`Connection timeout for session ${sessionId}`);
                        io.emit('pairing-result', {
                            sessionId,
                            success: false,
                            message: 'Timeout: Gagal terhubung ke WhatsApp'
                        });
                        await cleanupSession(sessionId);
                    }
                }, 120000); // 2 menit timeout
            }

            if (connection === 'open') {
                console.log(`WhatsApp connected for session ${sessionId}`);
                sessionData.status = 'connected';
                clearTimeout(connectionTimeout);
                
                try {
                    // Kirim pairing code
                    const formattedNumber = `${cleanNumber}@s.whatsapp.net`;
                    const results = [];
                    
                    for (let i = 0; i < count; i++) {
                        try {
                            await sock.sendMessage(formattedNumber, {
                                text: `🔐 *KODE PAIRING WHATSAPP*\n\nKode Pairing Anda: *${pairingCode}*\n\nGunakan kode ini untuk menghubungkan perangkat baru ke akun WhatsApp Anda.\n\n⏰ Kode berlaku 10 menit\n🔒 Jangan bagikan kode ini kepada siapapun!\n\nJika tidak meminta kode ini, abaikan pesan ini.`
                            });
                            
                            sessionData.messagesSent++;
                            results.push({
                                attempt: i + 1,
                                success: true,
                                message: `Pairing code berhasil dikirim`
                            });
                            
                            console.log(`Pairing code sent to ${cleanNumber} (${i + 1}/${count})`);
                            
                            // Delay antara pengiriman
                            if (i < count - 1) {
                                await delay(3000);
                            }
                            
                        } catch (error) {
                            results.push({
                                attempt: i + 1,
                                success: false,
                                message: `Gagal mengirim: ${error.message}`
                            });
                            console.error(`Error sending message ${i + 1}:`, error);
                        }
                    }
                    
                    isCompleted = true;
                    sessionData.status = 'completed';
                    
                    // Kirim hasil ke client
                    io.emit('pairing-result', {
                        sessionId,
                        success: true,
                        pairingCode: pairingCode,
                        message: `Berhasil mengirim ${sessionData.messagesSent} dari ${count} pairing code ke ${cleanNumber}`,
                        results: results
                    });
                    
                    console.log(`Session ${sessionId} completed successfully`);
                    
                    // Cleanup setelah 30 detik
                    setTimeout(() => cleanupSession(sessionId), 30000);
                    
                } catch (error) {
                    console.error(`Error in session ${sessionId}:`, error);
                    io.emit('pairing-result', {
                        sessionId,
                        success: false,
                        message: `Error: ${error.message}`
                    });
                    await cleanupSession(sessionId);
                }
            }

            if (connection === 'close') {
                console.log(`Connection closed for session ${sessionId}`);
                if (!isCompleted) {
                    io.emit('pairing-result', {
                        sessionId,
                        success: false,
                        message: 'Koneksi terputus sebelum pengiriman selesai'
                    });
                    await cleanupSession(sessionId);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        res.json({
            success: true,
            sessionId,
            message: 'Memulai proses pengiriman pairing code...',
            pairingCode: pairingCode
        });

    } catch (error) {
        console.error('Error creating session:', error);
        await cleanupSession(sessionId);
        res.status(500).json({
            success: false,
            message: `Gagal memulai session: ${error.message}`
        });
    }
});

// API untuk cek status session
app.get('/api/session/:sessionId', (req, res) => {
    const session = activeSessions.get(req.params.sessionId);
    if (session) {
        res.json({
            success: true,
            status: session.status,
            phoneNumber: session.phoneNumber,
            messagesSent: session.messagesSent,
            pairingCode: session.pairingCode
        });
    } else {
        res.json({
            success: false,
            status: 'not_found'
        });
    }
});

// Generate random pairing code
function generatePairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Cleanup interval (setiap 5 menit)
setInterval(cleanupOldSessions, 5 * 60 * 1000);

// Socket.io for real-time updates
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    // Cleanup all sessions
    for (const sessionId of activeSessions.keys()) {
        await cleanupSession(sessionId);
    }
    
    process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Buka http://localhost:${PORT} di browser`);
    console.log(`🗑️ Auto-cleanup session aktif`);
});
