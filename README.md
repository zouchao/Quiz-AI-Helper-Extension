# Quiz AI Helper - AI 做题助手

一个 Chrome 扩展（Manifest V3）：加载参考文档后，AI 理解文档内容并根据页面上的题目自动作答。支持截图识题、多种文档格式，可接入 OpenAI / Anthropic 或任意兼容 API。

## 功能特性

- 📄 **参考文档问答** — 加载 PDF / DOCX / TXT / Markdown 文档（本地文件或 URL），AI 基于文档内容作答
- 📸 **截图作答** — 一键截取当前页面，或 `Ctrl+V` 粘贴剪贴板截图，由视觉模型识别题目并作答
- 🆓 **无文档模式** — 不依赖参考资料，直接让 AI 回答页面题目
- 🤖 **多模型支持**
  - OpenAI 及任意兼容 API（可自定义 Base URL 和模型，默认 `gpt-4o`）
  - Anthropic Claude（默认 `claude-sonnet-4`）
- ⌨️ **可自定义快捷键** — 默认 `Alt+Q` 开关面板、`Alt+A` 截图作答，修改后即时生效
- 💬 **富文本回答** — 支持 Markdown 渲染、代码高亮显示
- 🔒 **密钥本地存储** — API Key 仅保存在浏览器 `chrome.storage` 本地，不上传任何服务器

## 安装

1. 克隆或下载本仓库：

   ```bash
   git clone https://github.com/zouchao/Quiz-AI-Helper-Extension.git
   ```

2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择本仓库目录

## 使用

1. 打开目标页面，点击右下角 🤖 悬浮按钮（或按 `Alt+Q`）打开面板
2. 在 **设置** 标签中填入你的 API Key（OpenAI 或 Anthropic），选择模型
3. 在 **文档** 标签中加载参考资料（可选）
4. 在 **答题** 标签中：
   - 点击 **截图作答** 或 `Ctrl+V` 粘贴截图，也可以手动输入题目
   - 点击 **AI 作答** 获取答案

## 注意事项

- 内容脚本的注入范围在 `manifest.json` 中通过 `include_globs` 做了限制（当前为 `https://develop.*.com/*`）。如需在其他网站使用，请修改 `content_scripts` 中的 `matches` / `include_globs` 后重新加载扩展。
- 截图功能需要当前标签页处于激活状态。
- 使用视觉模型（如 `gpt-4o`）才能识别截图中的题目。

## 项目结构

```
├── manifest.json      # 扩展配置（Manifest V3）
├── content.js         # 内容脚本：UI 面板、答题逻辑
├── background.js      # Service Worker：截图、API 请求代理
├── lib/               # 第三方库（pdf.js / marked / mammoth）
├── images/            # 图片资源
├── icon48.png         # 扩展图标
└── icon128.png
```

## 支持

如果这个项目对你有帮助，欢迎请作者喝杯咖啡 ☕（面板内 **支持** 标签）。

## 作者

Sean Zou ([zouchao2008@gmail.com](mailto:zouchao2008@gmail.com))
