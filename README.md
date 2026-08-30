# ☁️ CloudBrowser — 词典笔云浏览器

> 在词典笔（Rockchip 嵌入式 Linux 设备）上远程浏览网页：真实 Chrome 在服务器渲染，H.264 串流回词典笔屏幕，触摸事件回传到服务器控制页面。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D16-green)

---

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 🖥️ **远程浏览器** | 服务器跑真实 Chrome（headless），960×266 横屏视口 |
| 📺 **低延迟串流** | H.264 MPEG-TS：服务器背压丢帧 + 设备丢帧队列 + NV12 硬解直通 + TCP 裸流 |
| 👆 **触控回传** | 设备触摸屏 → TCP → Chrome CDP 合成触摸事件（含校准） |
| ⌨️ **系统输入法联动** | 网页输入框聚焦 → 自动弹设备系统输入法 → 确认回填网页（支持跨域 iframe） |
| 🔍 **搜索兜底** | headless Chrome 合成事件不触发 submit 时，手动 requestSubmit 兜底 |
| 🧭 **导航** | 前进 / 后退 / 刷新 / URL 跳转 |
| 📱 **Mobile UA** | 默认移动端 UA，网页正常渲染可交互 |

## 🏗️ 架构

```
┌─────────────────────┐         ┌──────────────────────────────┐
│  词典笔 (Rockchip)   │         │  服务器 (Linux + Node.js)     │
│                     │  TCP    │                              │
│  gst-launch 解码显示 │◄────────│  ffmpeg 单例 (H.264编码)     │
│  touch_back 触控采集 │────────►│  Node.js + Playwright        │
│  miniapp (Falcon)   │◄──HTTP──│  Chrome CDP (真实浏览器)     │
│  UI / 输入法联动     │  8088   │                              │
└─────────────────────┘         └──────────────────────────────┘
       960×266 横屏                    YOUR_SERVER_IP (示例)
```

### 端口
| 端口 | 用途 |
|---|---|
| **8088** | HTTP 控制：串流 / 导航 / 触控 / 输入法 / 调试 |
| **8089** | TCP 触控协议（设备 touch_back → 服务器） |
| **8090** | H.264 裸 TS 流（设备 gst tcpclientsrc 拉流） |

## 📦 目录结构

```
cloud-browser/
├── server/
│   └── server.js          # 服务器端（Node.js + Playwright + ffmpeg）
├── device/
│   ├── index.vue          # 词典笔 miniapp 设备端（Falcon 框架）
│   └── touch_back.c       # 触控回传程序源码（C，设备端运行）
└── release/
    └── cloud-browser_v1.2.8.amr   # 设备端安装包（miniapp）
```

## 🚀 快速开始

### 1. 服务器端

```bash
# 依赖
apt install -y ffmpeg
npm install playwright
npx playwright install chromium

# 启动（需 root，headless Chrome 需要 --no-sandbox）
node server/server.js
```

默认监听 8088 端口，浏览器打开 `http://服务器IP:8088/` 即可看到实时画面调试页。

> 如需换端口：`PORT=8088 node server.js`

### 2. 设备端

**硬件前提**：支持 Falcon miniapp 框架的词典笔（Rockchip + Linux + /dev/input 触摸）。

1. 修改 `device/index.vue` 里的 `serverHost` 为你服务器的 IP
2. 用 Falcon CLI 打包：`aiot-cli build:prod` → zip `.falcon_/` 为 `.amr`
3. 安装到设备：`miniapp_cli install cloud-browser.amr` → **重启设备**
4. 修改 `device/touch_back.c` 的 `SERVER_HOST` → 交叉编译 → 设备上运行
5. 设备端串流管道（gst-launch）：

```bash
gst-launch-1.0 -q tcpclientsrc host=SERVER_IP port=8090 \
  ! tsdemux ! h264parse ! queue max-size-time=40000000 leaky=downstream \
  ! mppvideodec ! videoflip video-direction=90l \
  ! kmssink plane-id=76 driver-name=rockchip sync=false
```

## 🛠️ HTTP API

| 端点 | 说明 |
|---|---|
| `/stream.mjpeg` | MJPEG 实时流（浏览器调试用） |
| `/stream.h264` | H.264 MPEG-TS 流（HTTP 方式） |
| `/status.json` | 状态：fps / viewport / 帧延迟 |
| `/nav?url=` `/back` `/forward` `/refresh` | 导航 |
| `/touch?event=start\|move\|end&x=&y=` | HTTP 触控 |
| `/input-status` | 网页输入框焦点状态（miniapp 轮询） |
| `/input-submit?text=` | 向聚焦的网页输入框填文字 |
| `/calib-start` `/calib-clear` | 触控校准红点 |
| `/debug-page` `/debug-frames` `/debug-element` | 调试工具 |

## ⚙️ 关键优化（踩坑记录）

1. **screencast 静止停帧** → `forceFrame()`：触摸瞬间主动截图，绕过恢复延迟
2. **奇数宽度 333×266 编码失败** → `scale+pad` 强制归一 960×266
3. **编码积压延迟累积** → ffmpeg stdin 背压：满了丢帧不排队
4. **设备缓冲** → gst `queue max-size-time=40ms leaky=downstream` 丢最旧帧
5. **headless Chrome 不触发 submit** → touchEnd 时 elementFromPoint 找按钮手动 `requestSubmit()`
6. **跨域 iframe 输入框检测不到** → 遍历 `page.frames()` 逐帧检测 activeElement
7. **CPU 转码开销** → 去 videoconvert，NV12 硬解直通 kmssink

## 📄 License

[MIT](./LICENSE) © 2026

## 🙏 致谢

- [Playwright](https://playwright.dev/) — 浏览器自动化
- FFmpeg / GStreamer — 音视频处理
