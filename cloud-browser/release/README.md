# Release — v1.2.8

> 延迟优化二档全完成版本（NV12 直通 + TCP 裸流 + queue 40ms），设备端已实测可用。

## 📦 安装包

| 文件 | 说明 |
|---|---|
| `cloud-browser_v1.2.8.amr` | 词典笔 miniapp 安装包（Falcon 框架） |

## 🔧 安装方法

```bash
# 设备 adb 连接后：
adb push cloud-browser_v1.2.8.amr /tmp/
adb shell 'miniapp_cli install /tmp/cloud-browser_v1.2.8.amr'
# ⚠️ 安装后必须重启设备（miniapp 进程重启才会加载新版）
```

## ⚙️ 此版本包含

- 低延迟三件套：服务器背压丢帧 / 设备 queue 40ms / NV12 硬解直通
- TCP 8090 裸流拉流（tcpclientsrc）
- 输入法联动（网页输入框 → 系统输入法，含跨域 iframe）
- Mobile UA + 搜索提交兜底
- 触控校准（/calib-start）

## ⚠️ 注意

- **serverHost 已脱敏**：安装前请将 `device/index.vue` 中的 `YOUR_SERVER_IP` 替换为你的服务器地址后重新打包
- 设备仅 1GB 内存，miniapp 基线占用 ~420MB，请勿开启过多后台服务