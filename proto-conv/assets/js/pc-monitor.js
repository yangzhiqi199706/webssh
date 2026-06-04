// 右列实时消息渲染（环形 200 条 + 暂停滚动）。复刻 ha-monitor 的 appendMsg。
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    msgList: $('msgList'),
    btnPauseScroll: $('btnPauseScroll'),
    btnClearMsg: $('btnClearMsg'),
  };
  var state = { pauseScroll: false, msgCount: 0 };
  var MAX_MSG = 200;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function nowStamp() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function append(level, msg, ts) {
    if (!el.msgList) return;
    var lvl = (level || 'info').toLowerCase();
    if (['info', 'warn', 'error'].indexOf(lvl) < 0) lvl = 'info';
    var node = document.createElement('div');
    node.className = 'msg-item lvl-' + lvl;
    node.innerHTML = '<span class="ts">[' + escHtml(ts || nowStamp()) + ']</span>' +
      '<span class="lvl-tag">' + lvl.toUpperCase() + '</span>' +
      escHtml(msg || '');
    el.msgList.appendChild(node);
    state.msgCount += 1;
    while (el.msgList.childElementCount > MAX_MSG) {
      el.msgList.removeChild(el.msgList.firstChild);
      state.msgCount -= 1;
    }
    if (!state.pauseScroll) {
      el.msgList.scrollTop = el.msgList.scrollHeight;
    }
  }

  if (el.btnPauseScroll) {
    el.btnPauseScroll.addEventListener('click', function () {
      state.pauseScroll = !state.pauseScroll;
      el.btnPauseScroll.textContent = state.pauseScroll ? '继续滚动' : '暂停滚动';
    });
  }
  if (el.btnClearMsg) {
    el.btnClearMsg.addEventListener('click', function () {
      if (el.msgList) { el.msgList.innerHTML = ''; state.msgCount = 0; }
    });
  }

  window.PcMonitor = {
    append: append,
    info: function (msg) { append('info', msg); },
    warn: function (msg) { append('warn', msg); },
    error: function (msg) { append('error', msg); },
    escHtml: escHtml,
  };

  // 首屏欢迎一行
  append('info', '协议转换面板就绪。点「连接信息」配置 baseUrl/账号，再点「登录」拿 cookie。');
})();
