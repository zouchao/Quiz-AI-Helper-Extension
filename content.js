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
    const I18N = window.QAH_I18N; // defined in i18n.js

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
        #qah-btn,#qah-panel{--qah-ink:#1F2A44;--qah-ink-2:#2E3D5E;--qah-gold:#F2A93B;--qah-gold-soft:#FCEBCB;--qah-paper:#FBF7EF;--qah-text:#2B2A27;--qah-muted:#6B6458;--qah-line:#E8E1D3;--qah-soft:#F4EEE2;--qah-bg:#fff;--qah-ok:#2F7D5B;--qah-err:#B4412F;--qah-err-soft:#FBEDEA;--qah-teal:#2A8C82;--qah-teal-soft:#DDF1EE;--qah-coral:#D9634A;--qah-coral-soft:#FBE4DD;--qah-blue:#3B6FD4;--qah-blue-soft:#E1EAFB;--qah-violet:#7A5CC9;--qah-violet-soft:#ECE6F8}
        #qah-btn{position:fixed;bottom:20px;right:20px;z-index:2147483647;width:48px;height:48px;border-radius:14px;background:var(--qah-ink);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 2px rgba(31,42,68,.2),0 6px 16px rgba(31,42,68,.22);transition:transform .18s ease,box-shadow .18s ease}
        #qah-btn:hover{transform:translateY(-2px);box-shadow:0 2px 4px rgba(31,42,68,.2),0 10px 22px rgba(31,42,68,.28)}
        #qah-btn:active{transform:translateY(0)}
        #qah-btn svg{width:30px;height:30px;display:block}
        #qah-btn .qah-mark-pick{transform-origin:5px 12px;transform-box:view-box;transition:transform .18s ease}
        #qah-btn:hover .qah-mark-pick{transform:scale(1.15)}
        #qah-panel{position:fixed;top:50%;right:20px;transform:translateY(-50%);z-index:2147483646;width:560px;max-width:calc(100vw - 40px);max-height:85vh;background:var(--qah-bg);border:1px solid var(--qah-line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);display:none;flex-direction:column;font-family:-apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;color:var(--qah-text);accent-color:var(--qah-ink);overflow:hidden}
        #qah-panel.show{display:flex}
        #qah-btn:focus-visible,#qah-panel :focus-visible{outline:2px solid var(--qah-ink);outline-offset:2px}
        .qah-header{padding:12px 16px;background:var(--qah-paper);color:var(--qah-ink);font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--qah-line)}
        .qah-brand{display:flex;align-items:center;gap:10px;letter-spacing:.01em}
        .qah-brand-logo{width:26px;height:26px;border-radius:8px;background:var(--qah-ink);display:flex;align-items:center;justify-content:center}
        .qah-brand-logo svg{width:18px;height:18px;display:block}
        .qah-close{background:none;border:none;color:var(--qah-muted);font-size:20px;line-height:1;width:28px;height:28px;border-radius:6px;cursor:pointer;padding:0}
        .qah-close:hover{background:var(--qah-soft);color:var(--qah-ink)}
        .qah-tabs{display:flex;gap:4px;padding:0 12px;border-bottom:1px solid var(--qah-line);background:var(--qah-paper)}
        .qah-ic{width:16px;height:16px;flex:none;display:inline-block;vertical-align:-3px}
        .qah-tab{display:flex;align-items:center;gap:6px;padding:10px 10px;margin-bottom:-1px;cursor:pointer;font-size:12px;font-weight:500;color:var(--qah-muted);border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
        .qah-tab .qah-ic{width:15px;height:15px;opacity:.75;transition:opacity .15s}
        .qah-tab.active .qah-ic,.qah-tab:hover .qah-ic{opacity:1}
        .qah-tab[data-tab=answer] .qah-ic{color:var(--qah-gold)}.qah-tab[data-tab=docs] .qah-ic{color:var(--qah-teal)}.qah-tab[data-tab=config] .qah-ic{color:var(--qah-blue)}.qah-tab[data-tab=support] .qah-ic{color:var(--qah-coral)}
        .qah-chip{width:28px;height:28px;border-radius:8px;flex:none;display:inline-flex;align-items:center;justify-content:center}
        .qah-chip .qah-ic{width:15px;height:15px}
        .qah-chip.gold{background:var(--qah-gold-soft);color:#B8761A}.qah-chip.teal{background:var(--qah-teal-soft);color:var(--qah-teal)}.qah-chip.coral{background:var(--qah-coral-soft);color:var(--qah-coral)}.qah-chip.blue{background:var(--qah-blue-soft);color:var(--qah-blue)}.qah-chip.violet{background:var(--qah-violet-soft);color:var(--qah-violet)}.qah-chip.err{background:#F6D7D0;color:var(--qah-err)}
        .qah-group-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--qah-ink);margin:2px 0 10px}
        .qah-group-title .qah-chip{width:22px;height:22px;border-radius:6px}.qah-group-title .qah-chip .qah-ic{width:13px;height:13px}
        .qah-tab.active{color:var(--qah-ink);font-weight:600;border-bottom-color:var(--qah-gold)}
        .qah-tab:hover{color:var(--qah-ink)}
        .qah-section{padding:14px 16px;overflow-y:auto;flex:1}
        .qah-field{margin-bottom:12px}
        .qah-field label{display:block;font-size:12px;font-weight:500;color:var(--qah-text);margin-bottom:4px}
        .qah-field input,.qah-field select,.qah-field textarea{width:100%;padding:8px 10px;border:1px solid var(--qah-line);border-radius:6px;font-size:13px;color:var(--qah-text);background:var(--qah-bg);outline:none;box-sizing:border-box;font-family:inherit}
        .qah-field input:focus,.qah-field select:focus,.qah-field textarea:focus{border-color:var(--qah-ink);box-shadow:0 0 0 3px var(--qah-gold-soft)}
        .qah-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;padding:7px 14px;border-radius:6px;border:1px solid var(--qah-ink);background:var(--qah-ink);color:#fff;font-size:12px;cursor:pointer;font-weight:500;font-family:inherit;transition:background .15s,border-color .15s}
        .qah-btn:hover{background:var(--qah-ink-2);border-color:var(--qah-ink-2)}
        .qah-btn.accent{background:var(--qah-gold);border-color:var(--qah-gold);color:var(--qah-ink);font-weight:600}
        .qah-btn.accent:hover{background:#E99A22;border-color:#E99A22}
        .qah-btn.secondary{background:var(--qah-bg);color:var(--qah-text);border-color:var(--qah-line)}
        .qah-btn .qah-ic{width:14px;height:14px}
        .qah-btn.secondary .qah-ic{color:var(--qah-teal)}
        .qah-btn.secondary:hover{background:var(--qah-soft)}
        .qah-btn.danger{background:var(--qah-bg);color:var(--qah-err);border-color:var(--qah-line)}
        .qah-btn.danger:hover{background:var(--qah-err-soft);border-color:#F0C9C1}
        .qah-pdf-item{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;background:var(--qah-bg);transition:border-color .15s;border:1px solid var(--qah-line);border-radius:6px;margin-bottom:6px;font-size:12px}
        .qah-pdf-item:hover{border-color:#D8CDB8}
        .qah-pdf-item .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .qah-pdf-item .meta{color:var(--qah-muted);font-size:11px;background:var(--qah-soft);padding:2px 8px;border-radius:999px}
        .qah-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--qah-muted);text-align:center;padding:18px;border:1px dashed var(--qah-line);border-radius:8px;font-size:12px}
        .qah-empty .qah-chip{width:40px;height:40px;border-radius:12px}.qah-empty .qah-chip .qah-ic{width:20px;height:20px}
        .qah-status{display:flex;align-items:center;gap:6px}.qah-status:empty{display:none}
        .qah-answer-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--qah-ink);margin:-2px 0 10px;padding-bottom:10px;border-bottom:1px dashed var(--qah-line)}
        .qah-answer-head .qah-chip{width:22px;height:22px;border-radius:6px}.qah-answer-head .qah-chip .qah-ic{width:13px;height:13px}
        .qah-answer-box{background:var(--qah-paper);border:1px solid var(--qah-line);border-left:3px solid var(--qah-gold);border-radius:8px;padding:12px 14px;margin-top:10px;line-height:1.7;font-size:13px}
        .qah-answer-box p{margin:0 0 8px}
        .qah-answer-box ul,.qah-answer-box ol{margin:4px 0;padding-left:20px}
        .qah-answer-box code{background:var(--qah-soft);padding:1px 4px;border-radius:3px;font-size:12px}
        .qah-answer-box pre{background:var(--qah-soft);color:var(--qah-text);border:1px solid var(--qah-line);padding:10px 12px;border-radius:6px;overflow-x:auto;font-size:12px}
        .qah-answer-box pre code{background:none;padding:0;color:inherit}
        .qah-answer-box strong{font-weight:600;color:var(--qah-ink)}
        .qah-answer-box.error{background:var(--qah-err-soft);border-color:#F0C9C1;border-left-color:var(--qah-err);color:var(--qah-err)}
        .qah-loading{text-align:center;padding:20px;color:var(--qah-muted)}
        .qah-loading::after{content:'';display:inline-block;width:14px;height:14px;border:2px solid var(--qah-line);border-top-color:var(--qah-gold);border-radius:50%;animation:qahspin 0.8s linear infinite;margin-left:8px;vertical-align:middle}
        @keyframes qahspin{to{transform:rotate(360deg)}}
        @media (prefers-reduced-motion:reduce){#qah-btn,#qah-panel *{transition:none!important}.qah-loading::after{animation-duration:2s}}
        #qah-question-preview{display:flex;align-items:flex-start;gap:10px;background:var(--qah-paper);border:1px dashed var(--qah-line);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12px;max-height:120px;overflow-y:auto;line-height:1.6;color:var(--qah-muted)}
        #qah-question-preview .qah-chip{margin-top:-2px}
        #qah-question-preview .qah-preview-text{flex:1;padding-top:3px}
    `;
    document.head.appendChild(style);

    // ===== UI =====
    const btn = document.createElement('button');
    btn.id = 'qah-btn';
    // Logo: an answer sheet with three options; the middle bubble is ticked in gold (the picked answer), sparkle = AI
    const LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="5" cy="5" r="2.1" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="1.6"/>'
        + '<path d="M10 5h7" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="2"/>'
        + '<g class="qah-mark-pick"><circle cx="5" cy="12" r="3.3" fill="#F2A93B"/>'
        + '<path d="M3.6 12.1l1 1 1.9-2.1" stroke="#1F2A44" stroke-width="1.5"/></g>'
        + '<path d="M10.5 12h10" stroke="#FBF7EF" stroke-width="2.2"/>'
        + '<circle cx="5" cy="19" r="2.1" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="1.6"/>'
        + '<path d="M10 19h5" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="2"/>'
        + '<path d="M20.5 2.2l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z" fill="#F2A93B"/>'
        + '</svg>';
    // Line icons (Lucide-style, 24 grid, stroke=currentColor); colour comes from the wrapping element
    const ICON_PATHS = {
        answer: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        docs: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
        config: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
        support: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
        camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
        sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
        file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
        trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
        bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
        alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        check: '<path d="M20 6L9 17l-5-5"/>',
        globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
        cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8"/>',
        heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'
    };
    const icon = (name) => '<svg class="qah-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATHS[name] + '</svg>';
    const chip = (name, tone) => '<span class="qah-chip ' + tone + '">' + icon(name) + '</span>';
    const groupTitle = (name, tone, text) => '<div class="qah-group-title">' + chip(name, tone) + '<span>' + text + '</span></div>';
    // File-type chip colour: PDF coral, Word blue, text/markdown teal
    const fileTone = (name) => /\.pdf$/i.test(name) ? 'coral' : /\.docx?$/i.test(name) ? 'blue' : 'teal';

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
            <div class="qah-tab" data-tab="config">${icon('config')}<span>${t('tabConfig')}</span></div>
            <div class="qah-tab" data-tab="support">${icon('support')}<span>${t('tabSupport')}</span></div>
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
            <div class="qah-field">
                <label>${t('answerLangLabel')}</label>
                <select id="qah-answer-lang">
                    <option value="question" ${config.answerLang==='question'?'selected':''}>${t('answerQuestion')}</option>
                    <option value="ui" ${config.answerLang==='ui'?'selected':''}>${t('answerUi')}</option>
                    <option value="zh" ${config.answerLang==='zh'?'selected':''}>中文</option>
                    <option value="en" ${config.answerLang==='en'?'selected':''}>English</option>
                </select>
            </div>
            ${groupTitle('cpu', 'blue', t('providerLabel'))}
            <div class="qah-field">
                <select id="qah-provider">
                    <option value="openai" ${config.provider==='openai'?'selected':''}>${t('openaiOpt')}</option>
                    <option value="anthropic" ${config.provider==='anthropic'?'selected':''}>Anthropic (Claude)</option>
                </select>
            </div>
            <div id="qah-provider-fields"></div>
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
            <button class="qah-btn" id="qah-save-config" style="margin-top:12px">${icon('check')}${t('saveBtn')}</button>
            <span id="qah-save-status" style="margin-left:10px;font-size:11px;color:var(--qah-ok)"></span>
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
        renderConfigTab();
        renderSupportTab();
        document.getElementById('qah-question').value = qVal;
        document.getElementById('qah-answer-area').innerHTML = aHtml;
    }

    renderAll();
})();
