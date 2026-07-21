# 雪花膏 · XUEHUAGAO

> 拥有完整人格、视觉场景与声音沉浸的 AI 陪伴应用 —— 让对话从「回答问题」变成「有人坐在对面陪你」。

原「Lumi · 鹿米」项目 v2.0：全量改名「雪花膏」+ 整体升级。

## 项目结构

```
xuehuagao-app/
├── server.js                  # Express 后端 · v2 人格编排管线（7 步 Pipeline）
├── package.json
└── public/
    ├── index.html             # Galgame 风格单页前端（自包含，无构建步骤）
    ├── audio-immersion.js     # 沉浸音频模块（Web Audio，场景交叉淡入淡出）
    ├── xuehuagao.png          # 大立绘 / 头像
    ├── scenes/                # 4 张全屏场景背景
    │   └── normal / thinking / rainy / cafe .png
    └── audio/                 # 8 个音频资产
        ├── opening_enter.mp3        # 开屏音
        ├── ui_message_send.wav      # 发送音效
        ├── ui_message_receive.wav   # 接收音效
        ├── scene_switch_soft.wav    # 场景转场音
        └── normal_room / cafe_ambient / rainy_window / thinking_night _loop.mp3
```

## 本地运行

```bash
cd xuehuagao-app
npm install
npm run dev          # 默认 3000 端口；PORT=8080 npm run dev 可指定
```

打开 http://localhost:3000

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `LLM_API_KEY` | 模型 API Key | 回退 `KIMI_API_KEY`，两者都无则启用角色化兜底回复 |
| `LLM_BASE_URL` | 模型接口地址 | 回退 `KIMI_BASE_URL` → `https://api.kimi.com/coding/v1` |
| `XUEHUAGAO_MODEL` | 模型名（兼容旧名 `LUMI_MODEL`） | `kimi-k2-turbo-preview` |

> 没有可用 Key 时应用不会崩溃：雪花膏会以角色化兜底语句回应（优雅降级 + 3 次重试）。

## API

- `POST /api/chat` — body `{ "message": "...", "history": [{role, content}] }` → `{ reply, scene }`
- `GET /api/health` → `{ ok, model, version }`

## v2.0 升级清单

**后端**：安全响应头 · 请求日志 · 输入校验 · LLM 失败优雅降级与重试 · 静态资源缓存策略（媒体 immutable / HTML no-cache）· 优雅关闭 · 密钥解析链
**前端**：移动端适配与安全区 · 消息时间戳 · 失败重试按钮 + 30s 超时 · 打字中动画 · textarea 自动增高 + 中文输入法合成保护 · 场景图预加载 · 全套 aria/键盘可访问性 · `prefers-reduced-motion` 降级 · 品牌区实时场景名
**音频**：首次手势自动解锁 + 解锁前请求补播 · 场景环境音 350/500ms 交叉淡入淡出（防叠音泄漏）· 分组音量 API（master/ambient/sfx）+ localStorage 持久化 · 加载失败静默降级重试

## 部署上线

这是一个普通 Node.js 应用，可部署到任何支持 Node ≥18 的平台：

**Railway / Render / Fly.io（推荐，免费档可用）**
1. 把 `xuehuagao-app/` 推到一个 Git 仓库
2. 在平台新建服务，Root Directory 指向该目录
3. Build：`npm install`，Start：`npm start`
4. 在平台环境变量里配置 `LLM_API_KEY` / `LLM_BASE_URL`

**自有 VPS**
```bash
npm install --omit=dev
PORT=80 LLM_API_KEY=sk-... nohup npm start &
# 建议前面再套一层 Caddy/Nginx 做 HTTPS
```

**mulerun（原部署方式）**：按 mulerun 文档上传本目录即可，入口 `server.js`。

> 注意：`xuehuagao.png` 与 `scenes/*.png` 单张约 2MB，如部署到按流量计费平台可自行压缩。
