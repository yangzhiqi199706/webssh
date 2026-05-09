// 远程串口客户端：通过 /ws/serial 连接服务端，控制 /dev/ttyS* 设备
(function () {
    'use strict';

    // ======== 状态 ========
    const state = {
        ws: null,
        connected: false,
        currentPort: '',
        portsLoaded: false,
        readBytes: 0,
        writeBytes: 0,
        fontSize: 15,
        rxLines: [],             // 接收面板行缓存
        rxMaxLines: 2000,
        rxTimer: null,           // 重绘节流
        txRepeatTimer: null,     // 定时发送
        rxHexBeforeModbus: null, // 勾 Modbus CRC 之前用户的 RX 模式（用于取消时恢复）
        rxFrameBuf: [],          // 帧聚合缓冲（Uint8Array 数组）
        rxFrameBytes: 0,
        rxFrameTimer: null,      // 聚合 flush 定时器
        lastFrameForParse: null, // 最近一帧 Modbus 响应（用于切换类型/字节序时重解析）
    };

    const LS_FONT = 'serial.fontSize';
    const LS_BAUD = 'serial.baudRate';
    const LS_PORT = 'serial.lastPort';
    const LS_DATABITS = 'serial.dataBits';
    const LS_PARITY = 'serial.parity';
    const LS_STOPBITS = 'serial.stopBits';
    const LS_RX_HEX = 'serial.rxHex';
    const LS_RX_TS = 'serial.rxTs';
    const LS_RX_MERGE = 'serial.rxMerge';
    const LS_TX_HEX = 'serial.txHex';
    const LS_TX_MODBUS = 'serial.txModbusCrc';
    const LS_TX_EOL = 'serial.txEol';
    const LS_TX_INTERVAL = 'serial.txInterval';
    const LS_TX_LAST = 'serial.txLast';
    const LS_MB_TYPE = 'serial.mbType';
    const LS_MB_E32 = 'serial.mbEndian32';
    const LS_MB_E16 = 'serial.mbEndian16';
    const LS_MB_START = 'serial.mbStart';

    // ======== DOM ========
    const $ = function (id) { return document.getElementById(id); };
    const el = {
        app: $('app'),
        terminalContainer: $('terminal-container'),
        selectPort: $('select-port'),
        selectBaud: $('select-baud'),
        selectDataBits: $('select-databits'),
        selectParity: $('select-parity'),
        selectStopBits: $('select-stopbits'),
        buttonRefreshPorts: $('button-refresh-ports'),
        buttonScanPorts: $('button-scan-ports'),
        buttonConnect: $('button-connect'),
        buttonCtrlC: $('button-ctrl-c'),
        buttonCtrlD: $('button-ctrl-d'),
        buttonScrollToBottom: $('button-scroll-to-bottom'),
        buttonResetStats: $('button-reset-stats'),
        inputFontSize: $('input-font-size'),
        buttonFontSizeMinus: $('button-font-size-minus'),
        buttonFontSizePlus: $('button-font-size-plus'),
        transferStats: $('transfer-stats'),
        // RX
        rxView: $('rx-view'),
        rxModeHex: $('rx-mode-hex'),
        rxShowTs: $('rx-show-ts'),
        rxAutoScroll: $('rx-auto-scroll'),
        rxPaused: $('rx-paused'),
        rxMerge: $('rx-merge'),
        rxClear: $('rx-clear'),
        rxSave: $('rx-save'),
        // TX
        txInput: $('tx-input'),
        txModeHex: $('tx-mode-hex'),
        txModbusCrc: $('tx-modbus-crc'),
        txEol: $('tx-eol'),
        txInterval: $('tx-interval'),
        txRepeat: $('tx-repeat'),
        txClear: $('tx-clear'),
        txSend: $('tx-send'),
        // Modbus
        mbPanel: $('mb-panel'),
        mbType: $('mb-type'),
        mbEndian32: $('mb-endian32'),
        mbEndian16: $('mb-endian16'),
        mbStart: $('mb-start'),
        mbFrameInfo: $('mb-frame-info'),
        mbResult: $('mb-result'),
        mbClear: $('mb-clear'),
    };

    // ======== xterm.js ========
    const { Terminal } = window;
    const { FitAddon } = window.FitAddon;
    const terminal = new Terminal({
        scrollback: 5000,
        cursorBlink: true,
        fontFamily: '"Ubuntu Mono", Menlo, Consolas, monospace',
        theme: { background: '#000000' },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(el.terminalContainer);
    fitAddon.fit();

    terminal.writeln('\x1b[36m[Remote Serial]\x1b[0m 通过 WebSocket 桥接服务器串口 /dev/ttyS*');
    terminal.writeln('选择设备和波特率，点击「打开串口」即可开始交互');

    terminal.onData(function (data) {
        if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        const chars = new TextEncoder().encode(data);
        state.writeBytes += chars.length;
        sendBytes(chars);
        updateStats();
    });

    window.addEventListener('resize', function () {
        try { fitAddon.fit(); } catch (_err) {}
    });

    // ======== 配置持久化 ========
    function loadConfig() {
        const savedFont = parseInt(localStorage.getItem(LS_FONT) || '15', 10);
        state.fontSize = isNaN(savedFont) ? 15 : Math.max(10, Math.min(40, savedFont));
        el.inputFontSize.value = state.fontSize;
        terminal.options.fontSize = state.fontSize;
        try { fitAddon.fit(); } catch (_err) {}

        const savedBaud = localStorage.getItem(LS_BAUD);
        if (savedBaud) el.selectBaud.value = savedBaud;
        const savedDataBits = localStorage.getItem(LS_DATABITS);
        if (savedDataBits) el.selectDataBits.value = savedDataBits;
        const savedParity = localStorage.getItem(LS_PARITY);
        if (savedParity) el.selectParity.value = savedParity;
        const savedStopBits = localStorage.getItem(LS_STOPBITS);
        if (savedStopBits) el.selectStopBits.value = savedStopBits;

        el.rxModeHex.checked = localStorage.getItem(LS_RX_HEX) === '1';
        el.rxShowTs.checked = localStorage.getItem(LS_RX_TS) === '1';
        const savedMerge = parseInt(localStorage.getItem(LS_RX_MERGE) || '50', 10);
        el.rxMerge.value = isNaN(savedMerge) ? 50 : Math.max(0, Math.min(2000, savedMerge));
        el.txModeHex.checked = localStorage.getItem(LS_TX_HEX) === '1';
        el.txModbusCrc.checked = localStorage.getItem(LS_TX_MODBUS) === '1';
        const savedEol = localStorage.getItem(LS_TX_EOL);
        if (savedEol) el.txEol.value = savedEol;
        const savedInterval = parseInt(localStorage.getItem(LS_TX_INTERVAL) || '1000', 10);
        if (!isNaN(savedInterval)) el.txInterval.value = Math.max(20, savedInterval);
        const savedTxLast = localStorage.getItem(LS_TX_LAST);
        if (savedTxLast != null) el.txInput.value = savedTxLast;

        const savedType = localStorage.getItem(LS_MB_TYPE);
        if (savedType) el.mbType.value = savedType;
        const savedE32 = localStorage.getItem(LS_MB_E32);
        if (savedE32) el.mbEndian32.value = savedE32;
        const savedE16 = localStorage.getItem(LS_MB_E16);
        if (savedE16) el.mbEndian16.value = savedE16;
        const savedStart = parseInt(localStorage.getItem(LS_MB_START) || '0', 10);
        if (!isNaN(savedStart)) el.mbStart.value = savedStart;
    }

    function saveConfig() {
        localStorage.setItem(LS_FONT, String(state.fontSize));
        localStorage.setItem(LS_BAUD, el.selectBaud.value);
        localStorage.setItem(LS_DATABITS, el.selectDataBits.value);
        localStorage.setItem(LS_PARITY, el.selectParity.value);
        localStorage.setItem(LS_STOPBITS, el.selectStopBits.value);
        localStorage.setItem(LS_RX_HEX, el.rxModeHex.checked ? '1' : '0');
        localStorage.setItem(LS_RX_TS, el.rxShowTs.checked ? '1' : '0');
        localStorage.setItem(LS_RX_MERGE, el.rxMerge.value);
        localStorage.setItem(LS_TX_HEX, el.txModeHex.checked ? '1' : '0');
        localStorage.setItem(LS_TX_MODBUS, el.txModbusCrc.checked ? '1' : '0');
        localStorage.setItem(LS_TX_EOL, el.txEol.value);
        localStorage.setItem(LS_TX_INTERVAL, el.txInterval.value);
        localStorage.setItem(LS_MB_TYPE, el.mbType.value);
        localStorage.setItem(LS_MB_E32, el.mbEndian32.value);
        localStorage.setItem(LS_MB_E16, el.mbEndian16.value);
        localStorage.setItem(LS_MB_START, el.mbStart.value);
        if (state.currentPort) localStorage.setItem(LS_PORT, state.currentPort);
    }

    function saveTxLast() {
        localStorage.setItem(LS_TX_LAST, el.txInput.value);
    }

    // ======== 字号 ========
    function changeFontSize(delta) {
        let next = parseInt(el.inputFontSize.value, 10);
        if (isNaN(next)) next = state.fontSize;
        if (typeof delta === 'number') next = delta < 0 ? next + 1 : next - 1;
        next = Math.max(10, Math.min(40, next));
        state.fontSize = next;
        el.inputFontSize.value = next;
        terminal.options.fontSize = next;
        saveConfig();
        try { fitAddon.fit(); } catch (_err) {}
    }

    // ======== 接收面板渲染 ========
    function fmtTs() {
        const d = new Date();
        const pad = function (n, w) { return String(n).padStart(w || 2, '0'); };
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
    }

    function bytesToHex(bytes) {
        const parts = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
            parts[i] = bytes[i].toString(16).toUpperCase().padStart(2, '0');
        }
        return parts.join(' ');
    }

    function bytesToText(bytes) {
        // 尽量按 UTF-8 解码，失败时容错替换
        try {
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch (_err) {
            let out = '';
            for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
            return out;
        }
    }

    function pushRxLine(prefix, body) {
        const line = (el.rxShowTs.checked ? '[' + fmtTs() + '] ' : '') + prefix + body;
        state.rxLines.push(line);
        if (state.rxLines.length > state.rxMaxLines) {
            state.rxLines.splice(0, state.rxLines.length - state.rxMaxLines);
        }
        scheduleRxRender();
    }

    function flushRxFrame() {
        if (state.rxFrameTimer) {
            clearTimeout(state.rxFrameTimer);
            state.rxFrameTimer = null;
        }
        if (!state.rxFrameBytes) return;
        // 合并成一个 Uint8Array
        const merged = new Uint8Array(state.rxFrameBytes);
        let offset = 0;
        for (let i = 0; i < state.rxFrameBuf.length; i++) {
            merged.set(state.rxFrameBuf[i], offset);
            offset += state.rxFrameBuf[i].length;
        }
        state.rxFrameBuf = [];
        state.rxFrameBytes = 0;
        if (el.rxModeHex.checked) {
            pushRxLine('<- ', bytesToHex(merged));
        } else {
            const text = bytesToText(merged);
            const segs = text.split(/\r\n|\r|\n/);
            for (let i = 0; i < segs.length; i++) {
                if (segs[i] === '' && i === segs.length - 1) continue;
                pushRxLine('<- ', segs[i]);
            }
        }
        // Modbus CRC 模式下，把这整帧送给解析面板
        if (el.txModbusCrc.checked && merged.length >= 4) {
            state.lastFrameForParse = merged;
            try { renderModbusResult(merged); } catch (err) {
                el.mbFrameInfo.innerHTML = '<span class="bad">解析异常: ' + esc(err.message) + '</span>';
            }
        }
    }

    function appendRxBytes(bytes) {
        if (el.rxPaused.checked) return;
        if (!bytes || !bytes.length) return;
        const mergeMs = Math.max(0, parseInt(el.rxMerge.value, 10) || 0);
        if (mergeMs === 0) {
            // 不聚合，立即展示
            if (el.rxModeHex.checked) {
                pushRxLine('<- ', bytesToHex(bytes));
            } else {
                const text = bytesToText(bytes);
                const segs = text.split(/\r\n|\r|\n/);
                for (let i = 0; i < segs.length; i++) {
                    if (segs[i] === '' && i === segs.length - 1) continue;
                    pushRxLine('<- ', segs[i]);
                }
            }
            return;
        }
        // 聚合模式：收到字节 → 进缓冲 → 重置定时器，静默期满才 flush
        state.rxFrameBuf.push(bytes);
        state.rxFrameBytes += bytes.length;
        if (state.rxFrameTimer) clearTimeout(state.rxFrameTimer);
        state.rxFrameTimer = setTimeout(flushRxFrame, mergeMs);
    }

    function scheduleRxRender() {
        if (state.rxTimer) return;
        state.rxTimer = requestAnimationFrame(function () {
            state.rxTimer = null;
            el.rxView.textContent = state.rxLines.join('\n');
            if (el.rxAutoScroll.checked) {
                el.rxView.scrollTop = el.rxView.scrollHeight;
            }
        });
    }

    function clearRx() {
        flushRxFrame();
        state.rxLines = [];
        state.rxFrameBuf = [];
        state.rxFrameBytes = 0;
        el.rxView.textContent = '';
    }

    function exportRx() {
        const blob = new Blob([state.rxLines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'serial-rx-' + Date.now() + '.txt';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    // ======== 发送面板 ========
    // Modbus RTU CRC-16：多项式 0xA001，初始 0xFFFF，低字节在前
    function crc16Modbus(bytes) {
        let crc = 0xffff;
        for (let i = 0; i < bytes.length; i++) {
            crc ^= bytes[i];
            for (let j = 0; j < 8; j++) {
                if (crc & 0x0001) {
                    crc = (crc >>> 1) ^ 0xa001;
                } else {
                    crc >>>= 1;
                }
            }
        }
        return new Uint8Array([crc & 0xff, (crc >>> 8) & 0xff]);
    }

    // ======== Modbus 帧解析 ========
    // 输入是一整帧字节，返回 { addr, func, byteCount, data, crcOk, frameText, exception, isRead }
    function parseModbusFrame(bytes) {
        if (!bytes || bytes.length < 4) {
            return { valid: false, reason: '帧长度不足 4 字节' };
        }
        const addr = bytes[0];
        const funcRaw = bytes[1];
        const isException = (funcRaw & 0x80) !== 0;
        const func = funcRaw & 0x7f;

        // CRC 校验（最后 2 字节）
        const payload = bytes.slice(0, bytes.length - 2);
        const expected = crc16Modbus(payload);
        const crcOk = expected[0] === bytes[bytes.length - 2] && expected[1] === bytes[bytes.length - 1];

        const info = {
            valid: true,
            addr: addr,
            func: funcRaw,
            funcBase: func,
            exception: isException,
            crcOk: crcOk,
            byteCount: 0,
            data: new Uint8Array(0),
            isRead: false,
        };

        if (isException) {
            // 异常帧：addr func errorCode CRC CRC，共 5 字节
            info.exception = true;
            info.errorCode = bytes.length >= 3 ? bytes[2] : 0;
            return info;
        }

        // 读响应：01/02/03/04 → addr, func, byteCount, data...
        if ([1, 2, 3, 4].indexOf(func) >= 0 && bytes.length >= 5) {
            info.isRead = true;
            info.byteCount = bytes[2];
            info.data = bytes.slice(3, 3 + info.byteCount);
            return info;
        }

        // 写单个响应（05/06）：addr func addr_hi addr_lo value_hi value_lo CRC CRC → 8 字节
        // 写多个响应（15/16）：addr func addr_hi addr_lo qty_hi qty_lo CRC CRC → 8 字节
        // 写请求回显里的地址和值也放进 data 方便查看
        if ([5, 6, 15, 16].indexOf(func) >= 0 && bytes.length >= 8) {
            info.writeRegAddr = (bytes[2] << 8) | bytes[3];
            info.writeRegValueOrQty = (bytes[4] << 8) | bytes[5];
            return info;
        }

        return info;
    }

    const MODBUS_EXCEPTIONS = {
        1: 'Illegal Function',
        2: 'Illegal Data Address',
        3: 'Illegal Data Value',
        4: 'Slave Device Failure',
        5: 'Acknowledge',
        6: 'Slave Device Busy',
        8: 'Memory Parity Error',
        10: 'Gateway Path Unavailable',
        11: 'Gateway Target Device Failed to Respond',
    };

    const MODBUS_FUNC_NAMES = {
        1: 'Read Coils',
        2: 'Read Discrete Inputs',
        3: 'Read Holding Registers',
        4: 'Read Input Registers',
        5: 'Write Single Coil',
        6: 'Write Single Register',
        15: 'Write Multiple Coils',
        16: 'Write Multiple Registers',
    };

    // 把 data（字节）按类型和字节序解析
    // data: Uint8Array
    // type: u16/i16/hex16/u32/i32/f32
    // e16/e32: 字节序
    function decodeModbusData(data, type, e16, e32) {
        const is32 = (type === 'u32' || type === 'i32' || type === 'f32');
        const items = [];
        const stride = is32 ? 4 : 2;
        if (data.length < stride) return items;

        for (let off = 0; off + stride <= data.length; off += stride) {
            const raw = data.slice(off, off + stride);
            const reordered = reorderBytes(raw, is32 ? e32 : e16);
            const buf = new ArrayBuffer(stride);
            new Uint8Array(buf).set(reordered);
            const dv = new DataView(buf);
            let value;
            if (type === 'u16') value = dv.getUint16(0, false);
            else if (type === 'i16') value = dv.getInt16(0, false);
            else if (type === 'hex16') value = '0x' + dv.getUint16(0, false).toString(16).toUpperCase().padStart(4, '0');
            else if (type === 'u32') value = dv.getUint32(0, false) >>> 0;
            else if (type === 'i32') value = dv.getInt32(0, false);
            else if (type === 'f32') {
                const f = dv.getFloat32(0, false);
                value = Number.isFinite(f) ? Number(f.toPrecision(8)) : String(f);
            }
            items.push({
                offsetBytes: off,
                raw: raw,
                reordered: reordered,
                value: value,
            });
        }
        return items;
    }

    // 按字节序重排（DataView 始终按"大端"读，因此重排后=目标大端布局）
    function reorderBytes(raw, order) {
        // raw 是原始顺序（来自 Modbus 线上顺序：先来的字节对应索引更小）
        // 对 16 位：AB 原序（高前低后），BA 字节交换
        if (raw.length === 2) {
            if (order === 'BA') return new Uint8Array([raw[1], raw[0]]);
            return new Uint8Array([raw[0], raw[1]]);
        }
        // 对 32 位：
        // 原始四字节记为 A B C D（寄存器 N 的高字节 A、低字节 B；寄存器 N+1 的高字节 C、低字节 D）
        // - ABCD：原序，高字存高地址（大端）
        // - CDAB：字交换，常见于"寄存器 N+1 是高位"的设备
        // - BADC：字节交换
        // - DCBA：全反序
        const a = raw[0], b = raw[1], c = raw[2], d = raw[3];
        if (order === 'CDAB') return new Uint8Array([c, d, a, b]);
        if (order === 'BADC') return new Uint8Array([b, a, d, c]);
        if (order === 'DCBA') return new Uint8Array([d, c, b, a]);
        return new Uint8Array([a, b, c, d]);
    }

    function renderModbusResult(frameBytes) {
        const info = parseModbusFrame(frameBytes);
        if (!info.valid) {
            el.mbFrameInfo.innerHTML = '<span class="bad">' + esc(info.reason) + '</span>';
            el.mbResult.innerHTML = '';
            return;
        }

        const funcName = MODBUS_FUNC_NAMES[info.funcBase] || ('Function ' + info.funcBase);
        const crcTag = info.crcOk ? '<span class="ok">CRC OK</span>' : '<span class="bad">CRC ERR</span>';
        let head = 'Slave=' + info.addr + '  Func=0x' + info.func.toString(16).toUpperCase().padStart(2, '0')
            + ' (' + esc(funcName) + (info.exception ? ' · EXCEPTION' : '') + ')  ' + crcTag;
        el.mbFrameInfo.innerHTML = head;

        if (info.exception) {
            const ex = MODBUS_EXCEPTIONS[info.errorCode] || 'Unknown';
            el.mbResult.innerHTML = '<div style="color:#fca5a5">异常码 ' + info.errorCode + ' (' + esc(ex) + ')</div>';
            return;
        }

        if (info.isRead && (info.funcBase === 3 || info.funcBase === 4)) {
            // 读寄存器
            const type = el.mbType.value;
            const e16 = el.mbEndian16.value;
            const e32 = el.mbEndian32.value;
            const start = parseInt(el.mbStart.value, 10) || 0;
            const items = decodeModbusData(info.data, type, e16, e32);
            if (!items.length) {
                el.mbResult.innerHTML = '<div style="color:#94a3b8">data 长度 ' + info.data.length + ' 字节，不足以按 ' + type + ' 解析</div>';
                return;
            }
            const regPerItem = (type === 'u16' || type === 'i16' || type === 'hex16') ? 1 : 2;
            let html = '<table><thead><tr>'
                + '<th>Addr</th><th>Raw(HEX)</th><th>Reordered</th><th>' + type.toUpperCase() + '</th>'
                + '</tr></thead><tbody>';
            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                const addr = start + i * regPerItem;
                const addrRange = regPerItem === 1 ? String(addr) : (addr + '~' + (addr + 1));
                html += '<tr>'
                    + '<td class="idx">' + addrRange + '</td>'
                    + '<td class="hex">' + bytesToHex(it.raw) + '</td>'
                    + '<td class="hex">' + bytesToHex(it.reordered) + '</td>'
                    + '<td class="val">' + esc(String(it.value)) + '</td>'
                    + '</tr>';
            }
            html += '</tbody></table>';
            el.mbResult.innerHTML = html;
            return;
        }

        if (info.isRead && (info.funcBase === 1 || info.funcBase === 2)) {
            // 读线圈/离散量：每字节是 8 个点，低位在前
            const start = parseInt(el.mbStart.value, 10) || 0;
            const bits = [];
            for (let i = 0; i < info.data.length; i++) {
                for (let b = 0; b < 8; b++) {
                    bits.push((info.data[i] >> b) & 1);
                }
            }
            let html = '<table><thead><tr><th>Addr</th><th>Bit</th></tr></thead><tbody>';
            for (let i = 0; i < bits.length; i++) {
                html += '<tr><td class="idx">' + (start + i) + '</td><td class="val">' + bits[i] + '</td></tr>';
            }
            html += '</tbody></table>';
            el.mbResult.innerHTML = html;
            return;
        }

        if ([5, 6, 15, 16].indexOf(info.funcBase) >= 0) {
            const label = (info.funcBase === 5 || info.funcBase === 6) ? '写入值' : '寄存器数量';
            el.mbResult.innerHTML = '<div>写响应: 起始地址=' + info.writeRegAddr
                + ' , ' + label + '=' + info.writeRegValueOrQty + '</div>';
            return;
        }

        el.mbResult.innerHTML = '<div style="color:#94a3b8">未识别的响应结构</div>';
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function parseHex(input) {
        // 忽略空白、逗号、0x 前缀；要求偶数个 hex 字符
        const cleaned = String(input || '').replace(/0x/gi, '').replace(/[\s,;]+/g, '');
        if (!cleaned.length) return new Uint8Array(0);
        if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
            throw new Error('HEX 内容包含非法字符');
        }
        if (cleaned.length % 2 !== 0) {
            throw new Error('HEX 长度必须为偶数');
        }
        const out = new Uint8Array(cleaned.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
        }
        return out;
    }

    function appendEol(bytes) {
        const eol = el.txEol.value;
        if (eol === 'None') return bytes;
        const extra = eol === 'LF' ? [0x0a] : eol === 'CR' ? [0x0d] : [0x0d, 0x0a];
        const out = new Uint8Array(bytes.length + extra.length);
        out.set(bytes, 0);
        out.set(extra, bytes.length);
        return out;
    }

    function buildTxBytes() {
        const raw = el.txInput.value;
        if (el.txModeHex.checked) {
            return parseHex(raw);
        }
        return new TextEncoder().encode(raw);
    }

    function appendCrc(bytes) {
        const crc = crc16Modbus(bytes);
        const out = new Uint8Array(bytes.length + 2);
        out.set(bytes, 0);
        out.set(crc, bytes.length);
        return out;
    }

    function buildFinalPayload() {
        const body = buildTxBytes();
        if (!body.length) return body;
        // Modbus CRC 勾选时，追加 CRC 并忽略行尾（RTU 帧不带 LF/CR）
        if (el.txModbusCrc.checked) {
            return appendCrc(body);
        }
        return appendEol(body);
    }

    function u8ToBase64(u8) {
        let s = '';
        const chunk = 0x8000;
        for (let i = 0; i < u8.length; i += chunk) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
        }
        return btoa(s);
    }

    function sendBytes(bytes) {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        state.ws.send(JSON.stringify({
            type: 'input',
            payload: { encoding: 'base64', data: u8ToBase64(bytes) },
        }));
    }

    function logTx(bytes) {
        if (!bytes || !bytes.length) return;
        if (el.rxPaused.checked) return;
        // 发送记录按发送模式显示：
        // - 接收面板勾了 HEX → 全部 HEX
        // - HEX 发送或 Modbus CRC → 强制 HEX（包含不可见字节，文本解码会变乱码）
        // - 文本发送且无 CRC → 文本
        const useHex = el.rxModeHex.checked || el.txModeHex.checked || el.txModbusCrc.checked;
        if (useHex) {
            pushRxLine('-> ', bytesToHex(bytes));
        } else {
            pushRxLine('-> ', bytesToText(bytes));
        }
    }

    function doSend() {
        if (!state.connected) {
            pushRxLine('!! ', '串口未打开');
            return;
        }
        let payload;
        try {
            payload = buildFinalPayload();
        } catch (err) {
            pushRxLine('!! ', '发送失败: ' + err.message);
            return;
        }
        if (!payload.length) return;
        sendBytes(payload);
        state.writeBytes += payload.length;
        logTx(payload);
        updateStats();
        saveTxLast();
    }

    function toggleRepeat() {
        if (state.txRepeatTimer) {
            clearInterval(state.txRepeatTimer);
            state.txRepeatTimer = null;
            el.txRepeat.textContent = '定时';
            el.txRepeat.classList.remove('io-btn-primary');
            return;
        }
        const interval = Math.max(20, parseInt(el.txInterval.value, 10) || 1000);
        el.txRepeat.textContent = '停止(' + interval + 'ms)';
        el.txRepeat.classList.add('io-btn-primary');
        doSend();
        state.txRepeatTimer = setInterval(doSend, interval);
        saveConfig();
    }

    function syncModbusUI() {
        // 勾选 Modbus CRC 时：
        //   - 行尾下拉置灰（RTU 帧不带 LF/CR）
        //   - 联动把接收面板切到 HEX（二进制帧文本解码会乱码）
        //   - 打开 Modbus 解析面板
        //   - 取消时恢复用户之前的接收显示模式，并收起解析面板
        const on = el.txModbusCrc.checked;
        el.txEol.disabled = on;
        el.txEol.title = on ? 'Modbus CRC 模式下忽略行尾' : '';
        el.mbPanel.classList.toggle('open', on);
        if (on) {
            if (state.rxHexBeforeModbus == null) {
                state.rxHexBeforeModbus = el.rxModeHex.checked;
            }
            if (!el.rxModeHex.checked) {
                el.rxModeHex.checked = true;
                localStorage.setItem(LS_RX_HEX, '1');
            }
        } else if (state.rxHexBeforeModbus != null) {
            if (el.rxModeHex.checked !== state.rxHexBeforeModbus) {
                el.rxModeHex.checked = state.rxHexBeforeModbus;
                localStorage.setItem(LS_RX_HEX, state.rxHexBeforeModbus ? '1' : '0');
            }
            state.rxHexBeforeModbus = null;
        }
    }

    // ======== 串口列表 ========
    function fetchPorts(probe) {
        // 用绝对路径 + cache:no-store，避免 iframe/缓存导致命中静态资源兜底
        const url = location.origin + '/api/serial/ports'
            + (probe ? '?probe=1&t=' : '?t=') + Date.now();
        return fetch(url, { cache: 'no-store', headers: { 'Accept': 'application/json' } })
            .then(function (resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const ct = resp.headers.get('content-type') || '';
                if (ct.indexOf('application/json') < 0) {
                    throw new Error('响应非 JSON（' + ct + '），可能命中了静态页面，请硬刷新页面');
                }
                return resp.json();
            })
            .then(function (json) {
                renderPorts(json.ports || [], !!json.probed);
                state.portsLoaded = true;
                if (probe) {
                    const total = (json.ports || []).length;
                    const usable = (json.ports || []).filter(function (p) { return p.openable !== false && !p.busy; }).length;
                    terminal.writeln('\x1b[36m[扫描] 共 ' + total + ' 个端口，' + usable + ' 个可用\x1b[0m');
                }
            })
            .catch(function (err) {
                terminal.writeln('\x1b[31m拉取串口列表失败：' + err.message + '\x1b[0m');
            });
    }

    function portLabel(p, probed) {
        // 展示：/dev/ttyS0 [16550A]  或  /dev/ttyS1 [unknown]  或  /dev/ttyUSB0 [USB]
        let label = p.path;
        if (p.uartType) label += ' [' + p.uartType + ']';
        else if (p.kind === 'usb') label += ' [USB]';
        else if (p.kind === 'acm') label += ' [ACM]';

        if (p.busy) label += ' · 占用';
        else if (probed) {
            if (p.openable === false) label += ' · 不可用' + (p.probeError ? '(' + p.probeError + ')' : '');
            else if (p.openable === true) label += ' · ✓';
        }
        return label;
    }

    function renderPorts(ports, probed) {
        const previous = el.selectPort.value || localStorage.getItem(LS_PORT) || '';
        el.selectPort.innerHTML = '';
        if (!ports.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '（未发现串口设备）';
            opt.disabled = true;
            el.selectPort.appendChild(opt);
            return;
        }
        ports.forEach(function (p) {
            const opt = document.createElement('option');
            opt.value = p.path;
            opt.textContent = portLabel(p, probed);
            if (p.busy || p.openable === false) opt.disabled = true;
            el.selectPort.appendChild(opt);
        });
        // 优先恢复上次选择；如果 previous 不可用，选第一个可用项
        let restored = false;
        if (previous) {
            for (let i = 0; i < el.selectPort.options.length; i++) {
                if (el.selectPort.options[i].value === previous && !el.selectPort.options[i].disabled) {
                    el.selectPort.selectedIndex = i;
                    restored = true;
                    break;
                }
            }
        }
        if (!restored) {
            for (let i = 0; i < el.selectPort.options.length; i++) {
                if (!el.selectPort.options[i].disabled) {
                    el.selectPort.selectedIndex = i;
                    break;
                }
            }
        }
    }

    // ======== WebSocket ========
    function wsUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return proto + '//' + location.host + '/ws/serial';
    }

    function updateStats() {
        const tag = state.connected
            ? ('已连接 ' + state.currentPort + ' @ ' + el.selectBaud.value + ' ' + el.selectDataBits.value + el.selectParity.value.charAt(0).toUpperCase() + el.selectStopBits.value)
            : '未连接';
        el.transferStats.textContent = tag + '  |  RX ' + state.readBytes + ' B  TX ' + state.writeBytes + ' B';
    }

    function setConnectedUI(opened) {
        state.connected = opened;
        el.buttonConnect.textContent = opened ? '关闭串口' : '打开串口';
        el.selectPort.disabled = opened;
        el.selectBaud.disabled = opened;
        el.selectDataBits.disabled = opened;
        el.selectParity.disabled = opened;
        el.selectStopBits.disabled = opened;
        el.buttonRefreshPorts.disabled = opened;
        el.buttonCtrlC.style.display = opened ? 'flex' : 'none';
        el.buttonCtrlD.style.display = opened ? 'flex' : 'none';
        el.buttonScrollToBottom.style.display = opened ? 'flex' : 'none';
        if (!opened && state.txRepeatTimer) {
            clearInterval(state.txRepeatTimer);
            state.txRepeatTimer = null;
            el.txRepeat.textContent = '定时';
            el.txRepeat.classList.remove('io-btn-primary');
        }
        updateStats();
    }

    function openSerial() {
        const devPath = el.selectPort.value;
        if (!devPath) {
            terminal.writeln('\x1b[33m请先选择一个串口设备\x1b[0m');
            return;
        }
        const ws = new WebSocket(wsUrl());
        state.ws = ws;
        state.currentPort = devPath;

        ws.addEventListener('open', function () {
            ws.send(JSON.stringify({
                type: 'open',
                payload: {
                    path: devPath,
                    baudRate: Number(el.selectBaud.value),
                    dataBits: Number(el.selectDataBits.value),
                    parity: el.selectParity.value,
                    stopBits: Number(el.selectStopBits.value),
                },
            }));
        });

        ws.addEventListener('message', function (event) {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_err) { return; }
            const payload = msg.payload || {};
            if (msg.type === 'status') {
                if (payload.state === 'opened') {
                    setConnectedUI(true);
                    terminal.writeln('\x1b[32m[已打开] ' + payload.port + ' @ ' + payload.baudRate + '\x1b[0m');
                    pushRxLine('** ', '已打开 ' + payload.port + ' @ ' + payload.baudRate);
                    terminal.focus();
                    saveConfig();
                } else if (payload.state === 'closed') {
                    setConnectedUI(false);
                    terminal.writeln('\x1b[33m[已关闭]' + (payload.reason ? ' (' + payload.reason + ')' : '') + '\x1b[0m');
                    pushRxLine('** ', '已关闭' + (payload.reason ? ' (' + payload.reason + ')' : ''));
                    try { ws.close(); } catch (_err) {}
                }
            } else if (msg.type === 'output') {
                let bytes;
                if (payload.encoding === 'base64') {
                    const bin = atob(payload.data || '');
                    bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                } else {
                    bytes = new TextEncoder().encode(payload.data || '');
                }
                state.readBytes += bytes.length;
                // Modbus/HEX 这类二进制协议场景，字节含控制字符，写进 xterm 会变乱码
                // 只在"非 Modbus 且接收面板非 HEX"时才写终端交互区
                const suppressXterm = el.txModbusCrc.checked || el.rxModeHex.checked;
                if (!suppressXterm) {
                    terminal.write(bytes);
                }
                appendRxBytes(bytes);
                updateStats();
            } else if (msg.type === 'error') {
                terminal.writeln('\x1b[31m[错误] ' + (payload.message || '') + '\x1b[0m');
                pushRxLine('!! ', payload.message || '未知错误');
            }
        });

        ws.addEventListener('close', function () {
            if (state.connected) {
                terminal.writeln('\x1b[33m[连接已断开]\x1b[0m');
                pushRxLine('** ', '连接已断开');
            }
            setConnectedUI(false);
            state.ws = null;
        });

        ws.addEventListener('error', function () {
            terminal.writeln('\x1b[31m[WebSocket 错误]\x1b[0m');
        });
    }

    function closeSerial() {
        if (!state.ws) { setConnectedUI(false); return; }
        try { state.ws.send(JSON.stringify({ type: 'close' })); } catch (_err) {}
        try { state.ws.close(); } catch (_err) {}
    }

    function toggleConnect() {
        if (state.connected) closeSerial();
        else openSerial();
    }

    // ======== 事件绑定 ========
    el.buttonConnect.addEventListener('click', toggleConnect);
    el.buttonRefreshPorts.addEventListener('click', function () { fetchPorts(false); });
    el.buttonScanPorts.addEventListener('click', function () {
        const originalText = el.buttonScanPorts.textContent;
        el.buttonScanPorts.disabled = true;
        el.buttonScanPorts.textContent = '扫描中...';
        terminal.writeln('\x1b[36m[扫描] 正在尝试打开每个端口，请稍候...\x1b[0m');
        fetchPorts(true).finally(function () {
            el.buttonScanPorts.disabled = false;
            el.buttonScanPorts.textContent = originalText;
        });
    });
    el.buttonCtrlC.addEventListener('click', function () {
        if (state.connected) { sendBytes(new Uint8Array([0x03])); terminal.focus(); }
    });
    el.buttonCtrlD.addEventListener('click', function () {
        if (state.connected) { sendBytes(new Uint8Array([0x04])); terminal.focus(); }
    });
    el.buttonScrollToBottom.addEventListener('click', function () {
        terminal.scrollToBottom();
        terminal.focus();
    });
    el.buttonResetStats.addEventListener('click', function () {
        state.readBytes = 0;
        state.writeBytes = 0;
        updateStats();
    });
    el.inputFontSize.addEventListener('change', function () { changeFontSize(); });
    el.buttonFontSizeMinus.addEventListener('click', function () { changeFontSize(1); });
    el.buttonFontSizePlus.addEventListener('click', function () { changeFontSize(-1); });
    el.inputFontSize.addEventListener('wheel', function (event) { event.preventDefault(); changeFontSize(event.deltaY); }, { passive: false });
    el.terminalContainer.addEventListener('click', function () { terminal.focus(); });
    el.terminalContainer.addEventListener('wheel', function (event) {
        if (event.ctrlKey) { event.preventDefault(); changeFontSize(event.deltaY); }
    }, { passive: false });

    el.selectBaud.addEventListener('change', saveConfig);
    el.selectDataBits.addEventListener('change', saveConfig);
    el.selectParity.addEventListener('change', saveConfig);
    el.selectStopBits.addEventListener('change', saveConfig);

    // RX 控件
    el.rxClear.addEventListener('click', clearRx);
    el.rxSave.addEventListener('click', exportRx);
    el.rxModeHex.addEventListener('change', function () {
        flushRxFrame();  // 切换 HEX/文本前先把缓冲按旧模式 flush，避免混显
        saveConfig();
    });
    el.rxShowTs.addEventListener('change', saveConfig);
    el.rxMerge.addEventListener('change', saveConfig);

    // TX 控件
    el.txSend.addEventListener('click', doSend);
    el.txClear.addEventListener('click', function () {
        el.txInput.value = '';
        saveTxLast();
    });
    el.txRepeat.addEventListener('click', toggleRepeat);
    el.txModeHex.addEventListener('change', saveConfig);
    el.txModbusCrc.addEventListener('change', function () {
        saveConfig();
        syncModbusUI();
    });
    el.txEol.addEventListener('change', saveConfig);
    el.txInterval.addEventListener('change', saveConfig);
    el.txInput.addEventListener('input', saveTxLast);
    // Ctrl+Enter 发送
    el.txInput.addEventListener('keydown', function (e) {
        if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); doSend(); }
    });

    // Modbus 解析面板控件
    function reparseLast() {
        saveConfig();
        if (state.lastFrameForParse && state.lastFrameForParse.length) {
            try { renderModbusResult(state.lastFrameForParse); } catch (_err) {}
        }
    }
    el.mbType.addEventListener('change', reparseLast);
    el.mbEndian32.addEventListener('change', reparseLast);
    el.mbEndian16.addEventListener('change', reparseLast);
    el.mbStart.addEventListener('change', reparseLast);
    el.mbClear.addEventListener('click', function () {
        el.mbFrameInfo.innerHTML = '';
        el.mbResult.innerHTML = '';
        state.lastFrameForParse = null;
    });

    // ======== 初始化 ========
    loadConfig();
    syncModbusUI();
    setConnectedUI(false);
    fetchPorts(false);
    el.app.style.visibility = 'visible';
})();
