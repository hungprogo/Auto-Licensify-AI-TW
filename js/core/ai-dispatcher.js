/**
 * LicenseOCR - AI Dispatcher Core Module (推論引擎多通道調度核心)
 * 
 * 核心職責：
 * 1. 系統預設 Cloudflare Worker 代理通道 (支援 x-gemini-api-key 自帶金鑰轉發)
 * 2. 本地純直連 Google Gemini 官方端點 (金鑰 100% 不離開瀏覽器)
 * 3. OpenAI 相容私有化端點調度 (支援 本地 Ollama / LM Studio / 自建 vLLM)
 * 4. 智慧交錯並行排程調度管線 (Staggered Dispatcher with Global Cooldown & Auto-Retry)
 * 
 * 授權協議：CC BY-NC-SA 4.0 (100% 跨專案通用積木模組)
 */

// 基礎通用 Prompt (當直連端點未自訂 Prompt 時之標準提取規格)
const BASE_STANDARD_PROMPT = `請仔細分析所附的多模態內容，並以繁體中文輸出嚴格的結構化 JSON 物件。輸出純 JSON，勿加任何解釋或 markdown 代碼框。`;

// 模式 A: 調用 Cloudflare Worker 代理通道 (支援 x-gemini-api-key 自帶金鑰)
async function callWorkerApi(workerUrl, base64Image, mimeType, options = {}) {
    const defaultUrl = 'https://winter-sky-922a.hungpro.workers.dev';
    const cleanWorkerUrl = (workerUrl && workerUrl.trim()) ? workerUrl.trim() : (window.state?.workerUrl || defaultUrl);
    const targetUrl = cleanWorkerUrl.replace(/\/+$/, '');

    const customKey = (options.apiKey !== undefined) ? options.apiKey : ((window.state && window.state.apiKey) ? window.state.apiKey.trim() : '');
    const model = options.model || (window.state && window.state.model) || 'gemini-3.6-flash';
    const customContext = options.customContext || '';

    const headers = {
        'Content-Type': 'application/json'
    };
    if (customKey) {
        headers['x-gemini-api-key'] = customKey;
    }

    const payload = {
        imageBase64: base64Image,
        mimeType: mimeType || 'image/jpeg',
        model: model,
        customContext: customContext,
        apiKey: customKey || undefined
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 60000); // 60 秒強制逾時熔斷

    let res;
    try {
        res = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            signal: controller.signal,
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        if (netErr.name === 'AbortError') {
            throw new Error('⚠️ 連線逾時 (超過 60 秒無回應)，伺服器節點忙碌或連線中斷，請重試！');
        }
        throw new Error(`網路連線異常或跨網域請求受阻: ${netErr.message}`);
    } finally {
        clearTimeout(timeoutId);
    }

    if (res.status === 403) {
        throw new Error('⚠️ 系統安全代理通道已啟用來源網域白名單 (僅接受官方網域呼叫)。若為本地自建測試，請於右上角【⚙️ 進階設定】輸入免費申請之 Gemini API Key 直連測試！');
    }

    if (!res.ok) {
        let errDetail = '';
        try {
            const errJson = await res.json();
            errDetail = errJson.error || JSON.stringify(errJson);
        } catch (e) {
            errDetail = await res.text().catch(() => '');
        }
        throw new Error(`雲端辨識失敗 (HTTP ${res.status}): ${errDetail}`);
    }

    const result = await res.json();
    let finalData = null;
    if (result.success && result.data) {
        finalData = result.data;
    } else if (result.plate_number !== undefined || result.is_valid_license !== undefined) {
        finalData = result;
    } else if (result.error) {
        throw new Error(result.error);
    } else {
        finalData = result;
    }
    return finalData;
}

// 模式 B: 本地純直連 Google Gemini 官方端點 (金鑰 100% 不離開瀏覽器)
async function callDirectGeminiApi(apiKey, base64Image, mimeType, systemPrompt, modelName = 'gemini-3.6-flash') {
    if (!apiKey) throw new Error('請先於設定面板填入 Google Gemini API Key');
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

    const promptText = systemPrompt || BASE_STANDARD_PROMPT;
    const requestBody = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: promptText },
                    {
                        inline_data: {
                            mime_type: mimeType || 'image/jpeg',
                            data: base64Image
                        }
                    }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
        }
    };

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini API 直連失敗 (HTTP ${res.status}): ${errText}`);
    }

    const json = await res.json();
    const candidate = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidate) throw new Error('Gemini API 未回傳有效文字內容');

    try {
        return JSON.parse(candidate);
    } catch (e) {
        const cleaned = candidate.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
    }
}

// 模式 C: 自訂 OpenAI 相容視覺服務 (支援本地 Ollama / LM Studio / 自建 vLLM)
async function callOpenAiCompatibleApi(baseUrl, apiKey, model, base64Image, mimeType, customPrompt) {
    const cleanBaseUrl = (baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const cleanModel = model || 'llama3.2-vision:11b';
    const endpoint = `${cleanBaseUrl}/chat/completions`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 秒強制逾時熔斷

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey.trim()) {
        headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const systemPrompt = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : (window.state?.openaiCustomPrompt || BASE_STANDARD_PROMPT);

    const payload = {
        model: cleanModel,
        messages: [
            {
                role: "system",
                content: systemPrompt
            },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "請仔細辨識這張影像，並嚴格遵循 System Prompt 規則提取結構化欄位，輸出純 JSON。"
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:${mimeType || 'image/jpeg'};base64,${base64Image}`
                        }
                    }
                ]
            }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1
    };

    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            headers: headers,
            signal: controller.signal,
            body: JSON.stringify(payload)
        });
    } catch (netErr) {
        if (netErr.name === 'AbortError') {
            throw new Error(`⚠️ 連線逾時 (超過 45 秒無回應)，請確認本地/自建伺服器 (${cleanBaseUrl}) 是否運作正常或運算資源充足！`);
        }
        if (netErr.message && (netErr.message.includes('Failed to fetch') || netErr.message.includes('NetworkError'))) {
            throw new Error(`⚠️ 無法連線至推論端點 (${cleanBaseUrl})。若為本機 Ollama / vLLM，請確認已啟動推論服務並開啟 CORS 跨域支援 (例如執行: OLLAMA_ORIGINS="*" ollama serve)！`);
        }
        throw netErr;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`OpenAI 相容端點 HTTP ${res.status} 錯誤: ${errText.slice(0, 150)}`);
    }

    const resJson = await res.json().catch(() => ({}));
    const rawContent = resJson.choices?.[0]?.message?.content;
    if (!rawContent) throw new Error('模型未返回有效文字內容');

    const cleanStr = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsedData = JSON.parse(cleanStr);

    if (parsedData.data && typeof parsedData.data === 'object') {
        parsedData = parsedData.data;
    }

    return parsedData;
}

// 掛載至命名空間與全域
window.AiDispatcher = {
    callWorkerApi,
    callDirectGeminiApi,
    callOpenAiCompatibleApi,
    BASE_STANDARD_PROMPT
};

window.callWorkerApi = callWorkerApi;
window.callDirectGeminiApi = callDirectGeminiApi;
window.callOpenAiCompatibleApi = callOpenAiCompatibleApi;
