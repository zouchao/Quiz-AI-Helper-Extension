(function() {
    'use strict';

    // ===== Subframe mode =====
    // In iframes we run headless: no UI, but we answer scan requests from the
    // top frame via postMessage so cross-origin iframe PDFs are discoverable.
    // Must be the very first thing — everything below assumes the top frame
    // (storage callbacks, renderConfigTab, DOM attach).
    if (window.top !== window) {
        window.addEventListener('message', (e) => {
            const d = e.data;
            if (!d || d.qahScan !== 'req' || !e.source) return;
            const own = scanEmbeddedPdfs(document);
            relayScanToChildren(d.nonce).then(extra => {
                try { e.source.postMessage({ qahScan: 'res', nonce: d.nonce, urls: own.concat(extra) }, '*'); } catch(err) {}
            });
        });
        return;
    }

    // ===== State =====
    let screenshotBase64 = null;
    let pdfDocs = []; // [{name, text}] - stores all document types
    let noDocMode = false;
    let lastScanUrls = [];        // survives re-render so you can load several PDFs from one scan
    let loadedScanUrls = new Set(); // scanned URLs already loaded, shown as ✓ Loaded
    let config = Object.assign({
        provider: 'openai',
        apiKey: '',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        anthropicKey: '',
        anthropicBaseUrl: 'https://api.anthropic.com',
        anthropicModel: 'claude-sonnet-4-20250514',
        hotkeyToggle: 'Alt+Q',
        hotkeyScreenshot: 'Alt+A',
        allowedDomains: '',
        language: 'auto',      // 'auto' | 'zh' | 'en' (UI + prompt language)
        answerLang: 'question' // 'question' | 'ui' | 'zh' | 'en'
    }, {});

    // ===== i18n =====
    const I18N = {
        zh: {
            tabAnswer: '答题', tabDocs: '文档', tabConfig: '设置', tabSupport: '支持',
            docsLoaded: '已加载 {0} 个文档', pagesSuffix: ', {0} 页',
            btnScreenshot: '截图作答', btnAsk: 'AI 作答',
            noDoc: '不依赖文档 (AI 根据自身知识回答)',
            needDocsWarn: '⚠️ 请先在「文档」标签加载参考资料，或勾选「不依赖文档」',
            hint: '点击「截图作答」或直接 Ctrl+V 粘贴截图，也可在下方手动输入题目',
            clearShot: '清除截图',
            questionLabel: '题目 / 问题 (可手动编辑，截图模式下可留空)',
            questionPh: '在此输入题目内容...',
            loadedMark: '✓ 已加载', load: '加载', del: '删除',
            pagesUnit: '{0}页', chunksUnit: '{0}段', noDocs: '暂无文档',
            uploadLabel: '上传文件 (支持 PDF、Word、TXT、Markdown，可多选)',
            urlLabel: '或输入链接 (支持网页和PDF链接，自动识别)',
            urlPh: 'https://example.com/page 或 .pdf 链接',
            scanLabel: '或扫描页面内嵌 PDF (iframe / embed / 页面链接)',
            scanBtn: '扫描当前页面',
            loadedDocs: '已加载文档:',
            scanNone: '未检测到内嵌 PDF。若 PDF 在 iframe 中，请等页面完全加载后重试，或手动粘贴链接。',
            langLabel: '界面语言 / Language',
            langAuto: '自动 (跟随浏览器)',
            answerLangLabel: 'AI 回答语言',
            answerQuestion: '跟随题目语言 (推荐)',
            answerUi: '跟随界面语言',
            providerLabel: 'AI 服务商',
            openaiOpt: 'OpenAI 兼容 (OpenAI/DeepSeek/Groq/本地等)',
            domainsLabel: '生效域名 (每行一个或逗号分隔，支持 * 通配符，留空 = 所有网站)',
            domainsPh: '例如:&#10;develop.*.com&#10;*.example.com',
            hotkeyTitle: '快捷键设置 (修改后即时生效)',
            hotkeyToggle: '打开/关闭面板', hotkeyShot: '截图',
            hotkeyTogglePh: '如 Alt+Q, Ctrl+Shift+K', hotkeyShotPh: '如 Alt+A, Ctrl+Shift+S',
            saveBtn: '保存设置', saved: '✓ 已保存',
            modelLabel: '模型', refreshPh: '-- 点击刷新加载 --', refreshBtn: '刷新列表',
            supportTitle: '觉得好用？请作者喝杯咖啡',
            supportText: '这个工具完全免费开源，如果它帮到了你，一杯咖啡就是最大的鼓励 :)',
            author: '作者: Sean Zou', contact: '联系: zouchao2008@gmail.com',
            needKey: '请先填写 API Key', loading: '加载中...', noModels: '未获取到模型', loadFailed: '加载失败',
            libFail: '组件加载失败: {0}', libNoEffect: '组件注入后未生效: {0} (请重新加载扩展)',
            parsing: '正在解析 {0}...', unsupported: '不支持的文件格式',
            fileDone: '✓ {0} 加载完成', fileFail: '✗ {0} 加载失败: {1}',
            downloading: '正在下载...', downloadFail: '下载失败', urlFail: '✗ 加载失败: {0}',
            shotOk: '✓ 截图已获取，点击「AI 作答」发送给AI',
            shotFail: '✗ 截图失败: {0}', unknown: '未知错误',
            pasteOk: '✓ 已从剪贴板粘贴截图，点击「AI 作答」发送给AI',
            errNoQuestion: '请先输入题目或截取屏幕',
            errNoDocs: '请先在「文档」标签加载参考资料，或勾选「不依赖文档」',
            errNoKey: '请先在「设置」中配置API Key',
            errNoAntKey: '请先在「设置」中配置Anthropic API Key',
            analyzing: 'AI 正在分析并作答...',
            docHeader: '===== 文档: {0} =====', pageMark: '[第{0}页]', truncated: '[...内容已截断...]',
            sysRole: '你是一个专业的考试助手。请根据你的知识回答用户的考试题目。',
            sysRoleDoc: '你是一个专业的考试助手。你的任务是根据提供的参考文档内容来回答用户的考试题目。',
            rulesTitle: '规则：',
            ruleExplain: '给出明确的答案，再简要说明理由',
            ruleReadDocs: '仔细阅读并理解所有参考文档内容',
            ruleDocAnswer: '根据文档内容精确回答问题，给出明确的答案',
            ruleDocFormat: '回答格式：先给出答案，再简要说明依据（引用文档中的具体条款或段落）',
            ruleChoice: '如果是选择题，明确指出正确选项',
            ruleTF: '如果是判断题(True/False)，明确给出True或False',
            ruleMatch: '如果是匹配题，给出所有正确的配对',
            ruleShot: '如果用户提供了屏幕截图，请从截图中识别题目内容并作答',
            ansQuestion: '用与题目相同的语言回答（题目是英文就用英文，是中文就用中文），选项原文保持不变',
            ansZh: '用中文回答', ansEn: '用英文回答 (Answer in English)',
            uDocs: '参考文档内容：\n{0}\n\n---\n',
            uAskDocs: '请根据以上参考文档回答以下题目：\n\n{0}',
            uAsk: '请回答以下题目：\n\n{0}',
            uShotDocs: '请根据以上参考文档，识别截图中的题目并作答：',
            uShot: '请识别截图中的题目并作答：',
            netFail: '网络请求失败', parseFail: '解析响应失败: {0}'
        },
        en: {
            tabAnswer: 'Answer', tabDocs: 'Docs', tabConfig: 'Settings', tabSupport: 'Support',
            docsLoaded: '{0} document(s) loaded', pagesSuffix: ', {0} pages',
            btnScreenshot: 'Screenshot', btnAsk: 'Ask AI',
            noDoc: 'No documents (AI answers from its own knowledge)',
            needDocsWarn: '⚠️ Load reference material in the "Docs" tab first, or tick "No documents"',
            hint: 'Click "Screenshot" or press Ctrl+V to paste one, or type the question below',
            clearShot: 'Clear screenshot',
            questionLabel: 'Question (editable; may be empty in screenshot mode)',
            questionPh: 'Type the question here...',
            loadedMark: '✓ Loaded', load: 'Load', del: 'Delete',
            pagesUnit: '{0} pp', chunksUnit: '{0} chunks', noDocs: 'No documents yet',
            uploadLabel: 'Upload files (PDF, Word, TXT, Markdown; multiple allowed)',
            urlLabel: 'Or enter a link (web page or PDF, auto-detected)',
            urlPh: 'https://example.com/page or a .pdf link',
            scanLabel: 'Or scan the page for embedded PDFs (iframe / embed / links)',
            scanBtn: 'Scan this page',
            loadedDocs: 'Loaded documents:',
            scanNone: 'No embedded PDF found. If it is inside an iframe, retry once the page has fully loaded, or paste the link manually.',
            langLabel: 'Language / 界面语言',
            langAuto: 'Auto (follow browser)',
            answerLangLabel: 'AI answer language',
            answerQuestion: 'Match the question (recommended)',
            answerUi: 'Match interface language',
            providerLabel: 'AI provider',
            openaiOpt: 'OpenAI-compatible (OpenAI/DeepSeek/Groq/local, etc.)',
            domainsLabel: 'Active domains (one per line or comma-separated, * wildcard supported, empty = all sites)',
            domainsPh: 'e.g.:&#10;develop.*.com&#10;*.example.com',
            hotkeyTitle: 'Hotkeys (apply immediately)',
            hotkeyToggle: 'Toggle panel', hotkeyShot: 'Screenshot',
            hotkeyTogglePh: 'e.g. Alt+Q, Ctrl+Shift+K', hotkeyShotPh: 'e.g. Alt+A, Ctrl+Shift+S',
            saveBtn: 'Save settings', saved: '✓ Saved',
            modelLabel: 'Model', refreshPh: '-- click Refresh to load --', refreshBtn: 'Refresh',
            supportTitle: 'Find it useful? Buy the author a coffee',
            supportText: 'This tool is free and open source. If it helped you, a coffee is the best encouragement :)',
            author: 'Author: Sean Zou', contact: 'Contact: zouchao2008@gmail.com',
            needKey: 'Please enter the API Key first', loading: 'Loading...', noModels: 'No models found', loadFailed: 'Load failed',
            libFail: 'Failed to load component: {0}', libNoEffect: 'Component injected but not active: {0} (reload the extension)',
            parsing: 'Parsing {0}...', unsupported: 'Unsupported file format',
            fileDone: '✓ {0} loaded', fileFail: '✗ Failed to load {0}: {1}',
            downloading: 'Downloading...', downloadFail: 'Download failed', urlFail: '✗ Load failed: {0}',
            shotOk: '✓ Screenshot captured. Click "Ask AI" to send it',
            shotFail: '✗ Screenshot failed: {0}', unknown: 'Unknown error',
            pasteOk: '✓ Screenshot pasted from clipboard. Click "Ask AI" to send it',
            errNoQuestion: 'Enter a question or take a screenshot first',
            errNoDocs: 'Load reference material in the "Docs" tab first, or tick "No documents"',
            errNoKey: 'Set your API Key in "Settings" first',
            errNoAntKey: 'Set your Anthropic API Key in "Settings" first',
            analyzing: 'AI is analyzing and answering...',
            docHeader: '===== Document: {0} =====', pageMark: '[Page {0}]', truncated: '[...content truncated...]',
            sysRole: 'You are a professional exam assistant. Answer the user\'s exam questions using your own knowledge.',
            sysRoleDoc: 'You are a professional exam assistant. Your task is to answer the user\'s exam questions based on the reference documents provided.',
            rulesTitle: 'Rules:',
            ruleExplain: 'Give a clear answer first, then briefly explain the reasoning',
            ruleReadDocs: 'Read and understand all of the reference documents carefully',
            ruleDocAnswer: 'Answer precisely based on the documents and give a definite answer',
            ruleDocFormat: 'Format: state the answer first, then briefly cite the basis (the specific clause or passage in the documents)',
            ruleChoice: 'For multiple-choice questions, state the correct option(s) explicitly',
            ruleTF: 'For True/False questions, answer explicitly True or False',
            ruleMatch: 'For matching questions, give all correct pairs',
            ruleShot: 'If the user provides a screenshot, identify the question in it and answer it',
            ansQuestion: 'Reply in the same language as the question (English question -> English, Chinese question -> Chinese); keep option text exactly as written',
            ansZh: '用中文回答 (Answer in Chinese)', ansEn: 'Answer in English',
            uDocs: 'Reference documents:\n{0}\n\n---\n',
            uAskDocs: 'Based on the reference documents above, answer the following question:\n\n{0}',
            uAsk: 'Answer the following question:\n\n{0}',
            uShotDocs: 'Based on the reference documents above, identify the question in the screenshot and answer it:',
            uShot: 'Identify the question in the screenshot and answer it:',
            netFail: 'Network request failed', parseFail: 'Failed to parse response: {0}'
        }
    };

    function uiLang() {
        if (config.language === 'zh' || config.language === 'en') return config.language;
        return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
    }

    function t(key, ...args) {
        const str = (I18N[uiLang()][key] !== undefined ? I18N[uiLang()][key] : I18N.en[key]) || key;
        return str.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? args[i] : m));
    }

    // Load config from chrome.storage
    chrome.storage.local.get('qah_config', (result) => {
        if (result.qah_config) Object.assign(config, result.qah_config);
        renderAll(); // re-render with loaded values (initial render runs before storage callback)
        applyDomainGate();
    });

    function saveConfigToStorage() {
        chrome.storage.local.set({ qah_config: config });
    }

    // ===== Styles =====
    const style = document.createElement('style');
    style.textContent = `
        #qah-btn{position:fixed;bottom:20px;right:20px;z-index:2147483647;width:54px;height:54px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;font-size:24px;cursor:pointer;box-shadow:0 4px 15px rgba(102,126,234,0.4);transition:transform .2s}
        #qah-btn:hover{transform:scale(1.1)}
        #qah-panel{position:fixed;top:50%;right:20px;transform:translateY(-50%);z-index:2147483646;width:560px;max-height:85vh;background:#fff;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,0.2);display:none;flex-direction:column;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#333;overflow:hidden}
        #qah-panel.show{display:flex}
        .qah-header{padding:14px 18px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}
        .qah-tabs{display:flex;border-bottom:1px solid #eee;background:#fafafa}
        .qah-tab{flex:1;padding:10px;text-align:center;cursor:pointer;font-size:12px;font-weight:500;border-bottom:2px solid transparent;transition:all .2s}
        .qah-tab.active{color:#667eea;border-bottom-color:#667eea;background:#fff}
        .qah-tab:hover{background:#f0f0ff}
        .qah-section{padding:14px 18px;overflow-y:auto;flex:1}
        .qah-field{margin-bottom:12px}
        .qah-field label{display:block;font-size:11px;font-weight:600;color:#555;margin-bottom:4px}
        .qah-field input,.qah-field select,.qah-field textarea{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:12px;outline:none;box-sizing:border-box}
        .qah-field input:focus,.qah-field textarea:focus{border-color:#667eea}
        .qah-btn{padding:8px 16px;border-radius:6px;border:none;background:#667eea;color:#fff;font-size:12px;cursor:pointer;font-weight:500}
        .qah-btn:hover{background:#5a6fd6}
        .qah-btn.danger{background:#ef4444}
        .qah-btn.secondary{background:#e5e7eb;color:#374151}
        .qah-btn.green{background:#10b981}
        .qah-pdf-item{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#f9fafb;border-radius:6px;margin-bottom:6px;font-size:12px}
        .qah-pdf-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .qah-pdf-item .meta{color:#888;margin:0 8px;font-size:11px}
        .qah-answer-box{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;margin-top:10px;line-height:1.8;font-size:13px}
        .qah-answer-box p{margin:0 0 8px}
        .qah-answer-box ul,.qah-answer-box ol{margin:4px 0;padding-left:20px}
        .qah-answer-box code{background:#e2e8f0;padding:1px 4px;border-radius:3px;font-size:12px}
        .qah-answer-box pre{background:#1e293b;color:#e2e8f0;padding:10px 12px;border-radius:6px;overflow-x:auto;font-size:12px}
        .qah-answer-box pre code{background:none;padding:0;color:inherit}
        .qah-answer-box strong{font-weight:600}
        .qah-answer-box.error{background:#fef2f2;border-color:#fecaca;color:#991b1b}
        .qah-loading{text-align:center;padding:20px;color:#667eea}
        .qah-loading::after{content:'';display:inline-block;width:16px;height:16px;border:2px solid #667eea;border-top-color:transparent;border-radius:50%;animation:qahspin 0.8s linear infinite;margin-left:8px;vertical-align:middle}
        @keyframes qahspin{to{transform:rotate(360deg)}}
        #qah-question-preview{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;max-height:120px;overflow-y:auto;line-height:1.6;color:#475569}
    `;
    document.head.appendChild(style);

    // ===== UI =====
    const btn = document.createElement('button');
    btn.id = 'qah-btn';
    btn.textContent = '\u{1F916}';
    btn.style.display = 'none'; // hidden until domain gate allows (avoids flash on disallowed sites)

    const panel = document.createElement('div');
    panel.id = 'qah-panel';
    panel.innerHTML = `
        <div class="qah-header">
            <div>Quiz AI Helper</div>
            <span style="cursor:pointer;font-size:20px" id="qah-close">&times;</span>
        </div>
        <div class="qah-tabs">
            <div class="qah-tab active" data-tab="answer">${t('tabAnswer')}</div>
            <div class="qah-tab" data-tab="docs">${t('tabDocs')}</div>
            <div class="qah-tab" data-tab="config">${t('tabConfig')}</div>
            <div class="qah-tab" data-tab="support">${t('tabSupport')}</div>
        </div>
        <div class="qah-section" id="qah-tab-answer"></div>
        <div class="qah-section" id="qah-tab-docs" style="display:none"></div>
        <div class="qah-section" id="qah-tab-config" style="display:none"></div>
        <div class="qah-section" id="qah-tab-support" style="display:none"></div>
    `;

    function getTopLayerContainer() {
        const dialog = document.querySelector('dialog[open]');
        if (dialog) return dialog;
        return document.body;
    }

    function attachUI() {
        const container = getTopLayerContainer();
        if (btn.parentElement !== container) {
            container.appendChild(btn);
            container.appendChild(panel);
        }
    }

    attachUI();

    // ===== Domain Gating =====
    let uiActive = false;

    function escapeRegExp(s) {
        return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }

    function hostAllowed() {
        const list = (config.allowedDomains || '')
            .split(/[\n,]/)
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);
        if (!list.length) return true; // empty = all sites
        const host = location.hostname.toLowerCase();
        return list.some(pattern => {
            const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
            return re.test(host);
        });
    }

    function applyDomainGate() {
        uiActive = hostAllowed();
        btn.style.display = uiActive ? '' : 'none';
        if (!uiActive) panel.classList.remove('show');
    }

    const uiObserver = new MutationObserver(() => attachUI());
    uiObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });

    btn.onclick = () => panel.classList.toggle('show');
    document.getElementById('qah-close').onclick = () => panel.classList.remove('show');

    const tabContainers = {
        answer: document.getElementById('qah-tab-answer'),
        docs: document.getElementById('qah-tab-docs'),
        config: document.getElementById('qah-tab-config'),
        support: document.getElementById('qah-tab-support')
    };
    const tabEls = panel.querySelectorAll('.qah-tab');
    let activeTab = 'answer';

    tabEls.forEach(t => {
        t.onclick = () => {
            tabEls.forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            activeTab = t.dataset.tab;
            Object.entries(tabContainers).forEach(([key, el]) => {
                el.style.display = key === activeTab ? '' : 'none';
            });
        };
    });

    // ===== Tab Renderers =====
    function renderAnswerTab() {
        const docCount = pdfDocs.length;
        const totalPages = pdfDocs.reduce((s, d) => s + (d.pages ? d.pages.length : 1), 0);
        tabContainers.answer.innerHTML = `
            <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
                <span style="font-size:11px;color:#888">${t('docsLoaded', docCount)}${docCount ? t('pagesSuffix', totalPages) : ''}</span>
                <div style="display:flex;gap:6px">
                    <button class="qah-btn" id="qah-screenshot" style="background:#f59e0b">${t('btnScreenshot')}</button>
                    <button class="qah-btn green" id="qah-ask-ai">${t('btnAsk')}</button>
                </div>
            </div>
            <div style="margin-bottom:10px">
                <label style="font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                    <input type="checkbox" id="qah-no-doc" ${noDocMode?'checked':''}>
                    <span>${t('noDoc')}</span>
                </label>
            </div>
            <div id="qah-question-preview">${!docCount && !noDocMode ? t('needDocsWarn') : t('hint')}</div>
            <div id="qah-screenshot-preview" style="display:${screenshotBase64?'block':'none'};margin-bottom:10px">
                <img id="qah-screenshot-img" src="${screenshotBase64 ? 'data:image/png;base64,'+screenshotBase64 : ''}" style="max-width:100%;border-radius:6px;border:1px solid #ddd">
                <button class="qah-btn danger" id="qah-clear-screenshot" style="margin-top:6px;padding:4px 8px;font-size:11px">${t('clearShot')}</button>
            </div>
            <div class="qah-field">
                <label>${t('questionLabel')}</label>
                <textarea id="qah-question" rows="4" placeholder="${t('questionPh')}"></textarea>
            </div>
            <div id="qah-answer-area"></div>
        `;
        document.getElementById('qah-screenshot').onclick = captureScreenshot;
        document.getElementById('qah-ask-ai').onclick = askAI;
        document.getElementById('qah-no-doc').onchange = (e) => { noDocMode = e.target.checked; };
        const clearBtn = document.getElementById('qah-clear-screenshot');
        if (clearBtn) clearBtn.onclick = () => {
            screenshotBase64 = null;
            renderAnswerTab();
        };
    }

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Scan the page (and same-origin iframes) for embedded PDF urls:
    // iframe/embed/object src, object data, anchor href
    function scanEmbeddedPdfs(doc, seen) {
        seen = seen || new Set();
        const add = (raw) => {
            if (!raw) return;
            try {
                const abs = new URL(raw, doc.baseURI || location.href).href;
                if (/\.pdf(\?|#|$)/i.test(abs)) seen.add(abs);
            } catch(e) { /* ignore malformed urls */ }
        };
        doc.querySelectorAll('iframe[src], frame[src], embed[src], object[data], a[href]').forEach(el => {
            add(el.getAttribute('src') || el.getAttribute('data') || el.getAttribute('href'));
        });
        doc.querySelectorAll('iframe, frame').forEach(f => {
            try {
                if (f.contentDocument && f.contentDocument !== doc) scanEmbeddedPdfs(f.contentDocument, seen);
            } catch(e) { /* cross-origin iframe: inner DOM not accessible */ }
        });
        return [...seen];
    }

    // Ask each child frame (cross-origin included) to scan its own document;
    // postMessage reaches cross-origin frames where contentDocument cannot.
    function relayScanToChildren(nonce) {
        const promises = [];
        for (let i = 0; i < window.frames.length; i++) {
            const win = window.frames[i];
            promises.push(new Promise(resolve => {
                let done = false;
                const handler = (e) => {
                    if (e.data && e.data.qahScan === 'res' && e.data.nonce === nonce && e.source === win) {
                        done = true;
                        window.removeEventListener('message', handler);
                        resolve(e.data.urls || []);
                    }
                };
                window.addEventListener('message', handler);
                try {
                    win.postMessage({ qahScan: 'req', nonce }, '*');
                } catch(e) {
                    window.removeEventListener('message', handler);
                    resolve([]);
                    return;
                }
                setTimeout(() => {
                    if (!done) { window.removeEventListener('message', handler); resolve([]); }
                }, 800);
            }));
        }
        return Promise.all(promises).then(rs => rs.flat());
    }

    async function scanAllFrames() {
        const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
        const own = scanEmbeddedPdfs(document);
        const extra = await relayScanToChildren(nonce);
        return [...new Set(own.concat(extra))];
    }

    // Render the persisted scan-result list (lastScanUrls) into #qah-scan-result.
    // Called after every docs-tab re-render so scanned PDFs don't vanish once
    // you load one of them. Loaded items show ✓ Loaded instead of a button.
    function renderScanResult() {
        const box = document.getElementById('qah-scan-result');
        if (!box) return;
        if (!lastScanUrls.length) { box.innerHTML = ''; return; }
        box.innerHTML = lastScanUrls.map(u => {
            const name = decodeURIComponent((u.split('/').pop() || u).split('?')[0]);
            const action = loadedScanUrls.has(u)
                ? `<span style="color:#2e7d32;font-size:11px;padding:4px 8px;white-space:nowrap">${t('loadedMark')}</span>`
                : `<button class="qah-btn" data-load="${escHtml(u)}" style="padding:4px 8px;font-size:11px">${t('load')}</button>`;
            return `<div class="qah-pdf-item">
                <span class="name" title="${escHtml(u)}">\u{1F50D} ${escHtml(name)}</span>
                ${action}
            </div>`;
        }).join('');
        box.querySelectorAll('[data-load]').forEach(b => {
            b.onclick = async () => {
                const ok = await loadUrl(b.dataset.load);
                if (ok) loadedScanUrls.add(b.dataset.load);
                renderDocsTab();
            };
        });
    }

    function renderDocsTab() {
        // preserve status message across re-renders (the load flow re-renders
        // right after writing ✓/✗ into #qah-load-status)
        const prevStatusEl = document.getElementById('qah-load-status');
        const prevStatus = prevStatusEl ? prevStatusEl.textContent : '';
        let listHtml = pdfDocs.map((d, i) => `
            <div class="qah-pdf-item">
                <span class="name" title="${d.name}">\u{1F4C4} ${d.name}</span>
                <span class="meta">${d.pages ? t('pagesUnit', d.pages.length) : t('chunksUnit', Math.round(d.text.length/500))}</span>
                <button class="qah-btn danger" data-rm="${i}" style="padding:4px 8px;font-size:11px">${t('del')}</button>
            </div>
        `).join('') || `<div style="color:#999;text-align:center;padding:20px">${t('noDocs')}</div>`;

        tabContainers.docs.innerHTML = `
            <div class="qah-field">
                <label>${t('uploadLabel')}</label>
                <input type="file" id="qah-pdf-file" accept=".pdf,.docx,.txt,.md,.markdown" multiple style="padding:6px">
            </div>
            <div class="qah-field">
                <label>${t('urlLabel')}</label>
                <div style="display:flex;gap:8px">
                    <input id="qah-pdf-url" placeholder="${t('urlPh')}">
                    <button class="qah-btn" id="qah-load-url">${t('load')}</button>
                </div>
            </div>
            <div class="qah-field">
                <label>${t('scanLabel')}</label>
                <button class="qah-btn secondary" id="qah-scan-pdfs" style="width:100%">${t('scanBtn')}</button>
                <div id="qah-scan-result"></div>
            </div>
            <div style="margin-top:12px">
                <label style="font-size:11px;font-weight:600;color:#555;margin-bottom:8px;display:block">${t('loadedDocs')}</label>
                ${listHtml}
            </div>
            <div id="qah-load-status" style="font-size:11px;color:#888;margin-top:8px">${prevStatus.replace(/</g, '&lt;')}</div>
        `;

        document.getElementById('qah-pdf-file').onchange = async (e) => {
            const files = Array.from(e.target.files);
            for (const file of files) {
                await loadFile(file);
            }
            renderDocsTab();
        };

        document.getElementById('qah-load-url').onclick = async () => {
            const url = document.getElementById('qah-pdf-url').value.trim();
            if (url) await loadUrl(url);
            renderDocsTab();
        };

        document.getElementById('qah-scan-pdfs').onclick = async () => {
            const urls = await scanAllFrames();
            const box = document.getElementById('qah-scan-result');
            if (!urls.length) {
                lastScanUrls = [];
                box.innerHTML = `<div style="color:#999;font-size:11px;padding:6px 0">${t('scanNone')}</div>`;
                return;
            }
            lastScanUrls = urls;
            renderScanResult();
        };

        tabContainers.docs.querySelectorAll('[data-rm]').forEach(b => {
            b.onclick = () => {
                pdfDocs.splice(parseInt(b.dataset.rm), 1);
                renderDocsTab();
            };
        });

        // repopulate the scan-result list from persisted state (innerHTML above
        // always creates #qah-scan-result empty)
        renderScanResult();
    }

    function renderConfigTab() {
        tabContainers.config.innerHTML = `
            <div class="qah-field">
                <label>${t('langLabel')}</label>
                <select id="qah-language">
                    <option value="auto" ${config.language==='auto'?'selected':''}>${t('langAuto')}</option>
                    <option value="zh" ${config.language==='zh'?'selected':''}>中文</option>
                    <option value="en" ${config.language==='en'?'selected':''}>English</option>
                </select>
            </div>
            <div class="qah-field">
                <label>${t('answerLangLabel')}</label>
                <select id="qah-answer-lang">
                    <option value="question" ${config.answerLang==='question'?'selected':''}>${t('answerQuestion')}</option>
                    <option value="ui" ${config.answerLang==='ui'?'selected':''}>${t('answerUi')}</option>
                    <option value="zh" ${config.answerLang==='zh'?'selected':''}>中文</option>
                    <option value="en" ${config.answerLang==='en'?'selected':''}>English</option>
                </select>
            </div>
            <div class="qah-field">
                <label>${t('providerLabel')}</label>
                <select id="qah-provider">
                    <option value="openai" ${config.provider==='openai'?'selected':''}>${t('openaiOpt')}</option>
                    <option value="anthropic" ${config.provider==='anthropic'?'selected':''}>Anthropic (Claude)</option>
                </select>
            </div>
            <div id="qah-provider-fields"></div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid #eee">
                <div class="qah-field">
                    <label>${t('domainsLabel')}</label>
                    <textarea id="qah-domains" rows="3" placeholder="${t('domainsPh')}"></textarea>
                </div>
            </div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid #eee">
                <label style="font-size:11px;font-weight:600;color:#555;margin-bottom:8px;display:block">${t('hotkeyTitle')}</label>
                <div class="qah-field">
                    <label>${t('hotkeyToggle')}</label>
                    <input id="qah-hotkey-toggle" value="${config.hotkeyToggle}" placeholder="${t('hotkeyTogglePh')}">
                </div>
                <div class="qah-field">
                    <label>${t('hotkeyShot')}</label>
                    <input id="qah-hotkey-screenshot" value="${config.hotkeyScreenshot}" placeholder="${t('hotkeyShotPh')}">
                </div>
            </div>
            <button class="qah-btn" id="qah-save-config" style="margin-top:12px">${t('saveBtn')}</button>
            <span id="qah-save-status" style="margin-left:10px;font-size:11px;color:#10b981"></span>
        `;
        renderProviderFields();
        document.getElementById('qah-domains').value = config.allowedDomains || '';
        document.getElementById('qah-language').onchange = (e) => {
            collectConfigFields(); // keep unsaved edits before the tab is rebuilt
            config.language = e.target.value;
            saveConfigToStorage();
            renderAll();
        };
        document.getElementById('qah-answer-lang').onchange = (e) => {
            config.answerLang = e.target.value;
            saveConfigToStorage();
        };
        document.getElementById('qah-provider').onchange = (e) => {
            config.provider = e.target.value;
            renderProviderFields();
        };
        document.getElementById('qah-hotkey-toggle').onkeydown = captureHotkey;
        document.getElementById('qah-hotkey-screenshot').onkeydown = captureHotkey;
        document.getElementById('qah-save-config').onclick = saveConfig;
    }

    function renderProviderFields() {
        const container = document.getElementById('qah-provider-fields');
        if (config.provider === 'openai') {
            container.innerHTML = `
                <div class="qah-field">
                    <label>API Base URL</label>
                    <input id="qah-base-url" value="${config.baseUrl}" placeholder="https://api.openai.com/v1">
                </div>
                <div class="qah-field">
                    <label>API Key</label>
                    <input id="qah-api-key" type="password" value="${config.apiKey}" placeholder="sk-...">
                </div>
                <div class="qah-field">
                    <label>${t('modelLabel')}</label>
                    <div style="display:flex;gap:6px">
                        <select id="qah-model" style="flex:1"><option value="${config.model}">${config.model || t('refreshPh')}</option></select>
                        <button class="qah-btn secondary" id="qah-fetch-models" style="padding:6px 10px;font-size:11px">${t('refreshBtn')}</button>
                    </div>
                </div>
            `;
            document.getElementById('qah-fetch-models').onclick = () => fetchModels('openai');
        } else {
            container.innerHTML = `
                <div class="qah-field">
                    <label>API Base URL</label>
                    <input id="qah-anthropic-url" value="${config.anthropicBaseUrl}" placeholder="https://api.anthropic.com">
                </div>
                <div class="qah-field">
                    <label>API Key</label>
                    <input id="qah-anthropic-key" type="password" value="${config.anthropicKey}" placeholder="sk-ant-...">
                </div>
                <div class="qah-field">
                    <label>${t('modelLabel')}</label>
                    <div style="display:flex;gap:6px">
                        <select id="qah-anthropic-model" style="flex:1"><option value="${config.anthropicModel}">${config.anthropicModel || t('refreshPh')}</option></select>
                        <button class="qah-btn secondary" id="qah-fetch-models-ant" style="padding:6px 10px;font-size:11px">${t('refreshBtn')}</button>
                    </div>
                </div>
            `;
            document.getElementById('qah-fetch-models-ant').onclick = () => fetchModels('anthropic');
        }
    }

    function renderSupportTab() {
        tabContainers.support.innerHTML = `
            <div style="text-align:center;padding:20px 10px">
                <div style="font-size:16px;font-weight:600;margin-bottom:8px">${t('supportTitle')}</div>
                <p style="color:#666;font-size:12px;margin-bottom:16px;line-height:1.6">${t('supportText')}</p>
                <img src="${chrome.runtime.getURL('images/buy-me-a-coffee.jpeg')}" style="max-width:220px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.1)">
                <p style="color:#888;font-size:12px;margin-top:16px">${t('author')}</p>
                <p style="color:#999;font-size:11px;margin-top:4px">${t('contact')}</p>
            </div>
        `;
    }

    // ===== Config =====
    function captureHotkey(e) {
        e.preventDefault();
        e.stopPropagation();
        const ignore = ['Control', 'Alt', 'Shift', 'Meta'];
        if (ignore.includes(e.key)) return;
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Cmd');
        let key = e.code;
        if (key.startsWith('Key')) key = key.slice(3);
        else if (key.startsWith('Digit')) key = key.slice(5);
        else key = e.key;
        parts.push(key.length === 1 ? key.toUpperCase() : key);
        e.target.value = parts.join('+');
    }

    function fetchModels(provider) {
        if (provider === 'openai') {
            const baseUrl = document.getElementById('qah-base-url').value.trim().replace(/\/$/, '');
            const apiKey = document.getElementById('qah-api-key').value.trim();
            if (!apiKey) { alert(t('needKey')); return; }
            const selectEl = document.getElementById('qah-model');
            selectEl.innerHTML = `<option value="">${t('loading')}</option>`;
            chrome.runtime.sendMessage({
                type: 'API_REQUEST',
                url: baseUrl + '/models',
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + apiKey }
            }, (resp) => {
                try {
                    const data = JSON.parse(resp.text);
                    const models = (data.data || data).map(m => m.id || m.name || m).filter(Boolean).sort();
                    selectEl.innerHTML = models.map(m => `<option value="${m}" ${m===config.model?'selected':''}>${m}</option>`).join('');
                    if (!models.length) selectEl.innerHTML = `<option value="">${t('noModels')}</option>`;
                } catch(e) {
                    selectEl.innerHTML = `<option value="">${t('loadFailed')}</option>`;
                }
            });
        } else {
            const baseUrl = document.getElementById('qah-anthropic-url').value.trim().replace(/\/$/, '');
            const apiKey = document.getElementById('qah-anthropic-key').value.trim();
            if (!apiKey) { alert(t('needKey')); return; }
            const selectEl = document.getElementById('qah-anthropic-model');
            selectEl.innerHTML = `<option value="">${t('loading')}</option>`;
            chrome.runtime.sendMessage({
                type: 'API_REQUEST',
                url: baseUrl + '/v1/models',
                method: 'GET',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                }
            }, (resp) => {
                try {
                    const data = JSON.parse(resp.text);
                    const models = (data.data || data).map(m => m.id || m.name || m).filter(Boolean).sort();
                    if (models.length) {
                        selectEl.innerHTML = models.map(m => `<option value="${m}" ${m===config.anthropicModel?'selected':''}>${m}</option>`).join('');
                    } else {
                        useAnthropicDefaults(selectEl);
                    }
                } catch(e) {
                    useAnthropicDefaults(selectEl);
                }
            });
        }
    }

    function useAnthropicDefaults(selectEl) {
        const defaults = ['claude-opus-4-20250514','claude-sonnet-4-20250514','claude-haiku-4-5-20251001','claude-3-5-sonnet-20241022','claude-3-5-haiku-20241022'];
        selectEl.innerHTML = defaults.map(m => `<option value="${m}" ${m===config.anthropicModel?'selected':''}>${m}</option>`).join('');
    }

    // Read the config form fields into `config` (without persisting)
    function collectConfigFields() {
        if (config.provider === 'openai') {
            config.baseUrl = document.getElementById('qah-base-url').value.trim();
            config.apiKey = document.getElementById('qah-api-key').value.trim();
            config.model = document.getElementById('qah-model').value.trim();
        } else {
            config.anthropicBaseUrl = document.getElementById('qah-anthropic-url').value.trim();
            config.anthropicKey = document.getElementById('qah-anthropic-key').value.trim();
            config.anthropicModel = document.getElementById('qah-anthropic-model').value.trim();
        }
        config.hotkeyToggle = document.getElementById('qah-hotkey-toggle').value.trim() || 'Alt+Q';
        config.hotkeyScreenshot = document.getElementById('qah-hotkey-screenshot').value.trim() || 'Alt+A';
        config.allowedDomains = document.getElementById('qah-domains').value.trim();
    }

    function saveConfig() {
        collectConfigFields();
        saveConfigToStorage();
        applyDomainGate();
        document.getElementById('qah-save-status').textContent = t('saved');
        setTimeout(() => {
            const el = document.getElementById('qah-save-status');
            if (el) el.textContent = '';
        }, 2000);
    }

    // ===== Lazy Library Loading =====
    const LIB_GLOBALS = {
        'lib/pdf.min.js': ['pdfjsLib', 'pdfjs-dist/build/pdf'],
        'lib/marked.min.js': ['marked'],
        'lib/mammoth.min.js': ['mammoth']
    };

    async function ensureLib(file) {
        if (LIB_GLOBALS[file].some(g => window[g])) return;
        const resp = await new Promise(resolve => {
            chrome.runtime.sendMessage({ type: 'INJECT_LIB', file }, resolve);
        });
        if (!resp || !resp.ok) throw new Error(t('libFail', (resp && resp.error) || file));
        if (!LIB_GLOBALS[file].some(g => window[g])) {
            throw new Error(t('libNoEffect', file));
        }
    }

    // ===== Document Loading =====
    async function loadFile(file) {
        const statusEl = document.getElementById('qah-load-status');
        if (statusEl) statusEl.textContent = t('parsing', file.name);
        try {
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'pdf') {
                const buf = await file.arrayBuffer();
                await extractPDF(new Uint8Array(buf), file.name);
            } else if (ext === 'docx') {
                await ensureLib('lib/mammoth.min.js');
                const buf = await file.arrayBuffer();
                const result = await mammoth.extractRawText({ arrayBuffer: buf });
                pdfDocs.push({ name: file.name, text: result.value });
            } else if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
                const text = await file.text();
                pdfDocs.push({ name: file.name, text });
            } else {
                throw new Error(t('unsupported'));
            }
            if (statusEl) statusEl.textContent = t('fileDone', file.name);
        } catch(e) {
            console.error('[Quiz AI Helper] loadFile failed:', e);
            if (statusEl) statusEl.textContent = t('fileFail', file.name, e.message);
        }
    }

    async function loadUrl(url) {
        const statusEl = document.getElementById('qah-load-status');
        if (statusEl) statusEl.textContent = t('downloading');
        try {
            const isPDF = /\.pdf(\?|$)/i.test(url);
            if (isPDF) {
                const resp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ type: 'FETCH_BINARY', url }, resolve);
                });
                if (!resp || !resp.ok) throw new Error(resp ? resp.error : t('downloadFail'));
                const binary = atob(resp.base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const name = url.split('/').pop().split('?')[0] || 'document.pdf';
                await extractPDF(bytes, name);
                if (statusEl) statusEl.textContent = t('fileDone', name);
                return true;
            } else {
                const resp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        type: 'API_REQUEST', url, method: 'GET', headers: {}
                    }, resolve);
                });
                if (!resp || !resp.ok) throw new Error(resp ? resp.error : t('downloadFail'));
                const contentType = resp.text.slice(0, 100);
                let text = resp.text;
                if (text.includes('<html') || text.includes('<HTML') || text.includes('<!DOCTYPE')) {
                    text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                               .replace(/<style[\s\S]*?<\/style>/gi, '')
                               .replace(/<[^>]+>/g, ' ')
                               .replace(/\s+/g, ' ')
                               .trim();
                }
                const name = url.replace(/^https?:\/\//, '').split('/')[0] || 'webpage';
                pdfDocs.push({ name, text: text.slice(0, 200000) });
                if (statusEl) statusEl.textContent = t('fileDone', name);
                return true;
            }
        } catch(e) {
            console.error('[Quiz AI Helper] loadUrl failed:', e);
            if (statusEl) statusEl.textContent = t('urlFail', e.message);
            return false;
        }
    }

    async function extractPDF(data, name) {
        await ensureLib('lib/pdf.min.js');
        const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items.map(item => item.str).join(' ');
            if (text.trim()) pages.push({ page: i, text });
        }
        pdfDocs.push({ name, pages });
    }

    // ===== Screenshot =====
    async function captureScreenshot() {
        const preview = document.getElementById('qah-question-preview');
        try {
            panel.style.display = 'none';
            btn.style.display = 'none';

            await new Promise(r => setTimeout(r, 200));

            const resp = await new Promise((resolve) => {
                chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, resolve);
            });

            panel.style.display = '';
            btn.style.display = '';
            panel.classList.add('show');

            if (resp && resp.dataUrl) {
                screenshotBase64 = resp.dataUrl.split(',')[1];
                if (preview) preview.textContent = t('shotOk');
                renderAnswerTab();
            } else {
                if (preview) preview.textContent = t('shotFail', resp && resp.error || t('unknown'));
            }
        } catch(e) {
            panel.style.display = '';
            btn.style.display = '';
            panel.classList.add('show');
            if (preview) preview.textContent = t('shotFail', e.message);
        }
    }

    // ===== Clipboard Paste =====
    panel.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                const reader = new FileReader();
                reader.onload = () => {
                    screenshotBase64 = reader.result.split(',')[1];
                    renderAnswerTab();
                    const preview = document.getElementById('qah-question-preview');
                    if (preview) preview.textContent = t('pasteOk');
                };
                reader.readAsDataURL(file);
                break;
            }
        }
    });

    // ===== AI Call =====
    async function askAI() {
        const questionEl = document.getElementById('qah-question');
        const answerArea = document.getElementById('qah-answer-area');
        const question = questionEl ? questionEl.value.trim() : '';

        if (!question && !screenshotBase64) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoQuestion')}</div>`;
            return;
        }
        if (!noDocMode && !pdfDocs.length) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoDocs')}</div>`;
            return;
        }
        if (config.provider === 'openai' && !config.apiKey) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoKey')}</div>`;
            return;
        }
        if (config.provider === 'anthropic' && !config.anthropicKey) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoAntKey')}</div>`;
            return;
        }

        answerArea.innerHTML = `<div class="qah-loading">${t('analyzing')}</div>`;

        let pdfContext = '';
        if (pdfDocs.length) {
            pdfDocs.forEach(doc => {
                pdfContext += `\n\n${t('docHeader', doc.name)}\n`;
                if (doc.pages) {
                    doc.pages.forEach(p => {
                        pdfContext += `\n${t('pageMark', p.page)}\n${p.text}\n`;
                    });
                } else {
                    pdfContext += `\n${doc.text}\n`;
                }
            });
        }

        if (pdfContext.length > 100000) {
            pdfContext = pdfContext.slice(0, 100000) + '\n\n' + t('truncated');
        }

        // Rules differ for doc-based vs. knowledge-only mode; answer language is appended last
        const useDocs = !(noDocMode && !pdfDocs.length);
        const answerMode = config.answerLang === 'ui' ? uiLang() : config.answerLang;
        const ansRule = answerMode === 'zh' ? t('ansZh') : answerMode === 'en' ? t('ansEn') : t('ansQuestion');
        const rules = (useDocs
            ? [t('ruleReadDocs'), t('ruleDocAnswer'), t('ruleDocFormat')]
            : [t('ruleExplain')]
        ).concat([t('ruleChoice'), t('ruleTF'), t('ruleMatch'), t('ruleShot'), ansRule]);
        const systemPrompt = (useDocs ? t('sysRoleDoc') : t('sysRole')) +
            '\n\n' + t('rulesTitle') + '\n' + rules.map((r, n) => (n + 1) + '. ' + r).join('\n');

        const userTextParts = [];
        if (pdfContext) {
            userTextParts.push(t('uDocs', pdfContext));
        }
        if (question) {
            userTextParts.push(pdfContext ? t('uAskDocs', question) : t('uAsk', question));
        } else {
            userTextParts.push(pdfContext ? t('uShotDocs') : t('uShot'));
        }
        const userText = userTextParts.join('\n');

        try {
            let answer;
            if (config.provider === 'openai') {
                answer = await callOpenAI(systemPrompt, userText, screenshotBase64);
            } else {
                answer = await callAnthropic(systemPrompt, userText, screenshotBase64);
            }
            try { await ensureLib('lib/marked.min.js'); } catch(e) { /* fall back to plain text */ }
            answerArea.innerHTML = `<div class="qah-answer-box">${renderMarkdown(answer)}</div>`;
        } catch(e) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${e.message}</div>`;
        }
    }

    function callOpenAI(system, user, imageBase64) {
        return new Promise((resolve, reject) => {
            const url = config.baseUrl.replace(/\/$/, '') + '/chat/completions';
            const userContent = [];
            if (imageBase64) {
                userContent.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageBase64 } });
            }
            userContent.push({ type: 'text', text: user });

            chrome.runtime.sendMessage({
                type: 'API_REQUEST',
                url: url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + config.apiKey
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: system },
                        { role: 'user', content: userContent }
                    ],
                    temperature: 0.1
                })
            }, (resp) => {
                if (!resp || !resp.ok) { reject(new Error(resp ? resp.error : t('netFail'))); return; }
                try {
                    const data = JSON.parse(resp.text);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.choices[0].message.content);
                } catch(e) {
                    reject(new Error(t('parseFail', (resp.text || '').slice(0, 200))));
                }
            });
        });
    }

    function callAnthropic(system, user, imageBase64) {
        return new Promise((resolve, reject) => {
            const url = config.anthropicBaseUrl.replace(/\/$/, '') + '/v1/messages';
            const userContent = [];
            if (imageBase64) {
                userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } });
            }
            userContent.push({ type: 'text', text: user });

            chrome.runtime.sendMessage({
                type: 'API_REQUEST',
                url: url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': config.anthropicKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: JSON.stringify({
                    model: config.anthropicModel,
                    max_tokens: 4096,
                    system: system,
                    messages: [
                        { role: 'user', content: userContent }
                    ],
                    temperature: 0.1
                })
            }, (resp) => {
                if (!resp || !resp.ok) { reject(new Error(resp ? resp.error : t('netFail'))); return; }
                try {
                    const data = JSON.parse(resp.text);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.content[0].text);
                } catch(e) {
                    reject(new Error(t('parseFail', (resp.text || '').slice(0, 200))));
                }
            });
        });
    }

    function renderMarkdown(text) {
        try {
            return marked.parse(text);
        } catch(e) {
            return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
        }
    }

    // ===== Keyboard Shortcut =====
    function matchHotkey(e, hotkeyStr) {
        const parts = hotkeyStr.split('+').map(s => s.trim().toLowerCase());
        const key = parts.pop();
        const needCtrl = parts.includes('ctrl');
        const needAlt = parts.includes('alt');
        const needShift = parts.includes('shift');
        const needMeta = parts.includes('meta') || parts.includes('cmd');
        if (e.ctrlKey !== needCtrl || e.altKey !== needAlt ||
            e.shiftKey !== needShift || e.metaKey !== needMeta) return false;
        const code = e.code.toLowerCase();
        if (key.length === 1 && code === 'key' + key) return true;
        if (/^\d$/.test(key) && code === 'digit' + key) return true;
        return e.key.toLowerCase() === key;
    }

    document.addEventListener('keydown', (e) => {
        if (!uiActive) return;
        if (matchHotkey(e, config.hotkeyToggle)) { e.preventDefault(); panel.classList.toggle('show'); }
        if (matchHotkey(e, config.hotkeyScreenshot)) { e.preventDefault(); panel.classList.add('show'); captureScreenshot(); }
    });

    // ===== Init =====
    // Re-render every tab (also used after a language change). Keeps the typed
    // question and the last answer, which renderAnswerTab() would otherwise wipe.
    function renderAll() {
        const q = document.getElementById('qah-question');
        const a = document.getElementById('qah-answer-area');
        const qVal = q ? q.value : '';
        const aHtml = a ? a.innerHTML : '';
        tabEls.forEach(el => { el.textContent = t('tab' + el.dataset.tab.charAt(0).toUpperCase() + el.dataset.tab.slice(1)); });
        renderAnswerTab();
        renderDocsTab();
        renderConfigTab();
        renderSupportTab();
        document.getElementById('qah-question').value = qVal;
        document.getElementById('qah-answer-area').innerHTML = aHtml;
    }

    renderAll();
})();
