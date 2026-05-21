import os
import sys
import io
import xlrd
import time
import re
import json
import stat
from datetime import datetime
import xml.etree.ElementTree as ET
from xml.dom import minidom
from werkzeug.utils import secure_filename

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE4_UPLOAD_FOLDER = os.path.join(BASE_DIR, 'module4_uploads')
MODULE4_DOWNLOAD_FOLDER = os.path.join(BASE_DIR, 'module4_downloads')
MODULE4_CONFIG_FOLDER = os.path.join(BASE_DIR, 'module4_config')
ALLOWED_EXTENSIONS = {'xls'}

for folder in [MODULE4_UPLOAD_FOLDER, MODULE4_DOWNLOAD_FOLDER, MODULE4_CONFIG_FOLDER]:
    os.makedirs(folder, exist_ok=True)
    try:
        os.chmod(folder, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    except:
        pass

D_COL = 3
J_COL = 9
K_COL = 10
G_COL = 6
C_COL = 2

J2K2_CONFIG_PATH = os.path.join(MODULE4_CONFIG_FOLDER, 'j2k2_format_config.json')

def prettify_xml(elem):
    try:
        rough_string = ET.tostring(elem, 'utf-8')
        reparsed = minidom.parseString(rough_string)
        
        def fix_self_closing_tags(xml_string):
            self_close_tags = ['FileSchema', 'Version', 'dpi', 'WP', 'ScanRate', 'SlaveID', 'Enable', 'StopOnError',
                               'OneBased', 'RowsDialog', 'HideNames', 'HexMode', 'DisplayAddr', 'ColCount', 'RowCount',
                               'ScrollPosV', 'ScrollPosH', 'FocusRow', 'FocusCol', 'Eachread', 'Rate', 'LogChangedOnly',
                               'LogErrors', 'LogErrorsOnly', 'LogAddress', 'LogDate', 'TDelimiter', 'LogMs', 'Delimiter',
                               'AutoStart', 'Flush', 'Append', 'NewLogFileAtMidnight', 'InsertHeader', 'NameCellsInTopRow',
                               'PollDefinition', 'LogName', 'StopAfter', 'Function', 'Address', 'Quantity',
                               'EnronMode', 'Colors', 'Compare', 'Font', 'Scales', 'ValueNames', 'ChartSeries', 'BinNames']
            for tag in self_close_tags:
                xml_string = xml_string.replace(f'></{tag}>', '/>')
            xml_string = xml_string.replace('encoding="utf-8"', 'encoding="UTF-8"')
            return xml_string
        
        pretty_xml = reparsed.toprettyxml(indent='   ', encoding='UTF-8').decode('UTF-8')
        pretty_xml = '\n'.join([line for line in pretty_xml.split('\n') if line.strip()])
        return fix_self_closing_tags(pretty_xml)
    except Exception as e:
        print(f"[工具错误] XML格式化失败：{str(e)}")
        raise

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def init_default_j2k2_config():
    default_config = {
        "match_rules": [
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 4,
                "trigger_k2": 1,
                "f_value": 1,
                "mode": "16位无符号整形（1寄存器=1名称）",
                "description": "J2=4且K2=1→16位无符号整形解析"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 4,
                "trigger_k2": 9,
                "f_value": 0,
                "mode": "16位有符号整形（1寄存器=1名称）",
                "description": "J2=4且K2=9→16位有符号整形解析（常用）"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 5,
                "f_value": 10,
                "mode": "J2=8且K2=5→32位浮点数小端",
                "description": "J2=8且K2=5→32位浮点数小端解析（f=10）"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 15,
                "f_value": 5,
                "mode": "J2=8且K2=15→32位浮点数大端",
                "description": "J2=8且K2=15→32位浮点数大端解析（f=5，D59行适用）"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 1,
                "f_value": 17,
                "mode": "UINT32 大端模式",
                "description": "J2=8且K2=1→UINT32大端解析"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 8,
                "f_value": 18,
                "mode": "UINT32 小端模式交换",
                "description": "J2=8且K2=8→UINT32小端交换解析"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 10,
                "f_value": 8,
                "mode": "INT32 小端模式交换",
                "description": "J2=8且K2=10→INT32小端交换解析"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 14,
                "f_value": 20,
                "mode": "UINT32 小端模式",
                "description": "J2=8且K2=14→UINT32小端解析"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 17,
                "f_value": 9,
                "mode": "INT32 大端模式",
                "description": "J2=8且K2=17→INT32大端解析"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 18,
                "f_value": 14,
                "mode": "INT32 小端模式（默认）",
                "description": "J2=8且K2=18→INT32小端解析"
            },
            {
                "trigger_type": "k2_only",
                "trigger_k2": 2,
                "f_value": 4,
                "mode": "32位浮点数小端模式交换",
                "description": "仅K2=2→32位浮点数小端交换解析"
            },
            {
                "trigger_type": "k2_only",
                "trigger_k2": 5,
                "f_value": 10,
                "mode": "32位浮点数小端",
                "description": "仅K2=5→32位浮点数小端解析"
            },
            {
                "trigger_type": "k2_only",
                "trigger_k2": 15,
                "f_value": 5,
                "mode": "32位浮点数大端",
                "description": "仅K2=15→32位浮点数大端解析（降级备用规则）"
            }
        ],
        "default_rule": {
            "f_value": 14,
            "mode": "INT32 小端模式（默认）",
            "description": "J2/K2无匹配时使用的默认规则"
        }
    }
    try:
        with open(J2K2_CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(default_config, f, ensure_ascii=False, indent=2)
        try:
            os.chmod(J2K2_CONFIG_PATH, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        except:
            pass
        print(f"[初始化日志] J2K2配置文件已创建：{J2K2_CONFIG_PATH}（含J2=8新规则）")
    except Exception as e:
        print(f"[警告] 初始化J2K2配置失败：{str(e)}")
    return default_config

def load_j2k2_config():
    if not os.path.exists(J2K2_CONFIG_PATH):
        return init_default_j2k2_config()
    
    try:
        file_mtime = os.path.getmtime(J2K2_CONFIG_PATH)
        mtime_str = datetime.fromtimestamp(file_mtime).strftime("%Y-%m-%d %H:%M:%S")
    except Exception as e:
        mtime_str = "未知"
        print(f"[警告] 获取配置文件时间失败：{str(e)}")
    
    try:
        with open(J2K2_CONFIG_PATH, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        if not isinstance(config.get('match_rules'), list) or not isinstance(config.get('default_rule'), dict):
            raise ValueError("配置结构错误：match_rules需为列表，default_rule需为字典")
        
        required_new_rules = [
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 5,
                "f_value": 10,
                "mode": "J2=8且K2=5→32位浮点数小端",
                "description": "J2=8且K2=5→32位浮点数小端解析（f=10）"
            },
            {
                "trigger_type": "j2_k2",
                "trigger_j2": 8,
                "trigger_k2": 15,
                "f_value": 5,
                "mode": "J2=8且K2=15→32位浮点数大端",
                "description": "J2=8且K2=15→32位浮点数大端解析（f=5，D59行适用）"
            }
        ]
        
        added_count = 0
        existing_rules = config['match_rules']
        for new_rule in required_new_rules:
            rule_exists = any(
                r.get('trigger_type') == new_rule['trigger_type'] and 
                r.get('trigger_j2') == new_rule['trigger_j2'] and 
                r.get('trigger_k2') == new_rule['trigger_k2']
                for r in existing_rules
            )
            if not rule_exists:
                existing_rules.append(new_rule)
                added_count += 1
                print(f"[热加载日志] 补充J2K2规则：{new_rule['description']}")
        
        if not config.get('default_rule'):
            config['default_rule'] = {
                "f_value": 14,
                "mode": "INT32 小端模式（默认）",
                "description": "补充的默认规则"
            }
            print(f"[热加载日志] 补充默认规则：INT32小端模式（f=14）")
        
        print(f"[热加载日志] 读取J2K2配置→修改时间：{mtime_str}，规则数：{len(config['match_rules'])}（新增{added_count}条）")
        return config
    except Exception as e:
        print(f"[警告] 读取J2K2配置失败（{str(e)}）→使用默认规则（含J2=8新规则）")
        return init_default_j2k2_config()

def parse_dynamic_d_data(sheet, d_row_idx, sheet_name):
    func_code = 3
    start_addr = 0
    register_count = 2
    is_valid = False
    
    try:
        if d_row_idx >= sheet.nrows or D_COL >= sheet.ncols:
            print(f"[解析日志] D{d_row_idx+1}（行{d_row_idx}）：行/列超出范围→无效")
            return func_code, start_addr, register_count, is_valid
        
        d_raw = sheet.cell_value(d_row_idx, D_COL)
        print(f"[解析日志] D{d_row_idx+1}：原始值={d_raw}，类型={type(d_raw).__name__}")
        
        if isinstance(d_raw, (int, float)):
            d_str = str(int(d_raw)).strip().upper() if d_raw.is_integer() else str(d_raw).strip().upper()
        else:
            d_str = str(d_raw).strip().upper()
        print(f"[解析日志] D{d_row_idx+1}：处理后={d_str}")
        
        d_clean = re.sub(r'[^0-9A-F]', '', d_str)
        print(f"[解析日志] D{d_row_idx+1}：16进制过滤后={d_clean}，长度={len(d_clean)}")
        
        if 8 <= len(d_clean) < 10:
            d_clean = d_clean.zfill(10)
            print(f"[解析日志] D{d_row_idx+1}：补0后={d_clean}（长度10）")
        elif len(d_clean) != 10:
            print(f"[解析日志] D{d_row_idx+1}：长度≠10→无效")
            return func_code, start_addr, register_count, is_valid
        
        func_hex = d_clean[0:2]
        addr_hex = d_clean[2:6]
        count_hex = d_clean[6:10]
        
        func_code = int(func_hex, 16)
        start_addr = int(addr_hex, 16)
        register_count = int(count_hex, 16)
        
        if func_code in [2, 3, 4] and 1 <= register_count <= 65535:
            is_valid = True
            print(f"[解析日志] ✅ D{d_row_idx+1}有效：功能码={func_code}，起始地址={start_addr}，寄存器数={register_count}")
        else:
            print(f"[解析日志] D{d_row_idx+1}无效：功能码={func_code}（需2/3/4）或寄存器数={register_count}（需1-65535）")
    
    except Exception as e:
        print(f"[解析日志] ❌ D{d_row_idx+1}解析失败：{str(e)}→无效")
    
    return func_code, start_addr, register_count, is_valid

def parse_jk_from_xls(sheet, jk_row_idx):
    j_val = None
    k_val = None
    
    try:
        if jk_row_idx < sheet.nrows and J_COL < sheet.ncols:
            j_raw = sheet.cell_value(jk_row_idx, J_COL)
            if isinstance(j_raw, str):
                j_raw = j_raw.strip()
                if not j_raw:
                    print(f"[解析日志] J{jk_row_idx+1}：值为空/空格→设为None")
                    pass
                elif j_raw.isdigit():
                    j_int = int(j_raw)
                    j_val = j_int if j_int != 0 else None
                else:
                    print(f"[解析日志] J{jk_row_idx+1}：值为非数字字符串→设为None")
            elif isinstance(j_raw, (int, float)):
                if j_raw.is_integer():
                    j_int = int(j_raw)
                    j_val = j_int if j_int != 0 else None
                else:
                    print(f"[解析日志] J{jk_row_idx+1}：值为非整数→设为None")
        print(f"[解析日志] J{jk_row_idx+1}：最终值={j_val}（None=无效/0/空）")
    except Exception as e:
        print(f"[解析日志] J{jk_row_idx+1}解析失败：{str(e)}→设为None")
    
    try:
        if jk_row_idx < sheet.nrows and K_COL < sheet.ncols:
            k_raw = sheet.cell_value(jk_row_idx, K_COL)
            if isinstance(k_raw, str):
                k_raw = k_raw.strip()
                if not k_raw:
                    print(f"[解析日志] K{jk_row_idx+1}：值为空/空格→设为None")
                    pass
                elif k_raw.isdigit():
                    k_int = int(k_raw)
                    k_val = k_int if k_int != 0 else None
                else:
                    print(f"[解析日志] K{jk_row_idx+1}：值为非数字字符串→设为None")
            elif isinstance(k_raw, (int, float)):
                if k_raw.is_integer():
                    k_int = int(k_raw)
                    k_val = k_int if k_int != 0 else None
                else:
                    print(f"[解析日志] K{jk_row_idx+1}：值为非整数→设为None")
        print(f"[解析日志] K{jk_row_idx+1}：最终值={k_val}（None=无效/0/空）")
    except Exception as e:
        print(f"[解析日志] K{jk_row_idx+1}解析失败：{str(e)}→设为None")
    
    return j_val, k_val

def get_c_text(sheet, c_row_idx):
    default_c = "维杜电量仪MBP"
    try:
        if c_row_idx < sheet.nrows and C_COL < sheet.ncols:
            c_raw = str(sheet.cell_value(c_row_idx, C_COL)).strip()
            if c_raw and not c_raw.isdigit() and "文档" not in c_raw and "A1" not in c_raw and "单元格" not in c_raw:
                print(f"[解析日志] C{c_row_idx+1}：值={c_raw}")
                return c_raw
    except Exception as e:
        print(f"[解析日志] C{c_row_idx+1}解析失败：{str(e)}")
    print(f"[解析日志] C{c_row_idx+1}：使用默认值={default_c}")
    return default_c

def get_full_params(sheet, g_start_row, param_count):
    params = []
    print(f"[解析日志] 从G{g_start_row+1}开始读取{param_count}个寄存器名称（完整）")
    
    for i in range(param_count):
        current_row = g_start_row + i
        current_idx = len(params) + 1
        try:
            if current_row >= sheet.nrows or G_COL >= sheet.ncols:
                raise Exception("行/列超出Excel范围")
            
            g_val = str(sheet.cell_value(current_row, G_COL)).strip()
            if not g_val or g_val.isdigit() or "文档" in g_val or "A1" in g_val or "单元格" in g_val:
                raise Exception(f"值无效（{g_val}）")
            
            params.append(g_val)
            print(f"[解析日志] G{current_row+1}：{g_val}→已加入")
        except Exception as e:
            default_val = f"寄存器{current_idx}"
            params.append(default_val)
            print(f"[解析日志] G{current_row+1}：{str(e)}→补默认值={default_val}")
    
    while len(params) < param_count:
        default_val = f"寄存器{len(params)+1}"
        params.append(default_val)
        print(f"[解析日志] 名称不足→补默认值={default_val}")
    
    print(f"[解析日志] 完整寄存器名称列表：{params}（共{len(params)}个）")
    return params

def generate_single_mbp(mbp_data, xls_filename):
    try:
        required_keys = ["func_code", "start_addr", "register_count", "param_count", 
                        "params", "target_f", "c2_text", "is_16bit_mode", "d_row_num"]
        for key in required_keys:
            if key not in mbp_data or mbp_data[key] is None:
                raise ValueError(f"缺少必要参数：{key}")
        
        func_code = mbp_data["func_code"]
        start_addr = mbp_data["start_addr"]
        register_count = mbp_data["register_count"]
        param_count = mbp_data["param_count"]
        full_params = mbp_data["params"]
        target_f = mbp_data["target_f"]
        c2_text = mbp_data["c2_text"]
        is_16bit_mode = mbp_data["is_16bit_mode"]
        d_row_num = mbp_data["d_row_num"]
        matched_mode = mbp_data.get("matched_mode", "16位无符号整形（默认）")
        is_float_mode = "浮点数" in matched_mode
        float_endian = "大端" if "大端" in matched_mode else "小端" if "小端" in matched_mode else ""
        is_coil_mode = mbp_data.get("is_coil_mode", False)
        
        if is_coil_mode:
            col_count = 8
            wp_left = "9"
            wp_right = "1617"
            wp_top = "10"
            wp_bottom = "617"
            wp_showcmd = "1"
            wp_maxposx = "-1"
            wp_maxposy = "-1"
            wp_minposx = "-1"
            wp_minposy = "-1"
            scroll_pos_h = "0"
            focus_row = "10"
            focus_col = "1"
            format_rule = "无Formats节点（线圈模式）"
        elif is_16bit_mode:
            col_count = 6
            wp_left = "0"
            wp_right = "1690"
            wp_top = "0"
            wp_bottom = "511"
            wp_showcmd = "3"
            wp_maxposx = "-9"
            wp_maxposy = "-38"
            wp_minposx = "-1"
            wp_minposy = "-1"
            scroll_pos_h = "0"
            focus_row = "1"
            focus_col = "2"
            format_rule = "所有F标签f=target_f、v=0"
        else:
            col_count = 18
            wp_left = "0"
            wp_right = "1690"
            wp_top = "0"
            wp_bottom = "645"
            wp_showcmd = "3"
            wp_maxposx = "-9"
            wp_maxposy = "-38"
            wp_minposx = "-1"
            wp_minposy = "-1"
            scroll_pos_h = "745"
            focus_row = "10"
            focus_col = "1"
            format_rule = "偶索引f=target_f/v=0，奇索引f=16/v=--"
        
        processed_c = re.sub(r'[\\/:*?"<>|]', '_', c2_text).strip() or "维杜电量仪MBP"
        if is_coil_mode:
            mode_suffix = "_线圈模式"
        else:
            mode_suffix = "_16位模式" if is_16bit_mode else f"_浮点数{float_endian}" if is_float_mode else ""
        timestamp = int(time.time())
        mbp_filename = f"{processed_c}_D{d_row_num}_{timestamp}_Func{func_code}_Addr{start_addr}_Reg{register_count}{mode_suffix}.mbp"
        mbp_save_path = os.path.join(MODULE4_DOWNLOAD_FOLDER, mbp_filename)
        print(f"\n[生成日志] 开始生成D{d_row_num}对应的MBP：{mbp_save_path}（模式：{matched_mode}，f={target_f}）")
        
        root = ET.Element("ModbusPoll")
        
        ET.SubElement(root, "FileSchema", r="0", c="0")
        ET.SubElement(root, "Version", major="12", minor="2", patch="0", build="2516")
        dpi_elem = ET.SubElement(root, "dpi")
        dpi_elem.text = "120"
        
        ET.SubElement(root, "WP", left=wp_left, right=wp_right, top=wp_top, bottom=wp_bottom,
                     ShowCmd=wp_showcmd, MaxPosX=wp_maxposx, MaxPosY=wp_maxposy, MinPosX=wp_minposx, MinPosY=wp_minposy)
        
        ET.SubElement(root, "ScanRate").text = "1000"
        ET.SubElement(root, "SlaveID").text = "1"
        ET.SubElement(root, "Enable").text = "1"
        ET.SubElement(root, "StopOnError").text = "0"
        ET.SubElement(root, "OneBased").text = "0"
        ET.SubElement(root, "RowsDialog").text = "0"
        ET.SubElement(root, "HideNames").text = "0"
        ET.SubElement(root, "HexMode").text = "0"
        ET.SubElement(root, "DisplayAddr").text = "0"
        ET.SubElement(root, "ColCount").text = str(col_count)
        ET.SubElement(root, "RowCount").text = "10"
        
        column_width = ET.SubElement(root, "ColumnWidth")
        if is_coil_mode:
            cw_values = ["1728", "1024", "1792", "1024", "1024", "1024", "1024", "1024"]
        elif is_16bit_mode:
            cw_values = ["1392", "2216", "2136", "1024", "1024", "1024"]
        else:
            cw_values = [
                "3224", "1024", "1024", "1024", "1024", "1024", "1024", "1024", "1024", 
                "1024", "1024", "1024", "1560", "1024", "1024", "1024", "1024", "1024"
            ]
        for cw in cw_values:
            ET.SubElement(column_width, "CW").text = cw
        
        row_hight = ET.SubElement(root, "RowHight")
        for _ in range(10):
            ET.SubElement(row_hight, "RH").text = "208"
        
        ET.SubElement(root, "ScrollPosV").text = "0"
        ET.SubElement(root, "ScrollPosH").text = scroll_pos_h
        ET.SubElement(root, "FocusRow").text = focus_row
        ET.SubElement(root, "FocusCol").text = focus_col
        
        log_text = ET.SubElement(root, "LogText")
        ET.SubElement(log_text, "Eachread").text = "0"
        ET.SubElement(log_text, "Rate").text = "1"
        ET.SubElement(log_text, "LogChangedOnly").text = "0"
        ET.SubElement(log_text, "LogErrors").text = "0"
        ET.SubElement(log_text, "LogErrorsOnly").text = "0"
        ET.SubElement(log_text, "LogAddress").text = "1"
        ET.SubElement(log_text, "LogDate").text = "0"
        ET.SubElement(log_text, "TDelimiter").text = "0"
        ET.SubElement(log_text, "LogMs").text = "1"
        ET.SubElement(log_text, "Delimiter").text = "0"
        ET.SubElement(log_text, "AutoStart").text = "0"
        ET.SubElement(log_text, "Flush").text = "0"
        ET.SubElement(log_text, "Append").text = "0"
        ET.SubElement(log_text, "NewLogFileAtMidnight").text = "0"
        ET.SubElement(log_text, "InsertHeader").text = "0"
        ET.SubElement(log_text, "NameCellsInTopRow").text = "0"
        ET.SubElement(log_text, "PollDefinition").text = "0"
        ET.SubElement(log_text, "LogName").text = "Type log name here"
        ET.SubElement(log_text, "FileName").text = ""
        
        log_excel = ET.SubElement(root, "LogExcel")
        ET.SubElement(log_excel, "Eachread").text = "1"
        ET.SubElement(log_excel, "Rate").text = "1"
        ET.SubElement(log_excel, "StopAfter").text = "1000"
        ET.SubElement(log_excel, "LogChangedOnly").text = "0"
        ET.SubElement(log_excel, "InsertHeader").text = "1"
        ET.SubElement(log_excel, "NameCellsInTopRow").text = "1"
        ET.SubElement(log_excel, "PollDefinition").text = "1"
        ET.SubElement(log_excel, "LogName").text = "Type log name here"
        
        data = ET.SubElement(root, "Data")
        ET.SubElement(data, "Function").text = str(func_code)
        ET.SubElement(data, "Address").text = str(start_addr)
        ET.SubElement(data, "Quantity").text = str(register_count)
        ET.SubElement(data, "EnronMode").text = "0"
        
        if not is_coil_mode:
            formats = ET.SubElement(data, "Formats")
            if is_16bit_mode:
                for _ in range(register_count):
                    ET.SubElement(formats, "F", f=str(target_f), v="0")
            else:
                for i in range(register_count):
                    if i % 2 == 0:
                        f_val = str(target_f)
                        v_val = "0"
                    else:
                        f_val = "16"
                        v_val = "--"
                    ET.SubElement(formats, "F", f=f_val, v=v_val)
            print(f"[生成日志] Formats节点：{format_rule}，共{register_count}个F标签")
        else:
            print(f"[生成日志] 线圈模式：无Formats节点")
        
        bytes_node = ET.SubElement(data, "Bytes")
        if is_coil_mode:
            byte_count = register_count
        else:
            byte_count = register_count * 2
        byte_values = ["0"] * byte_count
        for b_val in byte_values:
            ET.SubElement(bytes_node, "B").text = b_val
        
        cell_data = ET.SubElement(data, "CellData")
        if is_coil_mode or is_16bit_mode:
            max_param_idx = min(len(full_params), register_count)
            for idx in range(max_param_idx):
                cell = ET.SubElement(cell_data, "Cell", idx=str(idx))
                ET.SubElement(cell, "Colors")
                ET.SubElement(cell, "Compare", compare1="0", compare2="0", conditional1="0", conditional2="0")
                name_elem = ET.SubElement(cell, "Name")
                name_elem.text = full_params[idx]
                ET.SubElement(cell, "Font", used="false")
            print(f"[生成日志] {'线圈' if is_coil_mode else '16位'}模式：CellData idx连续，填充{max_param_idx}个名称")
        else:
            max_param_idx = min(len(full_params), param_count)
            for idx in range(max_param_idx):
                cell_idx = idx * 2
                cell = ET.SubElement(cell_data, "Cell", idx=str(cell_idx))
                ET.SubElement(cell, "Colors")
                ET.SubElement(cell, "Compare", compare1="0", compare2="0", conditional1="0", conditional2="0")
                name_elem = ET.SubElement(cell, "Name")
                name_elem.text = full_params[idx]
                ET.SubElement(cell, "Font", used="false")
            print(f"[生成日志] 32位{float_endian}模式：CellData idx间隔2，填充{max_param_idx}个名称")
        
        if is_coil_mode:
            ET.SubElement(data, "ChartSeries")
        else:
            bin_names = ET.SubElement(data, "BinNames")
            bin_name = ET.SubElement(bin_names, "BinName", idx="0")
            bin_sub_tags = ["B0", "B1", "B2", "B3", "B4", "B5", "B6", "B7", 
                            "B8", "B9", "B10", "B11", "B12", "B13", "B14", "B15"]
            bin_sub_values = ["", "", "", "", "", "", "", "", "", "", "", "4", "4", "3", "2", "KT"]
            for tag, val in zip(bin_sub_tags, bin_sub_values):
                tag_elem = ET.SubElement(bin_name, tag)
                tag_elem.text = val
            
            ET.SubElement(data, "Scales")
            ET.SubElement(data, "ValueNames")
            ET.SubElement(data, "ChartSeries")
        
        pretty_xml = prettify_xml(root)
        with open(mbp_save_path, 'w', encoding='UTF-8') as f:
            f.write(pretty_xml)
        
        if os.path.exists(mbp_save_path):
            file_size = os.path.getsize(mbp_save_path)
            if file_size < 100:
                raise Exception(f"文件过小（{file_size}字节）")
            print(f"[生成日志] ✅ D{d_row_num} MBP生成成功：{mbp_filename}（{file_size}字节）")
            return True, mbp_filename, f"D{d_row_num}：{c2_text}（{matched_mode}）"
        else:
            raise Exception("文件生成后未找到")
    except Exception as e:
        error_msg = f"生成失败：{str(e)}"
        print(f"[生成日志] ❌ D{d_row_num} MBP{error_msg}")
        return False, "", f"D{d_row_num}：{error_msg}"

def extract_multi_lnf_data(xls_path):
    multi_result = []
    try:
        if not os.path.exists(xls_path):
            raise Exception(f"Excel文件不存在：{xls_path}")
        if not os.access(xls_path, os.R_OK):
            raise Exception(f"无Excel文件读取权限：{xls_path}")
        
        workbook = xlrd.open_workbook(xls_path)
        sheet_names = workbook.sheet_names()
        print(f"\n[Excel解析日志] 打开文件：{xls_path}，包含Sheet：{sheet_names}")
        
        target_sheet = None
        target_sheet_name = ""
        priority_keywords = ["协议", "发送", "寄存器", "参数", "通讯"]
        for kw in priority_keywords:
            for name in sheet_names:
                if kw in name:
                    target_sheet = workbook.sheet_by_name(name)
                    target_sheet_name = name
                    break
            if target_sheet:
                break
        if not target_sheet:
            target_sheet = workbook.sheet_by_index(0)
            target_sheet_name = sheet_names[0]
        print(f"[Excel解析日志] 选择目标Sheet：{target_sheet_name}（行：{target_sheet.nrows}，列：{target_sheet.ncols}）")
        
        max_row = min(target_sheet.nrows, 1000)
        print(f"[Excel解析日志] 开始遍历D列（共{max_row}行，跳过超出部分）")
        for d_row_idx in range(max_row):
            d_row_num = d_row_idx + 1
            
            func_code, start_addr, register_count, is_valid = parse_dynamic_d_data(
                target_sheet, d_row_idx, target_sheet_name
            )
            if not is_valid:
                continue
            
            j_val, k_val = parse_jk_from_xls(target_sheet, d_row_idx)
            
            j2k2_config = load_j2k2_config()
            match_rules = j2k2_config.get('match_rules', [])
            default_rule = j2k2_config.get('default_rule', {
                "f_value": 14,
                "mode": "INT32 小端模式（默认）",
                "description": "配置异常时的默认规则"
            })
            matched_rule = None
            target_f = default_rule['f_value']
            matched_mode = default_rule['mode']
            
            if j_val is not None and k_val is not None:
                print(f"[Excel解析日志] D{d_row_num}：J={j_val}（有效），K={k_val}（有效）→尝试J2+K2匹配")
                for rule in match_rules:
                    if rule.get('trigger_type') == 'j2_k2' and rule.get('trigger_j2') == j_val and rule.get('trigger_k2') == k_val:
                        matched_rule = rule
                        target_f = rule.get('f_value', default_rule['f_value'])
                        matched_mode = rule.get('mode', default_rule['mode'])
                        break
                if matched_rule:
                    d59_tag = "（D59行匹配成功）" if d_row_num == 59 else ""
                    print(f"[Excel解析日志] D{d_row_num}：✅ 匹配J2+K2规则→f={target_f}，模式={matched_mode} {d59_tag}")
                else:
                    print(f"[Excel解析日志] D{d_row_num}：❌ 无匹配的J2+K2规则→尝试k2_only匹配")
                    for rule in match_rules:
                        if rule.get('trigger_type') == 'k2_only' and rule.get('trigger_k2') == k_val:
                            matched_rule = rule
                            target_f = rule.get('f_value', default_rule['f_value'])
                            matched_mode = rule.get('mode', default_rule['mode'])
                            break
                    if matched_rule:
                        print(f"[Excel解析日志] D{d_row_num}：✅ 降级匹配k2_only规则→f={target_f}，模式={matched_mode}")
                    else:
                        print(f"[Excel解析日志] D{d_row_num}：❌ 无匹配的k2_only规则→使用默认规则")
                        matched_mode = default_rule['mode']
            
            elif k_val is not None:
                print(f"[Excel解析日志] D{d_row_num}：J={j_val}（无效），K={k_val}（有效）→尝试k2_only匹配")
                for rule in match_rules:
                    if rule.get('trigger_type') == 'k2_only' and rule.get('trigger_k2') == k_val:
                        matched_rule = rule
                        target_f = rule.get('f_value', default_rule['f_value'])
                        matched_mode = rule.get('mode', default_rule['mode'])
                        break
                if matched_rule:
                    print(f"[Excel解析日志] D{d_row_num}：✅ 匹配k2_only规则→f={target_f}，模式={matched_mode}")
                else:
                    print(f"[Excel解析日志] D{d_row_num}：❌ 无匹配的k2_only规则→使用默认规则")
                    matched_mode = default_rule['mode']
            
            elif j_val is not None:
                print(f"[Excel解析日志] D{d_row_num}：J={j_val}（有效），K={k_val}（无效）→尝试j2_only匹配")
                for rule in match_rules:
                    if rule.get('trigger_type') == 'j2_only' and rule.get('trigger_j2') == j_val:
                        matched_rule = rule
                        target_f = rule.get('f_value', default_rule['f_value'])
                        matched_mode = rule.get('mode', default_rule['mode'])
                        break
                if matched_rule:
                    print(f"[Excel解析日志] D{d_row_num}：✅ 匹配j2_only规则→f={target_f}，模式={matched_mode}")
                else:
                    print(f"[Excel解析日志] D{d_row_num}：❌ 无匹配的j2_only规则→使用默认规则")
                    matched_mode = default_rule['mode']
            
            else:
                print(f"[Excel解析日志] D{d_row_num}：J={j_val}（无效），K={k_val}（无效）→使用默认规则")
                matched_mode = default_rule['mode']
            
            is_16bit_mode = False
            is_float_mode = "浮点数" in matched_mode
            is_coil_mode = matched_rule.get('is_coil_mode', False) if matched_rule else False
            print(f"[Excel解析日志] D{d_row_num}：模式分析→16位={is_16bit_mode}，浮点数={is_float_mode}，线圈={is_coil_mode}")
            
            if is_coil_mode:
                param_count = register_count
            elif "16位" in matched_mode and matched_rule and matched_rule.get('trigger_type') == 'j2_k2':
                is_16bit_mode = True
                param_count = register_count
            elif is_float_mode or "32位" in matched_mode:
                param_count = max(1, register_count // 2)
            else:
                param_count = max(1, register_count // 2)
            print(f"[Excel解析日志] D{d_row_num}：最终参数数={param_count}（寄存器数={register_count}）")
            
            c2_text = get_c_text(target_sheet, d_row_idx)
            full_params = get_full_params(target_sheet, d_row_idx, param_count)
            params_preview = full_params[:3] + ["..."] if len(full_params) > 3 else full_params.copy()
            
            is_coil_mode = matched_rule.get('is_coil_mode', False) if matched_rule else False
            result_item = {
                "d_row_idx": d_row_idx,
                "d_row_num": d_row_num,
                "func_code": func_code,
                "start_addr": start_addr,
                "register_count": register_count,
                "param_count": param_count,
                "params": full_params,
                "params_preview": params_preview,
                "target_f": target_f,
                "c2_text": c2_text,
                "is_16bit_mode": is_16bit_mode,
                "is_coil_mode": is_coil_mode,
                "matched_mode": matched_mode,
                "used_sheet": target_sheet_name,
                "rule_status": "matched" if matched_rule else "default",
                "debug_info": {
                    "j_val": j_val,
                    "k_val": k_val,
                    "matched_rule_desc": matched_rule.get('description', 'default') if matched_rule else 'default'
                }
            }
            multi_result.append(result_item)
            print(f"[Excel解析日志] D{d_row_num}：组装结果完成→matched_mode={matched_mode}，rule_status={result_item['rule_status']}")
        
        print(f"\n[Excel解析日志] 解析完成：共找到{len(multi_result)}个有效D列行")
        return multi_result, f"成功解析Sheet[{target_sheet_name}]，找到{len(multi_result)}个有效发送串"
    except Exception as e:
        error_msg = f"Excel解析异常：{str(e)}"
        print(f"[Excel解析日志] ❌ {error_msg}")
        return [], error_msg
