# -*- coding: utf-8 -*-
"""模块2：断续填充核心逻辑（独立封装）"""
import pandas as pd
import re

def allowed_file(filename):
    """验证是否为xlsx格式"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() == 'xlsx'

def code2dec(raw_code):
    """编码清洗+进制转换"""
    if pd.isna(raw_code):
        return None
    # 清洗：去除所有空白/不可见字符（含全角空格）
    code_clean = re.sub(r'\s+', '', str(raw_code))
    if not code_clean:
        return None
    
    try:
        # 16进制识别（0x/0X开头 或 包含A-F）
        if code_clean.startswith(('0x', '0X')) or re.search(r'[A-Fa-f]', code_clean):
            return int(code_clean, 16)
        # 10进制
        return int(float(code_clean))
    except (ValueError, TypeError):
        return None

def process_excel(df):
    """核心处理函数：断续填充"""
    # 校验列数
    if df.shape[1] != 3:
        return None, f"列数错误！需3列，当前{df.shape[1]}列"
    
    # 遍历解析编码
    code_name_dict = {}  # 10进制编码 → 故障名称
    dec2raw_code = {}    # 10进制编码 → 原始编码值
    valid_dec_codes = [] # 有效10进制编码列表
    
    for idx, row in df.iterrows():
        excel_row_num = idx + 1
        raw_code = row.iloc[2]
        b_name = row.iloc[1]
        dec_code = code2dec(raw_code)
        
        if dec_code is not None:
            code_name_dict[dec_code] = b_name if pd.notna(b_name) else f"未命名_{dec_code}"
            if dec_code not in dec2raw_code:
                dec2raw_code[dec_code] = raw_code
            valid_dec_codes.append(dec_code)
    
    # 无有效编码处理
    if not valid_dec_codes:
        return None, "无有效编码数据！"
    
    # 生成连续编码序列
    unique_valid_codes = list(set(valid_dec_codes))
    min_dec = min(unique_valid_codes)
    max_dec = max(unique_valid_codes)
    # 可选：强制固定范围（如1-203）
    # min_dec = 1
    # max_dec = 203
    continuous_codes = list(range(min_dec, max_dec + 1))
    
    # 填充缺失项为"预留"
    final_data = []
    reserve_count = 1
    for serial_num, dec_code in enumerate(continuous_codes, start=1):
        a_col = serial_num
        b_col = code_name_dict.get(dec_code, f"预留{reserve_count}")
        if dec_code not in code_name_dict:
            reserve_count += 1
        c_col = dec2raw_code.get(dec_code, "")
        final_data.append([a_col, b_col, c_col])
    
    # 构造最终DataFrame
    final_df = pd.DataFrame(
        final_data,
        columns=["A列_连续序号", "B列_故障名称/预留", "C列_原始编码(10/16进制)"]
    )
    
    # 统计信息
    res_info = {
        "原始有效编码数(唯一)": len(unique_valid_codes),
        "连续编码范围(10进制)": f"{min_dec} → {max_dec}",
        "处理后总行数": len(continuous_codes),
        "填充预留项数": reserve_count - 1
    }
    
    return final_df, res_info