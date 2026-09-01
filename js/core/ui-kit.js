/**
 * LicenseOCR - UI Kit Core Module (通用使用者介面核心套件)
 * 
 * 核心職責：
 * 1. 3 套精選介面風格循環切換 (大地紙感 terracotta / 經典明亮 classic / 極簡直角 bauhaus)
 * 2. 全域頂層毛玻璃 Toast 提示通知元件
 * 3. 診斷日誌 Panel 控制與 DevTools 同步
 * 4. 響應式 Popover (操作指引 / 日誌版權) 抽屜開關控制
 * 
 * 授權協議：CC BY-NC-SA 4.0 (100% 跨專案通用積木模組)
 */

// 3 套精選主題循環清單
const THEME_CYCLE = ['terracotta', 'classic', 'bauhaus'];

// 取得當前主題
function getCurrentTheme() {
    return localStorage.getItem('license_ocr_theme') || 'terracotta';
}

// 套用指定主題
function applyTheme(theme) {
    if (!THEME_CYCLE.includes(theme)) theme = 'terracotta';
    if (window.state) window.state.theme = theme;

    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('themeIcon');
    const text = document.getElementById('themeText');
    const btn = document.getElementById('themeBtn');

    if (icon && text && btn) {
        icon.style.color = '';
        if (theme === 'terracotta') {
            icon.className = 'fa-solid fa-leaf square-btn-icon';
            icon.style.color = '#ea580c';
            text.textContent = '大地紙感';
            btn.setAttribute('title', '目前為「大地紙感」風格，點擊切換為「經典明亮」');
        } else if (theme === 'classic') {
            icon.className = 'fa-solid fa-sun text-warning square-btn-icon';
            text.textContent = '經典明亮';
            btn.setAttribute('title', '目前為「經典明亮」風格，點擊切換為「極簡直角」');
        } else if (theme === 'bauhaus') {
            icon.className = 'fa-solid fa-vector-square text-primary square-btn-icon';
            text.textContent = '極簡直角';
            btn.setAttribute('title', '目前為「極簡直角」風格，點擊切換為「大地紙感」');
        }
    }
}

// 循環切換下一個主題
function toggleTheme() {
    const curTheme = getCurrentTheme();
    const curIdx = THEME_CYCLE.indexOf(curTheme);
    const nextIdx = (curIdx + 1) % THEME_CYCLE.length;
    const nextTheme = THEME_CYCLE[nextIdx];
    applyTheme(nextTheme);
    localStorage.setItem('license_ocr_theme', nextTheme);

    const toastMap = {
        terracotta: '🍂 已切換至「大地紙感（暖色系）」風格',
        classic: '☀️ 已切換至「經典明亮」風格',
        bauhaus: '📐 已切換至「極簡直角（包浩斯）」風格'
    };
    showToast(toastMap[nextTheme] || '🎨 已切換介面風格', 'info');
}

// 全局極簡 Toast 提示通知元件
function showToast(msg, type = 'info', duration = 4000) {
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toastText');
    const toastIcon = document.getElementById('toastIcon');
    if (!toast || !toastText) return;

    toastText.textContent = msg;
    if (type === 'success') {
        toastIcon.className = 'fa-solid fa-circle-check text-success';
    } else if (type === 'error') {
        toastIcon.className = 'fa-solid fa-circle-xmark text-danger';
    } else if (type === 'warning') {
        toastIcon.className = 'fa-solid fa-triangle-exclamation text-warning';
    } else {
        toastIcon.className = 'fa-solid fa-circle-info text-primary';
    }

    toast.classList.add('show');
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// 全局即時診斷日誌輸出 (同步輸出於日誌面版與 DevTools Console)
function addDebugLog(message, type = 'info') {
    const timeStr = new Date().toTimeString().split(' ')[0];
    console.log(`[${timeStr}] [${type.toUpperCase()}] ${message}`);
    const logBody = document.getElementById('debugLogBody');
    if (!logBody) return;
    
    // 超過 300 筆時移除最舊的日誌
    while (logBody.children.length >= 300) {
        logBody.removeChild(logBody.firstChild);
    }

    const item = document.createElement('div');
    const safeType = (type === 'warning') ? 'warn' : type;
    item.className = `debug-log-item ${safeType}`;
    item.textContent = `[${timeStr}] ${message}`;
    logBody.appendChild(item);
    logBody.scrollTop = logBody.scrollHeight;
}

// 清空即時執行日誌
function clearDebugLog(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const logBody = document.getElementById('debugLogBody');
    if (logBody) {
        logBody.innerHTML = '<div class="debug-log-item info">⚡ 日誌已清空，準備接收新記錄...</div>';
    }
    showToast('🧹 已清空即時執行日誌', 'info');
}

// 複製全部執行日誌
function copyDebugLog(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const logBody = document.getElementById('debugLogBody');
    if (!logBody) return;
    const text = Array.from(logBody.querySelectorAll('.debug-log-item')).map(el => el.textContent).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('📋 已複製全部執行日誌至剪貼簿！', 'success');
        }).catch(() => {
            showToast('❌ 複製失敗', 'error');
        });
    }
}

// Popover 控制邏輯 (操作指引 & 系統日誌)
function toggleGuidePopover(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const gContainer = document.getElementById('guidePopoverContainer');
    if (gContainer) {
        gContainer.classList.remove('force-closed');
        gContainer.classList.toggle('active');
    }
}

function closeGuidePopover(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const container = document.getElementById('guidePopoverContainer');
    if (container) {
        container.classList.remove('active');
        container.classList.add('force-closed');
    }
}

function toggleLogPopover(e) {
    if (typeof window.fetchLiveStats === 'function') window.fetchLiveStats();
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const lContainer = document.getElementById('logPopoverContainer');
    if (lContainer) {
        lContainer.classList.remove('force-closed');
        lContainer.classList.toggle('active');
    }
}

function closeLogPopover(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const container = document.getElementById('logPopoverContainer');
    if (container) {
        container.classList.remove('active');
        container.classList.add('force-closed');
    }
}

function openPrivacyInfo() {
    const container = document.getElementById('guidePopoverContainer');
    if (container) {
        container.classList.add('active');
    }
}

// 全域監聽外部點擊關閉 Popover
document.addEventListener('click', (e) => {
    const gContainer = document.getElementById('guidePopoverContainer');
    if (gContainer && gContainer.classList.contains('active')) {
        if (!gContainer.contains(e.target)) gContainer.classList.remove('active');
    }
    const lContainer = document.getElementById('logPopoverContainer');
    if (lContainer && lContainer.classList.contains('active')) {
        if (!lContainer.contains(e.target)) lContainer.classList.remove('active');
    }
});

// 掛載至命名空間與全域
window.UiKit = {
    THEME_CYCLE,
    getCurrentTheme,
    applyTheme,
    toggleTheme,
    showToast,
    addDebugLog,
    clearDebugLog,
    copyDebugLog,
    toggleGuidePopover,
    closeGuidePopover,
    toggleLogPopover,
    closeLogPopover,
    openPrivacyInfo
};

window.applyTheme = applyTheme;
window.toggleTheme = toggleTheme;
window.showToast = showToast;
window.addDebugLog = addDebugLog;
window.clearDebugLog = clearDebugLog;
window.copyDebugLog = copyDebugLog;
window.toggleGuidePopover = toggleGuidePopover;
window.closeGuidePopover = closeGuidePopover;
window.toggleLogPopover = toggleLogPopover;
window.closeLogPopover = closeLogPopover;
window.openPrivacyInfo = openPrivacyInfo;
