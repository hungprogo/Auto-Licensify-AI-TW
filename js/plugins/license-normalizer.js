/**
 * LicenseOCR - License Normalizer Plugin (台灣車籍領域資料清洗與結構化插件)
 * 
 * 核心職責：
 * 1. 官方 24 監理欄位自訂編碼權重字典 (100% 來自公路局監理標準)
 * 2. 系統性全域斷詞與欄位溢出清洗 (長詞貪婪匹配、字詞矯正、隔離文字池)
 * 3. 監理日期雙向解析與標準化換算 (西元 YYYY/MM/DD ⇄ 民國 YYY.MM.DD)
 * 4. 繁體中文標準全量 JSON 物件轉換器 (100% 依據原生 Excel 欄位對應)
 * 
 * 授權協議：CC BY-NC-SA 4.0
 */

// 1. 官方字典與自訂編碼
const REF_MAIN_ORDER = { "廂式": "A01", "轎式": "A02", "旅行式": "A03", "敞篷式": "A04", "吉普式": "A05", "單層開放": "A06", "雙層開放": "A07", "雙層廂式": "A08", "雙節式": "A51", "框式": "B01", "篷式": "B02", "柵式": "B03", "平板式": "B04", "罐式": "B05", "槽式": "B06", "密封式": "B07", "攪拌式": "B08", "輸送式": "B09", "雲梯式": "B10", "多層式": "B11", "雙廂式": "B51", "傾卸式": "B52", "分離式": "B53", "油壓式": "B54", "曳引式": "C01", "貨櫃架式": "C02", "前單輪後單輪": "D01", "前單輪後雙輪": "D02", "前雙輪後單輪": "D03", "前單輪(複)": "D04", "後單輪(複)": "D05" };
const REF_SUB_ORDER = { "低地板1": "A52", "低地板2": "A53", "低地板3": "A54", "凹形": "B55", "弧形": "B56", "硬頂": "B57", "活動": "B58", "伸縮": "B59", "氣液罐": "B60", "油罐": "B61", "氯液罐": "B62", "載水": "B63", "粉末": "B64", "高壓": "B65", "可拆手控": "B66", "車側上掀": "B67", "車側開窗": "B68", "後斜": "B69", "低床": "C03" };
const REF_EXTRA_ORDER = { "HID頭燈": "G01", "HID光型": "G02", "LED頭燈": "G03", "LED光型": "G04", "防撞桿": "G05", "置放架": "G06", "備胎架": "G07", "兼供曳引": "G08", "廣告看板": "G09", "廣告看板L": "G10", "輪椅區": "G11", "輪椅升降": "G12", "輪椅區自": "G13", "娛樂顯示": "G14", "迴轉座椅": "G15", "昇降機": "G16", "車頭飾板": "G17", "活動坡道": "G18", "附加吊桿": "H01", "高空作業": "H02", "附水槽": "H03", "冷藏": "H04", "冷凍": "H05", "冷氣": "H06", "保溫": "H07", "拖吊設備": "H08", "絞盤": "H09", "補胎機具": "H10", "修路設備": "H11", "緩撞設施": "H12", "舞台設備": "H13", "臂架1": "H14", "臂架2": "H15", "臂架3": "H16", "臂架4": "H17", "臂架5": "H18", "視野輔助1": "J01", "視野輔助2": "J02", "視野輔助3": "J03", "視野輔助": "J04", "夜停鎖定": "J05", "夜停明鎖": "J06", "無夜停鎖": "J07", "螺旋槳葉": "J08" };
const REF_SPECIAL_ORDER = { "巡邏車": "M01", "偵防車": "M02", "指揮車": "M03", "警備車": "M04", "警衛車": "M05", "勤務車": "M06", "勘驗車": "M07", "刑事偵查車": "M08", "通信作業車": "M09", "機動雷達車": "M10", "拖吊車": "M11", "偵緝車": "M12", "囚車": "M13", "行政巡邏車": "M14", "社區巡邏車": "M15", "消防車": "N01", "救災車": "N02", "消防救災車": "N03", "救災指揮車": "N04", "消防勤務車": "N05", "消防後勤車": "N06", "裝備運送車": "N07", "設施維護車": "N08", "X光勘驗車": "N09", "毒物事故應變車": "N10", "運犬車": "N11", "地震體驗車": "N12", "宣傳車": "N13", "救護車": "P01", "醫療車": "P02", "捐血車": "P03", "放射線檢驗車": "P04", "生醫棄物清運車": "P05", "垃圾車": "Q01", "子母式垃圾車": "Q02", "垃圾子車清洗車": "Q03", "資源回收車": "Q04", "廚餘回收車": "Q05", "污油回收車": "Q06", "真空掃街車": "Q07", "掃街車": "Q08", "灑水車": "Q09", "清溝車": "Q10", "清掃車": "Q11", "消毒車": "Q12", "水肥車": "Q13", "水肥化驗車": "Q14", "流動公廁車": "Q15", "流廁清洗車": "Q16", "空氣檢驗車": "Q17", "食品檢驗車": "Q18", "動物救援車": "Q19", "動物稽查管制車": "Q20", "野生動物行動醫療車": "Q21", "工程救險車": "S01", "工程車": "S02", "高空作業車": "S03", "吊車": "S04", "路面測試車": "S05", "路面修補車": "S06", "緩撞設備車": "S07", "橋樑檢修車": "S08", "混凝土泵浦車": "S09", "抽水泵浦車": "S10", "電力車": "S11", "電力供應車": "S12", "鋼線工程車": "S13", "救濟車": "S14", "石油探勘車": "S15", "修護車": "S16", "巡迴檢驗車": "S17", "航勤補給車": "T01", "郵電車": "T02", "運鈔車": "T03", "輻防廢水車": "T04", "飛安巡查車": "T05", "電視轉播車": "T06", "電波偵測車": "T07", "電信傳送車": "T08", "影音處理設備車": "T11", "靈車": "U01", "到宅沐浴車": "U02", "身心障礙服務接送車": "U03", "長期照顧服務接送車": "U04", "特製車": "U05", "特製車-機車": "U06", "幼童車": "X01", "校車": "X02", "露營車": "X03", "教練車": "X04", "考驗車": "X05", "特製教練車": "X06", "舞台車": "X07", "水陸兩用車(船)": "X08" };

const REF_MAIN_STYLES = Object.keys(REF_MAIN_ORDER).sort((a, b) => b.length - a.length);
const REF_SUB_STYLES = Object.keys(REF_SUB_ORDER).sort((a, b) => b.length - a.length);
const REF_EXTRAS = Object.keys(REF_EXTRA_ORDER).sort((a, b) => b.length - a.length);
const REF_SPECIALS = Object.keys(REF_SPECIAL_ORDER).sort((a, b) => b.length - a.length);

// 日期統一解析與雙向轉換 (西元 YYYY/MM/DD 與 民國 YYY.MM.DD)
function parseDatePair(adStr, rocStr) {
    let y, m, d;
    let s = (adStr || '').toString().trim();
    let mAd = s.match(/(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
    if (mAd) {
        y = parseInt(mAd[1], 10);
        m = parseInt(mAd[2], 10);
        d = parseInt(mAd[3], 10);
    } else {
        let r = (rocStr || '').toString().trim();
        let mRoc = r.match(/(\d{2,3})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
        if (mRoc) {
            y = parseInt(mRoc[1], 10) + 1911;
            m = parseInt(mRoc[2], 10);
            d = parseInt(mRoc[3], 10);
        }
    }
    if (y && m && d) {
        const adFormatted = `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
        const rocFormatted = `${y - 1911}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
        return { ad: adFormatted, roc: rocFormatted };
    }
    return { ad: adStr || '', roc: rocStr || '' };
}

// 系統性全域斷詞與欄位溢出清洗 (隔離文字池架構)
function cleanAndSegmentAttributes(item) {
    if (!item) return;

    const sanitize = (s) => (s || '')
        .toString()
        .replace(/高[工空]車?/g, '高空作業車')
        .replace(/蓬/g, '篷')
        .replace(/補助/g, '輔助')
        .replace(/缷/g, '卸')
        .replace(/[\(\)（）,\/、，。]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // 1. 車身式樣與附加配備專用文字池
    let bodyExtraPool = [
        sanitize(item.body_style),
        sanitize(item.extra_equipment)
    ].join(' ').replace(/\s+/g, ' ').trim();

    let matchedMain = [];
    let matchedSub = [];
    let matchedExtra = [];

    // 階段一：長詞貪婪匹配附加配備
    for (const ex of REF_EXTRAS) {
        if (bodyExtraPool.includes(ex)) {
            matchedExtra.push(ex);
            bodyExtraPool = bodyExtraPool.replaceAll(ex, ' ');
        }
    }

    // 階段二：長詞貪婪匹配主式樣
    for (const ms of REF_MAIN_STYLES) {
        if (bodyExtraPool.includes(ms)) {
            matchedMain.push(ms);
            bodyExtraPool = bodyExtraPool.replaceAll(ms, ' ');
        }
    }

    // 階段三：長詞貪婪匹配副式樣
    for (const ss of REF_SUB_STYLES) {
        if (bodyExtraPool.includes(ss)) {
            matchedSub.push(ss);
            bodyExtraPool = bodyExtraPool.replaceAll(ss, ' ');
        }
    }

    // 2. 特殊車種專用文字池
    let specialPool = [
        sanitize(item.special_type),
        sanitize(item.lessee),
        sanitize(item.vehicle_type)
    ].join(' ').replace(/\s+/g, ' ').trim();

    let matchedSpecial = [];
    for (const sv of REF_SPECIALS) {
        if (specialPool.includes(sv)) {
            matchedSpecial.push(sv);
            specialPool = specialPool.replaceAll(sv, ' ');
        }
    }

    // 3. 依官方 Excel B 欄「自訂編碼」進行固定權重排序
    const sortByKey = (arr, orderMap) => {
        return [...new Set(arr)].sort((a, b) => {
            const codeA = orderMap[a] || 'ZZZ';
            const codeB = orderMap[b] || 'ZZZ';
            return codeA.localeCompare(codeB);
        });
    };

    let sortedMain = sortByKey(matchedMain, REF_MAIN_ORDER);
    let sortedSub = sortByKey(matchedSub, REF_SUB_ORDER);
    let sortedExtra = sortByKey(matchedExtra, REF_EXTRA_ORDER);
    let sortedSpecial = sortByKey(matchedSpecial, REF_SPECIAL_ORDER);

    // 車身式樣：主式樣在前 + 副式樣在後
    item.body_style = [...sortedMain, ...sortedSub].join(' ') || '';
    item.extra_equipment = sortedExtra.join(' ') || '';
    item.special_type = sortedSpecial.join(' ') || '';

    // 車輛種類標準化（去除 -特種 前後綴）
    if (item.vehicle_type) {
        item.vehicle_type = item.vehicle_type.replace(/[-_]?(特種車?)/g, '').replace(/^(自用|公務)/g, '').trim();
    }

    if (item.lessee) {
        let cleanLessee = sanitize(item.lessee);
        [...matchedSpecial, ...matchedExtra, ...matchedMain, ...matchedSub].forEach(w => {
            cleanLessee = cleanLessee.replaceAll(w, ' ');
        });
        cleanLessee = cleanLessee.replace(/\s+/g, ' ').trim();
        item.lessee = cleanLessee;
    }

    const origPair = parseDatePair(item.original_issue_date_ad, item.original_issue_date_roc);
    item.original_issue_date_ad = origPair.ad;
    item.original_issue_date_roc = origPair.roc;
    item.original_issue_date = origPair.ad;

    const renewPair = parseDatePair(item.renew_issue_date_ad, item.renew_issue_date_roc);
    item.renew_issue_date_ad = renewPair.ad;
    item.renew_issue_date_roc = renewPair.roc;
    item.renew_issue_date = renewPair.ad;
}

// 繁體中文 24 欄位結構化物件標準化轉換
function convertResultToChineseObject(item, idx) {
    if (!item || !item.result) return null;
    const d = item.result;
    return {
        "序號": idx !== undefined ? idx + 1 : undefined,
        "檔案名稱": item.fileName || '',
        "狀態": item.status === 'success' ? '辨識成功' : (item.status === 'rejected' ? '守門員拒絕' : '異常'),
        "耗時秒數": item.elapsedTime ? parseFloat(item.elapsedTime) : 0,
        "辨識結果": {
            "是否為有效行照": d.is_valid_license !== false,
            "拒絕原因": d.rejection_reason || '',
            "牌照號碼": d.plate_number || '',
            "車輛種類": d.vehicle_type || '',
            "特殊車種": d.special_type || '',
            "車身式樣": d.body_style || '',
            "附加配備": d.extra_equipment || '',
            "車主名稱": d.owner || '',
            "住址": d.address || '',
            "廠牌": d.brand || '',
            "型式": d.model || '',
            "出廠年月": d.manufacture_date || '',
            "排氣量(c.c.)": d.displacement !== undefined ? d.displacement : '',
            "燃料種類": d.fuel_type || '',
            "車色": d.color || '',
            "引擎號碼": d.engine_number || '',
            "車身號碼(VIN)": d.vin || '',
            "載運人數(駕駛室)": d.capacity_driver !== undefined ? d.capacity_driver : 0,
            "載運人數(座)": d.capacity_sit !== undefined ? d.capacity_sit : 0,
            "載運人數(立)": d.capacity_stand !== undefined ? d.capacity_stand : 0,
            "載重量(公噸)": d.load_weight !== undefined ? d.load_weight : '',
            "總重量(公噸)": d.total_weight !== undefined ? d.total_weight : '',
            "曳引總重(公噸)": d.towing_weight !== undefined ? d.towing_weight : 0,
            "服務公司或承租人": d.lessee || '',
            "原發照日期(民國)": d.original_issue_date_roc || '',
            "原發照日期(西元)": d.original_issue_date_ad || d.original_issue_date || '',
            "換補照日期(民國)": d.renew_issue_date_roc || '',
            "換補照日期(西元)": d.renew_issue_date_ad || d.renew_issue_date || ''
        }
    };
}

// 掛載至命名空間與全域
window.LicenseNormalizer = {
    REF_MAIN_ORDER,
    REF_SUB_ORDER,
    REF_EXTRA_ORDER,
    REF_SPECIAL_ORDER,
    parseDatePair,
    cleanAndSegmentAttributes,
    convertResultToChineseObject
};

window.parseDatePair = parseDatePair;
window.cleanAndSegmentAttributes = cleanAndSegmentAttributes;
window.convertResultToChineseObject = convertResultToChineseObject;
