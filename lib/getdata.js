window.loadHourlyDataFromServer = async function(unixTimestamp) {
    // 1. 初始化文件级持久化缓存，防止历史回放时重复请求网络
    if (!STATE.fileCache) {
        STATE.fileCache = new Map();
    }
    
    // 清空当前激活视窗的渲染临时缓存
    STATE.hourlyCache = new Map();
    
    if (STATE.urlParams.level === '000') return STATE.hourlyCache;

    // 单个 JSON 文件的读取器（内嵌持久化缓存机制）
    const fetchWithCache = async (ts) => {
        if (ts > Math.floor(Date.now() / 1000) - 600) {
            return [];  //严格时间防逾界校验：秒数必须小于 (当前时间 - 600秒)
        }
        if (STATE.fileCache.has(ts)) {
            return STATE.fileCache.get(ts); // 击中缓存，0ms 延迟直接返回
        }
        try {
            const cdnUrl = `https://data.aqobs.com/${ts}.json`;
            const response = await fetch(cdnUrl);
            if (!response.ok) return [];
            const data = await response.json();
            if (!Array.isArray(data)) {
                console.warn(`[CDN Gateway] ${ts}.json 数据破损或格式非数组，跳过缓存`);
                return [];
            }
            STATE.fileCache.set(ts, data); // 写入全局持久缓存
            return data;
        } catch (e) {
            console.warn(`[CDN Gateway] 暂未发现 ${ts} 历史分片或请求失败:`, e);
            return [];
        }
    };

    // 统一数据结构解包映射器
    const parseAndInject = (v) => {
        if (!Array.isArray(v) || v.length < 8) return;
        STATE.hourlyCache.set(v[1], {
            unixTime: v[0],
            stationId: v[1],
            pm25: v[2],
            pm10: v[3],
            o3: v[4],
            no2: v[5],
            so2: v[6],
            co: v[7]
        });
    };

    try {
        // 2. 核心分流逻辑
        if (!STATE.isHistory) {
            // 【实时视图】并发并行加载当前整点和上两整点，确保 8000 秒内上报的站点都能平滑消隐
            const currentHour = unixTimestamp;
            const prevHour = unixTimestamp - 3600;
            const prevPrevHour = unixTimestamp - 7200;

            const [prevPrevData, prevData, currData] = await Promise.all([
                fetchWithCache(prevPrevHour),
                fetchWithCache(prevHour),
                fetchWithCache(currentHour)
            ]);

            // 先注旧、后注新，当前整点最新数据会自动覆盖旧数据
            prevPrevData.forEach(parseAndInject);
            prevData.forEach(parseAndInject);
            currData.forEach(parseAndInject);
            
            console.log(`[实时视图] 已就绪三整点数据流: ${prevPrevHour} + ${prevHour} + ${currentHour}`);
        } else {
            // 【历史视图】遵照指令：严格只拉取当前选中的单个整点文件，绝不越界，极速轻量
            const targetData = await fetchWithCache(unixTimestamp);
            targetData.forEach(parseAndInject);

            // 【新增优化】后台静默预加载前后 1 小时的整点 JSON 数据到 memory/diskcache
            fetchWithCache(unixTimestamp - 3600);

            // 【修改】后台静默预加载：向前预取无条件执行，向后预取增加 600s 安全阈值判定
            const maxAllowedTs = Math.floor(Date.now() / 1000) - 600;
            if (unixTimestamp + 3600 <= maxAllowedTs) {
                fetchWithCache(unixTimestamp + 3600);
            }
            
            console.log(`[历史视图] 严格单分片加载整点: ${unixTimestamp}`);
        }

    } catch (err) {
        console.error("解包边缘时序数据流失败:", err);
    }

    return STATE.hourlyCache;
};