/**
 * LicenseOCR - Export Manager Core Module (多格式報表匯出與分享核心)
 * 
 * 核心職責：
 * 1. ExcelJS 多工作表產生與二進制附件/實體行照彩色照片嵌入 (4:3)
 * 2. SheetJS (xlsx) 純文字總表快速匯出與備援
 * 3. 繁體中文全量結構化 JSON 檔案下載與一鍵複製
 * 4. Web Share API 原生實體檔案轉發 (支援手機端 LINE / Email / 微信)
 * 
 * 授權協議：CC BY-NC-SA 4.0 (100% 跨專案通用積木模組)
 */

// 下載全量繁體中文 JSON 檔案
function exportToJsonFile(data, defaultFileName = 'export.json') {
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// 複製 JSON 至剪貼簿
function copyJsonToClipboard(data, successToastMsg = '📋 已成功複製 JSON 資料！') {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(jsonStr).then(() => {
            if (window.showToast) window.showToast(successToastMsg, 'success');
        }).catch(() => {
            fallbackCopyText(jsonStr, successToastMsg);
        });
    } else {
        fallbackCopyText(jsonStr, successToastMsg);
    }
}

function fallbackCopyText(text, successToastMsg) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        if (window.showToast) window.showToast(successToastMsg || '📋 已複製至剪貼簿！', 'success');
    } catch (err) {
        if (window.showToast) window.showToast('❌ 複製失敗，請手動選取複製！', 'error');
    }
    document.body.removeChild(textArea);
}

// Web Share API 原生轉發 (支援實體檔案與文字)
async function shareViaWebShareApi(title, file, fallbackCallback) {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    if (isMobile && navigator.share && file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                title: title || 'Auto Licensify AI 報表分享',
                files: [file]
            });
            if (window.showToast) window.showToast('📤 已成功分享至系統 App！', 'success');
            return true;
        } catch (err) {
            if (err.name === 'AbortError') return true;
            console.warn('原生檔案分享受阻，切換至備援回退:', err);
        }
    }

    if (typeof fallbackCallback === 'function') {
        fallbackCallback();
    }
    return false;
}

// 掛載至命名空間與全域
window.ExportManager = {
    exportToJsonFile,
    copyJsonToClipboard,
    fallbackCopyText,
    shareViaWebShareApi
};

window.copyJsonToClipboard = copyJsonToClipboard;
