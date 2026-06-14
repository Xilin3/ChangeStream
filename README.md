# ChangeStream - B站直播间画面替换

将当前B站直播间画面替换为另一个直播间的视频流，保留原直播间的弹幕和控制栏。

## 安装

### 方式一：下载 Release（推荐）

1. 前往 [Releases](../../releases) 页面，下载最新版本的 `ChangeStream-vX.X.X.zip`
2. 解压 zip 到任意文件夹
3. 打开 Chrome/Edge，地址栏输入 `chrome://extensions/`（Edge 输入 `edge://extensions/`）
4. 开启右上角「**开发者模式**」
5. 点击「**加载已解压的扩展程序**」，选择解压后的文件夹

### 方式二：从源码安装

```bash
git clone https://github.com/YOUR_USERNAME/ChangeStream.git
```

然后按方式一的第 3-5 步操作，选择克隆下来的目录即可。

## 使用方法

1. 打开任意 B站直播间页面
2. 点击浏览器工具栏中的插件图标
3. 输入目标直播间 ID（如 `21652717`）或完整 URL
4. 点击「**替换画面**」
5. 需要恢复时点击「**恢复原始画面**」

## 功能特点

- 画质选择：蓝光 / HEVC原画 / HDR原画 / AV1原画
- 延迟控制：可设置 0-60 秒延迟，带缓冲进度显示
- 保留弹幕：新视频叠在原位，弹幕层自然覆盖
- 小窗原画面：可同时显示原直播间小窗口用于对比
- 自动记忆：刷新页面后自动恢复替换状态

## 打包（开发者）

```powershell
./build.ps1 -Version 1.0.0
```

生成的 zip 在 `dist/` 目录下，可直接上传到 GitHub Release。

## 文件说明

| 文件 | 说明 |
|------|------|
| `manifest.json` | 扩展配置 |
| `popup.html/js` | 弹窗界面 |
| `content.js/css` | 核心逻辑，运行在B站页面中 |
| `mse-delay.js` | MSE 延迟控制器 |
| `background.js` | 后台脚本 |
| `lib/flv.min.js` | flv.js 库 |

## 注意事项

- 目标直播间需要正在直播才能显示画面
- 延迟功能依赖 HLS fmp4 流，部分画质可能不支持
- 仅用于画面对比观看，请勿用于违规用途
