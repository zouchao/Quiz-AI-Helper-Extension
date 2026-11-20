import { I18N } from './i18n.js';
import { LOGO_SVG, ICON_PATHS, icon, chip, groupTitle, fileTone } from './icons.js';

// Whole content-script body; called once per frame from index.js.
export function main() {

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

    function uiLang() {
        if (config.language === 'zh' || config.language === 'en') return config.language;
        return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
    }

    function t(key, ...args) {
        const str = (I18N[uiLang()][key] !== undefined ? I18N[uiLang()][key] : I18N.en[key]) || key;
        return str.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? args[i] : m));
    }

    // ===== Config storage =====
    // `qah_config` lives in chrome.storage.sync when account sync is on, else in
    // chrome.storage.local. The on/off choice is per device (local key `qah_sync`).
    // Loaded documents are memory-only and never stored.
    let syncEnabled = false;
    const configArea = () => (syncEnabled ? chrome.storage.sync : chrome.storage.local);

    chrome.storage.local.get(['qah_config', 'qah_sync'], (loc) => {
        chrome.storage.sync.get('qah_config', (syn) => {
            const synced = !chrome.runtime.lastError && syn && syn.qah_config;
            // Never chosen on this device: follow sync if another device already uses it
            syncEnabled = loc.qah_sync === undefined ? !!synced : !!loc.qah_sync;
            if (loc.qah_sync === undefined && synced) chrome.storage.local.set({ qah_sync: true });
            const stored = syncEnabled ? (synced || loc.qah_config) : loc.qah_config;
            if (stored) Object.assign(config, stored);
            // Sync on but nothing uploaded yet (e.g. sync data cleared): seed it from this device
            if (syncEnabled && !synced && loc.qah_config) saveConfigToStorage();
            renderAll(); // re-render with loaded values (initial render runs before storage callback)
            applyDomainGate();
        });
    });

    // Settings changed elsewhere (another tab, or another device via sync)
    chrome.storage.onChanged.addListener((changes, area) => {
        // Sync toggled in another tab: switch area and reload from it
        if (area === 'local' && changes.qah_sync && !!changes.qah_sync.newValue !== syncEnabled) {
            syncEnabled = !!changes.qah_sync.newValue;
            configArea().get('qah_config', (r) => {
                if (r && r.qah_config) Object.assign(config, r.qah_config);
                renderAll();
                applyDomainGate();
            });
            return;
        }
        if (area !== (syncEnabled ? 'sync' : 'local') || !changes.qah_config) return;
        const next = changes.qah_config.newValue;
        if (!next || JSON.stringify(next) === JSON.stringify(config)) return; // our own write
        Object.assign(config, next);
        renderAll();
        applyDomainGate();
    });

    function saveConfigToStorage(onDone) {
        configArea().set({ qah_config: config }, () => {
            const err = chrome.runtime.lastError; // e.g. sync quota exceeded
            if (onDone) onDone(err);
        });
    }

    // Toggle account sync. Turning it on adopts settings already in sync (so a second
    // device picks up the first one's), otherwise uploads this device's settings.
    // Turning it off keeps a local copy; the sync copy stays for other devices.
    function setSyncEnabled(on) {
        collectConfigFields();
        const done = (msgKey) => (err) => {
            const el = document.getElementById('qah-sync-status');
            if (!el) return;
            el.style.color = err ? 'var(--qah-err)' : 'var(--qah-ok)';
            el.textContent = err ? t('saveFail', err.message) : t(msgKey);
        };
        if (!on) {
            syncEnabled = false;
            chrome.storage.local.set({ qah_sync: false });
            saveConfigToStorage(done('syncOff'));
            return;
        }
        chrome.storage.sync.get('qah_config', (syn) => {
            if (chrome.runtime.lastError) {
                document.getElementById('qah-sync-on').checked = false;
                return done()(chrome.runtime.lastError);
            }
            syncEnabled = true;
            chrome.storage.local.set({ qah_sync: true });
            if (syn && syn.qah_config) {
                Object.assign(config, syn.qah_config);
                renderAll();
                applyDomainGate();
                done('syncPulled')();
            } else {
                saveConfigToStorage(done('syncOn'));
            }
        });
    }

    // ===== UI =====
    const btn = document.createElement('button');
    btn.id = 'qah-btn';
    // Toggle the "thinking" animation on every logo instance (floating button + panel header)
    function setLogoThinking(on) {
        document.querySelectorAll('#qah-btn .qah-logo, #qah-panel .qah-logo').forEach(el => {
            el.classList.toggle('qah-thinking', on);
            if (!on) { el.classList.remove('qah-settle'); void el.getBoundingClientRect(); el.classList.add('qah-settle'); }
        });
    }

    btn.innerHTML = LOGO_SVG;
    btn.setAttribute('aria-label', 'Quiz AI Helper');
    btn.title = 'Quiz AI Helper';
    btn.style.display = 'none'; // hidden until domain gate allows (avoids flash on disallowed sites)

    const panel = document.createElement('div');
    panel.id = 'qah-panel';
    panel.innerHTML = `
        <div class="qah-header">
            <div class="qah-brand"><span class="qah-brand-logo">${LOGO_SVG}</span>Quiz AI Helper</div>
            <button type="button" class="qah-close" id="qah-close" aria-label="${t('close')}">&times;</button>
        </div>
        <div class="qah-tabs">
            <div class="qah-tab active" data-tab="answer">${icon('answer')}<span>${t('tabAnswer')}</span></div>
            <div class="qah-tab" data-tab="docs">${icon('docs')}<span>${t('tabDocs')}</span></div>
            <div class="qah-tab" data-tab="ai">${icon('sparkle')}<span>${t('tabAi')}</span></div>
            <div class="qah-tab" data-tab="config">${icon('config')}<span>${t('tabConfig')}</span></div>
            <div class="qah-tab" data-tab="support">${icon('support')}<span>${t('tabSupport')}</span></div>
        </div>
        <div class="qah-section" id="qah-tab-answer"></div>
        <div class="qah-section" id="qah-tab-docs" style="display:none"></div>
        <div class="qah-section" id="qah-tab-ai" style="display:none"></div>
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
        ai: document.getElementById('qah-tab-ai'),
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
                <span style="font-size:11px;color:var(--qah-muted)">${t('docsLoaded', docCount)}${docCount ? t('pagesSuffix', totalPages) : ''}</span>
                <div style="display:flex;gap:6px">
                    <button class="qah-btn secondary" id="qah-screenshot">${icon('camera')}${t('btnScreenshot')}</button>
                    <button class="qah-btn accent" id="qah-ask-ai">${icon('sparkle')}${t('btnAsk')}</button>
                </div>
            </div>
            <div style="margin-bottom:10px">
                <label style="font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                    <input type="checkbox" id="qah-no-doc" ${noDocMode?'checked':''}>
                    <span>${t('noDoc')}</span>
                </label>
            </div>
            <div id="qah-question-preview">${!docCount && !noDocMode ? chip('alert', 'coral') : chip('bulb', 'gold')}<span class="qah-preview-text">${!docCount && !noDocMode ? t('needDocsWarn') : t('hint')}</span></div>
            <div id="qah-screenshot-preview" style="display:${screenshotBase64?'block':'none'};margin-bottom:10px">
                <img id="qah-screenshot-img" src="${screenshotBase64 ? 'data:image/png;base64,'+screenshotBase64 : ''}" style="max-width:100%;border-radius:6px;border:1px solid var(--qah-line)">
                <button class="qah-btn danger" id="qah-clear-screenshot" style="margin-top:6px;padding:4px 8px;font-size:11px">${icon('trash')}${t('clearShot')}</button>
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
                ? `<span style="color:var(--qah-teal);font-size:11px;font-weight:500;padding:4px 8px;white-space:nowrap">${t('loadedMark')}</span>`
                : `<button class="qah-btn secondary" data-load="${escHtml(u)}" style="padding:4px 8px;font-size:11px">${t('load')}</button>`;
            return `<div class="qah-pdf-item">
                ${chip('search', 'violet')}<span class="name" title="${escHtml(u)}">${escHtml(name)}</span>
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
                ${chip('file', fileTone(d.name))}<span class="name" title="${d.name}">${d.name}</span>
                <span class="meta">${d.pages ? t('pagesUnit', d.pages.length) : t('chunksUnit', Math.round(d.text.length/500))}</span>
                <button class="qah-btn danger" data-rm="${i}" style="padding:4px 8px;font-size:11px">${icon('trash')}${t('del')}</button>
            </div>
        `).join('') || `<div class="qah-empty">${chip('docs', 'teal')}<span>${t('noDocs')}</span></div>`;

        tabContainers.docs.innerHTML = `
            ${groupTitle('upload', 'teal', t('uploadLabel'))}
            <div class="qah-field">
                <input type="file" id="qah-pdf-file" accept=".pdf,.docx,.txt,.md,.markdown" multiple style="padding:6px">
            </div>
            ${groupTitle('link', 'blue', t('urlLabel'))}
            <div class="qah-field">
                <div style="display:flex;gap:8px">
                    <input id="qah-pdf-url" placeholder="${t('urlPh')}">
                    <button class="qah-btn" id="qah-load-url">${t('load')}</button>
                </div>
            </div>
            ${groupTitle('search', 'violet', t('scanLabel'))}
            <div class="qah-field">
                <button class="qah-btn secondary" id="qah-scan-pdfs" style="width:100%">${icon('search')}${t('scanBtn')}</button>
                <div id="qah-scan-result"></div>
            </div>
            <div style="margin-top:12px">
                ${groupTitle('docs', 'gold', t('loadedDocs'))}
                ${listHtml}
            </div>
            <div id="qah-load-status" style="font-size:11px;color:var(--qah-muted);margin-top:8px">${prevStatus.replace(/</g, '&lt;')}</div>
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
                box.innerHTML = `<div style="color:var(--qah-muted);font-size:11px;padding:6px 0">${t('scanNone')}</div>`;
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
            ${groupTitle('globe', 'teal', t('langLabel'))}
            <div class="qah-field">
                <select id="qah-language">
                    <option value="auto" ${config.language==='auto'?'selected':''}>${t('langAuto')}</option>
                    <option value="zh" ${config.language==='zh'?'selected':''}>中文</option>
                    <option value="en" ${config.language==='en'?'selected':''}>English</option>
                </select>
            </div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--qah-line)">
                ${groupTitle('shield', 'violet', t('domainsLabel'))}
                <div class="qah-field">
                    <textarea id="qah-domains" rows="3" placeholder="${t('domainsPh')}"></textarea>
                </div>
            </div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--qah-line)">
                ${groupTitle('keyboard', 'gold', t('hotkeyTitle'))}
                <div class="qah-field">
                    <label>${t('hotkeyToggle')}</label>
                    <input id="qah-hotkey-toggle" value="${config.hotkeyToggle}" placeholder="${t('hotkeyTogglePh')}">
                </div>
                <div class="qah-field">
                    <label>${t('hotkeyShot')}</label>
                    <input id="qah-hotkey-screenshot" value="${config.hotkeyScreenshot}" placeholder="${t('hotkeyShotPh')}">
                </div>
            </div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--qah-line)">
                ${groupTitle('cloud', 'teal', t('syncTitle'))}
                <label style="font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
                    <input type="checkbox" id="qah-sync-on" ${syncEnabled?'checked':''}>
                    <span>${t('syncLabel')}</span>
                </label>
                <div style="font-size:11px;color:var(--qah-muted);margin:6px 0 0 20px;line-height:1.6">${t('syncHint')}</div>
                <div id="qah-sync-status" style="font-size:11px;margin:4px 0 0 20px"></div>
            </div>
            <button class="qah-btn" id="qah-save-config" style="margin-top:12px">${icon('check')}${t('saveBtn')}</button>
            <span id="qah-save-status" style="margin-left:10px;font-size:11px;color:var(--qah-ok)"></span>
        `;
        document.getElementById('qah-domains').value = config.allowedDomains || '';
        document.getElementById('qah-language').onchange = (e) => {
            collectConfigFields(); // keep unsaved edits before the tab is rebuilt
            config.language = e.target.value;
            saveConfigToStorage();
            renderAll();
        };
        document.getElementById('qah-hotkey-toggle').onkeydown = captureHotkey;
        document.getElementById('qah-hotkey-screenshot').onkeydown = captureHotkey;
        document.getElementById('qah-save-config').onclick = () => saveConfig('qah-save-status');
        document.getElementById('qah-sync-on').onchange = (e) => setSyncEnabled(e.target.checked);
    }

    // AI tab: provider, endpoint / key / model, answer language. Has its own save
    // button; saving collects every field on both tabs (all tabs stay in the DOM).
    function renderAiTab() {
        tabContainers.ai.innerHTML = `
            ${groupTitle('cpu', 'blue', t('providerLabel'))}
            <div class="qah-field">
                <select id="qah-provider">
                    <option value="openai" ${config.provider==='openai'?'selected':''}>${t('openaiOpt')}</option>
                    <option value="anthropic" ${config.provider==='anthropic'?'selected':''}>Anthropic (Claude)</option>
                </select>
            </div>
            <div id="qah-provider-fields"></div>
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--qah-line)">
                ${groupTitle('globe', 'teal', t('answerLangLabel'))}
                <div class="qah-field">
                    <select id="qah-answer-lang">
                        <option value="question" ${config.answerLang==='question'?'selected':''}>${t('answerQuestion')}</option>
                        <option value="ui" ${config.answerLang==='ui'?'selected':''}>${t('answerUi')}</option>
                        <option value="zh" ${config.answerLang==='zh'?'selected':''}>中文</option>
                        <option value="en" ${config.answerLang==='en'?'selected':''}>English</option>
                    </select>
                </div>
            </div>
            <button class="qah-btn" id="qah-save-ai" style="margin-top:12px">${icon('check')}${t('saveBtn')}</button>
            <span id="qah-save-ai-status" style="margin-left:10px;font-size:11px;color:var(--qah-ok)"></span>
        `;
        renderProviderFields();
        document.getElementById('qah-answer-lang').onchange = (e) => {
            config.answerLang = e.target.value;
            saveConfigToStorage();
        };
        document.getElementById('qah-provider').onchange = (e) => {
            config.provider = e.target.value;
            renderProviderFields();
        };
        document.getElementById('qah-save-ai').onclick = () => saveConfig('qah-save-ai-status');
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
                <div class="qah-chip coral" style="width:44px;height:44px;border-radius:14px;margin-bottom:10px"><svg class="qah-ic" style="width:22px;height:22px" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICON_PATHS.heart}</svg></div>
                <div style="font-size:16px;font-weight:600;color:var(--qah-ink);margin-bottom:8px">${t('supportTitle')}</div>
                <p style="color:var(--qah-muted);font-size:12px;margin-bottom:16px;line-height:1.6">${t('supportText')}</p>
                <img src="${chrome.runtime.getURL('images/buy-me-a-coffee.jpeg')}" style="max-width:220px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.1)">
                <p style="color:var(--qah-muted);font-size:12px;margin-top:16px">${t('author')}</p>
                <p style="color:var(--qah-muted);font-size:11px;margin-top:4px">${t('contact')}</p>
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

    function saveConfig(statusId) {
        collectConfigFields();
        applyDomainGate();
        saveConfigToStorage((err) => {
            const el = document.getElementById(statusId);
            if (!el) return;
            el.style.color = err ? 'var(--qah-err)' : 'var(--qah-ok)';
            el.textContent = err ? t('saveFail', err.message) : t('saved');
            if (err) return; // keep the error visible
            setTimeout(() => { const s = document.getElementById(statusId); if (s) s.textContent = ''; }, 2000);
        });
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

    // Hint bar under the buttons: coloured chip + text; ok/fail get their own chip
    function setPreview(el, text) {
        const tone = /^\u2717/.test(text) ? chip('alert', 'err') : /^\u2713/.test(text) ? chip('check', 'teal') : chip('bulb', 'gold');
        el.innerHTML = tone + '<span class="qah-preview-text"></span>';
        el.querySelector('.qah-preview-text').textContent = text;
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
                if (preview) setPreview(preview, t('shotOk'));
                renderAnswerTab();
            } else {
                if (preview) setPreview(preview, t('shotFail', resp && resp.error || t('unknown')));
            }
        } catch(e) {
            panel.style.display = '';
            btn.style.display = '';
            panel.classList.add('show');
            if (preview) setPreview(preview, t('shotFail', e.message));
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
                    if (preview) setPreview(preview, t('pasteOk'));
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

        setLogoThinking(true);
        try {
            let answer;
            if (config.provider === 'openai') {
                answer = await callOpenAI(systemPrompt, userText, screenshotBase64);
            } else {
                answer = await callAnthropic(systemPrompt, userText, screenshotBase64);
            }
            try { await ensureLib('lib/marked.min.js'); } catch(e) { /* fall back to plain text */ }
            answerArea.innerHTML = `<div class="qah-answer-box"><div class="qah-answer-head">${chip('answer', 'gold')}<span>${t('answerTitle')}</span></div>${renderMarkdown(answer)}</div>`;
        } catch(e) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${e.message}</div>`;
        } finally {
            setLogoThinking(false);
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
        tabEls.forEach(el => { el.querySelector('span').textContent = t('tab' + el.dataset.tab.charAt(0).toUpperCase() + el.dataset.tab.slice(1)); });
        renderAnswerTab();
        renderDocsTab();
        renderAiTab();
        renderConfigTab();
        renderSupportTab();
        document.getElementById('qah-question').value = qVal;
        document.getElementById('qah-answer-area').innerHTML = aHtml;
    }

    renderAll();
}
