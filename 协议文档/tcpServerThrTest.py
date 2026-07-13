#coding:utf-8
import socket
from time import ctime
import threading
import time

#监听
#最开始用在重写南网配网测试，串口圆环监听程序。		
class TcpSer:
	def __init__(self,HOST='0.0.0.0',PORT=1234):
		self.HOST = HOST
		self.PORT = PORT
		self.ADDR = (self.HOST,self.PORT)
		self.connectCount = 10
		self.countSock = 0
		self.exitFlag = False
		self.tcpSerSock = None
		self.socketList = []
		self.lock = threading.Lock()
		self.accept_thread = None
		self.start()

	def start(self):
		if self.accept_thread and self.accept_thread.is_alive():
			return True
		self.exitFlag = False
		if self.listen() == False:
			self.exitFlag = True
			return False
		self.accept_thread = threading.Thread(target=self.accept,args=(),daemon=True)
		self.accept_thread.start()
		return True
	
	def listen(self):
		print('Listening:',self.HOST,self.PORT)
		try:
			self.tcpSerSock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
			self.tcpSerSock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
			try:
				self.tcpSerSock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
			except Exception:
				pass
			self.tcpSerSock.bind(self.ADDR)
			self.tcpSerSock.listen(self.connectCount)
			self.tcpSerSock.settimeout(0.2)
			return True
		except Exception as e:
			print('Error in listen:',e)
			try:
				if self.tcpSerSock:
					self.tcpSerSock.close()
			except Exception:
				pass
			self.tcpSerSock = None
			return False
	
	def accept(self):
		while self.exitFlag == False:
			try:
				clientSock, addr = self.tcpSerSock.accept()
				clientSock.setblocking(0)
				with self.lock:
					self.socketList.append([clientSock,addr])
					self.countSock = self.countSock + 1
			except socket.timeout:
				continue
			except OSError:
				if self.exitFlag:
					break
				time.sleep(0.05)
			except Exception:
				if self.exitFlag:
					break
				time.sleep(0.05)
		return True

	def setExitFlag(self):
		self.exitFlag = True

	def getExitFlag(self):
		return self.exitFlag

	def getSocket(self):
		with self.lock:
			if len(self.socketList) != 0:
				theFirstSocket = self.socketList[0]
				del self.socketList[0]
				return theFirstSocket
			else:
				return False

	def close(self):
		self.setExitFlag()
		try:
			if self.tcpSerSock:
				try:
					self.tcpSerSock.shutdown(socket.SHUT_RDWR)
				except Exception:
					pass
				self.tcpSerSock.close()
		except Exception:
			pass
		finally:
			self.tcpSerSock = None
		with self.lock:
			for item in self.socketList:
				try:
					item[0].close()
				except Exception:
					pass
			self.socketList = []
		if self.accept_thread and self.accept_thread.is_alive():
			self.accept_thread.join(timeout=1.0)
		return True

class baseSR:
	def __init__(self,socket):
		self.socket = socket
		self.bufsize = 1024
	
	def settimeout(self,timeout):
		try:
			self.socket.settimeout(timeout)
			return True
		except Exception as e:
			return False
	
	def rr(self):
		try:
			recvData = self.socket.recv(self.bufsize)
			if recvData:
				return recvData
			return False
		except socket.timeout as e:
			return ''
		except BlockingIOError:
			return ''
		except Exception as e:
			return False
	
	def ss(self,data):
		try:
			self.socket.send(data)
			return True
		except Exception as e:
			return False	
			
	def close(self):
		try:
			self.socket.close()
			return True
		except Exception as e:
			print('Error in baseSR close:',e)
			return False
			
#=======================================================================			
class tcpServer(baseSR):
	def __init__(self,socket,addr,recvList,sendList):
		self.socket = socket
		self.addr = addr
		self.recvList = recvList
		self.sendList = sendList
		self.bufsize = 1024
		self.sendCount = 0
		self.exitFlag = False
		threading.Thread(target=self.mainLoop,args=(),daemon=True).start()
	
	def recv(self):
		self.settimeout(0.1)
		while self.exitFlag == False:
			recvData = self.rr()
			if recvData == False:
				self.close()
				self.exitFlag = True
				break
			if recvData == '':
				continue
			self.recvList.append(recvData)
			
	def mainLoop(self):
		print('Accept from:',self.addr)
		threading.Thread(target=self.recv,args=(),daemon=True).start()
		while self.exitFlag == False:
			if len(self.recvList) == 0:
				time.sleep(0.1)
				continue
			if self.ss(b"\xff") == False:
				self.close()
				self.exitFlag = True
				break
			else:
				self.sendCount = self.sendCount + len(self.recvList[0])
				del self.recvList[0]
				print('sendCount:'+str(self.sendCount)+'\r',end='')
		print('End of the connection.',self.socket)
		
if __name__ == '__main__':
	socketHand = TcpSer('0.0.0.0',1234)
	while True:
		tcpSock = socketHand.getSocket()
		if tcpSock == False:
			time.sleep(0.1)
			continue
		print('One connection.')
		tcpServer(tcpSock[0],tcpSock[1],[],[])
		time.sleep(4)
		socketHand.close()
		time.sleep(14)
		socketHand.start()