/**
 * Auto Licensify AI (TW) - Application Controller (主應用控制器)
 * 
 * 核心職責：
 * 1. 響應式 UI 狀態管理 (State Management)
 * 2. 檔案拖放、PDF 智慧拆解與剪貼簿貼上事件調度
 * 3. 縮圖卡片平移縮放、旋轉與 800x600 裁切工作流
 * 4. 串接各通用核心 (Core) 與領域插件 (Plugins) 執行 AI 辨識、報表匯出與跨端同步
 * 
 * 授權協議：CC BY-NC-SA 4.0
 */

// 設定 PDF.js worker
if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// 系統預設 Worker 代理端點常數
const DEFAULT_WORKER_URL = 'https://winter-sky-922a.hungpro.workers.dev';
const MAX_QUEUE_LIMIT = 10;

// 全域狀態管理
const state = {
    queue: [], // { id, file, base64, mimeType, fileName, status, result, errorMsg, elapsedTime, scale, panX, panY, rotation, isCropped, hasManualCropped, needsMandatoryCrop }
    isBatchRunning: false,
    abortBatch: false,
    theme: localStorage.getItem('license_ocr_theme') || 'terracotta',
    providerType: localStorage.getItem('license_provider_type') || 'default', // 'default' | 'gemini' | 'openai'
    workerUrl: localStorage.getItem('license_ocr_worker_url') || '',
    apiKey: localStorage.getItem('license_ocr_api_key') || '',
    model: 'gemini-3.6-flash',
    openaiBaseUrl: localStorage.getItem('license_openai_base_url') || 'http://localhost:11434/v1',
    openaiApiKey: localStorage.getItem('license_openai_api_key') || '',
    openaiModel: localStorage.getItem('license_openai_model') || 'llama3.2-vision:11b',
    openaiCustomPrompt: '',
    currentPage: 1,
    pageSize: 10
};
window.state = state;

// 全域配對變數
let activePairChannel = null;
let activePeerSessionId = null;
let receiverPeerInstance = null;
let pairingPollingTimer = null;
let pairingCountdownTimer = null;
let pairingRemainingSeconds = 300;
let inPageQrScannerInstance = null;
let isExcelImporting = false;

// 系統標準 Prompt
const SYSTEM_PROMPT = `你是一位精通台灣車輛監理法規與車籍資料審查的專業 AI。
請仔細分析所附的影像內容，並嚴格遵循以下兩階段規則，輸出指定格式之 JSON：

【第一階段：文件真偽、單一性與清晰度檢驗 (Gatekeeper)】
在提取任何車籍資料前，必須先嚴格審查影像內容：
1. ✅【合法放行標準 (is_valid_license: true)】：
   - 本體必須是「中華民國交通部制式行車執照」。
   - 行照實體在整個 800×600 可視畫面中的面積佔比必須 ≧ 60%，且牌照號碼等核心字元清晰可辨。
   - 寬容手持拍攝、桌面背景、護套反光與正常旋轉傾斜。
2. ❌【強制拒絕情境 (is_valid_license: false)】：
   - 情境 A（非行照）：上傳車體外觀照片、身分證、駕照、發票等 ➔ rejection_reason: "上傳影像研判並非行照文件，請上傳正式行車執照！"
   - 情境 B（多張行照）：畫面包含 2 張（含）以上行照 ➔ rejection_reason: "偵測到畫面中包含多張行照，請裁切為單張後分別上傳！"
   - 情境 C（佔比過小）：行照佔比小於 60% ➔ rejection_reason: "偵測到畫面包含大面積非行照文件或多餘空白，請利用滾輪與拖曳將行照放大填滿畫面後再確認辨識！"
   - 情境 D（極度模糊完全無法辨認） ➔ rejection_reason: "影像極度模糊無法辨識車籍內容，請重新拍攝！"
3. 🛑 若 is_valid_license 為 false，所有車籍欄位一律填空字串 "" 或 0。

【第二階段：車籍關鍵欄位萃取與智慧分流規則】
1. 牌照號碼 (plate_number)：精確辨識英數字與橫線（如: 297-TS, 9190-QY）。
2. 車輛種類 (vehicle_type)：去除自用/公務前綴，標準化為小客車、小貨車、小客貨、大客車、大貨車、曳引車等。
3. 特殊車種 (special_type)：特種車名稱（高空作業車、工程救險車、消防車、救護車等）。
4. 車身式樣 (body_style) 與 附加配備 (extra_equipment) 嚴格斷詞分流。
5. 服務公司或承租人 (lessee)：僅保留租賃公司或使用機關名稱。
6. 載運人數：細分為座 (capacity_sit)、立 (capacity_stand)、駕駛室 (capacity_driver)。
7. 重量規格：載重 (load_weight) 與總重 (total_weight) 轉換為純公噸數值。
8. 排氣量 (displacement)：純整數數值。
9. 監理日期：原發照與換補照日期，統一輸出西元 YYYY/MM/DD 標準格式。
10. 若某欄位為空白，填入空字串 "" 或 0。`;

// ==========================================
// 1. 初始化與輸入監聽 (Drag & Drop, Paste, Input)
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    applyTheme(state.theme);
    if (state.workerUrl === DEFAULT_WORKER_URL) {
        state.workerUrl = '';
        localStorage.removeItem('license_ocr_worker_url');
    }
    if (document.getElementById('workerUrlInput')) document.getElementById('workerUrlInput').value = state.workerUrl || '';
    if (document.getElementById('customApiKeyInput')) document.getElementById('customApiKeyInput').value = state.apiKey || '';
    if (document.getElementById('promptPreviewBox')) document.getElementById('promptPreviewBox').textContent = SYSTEM_PROMPT;

    setupDragAndDrop();
    setupClipboardPaste();
    updateQueueUI();
    fetchLiveStats();

    // 檢查 URL 參數
    const urlParams = new URLSearchParams(window.location.search);
    const pickupParam = urlParams.get('pickup');
    const pairParam = urlParams.get('peer') || urlParams.get('pair');

    if (pickupParam) {
        openReceiveModal();
        switchReceiveMode('pickup');
        const input = document.getElementById('inputPickupCode');
        if (input) input.value = pickupParam.toUpperCase();
        fetchResultsByPickupCode();
    } else if (pairParam) {
        activePairChannel = pairParam;
        sessionStorage.setItem('active_pair_channel', pairParam);
        sessionStorage.setItem('pair_timestamp', Date.now().toString());
        addDebugLog(`📱 已成功綁定接收端配對節點【${pairParam}】！`, 'success');

        if (window.history && window.history.replaceState) {
            const cleanUrl = window.location.pathname + window.location.hash;
            window.history.replaceState({}, document.title, cleanUrl);
        }

        const successItems = state.queue.filter(x => x.status === 'success' && x.result);
        if (successItems.length > 0) {
            sendCurrentResultsToPairSession(pairParam);
        } else {
            showToast('📱 已與接收端配對連線！完成辨識將自動傳送！(有效期限 10 分鐘)', 'info', 5000);
            switchMobileTab('queue');
        }
    } else {
        const savedPair = sessionStorage.getItem('active_pair_channel');
        const savedTime = parseInt(sessionStorage.getItem('pair_timestamp') || '0', 10);
        if (savedPair && (Date.now() - savedTime < 10 * 60 * 1000)) {
            activePairChannel = savedPair;
        } else {
            sessionStorage.removeItem('active_pair_channel');
            sessionStorage.removeItem('pair_timestamp');
        }
    }
});

// 支援鍵盤 Ctrl+V 貼上
function setupClipboardPaste() {
    window.addEventListener('paste', (e) => {
        const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
        if (!items) return;
        const files = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type && items[i].type.indexOf('image') !== -1) {
                const blob = items[i].getAsFile();
                if (blob) {
                    const ext = blob.type.split('/')[1] || 'png';
                    const file = new File([blob], `剪貼簿截圖_${Date.now()}.${ext}`, { type: blob.type });
                    files.push(file);
                }
            }
        }
        if (files.length > 0) handleIncomingFiles(files);
    });
}

// 支援拖曳上傳
function setupDragAndDrop() {
    const leftCard = document.getElementById('leftWorkspaceCard');
    const dropzone = document.getElementById('dropzone');
    const miniDropzone = document.getElementById('miniDropzone');

    window.addEventListener('dragenter', (e) => { e.preventDefault(); }, false);
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }, false);
    window.addEventListener('dragleave', (e) => { e.preventDefault(); }, false);
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = e.dataTransfer ? e.dataTransfer.files : null;
        if (files && files.length > 0) handleIncomingFiles(files);
    }, false);

    if (leftCard) {
        leftCard.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            leftCard.classList.add('left-card-drag-active');
            if (miniDropzone) miniDropzone.style.borderColor = 'var(--brand-primary)';
        }, false);

        leftCard.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!leftCard.contains(e.relatedTarget)) {
                leftCard.classList.remove('left-card-drag-active');
                if (miniDropzone) miniDropzone.style.borderColor = 'var(--border-strong)';
            }
        }, false);

        leftCard.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            leftCard.classList.remove('left-card-drag-active');
            if (miniDropzone) miniDropzone.style.borderColor = 'var(--border-strong)';
            if (dropzone) dropzone.classList.remove('dragover');
            const files = e.dataTransfer ? e.dataTransfer.files : null;
            if (files && files.length > 0) handleIncomingFiles(files);
        }, false);
    }
}

function handleFileSelected(event) {
    const files = event?.target?.files;
    if (files && files.length > 0) {
        handleIncomingFiles(files);
    }
    if (event?.target) {
        event.target.value = '';
    }
}

async function handleIncomingFiles(fileList) {
    if (state.isBatchRunning) {
        showToast('⏳ 批次處理進行中，請等待完成後再新增！', 'info');
        return;
    }

    const files = Array.from(fileList);
    let addedCount = 0;
    addDebugLog(`📂 收到 ${files.length} 個檔案，正在進行格式解析與前置畫質檢驗...`, 'info');

    for (const file of files) {
        if (state.queue.length >= MAX_QUEUE_LIMIT) {
            addDebugLog(`⚠️ 佇列已達上限 (${MAX_QUEUE_LIMIT} 筆)，其餘檔案已略過`, 'warn');
            showToast(`⚠️ 已達批次上限 (${MAX_QUEUE_LIMIT} 筆)，略過其餘檔案！`, 'info');
            break;
        }

        const fileNameLower = (file.name || '').toLowerCase();
        const isExcel = fileNameLower.endsWith('.xlsx') || fileNameLower.endsWith('.xls') || file.type.includes('spreadsheet') || file.type.includes('excel');
        const isPdf = file.type === 'application/pdf' || fileNameLower.endsWith('.pdf');
        const isImg = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|bmp|gif|tif|tiff)$/i.test(fileNameLower);

        if (isExcel) {
            addDebugLog(`📥 偵測到 Excel 報表【${file.name}】，啟動資料還原解析...`, 'info');
            await parseAndImportExcelFile(file);
            return;
        } else if (isPdf) {
            addDebugLog(`📄 偵測到 PDF 文件【${file.name}】，啟動 2.0x 高解析母體拆頁渲染...`, 'info');
            await extractPdfPages(file);
            addedCount++;
        } else if (isImg) {
            await processSingleFile(file, file.name || `行照影像_${Date.now()}.jpg`);
            addedCount++;
        } else if (file.size > 0) {
            await processSingleFile(file, file.name || `檔案_${Date.now()}.jpg`);
            addedCount++;
        }
    }

    updateQueueUI();
    if (addedCount > 0) {
        addDebugLog(`✅ 成功載入 ${addedCount} 個項目至待處理佇列 (當前共 ${state.queue.length} 筆)`, 'success');
        showToast(`📥 成功載入 ${addedCount} 個檔案至清單！`, 'success');
    }
}

function processSingleFile(file, fileName) {
    return new Promise((resolve) => {
        if (state.queue.length >= MAX_QUEUE_LIMIT) {
            resolve();
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            const rawDataUrl = e.target.result;
            const img = new Image();
            img.onload = () => {
                const qualityCheck = CvAnalyzer.analyzeImageQuality(img, file);

                const TARGET_W = 800;
                const TARGET_H = 600;
                const isOver800 = img.width > 800 || img.height > 800;

                const scale = Math.min(TARGET_W / img.width, TARGET_H / img.height);
                const drawW = Math.round(img.width * scale);
                const drawH = Math.round(img.height * scale);
                const offsetX = Math.round((TARGET_W - drawW) / 2);
                const offsetY = Math.round((TARGET_H - drawH) / 2);

                const canvas = document.createElement('canvas');
                canvas.width = TARGET_W;
                canvas.height = TARGET_H;
                const ctx = canvas.getContext('2d');

                ctx.fillStyle = '#0f172a';
                ctx.fillRect(0, 0, TARGET_W, TARGET_H);
                ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

                const containDataUrl = canvas.toDataURL('image/jpeg', 0.92);
                const base64 = containDataUrl.split(',')[1];
                const itemId = 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);

                const initialStatus = qualityCheck.isValid ? 'idle' : 'rejected';
                const initialRejection = qualityCheck.isValid ? '' : qualityCheck.reason;

                state.queue.push({
                    id: itemId,
                    file: file,
                    fileName: fileName,
                    rawImg: img,
                    rawImgW: img.width,
                    rawImgH: img.height,
                    rawDataUrl: rawDataUrl,
                    dataUrl: containDataUrl,
                    base64: base64,
                    mimeType: 'image/jpeg',
                    status: initialStatus,
                    result: null,
                    errorMsg: '',
                    rejectionReason: initialRejection,
                    elapsedTime: 0,
                    scale: 1.0,
                    panX: 0,
                    panY: 0,
                    rotation: 0,
                    isCropped: !isOver800,
                    hasManualCropped: false,
                    needsMandatoryCrop: isOver800
                });

                updateQueueUI();
                resolve();
            };
            img.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
    });
}

async function extractPdfPages(pdfFile) {
    if (!window.pdfjsLib) {
        showToast('⚠️ PDF.js 解析組件尚未載入完成，請稍候重試！', 'error');
        return;
    }
    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        if (state.queue.length >= MAX_QUEUE_LIMIT) {
            showToast(`⚠️ 已達佇列上限 (${MAX_QUEUE_LIMIT} 筆)，PDF 剩餘頁數已略過！`, 'info');
            break;
        }
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        const blob = await (await fetch(dataUrl)).blob();
        const pageFile = new File([blob], `${pdfFile.name.replace(/\.pdf$/i, '')}_第${pageNum}頁.jpg`, { type: 'image/jpeg' });
        await processSingleFile(pageFile, pageFile.name);
    }
}

function removeQueueItem(id) {
    state.queue = state.queue.filter(x => x.id !== id);
    updateQueueUI();
}

function clearQueue() {
    state.queue = [];
    updateQueueUI();
    showToast('已清空所有行照清單', 'info');
}

// ==========================================
// 2. UI 渲染與卡片手勢控制 (含 4:3 裁切導引、全域手勢鎖定、手機防卡住與分頁)
// ==========================================
function updateQueueUI() {
    const count = state.queue.length;
    const queueCountEl = document.getElementById('queueCount');
    if (queueCountEl) queueCountEl.textContent = count;

    const remainEl = document.getElementById('queueRemainCount');
    if (remainEl) remainEl.textContent = Math.max(0, MAX_QUEUE_LIMIT - count);

    const dropzone = document.getElementById('dropzone');
    const queueList = document.getElementById('queueListContainer');
    const miniDropzone = document.getElementById('miniDropzone');
    const emptyPlaceholder = document.getElementById('emptyPlaceholder');
    const cardsView = document.getElementById('cardsView');

    const successCount = state.queue.filter(x => x.status === 'success').length;
    const mobileQueueCount = document.getElementById('mobileQueueCount');
    const mobileResultCount = document.getElementById('mobileResultCount');
    const bottomQueueCount = document.getElementById('bottomQueueCount');
    if (bottomQueueCount) bottomQueueCount.textContent = count;
    if (mobileQueueCount) mobileQueueCount.textContent = count;
    if (mobileResultCount) mobileResultCount.textContent = successCount;
    updateBottomActionBar(count, successCount);

    if (count === 0) {
        if (dropzone) dropzone.style.display = 'flex';
        if (queueList) queueList.style.display = 'none';
        if (miniDropzone) miniDropzone.style.display = 'none';
        if (emptyPlaceholder) emptyPlaceholder.style.display = 'flex';
        if (cardsView) cardsView.style.display = 'none';
        return;
    }

    if (dropzone) dropzone.style.display = 'none';
    if (queueList) queueList.style.display = 'flex';
    if (miniDropzone) miniDropzone.style.display = (count < MAX_QUEUE_LIMIT && !state.isBatchRunning) ? 'flex' : 'none';

    emptyPlaceholder.style.display = 'none';
    cardsView.style.display = 'flex';

    queueList.innerHTML = '';

    // 分頁計算
    state.pageSize = state.pageSize || 10;
    const totalPages = Math.ceil(count / state.pageSize) || 1;
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;

    const startIndex = (state.currentPage - 1) * state.pageSize;
    const pageItems = state.queue.slice(startIndex, startIndex + state.pageSize);

    if (count > state.pageSize) {
        const paginationBar = document.createElement('div');
        paginationBar.className = 'pagination-toolbar';
        paginationBar.innerHTML = `
            <button type="button" class="btn-page-ctrl" onclick="changeQueuePage(-1)" ${state.currentPage === 1 ? 'disabled' : ''}>
                <i class="fa-solid fa-chevron-left"></i> 上一頁
            </button>
            <span class="page-indicator">第 ${state.currentPage} / ${totalPages} 頁 (${startIndex + 1}~${Math.min(startIndex + state.pageSize, count)} / 共 ${count} 筆)</span>
            <button type="button" class="btn-page-ctrl" onclick="changeQueuePage(1)" ${state.currentPage === totalPages ? 'disabled' : ''}>
                下一頁 <i class="fa-solid fa-chevron-right"></i>
            </button>
        `;
        queueList.appendChild(paginationBar);
    }

    pageItems.forEach((item, pageIdx) => {
        const index = startIndex + pageIdx;
        const card = document.createElement('div');
        const needsAttention = item.needsMandatoryCrop && !item.isCropped && item.status === 'idle';
        card.className = `queue-card ${item.status}${needsAttention ? ' card-needs-crop-attention' : ''}`;
        card.id = `qcard_${item.id}`;

        item.scale = item.scale || 1.0;
        item.panX = item.panX || 0;
        item.panY = item.panY || 0;
        item.rotation = item.rotation || 0;

        let topActionsHtml = '';
        if (item.status === 'success') {
            topActionsHtml = `<span class="queue-status-badge badge-success"><i class="fa-solid fa-check"></i> 完成 (${item.elapsedTime}s)</span>`;
        } else if (item.status === 'processing') {
            topActionsHtml = `<span class="queue-status-badge badge-processing"><i class="fa-solid fa-spinner fa-spin"></i> 辨識中...</span>`;
        } else if (item.status === 'rejected') {
            topActionsHtml = `<span class="queue-status-badge badge-rejected"><i class="fa-solid fa-triangle-exclamation"></i> 未符標準</span>`;
        } else if (item.status === 'error') {
            topActionsHtml = `<span class="queue-status-badge badge-error"><i class="fa-solid fa-xmark"></i> 失敗</span>`;
        } else if (item.needsMandatoryCrop && !item.isCropped) {
            topActionsHtml = `
                <div class="crop-top-inline-group">
                    <button type="button" class="btn-crop-inline-confirm-intense" onclick="confirmCropImage('${item.id}')" title="確認可視範圍裁切 (800x600)">
                        <i class="fa-solid fa-check me-1"></i>確認裁切
                    </button>
                </div>
            `;
        } else if (item.hasManualCropped) {
            topActionsHtml = `
                <div class="crop-top-inline-group">
                    <span class="queue-status-badge badge-success" style="font-size: 11px; padding: 3px 7px;"><i class="fa-solid fa-circle-check"></i> 800x600</span>
                    <button type="button" class="btn-crop-inline-reedit" onclick="reEditCropImage('${item.id}')" title="重新微調裁切">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                </div>
            `;
        } else {
            topActionsHtml = `<span class="queue-status-badge badge-idle"><i class="fa-regular fa-clock"></i> 等待辨識</span>`;
        }

        // 4:3 虛線導引提示框 (未裁切時居中提示)
        const cropGuideHtml = (item.needsMandatoryCrop && !item.isCropped && item.status === 'idle')
            ? `<div class="crop-overlay-guide"><div class="crop-guide-hint"><i class="fa-solid fa-arrows-up-down-left-right me-1"></i>滾輪縮放 / 拖曳平移對齊</div></div>`
            : '';

        const isExcelImport = item.id && item.id.startsWith('excel_imported_');
        const thumbContentHtml = item.dataUrl
            ? `<img src="${item.dataUrl}" id="img_${item.id}" class="queue-thumb-img" alt="${item.fileName}">`
            : `<div class="queue-cloud-placeholder">
                <i class="${isExcelImport ? 'fa-solid fa-file-excel' : 'fa-solid fa-cloud-arrow-down'} cloud-placeholder-icon" style="${isExcelImport ? 'color: #107c41;' : ''}"></i>
                <div class="cloud-placeholder-text">${isExcelImport ? 'Excel 報表匯入' : '跨裝置雲端同步'}</div>
                <div class="cloud-placeholder-sub">${item.result?.plate_number ? '車牌: ' + item.result.plate_number : item.fileName}</div>
               </div>`;

        // 鎖定狀態判定：已裁切或辨識中/完成時僅保留全螢幕檢視
        const isLocked = item.isCropped || item.status === 'success' || item.status === 'processing';
        const controlToolbarHtml = !isLocked ? `
            <button type="button" class="btn-zoom-ctrl" onclick="zoomCardImage('${item.id}', 1.25)" title="放大影像 (也可直接滾動滾輪)"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
            <button type="button" class="btn-zoom-ctrl" onclick="zoomCardImage('${item.id}', 0.8)" title="縮小影像"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
            <button type="button" class="btn-zoom-ctrl" onclick="rotateCardImage('${item.id}')" title="順時針旋轉 90 度"><i class="fa-solid fa-rotate-right"></i></button>
            <button type="button" class="btn-zoom-ctrl" onclick="resetCardImage('${item.id}')" title="重置位置與倍率 (也可雙擊圖片)"><i class="fa-solid fa-arrows-rotate"></i></button>
            <button type="button" class="btn-zoom-ctrl" onclick="previewLargeImage('${item.dataUrl}')" title="全螢幕新視窗檢視"><i class="fa-solid fa-expand"></i></button>
        ` : (item.dataUrl ? `
            <button type="button" class="btn-zoom-ctrl" onclick="previewLargeImage('${item.dataUrl}')" title="全螢幕新視窗檢視"><i class="fa-solid fa-expand"></i></button>
        ` : '');

        card.innerHTML = `
            <div class="queue-thumb-wrapper${isLocked ? ' is-locked' : ''}" id="wrapper_${item.id}" title="${!isLocked ? '滾動滾輪縮放、按住拖曳、雙擊重置' : '點擊全螢幕檢視'}">
                ${thumbContentHtml}
                ${cropGuideHtml}
            </div>

            <!-- 浮動頂部列 (左側檔名 + 右側狀態/操作按鈕) -->
            <div class="queue-floating-top">
                <div class="queue-filename-tag" title="${item.fileName}">#${index + 1}. ${item.fileName}</div>
                <div class="queue-top-actions-wrapper">${topActionsHtml}</div>
            </div>

            <!-- 浮動縮放平移旋轉快捷工具列 (左下角) -->
            <div class="queue-floating-controls">
                ${controlToolbarHtml}
            </div>

            <!-- 浮動底部列 (右下角移除按鈕) -->
            <div class="queue-floating-bottom">
                ${!state.isBatchRunning ? `<button type="button" class="btn-floating-action" onclick="removeQueueItem('${item.id}')" title="移除此項目"><i class="fa-solid fa-trash-can"></i> 移除</button>` : ''}
            </div>
        `;

        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const files = e.dataTransfer ? e.dataTransfer.files : null;
            if (files && files.length > 0) handleIncomingFiles(files);
        });

        queueList.appendChild(card);
        applyImageTransform(item);
        setupCardPanAndZoom(item);
    });

    renderRightCardsStream();
}

function changeQueuePage(delta) {
    const count = state.queue.length;
    const totalPages = Math.ceil(count / state.pageSize) || 1;
    const target = state.currentPage + delta;
    if (target >= 1 && target <= totalPages) {
        state.currentPage = target;
        updateQueueUI();
        const leftCard = document.getElementById('leftWorkspaceCard');
        if (leftCard) leftCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}
window.changeQueuePage = changeQueuePage;

function getRotationFitScale(item) {
    const rawW = item.rawImgW || item.rawWidth || 800;
    const rawH = item.rawImgH || item.rawHeight || 600;
    const isSwapped = (item.rotation === 90 || item.rotation === 270);
    const s0 = Math.min(800 / rawW, 600 / rawH);
    const sRot = isSwapped ? Math.min(800 / rawH, 600 / rawW) : s0;
    return sRot / (s0 || 1);
}

function applyImageTransform(item) {
    const img = document.getElementById(`img_${item.id}`);
    if (!img) return;
    const rotFitScale = getRotationFitScale(item);
    const totalScale = (item.scale || 1.0) * rotFitScale;
    img.style.transform = `translate(${item.panX || 0}px, ${item.panY || 0}px) rotate(${item.rotation || 0}deg) scale(${totalScale})`;
}

function zoomCardImage(itemId, factor) {
    const item = state.queue.find(x => x.id === itemId);
    if (!item || item.isCropped || item.status !== 'idle') return;
    item.scale = Math.min(6.0, Math.max(1.0, (item.scale || 1.0) * factor));
    if (item.scale <= 1.0) {
        item.panX = 0;
        item.panY = 0;
    }
    applyImageTransform(item);
}

function rotateCardImage(itemId) {
    const item = state.queue.find(x => x.id === itemId);
    if (!item || item.isCropped || item.status !== 'idle') return;
    item.rotation = ((item.rotation || 0) + 90) % 360;
    item.panX = 0;
    item.panY = 0;
    applyImageTransform(item);
    addDebugLog(`🔄 行照【${item.fileName}】順時針旋轉至 ${item.rotation}° (長寬比已自動適配)`, 'info');
    UiKit.showToast(`🔄 已旋轉至 ${item.rotation}° (長寬比已自動適配)`, 'info', 1500);
}

function resetCardImage(itemId) {
    const item = state.queue.find(x => x.id === itemId);
    if (!item || item.isCropped || item.status !== 'idle') return;
    item.scale = 1.0;
    item.panX = 0;
    item.panY = 0;
    item.rotation = 0;
    applyImageTransform(item);
    addDebugLog(`🔄 重置行照【${item.fileName}】之縮放倍率與平移座標`, 'info');
}

function setupCardPanAndZoom(item) {
    const wrapper = document.getElementById(`wrapper_${item.id}`);
    if (!wrapper) return;

    const isLocked = item.isCropped || item.status === 'success' || item.status === 'processing';
    if (isLocked) {
        wrapper.classList.add('is-locked');
        return; // 全域鎖定：不掛載拖曳/縮放攔截，放行手機原生垂直滑動
    } else {
        wrapper.classList.remove('is-locked');
    }

    let isDragging = false;
    let startX = 0;
    let startY = 0;

    wrapper.addEventListener('wheel', (e) => {
        if (item.isCropped || item.status !== 'idle') return;
        e.preventDefault();
        e.stopPropagation();
        const factor = e.deltaY < 0 ? 1.18 : 0.85;
        zoomCardImage(item.id, factor);
    }, { passive: false });

    wrapper.addEventListener('mousedown', (e) => {
        if (item.isCropped || item.status !== 'idle') return;
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX - (item.panX || 0);
        startY = e.clientY - (item.panY || 0);
        wrapper.classList.add('is-panning');
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        item.panX = e.clientX - startX;
        item.panY = e.clientY - startY;
        applyImageTransform(item);
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            wrapper.classList.remove('is-panning');
        }
    });

    wrapper.addEventListener('dblclick', (e) => {
        if (item.isCropped || item.status !== 'idle') return;
        e.preventDefault();
        if ((item.scale || 1.0) > 1.2) {
            resetCardImage(item.id);
        } else {
            item.scale = 2.4;
            item.panX = 0;
            item.panY = 0;
            applyImageTransform(item);
        }
    });

    // 手機端 Touch 事件 (未裁切時阻止畫面滾動以利拖曳平移/雙指縮放)
    let touchMode = 'none';
    let touchStartX = 0;
    let touchStartY = 0;
    let initialDistance = 0;
    let initialScale = 1.0;
    let lastTapTime = 0;

    wrapper.addEventListener('touchstart', (e) => {
        if (item.isCropped || item.status !== 'idle') return;
        if (e.touches.length === 1) {
            const now = Date.now();
            if (now - lastTapTime < 300) {
                e.preventDefault();
                if ((item.scale || 1.0) > 1.2) {
                    resetCardImage(item.id);
                } else {
                    item.scale = 2.4;
                    item.panX = 0;
                    item.panY = 0;
                    applyImageTransform(item);
                }
                lastTapTime = 0;
                touchMode = 'none';
                return;
            }
            lastTapTime = now;
            touchMode = 'pan';
            touchStartX = e.touches[0].clientX - (item.panX || 0);
            touchStartY = e.touches[0].clientY - (item.panY || 0);
            wrapper.classList.add('is-panning');
        } else if (e.touches.length === 2) {
            e.preventDefault();
            touchMode = 'pinch';
            initialDistance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            ) || 1;
            initialScale = item.scale || 1.0;
            touchStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - (item.panX || 0);
            touchStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - (item.panY || 0);
        }
    }, { passive: false });

    wrapper.addEventListener('touchmove', (e) => {
        if (item.isCropped || item.status !== 'idle' || touchMode === 'none') return;
        e.preventDefault();
        if (touchMode === 'pan' && e.touches.length === 1) {
            item.panX = e.touches[0].clientX - touchStartX;
            item.panY = e.touches[0].clientY - touchStartY;
            applyImageTransform(item);
        } else if (touchMode === 'pinch' && e.touches.length === 2) {
            const currentDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (initialDistance > 0) {
                const ratio = currentDist / initialDistance;
                item.scale = Math.min(6.0, Math.max(1.0, initialScale * ratio));
            }
            const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            item.panX = midX - touchStartX;
            item.panY = midY - touchStartY;
            applyImageTransform(item);
        }
    }, { passive: false });

    wrapper.addEventListener('touchend', (e) => {
        if (e.touches.length === 1) {
            touchMode = 'pan';
            touchStartX = e.touches[0].clientX - (item.panX || 0);
            touchStartY = e.touches[0].clientY - (item.panY || 0);
        } else if (e.touches.length === 0) {
            touchMode = 'none';
            wrapper.classList.remove('is-panning');
        }
    });
}

function confirmCropImage(itemId) {
    const item = state.queue.find(x => x.id === itemId);
    if (!item) return;

    const wrapper = document.getElementById(`wrapper_${itemId}`);
    const imgEl = document.getElementById(`img_${itemId}`);
    if (!wrapper || !imgEl) return;

    const TARGET_W = 800;
    const TARGET_H = 600;
    const canvas = document.createElement('canvas');
    canvas.width = TARGET_W;
    canvas.height = TARGET_H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, TARGET_W, TARGET_H);

    const wrapperRect = wrapper.getBoundingClientRect();
    const scaleRatio = TARGET_W / (wrapperRect.width || TARGET_W);

    const currentScale = item.scale || 1.0;
    const curPanX = (item.panX || 0) * scaleRatio;
    const curPanY = (item.panY || 0) * scaleRatio;
    const curRotRad = ((item.rotation || 0) * Math.PI) / 180;

    const baseImg = item.rawImg || imgEl;
    const rawW = item.rawImgW || item.rawWidth || baseImg.naturalWidth || baseImg.width || TARGET_W;
    const rawH = item.rawImgH || item.rawHeight || baseImg.naturalHeight || baseImg.height || TARGET_H;

    const isSwapped = (item.rotation === 90 || item.rotation === 270);
    const effW = isSwapped ? rawH : rawW;
    const effH = isSwapped ? rawW : rawH;

    const fitScale = Math.min(TARGET_W / effW, TARGET_H / effH);
    const drawW = rawW * fitScale;
    const drawH = rawH * fitScale;

    ctx.save();
    ctx.translate(TARGET_W / 2 + curPanX, TARGET_H / 2 + curPanY);
    ctx.rotate(curRotRad);
    ctx.scale(currentScale, currentScale);
    ctx.drawImage(baseImg, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    // 守門員 1：48 空間網格覆蓋率驗證
    if (typeof CvAnalyzer !== 'undefined' && CvAnalyzer.checkContentCoverage) {
        const coverageCheck = CvAnalyzer.checkContentCoverage(canvas);
        if (!coverageCheck.isValid) {
            addDebugLog(`⚠️ 行照【${item.fileName}】48 空間網格檢驗未通過：${coverageCheck.reason}`, 'warn');
            UiKit.showToast(`⚠️ ${coverageCheck.reason}`, 'warning');
            if (wrapper && wrapper.parentElement) {
                wrapper.parentElement.classList.add('card-highlight-shake');
                setTimeout(() => wrapper.parentElement.classList.remove('card-highlight-shake'), 1500);
            }
            return;
        }
    }

    // 守門員 2：空間雜訊熵量化驗證
    if (typeof CvAnalyzer !== 'undefined' && CvAnalyzer.calculateNoiseEntropy) {
        const noiseEntropy = CvAnalyzer.calculateNoiseEntropy(canvas);
        if (noiseEntropy > 0.25) {
            addDebugLog(`🛑 行照【${item.fileName}】空間雜訊熵過高 (${(noiseEntropy * 100).toFixed(0)}%)，文字筆劃失真`, 'error');
            UiKit.showToast(`🛑 偵測到影像網點與顆粒雜訊過高 (雜訊指數 ${(noiseEntropy * 100).toFixed(0)}%)，文字筆劃已碎裂失真無法確保辨識率！`, 'error');
            if (wrapper && wrapper.parentElement) {
                wrapper.parentElement.classList.add('card-highlight-shake');
                setTimeout(() => wrapper.parentElement.classList.remove('card-highlight-shake'), 1500);
            }
            return;
        }
    }

    const optDataUrl = canvas.toDataURL('image/jpeg', 0.90);
    const base64 = optDataUrl.split(',')[1];

    item.dataUrl = optDataUrl;
    item.base64 = base64;
    item.isCropped = true;
    item.hasManualCropped = true;
    item.scale = 1.0;
    item.panX = 0;
    item.panY = 0;
    item.rotation = 0;

    updateQueueUI();
    addDebugLog(`📐 行照 #${state.queue.indexOf(item) + 1}【${item.fileName}】已通過清晰度與 48 網格驗證，完成 800x600 裁切對齊！`, 'success');
    UiKit.showToast(`📐 行照 #${state.queue.indexOf(item) + 1} 已通過清晰度驗證並完成裁切對齊！`, 'success');
}

function enableCropEdit(itemId) {
    const item = state.queue.find(x => x.id === itemId);
    if (!item) return;
    item.isCropped = false;
    updateQueueUI();
}

function reEditCropImage(itemId) {
    const item = state.queue.find(x => x.id === itemId);
    if (!item) return;
    item.isCropped = false;
    item.hasManualCropped = false;
    if (item.originalDataUrl || item.rawDataUrl) {
        item.dataUrl = item.originalDataUrl || item.rawDataUrl;
    }
    updateQueueUI();
    addDebugLog(`🔄 行照 #${state.queue.indexOf(item) + 1}【${item.fileName}】已還原原始高畫質母體，進入重新微調模式`, 'info');
    UiKit.showToast(`🔄 已還原原始高畫質，請重新縮放與微調行照 #${state.queue.indexOf(item) + 1}`, 'info');
}

function renderRightCardsStream() {
    const cardsView = document.getElementById('cardsView');
    if (!cardsView) return;
    cardsView.innerHTML = '';

    const count = state.queue.length;
    state.pageSize = state.pageSize || 10;
    const totalPages = Math.ceil(count / state.pageSize) || 1;
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    if (state.currentPage < 1) state.currentPage = 1;

    const startIndex = (state.currentPage - 1) * state.pageSize;
    const pageItems = state.queue.slice(startIndex, startIndex + state.pageSize);

    if (count > state.pageSize) {
        const paginationBar = document.createElement('div');
        paginationBar.className = 'pagination-toolbar';
        paginationBar.innerHTML = `
            <button type="button" class="btn-page-ctrl" onclick="changeQueuePage(-1)" ${state.currentPage === 1 ? 'disabled' : ''}>
                <i class="fa-solid fa-chevron-left"></i> 上一頁
            </button>
            <span class="page-indicator">第 ${state.currentPage} / ${totalPages} 頁 (${startIndex + 1}~${Math.min(startIndex + state.pageSize, count)} / 共 ${count} 筆)</span>
            <button type="button" class="btn-page-ctrl" onclick="changeQueuePage(1)" ${state.currentPage === totalPages ? 'disabled' : ''}>
                下一頁 <i class="fa-solid fa-chevron-right"></i>
            </button>
        `;
        cardsView.appendChild(paginationBar);
    }

    pageItems.forEach((item, pageIdx) => {
        const index = startIndex + pageIdx;
        const block = document.createElement('div');
        block.className = 'result-item-block';
        block.id = `res_block_${item.id}`;

        if (item.status === 'idle') {
            block.innerHTML = `
                <div class="result-item-header">
                    <span class="result-item-title"><i class="fa-regular fa-image text-muted"></i> #${index + 1}. ${item.fileName}</span>
                    <span class="format-tag">⏸️ 排隊等待中</span>
                </div>
                <div style="padding: 100px 20px; text-align: center; color: var(--text-muted); font-size: 15px; font-weight: 700;">
                    <i class="fa-solid fa-arrow-down me-2 text-primary" style="font-size: 18px;"></i> 點擊下方【開始 AI 辨識】依序深度萃取車籍
                </div>
                <div style="font-size: 12px; color: var(--text-muted); text-align: right; padding-top: 8px; border-top: 1px solid var(--border-subtle);">狀態：尚未開始</div>
            `;
        } else if (item.status === 'processing') {
            block.innerHTML = `
                <div class="result-item-header">
                    <span class="result-item-title"><i class="fa-solid fa-spinner fa-spin text-primary"></i> #${index + 1}. ${item.fileName}</span>
                    <span class="format-tag" style="color: var(--color-blue); border-color: var(--color-blue);">⏳ AI 深度解析中...</span>
                </div>
                <div style="padding: 100px 20px; text-align: center;">
                    <div class="status-spinner" style="margin: 0 auto 16px; width: 36px; height: 36px;"></div>
                    <div style="font-weight: 800; font-size: 16px; color: var(--color-blue);">視覺模型辨識中...</div>
                </div>
                <div style="font-size: 12px; color: var(--color-blue); text-align: right; padding-top: 8px; border-top: 1px solid var(--border-subtle);">即時分析中</div>
            `;
        } else if (item.status === 'rejected') {
            block.innerHTML = `
                <div class="result-item-header" style="border-color: #fda4af;">
                    <span class="result-item-title" style="color: #be123c;"><i class="fa-solid fa-triangle-exclamation"></i> #${index + 1}. ${item.fileName}</span>
                    <span class="format-tag" style="background: #fecdd3; color: #be123c; border-color: #fda4af;">🛑 拒絕辨識 (Gatekeeper)</span>
                </div>
                <div style="background: #fff1f2; border: 1.5px solid #fda4af; border-radius: var(--radius-sm); padding: 24px; font-size: 14.5px; color: #9f1239; margin: 30px 0;">
                    <div style="font-weight: 800; margin-bottom: 6px;"><i class="fa-solid fa-shield-halved me-1"></i> 守門員審查攔截：</div>
                    ${item.result?.rejection_reason || item.errorMsg || '上傳影像研判並非單一台灣行車執照！'}
                </div>
                <div style="font-size: 12px; color: #be123c; text-align: right; padding-top: 8px; border-top: 1px solid var(--border-subtle);">已依安全標準拒絕處理</div>
            `;
        } else if (item.status === 'error') {
            block.innerHTML = `
                <div class="result-item-header" style="border-color: #fca5a5;">
                    <span class="result-item-title" style="color: #b91c1c;"><i class="fa-solid fa-circle-xmark"></i> #${index + 1}. ${item.fileName}</span>
                    <span class="format-tag" style="background: #fee2e2; color: #b91c1c; border-color: #fca5a5;">❌ 錯誤</span>
                </div>
                <div style="background: #fef2f2; border: 1.5px solid #fca5a5; border-radius: var(--radius-sm); padding: 24px; font-size: 13.5px; color: #991b1b; margin: 30px 0; word-break: break-all;">
                    <b>失敗原因：</b>${item.errorMsg}
                </div>
                <div style="font-size: 12px; color: #b91c1c; text-align: right; padding-top: 8px; border-top: 1px solid var(--border-subtle);">可重新點擊開始辨識進行重試</div>
            `;
        } else if (item.status === 'success' && item.result) {
            const d = item.result;
            const safeVal = (v) => (v !== undefined && v !== null && v !== '') ? v : '-';

            block.innerHTML = `
                <div class="result-item-header">
                    <span class="result-item-title">
                        <i class="fa-solid fa-id-card text-success"></i>
                        #${index + 1}. <b style="color: var(--color-blue); font-family: var(--font-mono); font-size: 16.5px;">${safeVal(d.plate_number)}</b>
                        <span style="font-size: 12.5px; color: var(--text-muted); font-weight: 500;">(${item.fileName})</span>
                    </span>
                    <button class="btn-copy-field" onclick="copyText('${d.plate_number}')"><i class="fa-regular fa-copy"></i> 複製車牌</button>
                </div>
                
                <div class="fields-grid" style="grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(6, 1fr); gap: 6px; flex: 1; margin: 0;">
                    <div class="field-card" style="grid-column: span 2;" onclick="copyText('${safeVal(d.owner)}')">
                        <div class="field-header-row"><span class="field-label">車主名稱</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.owner)}</span>
                    </div>

                    <div class="field-card" style="grid-column: span 2;" onclick="copyText('${safeVal(d.address)}')">
                        <div class="field-header-row"><span class="field-label">住址</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value" style="font-size: 12.5px;">${safeVal(d.address)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.vehicle_type)}')">
                        <div class="field-header-row"><span class="field-label">車種</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.vehicle_type)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.special_type)}')">
                        <div class="field-header-row"><span class="field-label">特殊車種</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value highlight-special">${safeVal(d.special_type)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.body_style)}')">
                        <div class="field-header-row"><span class="field-label">車身式樣</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.body_style)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.extra_equipment)}')">
                        <div class="field-header-row"><span class="field-label">附加配備</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value" style="color: var(--color-blue);">${safeVal(d.extra_equipment)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.brand)}')">
                        <div class="field-header-row"><span class="field-label">廠牌</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.brand)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.model)}')">
                        <div class="field-header-row"><span class="field-label">型式</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.model)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.displacement)}')">
                        <div class="field-header-row"><span class="field-label">排氣量 (c.c.)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.displacement)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.fuel_type)}')">
                        <div class="field-header-row"><span class="field-label">燃料種類</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.fuel_type)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.engine_number)}')">
                        <div class="field-header-row"><span class="field-label">引擎號碼</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value" style="font-family: var(--font-mono); font-size: 11.5px;">${safeVal(d.engine_number)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.vin)}')">
                        <div class="field-header-row"><span class="field-label">車身號碼 (VIN)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value" style="font-family: var(--font-mono); font-size: 11.5px;">${safeVal(d.vin)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('座:${d.capacity_sit || 0} 立:${d.capacity_stand || 0} 駕駛:${d.capacity_driver || 0}')">
                        <div class="field-header-row"><span class="field-label">載運人數</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${d.capacity_sit || 0}座 / ${d.capacity_stand || 0}立 / ${d.capacity_driver || 0}駕</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.load_weight)}')">
                        <div class="field-header-row"><span class="field-label">載重 (噸)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.load_weight)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.total_weight)}')">
                        <div class="field-header-row"><span class="field-label">總重 (噸)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.total_weight)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.towing_weight)}')">
                        <div class="field-header-row"><span class="field-label">聯結重量 (噸)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.towing_weight)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.color)}')">
                        <div class="field-header-row"><span class="field-label">車色</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.color)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.original_issue_date_ad || d.original_issue_date)}')">
                        <div class="field-header-row"><span class="field-label">原發照日期(西元)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.original_issue_date_ad || d.original_issue_date)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.renew_issue_date_ad || d.renew_issue_date)}')">
                        <div class="field-header-row"><span class="field-label">換補照日期(西元)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.renew_issue_date_ad || d.renew_issue_date)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.original_issue_date_roc)}')">
                        <div class="field-header-row"><span class="field-label">原發照日期(民國)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.original_issue_date_roc)}</span>
                    </div>

                    <div class="field-card" onclick="copyText('${safeVal(d.renew_issue_date_roc)}')">
                        <div class="field-header-row"><span class="field-label">換補照日期(民國)</span><span class="field-copy-hint"><i class="fa-regular fa-copy"></i></span></div>
                        <span class="field-value">${safeVal(d.renew_issue_date_roc)}</span>
                    </div>
                </div>
            `;
        }

        cardsView.appendChild(block);
    });
}

function updateBottomActionBar(queueCount, successCount) {
    const btnStart = document.getElementById('bottomBtnStart');
    const groupQueue = document.getElementById('bottomGroupQueue');
    const groupResults = document.getElementById('bottomGroupResults');
    if (!btnStart) return;

    const pendingList = state.queue.filter(x => x.status === 'idle' || x.status === 'error');
    const hasPending = pendingList.length > 0;
    const uncroppedCount = state.queue.filter(x => x.status === 'idle' && x.needsMandatoryCrop && !x.isCropped).length;
    const isMobile = window.innerWidth <= 768;

    btnStart.disabled = false;
    if (state.isBatchRunning) {
        btnStart.setAttribute('data-disabled', 'true');
        btnStart.classList.remove('btn-attention-ready');
        btnStart.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i>AI 深度辨識中...';
    } else if (uncroppedCount > 0) {
        btnStart.setAttribute('data-disabled', 'true');
        btnStart.classList.remove('btn-attention-ready');
        btnStart.innerHTML = `<i class="fa-solid fa-crop-simple me-1"></i>尚有 ${uncroppedCount} 張未確認裁切`;
    } else if (queueCount > 0 && hasPending) {
        btnStart.removeAttribute('data-disabled');
        btnStart.classList.add('btn-attention-ready');
        btnStart.innerHTML = `<i class="fa-solid fa-bolt me-1"></i>開始 AI 辨識 (${pendingList.length})`;
    } else {
        btnStart.setAttribute('data-disabled', 'true');
        btnStart.classList.remove('btn-attention-ready');
        btnStart.innerHTML = '<i class="fa-solid fa-bolt me-1"></i>開始 AI 辨識 (0)';
    }

    if (!isMobile) {
        if (successCount > 0 && !hasPending && !state.isBatchRunning) {
            if (groupQueue) groupQueue.style.display = 'none';
            if (groupResults) groupResults.style.display = 'flex';
        } else {
            if (groupQueue) groupQueue.style.display = 'flex';
            if (groupResults) groupResults.style.display = 'none';
        }
    } else {
        const isResultsTab = document.getElementById('tabBtnResults')?.classList.contains('active');
        if (isResultsTab) {
            if (groupQueue) groupQueue.style.display = 'none';
            if (groupResults) groupResults.style.display = 'flex';
        } else {
            if (groupQueue) groupQueue.style.display = 'flex';
            if (groupResults) groupResults.style.display = 'none';
        }
    }
}

// ==========================================
// 3. AI 推論與管線排程控制
// ==========================================
function getActiveChannelDescription() {
    if (state.providerType === 'openai') {
        const urlDisplay = state.openaiBaseUrl ? state.openaiBaseUrl.replace(/\/+$/, '') : 'http://localhost:11434/v1';
        const modelDisplay = state.openaiModel || 'llama3.2-vision:11b';
        return `🤖【OpenAI 相容私有化端點】模型: ${modelDisplay} ｜ 端點: ${urlDisplay}`;
    }
    
    const isCustomWorker = !!(state.workerUrl && state.workerUrl.trim() && state.workerUrl.trim() !== DEFAULT_WORKER_URL);
    const hasPersonalKey = !!(state.apiKey && state.apiKey.trim());
    const maskedKey = hasPersonalKey ? `...${state.apiKey.trim().slice(-4)}` : '';

    if (isCustomWorker && hasPersonalKey) {
        return `🛡️【自訂代理通道 + 個人 Gemini Key】Worker: ${state.workerUrl.trim()} ｜ Key末四碼: ${maskedKey}`;
    } else if (isCustomWorker) {
        return `🛡️【自訂代理通道】Worker: ${state.workerUrl.trim()}`;
    } else if (hasPersonalKey) {
        return `⚡【系統預設通道 + 個人 Gemini Key】官方 Worker 注入監理 Prompt ｜ Key末四碼: ${maskedKey}`;
    } else {
        return `🌐【系統預設通道】官方 Cloudflare 安全中繼 ｜ Gemini 3.6 Flash (免填 Key 公共配額)`;
    }
}

async function startBatchProcessing() {
    if (state.isBatchRunning) return;
    if (state.queue.length === 0) {
        showToast('⚠️ 請先加入行照！', 'warning');
        return;
    }

    const uncroppedItem = state.queue.find(x => x.status === 'idle' && x.needsMandatoryCrop && !x.isCropped);
    if (uncroppedItem) {
        const itemIdx = state.queue.indexOf(uncroppedItem) + 1;
        showToast(`💡 還有第 ${itemIdx} 張「${uncroppedItem.fileName}」尚未點擊【✔ 確認裁切】！`, 'warning', 4500);
        const cardEl = document.getElementById(`qcard_${uncroppedItem.id}`);
        if (cardEl) {
            cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cardEl.classList.add('card-highlight-shake');
            setTimeout(() => cardEl.classList.remove('card-highlight-shake'), 1800);
        }
        return;
    }

    const rejectedItem = state.queue.find(x => x.status === 'rejected');
    if (rejectedItem) {
        showToast(`⚠️ 佇列中有未通過品質檢驗之行照 (${rejectedItem.rejectionReason || '解析度過低'})，請修正或移除後再送出！`, 'warning', 5000);
        const el = document.getElementById(`qcard_${rejectedItem.id}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('card-highlight-shake');
            setTimeout(() => el.classList.remove('card-highlight-shake'), 1500);
        }
        return;
    }

    const pendingItems = state.queue.filter(x => x.status === 'idle' || x.status === 'error');
    if (pendingItems.length === 0) {
        showToast('ℹ️ 佇列中的資料皆已是完成狀態，可直接匯出或追加新照片！', 'info');
        return;
    }

    const workerUrl = (state.workerUrl && state.workerUrl.trim()) ? state.workerUrl.trim() : DEFAULT_WORKER_URL;
    const channelDesc = getActiveChannelDescription();
    addDebugLog(`📡 啟動 AI 辨識通道：${channelDesc}`, 'info');

    state.isBatchRunning = true;
    state.abortBatch = false;
    updateQueueUI();

    const statusCard = document.getElementById('statusCard');
    const statusText = document.getElementById('statusText');
    const statusTimer = document.getElementById('statusTimer');
    if (statusCard) {
        statusCard.style.display = 'flex';
        statusCard.classList.add('active');
    }

    const batchStartTime = Date.now();
    const batchTimerInterval = setInterval(() => {
        if (statusTimer) {
            statusTimer.textContent = ((Date.now() - batchStartTime) / 1000).toFixed(1) + 's';
        }
    }, 100);

    let wasAborted = false;
    let globalCooldownUntil = 0;
    const STAGGER_INTERVAL_MS = 5000;
    const MAX_RETRIES = 3;

    async function processSingleItem(item, itemIndex, totalPending) {
        let retryCount = 0;
        while (retryCount <= MAX_RETRIES) {
            if (state.abortBatch) {
                item.status = 'idle';
                return;
            }

            while (Date.now() < globalCooldownUntil) {
                if (state.abortBatch) {
                    item.status = 'idle';
                    return;
                }
                const waitSec = Math.ceil((globalCooldownUntil - Date.now()) / 1000);
                if (statusText) statusText.textContent = `⏳ 觸發 Google 頻率保護，管線暫停中，${waitSec} 秒後自動恢復...`;
                await new Promise(r => setTimeout(r, 1000));
            }

            item.status = 'processing';
            updateQueueUI();
            const startTime = Date.now();

            if (statusText) {
                statusText.textContent = `[${itemIndex + 1}/${totalPending}] 正在辨識: ${item.fileName}...${retryCount > 0 ? ` (第 ${retryCount} 次重試)` : ''}`;
            }

            try {
                let resultData = null;
                if (state.providerType === 'openai') {
                    resultData = await AiDispatcher.callOpenAiCompatibleApi(state.openaiBaseUrl, state.openaiApiKey, state.openaiModel, item.base64, item.mimeType, SYSTEM_PROMPT);
                } else {
                    resultData = await AiDispatcher.callWorkerApi(workerUrl, item.base64, item.mimeType);
                }

                item.elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

                if (state.abortBatch) {
                    item.status = 'idle';
                    return;
                }

                if (resultData.is_valid_license === false) {
                    item.status = 'rejected';
                    item.result = resultData;
                    item.rejectionReason = resultData.rejection_reason || '非單張行照文件';
                    addDebugLog(`⚠️ 行照 [${item.fileName}] 經 AI 審查判定無效: ${item.rejectionReason}`, 'warn');
                } else {
                    LicenseNormalizer.cleanAndSegmentAttributes(resultData);
                    item.status = 'success';
                    item.result = resultData;
                    addDebugLog(`🎉 行照 [${item.fileName}] 辨識成功 (${item.elapsedTime}s)！車號: ${resultData.plate_number || '未填'}`, 'success');
                    recordProcessedStats(1);
                }
                updateQueueUI();
                return;

            } catch (err) {
                item.elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
                if (state.abortBatch) {
                    item.status = 'idle';
                    return;
                }

                const errMsg = err.message || '';
                const retryMatch = errMsg.match(/Please retry in ([\d\.]+)s/i) || errMsg.match(/retry after ([\d\.]+)s/i);
                const isHighDemand = errMsg.includes('high demand') || errMsg.includes('503') || errMsg.includes('overloaded');
                const isQuotaLimit = errMsg.includes('Quota exceeded') || errMsg.includes('rate-limits') || errMsg.includes('429') || retryMatch;
                const isTimeout = errMsg.includes('連線逾時') || errMsg.includes('60 秒');

                if ((isQuotaLimit || isHighDemand || isTimeout) && retryCount < MAX_RETRIES) {
                    let cooldownSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : (isHighDemand || isTimeout ? 6 : 20);
                    globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + (cooldownSec * 1000));
                    addDebugLog(`⏳ 項目 [${item.fileName}] 觸發頻率保護，啟動全域冷卻 ${cooldownSec} 秒並重試...`, 'warn');
                    retryCount++;
                    item.status = 'idle';
                    updateQueueUI();
                } else {
                    item.status = 'error';
                    item.errorMsg = isTimeout ? '⚠️ 連線逾時，請重試！' : (errMsg.includes('429') ? '⏳ API 請求頻率已達限額，請稍候再試！' : errMsg);
                    updateQueueUI();
                    showToast(`❌ [${item.fileName}]: ${item.errorMsg.slice(0, 40)}`, 'error', 5000);
                    return;
                }
            }
        }
    }

    try {
        const tasks = [];
        for (let i = 0; i < pendingItems.length; i++) {
            if (state.abortBatch) {
                wasAborted = true;
                break;
            }
            const currentItem = pendingItems[i];
            tasks.push(processSingleItem(currentItem, i, pendingItems.length));

            if (i < pendingItems.length - 1) {
                let waitRemaining = STAGGER_INTERVAL_MS;
                while (waitRemaining > 0) {
                    if (state.abortBatch) {
                        wasAborted = true;
                        break;
                    }
                    if (Date.now() < globalCooldownUntil) {
                        const cdLeft = globalCooldownUntil - Date.now();
                        await new Promise(r => setTimeout(r, Math.min(cdLeft, 1000)));
                        continue;
                    }
                    const step = Math.min(waitRemaining, 500);
                    if (statusText) {
                        statusText.textContent = `⚡ 管線交錯發送中，${(waitRemaining / 1000).toFixed(1)}s 後發送下一筆...`;
                    }
                    await new Promise(r => setTimeout(r, step));
                    waitRemaining -= step;
                }
            }
        }

        await Promise.allSettled(tasks);
    } finally {
        clearInterval(batchTimerInterval);
        wasAborted = wasAborted || state.abortBatch;
        state.isBatchRunning = false;
        state.abortBatch = false;
        if (statusCard) {
            statusCard.style.display = 'none';
            statusCard.classList.remove('active');
        }
        updateQueueUI();

        if (wasAborted) {
            showToast('🛑 已手動取消辨識排程', 'info', 3000);
        } else {
            const successItems = state.queue.filter(x => x.status === 'success');
            if (successItems.length > 0) {
                showToast(`🎉 全部行照批次辨識完成 (共 ${successItems.length} 筆成功)！`, 'success', 5000);
                if (activePairChannel) {
                    sendCurrentResultsToPairSession(activePairChannel);
                }
                if (window.innerWidth <= 768) {
                    switchMobileTab('results');
                }
            }
        }
    }
}

function cancelBatchProcessing() {
    if (!state.isBatchRunning) return;
    state.abortBatch = true;
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = '🛑 正在取消排程中...';
}

// ==========================================
// 4. 報表匯出與分享 (Export & Share)
// ==========================================
async function exportBatchExcel() {
    const successItems = state.queue.filter(x => x.status === 'success' && x.result);
    if (successItems.length === 0) {
        showToast('⚠️ 目前尚無辨識成功的行照可供匯出！', 'info');
        return;
    }

    addDebugLog(`📊 開始匯出包含【車籍總表】與 ${successItems.length} 個【嵌入照片頁籤】之 Excel 報表...`, 'info');
    showToast('⏳ 正在生成多工作表 Excel 報表並嵌入行照照片...', 'info', 2000);

    if (window.ExcelJS) {
        try {
            const workbook = new ExcelJS.Workbook();
            workbook.creator = 'Auto Licensify AI (TW)';
            workbook.created = new Date();

            const summarySheet = workbook.addWorksheet('車籍彙總總表', { views: [{ showGridLines: true }] });
            const summaryHeaders = [
                "序號", "檔案名稱", "牌照號碼", "車輛種類", "特殊車種", "車身式樣", "附加配備",
                "車主名稱", "住址", "廠牌", "型式", "出廠年月", "排氣量(c.c.)", "燃料種類",
                "車色", "引擎號碼", "車身號碼(VIN)", "載運人數(座)", "載運人數(立)", "載運人數(駕駛室)",
                "載重量(公噸)", "總重量(公噸)", "曳引總重(公噸)", "服務公司或承租人",
                "原發照日期(民國)", "原發照日期(西元)", "換補照日期(民國)", "換補照日期(西元)"
            ];

            const headerRow = summarySheet.addRow(summaryHeaders);
            headerRow.height = 24;
            headerRow.eachCell((cell) => {
                cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            });

            summarySheet.columns = [
                { width: 8 }, { width: 22 }, { width: 14 }, { width: 14 },
                { width: 12 }, { width: 12 }, { width: 12 }, { width: 18 },
                { width: 30 }, { width: 14 }, { width: 16 }, { width: 12 },
                { width: 14 }, { width: 12 }, { width: 10 }, { width: 18 },
                { width: 22 }, { width: 12 }, { width: 12 }, { width: 14 },
                { width: 14 }, { width: 14 }, { width: 14 }, { width: 18 },
                { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }
            ];

            successItems.forEach((item, idx) => {
                const d = item.result;
                const row = summarySheet.addRow([
                    idx + 1, item.fileName || '', d.plate_number || '', d.vehicle_type || '',
                    d.special_type || '', d.body_style || '', d.extra_equipment || '', d.owner || '',
                    d.address || '', d.brand || '', d.model || '', d.manufacture_date || '',
                    d.displacement !== undefined ? d.displacement : '', d.fuel_type || '', d.color || '',
                    d.engine_number || '', d.vin || '', d.capacity_sit || 0, d.capacity_stand || 0,
                    d.capacity_driver || 0, d.load_weight || '', d.total_weight || '', d.towing_weight || 0,
                    d.lessee || '', d.original_issue_date_roc || '', d.original_issue_date_ad || '',
                    d.renew_issue_date_roc || '', d.renew_issue_date_ad || ''
                ]);
                row.height = 20;
                row.eachCell((cell) => { cell.alignment = { vertical: 'middle' }; });
            });

            successItems.forEach((item, idx) => {
                const d = item.result;
                const plate = (d.plate_number || '').trim();
                let sheetTitle = (plate ? `${idx + 1}_${plate}` : `第${idx + 1}筆_明細`).replace(/[:\\/?*\[\]]/g, '_').slice(0, 31);
                const detailSheet = workbook.addWorksheet(sheetTitle, { views: [{ showGridLines: true }] });

                detailSheet.columns = [
                    { width: 22 }, { width: 36 }, { width: 4 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }
                ];

                const titleRow = detailSheet.addRow(["行照車籍詳細規格表", plate ? `(${plate})` : ""]);
                titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1F4E79' } };
                titleRow.getCell(2).font = { bold: true, size: 14, color: { argb: 'FFC00000' } };

                detailSheet.addRow(["匯出日期", new Date().toLocaleString('zh-TW')]);
                detailSheet.addRow(["", ""]);

                const tableHeader = detailSheet.addRow(["項目欄位", "辨識內容", "", "📷 行照正本影像照片 (實體照片)"]);
                tableHeader.getCell(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
                tableHeader.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF203764' } };
                tableHeader.getCell(2).font = { bold: true, color: { argb: 'FFFFFFFF' } };
                tableHeader.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF203764' } };
                tableHeader.getCell(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
                tableHeader.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF385723' } };

                const fields = [
                    ["序號", idx + 1], ["影像檔案名稱", item.fileName || ''], ["牌照號碼", d.plate_number || ''],
                    ["車輛種類", d.vehicle_type || ''], ["特殊車種", d.special_type || ''], ["車身式樣", d.body_style || ''],
                    ["附加配備", d.extra_equipment || ''], ["車主名稱", d.owner || ''], ["住址", d.address || ''],
                    ["廠牌", d.brand || ''], ["型式", d.model || ''], ["出廠年月", d.manufacture_date || ''],
                    ["排氣量(c.c.)", d.displacement !== undefined ? d.displacement : ''], ["燃料種類", d.fuel_type || ''],
                    ["車色", d.color || ''], ["引擎號碼", d.engine_number || ''], ["車身號碼(VIN)", d.vin || ''],
                    ["載運人數(座)", d.capacity_sit || 0], ["載運人數(立)", d.capacity_stand || 0],
                    ["載運人數(駕駛室)", d.capacity_driver || 0], ["載重量(公噸)", d.load_weight || ''],
                    ["總重量(公噸)", d.total_weight || ''], ["曳引總重(公噸)", d.towing_weight || 0],
                    ["服務公司或承租人", d.lessee || ''], ["原發照日期(民國)", d.original_issue_date_roc || ''],
                    ["原發照日期(西元)", d.original_issue_date_ad || ''], ["換補照日期(民國)", d.renew_issue_date_roc || ''],
                    ["換補照日期(西元)", d.renew_issue_date_ad || '']
                ];

                fields.forEach(([label, val]) => {
                    const r = detailSheet.addRow([label, val]);
                    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
                    r.getCell(1).font = { bold: true };
                });

                if (item.dataUrl && item.dataUrl.startsWith('data:image')) {
                    try {
                        const isPng = item.dataUrl.includes('image/png');
                        const imageId = workbook.addImage({ base64: item.dataUrl, extension: isPng ? 'png' : 'jpeg' });
                        detailSheet.addImage(imageId, { tl: { col: 3.2, row: 4.2 }, ext: { width: 440, height: 330 }, editAs: 'oneCell' });
                    } catch (e) {}
                }
            });

            const buffer = await workbook.xlsx.writeBuffer();
            const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const fileName = `行照車籍辨識清冊_含實體照片_共${successItems.length}筆_${today}.xlsx`;

            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);

            addDebugLog(`📊 成功匯出包含【車籍總表】與 ${successItems.length} 個【嵌圖頁籤】之 Excel 報表！`, 'success');
            showToast(`📊 已成功匯出包含【車籍總表】與 ${successItems.length} 個【嵌圖頁籤】之 Excel！`, 'success', 5000);
            return;
        } catch (excelErr) {
            console.warn('ExcelJS 匯出回退至 SheetJS:', excelErr);
            addDebugLog(`⚠️ ExcelJS 嵌圖匯出異常，自動降級回退至 SheetJS 純文字模式: ${excelErr.message}`, 'warn');
        }
    }

    // 備援 SheetJS
    if (window.XLSX) {
        const wb = XLSX.utils.book_new();
        const summaryRows = successItems.map((item, idx) => {
            const d = item.result;
            return {
                "序號": idx + 1, "檔案名稱": item.fileName, "牌照號碼": d.plate_number || '',
                "車輛種類": d.vehicle_type || '', "特殊車種": d.special_type || '', "車身式樣": d.body_style || '',
                "附加配備": d.extra_equipment || '', "車主名稱": d.owner || '', "住址": d.address || '',
                "廠牌": d.brand || '', "型式": d.model || '', "出廠年月": d.manufacture_date || '',
                "排氣量(c.c.)": d.displacement || '', "燃料種類": d.fuel_type || '', "車色": d.color || '',
                "引擎號碼": d.engine_number || '', "車身號碼(VIN)": d.vin || '', "載運人數(座)": d.capacity_sit || 0,
                "載重量(公噸)": d.load_weight || '', "總重量(公噸)": d.total_weight || '',
                "原發照日期(民國)": d.original_issue_date_roc || '', "換補照日期(民國)": d.renew_issue_date_roc || ''
            };
        });
        const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
        XLSX.utils.book_append_sheet(wb, summaryWs, "車籍彙總總表");
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        XLSX.writeFile(wb, `行照車籍辨識清冊_共${successItems.length}筆_${today}.xlsx`);
        addDebugLog(`📊 成功匯出 ${successItems.length} 筆車籍總表 Excel！`, 'success');
        showToast('📊 已成功匯出 Excel 報表！', 'success', 5000);
    }
}

function exportBatchJson() {
    const successItems = state.queue.filter(x => x.status === 'success' && x.result);
    if (successItems.length === 0) {
        showToast('⚠️ 目前尚無辨識成功的行照可供匯出！', 'info');
        return;
    }
    const chineseData = successItems.map((it, idx) => LicenseNormalizer.convertResultToChineseObject(it, idx));
    const today = new Date().toISOString().slice(0, 10);
    ExportManager.exportToJsonFile(chineseData, `行照辨識全量中文清單_共${chineseData.length}筆_${today}.json`);
    addDebugLog(`💾 已成功下載 ${chineseData.length} 筆全量繁體中文車籍 JSON！`, 'success');
    showToast(`💾 已下載 ${chineseData.length} 筆全量繁中 JSON！`, 'success');
}

function copyText(text) {
    if (text) {
        navigator.clipboard.writeText(text);
        showToast(`📋 已複製: ${text}`, 'success');
    }
}

function previewLargeImage(src) {
    if (src) {
        const w = window.open('');
        w.document.write(`<body style="margin:0; background:#0f172a; display:flex; align-items:center; justify-content:center; min-height:100vh;"><img src="${src}" style="max-width:95vw; max-height:95vh; object-fit:contain; border-radius:8px; box-shadow:0 10px 25px rgba(0,0,0,0.5);"></body>`);
    }
}

// ==========================================
// 5. 跨裝置雙軌同步與取件 (Dual-Track Sync & Pickup)
// ==========================================
let pickupQrScannerInstance = null;

async function generatePickupCode() {
    const successItems = state.queue.filter(x => x.status === 'success' && x.result);
    if (successItems.length === 0) {
        showToast('⚠️ 請先完成至少一張行照的 AI 辨識！', 'info');
        return;
    }

    const code = DualTrackSync.generatePickupCode(6);
    const payload = successItems.map(it => ({
        fileName: it.fileName,
        result: it.result,
        dataUrl: it.dataUrl || null
    }));

    try {
        addDebugLog(`🔑 正在為 ${successItems.length} 筆車籍進行 AES-256 加密生成取件碼...`, 'info');
        showToast('⏳ 正在進行 AES-256 加密並上傳中繼通道...', 'info', 2000);
        const encryptedPayload = await DualTrackSync.encryptDataWithCode(JSON.stringify(payload), code);
        const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');

        // 1. 上傳 Cloudflare Worker 中繼
        try {
            await fetch(`${workerEndpoint}/api/sync/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code, cipher: encryptedPayload, createdAt: Date.now() })
            });
        } catch (workerErr) {
            console.warn('Worker 雲端中繼異常，啟用本地保底暫存:', workerErr);
        }

        // 2. 本地保底 (防 QuotaExceededError 溢出阻斷流程)
        try {
            localStorage.setItem(`pickup_${code}`, JSON.stringify({ cipher: encryptedPayload, createdAt: Date.now() }));
        } catch (storageErr) {
            console.warn('localStorage 空間已滿或超限，略過本地保底暫存:', storageErr);
        }

        const resultCard = document.getElementById('pickupResultCard');
        const displayCode = document.getElementById('displayPickupCode');
        const qrCanvas = document.getElementById('pickupQrCanvas');

        if (resultCard && displayCode) {
            displayCode.textContent = code;
            
            // 渲染純字串 QR Code (僅包含純 6 位字串，不含任何外部 URL)
            if (qrCanvas && typeof QRCode !== 'undefined') {
                qrCanvas.innerHTML = '';
                new QRCode(qrCanvas, {
                    text: code,
                    width: 130,
                    height: 130,
                    colorDark: "#0f172a",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel ? QRCode.CorrectLevel.M : 0
                });
            }

            const revokeBtn = resultCard.querySelector('.btn-pickup-revoke');
            if (revokeBtn) revokeBtn.style.display = 'inline-flex';

            resultCard.style.display = 'block';
        }

        // 3. 啟動在線等候探測器 (接收端提取成功後即時感知)
        startPickupStatusMonitor(code);

        addDebugLog(`✅ 6 位取件碼【${code}】生成完成 (共 ${successItems.length} 筆・閱後即焚)！已開啟在線取件感知`, 'success');
        showToast(`🔐 取件碼【${code}】已成功生成！請至接收端輸入取件！`, 'success', 6000);
    } catch (err) {
        console.error('取件碼生成失敗:', err);
        addDebugLog(`❌ 取件碼生成失敗: ${err.message}`, 'error');
        showToast(`❌ 加密暫存失敗，請重試！`, 'error');
    }
}

// ----------------------------------------------------
// 🌟 發送端在線取件狀態即時探測 (Real-Time Pickup Monitor)
// ----------------------------------------------------
let pickupMonitorTimer = null;
let currentMonitoringCode = '';

function startPickupStatusMonitor(code) {
    stopPickupStatusMonitor();
    currentMonitoringCode = code;

    // 每 3.5 秒低頻探測一次中繼狀態
    pickupMonitorTimer = setInterval(async () => {
        if (!currentMonitoringCode || currentMonitoringCode !== code) {
            stopPickupStatusMonitor();
            return;
        }

        const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
        const status = await DualTrackSync.checkPickupCodeStatus(workerEndpoint, code);

        // 若成功連線且中繼已不存在 (已被接收端成功提取並閱後即焚銷毀)
        if (status.success && !status.exists) {
            stopPickupStatusMonitor();
            onPickupCompletedByReceiver(code);
        }
    }, 3500);
}

function stopPickupStatusMonitor() {
    if (pickupMonitorTimer) {
        clearInterval(pickupMonitorTimer);
        pickupMonitorTimer = null;
    }
    currentMonitoringCode = '';
}

function onPickupCompletedByReceiver(code) {
    const resultCard = document.getElementById('pickupResultCard');
    const displayCode = document.getElementById('displayPickupCode');
    const qrCanvas = document.getElementById('pickupQrCanvas');

    if (resultCard && displayCode) {
        displayCode.innerHTML = `<span style="color: #16a34a; font-size: 24px; letter-spacing: 1px;">✅ 已完成取件</span>`;
        if (qrCanvas) {
            qrCanvas.innerHTML = `
                <div style="padding: 18px 10px; color: #16a34a; text-align: center; font-weight: 800; animation: modalIn 0.3s ease;">
                    <i class="fa-solid fa-circle-check" style="font-size: 48px; margin-bottom: 10px; color: #16a34a;"></i>
                    <div style="font-size: 15px; color: var(--text-title); margin-bottom: 4px;">🎉 接收端已成功提取！</div>
                    <div style="font-size: 12px; color: var(--text-muted); font-weight: 600;">雲端中繼資料已閱後即焚物理銷毀</div>
                </div>
            `;
        }

        const revokeBtn = resultCard.querySelector('.btn-pickup-revoke');
        if (revokeBtn) revokeBtn.style.display = 'none';
    }

    addDebugLog(`🎉 偵測到取件碼【${code}】已被接收端成功提取！雲端中繼資料已閱後即焚物理銷毀。`, 'success');
    showToast(`🎉 接收端已成功提取資料！雲端中繼已即刻物理銷毀。`, 'success', 6000);
}

// 複製當前生成的取件碼
function copyCurrentPickupCode() {
    const code = document.getElementById('displayPickupCode')?.textContent?.trim();
    if (code && code !== '------' && !code.includes('已完成取件')) {
        navigator.clipboard.writeText(code);
        showToast(`📋 已複製取件碼: ${code}`, 'success');
    }
}

// 傳送端主動撤回銷毀取件碼
async function revokeCurrentPickupCode() {
    const displayCodeEl = document.getElementById('displayPickupCode');
    const code = displayCodeEl?.textContent?.trim();
    if (!code || code === '------' || code.includes('已完成取件')) return;

    stopPickupStatusMonitor();
    showToast(`🗑️ 正在銷毀取件碼【${code}】...`, 'info', 1500);
    await DualTrackSync.revokePickupCode(state.workerUrl, code);

    const resultCard = document.getElementById('pickupResultCard');
    const qrCanvas = document.getElementById('pickupQrCanvas');
    if (resultCard) resultCard.style.display = 'none';
    if (displayCodeEl) displayCodeEl.textContent = '------';
    if (qrCanvas) qrCanvas.innerHTML = '';

    addDebugLog(`🗑️ 已主動註銷銷毀取件碼【${code}】中繼資料！`, 'info');
    showToast(`🗑️ 取件碼【${code}】已立即註銷銷毀！`, 'success', 4000);
}

// 接收端啟動相機掃描取件碼 (掃碼成功自動發起下載)
async function startPickupQrScanner() {
    const scannerBox = document.getElementById('pickupQrScannerBox');
    const startBtn = document.getElementById('btnStartPickupQrScan');
    if (!scannerBox) return;

    if (typeof Html5Qrcode === 'undefined') {
        showToast('⚠️ 掃描組件載入中，請稍候重試！', 'warning');
        return;
    }

    scannerBox.style.display = 'block';
    if (startBtn) startBtn.style.display = 'none';

    try {
        pickupQrScannerInstance = new Html5Qrcode("pickupQrReader");
        await pickupQrScannerInstance.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 200, height: 200 } },
            async (decodedText) => {
                stopPickupQrScanner();
                let cleanCode = (decodedText || '').trim().toUpperCase();
                if (cleanCode.includes('pickup=')) cleanCode = cleanCode.match(/pickup=([^&]+)/)?.[1] || cleanCode;
                cleanCode = cleanCode.replace(/[^A-Z0-9]/g, '').slice(0, 8);

                if (cleanCode && cleanCode.length >= 4) {
                    const input = document.getElementById('inputPickupCode');
                    if (input) input.value = cleanCode;
                    showToast(`📷 掃碼成功【${cleanCode}】，自動下載還原中...`, 'success', 2000);
                    // 掃碼成功直接自動發起下載還原，無需使用者再點擊下載按鈕
                    await fetchResultsByPickupCode();
                } else {
                    showToast('⚠️ 掃描內容非有效的取件碼！', 'warning', 3000);
                }
            },
            () => {}
        );
    } catch (err) {
        showToast('❌ 無法開啟相機鏡頭，請確認瀏覽器權限或手動輸入！', 'error', 4000);
        stopPickupQrScanner();
    }
}

function stopPickupQrScanner() {
    if (pickupQrScannerInstance) {
        pickupQrScannerInstance.stop().then(() => {
            pickupQrScannerInstance.clear();
            pickupQrScannerInstance = null;
        }).catch(() => {
            pickupQrScannerInstance = null;
        });
    }
    const scannerBox = document.getElementById('pickupQrScannerBox');
    const startBtn = document.getElementById('btnStartPickupQrScan');
    if (scannerBox) scannerBox.style.display = 'none';
    if (startBtn) startBtn.style.display = 'inline-flex';
}

async function fetchResultsByPickupCode() {
    const input = document.getElementById('inputPickupCode');
    const code = (input?.value || '').trim().toUpperCase();
    if (!code || code.length < 5) {
        showToast('⚠️ 請輸入正確的 6 位取件碼！', 'info');
        return;
    }

    addDebugLog(`📥 開始查詢 6 位取件碼【${code}】...`, 'info');
    showToast('⏳ 正在向雲端中繼站查詢取件碼...', 'info', 2000);
    let encryptedCipher = null;
    const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const pullRes = await fetch(`${workerEndpoint}/api/sync/pull?code=${encodeURIComponent(code)}`);
            const pullData = await pullRes.json().catch(() => ({}));
            if (pullRes.ok && pullData.success && pullData.cipher) {
                encryptedCipher = pullData.cipher;
                break;
            } else if (pullRes.status === 429) {
                showToast(`⚠️ ${pullData.error || '裝置冷卻中，請稍後重試！'}`, 'error', 5000);
                return;
            }
        } catch (netErr) {}
        if (!encryptedCipher && attempt === 0) {
            await new Promise(r => setTimeout(r, 600));
        }
    }

    const storageKey = `pickup_${code}`;
    if (!encryptedCipher) {
        const cachedItem = localStorage.getItem(storageKey);
        if (cachedItem) {
            try {
                encryptedCipher = JSON.parse(cachedItem).cipher;
                localStorage.removeItem(storageKey);
            } catch (e) {}
        }
    }

    if (!encryptedCipher) {
        addDebugLog(`❌ 查無取件碼【${code}】或資料已閱後即焚銷毀`, 'error');
        showToast('❌ 找不到該取件碼或資料已銷毀！請確認發送端是否已成功生成。', 'error', 4000);
        return;
    }

    try {
        showGlobalSyncOverlay('📥 正在還原車籍資料...', '已取回加密密文，正在進行本地 AES-256 解密與照片還原...');
        const rawJsonStr = await DualTrackSync.decryptDataWithCode(encryptedCipher, code);
        const items = JSON.parse(rawJsonStr);

        const existingPlates = new Set(
            state.queue.map(q => (q.result?.plate_number || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean)
        );

        let addedCount = 0;
        let duplicateCount = 0;

        items.forEach((it, idx) => {
            const plate = (it.result?.plate_number || '').trim();
            const cleanPlate = plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (cleanPlate && existingPlates.has(cleanPlate)) {
                duplicateCount++;
                return;
            }
            if (cleanPlate) existingPlates.add(cleanPlate);

            state.queue.push({
                id: 'restored_' + Date.now() + '_' + idx,
                file: null,
                fileName: it.fileName || `雲端同步_${idx + 1}.jpg`,
                status: 'success',
                result: it.result,
                dataUrl: it.dataUrl || null,
                isCropped: true,
                hasManualCropped: true,
                scale: 1.0,
                panX: 0,
                panY: 0,
                rotation: 0,
                errorMsg: '',
                elapsedTime: 0.8
            });
            addedCount++;
        });

        localStorage.removeItem(storageKey);
        updateQueueUI();
        switchMobileTab('results');

        if (addedCount === 0 && duplicateCount > 0) {
            showGlobalSyncOverlay('⚠️ 略過重複', `取件之 ${duplicateCount} 筆車號已存在於工作區，全數略過！`, 'warning');
            await new Promise(r => setTimeout(r, 1500));
            hideGlobalSyncOverlay();
            closeSyncModal();
            showToast(`⚠️ 所取件之 ${duplicateCount} 筆車號已在清單中，已全數略過重複！`, 'warning', 5000);
            return;
        }

        showGlobalSyncOverlay('🎉 還原完成！', `已成功取回並載入 ${addedCount} 筆車籍資料！`, 'success');
        await new Promise(r => setTimeout(r, 1200));
        hideGlobalSyncOverlay();
        closeSyncModal();
        showToast(`🎉 成功取回 ${addedCount} 筆車籍資料！`, 'success', 5000);
    } catch (err) {
        hideGlobalSyncOverlay();
        showToast('❌ 解密失敗，取件碼可能不正確或資料已損毀！', 'error', 4000);
    }
}

// 接收端出示配對 QR Code (WebRTC P2P + HTTPS 雙軌)
function refreshPairingQrCode() {
    const container = document.getElementById('pairingQrContainer');
    const displayCodeEl = document.getElementById('displayPairSessionCode');
    const statusText = document.getElementById('qrStatusText');
    const gsnNoticeBox = document.getElementById('protectedNetworkNotice');
    if (!container) return;

    stopPairingListener();

    container.innerHTML = '';
    container.style.opacity = '1';
    if (gsnNoticeBox) gsnNoticeBox.style.display = 'none';

    DualTrackSync.detectNetworkEnvironment((isProtected) => {
        if (isProtected && gsnNoticeBox) {
            gsnNoticeBox.style.display = 'block';
            addDebugLog('🛡️ 偵測到受保護網路環境 (UDP 受阻)，傳輸由雲端通道安全中繼', 'info');
        }
    });

    const randomHex = Math.random().toString(36).substr(2, 4).toUpperCase();
    const peerToken = 'LIC_' + randomHex;
    activePeerSessionId = peerToken;

    if (displayCodeEl) displayCodeEl.textContent = peerToken;

    const currentUrl = window.location.href.split('?')[0].split('#')[0];
    const syncUrl = currentUrl + '?peer=' + peerToken;

    if (typeof QRCode !== 'undefined') {
        new QRCode(container, {
            text: syncUrl,
            width: 170,
            height: 170,
            colorDark: "#0f172a",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    }

    pairingRemainingSeconds = 300;
    const formatTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    if (statusText) statusText.innerHTML = `等待發送端掃碼 (<span style="color: var(--brand-primary); font-weight: 700;">⏱️ ${formatTime(pairingRemainingSeconds)}</span>)`;

    let isReceivedDone = false;

    const processReceivedItems = async (items, sourceName) => {
        if (isReceivedDone) return;
        isReceivedDone = true;
        stopPairingListener();
        closeReceiveModal();

        showGlobalSyncOverlay('📥 正在接收跨裝置車籍...', `已透過【${sourceName}】建立連線！正在載入車籍與照片...`);

        const existingPlates = new Set(
            state.queue.map(q => (q.result?.plate_number || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean)
        );

        let addedCount = 0;
        let duplicateCount = 0;

        items.forEach((it, idx) => {
            const plate = (it.result?.plate_number || '').trim();
            const cleanPlate = plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (cleanPlate && existingPlates.has(cleanPlate)) {
                duplicateCount++;
                return;
            }
            if (cleanPlate) existingPlates.add(cleanPlate);

            state.queue.push({
                id: 'dual_sync_' + Date.now() + '_' + idx,
                file: null,
                fileName: it.fileName || ('跨端直傳_' + (idx + 1) + '.jpg'),
                status: 'success',
                result: it.result,
                dataUrl: it.dataUrl || null,
                isCropped: true,
                hasManualCropped: true,
                scale: 1.0,
                panX: 0,
                panY: 0,
                rotation: 0,
                errorMsg: '',
                elapsedTime: 0.1
            });
            addedCount++;
        });

        updateQueueUI();
        switchMobileTab('results');

        showGlobalSyncOverlay('🎉 接收完成！', `已成功透過 ${sourceName} 載入 ${addedCount} 筆車籍與實體照片！`, 'success');
        await new Promise(r => setTimeout(r, 1500));
        hideGlobalSyncOverlay();
        showToast(`🎉 收到發送端透過 ${sourceName} 直傳的 ${addedCount} 筆車籍資料！`, 'success', 6000);
    };

    pairingCountdownTimer = setInterval(() => {
        pairingRemainingSeconds--;
        if (pairingRemainingSeconds <= 0) {
            stopPairingListener();
            if (statusText) statusText.innerHTML = '<span style="color: #ef4444; font-weight: 700;">⚠️ 配對碼已過期失效</span>，請重新整理！';
            container.style.opacity = '0.25';
            return;
        }
        if (statusText) statusText.innerHTML = `等待發送端掃碼 (<span style="color: var(--brand-primary); font-weight: 700;">⏱️ ${formatTime(pairingRemainingSeconds)}</span>)`;
    }, 1000);

    // 軌道 A：WebRTC P2P
    if (typeof Peer !== 'undefined') {
        try {
            receiverPeerInstance = new Peer(peerToken, {
                debug: 0,
                config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] }
            });
            receiverPeerInstance.on('connection', (conn) => {
                conn.on('data', async (raw) => {
                    let items = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : [raw]);
                    await processReceivedItems(items, 'WebRTC P2P 直連');
                });
            });
        } catch (e) {}
    }

    // 軌道 B：Cloudflare HTTPS 備援輪詢
    const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
    pairingPollingTimer = setInterval(async () => {
        if (isReceivedDone || document.hidden) return;
        try {
            const res = await fetch(`${workerEndpoint}/api/sync/pull?code=${encodeURIComponent(peerToken)}&wait=1`, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json().catch(() => null);
            if (data && data.success && data.cipher) {
                const decryptedStr = await DualTrackSync.decryptDataWithCode(data.cipher, peerToken);
                let items = JSON.parse(decryptedStr);
                if (!Array.isArray(items)) items = [items];
                await processReceivedItems(items, 'Cloudflare HTTPS 443 備援');
            }
        } catch (err) {}
    }, 1200);
}

function stopPairingListener() {
    if (pairingPollingTimer) { clearInterval(pairingPollingTimer); pairingPollingTimer = null; }
    if (pairingCountdownTimer) { clearInterval(pairingCountdownTimer); pairingCountdownTimer = null; }
    if (receiverPeerInstance) {
        try { receiverPeerInstance.destroy(); } catch (e) {}
        receiverPeerInstance = null;
    }
}

async function sendCurrentResultsToPairSession(targetSession) {
    const sessionInput = document.getElementById('inputTargetPairSession');
    let session = (targetSession || sessionInput?.value || '').trim().toUpperCase();
    if (!session) {
        showToast('⚠️ 請輸入接收端配對代碼 (例如: LIC_XXXX)！', 'warning', 3000);
        return;
    }

    if (!session.startsWith('LIC_') && !session.startsWith('PAIR_') && session.length >= 4) {
        session = 'LIC_' + session;
    }

    const successItems = state.queue.filter(x => x.status === 'success' && x.result);
    if (successItems.length === 0) {
        showToast('⚠️ 目前無辨識成功資料可傳送！', 'warning');
        return;
    }

    const payload = successItems.map(it => ({
        fileName: it.fileName,
        result: it.result,
        dataUrl: it.dataUrl || null
    }));

    showGlobalSyncOverlay('🚀 正在傳送車籍資料...', `正在啟動雙軌傳輸至接收端【${session}】...`);

    // 軌道 A：WebRTC P2P
    if (typeof Peer !== 'undefined') {
        try {
            const senderPeer = new Peer({ debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } });
            senderPeer.on('open', () => {
                const conn = senderPeer.connect(session, { reliable: true });
                conn.on('open', () => {
                    conn.send(payload);
                    addDebugLog('⚡ WebRTC P2P 隧道直傳成功！', 'success');
                });
            });
        } catch (e) {}
    }

    // 軌道 B：Cloudflare HTTPS
    try {
        const cipher = await DualTrackSync.encryptDataWithCode(JSON.stringify(payload), session);
        const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
        await fetch(`${workerEndpoint}/api/sync/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: session, cipher: cipher, createdAt: Date.now() })
        });
        addDebugLog('☁️ 雲端備援封包已同步安全送達！', 'info');
    } catch (err) {}

    setTimeout(() => {
        showGlobalSyncOverlay('🎉 傳送完成！', `已成功將 ${payload.length} 筆車籍送出！`, 'success');
        setTimeout(() => {
            hideGlobalSyncOverlay();
            closeShareModal();
        }, 1200);
        showToast(`🎉 成功傳送 ${payload.length} 筆車籍至接收端！`, 'success', 5000);
    }, 1300);
}

// 網頁內啟動相機掃描 QR Code
async function startInPageQrScanner() {
    const scannerBox = document.getElementById('inPageQrScannerBox');
    const startBtn = document.getElementById('btnStartQrScan');
    if (!scannerBox) return;

    if (typeof Html5Qrcode === 'undefined') {
        showToast('⚠️ 掃描組件載入中，請稍候重試！', 'warning');
        return;
    }

    scannerBox.style.display = 'block';
    if (startBtn) startBtn.style.display = 'none';

    try {
        inPageQrScannerInstance = new Html5Qrcode("inPageQrReader");
        await inPageQrScannerInstance.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 230, height: 230 } },
            async (decodedText) => {
                stopInPageQrScanner();
                let pairCode = decodedText;
                if (decodedText.includes('peer=')) pairCode = decodedText.match(/peer=([^&]+)/)?.[1] || pairCode;
                else if (decodedText.includes('pair=')) pairCode = decodedText.match(/pair=([^&]+)/)?.[1] || pairCode;

                if (pairCode.startsWith('LIC_') || pairCode.startsWith('PAIR_') || pairCode.length >= 4) {
                    await sendCurrentResultsToPairSession(pairCode);
                } else {
                    showToast('⚠️ 未辨識出有效的配對代碼！', 'warning', 3000);
                }
            },
            () => {}
        );
    } catch (err) {
        showToast('❌ 無法開啟相機，請確認權限或手動輸入配對碼！', 'error', 5000);
        stopInPageQrScanner();
    }
}

function stopInPageQrScanner() {
    if (inPageQrScannerInstance) {
        inPageQrScannerInstance.stop().then(() => {
            inPageQrScannerInstance.clear();
            inPageQrScannerInstance = null;
        }).catch(() => {
            inPageQrScannerInstance = null;
        });
    }
    const scannerBox = document.getElementById('inPageQrScannerBox');
    const startBtn = document.getElementById('btnStartQrScan');
    if (scannerBox) scannerBox.style.display = 'none';
    if (startBtn) startBtn.style.display = 'inline-flex';
}

// 📂 本地 Excel 報表匯入還原
function handleExcelFileInput(event) {
    const file = event.target.files && event.target.files[0];
    if (file) parseAndImportExcelFile(file);
    event.target.value = '';
}

function handleExcelDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) parseAndImportExcelFile(file);
}

function getCleanExcelCellValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') {
        if (val.text !== undefined) return String(val.text).trim();
        if (val.result !== undefined) return String(val.result).trim();
        if (Array.isArray(val.richText)) return val.richText.map(r => r.text || '').join('').trim();
    }
    return String(val).trim();
}

async function parseAndImportExcelFile(file) {
    if (isExcelImporting) return;
    isExcelImporting = true;
    const fileName = file.name || `Excel報表_${Date.now()}.xlsx`;
    showToast('📊 正在讀取 Excel 報表與實體照片...', 'info', 2000);

    try {
        const arrayBuffer = await file.arrayBuffer();
        let importedItems = [];

        if (window.ExcelJS) {
            try {
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(arrayBuffer);
                const mediaMap = {};
                if (workbook.media && workbook.media.length > 0) {
                    workbook.media.forEach((m, idx) => {
                        if (m.buffer) {
                            try {
                                const bytes = new Uint8Array(m.buffer);
                                let binary = '';
                                for (let i = 0; i < bytes.length; i += 8192) {
                                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                                }
                                const mime = (m.extension === 'jpg' || m.extension === 'jpeg') ? 'image/jpeg' : 'image/png';
                                mediaMap[idx] = `data:${mime};base64,${btoa(binary)}`;
                            } catch (e) {}
                        }
                    });
                }

                const summaryWs = workbook.worksheets.find(w => w.name && (w.name.includes('總表') || w.name.includes('清冊'))) || workbook.worksheets[0];
                if (summaryWs) {
                    const headers = [];
                    summaryWs.getRow(1).eachCell((cell, colNumber) => { headers[colNumber] = getCleanExcelCellValue(cell.value); });
                    summaryWs.eachRow((row, rowNumber) => {
                        if (rowNumber === 1) return;
                        const rowData = {};
                        row.eachCell((cell, colNumber) => {
                            const key = headers[colNumber];
                            if (key) rowData[key] = getCleanExcelCellValue(cell.value);
                        });

                        const plateNumber = rowData['牌照號碼'] || rowData['車牌'] || '';
                        if (!plateNumber && !rowData['車主名稱']) return;

                        let matchedPhotoUrl = null;
                        const singleCarWs = workbook.worksheets.find(w => w !== summaryWs && w.name && w.name.includes(plateNumber));
                        if (singleCarWs && typeof singleCarWs.getImages === 'function') {
                            const images = singleCarWs.getImages();
                            if (images?.[0]?.imageId !== undefined) matchedPhotoUrl = mediaMap[images[0].imageId];
                        }
                        if (!matchedPhotoUrl && mediaMap[rowNumber - 2]) matchedPhotoUrl = mediaMap[rowNumber - 2];

                        importedItems.push({
                            fileName: rowData['檔案名稱'] || `${fileName}_第${rowNumber - 1}筆.jpg`,
                            result: {
                                is_valid_license: true, rejection_reason: '', plate_number: plateNumber,
                                vehicle_type: rowData['車輛種類'] || '', special_type: rowData['特殊車種'] || '',
                                body_style: rowData['車身式樣'] || '', extra_equipment: rowData['附加配備'] || '',
                                owner: rowData['車主名稱'] || '', address: rowData['住址'] || '',
                                brand: rowData['廠牌'] || '', model: rowData['型式'] || '',
                                manufacture_date: rowData['出廠年月'] || '', displacement: rowData['排氣量(c.c.)'] || '',
                                fuel_type: rowData['燃料種類'] || '', color: rowData['車色'] || '',
                                engine_number: rowData['引擎號碼'] || '', vin: rowData['車身號碼(VIN)'] || '',
                                capacity_sit: Number(rowData['載運人數(座)']) || 0, capacity_stand: Number(rowData['載運人數(立)']) || 0,
                                capacity_driver: Number(rowData['載運人數(駕駛室)']) || 0, load_weight: rowData['載重量(公噸)'] || '',
                                total_weight: rowData['總重量(公噸)'] || '', towing_weight: Number(rowData['曳引總重(公噸)']) || 0,
                                lessee: rowData['服務公司或承租人'] || '', original_issue_date_roc: rowData['原發照日期(民國)'] || '',
                                original_issue_date_ad: rowData['原發照日期(西元)'] || '', renew_issue_date_roc: rowData['換補照日期(民國)'] || '',
                                renew_issue_date_ad: rowData['換補照日期(西元)'] || ''
                            },
                            dataUrl: matchedPhotoUrl
                        });
                    });
                }
            } catch (e) {}
        }

        if (importedItems.length === 0) {
            showToast('⚠️ 未能從 Excel 中解析出符合格式的車籍資料！', 'warning', 4000);
            return;
        }

        const existingPlates = new Set(
            state.queue.map(q => (q.result?.plate_number || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean)
        );

        let addedCount = 0;
        importedItems.forEach((it, idx) => {
            const cleanPlate = (it.result?.plate_number || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (cleanPlate && existingPlates.has(cleanPlate)) return;
            if (cleanPlate) existingPlates.add(cleanPlate);

            state.queue.push({
                id: 'excel_' + Date.now() + '_' + idx,
                file: null,
                fileName: it.fileName,
                status: 'success',
                result: it.result,
                dataUrl: it.dataUrl || null,
                isCropped: true,
                hasManualCropped: true,
                scale: 1.0,
                panX: 0,
                panY: 0,
                rotation: 0,
                errorMsg: '',
                elapsedTime: 0.2
            });
            addedCount++;
        });

        updateQueueUI();
        switchMobileTab('results');
        closeReceiveModal();
        addDebugLog(`🎉 成功從 Excel【${fileName}】解析還原 ${addedCount} 筆車籍資料與實體照片！`, 'success');
        showToast(`🎉 成功從 Excel 匯入並還原 ${addedCount} 筆車籍與照片！`, 'success', 5000);
    } catch (err) {
        addDebugLog(`❌ Excel 解析例外: ${err.message}`, 'error');
        showToast(`❌ Excel 解析例外: ${err.message}`, 'error');
    } finally {
        isExcelImporting = false;
    }
}

// Modal 控制器
function openReceiveModal() {
    const modal = document.getElementById('receiveModal');
    if (modal) {
        modal.classList.add('active');
        switchReceiveMode('pickup');
    }
}

function closeReceiveModal() {
    const modal = document.getElementById('receiveModal');
    if (modal) modal.classList.remove('active');
    stopPairingListener();
}

function switchReceiveMode(mode) {
    const tabPickup = document.getElementById('receiveTabPickup');
    const tabQr = document.getElementById('receiveTabQr');
    const tabExcel = document.getElementById('receiveTabExcel');
    const contentPickup = document.getElementById('receiveContentPickup');
    const contentQr = document.getElementById('receiveContentQr');
    const contentExcel = document.getElementById('receiveContentExcel');

    if (tabPickup) tabPickup.classList.toggle('active', mode === 'pickup');
    if (tabQr) tabQr.classList.toggle('active', mode === 'qr');
    if (tabExcel) tabExcel.classList.toggle('active', mode === 'excel');
    if (contentPickup) contentPickup.style.display = mode === 'pickup' ? 'block' : 'none';
    if (contentQr) contentQr.style.display = mode === 'qr' ? 'block' : 'none';
    if (contentExcel) contentExcel.style.display = mode === 'excel' ? 'block' : 'none';

    if (mode === 'qr') refreshPairingQrCode();
    else stopPairingListener();
}

function openShareModal() {
    const successItems = state.queue.filter(x => x.status === 'success' && x.result);
    if (successItems.length === 0) {
        showToast('⚠️ 目前尚無辨識成功的車籍資料！', 'warning', 4000);
        return;
    }
    const modal = document.getElementById('shareModal');
    if (modal) {
        modal.classList.add('active');
        switchShareMode('pickup');
    }
}

function closeShareModal() {
    const modal = document.getElementById('shareModal');
    if (modal) modal.classList.remove('active');
    stopPickupStatusMonitor();
    stopInPageQrScanner();
}

function switchShareMode(mode) {
    const tabPickup = document.getElementById('shareTabPickup');
    const tabQr = document.getElementById('shareTabQr');
    const contentPickup = document.getElementById('shareContentPickup');
    const contentQr = document.getElementById('shareContentQr');

    if (tabPickup) tabPickup.classList.toggle('active', mode === 'pickup');
    if (tabQr) tabQr.classList.toggle('active', mode === 'qr');
    if (contentPickup) contentPickup.style.display = mode === 'pickup' ? 'block' : 'none';
    if (contentQr) contentQr.style.display = mode === 'qr' ? 'block' : 'none';

    if (mode !== 'qr') stopInPageQrScanner();
}

function openSyncModal() { openShareModal(); }
function closeSyncModal() { closeReceiveModal(); closeShareModal(); }

function showGlobalSyncOverlay(title, desc, status = 'loading') {
    const overlay = document.getElementById('globalSyncOverlay');
    const titleEl = document.getElementById('globalSyncTitle');
    const descEl = document.getElementById('globalSyncDesc');
    const iconEl = document.getElementById('globalSyncIcon');
    if (!overlay) return;
    if (title && titleEl) titleEl.textContent = title;
    if (desc && descEl) descEl.textContent = desc;
    if (iconEl) iconEl.className = status === 'success' ? 'fa-solid fa-circle-check text-success fa-bounce' : 'fa-solid fa-arrows-rotate fa-spin';
    overlay.classList.add('active');
    overlay.style.display = 'flex';
}

function hideGlobalSyncOverlay() {
    const overlay = document.getElementById('globalSyncOverlay');
    if (overlay) {
        overlay.classList.remove('active');
        overlay.style.display = 'none';
    }
}

// ==========================================
// 6. 設定視窗與輔助工具
// ==========================================
function selectProvider(type) {
    state.providerType = type;
    localStorage.setItem('license_provider_type', type);

    const cardDefault = document.getElementById('providerCardDefault');
    const cardGemini = document.getElementById('providerCardGemini');
    const cardOpenAi = document.getElementById('providerCardOpenAi');
    if (cardDefault) cardDefault.classList.toggle('active', type === 'default');
    if (cardGemini) cardGemini.classList.toggle('active', type === 'gemini');
    if (cardOpenAi) cardOpenAi.classList.toggle('active', type === 'openai');

    const secDefault = document.getElementById('sectionProviderDefault');
    const secGemini = document.getElementById('sectionProviderGemini');
    const secOpenAi = document.getElementById('sectionProviderOpenAi');
    if (secDefault) secDefault.style.display = (type === 'default') ? 'block' : 'none';
    if (secGemini) secGemini.style.display = (type === 'gemini') ? 'block' : 'none';
    if (secOpenAi) secOpenAi.style.display = (type === 'openai') ? 'block' : 'none';
}

function applyOpenAiPreset(presetKey) {
    const presets = {
        'openai': { name: 'OpenAI 官方 (gpt-4o-mini)', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
        'ollama': { name: '本地 Ollama (llama3.2-vision)', url: 'http://localhost:11434/v1', model: 'llama3.2-vision:11b', key: '' },
        'openrouter': { name: 'OpenRouter 聚合平台', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.2-11b-vision-instruct:free' },
        'lmstudio': { name: '本地 LM Studio', url: 'http://localhost:1234/v1', model: 'llama-3.2-11b-vision-instruct', key: '' }
    };
    const conf = presets[presetKey];
    if (!conf) return;

    const urlInput = document.getElementById('openaiBaseUrlInput');
    const modelInput = document.getElementById('openaiModelInput');
    const keyInput = document.getElementById('openaiApiKeyInput');

    if (urlInput) urlInput.value = conf.url;
    if (modelInput) modelInput.value = conf.model;
    if (conf.key !== undefined && keyInput) keyInput.value = conf.key;

    state.openaiBaseUrl = conf.url;
    state.openaiModel = conf.model;
    if (conf.key !== undefined) state.openaiApiKey = conf.key;

    localStorage.setItem('license_openai_base_url', state.openaiBaseUrl);
    localStorage.setItem('license_openai_model', state.openaiModel);
    if (conf.key !== undefined) localStorage.setItem('license_openai_api_key', state.openaiApiKey);

    showToast(`🚀 已套用【${conf.name}】快捷模板！`, 'info', 3000);
}

function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;

    const workerUrlInput = document.getElementById('workerUrlInput');
    const customApiKeyInput = document.getElementById('customApiKeyInput');
    const openaiBaseUrlInput = document.getElementById('openaiBaseUrlInput');
    const openaiApiKeyInput = document.getElementById('openaiApiKeyInput');
    const openaiModelInput = document.getElementById('openaiModelInput');

    if (workerUrlInput) workerUrlInput.value = state.workerUrl || '';
    if (customApiKeyInput) customApiKeyInput.value = state.apiKey || '';
    if (openaiBaseUrlInput) openaiBaseUrlInput.value = state.openaiBaseUrl || 'http://localhost:11434/v1';
    if (openaiApiKeyInput) openaiApiKeyInput.value = state.openaiApiKey || '';
    if (openaiModelInput) openaiModelInput.value = state.openaiModel || 'llama3.2-vision:11b';

    selectProvider(state.providerType || 'default');
    modal.classList.add('active');
}

function closeSettingsModal() {
    const workerUrlInput = document.getElementById('workerUrlInput');
    const customApiKeyInput = document.getElementById('customApiKeyInput');
    const openaiBaseUrlInput = document.getElementById('openaiBaseUrlInput');
    const openaiApiKeyInput = document.getElementById('openaiApiKeyInput');
    const openaiModelInput = document.getElementById('openaiModelInput');

    if (workerUrlInput) { state.workerUrl = workerUrlInput.value.trim(); localStorage.setItem('license_ocr_worker_url', state.workerUrl); }
    if (customApiKeyInput) { state.apiKey = customApiKeyInput.value.trim(); localStorage.setItem('license_ocr_api_key', state.apiKey); }
    if (openaiBaseUrlInput) { state.openaiBaseUrl = openaiBaseUrlInput.value.trim() || 'http://localhost:11434/v1'; localStorage.setItem('license_openai_base_url', state.openaiBaseUrl); }
    if (openaiApiKeyInput) { state.openaiApiKey = openaiApiKeyInput.value.trim(); localStorage.setItem('license_openai_api_key', state.openaiApiKey); }
    if (openaiModelInput) { state.openaiModel = openaiModelInput.value.trim() || 'llama3.2-vision:11b'; localStorage.setItem('license_openai_model', state.openaiModel); }

    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('active');
}

function saveSettings() {
    closeSettingsModal();
    showToast('✅ 系統設定已成功儲存！', 'success', 3000);
}

function toggleCustomWorkerUrl() {
    const container = document.getElementById('customWorkerContainer');
    if (container) container.style.display = (container.style.display === 'none' || !container.style.display) ? 'block' : 'none';
}

function clearWorkerUrl() {
    const input = document.getElementById('workerUrlInput');
    if (input) input.value = '';
    state.workerUrl = '';
    localStorage.removeItem('license_ocr_worker_url');
    showToast('已恢復系統預設代理通道', 'info');
}

function clearApiKey() {
    const input = document.getElementById('customApiKeyInput');
    if (input) input.value = '';
    state.apiKey = '';
    localStorage.removeItem('license_ocr_api_key');
    showToast('已清空個人 Gemini API Key', 'info');
}

function triggerCameraInput() {
    const cameraInput = document.getElementById('cameraInput');
    if (cameraInput) { cameraInput.value = ''; cameraInput.click(); }
}

function triggerFileInput() {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) { fileInput.value = ''; fileInput.click(); }
}

function switchMobileTab(tab) {
    const tabQueue = document.getElementById('tabBtnQueue');
    const tabResults = document.getElementById('tabBtnResults');
    const leftCard = document.getElementById('leftWorkspaceCard');
    const rightCard = document.getElementById('rightWorkspaceCard');
    const groupQueue = document.getElementById('bottomGroupQueue');
    const groupResults = document.getElementById('bottomGroupResults');
    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
        if (tab === 'queue') {
            if (tabQueue) tabQueue.classList.add('active');
            if (tabResults) tabResults.classList.remove('active');
            if (leftCard) leftCard.style.display = 'flex';
            if (rightCard) rightCard.style.display = 'none';
            if (groupQueue) groupQueue.style.display = 'flex';
            if (groupResults) groupResults.style.display = 'none';
            document.getElementById('step1Item')?.classList.add('active');
        } else {
            if (tabQueue) tabQueue.classList.remove('active');
            if (tabResults) tabResults.classList.add('active');
            if (leftCard) leftCard.style.display = 'none';
            if (rightCard) rightCard.style.display = 'flex';
            if (groupQueue) groupQueue.style.display = 'none';
            if (groupResults) groupResults.style.display = 'flex';
            document.getElementById('step3Item')?.classList.add('active');
        }
    } else {
        // 🌟 PC 桌面端：雙卡片永遠並列常駐顯示，絕不隱藏任何一邊！
        if (leftCard) leftCard.style.display = 'flex';
        if (rightCard) rightCard.style.display = 'flex';
        if (tab === 'queue') {
            document.getElementById('step1Item')?.classList.add('active');
        } else {
            document.getElementById('step4Item')?.classList.add('active');
        }
    }

    if (navigator.vibrate) {
        try { navigator.vibrate(15); } catch (e) { }
    }
}

// 響應視窗尺寸變更時自動重置雙欄顯示
window.addEventListener('resize', () => {
    const leftCard = document.getElementById('leftWorkspaceCard');
    const rightCard = document.getElementById('rightWorkspaceCard');
    const groupQueue = document.getElementById('bottomGroupQueue');
    const groupResults = document.getElementById('bottomGroupResults');
    const isMobile = window.innerWidth <= 768;

    if (!isMobile) {
        if (leftCard) leftCard.style.display = 'flex';
        if (rightCard) rightCard.style.display = 'flex';
        updateBottomActionBar(state.queue.length, state.queue.filter(x => x.status === 'success').length);
    } else {
        const isResultsTab = document.getElementById('tabBtnResults')?.classList.contains('active');
        if (isResultsTab) {
            if (leftCard) leftCard.style.display = 'none';
            if (rightCard) rightCard.style.display = 'flex';
            if (groupQueue) groupQueue.style.display = 'none';
            if (groupResults) groupResults.style.display = 'flex';
        } else {
            if (leftCard) leftCard.style.display = 'flex';
            if (rightCard) rightCard.style.display = 'none';
            if (groupQueue) groupQueue.style.display = 'flex';
            if (groupResults) groupResults.style.display = 'none';
        }
    }
});

async function fetchLiveStats() {
    try {
        const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
        const res = await fetch(`${workerEndpoint}/api/stats/view`).catch(() => null);
        if (res && res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data.views !== undefined) {
                const views = parseInt(data.views, 10) || 0;
                const elViews = document.getElementById('statLiveViews');
                if (elViews) elViews.textContent = views.toLocaleString();
            }
            if (data.processed !== undefined) {
                const elProc = document.getElementById('statLiveProcessed');
                if (elProc) elProc.textContent = Number(data.processed).toLocaleString();
            }
        }
    } catch (e) {}
}

async function recordProcessedStats(count) {
    if (!count || count <= 0) return;
    const elProc = document.getElementById('statLiveProcessed');
    if (elProc) {
        const cur = parseInt(elProc.textContent.replace(/,/g, ''), 10) || 0;
        elProc.textContent = (cur + count).toLocaleString();
    }
    try {
        const workerEndpoint = (state.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
        fetch(`${workerEndpoint}/api/stats/increment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ count })
        }).catch(() => {});
    } catch (e) {}
}

// 顯式掛載 HTML 與全局事件調用
window.confirmCropImage = confirmCropImage;
window.reEditCropImage = reEditCropImage;
window.enableCropEdit = enableCropEdit;
window.zoomCardImage = zoomCardImage;
window.rotateCardImage = rotateCardImage;
window.resetCardImage = resetCardImage;
window.previewLargeImage = previewLargeImage;
window.removeQueueItem = removeQueueItem;
window.clearQueue = clearQueue;
window.exportBatchExcel = exportBatchExcel;
window.exportBatchJson = exportBatchJson;
window.startBatchProcessing = startBatchProcessing;
window.cancelBatchProcessing = cancelBatchProcessing;
window.copyText = copyText;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.selectProvider = selectProvider;
window.applyOpenAiPreset = applyOpenAiPreset;
window.toggleCustomWorkerUrl = toggleCustomWorkerUrl;
window.clearWorkerUrl = clearWorkerUrl;
window.clearApiKey = clearApiKey;
window.saveSettings = saveSettings;
window.openReceiveModal = openReceiveModal;
window.closeReceiveModal = closeReceiveModal;
window.switchReceiveMode = switchReceiveMode;
window.openShareModal = openShareModal;
window.closeShareModal = closeShareModal;
window.switchShareMode = switchShareMode;
window.openSyncModal = openSyncModal;
window.closeSyncModal = closeSyncModal;
window.generatePickupCode = generatePickupCode;
window.copyCurrentPickupCode = copyCurrentPickupCode;
window.revokeCurrentPickupCode = revokeCurrentPickupCode;
window.startPickupQrScanner = startPickupQrScanner;
window.stopPickupQrScanner = stopPickupQrScanner;
window.fetchResultsByPickupCode = fetchResultsByPickupCode;
window.refreshPairingQrCode = refreshPairingQrCode;
window.triggerFileInput = triggerFileInput;
window.triggerCameraInput = triggerCameraInput;
window.handleFileSelected = handleFileSelected;
window.switchMobileTab = switchMobileTab;
window.handleExcelFileInput = handleExcelFileInput;
window.handleExcelDrop = handleExcelDrop;
window.startInPageQrScanner = startInPageQrScanner;
window.stopInPageQrScanner = stopInPageQrScanner;
window.sendCurrentResultsToPairSession = sendCurrentResultsToPairSession;
window.fetchLiveStats = fetchLiveStats;
window.recordProcessedStats = recordProcessedStats;
