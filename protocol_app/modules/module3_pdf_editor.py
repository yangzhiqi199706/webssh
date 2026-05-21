# -*- coding: utf-8 -*-
"""模块3：PDF与Excel对照编辑器核心逻辑"""
import xlrd
import xlwt
import os
from io import BytesIO

# Excel列配置（与示例文件保持一致）
EXCEL_COLUMNS = [
    "设备类型", "指令类型", "指令名称", "采集指令", "处理类型", 
    "参数索引", "参数名称", "参数变比", "参数单位", "参数长度", 
    "处理模型", "数据顺序", "报警特征值", "上限值", "下限值", 
    "偏移量", "保留小数位", "数据类型（1=模拟量，2=枚举）"
]

# 协议项数据（基于示例Excel）
PROTOCOL_ITEMS = {
    "A1": [
        {"name": "A相电压", "ratio": 0.1, "unit": "V", "model": 9, "length": 4},
        {"name": "B相电压", "ratio": 0.1, "unit": "V", "model": 9, "length": 4},
        {"name": "C相电压", "ratio": 0.1, "unit": "V", "model": 9, "length": 4},
        {"name": "AB线电压", "ratio": 0.1, "unit": "V", "model": 9, "length": 4},
        {"name": "BC线电压", "ratio": 0.1, "unit": "V", "model": 9, "length": 4},
        {"name": "CA线电压", "ratio": 0.1, "unit": "V", "model": 9, "length": 4},
        {"name": "A相电流", "ratio": 0.015, "unit": "A", "model": 9, "length": 4},
        {"name": "B相电流", "ratio": 0.015, "unit": "A", "model": 9, "length": 4},
        {"name": "C相电流", "ratio": 0.015, "unit": "A", "model": 9, "length": 4},
        {"name": "总有功功率", "ratio": 0.1, "unit": "Kw", "model": 9, "length": 4},
        {"name": "A相有功功率", "ratio": 0.1, "unit": "Kw", "model": 9, "length": 4},
        {"name": "B相有功功率", "ratio": 0.1, "unit": "Kw", "model": 9, "length": 4},
        {"name": "C相有功功率", "ratio": 0.1, "unit": "Kw", "model": 9, "length": 4},
        {"name": "总无功功率", "ratio": 0.1, "unit": "Kvar", "model": 9, "length": 4},
        {"name": "A相无功功率", "ratio": 0.1, "unit": "Kvar", "model": 9, "length": 4},
        {"name": "B相无功功率", "ratio": 0.1, "unit": "Kvar", "model": 9, "length": 4},
        {"name": "C相无功功率", "ratio": 0.1, "unit": "Kvar", "model": 9, "length": 4},
        {"name": "总视在功率", "ratio": 0.1, "unit": "Kva", "model": 9, "length": 4},
        {"name": "A相视在功率", "ratio": 0.1, "unit": "Kva", "model": 9, "length": 4},
        {"name": "B相视在功率", "ratio": 0.1, "unit": "Kva", "model": 9, "length": 4},
        {"name": "C相视在功率", "ratio": 0.1, "unit": "Kva", "model": 9, "length": 4},
        {"name": "总功率因数", "ratio": 0.001, "unit": "", "model": 9, "length": 4},
        {"name": "A相功率因数", "ratio": 0.001, "unit": "", "model": 9, "length": 4},
        {"name": "B相功率因数", "ratio": 0.001, "unit": "", "model": 9, "length": 4},
        {"name": "C相功率因数", "ratio": 0.001, "unit": "", "model": 9, "length": 4},
        {"name": "频率", "ratio": 0.01, "unit": "Hz", "model": 9, "length": 4}
    ],
    "A2": [
        {"name": "总有功电能", "ratio": 0.01, "unit": "Kwh", "model": 9, "length": 4},
        {"name": "A相有功电能", "ratio": 0.01, "unit": "Kwh", "model": 9, "length": 4},
        {"name": "B相有功电能", "ratio": 0.01, "unit": "Kwh", "model": 9, "length": 4},
        {"name": "C相有功电能", "ratio": 0.01, "unit": "Kwh", "model": 9, "length": 4},
        {"name": "总无功电能", "ratio": 0.01, "unit": "Kvarh", "model": 9, "length": 4}
    ]
}

def get_proto_items(cmd_type):
    """获取协议项列表"""
    return PROTOCOL_ITEMS.get(cmd_type, [])

def gen_collect_cmd(func_code, start_addr, reg_num):
    """生成采集指令"""
    func_code_hex = func_code.replace('0x', '').zfill(2)
    start_addr_hex = hex(int(start_addr))[2:].zfill(4)
    reg_num_hex = hex(int(reg_num))[2:].zfill(4)
    return f"{func_code_hex}{start_addr_hex}{reg_num_hex}"

def allowed_file(filename, file_type):
    """验证文件格式"""
    if '.' not in filename:
        return False
    ext = filename.rsplit('.', 1)[1].lower()
    if file_type == 'pdf':
        return ext == 'pdf'
    elif file_type == 'xls':
        return ext == 'xls'
    return False

def load_excel_template(file_path=None):
    """加载Excel模板文件或创建新模板"""
    if file_path and os.path.exists(file_path):
        try:
            wb = xlrd.open_workbook(file_path, formatting_info=False)
            ws = wb.sheet_by_index(0)
            data = []
            for row_idx in range(ws.nrows):
                row_data = []
                for col_idx in range(ws.ncols):
                    cell_val = ws.cell_value(row_idx, col_idx)
                    row_data.append(str(cell_val) if cell_val != "" else "")
                data.append(row_data)
            return {
                "status": "success",
                "data": data,
                "columns": EXCEL_COLUMNS
            }
        except Exception as e:
            return {
                "status": "error",
                "msg": f"加载Excel文件失败：{str(e)}"
            }
    else:
        default_data = [EXCEL_COLUMNS]
        return {
            "status": "success",
            "data": default_data,
            "columns": EXCEL_COLUMNS
        }

def save_excel_file(data, output_path):
    """保存Excel文件"""
    try:
        wb = xlwt.Workbook(encoding="utf-8")
        ws = wb.add_sheet("点码表", cell_overwrite_ok=True)
        
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
        
        for row_idx, row_data in enumerate(data):
            for col_idx, cell_val in enumerate(row_data):
                if row_idx == 0:
                    ws.write(row_idx, col_idx, cell_val, header_style)
                else:
                    ws.write(row_idx, col_idx, cell_val, data_style)
        
        wb.save(output_path)
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "msg": f"保存Excel文件失败：{str(e)}"}

def save_excel_to_memory(data):
    """保存Excel到内存（用于下载）"""
    try:
        output = BytesIO()
        wb = xlwt.Workbook(encoding="utf-8")
        ws = wb.add_sheet("点码表", cell_overwrite_ok=True)
        
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
        
        for row_idx, row_data in enumerate(data):
            for col_idx, cell_val in enumerate(row_data):
                if row_idx == 0:
                    ws.write(row_idx, col_idx, cell_val, header_style)
                else:
                    ws.write(row_idx, col_idx, cell_val, data_style)
        
        wb.save(output)
        output.seek(0)
        return {"status": "success", "data": output}
    except Exception as e:
        return {"status": "error", "msg": f"生成Excel文件失败：{str(e)}"}

def gen_excel_from_data_list(data_list):
    """从数据列表生成Excel"""
    data = [EXCEL_COLUMNS]
    for item in data_list:
        row = [
            str(item.get("device_type", "")),
            str(item.get("cmd_type", "")),
            str(item.get("cmd_name", "")),
            str(item.get("collect_cmd", "")),
            str(item.get("process_type", "")),
            str(item.get("param_index", "")),
            str(item.get("param_name", "")),
            str(item.get("param_ratio", "")),
            str(item.get("param_unit", "")),
            str(item.get("param_length", "")),
            str(item.get("process_model", "")),
            str(item.get("data_order", "")),
            str(item.get("alarm_value", "")),
            str(item.get("upper_limit", "")),
            str(item.get("lower_limit", "")),
            str(item.get("offset", "")),
            str(item.get("decimal_places", "")),
            str(item.get("data_type", ""))
        ]
        data.append(row)
    return save_excel_to_memory(data)

def add_row(data, row_data=None):
    """添加新行"""
    if row_data is None:
        row_data = [""] * len(EXCEL_COLUMNS)
        if len(data) > 1:
            last_row = data[-1]
            row_data[0] = last_row[0]
            row_data[1] = last_row[1]
            row_data[2] = last_row[2]
            row_data[3] = last_row[3]
            row_data[4] = last_row[4]
            if last_row[5]:
                try:
                    row_data[5] = str(float(last_row[5]) + 1)
                except:
                    row_data[5] = ""
            row_data[7] = last_row[7]
            row_data[9] = last_row[9]
            row_data[10] = last_row[10]
            row_data[16] = last_row[16]
            row_data[17] = last_row[17]
    data.append(row_data)
    return data

def delete_row(data, row_idx):
    """删除行"""
    if 0 < row_idx < len(data):
        data.pop(row_idx)
    return data

def update_cell(data, row_idx, col_idx, value):
    """更新单元格"""
    if row_idx < len(data) and col_idx < len(EXCEL_COLUMNS):
        while len(data) <= row_idx:
            data.append([""] * len(EXCEL_COLUMNS))
        while len(data[row_idx]) <= col_idx:
            data[row_idx].append("")
        data[row_idx][col_idx] = value
    return data
