// 子路径前缀：由模板里注入的 window.PROTOCOL_PREFIX 决定
// - 部署到 WebSSH 主壳时为 "/protocol"
// - 直连 Flask 时为空字符串
const _P = (typeof window !== 'undefined' && window.PROTOCOL_PREFIX) ? window.PROTOCOL_PREFIX : '';
const BACKEND_CONFIG = {
    module1: {
        uploadUrl:   _P + '/module1/upload',
        downloadUrl: _P + '/module1/download'
    },
    module2: {
        processUrl:  _P + '/module2/process',
        downloadUrl: _P + '/module2/download'
    },
    module3: {
        initUrl:           _P + '/module3/init',
        uploadPdfUrl:      _P + '/module3/upload_pdf',
        uploadExcelUrl:    _P + '/module3/upload_excel',
        addRowUrl:         _P + '/module3/add_row',
        deleteRowUrl:      _P + '/module3/delete_row',
        updateCellUrl:     _P + '/module3/update_cell',
        saveUrl:           _P + '/module3/save',
        getProtoItemsUrl:  _P + '/module3/get_proto_items',
        genCollectCmdUrl:  _P + '/module3/gen_collect_cmd',
        genExcelUrl:       _P + '/module3/gen_excel',
        downloadUrl:       _P + '/module3/download',
        uploadsBase:       _P + '/uploads'
    },
    module4: {
        getDynamicUrl: _P + '/module4/get-dynamic-content',
        uploadUrl:     _P + '/module4/upload',
        downloadUrl:   _P + '/module4/download'   // 末尾再拼 '/<filename>'
    },
    module5: {
        initUrl:     _P + '/module5/init',
        uploadUrl:   _P + '/module5/upload',
        processUrl:  _P + '/module5/process',
        downloadUrl: _P + '/module5/download',    // 末尾再拼 '/<filename>'
        reportUrl:   _P + '/module5/report'
    },
    indexUrl: _P + '/'   // "返回主页面" 用
};

/**
 * 显示提示信息（适配 webssh-theme：直接修改 #msgArea 自身的 class）
 * @param {string} msg 提示内容
 * @param {boolean} isError 是否为错误信息
 */
function showMsg(msg, isError = false) {
    const msgArea = document.getElementById('msgArea');
    if (!msgArea) return;
    msgArea.className = 'msg ' + (isError ? 'msg-error' : 'msg-success');
    msgArea.textContent = msg;
    // 3 秒后自动隐藏
    clearTimeout(showMsg._t);
    showMsg._t = setTimeout(() => {
        msgArea.classList.add('hidden');
    }, 3000);
}

/**
 * 渲染表格（保留兼容：写入 #tableContainer）
 * @param {array} columns 列名
 * @param {array} data 数据
 */
function renderTable(columns, data) {
    const tableContainer = document.getElementById('tableContainer');
    if (!tableContainer) return;
    let tableHtml = '<table class="table-common"><thead><tr>';
    columns.forEach(col => { tableHtml += `<th>${col}</th>`; });
    tableHtml += '</tr></thead><tbody>';
    (data || []).forEach(row => {
        tableHtml += '<tr>';
        row.forEach(cell => { tableHtml += `<td>${cell === null ? '' : cell}</td>`; });
        tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';
    tableContainer.innerHTML = tableHtml;
}

/**
 * 模块1：渲染统计信息（适配新主题 .info-area）
 * @param {object} info 统计信息
 */
function showModule1Info(info) {
    const infoArea = document.getElementById('statsArea');
    if (!infoArea) return;
    const r = info.process_result || {};
    infoArea.innerHTML = `
        <p><strong>📊 文件处理统计</strong></p>
        <p>源文件名：${info.original_filename}</p>
        <p>文件大小：${info.file_size.toFixed(2)} KB</p>
        <p>总行数：${r.row_count || 0}（含表头）</p>
        <p>总列数：${r.col_count || 0}</p>
        <p>故障标记行数：${r.fault_count || 0}</p>
    `;
    infoArea.classList.remove('hidden');
}

/**
 * 模块2：渲染统计信息
 * @param {object} info 统计信息
 */
function showModule2Info(info) {
    const infoArea = document.getElementById('infoArea');
    if (!infoArea) return;
    let html = '';
    for (const [key, value] of Object.entries(info)) {
        html += `<p><strong>${key}</strong>：${value}</p>`;
    }
    infoArea.innerHTML = html;
    infoArea.classList.remove('hidden');
}

/**
 * 模块1：渲染预览数据
 * @param {array} data 预览数据
 * @param {string} containerId 容器ID
 * @param {object|null} meta 预览元信息
 */
function renderModule1Preview(data, containerId, meta = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!data || data.length === 0) {
        container.innerHTML = '<div class="empty">无预览数据</div>';
        return;
    }

    let tableHtml = '<table class="table-common"><thead><tr>';
    const headerRow = data[0] || [];
    headerRow.forEach((header, idx) => {
        const headerText = header || `列${idx + 1}`;
        let mark = headerText;
        if (idx === 8)  mark = `${headerText}（I 列 / 单位）`;
        if (idx === 12) mark = `${headerText}（M 列 / 故障）`;
        if (idx === 17) mark = `${headerText}（R 列 / 分类）`;
        if (idx === 18) mark = `${headerText}（S 列 / 新增）`;
        if (idx === 19) mark = `${headerText}（T 列 / 新增）`;
        if (idx === 20) mark = `${headerText}（U 列 / 新增）`;
        if (idx === 21) mark = `${headerText}（V 列 / 新增）`;
        tableHtml += `<th>${mark}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';

    for (let i = 1; i < data.length; i++) {
        tableHtml += '<tr>';
        const row = data[i] || [];
        for (let j = 0; j < headerRow.length; j++) {
            const cellValue = row[j] !== undefined && row[j] !== null ? row[j] : '';
            tableHtml += `<td>${cellValue}</td>`;
        }
        tableHtml += '</tr>';
    }

    const rowCount = data.length - 1;
    const colCount = headerRow.length;
    let tip = `共 ${rowCount} 行数据 · ${colCount} 列 · 支持横向 / 纵向滚动`;
    if (meta && meta.truncated) {
        tip = `预览已截断：仅显示前 ${meta.preview_rows} 行（总 ${Math.max((meta.total_rows || 1) - 1, 0)} 行）`;
    }
    tableHtml += `</tbody></table><div style="padding:8px 10px;color:var(--muted);font-size:11px;border-top:1px dashed var(--border)">${tip}</div>`;

    container.innerHTML = tableHtml;
}