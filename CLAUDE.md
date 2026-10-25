# CLAUDE.md

Quiz AI Helper — Chrome 扩展 (Manifest V3)，加载参考文档后 AI 根据页面题目自动作答。

## 项目结构

- `manifest.json` — MV3 配置；content script 注入所有 HTTPS 页面，只注入 `content.js`
- `i18n.js` — 中/英词典（全局 `QAH_I18N`），先于 `content.js` 注入
- `content.js` — 单文件 IIFE：UI 面板、答题逻辑、域名门控、配置管理
- `background.js` — Service Worker：`CAPTURE_TAB` 截图 / `API_REQUEST` 请求代理 / `INJECT_LIB` 按需注入库 / `FETCH_BINARY` 二进制下载
- `lib/` — pdf.js / marked / mammoth，**按需注入**（不在 content_scripts 中），通过 `chrome.scripting.executeScript`（ISOLATED world，与 content script 共享全局）

## 关键约定

- 配置存于 `chrome.storage.local`（key: `qah_config`）；storage 回调是异步的，加载后需 `renderConfigTab()` 重新渲染 + `applyDomainGate()`
- panel/btn 必须**同步挂载**到 DOM（后续大量 `document.getElementById` 依赖），域名门控只控制 `btn.style.display`，不挂/卸 DOM
- 重渲染 tab 时注意保留 `#qah-load-status` 等状态信息，不要静默吞掉错误
- 扫描结果同理：`renderDocsTab()` 每次重建都会把 `#qah-scan-result` 清空，故扫描列表持久化在 `lastScanUrls`（+ `loadedScanUrls` 记录已加载项）里，由 `renderScanResult()` 在每次重渲染末尾回填；加载一个 PDF 后其余项不能消失。`loadUrl()` 返回 boolean 供此判断
- 跨域 iframe 里的 PDF：content script `all_frames:true`，子 frame 静默运行（IIFE 最前面早退，不建任何 UI/storage 回调），顶层通过 `postMessage` 中继逐层汇总（`scanAllFrames` / `relayScanToChildren`）
- 后台代理的库注入有白名单（`ALLOWED_LIBS`），新增库要同步改
- i18n（中/英）：所有面板文案和提示词都在 `i18n.js`（`window.QAH_I18N.zh` / `.en`，manifest 里先于 `content.js` 注入）里，用 `t(key, ...args)` 读取（占位符 `{0}`）；新增文案必须两套同时加。`config.language`（auto/zh/en）决定界面和提示词语言，auto 按 `navigator.language` 判断；`config.answerLang`（question/ui/zh/en）决定 AI 回答语言，默认跟随题目。切换语言走 `renderAll()`（会保留已输入的题目和答案）。商店名称/描述在 `_locales/*/messages.json`，`manifest.json` 用 `__MSG_*__` 引用
- AI 服务商两种：`openai`（兼容任意 `/chat/completions` 端点）和 `anthropic`（原生 Messages API）

## TODO / Feature Ideas

### Jev (TypeSafe AI) 选择题模式 — 已确认可做，暂缓

- 背景：https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Jev 是 "System One" 模型：不生成文本，输出预定义 schema 的类型化决策 + 校准概率；70-500ms 响应，$0.042/MTok，输出免费；最多 255 个选项；**不支持图像输入**（early access 阶段）
- 用户已有 early access 权限
- 设想功能：新增 provider「选择题快速模式」——输入题目文本 + 选项 + 文档摘录，返回 `{answer: "B", confidence: 0.93}`，UI 显示答案和置信度而非 Markdown 解析
- 混合方案：视觉 LLM 从截图提取题目文字 → Jev 做选择（把慢而贵的部分最小化）
- 实现要点：
  - API 是 TypeSafe 私有格式（非 OpenAI 兼容），集成前先看 https://typesafe.ai/docs
  - 复用 background.js 的 `API_REQUEST` 代理管道
  - content.js 加 provider 分支 + 设置项（API key）

### 其他

- [ ] 暂无
