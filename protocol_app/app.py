# -*- coding: utf-8 -*-
"""
主程序：整合模块1（XLS处理）、模块2（断续填充）、模块3（PDF编辑器）和模块4（MBP生成器）
统一路由入口，共享全局配置，模块逻辑独立封装

环境变量（部署时由 systemd 注入）：
  PROTOCOL_HOST    监听地址，默认 127.0.0.1（独立部署时只对本机的 Node 反代开放）
  PROTOCOL_PORT    监听端口，默认 5000
  PROTOCOL_PREFIX  应用挂载前缀，默认 /protocol；本地直连可设为空字符串走根路径
  PROTOCOL_DEBUG   1=开 debug，默认关
"""
import os
import io
import uuid
import pandas as pd
from flask import Flask, render_template, request, jsonify, send_file
from modules import module1_xls, module2_fill, module3_pdf_editor, module4_mbp_generator, module5_protocol_processor
from urllib.parse import unquote

# 子路径前缀。部署到 WebSSH 主壳时是 "/protocol"，独立运行时是 ""
PROTOCOL_PREFIX = os.environ.get('PROTOCOL_PREFIX', '/protocol').rstrip('/')

# 全局配置
app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app.config['UPLOAD_FOLDER'] = os.path.join(BASE_DIR, 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024  # 10MB限制
app.config['SECRET_KEY'] = 'your-secret-key-here'
# 把前缀注入 Flask 配置，模板里通过 config.PROTOCOL_PREFIX 拼绝对 URL 用
app.config['PROTOCOL_PREFIX'] = PROTOCOL_PREFIX

# 配置uploads目录为静态文件目录
from flask import send_from_directory

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# 创建上传目录（不存在则创建）
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# 全局变量（区分模块存储处理后数据）
module1_processed_data = None  # 模块1处理后数据
module1_task_files = {}        # 模块1任务ID -> 下载信息
module2_processed_df = None    # 模块2处理后DataFrame
module3_excel_data = None      # 模块3 Excel数据
module3_pdf_path = None        # 模块3 PDF文件路径
module5_processor = None        # 模块5 协议处理器实例

# -------------------------- 主路由（模块选择） --------------------------
@app.route('/')
def index():
    """主页面：模块选择入口"""
    return render_template('index.html')

# -------------------------- 模块1：XLS处理路由 --------------------------
@app.route('/module1')
def module1():
    """模块1页面"""
    return render_template('module1.html')

@app.route('/module1/upload', methods=['POST'])
def module1_upload():
    """模块1：上传并处理XLS文件"""
    global module1_processed_data, module1_task_files
    try:
        if 'file' not in request.files:
            return jsonify({"status": "error", "msg": "未选择文件"})
        file = request.files['file']
        if file.filename == '' or not module1_xls.allowed_file(file.filename):
            return jsonify({"status": "error", "msg": "仅支持.xls格式文件"})

        original_filename = file.filename
        task_id = uuid.uuid4().hex

        # 固定使用task_id命名，避免secure_filename导致中文名被压缩成异常短名
        input_name = f"{task_id}_input.xls"
        output_name_fs = f"{task_id}_output.xls"
        download_name = f"处理后_{original_filename}"

        file_path = os.path.join(app.config['UPLOAD_FOLDER'], input_name)
        file.save(file_path)

        output_path = os.path.join(app.config['UPLOAD_FOLDER'], output_name_fs)
        process_result = module1_xls.process_xls(file_path, output_path)

        if not os.path.exists(output_path):
            return jsonify({"status": "error", "msg": "处理后文件未生成，请重试"})

        preview_original = module1_xls.parse_xls_for_preview(file_path, max_rows=200)
        preview_processed = module1_xls.parse_xls_for_preview(output_path, max_rows=200)

        module1_processed_data = output_path
        module1_task_files[task_id] = {
            "path": output_path,
            "download_name": download_name
        }

        return jsonify({
            "status": "success",
            "task_id": task_id,
            "original_filename": original_filename,
            "file_size": os.path.getsize(file_path) / 1024,
            "process_result": process_result,
            "preview_original": preview_original,
            "preview_processed": preview_processed
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"处理失败：{str(e)}"})

@app.route('/module1/download/<task_id>')
def module1_download(task_id):
    """模块1：按任务ID下载处理后文件"""
    task_info = module1_task_files.get(task_id)
    if not task_info:
        return jsonify({"status": "error", "msg": "任务不存在或已过期"}), 404

    file_path = task_info.get("path")
    if not file_path:
        return jsonify({"status": "error", "msg": "无处理后文件"}), 404

    file_path = os.path.abspath(file_path)
    if not os.path.isfile(file_path):
        return jsonify({"status": "error", "msg": "处理后文件不存在，请重新上传处理"}), 404

    return send_file(
        file_path,
        as_attachment=True,
        download_name=task_info.get("download_name", os.path.basename(file_path)),
        mimetype='application/vnd.ms-excel'
    )

# -------------------------- 模块2：断续填充路由 --------------------------
@app.route('/module2')
def module2():
    """模块2页面"""
    return render_template('module2.html')

@app.route('/module2/process', methods=['POST'])
def module2_process():
    """模块2：上传并处理Excel文件"""
    global module2_processed_df
    try:
        if 'file' not in request.files:
            return jsonify({"status": "error", "msg": "未选择文件"})
        file = request.files['file']
        if file.filename == '' or not module2_fill.allowed_file(file.filename):
            return jsonify({"status": "error", "msg": "仅支持.xlsx格式文件"})
        
        df = pd.read_excel(file, header=None)
        
        final_df, res_info = module2_fill.process_excel(df)
        if final_df is None:
            return jsonify({"status": "error", "msg": res_info})
        
        module2_processed_df = final_df
        
        preview_data = final_df.values.tolist()
        columns = final_df.columns.tolist()
        
        return jsonify({
            "status": "success",
            "info": res_info,
            "columns": columns,
            "preview": preview_data
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"处理失败：{str(e)}"})

@app.route('/module2/download', methods=['POST'])
def module2_download():
    """模块2：下载处理后Excel"""
    global module2_processed_df
    if module2_processed_df is None:
        return jsonify({"status": "error", "msg": "无处理后数据"})
    
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        module2_processed_df.to_excel(writer, index=False, sheet_name='断续填充结果')
    output.seek(0)
    
    return send_file(
        output,
        as_attachment=True,
        download_name='处理后_故障编码表.xlsx',
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )

# -------------------------- 模块3：PDF与Excel对照编辑器 --------------------------
@app.route('/module3')
def module3():
    """模块3页面"""
    return render_template('module3.html')

@app.route('/module3/init', methods=['POST'])
def module3_init():
    """模块3：初始化编辑器（加载模板或Excel文件）"""
    global module3_excel_data
    try:
        data = request.get_json()
        excel_file_path = data.get('excel_file_path', None)
        
        result = module3_pdf_editor.load_excel_template(excel_file_path)
        if result['status'] == 'success':
            module3_excel_data = result['data']
            return jsonify({
                "status": "success",
                "data": module3_excel_data,
                "columns": result['columns']
            })
        else:
            return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "msg": f"初始化失败：{str(e)}"})

@app.route('/module3/upload_pdf', methods=['POST'])
def module3_upload_pdf():
    """模块3：上传PDF文件"""
    global module3_pdf_path
    try:
        if 'file' not in request.files:
            return jsonify({"status": "error", "msg": "未选择文件"})
        file = request.files['file']
        if file.filename == '' or not module3_pdf_editor.allowed_file(file.filename, 'pdf'):
            return jsonify({"status": "error", "msg": "仅支持.pdf格式文件"})
        
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(file_path)
        module3_pdf_path = file_path
        
        return jsonify({
            "status": "success",
            "filename": file.filename,
            "file_path": file_path
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"上传PDF失败：{str(e)}"})

@app.route('/module3/upload_excel', methods=['POST'])
def module3_upload_excel():
    """模块3：上传Excel文件作为模板"""
    global module3_excel_data
    try:
        if 'file' not in request.files:
            return jsonify({"status": "error", "msg": "未选择文件"})
        file = request.files['file']
        if file.filename == '' or not module3_pdf_editor.allowed_file(file.filename, 'xls'):
            return jsonify({"status": "error", "msg": "仅支持.xls格式文件"})
        
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(file_path)
        
        result = module3_pdf_editor.load_excel_template(file_path)
        if result['status'] == 'success':
            module3_excel_data = result['data']
            return jsonify({
                "status": "success",
                "data": module3_excel_data,
                "columns": result['columns'],
                "filename": file.filename
            })
        else:
            return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "msg": f"上传Excel失败：{str(e)}"})

@app.route('/module3/add_row', methods=['POST'])
def module3_add_row():
    """模块3：添加新行"""
    global module3_excel_data
    try:
        if module3_excel_data is None:
            return jsonify({"status": "error", "msg": "请先初始化Excel数据"})
        
        data = request.get_json()
        row_data = data.get('row_data', None)
        module3_excel_data = module3_pdf_editor.add_row(module3_excel_data, row_data)
        
        return jsonify({
            "status": "success",
            "data": module3_excel_data
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"添加行失败：{str(e)}"})

@app.route('/module3/delete_row', methods=['POST'])
def module3_delete_row():
    """模块3：删除行"""
    global module3_excel_data
    try:
        if module3_excel_data is None:
            return jsonify({"status": "error", "msg": "请先初始化Excel数据"})
        
        data = request.get_json()
        row_idx = data.get('row_idx', -1)
        module3_excel_data = module3_pdf_editor.delete_row(module3_excel_data, row_idx)
        
        return jsonify({
            "status": "success",
            "data": module3_excel_data
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"删除行失败：{str(e)}"})

@app.route('/module3/update_cell', methods=['POST'])
def module3_update_cell():
    """模块3：更新单元格"""
    global module3_excel_data
    try:
        if module3_excel_data is None:
            return jsonify({"status": "error", "msg": "请先初始化Excel数据"})
        
        data = request.get_json()
        row_idx = data.get('row_idx', -1)
        col_idx = data.get('col_idx', -1)
        value = data.get('value', '')
        
        module3_excel_data = module3_pdf_editor.update_cell(module3_excel_data, row_idx, col_idx, value)
        
        return jsonify({
            "status": "success",
            "data": module3_excel_data
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"更新单元格失败：{str(e)}"})

@app.route('/module3/save', methods=['POST'])
def module3_save():
    """模块3：保存Excel文件"""
    global module3_excel_data
    try:
        if module3_excel_data is None:
            return jsonify({"status": "error", "msg": "无数据可保存"})
        
        data = request.get_json()
        filename = data.get('filename', '处理后_点码表.xls')
        output_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        
        result = module3_pdf_editor.save_excel_file(module3_excel_data, output_path)
        if result['status'] == 'success':
            return jsonify({
                "status": "success",
                "file_path": output_path,
                "filename": filename
            })
        else:
            return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "msg": f"保存失败：{str(e)}"})

@app.route('/module3/get_proto_items', methods=['POST'])
def module3_get_proto_items():
    """模块3：获取协议项列表"""
    try:
        data = request.get_json()
        cmd_type = data.get('cmd_type', 'A1')
        proto_items = module3_pdf_editor.get_proto_items(cmd_type)
        return jsonify({
            "status": "success",
            "data": proto_items
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"获取协议项失败：{str(e)}"})

@app.route('/module3/gen_collect_cmd', methods=['POST'])
def module3_gen_collect_cmd():
    """模块3：生成采集指令"""
    try:
        data = request.get_json()
        func_code = data.get('func_code', '0x03')
        start_addr = data.get('start_addr', 0)
        reg_num = data.get('reg_num', 26)
        collect_cmd = module3_pdf_editor.gen_collect_cmd(func_code, start_addr, reg_num)
        return jsonify({
            "status": "success",
            "collect_cmd": collect_cmd
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"生成采集指令失败：{str(e)}"})

@app.route('/module3/gen_excel', methods=['POST'])
def module3_gen_excel():
    """模块3：一键生成并下载Excel"""
    try:
        data = request.get_json()
        data_list = data.get('data_list', [])
        result = module3_pdf_editor.gen_excel_from_data_list(data_list)
        if result['status'] == 'success':
            return send_file(
                result['data'],
                as_attachment=True,
                download_name='三相多功能表协议点码表.xls',
                mimetype='application/vnd.ms-excel'
            )
        else:
            return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "msg": f"生成Excel失败：{str(e)}"})

@app.route('/module3/download')
def module3_download():
    """模块3：下载Excel文件"""
    global module3_excel_data
    try:
        if module3_excel_data is None:
            return jsonify({"status": "error", "msg": "无数据可下载"})
        
        result = module3_pdf_editor.save_excel_to_memory(module3_excel_data)
        if result['status'] == 'success':
            return send_file(
                result['data'],
                as_attachment=True,
                download_name='处理后_点码表.xls',
                mimetype='application/vnd.ms-excel'
            )
        else:
            return jsonify(result)
    except Exception as e:
        return jsonify({"status": "error", "msg": f"下载失败：{str(e)}"})

# -------------------------- 模块4：MBP文件生成器 --------------------------
@app.route('/module4')
def module4():
    """模块4页面"""
    return render_template('module4.html')

@app.route('/module4/get-dynamic-content', methods=['GET'])
def module4_get_dynamic_content():
    """模块4：获取动态内容"""
    try:
        j2k2_config = module4_mbp_generator.load_j2k2_config()
        match_rules = j2k2_config.get('match_rules', [])
        j2k2_table = []
        
        for rule in match_rules:
            if rule.get('trigger_type') == 'j2_k2':
                trigger = f"J2={rule.get('trigger_j2')} 且 K2={rule.get('trigger_k2')}"
                if rule.get('trigger_j2') == 8 and rule.get('trigger_k2') == 15:
                    trigger_tag = "✅ 新增规则（D59行适用）"
                elif rule.get('trigger_j2') == 8 and rule.get('trigger_k2') in [5, 3]:
                    trigger_tag = "✅ 新增规则"
                else:
                    trigger_tag = ""
            elif rule.get('trigger_type') == 'k2_only':
                trigger = f"仅 K2={rule.get('trigger_k2')}（J2无效）"
                trigger_tag = "⚠️ k2_only规则" if rule.get('trigger_k2') == 15 else ""
            elif rule.get('trigger_type') == 'j2_only':
                trigger = f"仅 J2={rule.get('trigger_j2')}（K2无效）"
                trigger_tag = "⚠️ j2_only规则"
            else:
                trigger = "未知规则类型"
                trigger_tag = ""
            
            j2k2_table.append({
                "trigger": trigger,
                "trigger_tag": trigger_tag,
                "format": f"F={rule.get('f_value', 14)}",
                "mode": rule.get('mode', "INT32 小端模式（默认）"),
                "scene": rule.get('description', "无描述")
            })
        
        response_data = {
            "code": 200,
            "data": {
                "j2k2_table": j2k2_table
            },
            "msg": "动态内容获取成功"
        }
        return jsonify(response_data)
    except Exception as e:
        error_msg = f"获取动态内容失败：{str(e)}"
        return jsonify({"code": 500, "msg": error_msg}), 500

@app.route('/module4/upload', methods=['POST'])
def module4_upload():
    """模块4：上传Excel并生成MBP文件"""
    try:
        if 'file' not in request.files:
            return jsonify({"code": 400, "msg": "请求中无文件字段"}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({"code": 400, "msg": "未选择Excel文件"}), 400
        
        if not module4_mbp_generator.allowed_file(file.filename):
            file_ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else "无后缀"
            return jsonify({"code": 400, "msg": f"仅支持.xls格式文件，当前文件格式：{file_ext}"}), 400
        
        xls_filename = module4_mbp_generator.secure_filename(file.filename)
        xls_save_path = os.path.join(module4_mbp_generator.MODULE4_UPLOAD_FOLDER, xls_filename)
        file.save(xls_save_path)
        
        multi_data_list, parse_msg = module4_mbp_generator.extract_multi_lnf_data(xls_save_path)
        if not multi_data_list:
            return jsonify({"code": 400, "msg": f"Excel解析完成：{parse_msg}"}), 400
        
        mbp_list = []
        success_count = 0
        stats = {
            "j28_k5_count": 0,
            "j28_k15_count": 0,
            "k2_15_count": 0,
            "default_count": 0,
            "d59_matched": False,
            "format_aligned": True
        }
        
        for mbp_data in multi_data_list:
            d_row_num = mbp_data["d_row_num"]
            matched_mode = mbp_data["matched_mode"]
            rule_status = mbp_data["rule_status"]
            j_val = mbp_data["debug_info"]["j_val"]
            k_val = mbp_data["debug_info"]["k_val"]
            
            if rule_status == "matched":
                if j_val == 8 and k_val == 5:
                    stats["j28_k5_count"] += 1
                elif j_val == 8 and k_val == 15:
                    stats["j28_k15_count"] += 1
                    if d_row_num == 59:
                        stats["d59_matched"] = True
                elif k_val == 15 and j_val is None:
                    stats["k2_15_count"] += 1
            else:
                stats["default_count"] += 1
            
            success, mbp_filename, mbp_msg = module4_mbp_generator.generate_single_mbp(mbp_data, xls_filename)
            if success:
                success_count += 1
                mbp_list.append({
                    "button_name": f"{mbp_data['c2_text']}（D{d_row_num}）",
                    "mbp_filename": mbp_filename,
                    "func_code": mbp_data["func_code"],
                    "start_addr": mbp_data["start_addr"],
                    "register_count": mbp_data["register_count"],
                    "param_count": len(mbp_data["params"]),
                    "data_mode": "16位" if mbp_data["is_16bit_mode"] else "32位",
                    "matched_mode": matched_mode,
                    "is_float_mode": "浮点数" in matched_mode,
                    "float_endian": "大端" if "大端" in matched_mode else "小端" if "小端" in matched_mode else "",
                    "params": mbp_data["params"],
                    "params_preview": mbp_data["params_preview"],
                    "msg": mbp_msg,
                    "rule_status": rule_status,
                    "format_aligned": True
                })
            else:
                stats["format_aligned"] = False
        
        response_data = {
            "code": 200,
            "msg": f"共{len(multi_data_list)}个有效发送串，成功生成{success_count}个MBP文件",
            "total_count": len(multi_data_list),
            "success_count": success_count,
            "rule_stats": stats,
            "mbp_list": mbp_list,
            "used_sheet": multi_data_list[0]["used_sheet"]
        }
        return jsonify(response_data)
    except Exception as e:
        error_msg = f"上传处理异常：{str(e)}"
        return jsonify({"code": 500, "msg": error_msg}), 500

@app.route('/module4/download/<mbp_filename>', methods=['GET'])
def module4_download(mbp_filename):
    """模块4：下载MBP文件"""
    try:
        decoded_filename = unquote(mbp_filename)
        mbp_save_path = os.path.join(module4_mbp_generator.MODULE4_DOWNLOAD_FOLDER, decoded_filename)
        
        if not os.path.exists(mbp_save_path):
            return jsonify({"code": 404, "msg": f"MBP文件不存在"}), 404
        
        if not os.access(mbp_save_path, os.R_OK):
            return jsonify({"code": 403, "msg": "无MBP文件读取权限"}), 403
        
        file_size = os.path.getsize(mbp_save_path)
        if file_size < 100:
            return jsonify({"code": 500, "msg": "MBP文件损坏"}), 500
        
        return send_file(
            mbp_save_path,
            as_attachment=True,
            download_name=decoded_filename,
            mimetype='application/xml',
            conditional=False
        )
    except Exception as e:
        error_msg = f"MBP下载异常：{str(e)}"
        return jsonify({"code": 500, "msg": error_msg}), 500

# -------------------------- 模块5：协议文件批量处理器 --------------------------
@app.route('/module5')
def module5():
    """模块5页面"""
    return render_template('module5.html')

@app.route('/module5/init', methods=['POST'])
def module5_init():
    """模块5：初始化处理器"""
    global module5_processor
    try:
        data = request.get_json()
        source_folder = data.get('source_folder', '')
        
        if not source_folder:
            return jsonify({"status": "error", "msg": "请指定源文件夹路径"})
        
        if not os.path.exists(source_folder):
            return jsonify({"status": "error", "msg": "源文件夹不存在"})
        
        output_folder = os.path.join('uploads', 'module5_output')
        module5_processor = module5_protocol_processor.ProtocolProcessor(
            upload_folder=source_folder,
            output_folder=output_folder
        )
        
        available_files = module5_processor.get_available_files(source_folder)
        
        return jsonify({
            "status": "success",
            "source_folder": source_folder,
            "output_folder": output_folder,
            "file_count": int(len(available_files)),
            "files": available_files
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"初始化失败：{str(e)}"})

@app.route('/module5/process', methods=['POST'])
def module5_process():
    """模块5：批量处理文件"""
    global module5_processor
    try:
        if module5_processor is None:
            return jsonify({"status": "error", "msg": "请先初始化处理器"})
        
        data = request.get_json()
        file_list = data.get('file_list', [])
        
        if not file_list:
            return jsonify({"status": "error", "msg": "请选择要处理的文件"})
        
        summary = module5_processor.batch_process(file_list)
        
        return jsonify({
            "status": "success",
            "summary": summary,
            "log": module5_processor.get_processing_log()
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"处理失败：{str(e)}"})

@app.route('/module5/upload', methods=['POST'])
def module5_upload():
    """模块5：上传并处理文件"""
    global module5_processor
    try:
        if 'files' not in request.files:
            return jsonify({"status": "error", "msg": "未选择文件"})
        
        files = request.files.getlist('files')
        if not files or files[0].filename == '':
            return jsonify({"status": "error", "msg": "未选择文件"})
        
        # 初始化处理器
        output_folder = os.path.join('uploads', 'module5_output')
        module5_processor = module5_protocol_processor.ProtocolProcessor(
            upload_folder='uploads',
            output_folder=output_folder
        )
        
        # 处理上传的文件
        file_list = []
        for file in files:
            if file and module5_processor.allowed_file(file.filename):
                # 保存上传的文件
                upload_path = os.path.join('uploads', file.filename)
                file.save(upload_path)
                
                file_list.append({
                    "name": file.filename,
                    "path": upload_path,
                    "size": os.path.getsize(upload_path)
                })
        
        # 批量处理文件
        summary = module5_processor.batch_process(file_list)
        
        return jsonify({
            "status": "success",
            "uploaded_count": len(file_list),
            "summary": summary,
            "log": module5_processor.get_processing_log()
        })
    except Exception as e:
        return jsonify({"status": "error", "msg": f"上传处理失败：{str(e)}"})

@app.route('/module5/download/<filename>', methods=['GET'])
def module5_download(filename):
    """模块5：下载处理后的文件"""
    try:
        decoded_filename = unquote(filename)
        file_path = os.path.join('uploads', 'module5_output', decoded_filename)
        
        if not os.path.exists(file_path):
            return jsonify({"status": "error", "msg": "文件不存在"})
        
        return send_file(
            file_path,
            as_attachment=True,
            download_name=decoded_filename,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
    except Exception as e:
        return jsonify({"status": "error", "msg": f"下载失败：{str(e)}"})

@app.route('/module5/report', methods=['POST'])
def module5_report():
    """模块5：生成处理报告"""
    global module5_processor
    try:
        if module5_processor is None:
            return jsonify({"status": "error", "msg": "请先初始化处理器"})
        
        data = request.get_json()
        summary = data.get('summary')
        
        if not summary:
            return jsonify({"status": "error", "msg": "无处理数据"})
        
        report_content = module5_processor.generate_report(summary)
        
        report_path = os.path.join('uploads', 'module5_output', '处理报告.txt')
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(report_content)
        
        return send_file(
            report_path,
            as_attachment=True,
            download_name='协议文件处理报告.txt',
            mimetype='text/plain'
        )
    except Exception as e:
        return jsonify({"status": "error", "msg": f"生成报告失败：{str(e)}"})

# -------------------------- 启动入口 --------------------------
def _build_dispatcher_app(flask_app, prefix):
    """把 flask_app 挂到 prefix 子路径下，根路径返回 404，方便给 Node 反代直挂使用。
    prefix 为空字符串时退回原 app（直连模式）。"""
    if not prefix:
        return flask_app
    from werkzeug.middleware.dispatcher import DispatcherMiddleware
    from werkzeug.wrappers import Response as WResp

    def _root_404(environ, start_response):
        resp = WResp('协议助手运行中，请访问 ' + prefix + '/', status=404, mimetype='text/plain; charset=utf-8')
        return resp(environ, start_response)

    return DispatcherMiddleware(_root_404, {prefix: flask_app})


# WSGI 入口（gunicorn / uWSGI 时使用）
application = _build_dispatcher_app(app, PROTOCOL_PREFIX)


if __name__ == '__main__':
    host = os.environ.get('PROTOCOL_HOST', '127.0.0.1')
    port = int(os.environ.get('PROTOCOL_PORT', '5000'))
    debug = os.environ.get('PROTOCOL_DEBUG', '0') == '1'
    print(f'[protocol] listening on http://{host}:{port}{PROTOCOL_PREFIX or "/"}  debug={debug}')
    if PROTOCOL_PREFIX:
        # 走 DispatcherMiddleware：自己起 werkzeug 服务器
        from werkzeug.serving import run_simple
        run_simple(host, port, application, use_reloader=debug, use_debugger=debug, threaded=True)
    else:
        app.run(debug=debug, host=host, port=port)
