/**
 * LicenseOCR - CV Analyzer Plugin (行照影像前處理與畫質檢核插件)
 * 
 * 核心職責：
 * 1. 影像畫質與壓縮率自動把關 (Quality Gatekeeper)
 * 2. 局部空間雜訊熵量化演算法 (Local Noise Entropy - 專抓蜂巢網點碎裂/失真)
 * 3. 48 網格行照有效內容與密度分析 (48-Grid Content Density Analysis - 專抓縮太小/空白紙張)
 * 
 * 授權協議：CC BY-NC-SA 4.0
 */

// 影像畫質與壓縮率自動分析 (Quality Gatekeeper)
function analyzeImageQuality(img, file) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const totalPixels = width * height;
    const fileSize = file ? file.size : 0;

    // 1. 絕對解析度過低檢測 (短邊 < 280px 或 總像素 < 100,000，約 0.1 MP)
    if (width < 280 || height < 280 || totalPixels < 100000) {
        return {
            isValid: false,
            reason: `解析度過低 (${width}×${height}，僅 ${(totalPixels / 10000).toFixed(1)} 萬像素)`,
            detail: `圖片原始解析度僅 ${width}×${height} (0.04MP)，遠低於辨識極限 (需 ≥ 300px)，細小文字已嚴重混疊失真，系統自動拒絕處理！請手動移除並更換清晰圖檔。`
        };
    }

    // 2. 極端過度壓縮與低品質因數檢測 (檔案過小且解析度偏低)
    if (fileSize > 0 && fileSize < 30 * 1024 && totalPixels < 160000) {
        return {
            isValid: false,
            reason: `過度壓縮 (${(fileSize / 1024).toFixed(1)} KB)`,
            detail: `檔案壓縮率過高 (僅 ${(fileSize / 1024).toFixed(1)} KB)，JPEG 區塊效應失真嚴重，文字筆劃破碎無法保證辨識正確性，系統自動拒絕處理。`
        };
    }

    return { isValid: true };
}

// 前端 CV 物理把關 1：局部空間雜訊熵量化演算法 (Local Noise Entropy) - 專抓網點碎裂/失真
function calculateNoiseEntropy(canvas) {
    try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return 0;
        const W = canvas.width || 800;
        const H = canvas.height || 600;

        // 採樣中央 70% 區域 (避開外圍邊界黑邊)
        const cropX = Math.round(W * 0.15);
        const cropY = Math.round(H * 0.15);
        const cropW = Math.round(W * 0.70);
        const cropH = Math.round(H * 0.70);

        const imgData = ctx.getImageData(cropX, cropY, cropW, cropH).data;
        const gray = new Float32Array(cropW * cropH);
        for (let i = 0; i < gray.length; i++) {
            const idx = i * 4;
            gray[i] = 0.299 * imgData[idx] + 0.587 * imgData[idx + 1] + 0.114 * imgData[idx + 2];
        }

        let noiseFlips = 0;
        let sampleCount = 0;

        // 步進 2 加速運算 (耗時 < 1ms)
        for (let y = 2; y < cropH - 2; y += 2) {
            for (let x = 2; x < cropW - 2; x += 2) {
                const idx = y * cropW + x;
                const c = gray[idx];
                const left = gray[idx - 1];
                const right = gray[idx + 1];
                const top = gray[idx - cropW];
                const bottom = gray[idx + cropW];

                // 檢測水平與垂直像素是否在微小尺度發生高頻反覆劇烈跳變
                const isHorizontalFlip = (c - left) * (c - right) > 400 && Math.abs(c - left) > 20;
                const isVerticalFlip = (c - top) * (c - bottom) > 400 && Math.abs(c - top) > 20;

                if (isHorizontalFlip || isVerticalFlip) {
                    noiseFlips++;
                }
                sampleCount++;
            }
        }

        return sampleCount > 0 ? (noiseFlips / sampleCount) : 0;
    } catch (e) {
        console.warn('calculateNoiseEntropy failed:', e);
        return 0;
    }
}

// 前端 CV 物理把關 2：48 網格行照有效內容與密度分析 (48-Grid Content Density Analysis)
function checkContentCoverage(canvas) {
    try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return { isValid: true };
        const W = canvas.width || 800;
        const H = canvas.height || 600;
        const imgData = ctx.getImageData(0, 0, W, H).data;

        const GRID_COLS = 8;
        const GRID_ROWS = 6;
        const BLOCK_W = W / GRID_COLS; // 100px
        const BLOCK_H = H / GRID_ROWS; // 100px
        const TOTAL_BLOCKS = GRID_COLS * GRID_ROWS; // 48 blocks

        let activeBlocks = 0;

        for (let gy = 0; gy < GRID_ROWS; gy++) {
            for (let gx = 0; gx < GRID_COLS; gx++) {
                const startX = Math.round(gx * BLOCK_W);
                const startY = Math.round(gy * BLOCK_H);

                let sumGray = 0;
                let sumGraySq = 0;
                let sampleCount = 0;
                let greenOrBlueCount = 0;
                let darkBgCount = 0;

                // 採樣每個 100x100 網格內的像素 (步進 4)
                for (let y = startY + 4; y < startY + BLOCK_H - 4; y += 4) {
                    for (let x = startX + 4; x < startX + BLOCK_W - 4; x += 4) {
                        const idx = (y * W + x) * 4;
                        const r = imgData[idx];
                        const g = imgData[idx + 1];
                        const b = imgData[idx + 2];

                        if (r < 25 && g < 35 && b < 50) {
                            darkBgCount++;
                        }

                        if ((g > r + 6 && g > b + 2) || (b > r + 8)) {
                            greenOrBlueCount++;
                        }

                        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                        sumGray += gray;
                        sumGraySq += gray * gray;
                        sampleCount++;
                    }
                }

                if (sampleCount > 0) {
                    const mean = sumGray / sampleCount;
                    const variance = (sumGraySq / sampleCount) - (mean * mean);
                    const stdDev = Math.sqrt(Math.max(0, variance));

                    const hasDarkBg = (darkBgCount / sampleCount) > 0.05;
                    const hasLicenseColor = (greenOrBlueCount / sampleCount) > 0.12;
                    const hasTextOrTable = stdDev >= 16.0 && !hasDarkBg && mean < 250;

                    if (!hasDarkBg && (hasLicenseColor || hasTextOrTable)) {
                        activeBlocks++;
                    }
                }
            }
        }

        const coverageRatio = activeBlocks / TOTAL_BLOCKS;
        // 若有效行照內容佔比 < 28% ➔ 判定縮太小
        if (coverageRatio < 0.28) {
            return {
                isValid: false,
                reason: `偵測到有效行照區域在畫面中佔比過小 (僅約 ${(coverageRatio * 100).toFixed(0)}%)！請滾動滑鼠滾輪放大 1.5~2 倍將行照填滿畫面後，再按確認裁切！`
            };
        }
    } catch (e) {
        console.warn('checkContentCoverage failed:', e);
    }

    return { isValid: true };
}

// 掛載至命名空間與全域
window.CvAnalyzer = {
    analyzeImageQuality,
    calculateNoiseEntropy,
    checkContentCoverage
};

window.analyzeImageQuality = analyzeImageQuality;
window.calculateNoiseEntropy = calculateNoiseEntropy;
window.checkContentCoverage = checkContentCoverage;
