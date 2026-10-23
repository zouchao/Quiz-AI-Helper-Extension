(function() {
    'use strict';

    // ===== State =====
    let screenshotBase64 = null;
    let pdfDocs = []; // [{name, text}] - stores all document types
    let noDocMode = false;
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
        allowedDomains: ''
    }, {});

    // Load config from chrome.storage
    chrome.storage.local.get('qah_config', (result) => {
        if (result.qah_config) Object.assign(config, result.qah_config);
        renderConfigTab(); // re-render with loaded values (initial render runs before storage callback)
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
            <div class="qah-tab active" data-tab="answer">答题</div>
            <div class="qah-tab" data-tab="docs">文档</div>
            <div class="qah-tab" data-tab="config">设置</div>
            <div class="qah-tab" data-tab="support">支持</div>
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
                <span style="font-size:11px;color:#888">已加载 ${docCount} 个文档${docCount ? ', ' + totalPages + ' 页' : ''}</span>
                <div style="display:flex;gap:6px">
                    <button class="qah-btn" id="qah-screenshot" style="background:#f59e0b">截图作答</button>
                    <button class="qah-btn green" id="qah-ask-ai">AI 作答</button>
                </div>
            </div>
            <div style="margin-bottom:10px">
                <label style="font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                    <input type="checkbox" id="qah-no-doc" ${noDocMode?'checked':''}>
                    <span>不依赖文档 (AI 根据自身知识回答)</span>
                </label>
            </div>
            <div id="qah-question-preview">${!docCount && !noDocMode ? '⚠️ 请先在「文档」标签加载参考资料，或勾选「不依赖文档」' : '点击「截图作答」或直接 Ctrl+V 粘贴截图，也可在下方手动输入题目'}</div>
            <div id="qah-screenshot-preview" style="display:${screenshotBase64?'block':'none'};margin-bottom:10px">
                <img id="qah-screenshot-img" src="${screenshotBase64 ? 'data:image/png;base64,'+screenshotBase64 : ''}" style="max-width:100%;border-radius:6px;border:1px solid #ddd">
                <button class="qah-btn danger" id="qah-clear-screenshot" style="margin-top:6px;padding:4px 8px;font-size:11px">清除截图</button>
            </div>
            <div class="qah-field">
                <label>题目 / 问题 (可手动编辑，截图模式下可留空)</label>
                <textarea id="qah-question" rows="4" placeholder="在此输入题目内容..."></textarea>
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

    function renderDocsTab() {
        // preserve status message across re-renders (the load flow re-renders
        // right after writing ✓/✗ into #qah-load-status)
        const prevStatusEl = document.getElementById('qah-load-status');
        const prevStatus = prevStatusEl ? prevStatusEl.textContent : '';
        let listHtml = pdfDocs.map((d, i) => `
            <div class="qah-pdf-item">
                <span class="name" title="${d.name}">\u{1F4C4} ${d.name}</span>
                <span class="meta">${d.pages ? d.pages.length + '页' : Math.round(d.text.length/500) + '段'}</span>
                <button class="qah-btn danger" data-rm="${i}" style="padding:4px 8px;font-size:11px">删除</button>
            </div>
        `).join('') || '<div style="color:#999;text-align:center;padding:20px">暂无文档</div>';

        tabContainers.docs.innerHTML = `
            <div class="qah-field">
                <label>上传文件 (支持 PDF、Word、TXT、Markdown，可多选)</label>
                <input type="file" id="qah-pdf-file" accept=".pdf,.docx,.txt,.md,.markdown" multiple style="padding:6px">
            </div>
            <div class="qah-field">
                <label>或输入链接 (支持网页和PDF链接，自动识别)</label>
                <div style="display:flex;gap:8px">
                    <input id="qah-pdf-url" placeholder="https://example.com/page 或 .pdf 链接">
                    <button class="qah-btn" id="qah-load-url">加载</button>
                </div>
            </div>
            <div style="margin-top:12px">
                <label style="font-size:11px;font-weight:600;color:#555;margin-bottom:8px;display:block">已加载文档:</label>
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

        tabContainers.docs.querySelectorAll('[data-rm]').forEach(b => {
            b.onclick = () => {
                pdfDocs.splice(parseInt(b.dataset.rm), 1);
                renderDocsTab();
            };
        });
    }

    function renderConfigTab() {
        tabContainers.config.innerHTML = `
            <div class="qah-field">
                <label>AI 服务商</label>
                <select id="qah-provider">
                    <option value="openai" ${config.provider==='openai'?'selected':''}>OpenAI 兼容 (OpenAI/DeepSeek/Groq/本地等)</option>
                    <option value="anthropic" ${config.provider==='anthropic'?'selected':''}>Anthropic (Claude)</option>
                </select>
            </div>
            <div id="qah-provider-fields"></div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid #eee">
                <div class="qah-field">
                    <label>生效域名 (每行一个或逗号分隔，支持 * 通配符，留空 = 所有网站)</label>
                    <textarea id="qah-domains" rows="3" placeholder="例如:&#10;develop.*.com&#10;*.example.com"></textarea>
                </div>
            </div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid #eee">
                <label style="font-size:11px;font-weight:600;color:#555;margin-bottom:8px;display:block">快捷键设置 (修改后即时生效)</label>
                <div class="qah-field">
                    <label>打开/关闭面板</label>
                    <input id="qah-hotkey-toggle" value="${config.hotkeyToggle}" placeholder="如 Alt+Q, Ctrl+Shift+K">
                </div>
                <div class="qah-field">
                    <label>截图</label>
                    <input id="qah-hotkey-screenshot" value="${config.hotkeyScreenshot}" placeholder="如 Alt+A, Ctrl+Shift+S">
                </div>
            </div>
            <button class="qah-btn" id="qah-save-config" style="margin-top:12px">保存设置</button>
            <span id="qah-save-status" style="margin-left:10px;font-size:11px;color:#10b981"></span>
        `;
        renderProviderFields();
        document.getElementById('qah-domains').value = config.allowedDomains || '';
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
                    <label>模型</label>
                    <div style="display:flex;gap:6px">
                        <select id="qah-model" style="flex:1"><option value="${config.model}">${config.model || '-- 点击刷新加载 --'}</option></select>
                        <button class="qah-btn secondary" id="qah-fetch-models" style="padding:6px 10px;font-size:11px">刷新列表</button>
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
                    <label>模型</label>
                    <div style="display:flex;gap:6px">
                        <select id="qah-anthropic-model" style="flex:1"><option value="${config.anthropicModel}">${config.anthropicModel || '-- 点击刷新加载 --'}</option></select>
                        <button class="qah-btn secondary" id="qah-fetch-models-ant" style="padding:6px 10px;font-size:11px">刷新列表</button>
                    </div>
                </div>
            `;
            document.getElementById('qah-fetch-models-ant').onclick = () => fetchModels('anthropic');
        }
    }

    function renderSupportTab() {
        tabContainers.support.innerHTML = `
            <div style="text-align:center;padding:20px 10px">
                <div style="font-size:16px;font-weight:600;margin-bottom:8px">觉得好用？请作者喝杯咖啡</div>
                <p style="color:#666;font-size:12px;margin-bottom:16px;line-height:1.6">这个工具完全免费开源，如果它帮到了你，一杯咖啡就是最大的鼓励 :)</p>
                <img src="${chrome.runtime.getURL('images/buy-me-a-coffee.jpeg')}" style="max-width:220px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.1)">
                <p style="color:#888;font-size:12px;margin-top:16px">作者: Sean Zou</p>
                <p style="color:#999;font-size:11px;margin-top:4px">联系: zouchao2008@gmail.com</p>
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
            if (!apiKey) { alert('请先填写 API Key'); return; }
            const selectEl = document.getElementById('qah-model');
            selectEl.innerHTML = '<option value="">加载中...</option>';
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
                    if (!models.length) selectEl.innerHTML = '<option value="">未获取到模型</option>';
                } catch(e) {
                    selectEl.innerHTML = '<option value="">加载失败</option>';
                }
            });
        } else {
            const baseUrl = document.getElementById('qah-anthropic-url').value.trim().replace(/\/$/, '');
            const apiKey = document.getElementById('qah-anthropic-key').value.trim();
            if (!apiKey) { alert('请先填写 API Key'); return; }
            const selectEl = document.getElementById('qah-anthropic-model');
            selectEl.innerHTML = '<option value="">加载中...</option>';
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

    function saveConfig() {
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
        saveConfigToStorage();
        applyDomainGate();
        document.getElementById('qah-save-status').textContent = '✓ 已保存';
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
        if (!resp || !resp.ok) throw new Error('组件加载失败: ' + ((resp && resp.error) || file));
        if (!LIB_GLOBALS[file].some(g => window[g])) {
            throw new Error('组件注入后未生效: ' + file + ' (请重新加载扩展)');
        }
    }

    // ===== Document Loading =====
    async function loadFile(file) {
        const statusEl = document.getElementById('qah-load-status');
        if (statusEl) statusEl.textContent = `正在解析 ${file.name}...`;
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
                throw new Error('不支持的文件格式');
            }
            if (statusEl) statusEl.textContent = `✓ ${file.name} 加载完成`;
        } catch(e) {
            console.error('[Quiz AI Helper] loadFile failed:', e);
            if (statusEl) statusEl.textContent = `✗ ${file.name} 加载失败: ${e.message}`;
        }
    }

    async function loadUrl(url) {
        const statusEl = document.getElementById('qah-load-status');
        if (statusEl) statusEl.textContent = '正在下载...';
        try {
            const isPDF = /\.pdf(\?|$)/i.test(url);
            if (isPDF) {
                const resp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({ type: 'FETCH_BINARY', url }, resolve);
                });
                if (!resp || !resp.ok) throw new Error(resp ? resp.error : '下载失败');
                const binary = atob(resp.base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const name = url.split('/').pop().split('?')[0] || 'document.pdf';
                await extractPDF(bytes, name);
                if (statusEl) statusEl.textContent = `✓ ${name} 加载完成`;
            } else {
                const resp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        type: 'API_REQUEST', url, method: 'GET', headers: {}
                    }, resolve);
                });
                if (!resp || !resp.ok) throw new Error(resp ? resp.error : '下载失败');
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
                if (statusEl) statusEl.textContent = `✓ ${name} 加载完成`;
            }
        } catch(e) {
            console.error('[Quiz AI Helper] loadUrl failed:', e);
            if (statusEl) statusEl.textContent = `✗ 加载失败: ${e.message}`;
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
                if (preview) preview.textContent = '✓ 截图已获取，点击「AI 作答」发送给AI';
                renderAnswerTab();
            } else {
                if (preview) preview.textContent = '✗ 截图失败: ' + (resp && resp.error || '未知错误');
            }
        } catch(e) {
            panel.style.display = '';
            btn.style.display = '';
            panel.classList.add('show');
            if (preview) preview.textContent = `✗ 截图失败: ${e.message}`;
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
                    if (preview) preview.textContent = '✓ 已从剪贴板粘贴截图，点击「AI 作答」发送给AI';
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
            answerArea.innerHTML = '<div class="qah-answer-box error">请先输入题目或截取屏幕</div>';
            return;
        }
        if (!noDocMode && !pdfDocs.length) {
            answerArea.innerHTML = '<div class="qah-answer-box error">请先在「文档」标签加载参考资料，或勾选「不依赖文档」</div>';
            return;
        }
        if (config.provider === 'openai' && !config.apiKey) {
            answerArea.innerHTML = '<div class="qah-answer-box error">请先在「设置」中配置API Key</div>';
            return;
        }
        if (config.provider === 'anthropic' && !config.anthropicKey) {
            answerArea.innerHTML = '<div class="qah-answer-box error">请先在「设置」中配置Anthropic API Key</div>';
            return;
        }

        answerArea.innerHTML = '<div class="qah-loading">AI 正在分析并作答...</div>';

        let pdfContext = '';
        if (pdfDocs.length) {
            pdfDocs.forEach(doc => {
                pdfContext += `\n\n===== 文档: ${doc.name} =====\n`;
                if (doc.pages) {
                    doc.pages.forEach(p => {
                        pdfContext += `\n[第${p.page}页]\n${p.text}\n`;
                    });
                } else {
                    pdfContext += `\n${doc.text}\n`;
                }
            });
        }

        if (pdfContext.length > 100000) {
            pdfContext = pdfContext.slice(0, 100000) + '\n\n[...内容已截断...]';
        }

        let systemPrompt;
        if (noDocMode && !pdfDocs.length) {
            systemPrompt = `你是一个专业的考试助手。请根据你的知识回答用户的考试题目。

规则：
1. 给出明确的答案，再简要说明理由
2. 如果是选择题，明确指出正确选项
3. 如果是判断题(True/False)，明确给出True或False
4. 如果是匹配题，给出所有正确的配对
5. 如果用户提供了屏幕截图，请从截图中识别题目内容并作答
6. 用中文回答`;
        } else {
            systemPrompt = `你是一个专业的考试助手。你的任务是根据提供的参考文档内容来回答用户的考试题目。

规则：
1. 仔细阅读并理解所有参考文档内容
2. 根据文档内容精确回答问题，给出明确的答案
3. 回答格式：先给出答案，再简要说明依据（引用文档中的具体条款或段落）
4. 如果是选择题，明确指出正确选项
5. 如果是判断题(True/False)，明确给出True或False
6. 如果是匹配题，给出所有正确的配对
7. 如果用户提供了屏幕截图，请从截图中识别题目内容并作答
8. 用中文回答`;
        }

        const userTextParts = [];
        if (pdfContext) {
            userTextParts.push(`参考文档内容：\n${pdfContext}\n\n---\n`);
        }
        if (question) {
            if (pdfContext) {
                userTextParts.push(`请根据以上参考文档回答以下题目：\n\n${question}`);
            } else {
                userTextParts.push(`请回答以下题目：\n\n${question}`);
            }
        } else {
            if (pdfContext) {
                userTextParts.push(`请根据以上参考文档，识别截图中的题目并作答：`);
            } else {
                userTextParts.push(`请识别截图中的题目并作答：`);
            }
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
                if (!resp || !resp.ok) { reject(new Error(resp ? resp.error : '网络请求失败')); return; }
                try {
                    const data = JSON.parse(resp.text);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.choices[0].message.content);
                } catch(e) {
                    reject(new Error('解析响应失败: ' + (resp.text || '').slice(0, 200)));
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
                if (!resp || !resp.ok) { reject(new Error(resp ? resp.error : '网络请求失败')); return; }
                try {
                    const data = JSON.parse(resp.text);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.content[0].text);
                } catch(e) {
                    reject(new Error('解析响应失败: ' + (resp.text || '').slice(0, 200)));
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
    renderAnswerTab();
    renderDocsTab();
    renderConfigTab();
    renderSupportTab();
})();
