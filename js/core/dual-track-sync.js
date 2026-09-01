/**
 * LicenseOCR - Dual Track Sync Core Module (跨裝置雙軌同步與端對端加密核心)
 * 
 * 核心職責：
 * 1. 軌道 A：WebRTC P2P 端對端毫秒直連 (寬鬆網路 UDP 0.05 秒直傳)
 * 2. 軌道 B：6 位取件碼 + Web Crypto 原生 AES-256-GCM + Cloudflare 閱後即焚中繼 (穿透機關防火牆)
 * 3. 網絡環境自適應探測 (detectNetworkEnvironment)
 * 4. 競態去重仲裁器 (誰先到達即載入誰)
 * 
 * 授權協議：CC BY-NC-SA 4.0 (100% 跨專案通用積木模組)
 */

// 生成防混淆隨機安全取件碼 (排除容易混淆之 0, 1, I, O)
function generatePickupCode(length = 6) {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 安全的分塊 Uint8Array 轉 Base64 (防止大容量圖片資料超出 call stack 大小限制)
function uint8ArrayToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    const CHUNK_SIZE = 0x8000; // 32768
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK_SIZE, len)));
    }
    return btoa(binary);
}

// 安全的 Base64 轉 Uint8Array
function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

// AES-256-GCM 端對端加密 (支援 HTTPS Web Crypto API 與 HTTP 測試環境之 XOR 降級相容)
async function encryptDataWithCode(dataJsonStr, code) {
    // 1. 若處於 Secure Context (HTTPS 或 localhost)，使用標準 AES-GCM
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle && window.crypto.subtle.importKey) {
        try {
            const enc = new TextEncoder();
            const keyMaterial = await window.crypto.subtle.importKey(
                "raw", enc.encode(code.padEnd(32, '0').slice(0, 32)),
                { name: "AES-GCM" }, false, ["encrypt"]
            );
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                keyMaterial,
                enc.encode(dataJsonStr)
            );
            const combined = new Uint8Array(iv.length + encrypted.byteLength);
            combined.set(iv, 0);
            combined.set(new Uint8Array(encrypted), iv.length);
            return uint8ArrayToBase64(combined);
        } catch (e) {
            console.warn('AES-GCM 加密異常，切換至相容加密模式:', e);
        }
    }

    // 2. 降級相容模式 (支援 HTTP 區域 IP 測試環境)
    const utf8Str = encodeURIComponent(dataJsonStr);
    let result = '';
    for (let i = 0; i < utf8Str.length; i++) {
        result += String.fromCharCode(utf8Str.charCodeAt(i) ^ code.charCodeAt(i % code.length));
    }
    return 'fb:' + btoa(result);
}

// AES-256-GCM 端對端解密
async function decryptDataWithCode(cipherB64, code) {
    // 1. 若為純 JS 降級密文
    if (cipherB64.startsWith('fb:')) {
        const raw = atob(cipherB64.slice(3));
        let result = '';
        for (let i = 0; i < raw.length; i++) {
            result += String.fromCharCode(raw.charCodeAt(i) ^ code.charCodeAt(i % code.length));
        }
        return decodeURIComponent(result);
    }

    // 2. 標準 AES-GCM 解密
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle && window.crypto.subtle.importKey) {
        const enc = new TextEncoder();
        const combined = base64ToUint8Array(cipherB64);
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw", enc.encode(code.padEnd(32, '0').slice(0, 32)),
            { name: "AES-GCM" }, false, ["decrypt"]
        );
        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            keyMaterial,
            data
        );
        return new TextDecoder().decode(decrypted);
    }

    throw new Error('當前環境不支援 AES 解密，請使用 HTTPS 或現代瀏覽器開啟。');
}

// 網絡環境與穿透能力探測 (檢測 UDP / STUN 是否受機關防火牆阻斷)
function detectNetworkEnvironment(callback) {
    if (typeof RTCPeerConnection === 'undefined') {
        callback(true);
        return;
    }
    try {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        let hasSrflx = false;
        let isDone = false;

        pc.onicecandidate = (e) => {
            if (e.candidate && (e.candidate.type === 'srflx' || e.candidate.candidate?.includes('srflx'))) {
                hasSrflx = true;
                if (!isDone) {
                    isDone = true;
                    try { pc.close(); } catch(err) {}
                    callback(false); // 寬鬆網路 (UDP 暢通)
                }
            } else if (!e.candidate && !isDone) {
                isDone = true;
                try { pc.close(); } catch(err) {}
                callback(!hasSrflx); // 若無 srflx 候選則判定為受保護網路
            }
        };

        pc.createDataChannel('net_probe');
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {});

        setTimeout(() => {
            if (!isDone) {
                isDone = true;
                try { pc.close(); } catch(err) {}
                callback(!hasSrflx);
            }
        }, 750);
    } catch (e) {
        callback(true);
    }
}

// 主動註銷銷毀取件碼 (Revoke Pickup Code)
async function revokePickupCode(workerUrl, code) {
    if (!code) return false;
    const cleanCode = code.toUpperCase().trim();
    const defaultUrl = 'https://winter-sky-922a.hungpro.workers.dev';
    const endpoint = (workerUrl && workerUrl.trim() ? workerUrl.trim() : (window.state?.workerUrl || defaultUrl)).replace(/\/+$/, '');
    
    // 1. 本地儲存立即清理
    try {
        localStorage.removeItem(`pickup_${cleanCode}`);
    } catch (e) {}

    // 2. 呼叫 Worker 進行物理刪除
    try {
        await fetch(`${endpoint}/api/sync/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: cleanCode })
        });
        return true;
    } catch (err) {
        console.warn('銷毀中繼取件碼失敗:', err);
        return false;
    }
}

// 探測取件碼中繼狀態 (Check Pickup Code Status - 僅探測存不存在，不觸發銷毀)
async function checkPickupCodeStatus(workerUrl, code) {
    if (!code) return { success: false, exists: false };
    const cleanCode = code.toUpperCase().trim();
    const defaultUrl = 'https://winter-sky-922a.hungpro.workers.dev';
    const endpoint = (workerUrl && workerUrl.trim() ? workerUrl.trim() : (window.state?.workerUrl || defaultUrl)).replace(/\/+$/, '');

    try {
        const res = await fetch(`${endpoint}/api/sync/check?code=${cleanCode}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (res.ok) {
            const data = await res.json();
            return { success: true, exists: !!data.exists };
        }
        return { success: false, exists: false };
    } catch (err) {
        return { success: false, exists: false, error: err.message };
    }
}

// 掛載至命名空間與全域
window.DualTrackSync = {
    generatePickupCode,
    encryptDataWithCode,
    decryptDataWithCode,
    detectNetworkEnvironment,
    revokePickupCode,
    checkPickupCodeStatus
};

window.encryptDataWithCode = encryptDataWithCode;
window.decryptDataWithCode = decryptDataWithCode;
window.generatePickupCode = generatePickupCode;
window.detectNetworkEnvironment = detectNetworkEnvironment;
window.revokePickupCode = revokePickupCode;
window.checkPickupCodeStatus = checkPickupCodeStatus;
