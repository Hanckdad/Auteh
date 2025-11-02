class WhatsAppPairing {
    constructor() {
        this.socket = io();
        this.currentSessionId = null;
        this.progressInterval = null;
        this.init();
    }

    init() {
        this.initializeSocket();
        this.initializeForm();
        this.initializeCounter();
    }

    initializeSocket() {
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.updateUIStatus('connected');
        });

        this.socket.on('pairing-result', (data) => {
            this.handlePairingResult(data);
        });

        this.socket.on('disconnect', () => {
            this.updateUIStatus('disconnected');
            this.showResult({
                success: false,
                message: 'Koneksi ke server terputus'
            });
        });
    }

    initializeForm() {
        const form = document.getElementById('pairingForm');
        form.addEventListener('submit', (e) => this.handleSubmit(e));
    }

    initializeCounter() {
        const decreaseBtn = document.getElementById('decreaseCount');
        const increaseBtn = document.getElementById('increaseCount');
        const countInput = document.getElementById('count');

        decreaseBtn.addEventListener('click', () => {
            let value = parseInt(countInput.value);
            if (value > 1) {
                countInput.value = value - 1;
            }
        });

        increaseBtn.addEventListener('click', () => {
            let value = parseInt(countInput.value);
            if (value < 5) {
                countInput.value = value + 1;
            }
        });
    }

    async handleSubmit(e) {
        e.preventDefault();
        
        const phoneNumber = document.getElementById('phoneNumber').value.trim();
        const count = parseInt(document.getElementById('count').value);
        
        if (!this.validateInput(phoneNumber, count)) {
            return;
        }

        this.showLoading();
        this.showProgress();
        
        try {
            const response = await fetch('/api/send-pairing', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    phoneNumber: phoneNumber,
                    count: count
                })
            });

            const result = await response.json();
            
            if (result.success) {
                this.currentSessionId = result.sessionId;
                this.startProgressAnimation();
                this.monitorSession(result.sessionId);
            } else {
                this.showResult(result);
                this.hideLoading();
                this.hideProgress();
            }
            
        } catch (error) {
            this.showResult({
                success: false,
                message: 'Terjadi kesalahan jaringan: ' + error.message
            });
            this.hideLoading();
            this.hideProgress();
        }
    }

    validateInput(phoneNumber, count) {
        const phoneRegex = /^[0-9]{10,15}$/;
        
        if (!phoneRegex.test(phoneNumber)) {
            this.showResult({
                success: false,
                message: 'Format nomor tidak valid. Gunakan 10-15 digit angka (contoh: 6281234567890)'
            });
            return false;
        }

        if (count < 1 || count > 5) {
            this.showResult({
                success: false,
                message: 'Jumlah pengiriman harus antara 1-5'
            });
            return false;
        }

        return true;
    }

    async monitorSession(sessionId) {
        const checkInterval = setInterval(async () => {
            try {
                const response = await fetch(`/api/session/${sessionId}`);
                const status = await response.json();
                
                if (!status.success) {
                    clearInterval(checkInterval);
                    return;
                }

                this.updateSessionInfo(status);
                
            } catch (error) {
                console.error('Error checking session status:', error);
                clearInterval(checkInterval);
            }
        }, 2000);

        // Auto stop setelah 3 menit
        setTimeout(() => {
            clearInterval(checkInterval);
        }, 180000);
    }

    updateSessionInfo(status) {
        const sessionInfo = document.getElementById('sessionInfo');
        const sessionDetails = document.getElementById('sessionDetails');
        
        sessionInfo.style.display = 'block';
        
        let statusText = '';
        switch(status.status) {
            case 'initializing':
                statusText = '🔄 Membuat session...';
                break;
            case 'qr_received':
                statusText = '📱 Menghubungkan ke WhatsApp...';
                break;
            case 'connected':
                statusText = '✅ Terhubung, mengirim pairing code...';
                break;
            case 'completed':
                statusText = '🎉 Pengiriman selesai';
                break;
            default:
                statusText = `📊 ${status.status}`;
        }
        
        sessionDetails.innerHTML = `
            <p><strong>Status:</strong> ${statusText}</p>
            <p><strong>Nomor Tujuan:</strong> ${status.phoneNumber}</p>
            <p><strong>Pesan Terkirim:</strong> ${status.messagesSent || 0}</p>
            ${status.pairingCode ? `<p><strong>Kode Pairing:</strong> <code>${status.pairingCode}</code></p>` : ''}
        `;
    }

    startProgressAnimation() {
        let progress = 0;
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const statusMessage = document.getElementById('statusMessage');
        
        const stages = [
            { percent: 20, text: 'Membuat session...', message: 'Mempersiapkan sistem pengiriman' },
            { percent: 40, text: 'Menghubungkan WhatsApp...', message: 'Membuat koneksi ke WhatsApp' },
            { percent: 70, text: 'Mengirim pairing code...', message: 'Mengirim kode ke nomor tujuan' },
            { percent: 90, text: 'Menyelesaikan...', message: 'Membersihkan session' }
        ];
        
        let currentStage = 0;
        
        this.progressInterval = setInterval(() => {
            if (currentStage < stages.length) {
                const stage = stages[currentStage];
                progress = stage.percent;
                progressFill.style.width = `${progress}%`;
                progressText.textContent = stage.text;
                statusMessage.textContent = stage.message;
                currentStage++;
            }
        }, 3000);
    }

    stopProgressAnimation() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
        const progressFill = document.getElementById('progressFill');
        progressFill.style.width = '100%';
    }

    handlePairingResult(data) {
        this.stopProgressAnimation();
        this.hideLoading();
        
        if (data.success) {
            document.getElementById('progressText').textContent = '✅ Pengiriman Berhasil';
            document.getElementById('statusMessage').textContent = 'Pairing code berhasil dikirim';
        } else {
            document.getElementById('progressText').textContent = '❌ Gagal';
            document.getElementById('statusMessage').textContent = 'Terjadi kesalahan dalam pengiriman';
        }
        
        this.showResult(data);
        
        // Auto hide progress setelah 5 detik
        setTimeout(() => {
            this.hideProgress();
        }, 5000);
    }

    updateUIStatus(status) {
        // Bisa ditambahkan indicator status koneksi jika needed
        console.log('UI Status:', status);
    }

    showProgress() {
        const progressContainer = document.getElementById('progressContainer');
        progressContainer.style.display = 'block';
    }

    hideProgress() {
        const progressContainer = document.getElementById('progressContainer');
        progressContainer.style.display = 'none';
        
        // Reset progress
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const statusMessage = document.getElementById('statusMessage');
        
        progressFill.style.width = '0%';
        progressText.textContent = 'Mempersiapkan sistem...';
        statusMessage.textContent = 'Membuat koneksi WhatsApp...';
    }

    showLoading() {
        const submitBtn = document.getElementById('submitBtn');
        const buttonText = submitBtn.querySelector('.button-text');
        const buttonLoader = submitBtn.querySelector('.button-loader');
        
        buttonText.style.display = 'none';
        buttonLoader.style.display = 'flex';
        submitBtn.disabled = true;
    }

    hideLoading() {
        const submitBtn = document.getElementById('submitBtn');
        const buttonText = submitBtn.querySelector('.button-text');
        const buttonLoader = submitBtn.querySelector('.button-loader');
        
        buttonText.style.display = 'block';
        buttonLoader.style.display = 'none';
        submitBtn.disabled = false;
    }

    showResult(result) {
        const resultElement = document.getElementById('result');
        resultElement.className = 'result';
        resultElement.style.display = 'block';
        
        if (result.success) {
            resultElement.classList.add('success');
            
            let html = `
                <p><strong>✅ ${result.message}</strong></p>
                ${result.pairingCode ? `<p><strong>Kode Pairing:</strong> <code style="font-size: 1.2em; background: #d4edda; padding: 5px 10px; border-radius: 5px;">${result.pairingCode}</code></p>` : ''}
            `;
            
            if (result.results) {
                html += `<div style="margin-top: 15px; border-top: 1px solid rgba(0,0,0,0.1); padding-top: 10px;">`;
                result.results.forEach(item => {
                    const icon = item.success ? '✅' : '❌';
                    html += `<div class="result-item">${icon} Percobaan ${item.attempt}: ${item.message}</div>`;
                });
                html += `</div>`;
            }
            
            html += `<p style="margin-top: 15px; font-size: 0.9em; opacity: 0.8;"><small>Session akan otomatis terhapus dalam 30 detik</small></p>`;
            
            resultElement.innerHTML = html;
        } else {
            resultElement.classList.add('error');
            resultElement.innerHTML = `
                <p><strong>❌ ${result.message}</strong></p>
                <p style="margin-top: 10px; font-size: 0.9em;">Silakan coba lagi atau periksa nomor tujuan.</p>
            `;
        }
        
        resultElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Initialize application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new WhatsAppPairing();
    
    // Add some interactive effects
    const inputs = document.querySelectorAll('input');
    inputs.forEach(input => {
        input.addEventListener('focus', () => {
            input.parentElement.style.transform = 'translateY(-2px)';
        });
        
        input.addEventListener('blur', () => {
            input.parentElement.style.transform = 'translateY(0)';
        });
    });
});
