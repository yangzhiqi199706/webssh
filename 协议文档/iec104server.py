# coding:utf-8
import socket
import sys,time,random,os
import threading
import binascii,datetime
from iec104funPy3 import *
from tcpServerThrTest import *
import argparse,math
import struct

from mysqlpoolctrl import MysqlPoolCtrl
import dbcontrol 

from twisted.python import log,logfile

# dbPool = MysqlPoolCtrl("dcim", "3seckmG7eKstTCRz", "dcim")
# dbPool.getConn()
# dbctrl = dbcontrol.dbControl(dbPool)

while True:
    try:
        dbPool = MysqlPoolCtrl("dcim", "3seckmG7eKstTCRz", "dcim")
        dbPool.getConn()
        dbctrl = dbcontrol.dbControl(dbPool)
        log.msg("MySQL 连接池已启动！")
        break
    except Exception as e:
        log.msg("等待 MySQL 启动...")
        time.sleep(2)


f = logfile.DailyLogFile('log_104.txt', '/www/python/log/dailylog')
log.startLogging(f)

DBUG = True
printFlag = [True]
ycCount = 0
yxCount = 0


class iec104server:
    recv_count = 0  # 当前接收的连接数，新连接加1，断开减1，默认1024条。
    send_state = False

    def __init__(self, socket, addr, ycFrame,yxFrame):
        self.socket = socket
        self.addr = addr
        self.ycFrame = ycFrame
        self.yxFrame = yxFrame

        self.beginComf = '68040b000000'    #固定
        self.timeout = 0.4

        self.localSend = '0000'    #发送端发送序号
        self.localRecv = '0000'    #发送端接收序号

        if DBUG: log.msg('Accept From:', self.addr)
        self.settimeout(1)
        self.myInit()

    def myInit(self):
        iec104server.recv_count = iec104server.recv_count + 1
        self.run()

    def settimeout(self, timeout=0.4):
        self.socket.settimeout(timeout)

    def get_connection_count(self):
        return iec104server.recv_count

    def closeSocket(self):
        try:
            self.socket.close()
        except Exception as e:
            pass

    #发送数据，参数类型为string
    def sendData(self,data):
        # try:
        if DBUG: log.msg('[发#',binascii.b2a_hex(data),']')
        self.socket.sendall(data)
        self.updateLocalSend(binascii.b2a_hex(data),2)    #这里加2，下次发送时要加2.
        return True
        # except Exception as e:
        #     self.closeSocket()
        #     if DBUG: log.msg('Error in send data(Break the connect.):', e)
        #     return False

    def recvData(self):
        try:
            temp_data = self.socket.recv(1024)
            tempDataAscii = binascii.b2a_hex(temp_data)  # 转成16进制
            
            if len(tempDataAscii) != 0:
                if DBUG: log.msg('[收#',tempDataAscii,']')
                self.updateLocalRecv(tempDataAscii,2)
                return tempDataAscii.decode()
            else:
                return ''
        except socket.timeout as e:
            return ''
        except Exception as e:
            if DBUG: log.msg('Error in recvData:', e)
            self.closeSocket()
            return False

    #启动确认
    def sendBeginComf(self):
        if DBUG: log.msg('发送初始化开始返回:'+self.beginComf)
        return self.sendData(binascii.a2b_hex(self.beginComf))
    
    def sendInitEnd(self):
        #self.initEnd = '680e0000 0000 46010400010000000001'  # 初始化结束。
        curFrame = '680e'+self.localSend+self.localRecv+'46010400010000000001'
        if DBUG: log.msg('发送初始化结束返回:'+ curFrame)
        return self.sendData(binascii.a2b_hex(curFrame))

    # 总召确认,返回确认帧的具体内容。以便后续的帧获取到发送序号。
    def sendZZaoComf(self):
        comf_str = '680e' + self.localSend+self.localRecv+'64010700010000000014'
        if DBUG: log.msg('发送总招返回:', comf_str)
        return self.sendData(binascii.a2b_hex(comf_str))

    # 发送总召激活终止。
    def sendEnd(self):
        # if DBUG: log.msg('激活终止')
        ###############################################总召，不连接，激活终止。
        curFrame = '680e'+self.localSend+self.localRecv+'6401'+'0a00'+'010000000014'
        if DBUG: log.msg('发送总召激活返回:', curFrame)
        return self.sendData(binascii.a2b_hex(curFrame))

    # 发送遥测数据
    def sendYcData(self,str_state = "0100"):
        if DBUG: log.msg('发送遥测帧' + str_state)
        for line in self.ycFrame:
            curFrame = '68'+line[1]+self.localSend+self.localRecv+line[0]
            curFrame = curFrame[:16] + str_state + curFrame[20:]
            #if DBUG: log.msg('发送遥测数据:', curFrame)
            if not self.sendData(binascii.a2b_hex(curFrame)):
                return False
        return True

    # 发送遥信数据
    def sendYXData(self,str_state = "0100"):
        if DBUG: log.msg('发送遥信帧' + str_state)
        # if DBUG: log.msg('sendYXData self.yxFrame',self.yxFrame)
        for line in self.yxFrame:
            curFrame = '68'+line[1]+self.localSend+self.localRecv+line[0]
            curFrame = curFrame[:16] + str_state + curFrame[20:]
            #if DBUG: log.msg('发送遥信数据:', curFrame)
            if not self.sendData(binascii.a2b_hex(curFrame)):
                return False
        return True


    #更新本地发送序号。
    #默认加0，则接收到的序号。在sendData中，自己每一次发，panding应该为2
    def updateLocalSend(self,resultData,panding=0):
        if len(resultData) > 12:
            self.localSend = createXuHao(getXuHao(resultData)+panding)

    #更新本地发送序号。
    #本地发送序号为最为接收I帧的发送序号+2
    def updateLocalRecv(self,resultData,panding=0):
        if len(resultData) > 12:
            self.localRecv = createXuHao(getXuHao(resultData)+panding)

    # 用户重写或者覆盖此方法
    def run(self):
        while True:
            resultData = self.recvData()
            
            if resultData == False:  # 接收错误
                break
            if resultData == '':  # 超时返回
                continue

            if checkIfBegin(resultData):  # 如果是启动传输。
                log.msg("收到初始化指令")
                if not (self.sendBeginComf() and self.sendInitEnd()):
                    break

            elif checkIfZZao(resultData):  # 如果是总召。
                log.msg("收到总召指令")
                self.send_state = False 

                self.sendZZaoComf()
                self.sendYcData("1400")
                self.sendYXData("1400")
                self.sendEnd()

                self.send_state = True
                log.msg("收到总召指令 send_state",self.send_state)

                while self.send_state:
                    self.sendYcData()
                    time.sleep(30)
                    self.sendYXData()
                    time.sleep(30)
  
                log.msg("收到新总召指令 send_state",self.send_state)
                    

            elif ifYaoKong(resultData):    #遥控
                log.msg("收到遥控指令")
                ykPart = resultData[12:32]        #
                timeString = resultData[32:]    #时标
                if ykPart.find('0600') != -1:
                    ykPartComf = ykPart.replace('0600','0700')
                elif ykPart.find('0800') != -1:
                    ykPartComf = ykPart.replace('0800','0900')
                if len(timeString) == 0:
                    frameLen = '0e'
                else:
                    frameLen = '15'
                curFrame = '68'+frameLen+self.localSend+self.localRecv+ykPartComf+timeString
                if not self.sendData(binascii.a2b_hex(curFrame)):
                    break

            elif ifGuiYi(resultData):    #归一化值。
                log.msg("收到归一化值指令")
                gyPart = resultData[12:20]    #从apdu类型到传输原因。
                gyActiveFlag = resultData[-2:]    #最后一字节
                frameLen = '10'
                if gyPart.find('0600') != -1 and gyActiveFlag == '80':
                    gyPartComf = gyPart.replace('0600','0700')
                elif gyPart.find('0600') != -1 and gyActiveFlag == '00':
                    gyPartComf = gyPart.replace('0600', '0a00')
                elif gyPart.find('0800') != 0:
                    gyPartComf = gyPart.replace('0800', '0a00')
                curFrame = '68'+frameLen+self.localSend+self.localRecv+gyPartComf+resultData[20:]
                if not self.sendData(binascii.a2b_hex(curFrame)):
                    break

            elif ifYaoTiao(resultData): #遥调
                log.msg("收到遥调指令")
                ytPart = resultData[12:20]
                ytActiveFlag = resultData[-2:]
                frameLen = '0e'
                if ytPart.find('0600') != -1 and ytActiveFlag in ['82','81']:
                    ytPartComf = ytPart.replace('0600','0700')
                elif ytPart.find('0600') != -1 and ytActiveFlag in ['02','01']:
                    ytPartComf = ytPart.replace('0600', '0a00')
                elif ytPart.find('0800') != -1:
                    ytPartComf = ytPart.replace('0800', '0a00')
                curFrame = '68'+frameLen+self.localSend+self.localRecv+ytPartComf+resultData[20:]
                if not self.sendData(binascii.a2b_hex(curFrame)):
                    break

            else:
                pass

        self.closeSocket()
        iec104server.recv_count = iec104server.recv_count - 1


def random_string(randomlength=1024):
    str = ''
    chars = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789'
    length = 61
    random = Random()
    for i in range(randomlength):
        str += chars[random.randint(0, length)]
    return str

#获取，单点，双点遥控选择与执行帧，客户端与服务端都可以调用。
#single为单双点，active为第3帧是否执行，comf是否回复帧，switch为分合，select为前两帧
def createYaoKong(point,single,active,comf,switch,select,timeMark):
    pubAddress = '0100'
    if single and not timeMark:
        ykType = '2d'    #单点，不带时标
    elif single and timeMark:
        ykType = '3a'    #单点，带时标
    elif not single and not timeMark:
        ykType = '2e'    #双点，不带时标
    elif not single and timeMark:
        ykType = '3b'    #双点，带时标

    if select:    #第一、二帧
        if not comf:    # 第一帧
            ykJiHuo = '0600'
        else:    #第二帧
            ykJiHuo = '0700'

        if single:    #单点
            if switch:    #合
                ykAction = '81'
            else:    #分
                ykAction = '80'
        else:    #双点
            if switch:    #合
                ykAction = '82'
            else:    #分
                ykAction = '81'

    elif not select: #第三、四帧
        if not comf: #第三帧，
            if active: #执行
                ykJiHuo = '0600'
            else:    #取消执行
                ykJiHuo = '0800'
        else: #第四帧
            if active: #执行
                ykJiHuo = '0700'
            else:    #取消执行
                ykJiHuo = '0900'

        if single:    #单点
            if switch:    #合
                ykAction = '01'
            else:    #分
                ykAction = '00'
        else:    #双点
            if switch:    #合
                ykAction = '02'
            else:    #分
                ykAction = '01'

    curAddress = createAddress(point,plus=24577-1)    #首个地址是24577
    return ykType+'01'+ykJiHuo+pubAddress+curAddress+ykAction

#遥调
def createYaoTiao(point,active,comf,switch,select):
    pubAddress = '0100'
    ytType = '2f' #遥调，与双点遥信类似。
    if select: #第一、二帧
        if not comf: #第一帧
            ytJiHuo = '0600'
        else: #第二帧
            ytJiHuo = '0700'

        if switch: #升
            ytAction = '82'
        else: #降
            ytAction = '81'

    else: #第三、四帧
        if not comf: #第三帧
            if active:
                ytJiHuo = '0600'
            else:
                ytJiHuo = '0800'
        else:
            ytJiHuo = '0a00'

        if active:
            if switch:
                ytAction = '02' #执行、升
            else:
                ytAction = '01' #执行、降
        else:
            if switch:
                ytAction = '82' #取消、升
            else:
                ytAction = '81' #取消、降

    curAddress = createAddress(point,plus=0) #网上没有查到首个地址，PMA显示首个地址为0
    return ytType+'01'+ytJiHuo+pubAddress+curAddress+ytAction

#select为前两帧，comf为回复帧，active为第3帧是否执行。
def createGuiYi(point,value,active,comf,select):
    pubAddress = '0100'
    gyType = '30'
    curAddress = createAddress(point,plus=0)
    curValue = createOneGy(value)

    if select: #第一、二帧
        gyAction = '80'
        if not comf: #第一帧
            gyJiHuo = '0600'
        else: #第二帧
            gyJiHuo = '0700'
    else: #第三、四帧
        if not comf: #第三帧
            if active: #执行
                gyJiHuo = '0600'
                gyAction = '00'
            else: #取消
                gyJiHuo = '0800'
                gyAction = '80' #不知道为什么PMA是返回这个值？，如果高位s/e执行时设为0，此值16进制应该是0
        else: #第四帧
            if active: #执行
                gyJiHuo = '0a00'
                gyAction = '00'
            else: #取消
                gyJiHuo = '0a00'
                gyAction = '80'

    return gyType+'01'+gyJiHuo+pubAddress+curAddress+curValue+gyAction

#更新遥测帧
def updateYCFrame(ycList,ycFrame,ycCount):
    ycPart = ''
    yc_zhi = '0d'  # 当前帧为遥测帧（0b标度化值 0D小浮点数）
    zzao_zhen = '1400'  # 遥测帧，响应总召。传输原因
    pub_addr = '0100'  # 公共地址
    curAddress = ''
    first_address = True
    j = 0
    i = 0
    '''遥测帧长度：
    1、68:1    不计算在内
    2、长度:1 不计算内
    3、发送序号：2
    4、接收序号：2
    5、遥测值表示：1
    6、遥测值数量表示：1
    7、传输原因：2
    8、公共地址：2
    8、首个值地址：3
    9、遥测点个数x*3
    当x=76（2+2+1+1+2+2+3+76*3=13+228=241=f1）
    当x=76（2+2+1+1+2+2+3+45*5=13+225=238=ee）
    当x=52（2+2+1+1+2+2+3+52*3=13+156=169=a9）
    '''
    if DBUG: log.msg('updateYCFrame ycCount:',ycCount)
    # if DBUG: log.msg('updateYCFrame ycList:',ycList)
    for z in range(ycCount):
        if first_address == True:
            curAddress = createAddress(0)  # 当前帧遥测值首地址。
            first_address = False
        ycPart = ycPart + ycList[z]
        if j == 44:  # 最长一个遥测帧为76个值（前位置1，表示连接。16进制为（128+76=CC 128+45=ad）。其实76为自己定义的一个值。
            j = 0
            this_z = yc_zhi + 'ad' + zzao_zhen + pub_addr + curAddress + ycPart
            ycFrame[i] = [this_z,'ee']
            i = i + 1
            curAddress = createAddress(z+1)  #下一个帧遥测值首地址。
            ycPart = ''
        else:
            j = j + 1
    ###################128,最高位置1，连续
    last_z = yc_zhi+hex(j+128).replace('0x','')+zzao_zhen+pub_addr+curAddress+ycPart
    last_z_len = hex(int((len(last_z)+8)/2)).replace('0x', '')  #加8，因为这里少了发送序号和接收序号。
    # if DBUG: log.msg('updateYCFrame i:',i)
    log.msg('updateYCFrame ycFramelen:',len(ycFrame))
    # if DBUG: log.msg('updateYCFrame ycFrame[0]:',len(ycFrame[0]))
    # if DBUG: log.msg('updateYCFrame last_z:',last_z)
    # if DBUG: log.msg('updateYCFrame last_z:',last_z_len)
    ycFrame[i] = [last_z,last_z_len]
    # for line in ycList:
    #     if DBUG: log.msg('ycList:',line)
    # for line in ycFrame:
    #     if DBUG: log.msg('ycFrame:',line,len(line[0]))


def updateYXFrame(yxList,yxFrame,yxCount):
    yxPart = ''

    s01 = '01'  # 单点信息
    sLen = 0  # 长度，多少个遥信量
    sReason = '1400'  # 传输原因，包括测试位，P/N位，传送原因，源发地址
    sPublish = '0100'  # 公共地址
    sFirstYxAddress = 0  # 第一个遥信地址
    firstAddress = True
    j = 0
    i = 0
    '''遥信帧长度：
    1、68:1    不计算在内
    2、长度:1 不计算内
    3、发送序号：2
    4、接收序号：2
    5、遥信值表示：1
    6、遥信值数量表示：1
    7、传输原因：2
    8、公共地址：2
    8、首个值地址：3
    9、遥测点个数x*1
    当x=76（2+2+1+1+2+2+3+76*1=13+76=89=59（Hex））
    当x=52（2+2+1+1+2+2+3+52*1=13+52=65=41（Hex））
    '''

    log.msg('updateYXFrame yxFramelen:',len(yxFrame))
    if DBUG: log.msg('updateYXFrame yxList:',yxList)

    for z in range(yxCount):
        if firstAddress == True:
            firstAddress = False
            curAddress = createAddress(1,plus=28672)

        yxPart = yxPart + yxList[z]

        if j == 75:    #最长一个遥信帧，即76个遥信（cc），也是随便定义的，跟遥测测试为相同。
            j = 0
            thisZ = s01+'cc'+sReason+sPublish+curAddress+yxPart
            # if DBUG: log.msg('updateYXFrame i:',i)
            yxFrame[i] = [thisZ,'59']
            i = i + 1
            curAddress = createAddress(z+2,plus=28672)    #下一个遥信帧首地址。
            yxPart = ''
        else:
            j = j + 1
        #################128,则最高位置1，表示连续。
    thisZ = s01+hex(j+128).replace('0x','')+sReason+sPublish+curAddress+yxPart
    thisZLen = hex(int((len(thisZ)+8)/2)).replace('0x', '')  #加8，因为这里少了发送序号和接收序号。
    yxFrame[i] = [thisZ,thisZLen]

    # for line in yxFrame:
    #     if DBUG: log.msg(line,len(line[0]))

#定时更新ycList的值。不是具体报文。
def initYcYxList(ycList,ycFrame,ycCount,yxList,yxFrame,yxCount):
    # if DBUG: log.msg('initYcList dbctrl:',dbctrl)
    ycCount,ycList = setValueYc(ycList, ycCount)  # 初始化遥测值。
    yxCount,yxList = setValueYx(yxList, yxCount)  # 初始化遥信值。

    if DBUG: log.msg('initYcList ycCount:',ycCount)
    if DBUG: log.msg('initYcList yxCount:',yxCount)

    ycFrameLen = math.ceil(ycCount/45)    #向上取整
    #ycFrema = [[帧内容（不包括头，发送序号，接收序号），长度]]
    for i in range(ycFrameLen):    #初始化ycFrame长度
        ycFrame.append([])
    
    yxFrameLen = math.ceil(yxCount/76)    #向上取整
    for i in range(yxFrameLen):
        yxFrame.append([])


    if DBUG: log.msg('initYcList ycFrameLen:',ycFrameLen)
    if DBUG: log.msg('initYcList yxFrameLen:',yxFrameLen)

    j = 0
    while True:

        ycCount,ycList = setValueYc(ycList, ycCount)  # 更新遥测值。
        yxCount,yxList = setValueYx(yxList, yxCount)  # 更新遥信值。

        # arrYcList = dbctrl.getTelemetry(1)

        # xx = 0

        # for ycValue in arrYcList:
        #     # ycList[xx] = createFloatYc(ycValue + j)
        #     ycList[xx] = createFloatYc(ycValue)
        #     xx = xx + 1
            
        updateYCFrame(ycList,ycFrame,ycCount)

        # j = j + 1
        # if j >= 6:
        #     j = 0

        # arrYxList = dbctrl.getTelemetry(2)
        # xx = 0
        # for i in arrYxList:
        #     if i == 0:
        #         yxList[xx] = '01'
        #     else:
        #         yxList[xx] = '00'
        #     xx = xx + 1

        updateYXFrame(yxList,yxFrame,yxCount)

        time.sleep(60)

# def initYxList(yxList,yxFrame,yxCount):
#     yxCount = 0
#     dbPool.getConn()
#     dbctrl = dbcontrol.dbControl(dbPool)
#     if DBUG: log.msg('initYxList dbctrl:',dbctrl)
#     # for i in range(yxSize):
#     #     if i%2 == 0:
#     #         yxList.append('00')    #'00分，01合'
#     #     else:
#     #         yxList.append('01')  # '00分，01合'
#     setValueYx(yxList, yxCount)  # 初始化遥信值。

#     yxFrameLen = math.ceil(yxCount/76)    #向上取整

#     for i in range(yxFrameLen):
#         yxFrame.append([])
#     j = 0

#     while True:
#         setValueYx(yxList, dbctrl, yxCount)  # 更新遥信值。
#         for i in range(yxCount):
#             if yxList[i] == '00':
#                 yxList[i] = '01'
#             else:
#                 yxList[i] = '00'
#         updateYXFrame(yxList,yxFrame,yxCount)
#         time.sleep(60)

# 随机遥测值
# def random_yc(ycList, number):
#     for i in range(number):
#         ycList.append(createOneYc(i))

# 取得遥测值
def setValueYc(ycList,ycCount):
    try:
        arrYcList = dbctrl.getTelemetry(1)
        ycCount = len(arrYcList)
        ycList = []
        # if DBUG: log.msg('arrYcList:',arrYcList)
        if DBUG: log.msg('ycCount:'+ str(ycCount))

        for i in arrYcList:
            ycList.append(createFloatYc(i))
            
    except Exception as e:
        log.msg('setValueYc error:'+ str(e))
    
    return ycCount,ycList

# 取得遥信值
def setValueYx(yxList,yxCount):
    try:
        arrYxList = dbctrl.getTelemetry(2)
        yxCount = len(arrYxList)
        yxList = []

        if DBUG: log.msg('arrYxList:',arrYxList)
        if DBUG: log.msg('yxCount:'+ str(yxCount))

        # if DBUG: log.msg('yxCount yxList:'+ str(len(yxList)))

        for i in arrYxList:
            if int(i) == 0 :
                yxList.append('00')  #'00分，01合'
            else:
                yxList.append('01')  #'00分，01合'

        if DBUG: log.msg('yxCount yxList:'+ str(len(yxList)))
    except Exception as e:
        log.msg('setValueYx error:'+ str(e))
        
    return yxCount,yxList

# 每个遥测长度6位，共3个字节，前两个为具体数值，低位在前，高位在后，最后1个字节为品质。
def createOneYc(value):
    hex_yc = hex(int(value*100)).replace('0x', '')
    # hex_yc = struct.pack('>f' ,float(value)).hex()
    # if DBUG: log.msg('createOneYc hex_yc:',hex_yc)
    if len(hex_yc) == 1:
        return '0' + hex_yc + '0000'
    elif len(hex_yc) == 2:
        return hex_yc + '0000'
    elif len(hex_yc) == 3:
        return hex_yc[1:3] + '0' + hex_yc[0] + '00'
    elif len(hex_yc) == 4:
        return hex_yc[2:4] + hex_yc[0:2] + '00'
    else:
        return '000000'
    # return hex_yc + '00'

def createFloatYc(value):
    # hex_yc = hex(int(value*100)).replace('0x', '')
    hex_yc = struct.pack('>f' ,float(value)).hex()

    return hex_yc[6:8] + hex_yc[4:6] + hex_yc[2:4] + hex_yc[0:2] + '00'
    # return hex_yc + '00'

#返修归一值。
def createOneGy(value):
    hexString = hex(value)[2:].zfill(4)
    return hexString[2:]+hexString[0:2]

#以帧分割接收到的数据。
def splitData(varByte):
    dataList = []
    while True:
        if getBit(varByte,1) == '68':
            curLen = int(getBit(varByte,2),16)*2+4
            dataList.append(varByte[0:curLen])
            varByte = varByte[curLen:]
            if len(varByte) == 0:
                break
    return dataList

def countConnect():
    while True:
        if DBUG: log.msg('Total:', iec104server.recv_count, '\r',end='')
        sys.stdout.flush()
        time.sleep(1)

def osSystem(cmd):
    try:
        return os.system(cmd)
    except Exception as e:
        if DBUG: log.msg('Error in osSystem:', e)

def setTitle(theTitle):
    try:
        if os.name == 'nt':
            osSystem("title " + theTitle)
        if os.name == 'posix':
            sys.stdout.write("\x1b]2;" + theTitle + "\x07")
    except Exception as e:
        if DBUG: log.msg('Error in setTitle:', e)

def printData(info):
    if printFlag[0] == False:
        return False
    sys.stdout.write(datetime.datetime.now().strftime('%H:%M:%S.%f '))
    sys.stdout.write(info[0])
    sys.stdout.write(' ')
    data = info[1]
    if type(data) == type(b'asdf'):
        data = data.decode()

    while True:
        sys.stdout.write(data[0:2])
        sys.stdout.write(' ')
        data = data[2:]
        if len(data) == 0:
            if DBUG: log.msg('')
            break


def mainServer(port,ycSize=64,yxSize=32):
    ycList = []
    ycFrame = []
    yxList = []
    yxFrame = []
    ycSize = ycSize
    yxSize = yxSize
    threading.Thread(target=initYcYxList, args=(ycList,ycFrame,ycSize,yxList,yxFrame,yxSize)).start()
    #threading.Thread(target=initYxList, args=(yxList,yxFrame,yxSize)).start()
    threading.Thread(target=countConnect, args=()).start()

    socketHand = TcpSer('0.0.0.0', 2404)
    while True:
        tcpSock = socketHand.getSocket()
        if tcpSock == False:
            time.sleep(0.05)
            continue
        threading.Thread(target=iec104server, args=(tcpSock[0], tcpSock[1], ycFrame,yxFrame)).start()

def mainClient(ip,port,thrCount=1):
    for i in range(thrCount):
        threading.Thread(target=iec104client(ip,port).start,args=()).start()

def main_loop():
    curRole = 's'
    ip = '127.0.0.1'
    port = 2404
    thrCount = 1
    ycSize = 64
    yxSize = 32
     
    if curRole == 's':
        setTitle('Server#'+str(port)+' yc:'+str(ycSize)+' yx:'+str(yxSize))
        mainServer(port,ycSize,yxSize)
    if curRole == 'c':
        setTitle('Client#'+ip+':'+str(port)+' thr:'+str(thrCount))
        mainClient(ip,port,thrCount)

if __name__ == '__main__':
    main_loop()
     