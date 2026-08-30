<template>
  <scroller class="container">
    <text class="title">☁ 云浏览器 v1.2.0</text>

    <div class="section">
      <text class="label">服务器</text>
      <input class="input" type="text" :value="serverHost" placeholder="IP:端口" @input="onHostChange" @click="openKeyboard('serverHost', serverHost, 'IP:端口')" />
    </div>

    <div class="section">
      <text class="label">默认页面</text>
      <input class="input" type="text" :value="defaultUrl" placeholder="https://m.baidu.com/" @input="onDefaultUrlChange" @click="openKeyboard('defaultUrl', defaultUrl, 'https://m.baidu.com/')" />
    </div>

    <div class="section">
      <text class="label">导航</text>
      <div class="nav-row">
        <input class="nav-input" type="text" :value="navUrl" placeholder="输入网址" @input="onNavUrlChange" @click="openKeyboard('navUrl', navUrl, '输入网址')" />
        <div class="btn btn-sm btn-go" @click="onNavGo"><text class="btn-text-sm">前往</text></div>
        <div class="btn btn-sm btn-refresh" @click="onRefresh"><text class="btn-text-sm">刷新</text></div>
      </div>
      <div class="nav-row">
        <div class="btn btn-xs btn-quick" @click="onQuickNav('https://m.baidu.com/')"><text class="btn-text-xs">百度</text></div>
        <div class="btn btn-xs btn-quick" @click="onQuickNav('https://cn.bing.com/')"><text class="btn-text-xs">必应</text></div>
        <div class="btn btn-xs btn-quick" @click="onQuickNav('https://example.com/')"><text class="btn-text-xs">Example</text></div>
        <div class="btn btn-xs btn-back" @click="onBack"><text class="btn-text-xs">后退</text></div>
        <div class="btn btn-xs btn-fwd" @click="onForward"><text class="btn-text-xs">前进</text></div>
      </div>
    </div>

    <div class="section">
      <text class="label">控制</text>
      <div class="status-bar">
        <div class="status-item">
          <text :class="['status-dot', serverOnline ? 'dot-green' : 'dot-red']"></text>
          <text class="status-text">服务器</text>
        </div>
        <div class="status-item">
          <text :class="['status-dot', streamRunning ? 'dot-green' : 'dot-red']"></text>
          <text class="status-text">串流</text>
        </div>
        <div class="status-item">
          <text :class="['status-dot', touchRunning ? 'dot-green' : 'dot-red']"></text>
          <text class="status-text">触控</text>
        </div>
      </div>
      <div class="button-row">
        <div class="btn btn-start" @click="onStartAll"><text class="btn-text">一键启动</text></div>
        <div class="btn btn-stop" @click="onStopAll"><text class="btn-text">停止全部</text></div>
      </div>
      <div class="button-row">
        <div class="btn btn-sm btn-stream" @click="onStartStream"><text class="btn-text-sm">仅串流</text></div>
        <div class="btn btn-sm btn-touch" @click="onStartTouch"><text class="btn-text-sm">仅触控</text></div>
        <div class="btn btn-sm btn-stop-stream" @click="onStopStream"><text class="btn-text-sm">停串流</text></div>
        <div class="btn btn-sm btn-stop-touch" @click="onStopTouch"><text class="btn-text-sm">停触控</text></div>
      </div>
    </div>

    <div class="section">
      <text class="label">日志</text>
      <div class="log-box"><text class="log-text">{{ logText }}</text></div>
    </div>
  </scroller>
</template>

<script>
import _bridge from 'bridge'
import globalModule from 'global'

var gm = null;
function getGM() {
  if (!gm) { gm = new globalModule.Global(); }
  return gm;
}

var LOG_MAX = 2000;

export default {
  data: function() {
    return {
      serverHost: 'YOUR_SERVER_IP:8088',
      defaultUrl: 'https://m.baidu.com/',
      navUrl: 'https://m.baidu.com/',
      streamRunning: false,
      touchRunning: false,
      serverOnline: false,
      keyboardUuid: '',
      keyboardField: '',
      wasStreamingOnKeyboard: false,
      wasTouchingOnKeyboard: false,
      logText: ''
    };
  },
  methods: {
    onHostChange: function(e) { this.serverHost = e.value; },
    onDefaultUrlChange: function(e) { this.defaultUrl = e.value; },
    onNavUrlChange: function(e) { this.navUrl = e.value; },

    openKeyboard: function(field, value, placeholder, inputType) {
      var self = this;
      var g = getGM();
      if (!g || !g.startTextEdit) {
        self.addLog('系统输入法不可用');
        return;
      }
      if (self.keyboardUuid) self.closeKeyboard();

      self.wasStreamingOnKeyboard = self.streamRunning;
      self.wasTouchingOnKeyboard = self.touchRunning;
      if (self.wasStreamingOnKeyboard || self.wasTouchingOnKeyboard) {
        self.exec('kill $(pgrep gst-launch) 2>/dev/null; kill $(pgrep touch_back) 2>/dev/null');
        self.streamRunning = false;
        self.touchRunning = false;
      }

      var config = JSON.stringify({
        text: String(value || ''),
        placeholder: placeholder || '请输入内容',
        maxlength: 2048,
        inputType: inputType || 'EnUSPreferred',
        autofocus: true,
        showCursor: true,
        cursorColor: '#087F5B',
        cursorSize: 3,
        confirmButtonDisabledOnTextEmpty: false,
        multiLinesEditVisible: false,
        enterButtonText: '确认'
      });
      try {
        globalThis.__systemInput = true;
        self.keyboardUuid = g.startTextEdit(config) || '';
        self.keyboardField = field;
        if (!self.keyboardUuid) throw new Error('会话创建失败');
      } catch (e) {
        globalThis.__systemInput = false;
        self.keyboardUuid = '';
        self.addLog('输入法启动失败: ' + (e.message || e));
      }
    },
    closeKeyboard: function() {
      var self = this;
      var uuid = self.keyboardUuid;
      if (uuid) {
        var g = getGM();
        if (g && g.closeTextEdit) { g.closeTextEdit(uuid); }
      }
      self.keyboardUuid = '';
      globalThis.__systemInput = false;
    },
    onTextEditFinished: function(uuid, jsonData) {
      var self = this;
      if (!self.keyboardUuid || uuid !== self.keyboardUuid) return;
      var result = null;
      try { result = JSON.parse(jsonData || '{}'); } catch (e) {}
      if (result && result.editConfirmed === true) {
        var text = (result.text || '').replace(/\n/g, '');
        if (self.keyboardField === '__webInput') {
          self.addLog('网页输入: ' + text);
          var host = self.serverHost.split(':')[0];
          self.exec('curl -s -o /dev/null "http://' + host + ':8088/input-submit?text=' + encodeURIComponent(text) + '"');
        } else {
          self[self.keyboardField] = text;
          self.addLog(self.keyboardField + ' 已更新为: ' + text);
        }
      }
      setTimeout(function() {
        self.closeKeyboard();
        var host = self.serverHost.split(':')[0];
        var port = self.serverHost.split(':')[1] || '8088';
        // 无论确认还是取消，都通知服务器清除焦点状态（防重复弹输入法）
        self.exec('curl -s -o /dev/null -m 2 "http://' + host + ':' + port + '/input-blur" &');
        if (self.wasStreamingOnKeyboard) {
          self.exec('setsid sh -c "gst-launch-1.0 -q tcpclientsrc host=' + host + ' port=8090 ! tsdemux ! h264parse ! queue max-size-time=40000000 leaky=downstream ! mppvideodec ! videoflip video-direction=90l ! kmssink plane-id=76 driver-name=rockchip sync=false >/tmp/gst.log 2>&1 &"');
        }
        if (self.wasTouchingOnKeyboard) {
          self.exec('cp \$(find /userdisk/miniapp/data/mini_app/pkg/8001000000000100 -name touch_back -type f 2>/dev/null | head -1) /tmp/touch_back && chmod +x /tmp/touch_back && setsid /tmp/touch_back >/tmp/touch.log 2>&1 &');
        }
        if (self.wasStreamingOnKeyboard) {
          self._blankTimer = setTimeout(function() { $falcon.navTo('blank', {}); }, 5000);
        }
        self.wasStreamingOnKeyboard = false;
        self.wasTouchingOnKeyboard = false;
      }, 300);
    },

    addLog: function(msg) {
      var now = new Date();
      var h = now.getHours().toString(); var m = now.getMinutes().toString(); var s = now.getSeconds().toString();
      if (h.length < 2) h = '0' + h; if (m.length < 2) m = '0' + m; if (s.length < 2) s = '0' + s;
      this.logText = '[' + h + ':' + m + ':' + s + '] ' + msg + '\n' + this.logText;
      if (this.logText.length > LOG_MAX) this.logText = this.logText.substr(0, LOG_MAX);
    },

    exec: function(cmd) {
      try { return _bridge.Shell.exec(cmd); } catch (e) { this.addLog('错误: ' + e.message); return null; }
    },
    execRaw: function(cmd) {
      try { return _bridge.Shell.exec(cmd); } catch (e) { return null; }
    },

    checkStatus: function() {
      var self = this;
      var r1 = self.execRaw('ps | grep -v grep | grep gst-launch');
      var r2 = self.execRaw('ps | grep -v grep | grep touch_back');
      self.streamRunning = (r1 && r1.output && r1.output.indexOf('gst-launch') >= 0);
      self.touchRunning = (r2 && r2.output && r2.output.indexOf('touch_back') >= 0);
    },
    checkServer: function() {
      var self = this;
      var host = self.serverHost.split(':')[0];
      var port = self.serverHost.split(':')[1] || '8088';
      var r = self.execRaw('curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 http://' + host + ':' + port + '/status.json');
      self.serverOnline = (r && r.output && r.output.indexOf('200') >= 0);
    },

    httpGet: function(path) {
      var self = this;
      var host = self.serverHost.split(':')[0];
      var port = self.serverHost.split(':')[1] || '8088';
      self.exec('curl -s "http://' + host + ':' + port + path + '" &');
    },

    onNavGo: function() {
      var self = this;
      var url = self.navUrl;
      if (!url) return;
      if (url.indexOf('://') < 0) url = 'https://' + url;
      self.addLog('导航: ' + url);
      self.httpGet('/nav?url=' + encodeURIComponent(url));
    },
    onQuickNav: function(url) { this.navUrl = url; this.onNavGo(); },
    onBack: function() { this.addLog('后退'); this.httpGet('/back'); },
    onForward: function() { this.addLog('前进'); this.httpGet('/forward'); },
    onRefresh: function() { this.addLog('刷新'); this.httpGet('/refresh'); },

    pollInput: function() {
      var self = this;
      if (self.keyboardUuid) return; // 输入法已打开，不重复弹
      var host = self.serverHost.split(':')[0];
      var port = self.serverHost.split(':')[1] || '8088';
      var r = self.execRaw('curl -s -m 2 "http://' + host + ':' + port + '/input-status"');
      if (!r || !r.output) return;
      var j = null;
      try { j = JSON.parse(r.output); } catch (e) {}
      if (j && j.pending === true) {
        self.addLog('网页输入框聚焦，弹出输入法');
        self.openKeyboard('__webInput', j.value || '', j.placeholder || '', j.type === 'number' ? 'Number' : 'EnUSPreferred');
      }
    },

    onStartAll: function() {
      var self = this;
      self.addLog('一键启动...');
      var host = self.serverHost.split(':')[0];
      self.exec('kill $(pgrep gst-launch) 2>/dev/null; kill $(pgrep touch_back) 2>/dev/null');
      self.exec('setsid sh -c "gst-launch-1.0 -q tcpclientsrc host=' + host + ' port=8090 ! tsdemux ! h264parse ! queue max-size-time=40000000 leaky=downstream ! mppvideodec ! videoflip video-direction=90l ! kmssink plane-id=76 driver-name=rockchip sync=false >/tmp/gst.log 2>&1 &"');
      self.exec('cp \$(find /userdisk/miniapp/data/mini_app/pkg/8001000000000100 -name touch_back -type f 2>/dev/null | head -1) /tmp/touch_back && chmod +x /tmp/touch_back && setsid /tmp/touch_back >/tmp/touch.log 2>&1 &');
      setTimeout(function() { self.checkStatus(); }, 1500);
      self._blankTimer = setTimeout(function() { $falcon.navTo('blank', {}); }, 1000);
    },
    onStopAll: function() {
      var self = this;
      self.addLog('停止全部...');
      self.exec('kill $(pgrep gst-launch) 2>/dev/null; kill $(pgrep touch_back) 2>/dev/null');
      setTimeout(function() { self.checkStatus(); }, 500);
    },
    onStartStream: function() {
      var self = this;
      var host = self.serverHost.split(':')[0];
      self.addLog('启动串流...');
      self.exec('kill $(pgrep gst-launch) 2>/dev/null');
      self.exec('setsid sh -c "gst-launch-1.0 -q tcpclientsrc host=' + host + ' port=8090 ! tsdemux ! h264parse ! queue max-size-time=40000000 leaky=downstream ! mppvideodec ! videoflip video-direction=90l ! kmssink plane-id=76 driver-name=rockchip sync=false >/tmp/gst.log 2>&1 &"');
      setTimeout(function() { self.checkStatus(); }, 1500);
    },
    onStartTouch: function() {
      var self = this;
      self.addLog('启动触控...');
      self.exec('kill $(pgrep touch_back) 2>/dev/null');
      self.exec('cp \$(find /userdisk/miniapp/data/mini_app/pkg/8001000000000100 -name touch_back -type f 2>/dev/null | head -1) /tmp/touch_back && chmod +x /tmp/touch_back && setsid /tmp/touch_back >/tmp/touch.log 2>&1 &');
      setTimeout(function() { self.checkStatus(); }, 1500);
    },
    onStopStream: function() {
      var self = this;
      self.addLog('停止串流...');
      self.exec('kill $(pgrep gst-launch) 2>/dev/null');
      setTimeout(function() { self.checkStatus(); }, 500);
    },
    onStopTouch: function() {
      var self = this;
      self.addLog('停止触控...');
      self.exec('kill $(pgrep touch_back) 2>/dev/null');
      setTimeout(function() { self.checkStatus(); }, 500);
    }
  },
  mounted: function() {
    var self = this;
    self.addLog('面板已启动');
    self.checkStatus();
    self.checkServer();
    self.statusTimer = setInterval(function() { self.checkStatus(); }, 2000);
    self.serverTimer = setInterval(function() { self.checkServer(); }, 5000);
    self.inputTimer = setInterval(function() { self.pollInput(); }, 300);
    var g = getGM();
    if (g && g.textEditFinished && g.textEditFinished.on) {
      self._textEditHandler = function(uuid, jsonData) {
        self.onTextEditFinished(uuid, jsonData);
      };
      g.textEditFinished.on(self._textEditHandler);
    }
  },
  beforeDestroy: function() {
    if (this.statusTimer) { clearInterval(this.statusTimer); }
    if (this.serverTimer) { clearInterval(this.serverTimer); }
    if (this.inputTimer) { clearInterval(this.inputTimer); }
    this.closeKeyboard();
    if (this._textEditHandler) {
      var g = getGM();
      if (g && g.textEditFinished && g.textEditFinished.off) {
        g.textEditFinished.off(this._textEditHandler);
      }
      this._textEditHandler = null;
    }
  }
};
</script>

<style>
.container { display: flex; flex-direction: column; padding: 16px; background-color: #1a1a2e; min-height: 100vh; }
.title { font-size: 32px; color: #e0e0e0; text-align: center; margin-bottom: 12px; font-weight: bold; }
.section { margin-bottom: 12px; }
.label { font-size: 20px; color: #8888aa; margin-bottom: 6px; }
.input { width: 100%; height: 52px; background-color: #2a2a3e; color: #ffffff; font-size: 20px; border-radius: 6px; padding: 0 12px; }
.nav-row { display: flex; flex-direction: row; align-items: center; margin-bottom: 6px; }
.nav-input { flex: 1; height: 52px; background-color: #2a2a3e; color: #ffffff; font-size: 20px; border-radius: 6px; padding: 0 12px; margin-right: 6px; }
.status-bar { display: flex; flex-direction: row; justify-content: space-around; padding: 10px; background-color: #2a2a3e; border-radius: 6px; margin-bottom: 8px; }
.status-item { display: flex; flex-direction: row; align-items: center; min-width: 100px; }
.status-text { font-size: 20px; color: #ccc; }
.status-dot { width: 14px; height: 14px; border-radius: 7px; margin-right: 6px; }
.dot-green { background-color: #4caf50; }
.dot-red { background-color: #f44336; }
.button-row { display: flex; flex-direction: row; justify-content: space-between; margin-bottom: 4px; }
.btn { display: flex; align-items: center; justify-content: center; border-radius: 8px; }
.btn-start { flex: 1; background-color: #4caf50; height: 60px; margin-right: 4px; }
.btn-stop { flex: 1; background-color: #f44336; height: 60px; margin-left: 4px; }
.btn-stream { flex: 1; background-color: #2196f3; height: 44px; margin-right: 2px; }
.btn-touch { flex: 1; background-color: #ff9800; height: 44px; margin-right: 2px; }
.btn-stop-stream { flex: 1; background-color: #607d8b; height: 44px; margin-right: 2px; }
.btn-stop-touch { flex: 1; background-color: #795548; height: 44px; margin-left: 2px; }
.btn-go { background-color: #2196f3; height: 52px; width: 80px; margin-left: 4px; }
.btn-refresh { background-color: #009688; height: 52px; width: 80px; margin-left: 4px; }
.btn-quick { flex: 1; background-color: #3f51b5; height: 40px; margin-right: 2px; }
.btn-back { flex: 1; background-color: #607d8b; height: 40px; margin-right: 2px; }
.btn-fwd { flex: 1; background-color: #607d8b; height: 40px; margin-left: 2px; }
.btn-sm { width: auto; }
.btn-xs { width: auto; }
.btn-text { font-size: 22px; color: #ffffff; }
.btn-text-sm { font-size: 18px; color: #ffffff; }
.btn-text-xs { font-size: 16px; color: #ffffff; }
.log-box { background-color: #0a0a1a; border-radius: 6px; padding: 10px; height: 160px; overflow: hidden; }
.log-text { font-size: 16px; color: #88cc88; font-family: monospace; }
</style>