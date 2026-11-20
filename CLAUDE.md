# CLAUDE.md

Quiz AI Helper — 浏览器扩展 (Manifest V3，基于 [WXT](https://wxt.dev) 构建：Chrome/Edge/Opera/Brave + Firefox)，加载参考文档后 AI 根据页面题目自动作答。

## 构建

- `npm install` 后：`npm run dev`（热重载开发，`dev:firefox` 同理）/ `npm run build`（→ `.output/chrome-mv3`）/ `npm run build:firefox`（→ `.output/firefox-mv3`）/ `npm run zip[:firefox]`（商店包）
- **没有手写 manifest.json**：由 `wxt.config.js` 生成；content script 的 matches/allFrames/runAt 在 `entrypoints/content/index.js` 的 `defineContentScript()` 里。Firefox 专属字段（`browser_specific_settings.gecko.id`）在 config 里按 `browser` 条件添加
- 版本号只在 `package.json` 改
- 许可证 GPL-3.0（根目录 `LICENSE`，`package.json` 的 `license: GPL-3.0-only`）；`wxt.config.js` 的 `build:publicAssets` hook 把 `LICENSE` 复制进每个构建产物，不要在 `public/` 再放一份
- CI（`.github/workflows/ci.yml`）：push main / PR 时构建 Chrome + Firefox zip、跑 `npm run lint:firefox`（web-ext lint，只有 error 才失败），zip 作为 artifact 上传
- 发布（`.github/workflows/release.yml`）：推 `v*` tag 触发，tag 必须等于 `v` + package.json 版本，否则失败；产出 chrome / firefox / edge / sources zip 并创建 GitHub Release。商店上传仍手动
- `npm run dev` 不自动开浏览器（`wxt.config.js` 里 `webExt.disabled`，也没装 `web-ext`）：在自己的 Chrome 里加载一次 `.output/chrome-mv3-dev`，之后改代码会自动重建并重载
- 改完代码要重新构建（或开着 `npm run dev`），浏览器加载的是 `.output/` 而不是源码目录

## 项目结构

- `README.md`（英文，默认）/ `README.zh-CN.md`（中文）— 顶部互链，改一份时同步另一份
- `entrypoints/background.js` — `defineBackground()`：`CAPTURE_TAB` 截图 / `API_REQUEST` 请求代理 / `INJECT_LIB` 按需注入库 / `FETCH_BINARY` 二进制下载
- `entrypoints/content/` — 内容脚本，打包成单个 `content-scripts/content.js` + `.css`
  - `index.js` — 入口：`defineContentScript()` + 导入 `style.css`，调用 `main()`
  - `main.js` — `export function main()`：UI 面板、答题逻辑、域名门控、配置管理（整个函数体即原来的 IIFE）
  - `i18n.js` — `export const I18N`（中/英词典）
  - `icons.js` — logo / 线性图标 SVG 及 `icon()` / `chip()` / `groupTitle()` / `fileTone()` 助手，ES module 导出
  - `style.css` — 面板全部样式；选择器一律以 `#qah-btn` / `#qah-panel` 限定，避免污染宿主页面
- `public/` — 原样复制到构建产物根目录（路径不变）：`_locales/`、`lib/`、`images/`
- `public/images/icons/` — 扩展图标（16/32/48/128），由 `icons.js` 里的 `LOGO_SVG` 渲染而来；改 logo 时同步重新导出。logo 动画纯 CSS（`style.css` 里 `.qah-logo` 规则）：待机星光闪烁 / hover 弹出 / `setLogoThinking()` 在 `askAI()` 期间让金色圆点扫描选项，结束时落定打勾
- `docs/screenshots/` — README 截图（不打包进扩展）
- 配色「墨蓝 + 金盏黄」：CSS 变量定义在 `style.css` 的 `#qah-btn,#qah-panel{--qah-*}`（`--qah-ink` #1F2A44 主色 / `--qah-gold` #F2A93B 强调 / `--qah-paper` #FBF7EF 纸色），组件里不要写裸 hex；辅助色 teal/blue/violet/coral（各带 `-soft` 底色）只用于图标色块
- 明/暗配色：`config.theme`（auto/light/dark，auto 跟随 `prefers-color-scheme`）→ `applyTheme()` 给 `#qah-btn` / `#qah-panel` 设 `data-theme`，`style.css` 的 `[data-theme=dark]` 块只覆盖 `--qah-*` 变量。暗色下 `--qah-ink` 翻成浅色（标题/主按钮），logo 底色用 `--qah-brand`（始终墨蓝）；新增颜色必须两套都定义
- 图标：`ICON_PATHS` + `icon(name)` / `chip(name, tone)` / `groupTitle()`（`icons.js`），线性图标 stroke=currentColor，不用 emoji
  - SVG 有意内联在 `icons.js` 里，**不要拆成 .svg 文件**：`<img>` 引用会让 `currentColor` 变色和 logo 的 CSS 动画失效；运行时 fetch 会变成异步，与面板同步挂载冲突，还得加进 `web_accessible_resources`，网页就能探测到扩展
- `public/lib/` — pdf.js / marked / mammoth，**不经过打包、按需注入**（不在 content script bundle 里），通过 `chrome.scripting.executeScript({files:['lib/…']})`（ISOLATED world，与 content script 共享全局）；放 `public/` 是为了让运行时路径保持 `lib/xxx.js`

## 关键约定

- 配置 key `qah_config`：开启「跨设备同步」时存 `chrome.storage.sync`，否则存 `chrome.storage.local`；开关是每台设备独立的（local key `qah_sync`），读写一律走 `configArea()` / `saveConfigToStorage()`，不要直接调 `storage.local`。首次打开时若 sync 里已有配置会自动跟随开启；sync 单 key 上限 8KB，文档等大数据不能进配置。`storage.onChanged` 监听其他标签页 / 设备的修改后 `renderAll()` + `applyDomainGate()`。storage 回调是异步的，加载后需重新渲染 + `applyDomainGate()`
- panel/btn 必须**同步挂载**到 DOM（后续大量 `document.getElementById` 依赖），域名门控只控制 `btn.style.display`，不挂/卸 DOM
- 重渲染 tab 时注意保留 `#qah-load-status` 等状态信息，不要静默吞掉错误
- 扫描结果同理：`renderDocsTab()` 每次重建都会把 `#qah-scan-result` 清空，故扫描列表持久化在 `lastScanUrls`（+ `loadedScanUrls` 记录已加载项）里，由 `renderScanResult()` 在每次重渲染末尾回填；加载一个 PDF 后其余项不能消失。`loadUrl()` 返回 boolean 供此判断
- 跨域 iframe 里的 PDF：content script `allFrames:true`，子 frame 静默运行（`main()` 最前面早退，不建任何 UI/storage 回调），顶层通过 `postMessage` 中继逐层汇总（`scanAllFrames` / `relayScanToChildren`）
- 后台代理的库注入有白名单（`ALLOWED_LIBS`），新增库要同步改
- i18n（中/英）：所有面板文案和提示词都在 `entrypoints/content/i18n.js`（`I18N.zh` / `.en`）里，用 `t(key, ...args)` 读取（占位符 `{0}`）；新增文案必须两套同时加。`config.language`（auto/zh/en）决定界面和提示词语言，auto 按 `navigator.language` 判断；`config.answerLang`（question/ui/zh/en）决定 AI 回答语言，默认跟随题目。切换语言走 `renderAll()`（会保留已输入的题目和答案）。商店名称/描述在 `public/_locales/*/messages.json`，`wxt.config.js` 用 `__MSG_*__` 引用
- AI 服务商两种：`openai`（兼容任意 `/chat/completions` 端点）和 `anthropic`（原生 Messages API）
- 面板标签：答题 / 文档 / **AI**（`renderAiTab()`：服务商、Base URL、Key、模型、回答语言）/ 设置（`renderConfigTab()`：界面语言、生效域名、快捷键、同步）/ 支持。AI 和设置各有保存按钮，都调 `saveConfig(statusId)`；`collectConfigFields()` 会同时读两个标签的输入框（隐藏的标签仍在 DOM 中），所以任一保存都会保存全部

## TODO / Feature Ideas

### Jev (TypeSafe AI) 选择题模式 — 已确认可做，暂缓

- 背景：https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev 是 "System One" 模型：不生成文本，输出预定义 schema 的类型化决策 + 校准概率；70-500ms 响应，$0.042/MTok，输出免费；最多 255 个选项；**不支持图像输入**（early access 阶段）
- 用户已有 early access 权限
- 设想功能：新增 provider「选择题快速模式」——输入题目文本 + 选项 + 文档摘录，返回 `{answer: "B", confidence: 0.93}`，UI 显示答案和置信度而非 Markdown 解析
- 混合方案：视觉 LLM 从截图提取题目文字 → Jev 做选择（把慢而贵的部分最小化）
- 实现要点：
  - API 是 TypeSafe 私有格式（非 OpenAI 兼容），集成前先看 https://typesafe.ai/docs
  - 复用 `entrypoints/background.js` 的 `API_REQUEST` 代理管道
  - `entrypoints/content/main.js` 加 provider 分支 + 设置项（API key）

### 其他

- [ ] 暂无
