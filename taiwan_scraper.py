import asyncio
import os
import json
import random
from datetime import datetime, timezone, timedelta
import httpx

# ==================== 配置区 ====================
STATION_FILE = "station_ids.json"
OUTPUT_DIR = "data_output"
CONCURRENCY_LIMIT = 3  # 严格限制并发数，防止被封 IP
MIN_DELAY = 0.5        # 请求间的最小随机延迟（秒）
MAX_DELAY = 1.5        # 请求间的最大随机延迟（秒）
TIMEOUT_SECONDS = 20.0 # 配套的高峰期响应超时时间

# 统一的反爬虫伪装 Headers
BASE_HEADERS = {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh-TW;q=0.9,zh;q=0.8,en;q=0.7,ja;q=0.6',
    'Connection': 'keep-alive',
    'Origin': 'https://airtw.moenv.gov.tw',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"'
}

# ==================== 核心逻辑 ====================

def calculate_target_time():
    """根据东八区当前时间判定抓取的整点目标，并生成对应的 UnixTime 和 URL 字符串"""
    tz_taiwan = timezone(timedelta(hours=8))
    now_taiwan = datetime.now(timezone.utc).astimezone(tz_taiwan)
    
    # 50分前用当前小时整点，50分及以后用上一个小时整点
    if now_taiwan.minute < 50:
        target_dt = now_taiwan.replace(minute=0, second=0, microsecond=0)
    else:
        target_dt = (now_taiwan - timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        
    unix_time = int(target_dt.timestamp())
    # 格式化输出供 URL 传参使用
    time_str = target_dt.strftime("%Y/%m/%d %H:00")
    return unix_time, time_str

def clean_value(val):
    """指标清洗：异常字符串或负数全部置 None (JSON序列化后为 null)"""
    if val is None:
        return None
    val_s = str(val).strip()
    
    # 匹配已知的异常标志字符
    invalid_flags = {"儀器異常", "有效數據不足", "數據接收中", "未監測", "設備維護", "-", "—", "null", ""}
    if val_s in invalid_flags:
        return None
        
    try:
        num = float(val_s)
        return num if num >= 0 else None
    except ValueError:
        return None

async def fetch_station_data(client, semaphore, abbr, station_id, unix_time, time_str):
    """针对单个站点执行请求并提取清洗数据"""
    async with semaphore:
        # 随机延迟，模拟人类行为
        await asyncio.sleep(random.uniform(MIN_DELAY, MAX_DELAY))
        
        abbr_int = int(abbr)
        url = ""
        method = "GET"
        data_payload = None
        headers = BASE_HEADERS.copy()

        # 分流配置不同的请求终点和参数结构
        if 1 <= abbr_int <= 199:
            url = "https://airtw.moenv.gov.tw/ajax.aspx"
            method = "POST"
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
            headers['Referer'] = 'https://airtw.moenv.gov.tw/CHT/EnvMonitoring/Central/CentralMonitoring.aspx'
            data_payload = {
                'Target': 'air_list',
                'SiteID': str(abbr),
                'Datatime': time_str,
                'Type': ''
            }
        elif 1000 <= abbr_int <= 1999:
            url = f"https://airtw.moenv.gov.tw/ajaxCS.aspx?Type=GetSiteDetail&SiteType=地方環保局&SiteID={abbr}&QueryTime={time_str}"
            headers['Referer'] = 'https://airtw.moenv.gov.tw/CHT/EnvMonitoring/Local/LocalMonitoring.aspx'
        elif 2000 <= abbr_int <= 2999:
            url = f"https://airtw.moenv.gov.tw/ajaxCS.aspx?Type=GetSiteDetail&SiteType=特殊性工業區&SiteID={abbr}&QueryTime={time_str}"
            headers['Referer'] = 'https://airtw.moenv.gov.tw/CHT/EnvMonitoring/Local/LocalMonitoring.aspx'
        elif 3000 <= abbr_int <= 3999:
            url = f"https://airtw.moenv.gov.tw/ajaxCS.aspx?Type=GetSiteDetail&SiteType=大型事業&SiteID={abbr}&QueryTime={time_str}"
            headers['Referer'] = 'https://airtw.moenv.gov.tw/CHT/EnvMonitoring/Local/LocalMonitoring.aspx'
        else:
            print(f"[-] 未知范围的站点 abbr: {abbr} (ID: {station_id})，跳过。")
            return None

        try:
            if method == "POST":
                resp = await client.post(url, headers=headers, data=data_payload, timeout=TIMEOUT_SECONDS)
            else:
                resp = await client.get(url, headers=headers, timeout=TIMEOUT_SECONDS)
                
            if resp.status_code != 200:
                print(f"[-] 站点 {abbr} 请求失败，状态码: {resp.status_code}")
                return None
                
            raw_json = resp.json()
            if not isinstance(raw_json, list) or not raw_json:
                return None

            # 数据解析分流
            pm25, pm10, o3, no2, so2, co = None, None, None, None, None, None

            if 1 <= abbr_int <= 199:
                # 扁平化小字典列表
                flat_map = {}
                for block in raw_json:
                    flat_map.update(block)
                pm25 = clean_value(flat_map.get("PM25_FIX"))
                pm10 = clean_value(flat_map.get("PM10_FIX"))
                o3   = clean_value(flat_map.get("O3_FIX"))
                no2  = clean_value(flat_map.get("NO2_FIX"))
                so2  = clean_value(flat_map.get("SO2_FIX"))
                co   = clean_value(flat_map.get("CO_FIX"))
            else:
                # 提取首个完整大字典
                site_data = raw_json[0]
                pm25 = clean_value(site_data.get("PM25"))
                pm10 = clean_value(site_data.get("PM10"))
                o3   = clean_value(site_data.get("O3"))
                no2  = clean_value(site_data.get("NO2"))
                so2  = clean_value(site_data.get("SO2"))
                co   = clean_value(site_data.get("CO"))

            # 如果六项指标全部为空，整条记录予以取消丢弃
            if all(v is None for v in [pm25, pm10, o3, no2, so2, co]):
                return None

            # 返回有效记录数据
            return {
                "station_id": station_id,
                "data": {
                    "PM2.5": pm25,
                    "PM10": pm10,
                    "O3": o3,
                    "NO2": no2,
                    "SO2": so2,
                    "CO": co
                }
            }

        except Exception as e:
            print(f"[-] 站点 {abbr} 抓取时发生异常: {str(e)}")
            return None

async def main():
    if not os.path.exists(STATION_FILE):
        print(f"错误: 找不到站点配置文件 {STATION_FILE}")
        return

    with open(STATION_FILE, "r", encoding="utf-8") as f:
        stations = json.load(f)

    unix_time, time_str = calculate_target_time()
    print(f"[+] 初始化完成。计算出的抓取目标整点时间为: {time_str} (UnixTime: {unix_time})")

    semaphore = asyncio.Semaphore(CONCURRENCY_LIMIT)
    
    # 建立持久化 Client 会话，提升高频请求性能
    async with httpx.AsyncClient(verify=False) as client:
        tasks = []
        for item in stations:
            abbr = str(item.get("abbr", "")).strip()
            station_id = item.get("id")
            if abbr and station_id:
                tasks.append(fetch_station_data(client, semaphore, abbr, station_id, unix_time, time_str))
        
        print(f"[+] 开始并发异步调度，总计站点数: {len(tasks)}")
        results = await asyncio.gather(*tasks)

    # ==================== 结果结构化重组 ====================
    # 构建以 UnixTime 和 StationID 作为 JSON 复合主键的双层嵌套字典结构
    output_json = {str(unix_time): {}}

    valid_count = 0
    for res in results:
        if res:
            s_id = str(res["station_id"])
            output_json[str(unix_time)][s_id] = res["data"]
            valid_count += 1

    print(f"[+] 抓取清洗结束。有效非空记录数: {valid_count} 条。")

    # 结果持久化暂存，供 GitHub Artifact 归档
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    file_name = f"air_data_{unix_time}.json"
    output_path = os.path.join(OUTPUT_DIR, file_name)
    
    with open(output_path, "w", encoding="utf-8") as out_f:
        json.dump(output_json, out_f, ensure_ascii=False, indent=2)
    print(f"[+] 数据成功写入暂存文件: {output_path}")

if __name__ == "__main__":
    # 针对 Windows 调试环境的兼容性处理
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
