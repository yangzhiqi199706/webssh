# -*- coding: utf-8 -*-
"""模块1：XLS文件处理核心逻辑（独立封装）"""
import xlrd
import xlwt
import os

# 配置项（独立管理）
XLS_CONFIG = {
    "COL_MAP": {
        "B": 1, "D": 3, "G": 6, "I": 8, "J": 9, "M": 12, "R": 17,
        "S": 18, "T": 19, "U": 20, "V": 21,
        "MAX_FILL_COL": 21
    },
    "I_UNIT_MAP": {
        "电压": "V", "电流": "A", "有功功率": "Kw", "无功功率": "Kwar",
        "视在功率": "Kva", "有功电能": "Kwh", "无功电能": "Kwarh",
        "频率": "Hz", "时间": "min", "温度": "℃", "湿度": "%"
    },
    "FAULT_WORDS": ["告警", "报警", "故障", "过流", "过压", "欠压", "计量异常", "通讯故障", "柜门异常", "散热故障"],
    "NO_REMOVE_DOT_ZERO_COLS": [3, 6],
    "FILL_COLOR": 43
}

def allowed_file(filename):
    """验证是否为xls格式"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() == 'xls'

def safe_get_val(row_data, col_idx, default=""):
    """安全获取行列值"""
    if isinstance(row_data, list) and len(row_data) > col_idx:
        val = row_data[col_idx]
        if col_idx in XLS_CONFIG["NO_REMOVE_DOT_ZERO_COLS"]:
            return val if val is not None else default
        return str(val).strip() if val is not None else default
    return default

def safe_set_val(row_data, col_idx, val):
    """安全设置行列值"""
    if len(row_data) <= col_idx:
        row_data += [""] * (col_idx - len(row_data) + 1)
    row_data[col_idx] = val
    return row_data

def is_valid_data(val):
    """判断是否为有效数据"""
    val_clean = str(val).strip().lower()
    return val_clean not in ["unknown", "null", "空", "none"] and val_clean != ""

def global_remove_dot_zero(val, col_idx):
    """全局去.0处理"""
    if col_idx in XLS_CONFIG["NO_REMOVE_DOT_ZERO_COLS"]:
        return val
    try:
        float_val = float(str(val).strip())
        if float_val.is_integer():
            return str(int(float_val))
        return str(val)
    except (ValueError, TypeError):
        return str(val)

def clean_b_column(val):
    """B列清洗逻辑"""
    return str(val).strip().replace("\n", "").replace("\t", "").replace(" ", "").replace("_", "").upper()

def process_xls(file_path, output_path):
    """核心处理函数"""
    wb = xlrd.open_workbook(file_path, formatting_info=False)
    ws = wb.sheet_by_index(0)
    row_total, col_total = ws.nrows, ws.ncols
    
    # 读取数据
    data = []
    for row_idx in range(row_total):
        row_data = []
        for col_idx in range(col_total):
            cell_val = ws.cell_value(row_idx, col_idx)
            if col_idx in XLS_CONFIG["NO_REMOVE_DOT_ZERO_COLS"]:
                row_data.append(cell_val)
            else:
                row_data.append(global_remove_dot_zero(cell_val, col_idx))
        data.append(row_data)
    
    # 业务逻辑处理
    fault_count = 0
    col_map = XLS_CONFIG["COL_MAP"]
    b_col, d_col, g_col, j_col, r_col, i_col, m_col = col_map["B"], col_map["D"], col_map["G"], col_map["J"], col_map["R"], col_map["I"], col_map["M"]
    
    # B列清洗+延续
    break_val_b = ""
    for row_idx in range(1, row_total):
        current_b = safe_get_val(data[row_idx], b_col)
        current_b_clean = clean_b_column(current_b)
        if is_valid_data(current_b_clean):
            break_val_b = current_b_clean
            data[row_idx] = safe_set_val(data[row_idx], b_col, break_val_b)
        elif break_val_b != "":
            data[row_idx] = safe_set_val(data[row_idx], b_col, break_val_b)
    
    # D/G列保护
    for row_idx in range(row_total):
        original_d = safe_get_val(data[row_idx], d_col)
        data[row_idx] = safe_set_val(data[row_idx], d_col, original_d)
        original_g = safe_get_val(data[row_idx], g_col)
        data[row_idx] = safe_set_val(data[row_idx], g_col, original_g)
    
    # J列去.0+延续
    break_val_j = ""
    for row_idx in range(1, row_total):
        current_j = safe_get_val(data[row_idx], j_col)
        current_j_clean = global_remove_dot_zero(current_j, j_col)
        if is_valid_data(current_j_clean):
            break_val_j = current_j_clean
            data[row_idx] = safe_set_val(data[row_idx], j_col, break_val_j)
        elif break_val_j != "":
            data[row_idx] = safe_set_val(data[row_idx], j_col, break_val_j)
    
    # R列填充
    for row_idx in range(1, row_total):
        b_val_clean = safe_get_val(data[row_idx], b_col)
        r_val = "2" if ("B" in b_val_clean or "C" in b_val_clean) else "1" if "A" in b_val_clean else ""
        data[row_idx] = safe_set_val(data[row_idx], r_col, r_val)
    
    # I列匹配单位
    for row_idx in range(1, row_total):
        current_r = safe_get_val(data[row_idx], r_col)
        current_g = str(safe_get_val(data[row_idx], g_col))
        current_i_original = safe_get_val(data[row_idx], i_col)
        
        if current_r == "1":
            matched_unit = ""
            for keyword, unit in XLS_CONFIG["I_UNIT_MAP"].items():
                if keyword in current_g:
                    matched_unit = unit
                    break
            data[row_idx] = safe_set_val(data[row_idx], i_col, matched_unit)
        elif current_r == "2":
            data[row_idx] = safe_set_val(data[row_idx], i_col, current_i_original)
        else:
            data[row_idx] = safe_set_val(data[row_idx], i_col, "")
    
    # M列故障标记
    for row_idx in range(1, row_total):
        current_r = safe_get_val(data[row_idx], r_col)
        current_g = str(safe_get_val(data[row_idx], g_col))
        is_fault = current_r == "2" and any(word in current_g for word in XLS_CONFIG["FAULT_WORDS"])
        data[row_idx] = safe_set_val(data[row_idx], m_col, "1" if is_fault else "")
        if is_fault:
            fault_count += 1
    
    # 写入文件
    wb_out = xlwt.Workbook(encoding="utf-8")
    ws_out = wb_out.add_sheet("处理结果", cell_overwrite_ok=True)
    
    # 样式定义
    header_style = xlwt.XFStyle()
    header_font = xlwt.Font()
    header_font.name = "宋体"
    header_font.height = 220
    header_font.bold = True
    header_style.font = header_font
    
    data_style = xlwt.XFStyle()
    data_font = xlwt.Font()
    data_font.name = "宋体"
    data_font.height = 200
    data_style.font = data_font
    
    d_style = xlwt.XFStyle()
    d_style.font = data_font
    d_style.num_format_str = "@"
    
    fill_style = xlwt.XFStyle()
    fill_style.font = data_font
    fill_pattern = xlwt.Pattern()
    fill_pattern.pattern = xlwt.Pattern.SOLID_PATTERN
    fill_pattern.pattern_fore_colour = XLS_CONFIG["FILL_COLOR"]
    fill_style.pattern = fill_pattern
    
    # 写入数据
    max_fill_col = col_map["MAX_FILL_COL"]
    for row_idx in range(len(data)):
        row_data = data[row_idx]
        for col_idx in range(len(row_data)):
            val = safe_get_val(row_data, col_idx)
            if row_idx == 0:
                ws_out.write(row_idx, col_idx, val, header_style)
            else:
                if col_idx == d_col:
                    ws_out.write(row_idx, col_idx, val, d_style)
                elif col_idx == g_col:
                    ws_out.write(row_idx, col_idx, val, data_style)
                else:
                    d_val = safe_get_val(row_data, d_col)
                    style = fill_style if (d_val != "" and col_idx <= max_fill_col) else data_style
                    ws_out.write(row_idx, col_idx, val, style)
    
    wb_out.save(output_path)
    return {
        "row_count": len(data),
        "col_count": max([len(row) for row in data]),
        "fault_count": fault_count,
        "status": "success"
    }

def parse_xls_for_preview(file_path, max_rows=200):
    """解析XLS为预览数据（默认仅返回前max_rows行数据）"""
    try:
        wb = xlrd.open_workbook(file_path, formatting_info=False)
        ws = wb.sheet_by_index(0)
        row_total = ws.nrows
        col_total = ws.ncols

        preview_data = []
        # 表头
        header = []
        for col_idx in range(col_total):
            header.append(str(ws.cell_value(0, col_idx)).strip())
        preview_data.append(header)

        # 数据行（限制预览行数）
        data_row_total = max(row_total - 1, 0)
        preview_row_count = min(data_row_total, max_rows)
        for row_idx in range(1, preview_row_count + 1):
            row_data = []
            for col_idx in range(col_total):
                row_data.append(str(ws.cell_value(row_idx, col_idx)).strip())
            preview_data.append(row_data)

        return {
            "preview_data": preview_data,
            "row_count": len(preview_data),
            "total_rows": row_total,
            "preview_rows": preview_row_count,
            "truncated": data_row_total > max_rows,
            "col_count": col_total,
            "status": "success"
        }
    except Exception as e:
        return {"status": "error", "msg": str(e)}