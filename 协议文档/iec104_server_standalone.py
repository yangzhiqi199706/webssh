# coding: utf-8
# IEC 60870-5-104 独立服务端（基于现有工程逻辑）
# 说明（来自接口文档关键点）：
# 1) 报文三类：I 帧（信息）、S 帧（确认）、U 帧（控制）。
#    APCI 固定 6 字节：启动字符 0x68 + 长度 + 4 字节控制域。
# 2) 总召：类型标识 0x64，COT=0x06 激活，COT=0x07 激活确认，
#    COT=0x0A 激活结束，QOI=0x14 表示总召。
# 3) 遥测常用类型：0x0D（浮点 + 品质，4 字节数据 + 1 字节品质）。
# 4) 遥信常用类型：0x01（单点遥信，1 字节值）。
# 5) CA/COT/IOA 字节数需与主站一致；本文件支持配置化长度。
import socket
import sys
import time
import threading
import binascii
import datetime
import math
import struct
import os
import signal

from mysqlpoolctrl import MysqlPoolCtrl
import dbcontrol
from tcpServerThrTest import TcpSer
from twisted.python import log, logfile


DBUG = True
# IEC104 可配置字段长度（默认 2/2/3，兼容 1/1/2）
# ca_len: 公共地址字节数（CA）
# cot_len: 传输原因字节数（COT）
# ioa_len: 信息体地址字节数（IOA）
# ca: 本站公共地址（与主站配置一致）
# ti_yc/ti_yx: 遥测/遥信类型标识（0x0D/0x01）
# cot: 传输原因（COT）常量集合
IEC104_CONFIG = {
    "ca_len": 2,
    "cot_len": 2,
    "ioa_len": 3,
    "ca": 1,
    "ti_yc": 0x0D,
    "ti_yx": 0x01,
    "cot": {
        "cyc": 0x01,
        "spont": 0x03,
        "act": 0x06,
        "actcon": 0x07,
        "actterm": 0x0A,
        "gi": 0x14,
    },
}
# YX/YC base addresses (kept consistent with current logic)
YC_BASE = 16386
YX_BASE = 2

# U 帧常量
U_STARTDT_ACT = '07'
U_STARTDT_CON = '0B'
U_STOPDT_ACT = '13'
U_STOPDT_CON = '23'
U_TESTFR_ACT = '43'
U_TESTFR_CON = '83'

# 空闲测试帧周期（秒）
U_TEST_INTERVAL = 60

# YX spontaneous event


yx_spont_event = threading.Event()
yx_spont_lock = threading.Lock()
yx_spont_indices = []
yx_current = []

shutdown_event = threading.Event()
server_socket_holder = {'listener': None}

# 小端字节序转整数（低位在前）
def _u8_list_to_int_le(byte_list):
    return sum(b << (8 * i) for i, b in enumerate(byte_list))


# 整数转小端字节序列表
def _int_to_u8_list_le(val, length):
    return [(val >> (8 * i)) & 0xFF for i in range(length)]


# 从十六进制字符串按字节偏移切片
def _hexslice_to_u8(hex_str, offset, length):
    return [int(hex_str[(offset + i) * 2:(offset + i + 1) * 2], 16) for i in range(length)]


# 解析 APDU：APCI 固定 6 字节，ASDU 从第 7 字节开始
# 按 ca_len/cot_len/ioa_len 计算偏移，返回 ti/vsq/cot/ca/ioa
def parse_apdu(apdu_hex, cfg=IEC104_CONFIG):
    if len(apdu_hex) < 12:
        return {"is_i": False, "is_s": False, "is_u": False}
    c1 = int(apdu_hex[4:6], 16)
    is_u = (c1 & 0x03) == 0x03
    is_s = (c1 & 0x01) == 0x01 and not is_u
    is_i = (c1 & 0x01) == 0x00 and not is_u
    if not is_i:
        return {"is_i": is_i, "is_s": is_s, "is_u": is_u}
    asdu_start = 6
    ti = int(apdu_hex[asdu_start * 2:(asdu_start + 1) * 2], 16)
    vsq = int(apdu_hex[(asdu_start + 1) * 2:(asdu_start + 2) * 2], 16)
    cot_off = asdu_start + 2
    cot = _u8_list_to_int_le(_hexslice_to_u8(apdu_hex, cot_off, cfg["cot_len"])) & 0x3F
    ca_off = cot_off + cfg["cot_len"]
    ca = _u8_list_to_int_le(_hexslice_to_u8(apdu_hex, ca_off, cfg["ca_len"]))
    ioa_off = ca_off + cfg["ca_len"]
    ioa = _u8_list_to_int_le(_hexslice_to_u8(apdu_hex, ioa_off, cfg["ioa_len"]))
    data_off = ioa_off + cfg["ioa_len"]
    return {
        "is_i": True,
        "is_s": False,
        "is_u": False,
        "ti": ti,
        "vsq": vsq,
        "cot": cot,
        "ca": ca,
        "ioa": ioa,
        "data_offset": data_off,
    }


def parse_ctrl_field(apdu_hex):
    # 解析控制域：识别 I/S/U 帧并返回原始序号（未右移）
    if len(apdu_hex) < 12:
        return {"is_i": False, "is_s": False, "is_u": False}
    c1 = int(apdu_hex[4:6], 16)
    c2 = int(apdu_hex[6:8], 16)
    c3 = int(apdu_hex[8:10], 16)
    c4 = int(apdu_hex[10:12], 16)
    is_u = (c1 & 0x03) == 0x03
    is_s = (c1 & 0x01) == 0x01 and not is_u
    is_i = (c1 & 0x01) == 0x00 and not is_u
    send_raw = (c2 << 8) | c1
    recv_raw = (c4 << 8) | c3
    return {
        "is_i": is_i,
        "is_s": is_s,
        "is_u": is_u,
        "send_raw": send_raw,
        "recv_raw": recv_raw,
    }


def debug_log(*args):
    # 统一调试输出开关，避免散落 if DBUG
    if DBUG:
        log.msg(*args)


def debug_hex_frame(prefix, hex_str):
    # 调试输出完整十六进制帧（仅在 DBUG 为 True 时）
    if DBUG:
        log.msg(prefix, hex_str)


def cot_desc(cot):
    # 传送原因中文说明（用于日志）
    if cot == IEC104_CONFIG["cot"]["gi"]:
        return "总召响应"
    if cot == IEC104_CONFIG["cot"]["cyc"]:
        return "周期上送"
    if cot == IEC104_CONFIG["cot"]["spont"]:
        return "突变上送"
    if cot == IEC104_CONFIG["cot"]["actcon"]:
        return "激活确认"
    if cot == IEC104_CONFIG["cot"]["actterm"]:
        return "激活结束"
    return f"未知COT({hex(cot)})"


# 组装 ASDU：ti/vsq + cot/ca/ioa（小端）+ 数据区
def build_asdu(ti, vsq, cot, ca, ioa, data_hex, cfg=IEC104_CONFIG):
    cot_bytes = _int_to_u8_list_le(cot, cfg["cot_len"])
    ca_bytes = _int_to_u8_list_le(ca, cfg["ca_len"])
    ioa_bytes = _int_to_u8_list_le(ioa, cfg["ioa_len"])

    def _bytes_to_hex(lst):
        return ''.join(f"{b:02x}" for b in lst)

    return (
        f"{ti:02x}{vsq:02x}"
        f"{_bytes_to_hex(cot_bytes)}"
        f"{_bytes_to_hex(ca_bytes)}"
        f"{_bytes_to_hex(ioa_bytes)}"
        f"{data_hex}"
    )


# APCI 长度 = ASDU 字节数 + 4（控制域）
def create_apci_len(asdu_hex):
    ln = int(len(asdu_hex) / 2) + 4
    return f"{ln:02x}"


# 生成 IOA 整数（基址 + 序号）
def create_ioa_int(i, base):
    return base + int(i)


# IOA 整数转小端十六进制
def create_ioa_hex(ioa, cfg=IEC104_CONFIG):
    ioa_bytes = _int_to_u8_list_le(ioa, cfg["ioa_len"])
    return ''.join(f"{b:02x}" for b in ioa_bytes)

def build_u_frame(ctrl_hex):
    # U 帧：68 04 <ctrl> 00 00 00
    return '6804' + ctrl_hex + '000000'

def is_u_frame(var, ctrl_hex):
    return len(var) == 12 and getBit(var, 1) == '68' and getBit(var, 3) == ctrl_hex

def get_time_mark_hex():
    # CP56Time2a：毫秒(低在前) + 分 + 时 + 日/周 + 月 + 年(2000基准)
    t = time.localtime()
    ms = int((time.time() * 1000) % 60000)
    ms_hex = hex(ms)[2:].zfill(4)
    minute = hex(t.tm_min)[2:].zfill(2)
    hour = hex(t.tm_hour)[2:].zfill(2)
    wday = int(time.strftime('%w', t))  # 0-6
    day = t.tm_mday + (wday << 5)
    day_hex = hex(day)[2:].zfill(2)
    month = hex(t.tm_mon)[2:].zfill(2)
    year = hex(t.tm_year - 2000)[2:].zfill(2)
    return ms_hex[2:] + ms_hex[:2] + minute + hour + day_hex + month + year

def getBit(varString, count):
    # 取第 count 个字节（1-based），返回 2 位十六进制字符串（大写）
    if len(varString) < 2 * count:
        return ''
    if str(type(varString)).find('byte') != -1:
        return varString[2 * count - 2:2 * count].decode().upper()
    return varString[2 * count - 2:2 * count].upper()


def getXuHao(var):
    # 发送/接收序号在控制域第 3/4 字节（低位在前）
    if len(var) < 8:
        return False
    return int(getBit(var, 4) + getBit(var, 3), 16)


def createXuHao(var_int):
    # 生成发送/接收序号（低位字节在前）
    hex_num = hex(int(var_int)).replace('0x', '')
    hex_num_len = len(hex_num)
    if hex_num_len % 2 != 0:
        hex_num = '0' + hex_num
    if len(hex_num) == 2:
        return hex_num + '00'
    return hex_num[2] + hex_num[3] + hex_num[0] + hex_num[1]


# STARTDT 激活判断（U 帧控制域 0x07）
def checkIfBegin(var):
    return len(var) >= 12 and getBit(var, 1) == '68' and getBit(var, 3) == '07'


# 总召激活判断：TI=0x64，COT=act，QOI=0x14
def checkIfZZao(var):
    p = parse_apdu(var)
    if not p.get("is_i"):
        return False
    if p.get("ti") != 0x64 or p.get("cot") != IEC104_CONFIG["cot"]["act"]:
        return False
    data_off = p.get("data_offset")
    if data_off is None or len(var) < (data_off + 1) * 2:
        return False
    qoi = int(var[data_off * 2:(data_off + 1) * 2], 16)
    return qoi == 0x14


def ifYaoKong(var):
    # 遥控：TI=0x2D/0x2E/0x3A/0x3B
    if len(var) >= 32:
        bit7 = getBit(var, 7)
        if bit7 in ['2D', '2E', '3A', '3B']:
            return True
    return False


def ifYaoTiao(var):
    # 遥调：TI=0x2F
    
    if len(var) >= 32:
        bit7 = getBit(var, 7)
        if bit7 in ['2F']:
            return True
    return False


# 归一化值：TI=0x30
def ifGuiYi(var):
    if len(var) >= 36:
        bit7 = getBit(var, 7)
        if bit7 in ['30']:
            return True
    return False


def createAddress(i, plus=YC_BASE):
    ioa = create_ioa_int(i, plus)
    return create_ioa_hex(ioa)


def splitData(varByte):
    # 按 APCI 长度字段拆分粘包（长度字段不含 0x68 与长度字节）
    dataList = []
    
    while True:
        if getBit(varByte, 1) == '68':
            curLen = int(getBit(varByte, 2), 16) * 2 + 4
            dataList.append(varByte[0:curLen])
            varByte = varByte[curLen:]
            if len(varByte) == 0:
                break
    return dataList


# 遥测浮点值编码：4 字节 IEEE754 + 1 字节品质
def createFloatYc(value):
    hex_yc = struct.pack('>f', float(value)).hex()
    return hex_yc[6:8] + hex_yc[4:6] + hex_yc[2:4] + hex_yc[0:2] + '00'


def setValueYc(dbctrl):
    # 从数据库读取遥测值并编码为浮点 + 品质
    arrYcList = dbctrl.getTelemetry(1)
    ycList = [createFloatYc(v) for v in arrYcList]
    return len(arrYcList), ycList


def setValueYx(dbctrl):
    # 从数据库读取遥信值：0=分(00)，1=合(01)
    arrYxList = dbctrl.getTelemetry(2)
    yxList = []
    for v in arrYxList:
        if int(v) == 0:
            yxList.append('00')
        else:
            yxList.append('01')
    return len(arrYxList), yxList


# 遥测组帧：连续地址，VSQ 高位=1，按 45 点分包
def updateYCFrame(ycList, ycFrame, ycCount):
    chunk_size = 45
    frames = []
    start = 0
    while start < ycCount:
        count = min(chunk_size, ycCount - start)
        vsq = 0x80 + count
        data_hex = ''.join(ycList[start:start + count])
        ioa = create_ioa_int(start, YC_BASE)
        frames.append({"vsq": vsq, "ioa": ioa, "data": data_hex})
        start += count
    ycFrame[:] = frames


# 遥信组帧：连续地址，VSQ 高位=1，按 76 点分包
def updateYXFrame(yxList, yxFrame, yxCount):
    chunk_size = 76
    frames = []
    start = 0
    while start < yxCount:
        count = min(chunk_size, yxCount - start)
        vsq = 0x80 + count
        data_hex = ''.join(yxList[start:start + count])
        ioa = create_ioa_int(start + 1, YX_BASE)
        frames.append({"vsq": vsq, "ioa": ioa, "data": data_hex})
        start += count
    yxFrame[:] = frames


# 定时刷新数据库并重组帧，同时检测遥信变化用于突变上报
def initYcYxList(dbctrl, ycList, ycFrame, ycCount, yxList, yxFrame, yxCount, stop_event=None):
    ycCount, ycList = setValueYc(dbctrl)
    yxCount, yxList = setValueYx(dbctrl)
    prev_yx = list(yxList)
    with yx_spont_lock:
        yx_current[:] = list(yxList)

    updateYCFrame(ycList, ycFrame, ycCount)
    updateYXFrame(yxList, yxFrame, yxCount)
    debug_log('Init data', 'ycCount=', ycCount, 'yxCount=', yxCount)

    if stop_event is None:
        stop_event = shutdown_event

    while not stop_event.is_set():
        ycCount, ycList = setValueYc(dbctrl)
        yxCount, yxList = setValueYx(dbctrl)
        if yxList != prev_yx:
            changed = []
            min_len = min(len(prev_yx), len(yxList))
            for i in range(min_len):
                if yxList[i] != prev_yx[i]:
                    changed.append(i)
            if len(yxList) > min_len:
                changed.extend(range(min_len, len(yxList)))
            if changed:
                with yx_spont_lock:
                    yx_spont_indices[:] = changed
                    yx_current[:] = list(yxList)
                yx_spont_event.set()
                debug_log('YX changed', 'count=', len(changed), 'indices=', changed[:20])
            prev_yx = list(yxList)
        else:
            with yx_spont_lock:
                yx_current[:] = list(yxList)
        updateYCFrame(ycList, ycFrame, ycCount)
        updateYXFrame(yxList, yxFrame, yxCount)
        debug_log('Refresh data', 'ycCount=', ycCount, 'yxCount=', yxCount)
        stop_event.wait(60)


class IEC104Server:
    recv_count = 0
    send_state = False

    def __init__(self, sock, addr, ycFrame, yxFrame):
        self.socket = sock
        self.addr = addr
        self.ycFrame = ycFrame
        self.yxFrame = yxFrame
        debug_log('Accept From:', self.addr)
        self.beginComf = '68040b000000'
        self.localSend = '0000'
        self.localRecv = '0000'
        self.recv_buffer = ''
        self.last_io_time = time.time()
        self.next_yc_send = time.time()
        self.last_timeout_log = 0
        self.settimeout(1)
        IEC104Server.recv_count = IEC104Server.recv_count + 1
        self.run()

    def settimeout(self, timeout=0.4):
        self.socket.settimeout(timeout)

    def closeSocket(self):
        try:
            self.socket.close()
            debug_log('Socket closed:', self.addr)
        except Exception:
            pass

    def sendData(self, data, is_i=False):
        if DBUG:
            debug_log('[send]', binascii.b2a_hex(data))
        self.socket.sendall(data)
        if is_i:
            self.updateLocalSend(binascii.b2a_hex(data), 2)
        self.last_io_time = time.time()
        return True

    def recvData(self):
        try:
            temp_data = self.socket.recv(4096)
            tempDataAscii = binascii.b2a_hex(temp_data)
            if len(tempDataAscii) != 0:
                debug_log('收到原始数据', 'addr=', self.addr, 'hex=', tempDataAscii)
                self.last_io_time = time.time()
                self.recv_buffer += tempDataAscii.decode()
                frames = []
                while True:
                    if len(self.recv_buffer) < 4:
                        break
                    if self.recv_buffer[:2].lower() != '68':
                        idx = -1
                        for i in range(0, len(self.recv_buffer) - 1, 2):
                            if self.recv_buffer[i:i + 2].lower() == '68':
                                idx = i
                                break
                        if idx == -1:
                            if DBUG and len(self.recv_buffer) > 0:
                                debug_log('接收缓冲丢弃无效前导', self.recv_buffer)
                            self.recv_buffer = ''
                            break
                        if DBUG and idx > 0:
                            debug_log('接收缓冲丢弃前导', self.recv_buffer[:idx])
                        self.recv_buffer = self.recv_buffer[idx:]
                        if len(self.recv_buffer) < 4:
                            break
                    frame_len = int(self.recv_buffer[2:4], 16) * 2 + 4
                    if len(self.recv_buffer) < frame_len:
                        if DBUG:
                            debug_log('接收缓冲等待完整帧', 'need=', frame_len, 'have=', len(self.recv_buffer))
                        break
                    frames.append(self.recv_buffer[:frame_len])
                    self.recv_buffer = self.recv_buffer[frame_len:]
                return frames if frames else ''
            if DBUG:
                debug_log('[recv] empty payload')
            return ''
        except socket.timeout:
            if DBUG:
                now = time.time()
                if now - self.last_timeout_log >= 30:
                    debug_log('接收超时（无数据）', 'addr=', self.addr)
                    self.last_timeout_log = now
            return ''
        except Exception:
            self.closeSocket()
            return False

    def sendBeginComf(self):
        debug_log('响应：启动传输确认(STARTDT CON)')
        debug_log('Send STARTDT CON')
        return self.sendData(binascii.a2b_hex(self.beginComf))

    def sendTestfrCon(self):
        debug_log('响应：测试帧确认(TESTFR CON)')
        debug_log('Send TESTFR CON')
        return self.sendData(binascii.a2b_hex(build_u_frame(U_TESTFR_CON)))

    def sendTestfrAct(self):
        debug_log('发送：测试帧请求(TESTFR ACT)')
        debug_log('Send TESTFR ACT')
        return self.sendData(binascii.a2b_hex(build_u_frame(U_TESTFR_ACT)))

    def sendStopdtCon(self):
        debug_log('响应：停止传输确认(STOPDT CON)')
        debug_log('Send STOPDT CON')
        return self.sendData(binascii.a2b_hex(build_u_frame(U_STOPDT_CON)))

    def sendTimeSyncCon(self):
        # 时钟同步确认（TI=0x67，COT=actcon）
        debug_log('响应：对时确认(TI=0x67)')
        time_hex = get_time_mark_hex()
        asdu = build_asdu(
            0x67,
            0x01,
            IEC104_CONFIG["cot"]["actcon"],
            IEC104_CONFIG["ca"],
            0,
            time_hex,
        )
        curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
        debug_hex_frame('[send TIME_CON]', curFrame)
        return self.sendData(binascii.a2b_hex(curFrame), is_i=True)

    def sendElectricActcon(self, qcc_hex):
        # 电度总召确认（TI=0x65，COT=actcon）
        debug_log('响应：电度总召激活确认(TI=0x65)', 'QCC=', qcc_hex)
        asdu = build_asdu(
            0x65,
            0x01,
            IEC104_CONFIG["cot"]["actcon"],
            IEC104_CONFIG["ca"],
            0,
            qcc_hex,
        )
        curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
        debug_hex_frame('[send KWH_CON]', curFrame)
        return self.sendData(binascii.a2b_hex(curFrame), is_i=True)

    def sendElectricActterm(self, qcc_hex):
        # 电度总召结束（TI=0x65，COT=actterm）
        debug_log('响应：电度总召结束(TI=0x65)', 'QCC=', qcc_hex)
        asdu = build_asdu(
            0x65,
            0x01,
            IEC104_CONFIG["cot"]["actterm"],
            IEC104_CONFIG["ca"],
            0,
            qcc_hex,
        )
        curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
        debug_hex_frame('[send KWH_END]', curFrame)
        return self.sendData(binascii.a2b_hex(curFrame), is_i=True)

    def sendInitEnd(self):
        debug_log('响应：初始化结束(TI=0x46)')
        debug_log('Send init end (TI=0x46)')
        curFrame = '680e' + self.localSend + self.localRecv + '46010400010000000001'
        return self.sendData(binascii.a2b_hex(curFrame), is_i=True)

    # 总召激活确认（COT=actcon，QOI=0x14）
    def sendZZaoComf(self):
        debug_log('响应：总召激活确认(TI=0x64)')
        debug_log('Send GI actcon')
        asdu = build_asdu(
            0x64,
            0x01,
            IEC104_CONFIG["cot"]["actcon"],
            IEC104_CONFIG["ca"],
            0,
            '14',
        )
        curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
        return self.sendData(binascii.a2b_hex(curFrame), is_i=True)

    # 总召激活结束（COT=actterm，QOI=0x14）
    def sendEnd(self):
        debug_log('响应：总召结束(TI=0x64)')
        debug_log('Send GI actterm')
        asdu = build_asdu(
            0x64,
            0x01,
            IEC104_CONFIG["cot"]["actterm"],
            IEC104_CONFIG["ca"],
            0,
            '14',
        )
        curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
        return self.sendData(binascii.a2b_hex(curFrame), is_i=True)

    # 遥测上送：COT 可选（总召/周期），VSQ 连续
    def sendYcData(self, cot=None):
        if cot is None:
            cot = IEC104_CONFIG["cot"]["cyc"]
        debug_log('响应：遥测', cot_desc(cot))
        debug_log('Send YC', 'cot=', hex(cot), 'frames=', len(self.ycFrame))
        for entry in self.ycFrame:
            asdu = build_asdu(
                IEC104_CONFIG["ti_yc"],
                entry["vsq"],
                cot,
                IEC104_CONFIG["ca"],
                entry["ioa"],
                entry["data"],
            )
            curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
            debug_hex_frame('[send YC]', curFrame)
            if not self.sendData(binascii.a2b_hex(curFrame), is_i=True):
                return False
        return True

    # 遥信上送：COT 可选（总召/周期），VSQ 连续
    def sendYXData(self, cot=None):
        if cot is None:
            cot = IEC104_CONFIG["cot"]["cyc"]
        debug_log('响应：遥信', cot_desc(cot))
        debug_log('Send YX', 'cot=', hex(cot), 'frames=', len(self.yxFrame))
        for entry in self.yxFrame:
            asdu = build_asdu(
                IEC104_CONFIG["ti_yx"],
                entry["vsq"],
                cot,
                IEC104_CONFIG["ca"],
                entry["ioa"],
                entry["data"],
            )
            curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
            debug_hex_frame('[send YX]', curFrame)
            if not self.sendData(binascii.a2b_hex(curFrame), is_i=True):
                return False
        return True

    # 遥信突变上送：逐点构帧（VSQ=1，COT=spont）
    def sendYXSpont(self):
        with yx_spont_lock:
            indices = list(yx_spont_indices)
            yx_spont_indices[:] = []
            yx_spont_event.clear()
            current = list(yx_current)

        debug_log('响应：遥信突变上送')
        debug_log('Send YX spont', 'count=', len(indices))
        for idx in indices:
            if idx >= len(current):
                continue
            ioa = create_ioa_int(idx + 1, YX_BASE)
            asdu = build_asdu(
                IEC104_CONFIG["ti_yx"],
                0x01,
                IEC104_CONFIG["cot"]["spont"],
                IEC104_CONFIG["ca"],
                ioa,
                current[idx],
            )
            curFrame = '68' + create_apci_len(asdu) + self.localSend + self.localRecv + asdu
            debug_hex_frame('[send YX_spont]', curFrame)
            if not self.sendData(binascii.a2b_hex(curFrame), is_i=True):
                return False
        return True

    def updateLocalSend(self, resultData, padding=0):
        if len(resultData) > 12:
            self.localSend = createXuHao(getXuHao(resultData) + padding)
            debug_log('Update localSend:', self.localSend)

    def updateLocalRecv(self, resultData, padding=0):
        if len(resultData) > 12:
            self.localRecv = createXuHao(getXuHao(resultData) + padding)
            debug_log('Update localRecv:', self.localRecv)

    def handle_frame(self, frame):
        ctrl = parse_ctrl_field(frame)
        if ctrl.get("is_i"):
            self.localRecv = createXuHao(ctrl["send_raw"] + 2)
            debug_log('Update localRecv:', self.localRecv)
        elif ctrl.get("is_s"):
            ack_seq = ctrl.get("recv_raw", 0) >> 1
            debug_log('收到请求：S帧确认(ACK)', 'NR=', ack_seq)
            return

        if is_u_frame(frame, U_TESTFR_ACT):
            debug_log('收到请求：测试帧激活(TESTFR ACT)')
            self.sendTestfrCon()
            return
        if is_u_frame(frame, U_TESTFR_CON):
            debug_log('收到请求：测试帧确认(TESTFR CON)')
            return
        if is_u_frame(frame, U_STOPDT_ACT):
            debug_log('收到请求：停止传输激活(STOPDT ACT)')
            self.sendStopdtCon()
            return

        if checkIfBegin(frame):
            debug_log('收到请求：启动传输激活(STARTDT ACT)')
            if not (self.sendBeginComf() and self.sendInitEnd()):
                raise RuntimeError('send STARTDT failed')
        elif checkIfZZao(frame):
            debug_log('收到请求：总召激活(GI ACT)')
            self.send_state = False
            self.sendZZaoComf()
            self.sendYcData(IEC104_CONFIG["cot"]["gi"])
            self.sendYXData(IEC104_CONFIG["cot"]["gi"])
            self.sendEnd()
            self.send_state = True
            self.next_yc_send = time.time() + 30
        elif parse_apdu(frame).get("is_i") and parse_apdu(frame).get("ti") == 0x67 and parse_apdu(frame).get("cot") == IEC104_CONFIG["cot"]["act"]:
            debug_log('收到请求：对时激活(TI=0x67)')
            self.sendTimeSyncCon()
        elif parse_apdu(frame).get("is_i") and parse_apdu(frame).get("ti") == 0x65 and parse_apdu(frame).get("cot") == IEC104_CONFIG["cot"]["act"]:
            debug_log('收到请求：电度总召激活(TI=0x65)')
            p = parse_apdu(frame)
            data_off = p.get("data_offset")
            qcc_hex = frame[data_off * 2:(data_off + 1) * 2] if data_off is not None else '45'
            self.sendElectricActcon(qcc_hex)
            self.sendElectricActterm(qcc_hex)
        elif ifYaoKong(frame):
            debug_log('收到请求：遥控(YK)')
            ykPart = frame[12:32]
            timeString = frame[32:]
            if ykPart.find('0600') != -1:
                ykPartComf = ykPart.replace('0600', '0700')
            elif ykPart.find('0800') != -1:
                ykPartComf = ykPart.replace('0800', '0900')
            if len(timeString) == 0:
                frameLen = '0e'
            else:
                frameLen = '15'
            curFrame = '68' + frameLen + self.localSend + self.localRecv + ykPartComf + timeString
            if not self.sendData(binascii.a2b_hex(curFrame), is_i=True):
                raise RuntimeError('send YK failed')
        elif ifGuiYi(frame):
            debug_log('收到请求：归一化值(GUIYI)')
            gyPart = frame[12:20]
            gyActiveFlag = frame[-2:]
            frameLen = '10'
            if gyPart.find('0600') != -1 and gyActiveFlag == '80':
                gyPartComf = gyPart.replace('0600', '0700')
            elif gyPart.find('0600') != -1 and gyActiveFlag == '00':
                gyPartComf = gyPart.replace('0600', '0a00')
            elif gyPart.find('0800') != 0:
                gyPartComf = gyPart.replace('0800', '0a00')
            curFrame = '68' + frameLen + self.localSend + self.localRecv + gyPartComf + frame[20:]
            if not self.sendData(binascii.a2b_hex(curFrame), is_i=True):
                raise RuntimeError('send GUIYI failed')
        elif ifYaoTiao(frame):
            debug_log('收到请求：遥调(YT)')
            ytPart = frame[12:20]
            ytActiveFlag = frame[-2:]
            frameLen = '0e'
            if ytPart.find('0600') != -1 and ytActiveFlag in ['82', '81']:
                ytPartComf = ytPart.replace('0600', '0700')
            elif ytPart.find('0600') != -1 and ytActiveFlag in ['02', '01']:
                ytPartComf = ytPart.replace('0600', '0a00')
            elif ytPart.find('0800') != -1:
                ytPartComf = ytPart.replace('0800', '0a00')
            curFrame = '68' + frameLen + self.localSend + self.localRecv + ytPartComf + frame[20:]
            if not self.sendData(binascii.a2b_hex(curFrame), is_i=True):
                raise RuntimeError('send YT failed')
        else:
            # 其它 I 帧不处理，留作后续扩展
            debug_log('收到请求：未处理帧', frame)

    def handle_periodic_send(self):
        now = time.time()
        if self.send_state and now >= self.next_yc_send:
            self.sendYcData()
            self.next_yc_send = now + 30
        if yx_spont_event.is_set():
            self.sendYXSpont()

    # 主循环：处理 STARTDT、总召、遥控/遥调/归一化
    # def run(self):
    #     while True:
    #         resultData = self.recvData()
    #         if resultData is False:
    #             debug_log('Recv error, closing', self.addr)
    #             break
    #         if resultData == '':
    #             # 空闲超时主动发送测试帧
    #             if time.time() - self.last_io_time >= U_TEST_INTERVAL:
    #                 self.sendTestfrAct()
    #             self.handle_periodic_send()
    #             continue

    #         if isinstance(resultData, list):
    #             frames = resultData
    #         else:
    #             frames = splitData(resultData)
    #             if not frames:
    #                 frames = [resultData]

    #         for frame in frames:
    #             try:
    #                 self.handle_frame(frame)
    #             except Exception:
    #                 self.closeSocket()
    #                 return
    #         self.handle_periodic_send()

    #     self.closeSocket()
    #     IEC104Server.recv_count = IEC104Server.recv_count - 1
        # 主循环：处理 STARTDT、总召、遥控/遥调/归一化
    def run(self):
        try:
            while not shutdown_event.is_set():
                resultData = self.recvData()
                if resultData is False:
                    debug_log('Recv error, closing', self.addr)
                    break
                if resultData == '':
                    # 空闲超时主动发送测试帧
                    if time.time() - self.last_io_time >= U_TEST_INTERVAL:
                        self.sendTestfrAct()
                    self.handle_periodic_send()
                    continue

                if isinstance(resultData, list):
                    frames = resultData
                else:
                    frames = splitData(resultData)
                    if not frames:
                        frames = [resultData]

                for frame in frames:
                    try:
                        self.handle_frame(frame)
                    except Exception as e:
                        debug_log('Handle frame error', 'addr=', self.addr, 'err=', repr(e))
                        return
                self.handle_periodic_send()
        finally:
            self.closeSocket()
            IEC104Server.recv_count = max(IEC104Server.recv_count - 1, 0)
def countConnect(stop_event=None):
    # 连接计数线程（保留位）
    if stop_event is None:
        stop_event = shutdown_event

    while not stop_event.is_set():
        sys.stdout.flush()
        time.sleep(1)


def osSystem(cmd):
    try:
        return os.system(cmd)
    except Exception:
        return None


def setTitle(theTitle):
    try:
        if os.name == 'nt':
            osSystem("title " + theTitle)
        if os.name == 'posix':
            sys.stdout.write("\x1b]2;" + theTitle + "\x07")
    except Exception:
        pass


def close_listener(socketHand):
    if socketHand is None:
        return

    candidates = []
    for attr in ('socket', 'sock', 'server', 'server_socket', '_socket', '_sock'):
        obj = getattr(socketHand, attr, None)
        if obj is not None:
            candidates.append(obj)
    candidates.append(socketHand)

    seen = set()
    for obj in candidates:
        if obj is None or id(obj) in seen:
            continue
        seen.add(id(obj))
        for method_name in ('closeSocket', 'close', 'shutdown'):
            method = getattr(obj, method_name, None)
            if callable(method):
                try:
                    if method_name == 'shutdown':
                        try:
                            method(socket.SHUT_RDWR)
                        except TypeError:
                            method()
                    else:
                        method()
                except Exception:
                    pass


def install_signal_handlers():
    def _handle_stop(signum, frame):
        debug_log('Receive signal', signum, 'shutdown requested')
        shutdown_event.set()
        close_listener(server_socket_holder.get('listener'))

    for sig_name in ('SIGTERM', 'SIGINT'):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            signal.signal(sig, _handle_stop)


def mainServer(dbctrl, port=2404, ycSize=64, yxSize=32):
    # 启动顺序：先监听成功，再启动数据刷新线程 + TCP 接入线程
    ycList = []
    ycFrame = []
    yxList = []
    yxFrame = []

    try:
        socketHand = TcpSer('0.0.0.0', port)
    except Exception as e:
        debug_log('Listen failed', '0.0.0.0', port, 'err=', repr(e))
        raise SystemExit(1)

    server_socket_holder['listener'] = socketHand
    debug_log('Listening OK', '0.0.0.0', port)

    threading.Thread(
        target=initYcYxList,
        args=(dbctrl, ycList, ycFrame, ycSize, yxList, yxFrame, yxSize, shutdown_event),
        daemon=True,
    ).start()
    threading.Thread(target=countConnect, args=(shutdown_event,), daemon=True).start()

    try:
        while not shutdown_event.is_set():
            tcpSock = socketHand.getSocket()
            if tcpSock is False:
                time.sleep(0.05)
                continue
            threading.Thread(
                target=IEC104Server,
                args=(tcpSock[0], tcpSock[1], ycFrame, yxFrame),
                daemon=True,
            ).start()
    finally:
        close_listener(socketHand)
        server_socket_holder['listener'] = None


def start_db():
    # 等待数据库启动并返回连接控制器
    while True:
        try:
            dbPool = MysqlPoolCtrl("dcim", "3seckmG7eKstTCRz", "dcim")
            dbPool.getConn()
            return dbcontrol.dbControl(dbPool)
        except Exception:
            time.sleep(2)


def main_loop():
    # 主入口：日志 + DB + 监听
    log_dir = '/www/python/log/dailylog'
    os.makedirs(log_dir, exist_ok=True)
    f = logfile.DailyLogFile('log_104_server_standalone.txt', log_dir)
    log.startLogging(f)

    install_signal_handlers()
    shutdown_event.clear()

    dbctrl = start_db()
    port = 2404
    ycSize = 64
    yxSize = 32
    setTitle('Server#' + str(port) + ' yc:' + str(ycSize) + ' yx:' + str(yxSize))
    debug_log('Server start', 'port=', port, 'ycSize=', ycSize, 'yxSize=', yxSize)

    try:
        mainServer(dbctrl, port, ycSize, yxSize)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        debug_log('KeyboardInterrupt, shutdown requested')
    except Exception as e:
        debug_log('Main loop exception', repr(e))
        raise
    finally:
        shutdown_event.set()
        close_listener(server_socket_holder.get('listener'))
        debug_log('Server stop')

    return 0


if __name__ == '__main__':
    sys.exit(main_loop())
    
# def countConnect():
#     # 连接计数线程（保留位）
    
#     while True:
#         sys.stdout.flush()
#         time.sleep(1)


# def osSystem(cmd):
#     try:
#         return os.system(cmd)
#     except Exception:
#         return None


# def setTitle(theTitle):
#     try:
#         if os.name == 'nt':
#             osSystem("title " + theTitle)
#         if os.name == 'posix':
#             sys.stdout.write("\x1b]2;" + theTitle + "\x07")
#     except Exception:
#         pass


# def mainServer(dbctrl, port=2404, ycSize=64, yxSize=32):
#     # 启动：数据刷新线程 + TCP 接入线程
#     ycList = []
#     ycFrame = []
#     yxList = []
#     yxFrame = []
#     threading.Thread(target=initYcYxList, args=(dbctrl, ycList, ycFrame, ycSize, yxList, yxFrame, yxSize)).start()
#     threading.Thread(target=countConnect, args=()).start()

#     socketHand = TcpSer('0.0.0.0', port)
#     debug_log('Listening', '0.0.0.0', port)
    
#     while True:
#         tcpSock = socketHand.getSocket()
#         if tcpSock is False:
#             time.sleep(0.05)
#             continue
#         threading.Thread(target=IEC104Server, args=(tcpSock[0], tcpSock[1], ycFrame, yxFrame)).start()


# def start_db():
#     # 等待数据库启动并返回连接控制器
#     while True:
#         try:
#             dbPool = MysqlPoolCtrl("dcim", "3seckmG7eKstTCRz", "dcim")
#             dbPool.getConn()
#             return dbcontrol.dbControl(dbPool)
#         except Exception:
#             time.sleep(2)


# def main_loop():
#     # 主入口：日志 + DB + 监听
#     f = logfile.DailyLogFile('log_104_server_standalone.txt', '/www/python/log/dailylog')
#     log.startLogging(f)

#     dbctrl = start_db()
#     port = 2404
#     ycSize = 64
#     yxSize = 32
#     setTitle('Server#' + str(port) + ' yc:' + str(ycSize) + ' yx:' + str(yxSize))
#     debug_log('Server start', 'port=', port, 'ycSize=', ycSize, 'yxSize=', yxSize)
#     mainServer(dbctrl, port, ycSize, yxSize)


# if __name__ == '__main__':
#     main_loop()
