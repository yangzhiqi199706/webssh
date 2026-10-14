// 模拟内核驱动同步卡住，仅供隔离测试使用。
process.once('message', function () {
  process.send({ type: 'blocked' }, function () {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  });
});
