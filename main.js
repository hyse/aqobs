// 核心运行状态管理机
const STATE = {
    regions: [],    // 存储 regions.json 数据
    stations: [],   // 存储 stations.json 转换后的站点
    aqiRules: [],
    activeRule: null,
    isHistory: false,
    currentTimestamp: null,
    timeTimelineList: [],
    markerInstances: [],    // 保留，我们将主要使用下面的 markerMap
    markerMap: new Map(),   // 【新增：用于 O(1) 级站点 Marker 内存复用映射】
    hourlyCache: new Map(), // 新增：用于缓存当前整点从小端 CDN 拉回来的中括号时序记录
    playInterval: null,
    urlParams: { lat: null, lon: null, scale: null, level: '111', pol: 'aqi', aqi: 'us' }
};

// 【修改】全局弹窗生命周期管理：记录当前被固定的站点 ID
let activePopup = null; 
let pinnedStationId = null; // 当前被点击固定展示的站点 ID（null 表示未固定）

function closeAllPopups() {
    if (activePopup) {
        activePopup.remove();
        activePopup = null;
    }
    pinnedStationId = null;
}

const polList = ['co', 'so2', 'no2', 'o3', 'pm25', 'pm10', 'aqi'];

let map;

// 根据短边计算 50 km 自适应缩放比
function calculateZoomFor50Km(lat) {
    const shortEdge = Math.min(window.innerWidth, window.innerHeight);
    const latRad = lat * Math.PI / 180;
    return Math.max(0, Math.min(22, Math.log2((shortEdge * 40075016.686 * Math.cos(latRad)) / (512 * 50000))));
}

// 解析并接管本地URL参数
function parseURLQuery() {
    const params = new URLSearchParams(window.location.search);
    STATE.urlParams.lat = params.get('lat') ? parseFloat(params.get('lat')) : null;
    STATE.urlParams.lon = params.get('lon') ? parseFloat(params.get('lon')) : null;
    STATE.urlParams.scale = params.get('scale') ? parseFloat(params.get('scale')) : null;
    STATE.urlParams.level = params.get('level') || '111';
    STATE.urlParams.pol = params.get('pol') || 'aqi';
    STATE.urlParams.aqi = params.get('aqi') || '';
    let past = parseInt(params.get('past')) || 75;
    STATE.urlParams.past = Math.max(1, Math.min(180, past));
}

function pushStateToURL() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const newUrl = `${window.location.origin}${window.location.pathname}?lat=${center.lat.toFixed(6)}&lon=${center.lng.toFixed(6)}&scale=${zoom.toFixed(2)}&level=${STATE.urlParams.level}&pol=${STATE.urlParams.pol}&aqi=${STATE.urlParams.aqi}&past=${STATE.urlParams.past}`;
    window.history.replaceState(null, '', newUrl);
}

// 【新增】根据行政区划代码或省市名称在 STATE.regions 中快速查找对应经纬度坐标
function findRegionCoords(code, name) {
    if (!STATE.regions || STATE.regions.length === 0) return null;
    
    // 1. 优先按行政区划代码 (Code) 匹配 (支持前4位市级匹配)
    if (code) {
        const cStr = String(code).trim();
        let match = STATE.regions.find(r => String(r.code) === cStr);
        if (!match && cStr.length >= 4) {
            match = STATE.regions.find(r => String(r.code).startsWith(cStr.substring(0, 4)));
        }
        if (match && match.lat && match.lon) return { lat: match.lat, lon: match.lon };
    }

    // 2. 按省/市/区名称 (Name/Short) 模糊匹配
    if (name) {
        const nStr = String(name).trim();
        const match = STATE.regions.find(r => 
            (r.name && (r.name.includes(nStr) || nStr.includes(r.name))) ||
            (r.short && (r.short.includes(nStr) || nStr.includes(r.short)))
        );
        if (match && match.lat && match.lon) return { lat: match.lat, lon: match.lon };
    }

    return null;
}

// 高可用 IP 定位驱动机（三重 HTTPS/CORS 并行容错机制 - 统一单行语法）
async function fetchIpLocation() {
    const fetchWithTimeout = async (url, parseFn, timeout = 2000) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            clearTimeout(timer);
            const parsed = parseFn(data);
            if (parsed) return parsed;
            throw new Error('Invalid data');
        } catch (e) {
            clearTimeout(timer);
            throw e;
        }
    };

    try {
        // 使用 Promise.any 并发发起 3 个通道请求，谁最快用谁
        return await Promise.any([
            fetchWithTimeout(
                'https://api.bigdatacloud.net/data/reverse-geocode-client',
                d => (d && d.latitude && d.longitude) ? { lat: parseFloat(d.latitude), lon: parseFloat(d.longitude) } : null
            ),
            fetchWithTimeout(
                'https://ipapi.co/json/',
                d => (d && d.latitude && d.longitude) ? { lat: parseFloat(d.latitude), lon: parseFloat(d.longitude) } : null
            ),
            fetchWithTimeout(
                'https://ipinfo.io/json',
                d => (d && d.loc) ? { lat: parseFloat(d.loc.split(',')[0]), lon: parseFloat(d.loc.split(',')[1]) } : null
            )
        ]);
    } catch (e) {
        return null;
    }
}

// 全周期初始化驱动
async function applicationMain() {
    try {
        parseURLQuery();
        
        document.getElementById('loader-text').innerText = "正在并行同步配置与静态站点资产...";

        // 【优化】并行拉取 AQI 规则、区域网格与站点静态资产
        const [aqiRes, regionsRes, stationsRes] = await Promise.all([
            fetch('./assets/aqi.json'),
            fetch('./public/regions.json'),
            fetch('./public/stations.json')
        ]);

        STATE.aqiRules = await aqiRes.json();
        
        const aqiSelect = document.getElementById('aqi-select');
        aqiSelect.innerHTML = '';
        [...STATE.aqiRules].reverse().forEach(rule => {
            const opt = document.createElement('option');
            opt.value = rule.code;
            opt.innerText = rule.name.toUpperCase();
            aqiSelect.appendChild(opt);
        });

        if (!STATE.urlParams.aqi) {
            STATE.urlParams.aqi = STATE.aqiRules[0].code;
        }
        aqiSelect.value = STATE.urlParams.aqi;
        STATE.activeRule = STATE.aqiRules.find(r => r.code === STATE.urlParams.aqi) || STATE.aqiRules[0];
        
        const rawRegions = await regionsRes.json();
        const rawStations = await stationsRes.json();

        // 完美适配并录入 regions.json 的中括号结构
        // 对应索引：[RegionCode, RegionName, RegionShort, RegionABBR, LatitudeX1e7, LongitudeX1e7]
        STATE.regions = rawRegions.map(v => ({
            code: v[0],
            name: v[1],
            short: v[2],
            abbr: v[3],
            lat: v[4] !== null ? v[4] / 1e7 : null,
            lon: v[5] !== null ? v[5] / 1e7 : null
        }));

        // 完美适配并录入 stations.json 中括号结构
        // 对应索引：[StationID, StationName, StationLevel, RegionCode, LatitudeX1e7, LongitudeX1e7]
        STATE.stations = rawStations.map(v => ({
            id: v[0], 
            name: v[1], 
            level: v[2], 
            lat: v[4] / 1e7, 
            lon: v[5] / 1e7
        }));

        // 根据 URL 参数直接在内存中构建等距整点时间轴
        const currentHourFloor = Math.floor(Date.now() / 1000 / 3600) * 3600;
        STATE.timeTimelineList = [];
        for (let i = STATE.urlParams.past; i >= 0; i--) {
            STATE.timeTimelineList.push(currentHourFloor - i * 3600);
        }

        // 3. 地图渲染管线接管
        document.getElementById('loader-text').innerText = "配置矢量瓦片图层渲染通道...";
        let startLat = STATE.urlParams.lat || 34.3415;
        let startLon = STATE.urlParams.lon || 108.9404;
        let startZoom = STATE.urlParams.scale || calculateZoomFor50Km(startLat);

        // 若URL未传坐标则通过多源公网网关做缺省本地化定位
        if (STATE.urlParams.lat === null) {
            const coords = await fetchIpLocation();
            if (coords && coords.lat && coords.lon) {
                startLat = coords.lat; 
                startLon = coords.lon;
                if (STATE.urlParams.scale === null) startZoom = calculateZoomFor50Km(startLat);
            }
        }

        map = new maplibregl.Map({
            container: 'map',
            style: 'https://tiles.openfreemap.org/styles/liberty',
            center: [startLon, startLat],
            zoom: startZoom,
            // precision: 'lowp',
            // cooperativeGestures 设为 false，滚轮直接触发缩放 (类似 Google Earth)，无需按住 Ctrl 键
            cooperativeGestures: false,
            fadeDuration: 0,
            trackResize: true,
            attributionControl: false,
            // antialias: false, // 关闭抗锯齿不能使画面流畅
            localIdeographFontFamily: 'sans-serif'
        });

        // 优雅过滤掉行政边界与干扰标签
        map.on('style.load', () => {
            const layers = map.getStyle().layers;

            // 在循环外预编译正则表达式，避免重复创建
            const secretReg = /country|state|province|capital|admin|boundary|continent/i;
            const placeReg = /place|settlement|water|waterway|river|stream|canal|lake|natural|island|marine|poi|building/i;
            const districtReg = /city|town|township|subdistrict|village|hamlet|suburb|neighbourhood/i;

            layers.forEach((layer) => {
                const id = layer.id;

                // 彻底切断所有“国家(Country)”和“省份/州(State)”图层
                if (secretReg.test(id)) {
                    map.setLayoutProperty(id, 'visibility', 'none');
                    return;
                }

                // 对所有城市/地名标注 (Symbol) 进行强制统一化改造
                if (layer.type === 'symbol') {

                    // --- 强行统一城镇文字内容：只留中文，去掉英文和拼音 ---
                    if (placeReg.test(id) || districtReg.test(id)) {
                        // 使用 coalesce 确保：有中文显示中文，没中文显示空，绝不显示默认的英文/拼音名
                        map.setLayoutProperty(id, 'text-field', ['coalesce', ['get', 'name:zh'], ['get', 'name']]);
                    }

                    // --- 弯度太大的路就不标名字了，省算力 ---
                    if (id.includes('road') || id.includes('highway') || id.includes('path')) {
                        map.setLayoutProperty(id, 'text-max-angle', 30);
                    }

                    // --- 强行统一字体和字重：去掉加粗 ---
                    map.setLayoutProperty(id, 'text-font', ['Noto Sans Regular']);

                    // --- 性能优化：降低标注碰撞检测频率 ---
                    map.setLayoutProperty(id, 'text-padding', 7);
                    map.setLayoutProperty(id, 'text-allow-overlap', false);
                    map.setLayoutProperty(id, 'text-ignore-placement', false);
                }
            });
        });

        map.on('moveend', pushStateToURL);

        // 记录上一次渲染时是否处于视口裁剪模式（> 6.7）
        let lastWasCull = map.getZoom() > 6.7;
        map.on('moveend', () => {
            pushStateToURL();
            const currentZoom = map.getZoom();
            const isCull = currentZoom > 6.7;
            // 仅在以下两种情况才触发 DOM 重画：1. 当前处于小范围 (Zoom > 6.7)，移动/缩放后视口边界变了，需要重新裁剪；2. 刚刚跨越了 6.7 的临界点（从全量切到裁剪，或从裁剪恢复全量）
            if (isCull || isCull !== lastWasCull) {
                renderMapMarkers();
                lastWasCull = isCull;
            }
        });

        map.on('click', closeAllPopups);
        map.on('click', closeAllPopups);

        // 4. 驱动UI结构、绑定全局硬件设备中断事件
        buildTimeDropdownDOM();
        setupShortcutEvents();

        if (STATE.timeTimelineList.length > 0) {
            const latestTs = STATE.timeTimelineList[STATE.timeTimelineList.length - 1];
            await window.loadHourlyDataFromServer(latestTs);
        }

        syncUIStateAndURL();
        renderMapMarkers();

        // 关闭阻断加载界面
        const loader = document.getElementById('loader');
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 300);

    } catch (err) {
        console.error(err);
        document.getElementById('loader-text').innerText = `致命错误: ${err.message}。请检查 docs/lib/ 目录下依赖是否完整。`;
    }
}

// 精密分段线性内插分值算法引擎
function calcSingleIaqi(polType, value, rule) {
    if (value === null || value === undefined || isNaN(value)) return null;
    const polConfig = rule.pollutants[polType];
    if (!polConfig) return null;

    const bp = polConfig.bp;
    const aqiScale = polConfig.aqi;

    for (let i = 0; i < bp.length - 1; i++) {
        if (value >= bp[i] && value <= bp[i+1]) {
            return Math.round(((aqiScale[i+1] - aqiScale[i]) / (bp[i+1] - bp[i])) * (value - bp[i]) + aqiScale[i]);
        }
    }
    // 超出高位边界时的延长线外推机制
    const len = bp.length;
    if (value > bp[len-1]) {
        const slope = (aqiScale[len-1] - aqiScale[len-2]) / (bp[len-1] - bp[len-2]);
        return Math.round(aqiScale[len-1] + slope * (value - bp[len-1]));
    }
    return 0;
}

// 动态现场聚合计算复合站点的多要素最大 AQI
function getStationCalculatedAqi(dbRow, rule) {
    let maxAqi = 0;
    let hasValidData = false;
    ['co', 'so2', 'no2', 'o3', 'pm25', 'pm10'].forEach(key => {
        let val = dbRow[key];
        if (val !== null && val !== undefined) {
            if (key === 'co') val = val / 1000; // 算法内插前将 CO 升阶换算为 mg/m3
            const iaqi = calcSingleIaqi(key, val, rule);
            if (iaqi > maxAqi) maxAqi = iaqi;
            hasValidData = true;
        }
    });
    return hasValidData ? maxAqi : null;
}

// 获取对应分级标准的级别颜色 definition
function getColorAndLabel(polType, value, rule) {
    let aqiValue = value;
    // 如果传入的不是最终的AQI，先计算对应的分项IAQI值
    if (polType !== 'aqi') {
        aqiValue = calcSingleIaqi(polType, value, rule) || 0;
    }
    const levels = rule.aqi_levels;
    for (let i = 0; i < levels.length; i++) {
        if (aqiValue >= levels[i].min && aqiValue <= levels[i].max) {
            return { color: `rgb(${levels[i].color.join(',')})`, label: levels[i].label };
        }
    }
    // 兜底外推最高阶颜色
    return { color: `rgb(${levels[levels.length-1].color.join(',')})`, label: levels[levels.length-1].label };
}

// 构造时间整点回溯下拉选单
function buildTimeDropdownDOM() {
    const container = document.getElementById('time-dropdown-container');
    container.innerHTML = '';
    
    const currentHourFloor = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const historyOrderList = STATE.timeTimelineList; // 自下而上反向，最上面是最早的数据

    historyOrderList.forEach(ts => {
        const date = new Date(ts * 1000);
        const hh = String(date.getHours()).padStart(2, '0') + ':00';
        const hoursAgo = Math.floor((currentHourFloor - ts) / 3600);

        const item = document.createElement('div');
        item.className = 'time-drop-item';
        item.dataset.ts = ts;
        item.innerHTML = `<span>${hh}</span><span class="time-ago">${hoursAgo}</span>`;
        
        item.onclick = (e) => {
            e.stopPropagation();
            enterHistoryView(ts);
            container.style.display = 'none';
        };
        container.appendChild(item);
    });

    buildTimeSliderTicks();
}

// 绘制历史时间标尺刻度（SVG + crispEdges 终极干掉抗锯齿）
function buildTimeSliderTicks() {
    const wrapper = document.getElementById('timeline-axis-wrapper');
    // 清理旧刻度与 SVG 矢量图层
    wrapper.querySelectorAll('.timeline-svg, .timeline-label').forEach(el => el.remove());
    if (STATE.timeTimelineList.length === 0) return;

    const minTs = STATE.timeTimelineList[0];
    const maxTs = STATE.timeTimelineList[STATE.timeTimelineList.length - 1];
    const span = maxTs - minTs || 1;
    const width = wrapper.clientWidth || 300;
    const height = wrapper.clientHeight || 32;

    // 创建 SVG 绘制容器
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'timeline-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.pointerEvents = 'none';

    STATE.timeTimelineList.forEach(ts => {
        const percent = (ts - minTs) / span;
        const x = percent * width;
        const d = new Date(ts * 1000);
        const isMidnight = d.getHours() === 0;

        // 创建 SVG 刻度线
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x);
        line.setAttribute('x2', x);
        line.setAttribute('y1', isMidnight ? height - 12 : height - 6); // 午夜 12px，普通 6px
        line.setAttribute('y2', height);
        line.setAttribute('stroke', isMidnight ? '#111827' : '#6b7280');
        line.setAttribute('stroke-width', isMidnight ? '2' : '1');
        
        // 核心技术：强行关闭抗锯齿，使物理像素 100% 硬对齐
        line.setAttribute('shape-rendering', 'crispEdges');
        
        svg.appendChild(line);

        // 绘制日期标签
        if (isMidnight) {
            const label = document.createElement('div');
            label.className = 'timeline-label';
            label.style.left = `${percent * 100}%`;
            label.innerText = `${d.getDate()}日`;
            wrapper.appendChild(label);
        }
    });

    wrapper.appendChild(svg);
    setupSliderDragLogic();
}

// 像素级梯形时间游标拖拽及吸附逻辑
function setupSliderDragLogic() {
    const cursor = document.getElementById('timeline-cursor');
    const wrapper = document.getElementById('timeline-axis-wrapper');
    let dragging = false;
    let lastRenderTime = 0; // 用于节流的时间戳看门狗

    function processMove(clientX) {
        const rect = wrapper.getBoundingClientRect();
        let pct = (clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));

        const minTs = STATE.timeTimelineList[0];
        const maxTs = STATE.timeTimelineList[STATE.timeTimelineList.length - 1];
        const targetTs = minTs + pct * (maxTs - minTs);

        // 二分查找或最近吸附算法
        let closest = STATE.timeTimelineList[0];
        let diff = Math.abs(targetTs - closest);
        for (let i = 1; i < STATE.timeTimelineList.length; i++) {
            let d = Math.abs(targetTs - STATE.timeTimelineList[i]);
            if (d < diff) { diff = d; closest = STATE.timeTimelineList[i]; }
        }
        
        // 限制高频拖拽引发的过度渲染锁
        if (closest !== STATE.currentTimestamp) {
            const now = Date.now();
            if (now - lastRenderTime > 60 || closest !== STATE.currentTimestamp) {
                lastRenderTime = now;
                enterHistoryView(closest);
            }
        }
    }

    cursor.onmousedown = (e) => { e.stopPropagation(); dragging = true; };
    window.addEventListener('mousemove', (e) => { if (dragging) processMove(e.clientX); });
    window.addEventListener('mouseup', () => { dragging = false; });
    wrapper.onmousedown = (e) => { if (e.target !== cursor) processMove(e.clientX); };
}

// 双向视图状态控制器
async function enterHistoryView(ts) {
    STATE.isHistory = true;
    STATE.currentTimestamp = ts;
    document.getElementById('upper-control-row').style.display = 'flex';
    buildTimeSliderTicks();
    document.getElementById('time-display-box').classList.add('history-mode');
    syncUIStateAndURL();
    
    // 渲染前，先去 CDN 把这个时间戳的 JSON 拉回来
    await loadHourlyDataFromServer(ts);
    renderMapMarkers();
}

async function enterRealtimeView() {
    // 【新增】检测当前系统整点是否已跨点更新
    const currentHourFloor = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const latestTs = STATE.timeTimelineList[STATE.timeTimelineList.length - 1];
    
    if (!latestTs || latestTs !== currentHourFloor) {
        window.location.reload();
        return;
    }

    STATE.isHistory = false;
    stopAutoPlay();
    document.getElementById('upper-control-row').style.display = 'none';
    document.getElementById('time-display-box').classList.remove('history-mode');
    syncUIStateAndURL();
    
    // 实时视角下，拉取时间轴上最新的一个整点数据
    await loadHourlyDataFromServer(latestTs);
    renderMapMarkers();
}

// 参数同步到 DOM 与 URL 状态
function syncUIStateAndURL() {
    document.getElementById('pol-select').value = STATE.urlParams.pol;
    document.getElementById('aqi-select').value = STATE.urlParams.aqi;

    const timeBox = document.getElementById('time-display-box');
    if (!STATE.isHistory) {
        const d = new Date();
        timeBox.innerText = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        timeBox.setAttribute('data-tooltip', `${d.getDate()}日${d.getHours()}时`);
    } else {
        const d = new Date(STATE.currentTimestamp * 1000);
        timeBox.innerText = `${String(d.getHours()).padStart(2,'0')}:00`;
        timeBox.setAttribute('data-tooltip', `${d.getDate()}日${d.getHours()}时`);

        // 刷新游标（直角梯形：下底正对当前时间刻度，尖角刚好触及最高刻度线顶端，斜腰夹角 60°）
        const wrapper = document.getElementById('timeline-axis-wrapper');
        const minTs = STATE.timeTimelineList[0];
        const maxTs = STATE.timeTimelineList[STATE.timeTimelineList.length - 1];
        const spanHours = STATE.timeTimelineList.length - 1 || 1;
        const axisWidth = wrapper.clientWidth || 300;
        const axisHeight = wrapper.clientHeight || 32;
        
        const hourWidthPx = axisWidth / spanHours; // 1 小时像素宽度（垂直腰长度）
        const midnightTickHeight = 12;             // 最高刻度线高度 (px)
        
        // 游标右侧下底高度：从顶部向下延伸，刚好碰到最高刻度线的顶端
        const h2 = Math.max(10, axisHeight - midnightTickHeight); 

        // 依据 60° 几何夹角计算上底（左侧）高度: (h2 - h1) = hourWidth / tan(60°) = hourWidth / sqrt(3)
        const diffPx = hourWidthPx / Math.sqrt(3);
        const h1 = Math.max(0, h2 - diffPx);
        const topBasePct = (h1 / h2) * 100;

        const pct = ((STATE.currentTimestamp - minTs) / (maxTs - minTs || 1)) * 100;
        const cursor = document.getElementById('timeline-cursor');
        
        cursor.style.width = `${hourWidthPx}px`;
        cursor.style.height = `${h2}px`;
        cursor.style.left = `${pct}%`;
        cursor.style.transform = 'translateX(-100%)'; // 下底（右侧边）精确对齐当前时间刻度
        cursor.style.clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 ${topBasePct}%)`;
        cursor.title = `${d.getDate()}日${d.getHours()}时`;
    }

    // 同步下拉框的高亮定位
    document.querySelectorAll('.time-drop-item').forEach(item => {
        const ts = parseInt(item.dataset.ts);
        if (STATE.isHistory && ts === STATE.currentTimestamp) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // 动态检查对齐上下层组件线宽
    const polEl = document.getElementById('pol-select');
    const selBtn = document.getElementById('time-select-btn');
    const upperRow = document.getElementById('upper-control-row');
    if (upperRow.style.display !== 'none') {
        const leftPos = polEl.getBoundingClientRect().left;
        const rightPos = selBtn.getBoundingClientRect().right;
        upperRow.style.width = `${rightPos - leftPos}px`;
    }

    pushStateToURL();
}

setInterval(() => {
        if (STATE.isHistory) return; // 历史模式下静默，不干扰历史时间显示
        const timeBox = document.getElementById('time-display-box');
        if (!timeBox) return;
        const d = new Date();
        timeBox.innerText = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        timeBox.setAttribute('data-tooltip', `${d.getDate()}日${d.getHours()}时`);
}, 1000);

// 常规组件的联动改变响应
document.getElementById('pol-select').onchange = (e) => { 
    STATE.urlParams.pol = e.target.value; 
    syncUIStateAndURL(); 
    renderMapMarkers(); 
    e.target.blur(); // 选择完成后立即清除焦点高亮
};
document.getElementById('aqi-select').onchange = (e) => {
    STATE.urlParams.aqi = e.target.value;
    STATE.activeRule = STATE.aqiRules.find(r => r.code === STATE.urlParams.aqi);
    syncUIStateAndURL(); 
    renderMapMarkers(); 
    e.target.blur(); // 选择完成后立即清除焦点高亮
};
document.getElementById('time-display-box').onclick = () => enterRealtimeView();

const triggerBtn = document.getElementById('time-select-btn');
const dropBox = document.getElementById('time-dropdown-container');
dropBox.onclick = (e) => { e.stopPropagation(); };
triggerBtn.onclick = (e) => {
    e.stopPropagation();
    const isOpen = dropBox.style.display === 'block';
    dropBox.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
        const btnRight = triggerBtn.getBoundingClientRect().right;
        if (window.innerWidth > 640) {
            // 桌面端：左侧精准对齐 #time-display-box
            const boxLeft = document.getElementById('time-display-box').getBoundingClientRect().left;
            dropBox.style.width = `${Math.round(btnRight - boxLeft)}px`;
        } else {
            // 移动端：左侧精准对齐 #pol-select 的左边缘
            const polLeft = document.getElementById('pol-select').getBoundingClientRect().left;
            dropBox.style.width = `${Math.round(btnRight - polLeft)}px`;
        }
        // 关键点：打开下拉框后，自动将滚轮聚焦并拉至最底部（最近时间点）
        dropBox.scrollTop = dropBox.scrollHeight;
    }
};
document.addEventListener('click', () => { dropBox.style.display = 'none'; });

// 长按自动放映循环机制驱动
function startAutoPlay(direction) {
    stopAutoPlay();
    if (!STATE.isHistory) {
        enterHistoryView(STATE.timeTimelineList[STATE.timeTimelineList.length - 1]);
    }
    STATE.playInterval = setInterval(() => {
        let idx = STATE.timeTimelineList.indexOf(STATE.currentTimestamp);
        if (direction === 'forward') {
            idx = (idx + 1) % STATE.timeTimelineList.length;
        } else {
            idx = (idx - 1 + STATE.timeTimelineList.length) % STATE.timeTimelineList.length;
        }
        enterHistoryView(STATE.timeTimelineList[idx]);
    }, 1500);
}

function stopAutoPlay() {
    if (STATE.playInterval) { clearInterval(STATE.playInterval); STATE.playInterval = null; }
}

// 按键前后移动核心步进方法
function stepTime(isForward) {
    if (STATE.timeTimelineList.length === 0) return;
    let idx = STATE.timeTimelineList.indexOf(STATE.currentTimestamp);
    if (idx === -1) {
        idx = STATE.timeTimelineList.length - 1;
    } else {
        if (isForward) {
            idx = (idx + 1) % STATE.timeTimelineList.length;
        } else {
            idx = (idx - 1 + STATE.timeTimelineList.length) % STATE.timeTimelineList.length;
        }
    }
    enterHistoryView(STATE.timeTimelineList[idx]);
}

// 全球全域硬件设备键盘事件映射机
function setupShortcutEvents() {
    // 1. 精准拦截 Chrome / Edge 触摸板双指捏合导致的“整页放大”（仅针对 ctrlKey 缩放，不影响普通滚轮平移）
    window.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault(); // 封死网页放大，地图 Canvas 内部会自行接管地图级别的缩放
        }
    }, { passive: true });

    // 2. 精准拦截 Safari (macOS / iOS) 的原生网页手势放大
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(type => {
        document.addEventListener(type, (e) => {
            e.preventDefault(); // 封死 Safari 网页手势缩放
        });
    });

    let keyTimers = {};

    window.addEventListener('keydown', (e) => {
        const activeTag = document.activeElement.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'select') return;
        
        const k = e.key.toUpperCase();
        if (keyTimers[k]) return; // 防止系统原生打字机连发副作用

        if (k === 'W') {
            e.preventDefault();
            let idx = polList.indexOf(STATE.urlParams.pol);
            STATE.urlParams.pol = polList[(idx - 1 + polList.length) % polList.length];
            syncUIStateAndURL(); renderMapMarkers();
        }
        if (k === 'S') {
            e.preventDefault();
            let idx = polList.indexOf(STATE.urlParams.pol);
            STATE.urlParams.pol = polList[(idx + 1) % polList.length];
            syncUIStateAndURL(); renderMapMarkers();
        }
        if (k === 'Q') {
            e.preventDefault();
            let idx = STATE.aqiRules.findIndex(r => r.code === STATE.urlParams.aqi);
            STATE.urlParams.aqi = STATE.aqiRules[(idx - 1 + STATE.aqiRules.length) % STATE.aqiRules.length].code;
            STATE.activeRule = STATE.aqiRules.find(r => r.code === STATE.urlParams.aqi);
            syncUIStateAndURL(); renderMapMarkers();
        }
        if (k === 'E') {
            e.preventDefault();
            let idx = STATE.aqiRules.findIndex(r => r.code === STATE.urlParams.aqi);
            STATE.urlParams.aqi = STATE.aqiRules[(idx + 1) % STATE.aqiRules.length].code;
            STATE.activeRule = STATE.aqiRules.find(r => r.code === STATE.urlParams.aqi);
            syncUIStateAndURL(); renderMapMarkers();
        }
        if (k === 'R') { e.preventDefault(); enterRealtimeView(); }
        if (k === 'T') { e.preventDefault(); triggerBtn.click(); }
        if (k === 'I') { e.preventDefault(); toggleInfoPanel(); }

        if (k === 'A') {
            e.preventDefault();
            stepTime(false);
            keyTimers[k] = setTimeout(() => startAutoPlay('backward'), 500);
        }
        if (k === 'D') {
            e.preventDefault();
            stepTime(true);
            keyTimers[k] = setTimeout(() => startAutoPlay('forward'), 500);
        }
    });

    window.addEventListener('keyup', (e) => {
        const k = e.key.toUpperCase();
        if (k === 'A' || k === 'D') {
            clearTimeout(keyTimers[k]);
            delete keyTimers[k];
            stopAutoPlay();
        }
    });

    // 鼠标指针层级的 A / D 与后退、前进键功能整合绑定
    let mouseTimer;
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');

    btnPrev.onmousedown = () => { stepTime(false); mouseTimer = setTimeout(() => startAutoPlay('backward'), 500); };
    btnPrev.onmouseup = btnPrev.onmouseleave = () => { clearTimeout(mouseTimer); stopPlaybackHelper(); };
    
    btnNext.onmousedown = () => { stepTime(true); mouseTimer = setTimeout(() => startAutoPlay('forward'), 500); };
    btnNext.onmouseup = btnNext.onmouseleave = () => { clearTimeout(mouseTimer); stopPlaybackHelper(); };
    
    function stopPlaybackHelper() { stopAutoPlay(); }
}

// 智能色彩对比度感知工具函数
function getTextColorForBackground(colorStr) {
    if (!colorStr) return '#ffffff';
    let r, g, b;
    
    if (colorStr.startsWith('rgb')) {
        const match = colorStr.match(/\d+/g);
        if (match) {
            r = parseInt(match[0], 10);
            g = parseInt(match[1], 10);
            b = parseInt(match[2], 10);
        }
    } else {
        let hex = colorStr.replace('#', '');
        if (hex.length === 3) {
            hex = hex.split('').map(c => c + c).join('');
        }
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
    }
    
    if (isNaN(r) || isNaN(g) || isNaN(b)) return '#ffffff';

    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 170 ? '#727272' : '#ffffff';
}

// 高动态位掩码过滤与 Canvas 站点标记控制系统（DPR 高清抗锯齿 / 内存 DOM 复用 / 零闪烁定稿版）
function renderMapMarkers() {
    closeAllPopups();

    const mask = STATE.urlParams.level;
    const currentSystemSec = Math.floor(Date.now() / 1000);
    const recordMap = STATE.hourlyCache;

    // 获取当前 Zoom 及视口边界（仅在 Zoom > 6.7 时计算视口）
    const currentZoom = map.getZoom();
    const enableCulling = currentZoom > 6.7;
    
    let minLng = 0, maxLng = 0, minLat = 0, maxLat = 0;
    if (enableCulling) {
        const bounds = map.getBounds();
        const rawMinLng = bounds.getWest();
        const rawMaxLng = bounds.getEast();
        const rawMinLat = bounds.getSouth();
        const rawMaxLat = bounds.getNorth();

        // 手动计算四周 30% 的外扩余量
        const lngMargin = (rawMaxLng - rawMinLng) * 0.3;
        const latMargin = (rawMaxLat - rawMinLat) * 0.3;

        minLng = rawMinLng - lngMargin;
        maxLng = rawMaxLng + lngMargin;
        minLat = rawMinLat - latMargin;
        maxLat = rawMaxLat + latMargin;
    }

    // 记录本次渲染视口内真正有效显示的站点 ID 集合
    const activeStationIds = new Set();

    STATE.stations.forEach(st => {
        // 1. 图层级别掩码过滤
        let visible = false;
        if (st.level === '国控' && mask[0] === '1') visible = true;
        if (st.level === '省控' && mask[1] === '1') visible = true;
        if (st.level !== '国控' && st.level !== '省控' && mask[2] === '1') visible = true;
        if (mask === '000') visible = true;

        if (!visible) return;

        // 2. 视口裁剪
        if (enableCulling) {
            if (st.lon < minLng || st.lon > maxLng || st.lat < minLat || st.lat > maxLat) {
                return;
            }
        }

        // 3. 提取与校验数据（提前至 DOM 复用拦截前，防止无效站点误占位）
        let matchedRecord = null;
        let nodeValue = '';
        let rawVal = 0;
        let hexColor = '#9ca3af';
        let ageSeconds = 0;

        if (mask !== '000') {
            matchedRecord = recordMap.get(st.id);
            if (!matchedRecord) return;

            if (!STATE.isHistory) {
                ageSeconds = currentSystemSec - matchedRecord.unixTime;
                if (ageSeconds >= 8000) return; // 超过 2 小时无数据不渲染

                if (STATE.urlParams.pol !== 'aqi') {
                    if (matchedRecord[STATE.urlParams.pol] === null || matchedRecord[STATE.urlParams.pol] === undefined) return;
                }
            }

            if (STATE.urlParams.pol === 'aqi') {
                rawVal = getStationCalculatedAqi(matchedRecord, STATE.activeRule);
                if (rawVal === null || rawVal === undefined) return;
                nodeValue = rawVal;
            } else {
                rawVal = matchedRecord[STATE.urlParams.pol];
                if (rawVal === null || rawVal === undefined) return;
                
                if (STATE.urlParams.pol === 'co') {
                    rawVal = rawVal / 1000; // 毫克换算
                    nodeValue = rawVal.toFixed(1);
                } else {
                    nodeValue = Math.round(rawVal);
                }
            }
            hexColor = getColorAndLabel(STATE.urlParams.pol, rawVal, STATE.activeRule).color;
        }

        // 4. 构造 Marker Key（含 ageBucket 分钟粒度更新，兼顾拖拽防闪烁与时间平滑演进）
        const ageBucket = (!STATE.isHistory && mask !== '000') ? Math.floor(ageSeconds / 60) : 0;
        const recordTime = matchedRecord ? matchedRecord.unixTime : 0;
        const markerKey = `${st.id}_${mask}_${STATE.urlParams.pol}_${STATE.urlParams.aqi}_${STATE.activeRule}_${STATE.isHistory}_${STATE.currentTimestamp}_${recordTime}_${ageBucket}`;

        activeStationIds.add(st.id);

        // 5. 内存 DOM 复用拦截
        const existing = STATE.markerMap.get(st.id);
        if (existing && existing.key === markerKey) {
            return;
        }

        // 状态变动时先清空旧 DOM
        if (existing) {
            existing.marker.remove();
            STATE.markerMap.delete(st.id);
        }

        // 6. 构建 DOM 节点
        const containerEl = document.createElement('div');
        containerEl.className = 'station-marker';

        if (mask === '000') {
            const size = st.level === '国控' ? 14 : 12;
            containerEl.className = 'empty-station';
            containerEl.style.width = `${size}px`;
            containerEl.style.height = `${size}px`;
            containerEl.style.borderColor = '#1f2937';
            
            if (st.level === '国控') {
                containerEl.style.borderWidth = '3.3px'; containerEl.style.borderStyle = 'solid';
            } else if (st.level === '省控') {
                containerEl.style.borderWidth = '4px'; containerEl.style.borderStyle = 'double';
            } else {
                containerEl.style.borderWidth = '1.4px'; containerEl.style.borderStyle = 'solid';
            }
            bindPopupEvents(containerEl, st, null);
        } else {
            const node = document.createElement('div');
            node.className = 'station-node';

            node.style.display = 'flex';
            node.style.alignItems = 'center';
            node.style.justifyContent = 'center';
            node.style.position = 'relative';
            node.style.boxSizing = 'border-box';
            node.style.padding = '0';
            node.style.margin = '0';
            node.style.lineHeight = '1';
            node.style.textAlign = 'center';
            node.style.whiteSpace = 'nowrap';
            
            if (!STATE.isHistory) {
                node.style.width = '24px';
                node.style.height = '24px';
                node.style.borderRadius = '50%';
                node.style.fontSize = '13px';
                node.style.opacity = '0.88';
            } else {
                node.style.width = '24px';
                node.style.height = '16px';
                node.style.borderRadius = '4px';
                node.style.fontSize = '12px';
                node.style.opacity = '0.88';
            }
            
            node.style.backgroundColor = hexColor;
            node.style.color = getTextColorForBackground(hexColor);
            node.innerText = nodeValue;
            containerEl.appendChild(node);

            if (!STATE.isHistory) {
                if (ageSeconds < 3600) {
                    const canvas = document.createElement('canvas');
                    canvas.className = 'ring-canvas';

                    // 高分屏 DPR 物理像素缩放，消除 Canvas 抗锯齿
                    const dpr = window.devicePixelRatio || 1;
                    canvas.width = 32 * dpr; 
                    canvas.height = 32 * dpr;
                    canvas.style.width = '32px';
                    canvas.style.height = '32px';

                    canvas.style.position = 'absolute';
                    canvas.style.top = '50%';
                    canvas.style.left = '50%';
                    canvas.style.transform = 'translate(-50%, -50%)';
                    canvas.style.pointerEvents = 'none';

                    const ctx = canvas.getContext('2d');
                    ctx.scale(dpr, dpr);

                    const ratio = 1 - (ageSeconds / 3600);
                    ctx.clearRect(0, 0, 32, 32);
                    
                    const RING_COLOR = '#202020';
                    ctx.strokeStyle = RING_COLOR;

                    const cx = 16, cy = 16;
                    const startAngle = -Math.PI / 2;
                    const endAngle = (-Math.PI / 2) + (Math.PI * 2 * ratio);

                    if (st.level === '国控') {
                        ctx.lineWidth = 2.6;
                        ctx.beginPath();
                        ctx.arc(cx, cy, 14, startAngle, endAngle);
                        ctx.stroke();
                    } 
                    else if (st.level === '省控') {
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.arc(cx, cy, 14.3, startAngle, endAngle);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.arc(cx, cy, 12, startAngle, endAngle);
                        ctx.stroke();
                    } 
                    else {
                        ctx.lineWidth = 1.2;
                        ctx.beginPath();
                        ctx.arc(cx, cy, 14, startAngle, endAngle);
                        ctx.stroke();
                    }

                    node.appendChild(canvas);
                } else if (ageSeconds >= 3600 && ageSeconds < 8000) {
                    const opacity = (1 - Math.pow((ageSeconds - 3600) / (8000 - 3600), 3)) * 0.88;
                    node.style.opacity = opacity.toFixed(2);
                }
            }
            bindPopupEvents(containerEl, st, matchedRecord);
        }

        const marker = new maplibregl.Marker({ element: containerEl, anchor: 'center' })
            .setLngLat([st.lon, st.lat])
            .addTo(map);

        STATE.markerMap.set(st.id, { marker, key: markerKey });
    });

    // 7. 按需移除已移出视口或不需要显示的 Marker DOM
    for (const [id, item] of STATE.markerMap.entries()) {
        if (!activeStationIds.has(id)) {
            item.marker.remove();
            STATE.markerMap.delete(id);
        }
    }

    // 8. 同步 STATE.markerInstances 数组，确保全局兼容性
    STATE.markerInstances = Array.from(STATE.markerMap.values()).map(item => item.marker);
}

// 多指标聚合看板 Tooltip 引擎
function bindPopupEvents(el, station, record) {
    // 动态更新节点挂载的数据源，确保 Hover 时读取最新整点值
    el._st = station;
    el._record = record;

    // 若当前 DOM 已经挂载过事件，直接返回，不再重复绑定
    if (el._hasPopupEvents) return;
    el._hasPopupEvents = true;

    const buildContent = () => {
        const st = el._st;
        const rec = el._record;
        const div = document.createElement('div');
        div.className = 'aqobs-popup-panel';

        if (!rec) {
            div.innerHTML = `<div class="pop-row"><span class="pop-title">${st.name}</span><span class="pop-level">${st.level}</span></div>`;
            return div;
        }

        const d = new Date(rec.unixTime * 1000);
        const finalAqi = getStationCalculatedAqi(rec, STATE.activeRule);
        const aqiBg = getColorAndLabel('aqi', finalAqi, STATE.activeRule).color;
        const aqiTextColor = getTextColorForBackground(aqiBg); 

        const createBadge = (pType) => {
            let v = rec[pType]; 
            if (v === null || v === undefined) return `<span style="color:#9ca3af">--</span>`;
            if (pType === 'co') {
                v = (v / 1000).toFixed(1);
            } else {
                v = Math.round(v);
            }
            const bg = getColorAndLabel(pType, v, STATE.activeRule).color;
            const badgeTextColor = getTextColorForBackground(bg); 
            return `<span class="pop-badge" style="background:${bg}; color:${badgeTextColor}">${v}</span>`;
        };

        div.innerHTML = `
            <div class="pop-row"><span class="pop-title">${st.name}</span><span class="pop-level">${st.level}</span></div>
            <div class="pop-row">
                <span>AQI<sub>${STATE.urlParams.aqi.toUpperCase()}</sub>: <span class="pop-badge" style="background:${aqiBg}; color:${aqiTextColor}">${finalAqi}</span></span>
                <span style="color:#4b5563; font-weight:500;">${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:00</span>
            </div>
            <hr style="border:0; border-top:1px solid #e5e7eb; margin:5px 0;"/>
            <div class="pop-row"><span>PM2.5: ${createBadge('pm25')}</span><span>PM10: ${createBadge('pm10')}</span></div>
            <div class="pop-row"><span>O3: ${createBadge('o3')}</span><span>NO2: ${createBadge('no2')}</span></div>
            <div class="pop-row"><span>SO2: ${createBadge('so2')}</span><span>CO: ${createBadge('co')}</span></div>
        `;
        return div;
    };

    const show = () => {
        if (activePopup) activePopup.remove();

        activePopup = new maplibregl.Popup({ 
            offset: 12, 
            closeButton: false, 
            closeOnClick: false 
        })
        .setLngLat([el._st.lon, el._st.lat])
        .setDOMContent(buildContent())
        .addTo(map);
    };

    el.addEventListener('mouseenter', () => {
        if (pinnedStationId !== null) return;
        show();
    });

    el.addEventListener('mouseleave', () => {
        if (pinnedStationId === null) closeAllPopups();
    });

    el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pinnedStationId === el._st.id) {
            closeAllPopups();
        } else {
            pinnedStationId = el._st.id;
            show();
        }
    });
}

// 右上角信息控制面板
const infoModal = document.getElementById('info-modal');
function toggleInfoPanel() {
    const isClosed = infoModal.style.display !== 'flex';
    infoModal.style.display = isClosed ? 'flex' : 'none';
    if (isClosed) switchTab(0);
}

document.getElementById('info-trigger').onclick = (e) => { e.stopPropagation(); toggleInfoPanel(); };
infoModal.onclick = (e) => e.stopPropagation();
document.addEventListener('click', () => { infoModal.style.display = 'none'; });

const helpTexts = [
    "<h4>aqobs 观测系统概述</h4><p>本平台依托高效率 WebAssembly 容器本地解析时序 SQLite 关系库，无需依赖高延迟后端集群即可在前端完成全量环境要素空间差值图层解析与历史演化放映。</p>",
    "<h4>中国国家标准 (GB 3095-2012)</h4><p>内置标准分段多级线性内插算法。系统能自动识别 CO 要素的量纲差异，并在运算前将其从微克自动升阶换算为毫克。</p>",
    "<h4>美国 EPA 空气质量规范</h4><p>契合美标分段浓度阶梯函数。针对特定颗粒物在低浓度边界的健康响应进行了针对性的高阶动态加权。</p>",
    "<h4>数据源底层定义</h4><p>数据源挂载于本地 <code>/data/aqdata.db</code>。站点坐标采用无偏 WGS-84 投影地理坐标系存储，与底图几何中心轴完全对齐。</p>",
    "<h4>全生命周期极客快捷键</h4><ul><li><b>W / S</b> : 上下循环选择显示指标 (CO~AQI)</li><li><b>Q / E</b> : 升降轮换多国 AQI 标准</li><li><b>A / D</b> : 历史时序向后/向前回溯（长按触发自动放映）</li><li><b>T</b> : 唤醒/隐藏时间整点下拉选择网格</li><li><b>R</b> : 一键消除时轴切回实时追踪视图</li><li><b>I</b> : 弹出/关闭本系统说明看板</li></ul>",
    "<h4>关于</h4><p>aqobs v0.2<br/>High-Resolution Spatial-Temporal Environmental Spatial Terminal.</p>"
];

function switchTab(idx) {
    document.querySelectorAll('.modal-tab').forEach((el, i) => {
        if (i === idx) el.classList.add('active'); else el.classList.remove('active');
    });
    document.getElementById('modal-content').innerHTML = helpTexts[idx];
}

// 【修复/重构要点】：将全局切换函数显示暴露给全局作用域，确保 HTML 中的 onclick 映射完好生效
window.switchTab = switchTab;

window.addEventListener('resize', () => {
    if (STATE.isHistory) {
        buildTimeSliderTicks();
        syncUIStateAndURL();
    }
});

window.onload = async () => {
    await applicationMain();
};