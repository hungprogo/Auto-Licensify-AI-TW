/**
 * LicenseOCR - Cloudflare Worker 中繼代理與 6 位取件碼同步模組
 * 
 * @version 1.5.0
 * 
 * 核心職責：
 * 1. 來源網域零信任白名單審查 (Origin / Referer 驗證)
 * 2. 注入台灣行照 System Instruction 與 JSON Schema 硬約束
 * 3. 安全轉發至 Google Gemini API 並提供模型熱自癒容災迴圈
 * 4. 跨裝置 6 位取件碼端對端加密暫存 (E2EE 閱後即焚)
 */

// 🔒 授權白名單網域 (嚴格全等來源比對)
const ALLOWED_ORIGINS = new Set([
    "https://hungprogo.github.io"
]);

// 🤖 允許呼叫之 Gemini 模型安全性判定 (嚴格限定官方 Flash 輕量免費層級，封鎖 Pro / Ultra 高額付費端點)
function isAllowedFlashModel(modelName) {
    if (!modelName || typeof modelName !== 'string') return false;
    const clean = modelName.trim().toLowerCase();
    // 支援當前 3.6-flash 以及未來 3.x/4.x flash 系列，拒絕任何 pro / ultra 參數
    return /^gemini-[34]\.[0-9]+-flash(-8b|-lite)?$/i.test(clean);
}

function isOriginAllowed(origin, referer) {
    const checkStr = (str) => {
        if (!str) return false;
        try {
            const parsed = new URL(str);
            return ALLOWED_ORIGINS.has(parsed.origin);
        } catch {
            return false;
        }
    };

    return checkStr(origin) || checkStr(referer);
}

// 全域記憶體暫存池 (當未綁定 Cloudflare KV 時自動以記憶體中繼)
globalThis.MEMORY_SYNC_STORE = globalThis.MEMORY_SYNC_STORE || new Map();
// 錯誤次數計數器 (防暴力猜測 6 位碼，連續錯誤 5 次冷卻 10 分鐘)
globalThis.RATE_LIMIT_STORE = globalThis.RATE_LIMIT_STORE || new Map();
// 全域 IP 請求頻率限制池 (防惡意腳本，每 IP 每分鐘最多 40 次)
globalThis.IP_REQUEST_LIMITS = globalThis.IP_REQUEST_LIMITS || new Map();

export default {
    async fetch(request, env, ctx) {
        // 支援 BYOK 自帶金鑰
        const customApiKey = request.headers.get("x-gemini-api-key");
        const origin = request.headers.get("Origin");
        const referer = request.headers.get("Referer");
        const clientIp = request.headers.get("CF-Connecting-IP") || "anonymous";
        const url = new URL(request.url);

        // 🛡️ 1. Payload 體積過大防護 (超過 8MB 直接阻斷，防止 Worker 記憶體溢出)
        const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
        if (contentLength > 8 * 1024 * 1024) {
            return new Response(JSON.stringify({ error: "⛔ 請求體積過大 (超過 8MB)" }), {
                status: 413,
                headers: { "Content-Type": "application/json" }
            });
        }

        // 🛡️ 2. 單一 IP 請求頻率防護 (AI 辨識限制每分鐘 40 次，同步輪詢支援高頻 300 次)
        const isSyncRoute = url.pathname.includes("/sync/");
        const maxLimit = isSyncRoute ? 300 : 40;

        const now = Date.now();
        const ipRecord = globalThis.IP_REQUEST_LIMITS.get(clientIp + (isSyncRoute ? '_sync' : '_ai')) || { count: 0, resetAt: now + 60000 };
        if (now > ipRecord.resetAt) {
            ipRecord.count = 0;
            ipRecord.resetAt = now + 60000;
        }
        ipRecord.count++;
        globalThis.IP_REQUEST_LIMITS.set(clientIp + (isSyncRoute ? '_sync' : '_ai'), ipRecord);

        if (ipRecord.count > maxLimit) {
            return new Response(JSON.stringify({ error: "⚠️ 請求過於頻繁，請稍後再試 (Rate limit exceeded)！" }), {
                status: 429,
                headers: { "Content-Type": "application/json", "Retry-After": "60" }
            });
        }

        const corsHeaders = {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": isOriginAllowed(origin, referer) ? (origin || "https://hungprogo.github.io") : "https://hungprogo.github.io",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-gemini-api-key",
        };

        // 4. 處理 CORS 跨域 Preflight 請求
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    ...corsHeaders,
                    "Access-Control-Max-Age": "86400",
                },
            });
        }

        // ==========================================
        // 📊 作品展示動態計數器 (瀏覽次數與累計解析量)
        // ==========================================
        if (url.pathname === "/api/stats/view" || url.pathname === "/stats/view") {
            try {
                let views = 0;
                let processed = 0;
                const kv = env.COUNTER_KV || env.SYNC_KV;
                if (kv) {
                    const rawViews = await kv.get("visits_count");
                    const rawProcessed = await kv.get("processed_count");
                    let currentV = rawViews ? parseInt(rawViews, 10) : 0;
                    if (currentV >= 10000) currentV = 0; // 自動清除舊測試基數
                    views = currentV + 1;
                    processed = rawProcessed ? parseInt(rawProcessed, 10) : 0;
                    await kv.put("visits_count", views.toString());
                } else {
                    let currentV = globalThis.TOTAL_VIEWS || 0;
                    if (currentV >= 10000) currentV = 0;
                    globalThis.TOTAL_VIEWS = currentV + 1;
                    views = globalThis.TOTAL_VIEWS;
                    processed = globalThis.TOTAL_PROCESSED || 0;
                }
                return new Response(JSON.stringify({ success: true, views, processed }), { status: 200, headers: corsHeaders });
            } catch (err) {
                return new Response(JSON.stringify({ success: true, views: 0, processed: 0 }), { status: 200, headers: corsHeaders });
            }
        }

        if (url.pathname === "/api/stats/increment" || url.pathname === "/stats/increment") {
            try {
                const reqData = await request.json().catch(() => ({}));
                const count = parseInt(reqData.count || "1", 10);
                const kv = env.COUNTER_KV || env.SYNC_KV;
                let processed = 0;
                if (kv) {
                    const rawProcessed = await kv.get("processed_count");
                    processed = (rawProcessed ? parseInt(rawProcessed, 10) : 0) + count;
                    await kv.put("processed_count", processed.toString());
                } else {
                    globalThis.TOTAL_PROCESSED = (globalThis.TOTAL_PROCESSED || 0) + count;
                    processed = globalThis.TOTAL_PROCESSED;
                }
                return new Response(JSON.stringify({ success: true, processed }), { status: 200, headers: corsHeaders });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
            }
        }

        // ==========================================
        // 🔒 跨裝置 6 位取件碼與 QR 配對端對端加密中繼路由 (E2EE 閱後即焚)
        // ==========================================
        if (url.pathname === "/api/sync/push" || url.pathname === "/sync/push") {
            if (request.method !== "POST") {
                return new Response(JSON.stringify({ error: "只支援 POST 請求" }), { status: 405, headers: corsHeaders });
            }
            try {
                const reqData = await request.json();
                const { code, cipher, createdAt } = reqData;
                if (!code || !cipher) {
                    return new Response(JSON.stringify({ success: false, error: "缺少取件碼或密文資料" }), { status: 400, headers: corsHeaders });
                }
                const cleanCode = code.toUpperCase().trim();
                const storeKey = `sync_${cleanCode}`;
                const record = { cipher, createdAt: createdAt || Date.now() };

                if (env.SYNC_KV) {
                    await env.SYNC_KV.put(storeKey, JSON.stringify(record), { expirationTtl: 86400 });
                } else {
                    globalThis.MEMORY_SYNC_STORE.set(storeKey, record);
                }
                return new Response(JSON.stringify({ success: true, code: cleanCode }), { status: 200, headers: corsHeaders });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: "寫入中繼失敗: " + err.message }), { status: 500, headers: corsHeaders });
            }
        }

        if (url.pathname === "/api/sync/pull" || url.pathname === "/sync/pull") {
            let code = "";
            if (request.method === "GET") {
                code = url.searchParams.get("code") || "";
            } else if (request.method === "POST") {
                const reqData = await request.json().catch(() => ({}));
                code = reqData.code || "";
            }
            code = (code || "").toUpperCase().trim();
            if (!code || code.length < 4) {
                return new Response(JSON.stringify({ success: false, error: "請提供正確的取件碼或配對代碼" }), { status: 400, headers: corsHeaders });
            }

            const isPairSession = code.startsWith('LIC_') || code.startsWith('PAIR_') || url.searchParams.get("wait") === "1";

            const failRecord = globalThis.RATE_LIMIT_STORE.get(clientIp) || { count: 0, cooldownUntil: 0 };
            if (!isPairSession && failRecord.cooldownUntil > now) {
                const remainingMinutes = Math.ceil((failRecord.cooldownUntil - now) / 60000);
                return new Response(JSON.stringify({
                    success: false,
                    error: `連續錯誤次數過多，裝置保護冷卻中，請於 ${remainingMinutes} 分鐘後重試！`
                }), { status: 429, headers: corsHeaders });
            }

            const storeKey = `sync_${code}`;
            let record = null;

            if (env.SYNC_KV) {
                const kvVal = await env.SYNC_KV.get(storeKey);
                if (kvVal) {
                    record = JSON.parse(kvVal);
                    await env.SYNC_KV.delete(storeKey); // 閱後即焚物理刪除
                }
            } else {
                record = globalThis.MEMORY_SYNC_STORE.get(storeKey);
                if (record) {
                    globalThis.MEMORY_SYNC_STORE.delete(storeKey); // 閱後即焚物理刪除
                }
            }

            if (!record) {
                if (isPairSession) {
                    // QR Code 配對等待中，回傳 200 waiting，不觸發錯誤計數與冷卻
                    return new Response(JSON.stringify({ success: false, waiting: true }), {
                        status: 200,
                        headers: {
                            ...corsHeaders,
                            "Cache-Control": "no-store, no-cache, must-revalidate"
                        }
                    });
                }

                failRecord.count++;
                if (failRecord.count >= 5) {
                    const coolDuration = (10 + (failRecord.count - 5) * 10) * 60 * 1000;
                    failRecord.cooldownUntil = now + coolDuration;
                }
                globalThis.RATE_LIMIT_STORE.set(clientIp, failRecord);
                return new Response(JSON.stringify({ success: false, error: "找不到該取件碼或資料已閱後即焚銷毀！" }), { status: 404, headers: corsHeaders });
            }

            // 成功取件，清除錯誤計數
            if (!isPairSession) {
                globalThis.RATE_LIMIT_STORE.delete(clientIp);
            }

            return new Response(JSON.stringify({
                success: true,
                cipher: record.cipher,
                createdAt: record.createdAt
            }), {
                status: 200,
                headers: {
                    ...corsHeaders,
                    "Cache-Control": "no-store, no-cache, must-revalidate"
                }
            });
        }

        // ==========================================
        // 🗑️ 取件碼主動註銷銷毀路由 (Revoke / Invalidate)
        // ==========================================
        if (url.pathname === "/api/sync/revoke" || url.pathname === "/sync/revoke") {
            let code = "";
            if (request.method === "POST") {
                const reqData = await request.json().catch(() => ({}));
                code = reqData.code || "";
            } else {
                code = url.searchParams.get("code") || "";
            }
            code = (code || "").toUpperCase().trim();
            if (!code) {
                return new Response(JSON.stringify({ success: false, error: "缺少註銷取件碼" }), { status: 400, headers: corsHeaders });
            }
            const storeKey = `sync_${code}`;
            if (env.SYNC_KV) {
                await env.SYNC_KV.delete(storeKey);
            }
            globalThis.MEMORY_SYNC_STORE.delete(storeKey);
            return new Response(JSON.stringify({ success: true, message: `取件碼 ${code} 已主動註銷銷毀` }), { status: 200, headers: corsHeaders });
        }

        // ==========================================
        // 🔍 取件碼狀態在線探測路由 (Check Status - 僅探測存不存在，不觸發刪除)
        // ==========================================
        if (url.pathname === "/api/sync/check" || url.pathname === "/sync/check") {
            let code = "";
            if (request.method === "POST") {
                const reqData = await request.json().catch(() => ({}));
                code = reqData.code || "";
            } else {
                code = url.searchParams.get("code") || "";
            }
            code = (code || "").toUpperCase().trim();
            if (!code) {
                return new Response(JSON.stringify({ success: false, error: "缺少探測取件碼" }), { status: 400, headers: corsHeaders });
            }
            const storeKey = `sync_${code}`;
            let exists = false;
            if (env.SYNC_KV) {
                const val = await env.SYNC_KV.get(storeKey);
                exists = !!val;
            } else {
                exists = globalThis.MEMORY_SYNC_STORE.has(storeKey);
            }
            return new Response(JSON.stringify({ success: true, code, exists }), {
                status: 200,
                headers: {
                    ...corsHeaders,
                    "Cache-Control": "no-store, no-cache, must-revalidate"
                }
            });
        }

        // 🛡️ 3. 來源網域零信任審查 (針對 AI 辨識路由)
        if (!isOriginAllowed(origin, referer)) {
            return new Response(JSON.stringify({
                error: "⛔ 拒絕存取：未授權的網域來源！(Unauthorized Origin) 本代理通道僅供官方 GitHub Pages 存取。若為自建專案，請於設定中填入個人免費 Gemini API Key 直連！"
            }), {
                status: 403,
                headers: corsHeaders,
            });
        }

        // ==========================================
        // 🤖 Gemini AI 行照辨識代理
        // ==========================================
        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "只支援 POST 請求" }), {
                status: 405,
                headers: corsHeaders,
            });
        }

        try {
            const reqBody = await request.json().catch(() => ({}));
            let { imageBase64, mimeType = "image/jpeg", customContext = "", model = "gemini-3.6-flash", apiKey: bodyApiKey } = reqBody;

            // 支援 Header -> Request Body -> 環境變數依序解析金鑰
            const effectiveApiKey = (customApiKey && customApiKey.trim())
                ? customApiKey.trim()
                : ((bodyApiKey && bodyApiKey.trim())
                    ? bodyApiKey.trim()
                    : (env.GEMINI_API_KEY ? env.GEMINI_API_KEY.trim() : ""));

            if (!effectiveApiKey) {
                return new Response(JSON.stringify({
                    error: "Cloudflare Worker 尚未設定 GEMINI_API_KEY 環境變數且請求未附帶金鑰！"
                }), {
                    status: 500,
                    headers: corsHeaders,
                });
            }

            // 🛡️ 模型安全強制校驗 (防止他人偽造請求傳入高額計費 Pro/Ultra 模型)
            if (!isAllowedFlashModel(model)) {
                model = "gemini-3.6-flash";
            }

            if (!imageBase64) {
                return new Response(JSON.stringify({ error: "未接收到行照影像數據 (imageBase64)" }), {
                    status: 400,
                    headers: corsHeaders,
                });
            }

            // =========================================================================
            // 💡 開源骨架提示詞插槽說明 (System Instruction Slot)
            // =========================================================================
            const SYSTEM_PROMPT = `你是一位專業的繁體中文車籍影像辨識 AI。請仔細分析所附的台灣車輛行車執照影像，精確提取關鍵車籍欄位並輸出為結構化 JSON。若某欄位無法辨識請填空字串 "" 或 0。`;

            // 結構化 JSON Schema
            const JSON_SCHEMA = {
                type: "OBJECT",
                properties: {
                    is_valid_license: { type: "BOOLEAN", description: "是否為單一張合法的台灣車輛行照" },
                    rejection_reason: { type: "STRING", description: "若非單一行照之具體拒絕原因，合法則為空字串" },
                    plate_number: { type: "STRING", description: "牌照號碼" },
                    vehicle_type: { type: "STRING", description: "車輛種類" },
                    special_type: { type: "STRING", description: "特殊車種" },
                    owner: { type: "STRING", description: "車主名稱/機關" },
                    address: { type: "STRING", description: "住址" },
                    brand: { type: "STRING", description: "廠牌" },
                    manufacture_date: { type: "STRING", description: "出廠年月" },
                    model: { type: "STRING", description: "型式/款式" },
                    displacement: { type: "INTEGER", description: "排氣量 (c.c.)" },
                    fuel_type: { type: "STRING", description: "燃料種類" },
                    body_style: { type: "STRING", description: "車身式樣" },
                    extra_equipment: { type: "STRING", description: "附加配備" },
                    engine_number: { type: "STRING", description: "引擎號碼" },
                    vin: { type: "STRING", description: "車身號碼 (VIN)" },
                    capacity_sit: { type: "INTEGER", description: "載運人數-座" },
                    capacity_stand: { type: "INTEGER", description: "載運人數-立" },
                    capacity_driver: { type: "INTEGER", description: "載運人數-駕駛室" },
                    load_weight: { type: "NUMBER", description: "載重量 (公噸)" },
                    total_weight: { type: "NUMBER", description: "總重量 (公噸)" },
                    towing_weight: { type: "NUMBER", description: "聯結重量/總聯結重量 (公噸)" },
                    lessee: { type: "STRING", description: "服務公司或承租人" },
                    original_issue_date_roc: { type: "STRING", description: "原發照日期 (民國年，如 111.03.10)" },
                    original_issue_date_ad: { type: "STRING", description: "原發照日期 (西元年，如 2022/03/10)" },
                    renew_issue_date_roc: { type: "STRING", description: "換補照日期 (民國年，如 111.03.10)" },
                    renew_issue_date_ad: { type: "STRING", description: "換補照日期 (西元年，如 2022/03/10)" },
                    color: { type: "STRING", description: "車色" }
                },
                required: ["is_valid_license", "rejection_reason", "plate_number", "vehicle_type", "owner", "brand", "model"]
            };

            const payload = {
                contents: [{
                    parts: [
                        { text: customContext ? `補充車籍背景資訊: ${customContext}\n\n請辨識以下行照影像：` : "請辨識以下行照影像，並提取所有關鍵車籍資料：" },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: imageBase64
                            }
                        }
                    ]
                }],
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT }]
                },
                generationConfig: {
                    temperature: 0.1,
                    topP: 0.8,
                    topK: 40,
                    responseMimeType: "application/json",
                    responseSchema: JSON_SCHEMA
                }
            };

            // 具備自動容災自癒 (Self-Healing) 的模型調用迴圈
            let currentModel = model || "gemini-3.6-flash";
            let maxAttempts = 3;
            let attempt = 0;
            let geminiRes = null;
            let resJson = null;

            while (attempt < maxAttempts) {
                attempt++;
                const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${effectiveApiKey}`;

                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                resJson = await res.json();

                if (res.ok && resJson.candidates && resJson.candidates[0]?.content?.parts?.[0]?.text) {
                    geminiRes = resJson;
                    break;
                }

                // 檢查是否為模型關停/已棄用錯誤 (自動尋找錯誤訊息內推薦的模型，嚴格排除 2.5/1.5 已下架版本)
                const errMsg = resJson.error?.message || "";
                if (errMsg.includes("not found") || errMsg.includes("deprecated") || errMsg.includes("no longer supported") || errMsg.includes("no longer available") || errMsg.includes("unsupported")) {
                    const match = errMsg.match(/gemini-[a-zA-Z0-9\.\-]+/g);
                    if (match && match.length > 0) {
                        const fallbackModel = match.find(m => m !== currentModel && !m.includes("2.5") && !m.includes("1.5"));
                        if (fallbackModel) {
                            currentModel = fallbackModel;
                            continue;
                        }
                    }
                }

                throw new Error(errMsg || `Google Gemini API 呼叫失敗 (HTTP ${res.status})`);
            }

            if (!geminiRes) {
                throw new Error(resJson?.error?.message || "AI 服務暫時無法產生辨識結果，請稍後重試");
            }

            const rawText = geminiRes.candidates[0].content.parts[0].text;
            const parsedData = JSON.parse(rawText);

            return new Response(JSON.stringify(parsedData), {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Access-Control-Allow-Origin": origin || "*",
                },
            });

        } catch (error) {
            return new Response(JSON.stringify({ error: "伺服器內部錯誤: " + error.message }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Access-Control-Allow-Origin": origin || "*",
                },
            });
        }
    }
};
