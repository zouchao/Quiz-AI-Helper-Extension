import { I18N } from './i18n.js';
import { LOGO_SVG, ICON_PATHS, icon, brandIcon, chip, groupTitle, fileTone } from './icons.js';
import { PROVIDER_PRESETS, ANTHROPIC_MODELS, presetById, presetOf } from './providers.js';

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
    let screenshots = []; // [base64 JPEG], sent to the AI in order
    const MAX_SHOTS = 20;      // keeps requests under provider size limits (Anthropic: 32 MB)
    const SHOT_MAX_EDGE = 2576; // long edge, px; current Claude / GPT vision models downscale beyond this
    let pdfDocs = []; // [{name, text}] - stores all document types
    let noDocMode = false;
    let lastScanUrls = [];        // survives re-render so you can load several PDFs from one scan
    let loadedScanUrls = new Set(); // scanned URLs already loaded, shown as ✓ Loaded
    let config = Object.assign({
        providers: [],         // [{id, preset, name, protocol, baseUrl, apiKey, model}], see providers.js
        activeProvider: '',    // id of the one used for answering
        hotkeyToggle: 'Alt+Q',
        hotkeyScreenshot: 'Alt+A',
        allowedDomains: '',
        language: 'auto',      // 'auto' | 'zh' | 'en' (UI + prompt language)
        theme: 'auto',         // 'auto' | 'light' | 'dark' (auto follows prefers-color-scheme)
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

    // ===== Theme =====
    // Sets data-theme on #qah-btn / #qah-panel; style.css swaps the --qah-* tokens.
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme() {
        const dark = config.theme === 'dark' || (config.theme !== 'light' && darkQuery.matches);
        btn.dataset.theme = panel.dataset.theme = viewer.dataset.theme = dark ? 'dark' : 'light';
    }
    darkQuery.addEventListener('change', () => { if (config.theme === 'auto') applyTheme(); });

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
            const migrated = stored && applyStoredConfig(stored);
            // Sync on but nothing uploaded yet (e.g. sync data cleared): seed it from this device
            if ((syncEnabled && !synced && loc.qah_config) || migrated) saveConfigToStorage();
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
                if (r && r.qah_config) applyStoredConfig(r.qah_config);
                renderAll();
                applyDomainGate();
            });
            return;
        }
        if (area !== (syncEnabled ? 'sync' : 'local') || !changes.qah_config) return;
        const next = changes.qah_config.newValue;
        if (!next || JSON.stringify(next) === JSON.stringify(config)) return; // our own write
        applyStoredConfig(next);
        renderAll();
        applyDomainGate();
    });

    // Merge a stored config into `config`. Configs from before multi-provider support
    // (provider / apiKey / baseUrl / model / anthropic*) become provider entries.
    // Returns true when such a migration happened, so the caller can persist it.
    const LEGACY_KEYS = ['provider', 'apiKey', 'baseUrl', 'model', 'anthropicKey', 'anthropicBaseUrl', 'anthropicModel'];
    function applyStoredConfig(stored) {
        Object.assign(config, stored);
        const legacy = !Array.isArray(stored.providers);
        if (legacy) {
            config.providers = [];
            const add = (protocol, baseUrl, apiKey, model) => {
                const entry = newProvider(guessPreset(protocol, baseUrl), { baseUrl, apiKey, model });
                config.providers.push(entry);
                return entry.id;
            };
            let openaiId, antId;
            if (stored.apiKey || stored.provider !== 'anthropic') {
                openaiId = add('openai', stored.baseUrl || 'https://api.openai.com/v1', stored.apiKey || '', stored.model || 'gpt-4o');
            }
            if (stored.anthropicKey || stored.provider === 'anthropic') {
                antId = add('anthropic', stored.anthropicBaseUrl || 'https://api.anthropic.com', stored.anthropicKey || '', stored.anthropicModel || '');
            }
            config.activeProvider = (stored.provider === 'anthropic' ? antId : openaiId) || '';
        }
        LEGACY_KEYS.forEach(k => delete config[k]);
        if (!activeProvider()) config.activeProvider = config.providers.length ? config.providers[0].id : '';
        return legacy;
    }

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
                applyStoredConfig(syn.qah_config);
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

    // Screenshot lightbox (see "Image viewer" below); mounted alongside btn/panel by attachUI()
    const viewer = document.createElement('div');
    viewer.id = 'qah-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');

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
            container.appendChild(viewer);
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
    function docCountText() {
        const totalPages = pdfDocs.reduce((s, d) => s + (d.pages ? d.pages.length : 1), 0);
        return t('docsLoaded', pdfDocs.length) + (pdfDocs.length ? t('pagesSuffix', totalPages) : '');
    }

    // Default hint bar: "load docs first" warning, or the usage hint once docs (or no-doc mode) are set
    function defaultPreviewHtml() {
        const warn = !pdfDocs.length && !noDocMode;
        return `${warn ? chip('alert', 'coral') : chip('bulb', 'gold')}<span class="qah-preview-text">${warn ? t('needDocsWarn') : t('hint')}</span>`;
    }

    // Refresh the answer tab's doc count + hint in place after docs or no-doc mode change,
    // without re-rendering it (that would wipe the typed question and the answer).
    // A screenshot/paste status in the hint bar is left alone.
    function updateDocStatus() {
        const countEl = document.getElementById('qah-doc-count');
        if (countEl) countEl.textContent = docCountText();
        const preview = document.getElementById('qah-question-preview');
        const text = preview && preview.querySelector('.qah-preview-text');
        if (text && (text.textContent === t('needDocsWarn') || text.textContent === t('hint'))) {
            preview.innerHTML = defaultPreviewHtml();
        }
    }

    function renderAnswerTab() {
        tabContainers.answer.innerHTML = `
            <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
                <span id="qah-doc-count" style="font-size:11px;color:var(--qah-muted)">${docCountText()}</span>
                <div style="display:flex;gap:6px;align-items:center">
                    <span id="qah-quick-provider"></span>
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
            <div id="qah-question-preview">${defaultPreviewHtml()}</div>
            <div id="qah-shots"></div>
            <div class="qah-field">
                <label>${t('questionLabel')}</label>
                <textarea id="qah-question" rows="4" placeholder="${t('questionPh')}"></textarea>
            </div>
            <div id="qah-answer-area"></div>
        `;
        document.getElementById('qah-screenshot').onclick = captureScreenshot;
        document.getElementById('qah-ask-ai').onclick = askAI;
        document.getElementById('qah-no-doc').onchange = (e) => { noDocMode = e.target.checked; updateDocStatus(); };
        renderShots();
        renderQuickProvider();
    }

    // Thumbnail strip for the screenshot list. Re-rendered on its own so adding or
    // removing an image keeps the typed question and the last answer.
    function renderShots() {
        const box = document.getElementById('qah-shots');
        if (!box) return;
        if (!screenshots.length) { box.innerHTML = ''; return; }
        box.innerHTML = `
            <div class="qah-shots-head">
                <span>${t('shotCount', screenshots.length, MAX_SHOTS)}</span>
                <button class="qah-btn danger" id="qah-clear-shots">${icon('trash')}${t('clearShots')}</button>
            </div>
            <div class="qah-shots-list">
                ${screenshots.map((b64, i) => `
                    <div class="qah-shot" draggable="true" data-shot="${i}">
                        <img src="data:image/jpeg;base64,${b64}" data-view="${i}" alt="${t('shotAlt', i + 1)}" title="${t('shotView')}" draggable="false" tabindex="0" role="button">
                        <span class="qah-shot-num">${i + 1}</span>
                        <button type="button" class="qah-shot-rm" data-rm-shot="${i}" aria-label="${t('del')}" title="${t('del')}">&times;</button>
                        <div class="qah-shot-move">
                            <button type="button" data-move-shot="${i}" data-dir="-1" aria-label="${t('shotMoveUp')}" title="${t('shotMoveUp')}" ${i === 0 ? 'disabled' : ''}>&lsaquo;</button>
                            <button type="button" data-move-shot="${i}" data-dir="1" aria-label="${t('shotMoveDown')}" title="${t('shotMoveDown')}" ${i === screenshots.length - 1 ? 'disabled' : ''}>&rsaquo;</button>
                        </div>
                    </div>`).join('')}
            </div>
            ${screenshots.length > 1 ? `<div class="qah-shots-tip">${t('shotReorderTip')}</div>` : ''}
        `;
        document.getElementById('qah-clear-shots').onclick = () => { screenshots = []; renderShots(); resetShotHint(); };
        box.querySelectorAll('[data-rm-shot]').forEach(b => {
            b.onclick = () => removeShot(parseInt(b.dataset.rmShot));
        });
        // Reorder: the ‹ / › buttons swap with a neighbour, drag and drop moves to any position
        box.querySelectorAll('[data-move-shot]').forEach(b => {
            b.onclick = () => {
                const from = parseInt(b.dataset.moveShot);
                moveShot(from, from + parseInt(b.dataset.dir));
                const again = box.querySelector(`[data-move-shot="${from + parseInt(b.dataset.dir)}"][data-dir="${b.dataset.dir}"]`);
                if (again && !again.disabled) again.focus(); // keep keyboard focus on the moved image
            };
        });
        let dragFrom = null;
        box.querySelectorAll('.qah-shot').forEach(el => {
            const idx = parseInt(el.dataset.shot);
            el.ondragstart = (e) => {
                dragFrom = idx;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(idx)); // Firefox won't start a drag without data
                el.classList.add('dragging');
            };
            el.ondragend = () => {
                dragFrom = null;
                box.querySelectorAll('.qah-shot').forEach(x => x.classList.remove('dragging', 'drop-before', 'drop-after'));
            };
            el.ondragover = (e) => {
                if (dragFrom === null) return; // ignore files / text dragged in from the page
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const after = e.clientX > el.getBoundingClientRect().left + el.offsetWidth / 2;
                el.classList.toggle('drop-before', !after);
                el.classList.toggle('drop-after', after);
            };
            el.ondragleave = () => el.classList.remove('drop-before', 'drop-after');
            el.ondrop = (e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                const after = e.clientX > el.getBoundingClientRect().left + el.offsetWidth / 2;
                // target index after the dragged item is taken out of the list
                let to = idx + (after ? 1 : 0);
                if (dragFrom < to) to--;
                moveShot(dragFrom, to);
            };
        });
        box.querySelectorAll('[data-view]').forEach(img => {
            img.onclick = () => openViewer(parseInt(img.dataset.view));
            img.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(parseInt(img.dataset.view)); } };
        });
    }

    // ===== Image viewer =====
    // In-page lightbox for the screenshot list: zoom (wheel / buttons / keys), drag to pan,
    // ‹ › to step through. A sibling of #qah-panel, not a child: the panel's transform
    // would make a position:fixed child cover only the panel.
    const ZOOM_MIN = 0.1, ZOOM_MAX = 8, ZOOM_STEP = 1.25;
    // fit: zoom that fits the whole image in the window (recomputed on resize)
    const view = { index: 0, zoom: 1, fit: 1, x: 0, y: 0, open: false };

    function renderViewer() {
        viewer.innerHTML = `
            <div class="qah-viewer-stage">
                <img class="qah-viewer-img" alt="" draggable="false">
            </div>
            <div class="qah-viewer-bar">
                <button type="button" data-v="prev" aria-label="${t('viewerPrev')}" title="${t('viewerPrev')} (←)">&lsaquo;</button>
                <span class="qah-viewer-count"></span>
                <button type="button" data-v="next" aria-label="${t('viewerNext')}" title="${t('viewerNext')} (→)">&rsaquo;</button>
                <span class="qah-viewer-sep"></span>
                <button type="button" data-v="out" aria-label="${t('viewerZoomOut')}" title="${t('viewerZoomOut')} (−)">&minus;</button>
                <span class="qah-viewer-zoom"></span>
                <button type="button" data-v="in" aria-label="${t('viewerZoomIn')}" title="${t('viewerZoomIn')} (+)">+</button>
                <button type="button" data-v="fit" class="qah-viewer-text">${t('viewerFit')}</button>
                <button type="button" data-v="actual" class="qah-viewer-text">1:1</button>
                <span class="qah-viewer-sep"></span>
                <button type="button" data-v="delete" class="qah-viewer-del" aria-label="${t('viewerDelete')}" title="${t('viewerDelete')} (Delete)">${icon('trash')}</button>
            </div>
            <button type="button" class="qah-viewer-close" data-v="close" aria-label="${t('close')}" title="${t('close')} (Esc)">&times;</button>
        `;
        viewer.setAttribute('aria-label', t('viewerTitle'));
        const actions = {
            prev: () => showViewerImage(view.index - 1),
            next: () => showViewerImage(view.index + 1),
            in: () => zoomViewer(view.zoom * ZOOM_STEP),
            out: () => zoomViewer(view.zoom / ZOOM_STEP),
            fit: () => resetViewerZoom(),
            actual: () => zoomViewer(1),
            close: () => closeViewer(),
            delete: () => deleteViewerImage(),
        };
        viewer.querySelectorAll('[data-v]').forEach(b => { b.onclick = (e) => { e.stopPropagation(); actions[b.dataset.v](); }; });

        const stage = viewer.querySelector('.qah-viewer-stage');
        const img = viewer.querySelector('.qah-viewer-img');
        // Click on the dark backdrop closes; clicks on the image don't
        stage.onclick = (e) => { if (e.target === stage && !panState.moved) closeViewer(); };
        img.ondblclick = () => (Math.abs(view.zoom - view.fit) < 0.001 ? zoomViewer(1, centerOf(img)) : resetViewerZoom());
        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            zoomViewer(view.zoom * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), { x: e.clientX, y: e.clientY });
        }, { passive: false });
        const panState = { active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
        img.onpointerdown = (e) => {
            if (e.button !== 0) return;
            panState.active = true; panState.moved = false;
            panState.sx = e.clientX; panState.sy = e.clientY; panState.ox = view.x; panState.oy = view.y;
            img.setPointerCapture(e.pointerId);
            img.classList.add('panning');
        };
        img.onpointermove = (e) => {
            if (!panState.active) return;
            const dx = e.clientX - panState.sx, dy = e.clientY - panState.sy;
            if (Math.abs(dx) + Math.abs(dy) > 3) panState.moved = true;
            view.x = panState.ox + dx; view.y = panState.oy + dy;
            applyViewerTransform();
        };
        img.onpointerup = img.onpointercancel = () => { panState.active = false; img.classList.remove('panning'); };
    }

    const centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

    function applyViewerTransform() {
        const img = viewer.querySelector('.qah-viewer-img');
        if (!img) return;
        img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
        img.classList.toggle('zoomed', view.zoom > view.fit + 0.001);
        const z = viewer.querySelector('.qah-viewer-zoom');
        if (z) z.textContent = Math.round(view.zoom * 100) + '%';
    }

    // Zoom around a screen point (default: window centre), keeping that point fixed
    function zoomViewer(next, at) {
        next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const p = at || { x: cx, y: cy };
        const k = next / view.zoom;
        view.x = (p.x - cx) - k * ((p.x - cx) - view.x);
        view.y = (p.y - cy) - k * ((p.y - cy) - view.y);
        view.zoom = next;
        applyViewerTransform();
    }

    function resetViewerZoom() {
        const img = viewer.querySelector('.qah-viewer-img');
        if (!img || !img.naturalWidth) return;
        // leave room for the toolbar at the bottom and a margin all round
        view.fit = Math.min(1, (window.innerWidth - 80) / img.naturalWidth, (window.innerHeight - 140) / img.naturalHeight);
        view.zoom = view.fit; view.x = 0; view.y = 0;
        applyViewerTransform();
    }

    function showViewerImage(i) {
        if (!screenshots.length) return closeViewer();
        view.index = (i + screenshots.length) % screenshots.length; // wraps around
        const img = viewer.querySelector('.qah-viewer-img');
        img.onload = resetViewerZoom;
        img.src = 'data:image/jpeg;base64,' + screenshots[view.index];
        img.alt = t('shotAlt', view.index + 1);
        viewer.querySelector('.qah-viewer-count').textContent = `${view.index + 1} / ${screenshots.length}`;
        const single = screenshots.length < 2;
        viewer.querySelectorAll('[data-v="prev"],[data-v="next"]').forEach(b => { b.disabled = single; });
    }

    // Delete the image on screen, then show the one that moved into its place (the next one),
    // or the new last image if it was the last; close when none are left
    function deleteViewerImage() {
        removeShot(view.index);
        if (!screenshots.length) return closeViewer();
        showViewerImage(Math.min(view.index, screenshots.length - 1));
    }

    let viewerReturnFocus = null;
    function openViewer(i) {
        viewerReturnFocus = document.activeElement;
        renderViewer();
        view.open = true;
        viewer.classList.add('show');
        showViewerImage(i);
        viewer.querySelector('[data-v="close"]').focus();
    }

    function closeViewer() {
        if (!view.open) return;
        view.open = false;
        viewer.classList.remove('show');
        viewer.innerHTML = ''; // drop the full-size image
        // The thumbnail that opened the viewer may be gone (deleted, or the grid re-rendered):
        // focus the one now shown at the same position, else the screenshot button
        const target = (viewerReturnFocus && viewerReturnFocus.isConnected) ? viewerReturnFocus
            : document.querySelector(`#qah-shots [data-view="${Math.min(view.index, screenshots.length - 1)}"]`) || document.getElementById('qah-screenshot');
        if (target) target.focus();
    }

    // Capture phase so the page and our own hotkeys don't also act on these keys
    document.addEventListener('keydown', (e) => {
        if (!view.open) return;
        const keys = {
            Escape: closeViewer, ArrowLeft: () => showViewerImage(view.index - 1), ArrowRight: () => showViewerImage(view.index + 1),
            '+': () => zoomViewer(view.zoom * ZOOM_STEP), '=': () => zoomViewer(view.zoom * ZOOM_STEP),
            '-': () => zoomViewer(view.zoom / ZOOM_STEP), '0': resetViewerZoom, '1': () => zoomViewer(1),
            Delete: deleteViewerImage, Backspace: deleteViewerImage,
        };
        if (keys[e.key]) { e.preventDefault(); e.stopPropagation(); keys[e.key](); }
        else if (e.key === 'Tab') {
            // keep focus inside the dialog
            const f = [...viewer.querySelectorAll('button:not(:disabled)')];
            const i = f.indexOf(document.activeElement);
            e.preventDefault();
            f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
    }, true);
    window.addEventListener('resize', () => { if (view.open) resetViewerZoom(); });

    // Removing images makes an "N added" status stale, so fall back to the default hint
    function resetShotHint() {
        const preview = document.getElementById('qah-question-preview');
        if (preview) preview.innerHTML = defaultPreviewHtml();
    }

    // Shared by the thumbnail × and the viewer's delete button
    function removeShot(i) {
        screenshots.splice(i, 1);
        renderShots();
        resetShotHint();
    }

    function moveShot(from, to) {
        if (to < 0 || to >= screenshots.length || from === to) return;
        const [shot] = screenshots.splice(from, 1);
        screenshots.splice(to, 0, shot);
        renderShots();
    }

    // Re-encode any image (PNG capture, pasted file) as JPEG with the long edge capped at
    // SHOT_MAX_EDGE: Retina PNGs are 1-3 MB each, JPEG brings them to a few hundred KB.
    function toJpegBase64(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.naturalWidth * scale);
                canvas.height = Math.round(img.naturalHeight * scale);
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; // transparent pasted PNGs would otherwise turn black
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
            };
            img.onerror = () => reject(new Error(t('imageDecodeFail')));
            img.src = src;
        });
    }

    // Append a screenshot; returns false (and shows why) when the list is full
    async function addShot(src, okKey) {
        const preview = document.getElementById('qah-question-preview');
        if (screenshots.length >= MAX_SHOTS) {
            if (preview) setPreview(preview, t('shotLimit', MAX_SHOTS));
            return false;
        }
        screenshots.push(await toJpegBase64(src));
        renderShots();
        if (preview) setPreview(preview, t(okKey, screenshots.length));
        return true;
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
        updateDocStatus(); // every doc load / delete ends here
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
                ${groupTitle('moon', 'blue', t('themeLabel'))}
                <div class="qah-field">
                    <select id="qah-theme">
                        <option value="auto" ${config.theme==='auto'?'selected':''}>${t('themeAuto')}</option>
                        <option value="light" ${config.theme==='light'?'selected':''}>${t('themeLight')}</option>
                        <option value="dark" ${config.theme==='dark'?'selected':''}>${t('themeDark')}</option>
                    </select>
                </div>
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
        document.getElementById('qah-theme').onchange = (e) => {
            config.theme = e.target.value;
            saveConfigToStorage();
            applyTheme();
        };
        document.getElementById('qah-hotkey-toggle').onkeydown = captureHotkey;
        document.getElementById('qah-hotkey-screenshot').onkeydown = captureHotkey;
        document.getElementById('qah-save-config').onclick = () => saveConfig('qah-save-status');
        document.getElementById('qah-sync-on').onchange = (e) => setSyncEnabled(e.target.checked);
    }

    // ===== AI providers =====
    // Several saved providers (cc-switch style), one active. The AI tab shows either the
    // list, the preset picker or the editor (aiView); the editor works on a copy (aiDraft)
    // that only replaces the saved entry on Save, and survives renderAll().
    let aiView = 'list'; // 'list' | 'pick' | 'edit'
    let aiDraft = null;
    let aiDraftIsNew = false;
    let aiModels = [];   // model ids fetched for the provider being edited (combobox options)

    const activeProvider = () => config.providers.find(p => p.id === config.activeProvider) || null;
    const presetName = (preset) => preset.nameKey ? t(preset.nameKey) : preset.name;
    const providerName = (entry) => entry.name || presetName(presetOf(entry));
    const providerIcon = (preset) => preset.brand ? brandIcon(preset.brand) : icon(preset.icon);

    function newProvider(presetId, overrides) {
        const preset = presetById(presetId);
        return Object.assign({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            preset: preset.id, name: '', protocol: preset.protocol,
            baseUrl: preset.baseUrl, apiKey: '', model: preset.model
        }, overrides);
    }

    // Preset whose endpoint host matches, else the custom entry of that protocol (legacy migration)
    function guessPreset(protocol, baseUrl) {
        const host = (u) => { try { return new URL(u).host; } catch(e) { return ''; } };
        const hit = PROVIDER_PRESETS.find(p => p.protocol === protocol && p.baseUrl && host(p.baseUrl) === host(baseUrl));
        return hit ? hit.id : 'custom-' + protocol;
    }

    function setActiveProvider(id) {
        config.activeProvider = id;
        saveConfigToStorage();
        if (aiView === 'list') renderAiTab();
        renderQuickProvider();
    }

    // AI tab: provider list / picker / editor, plus the answer language (saved on change).
    function renderAiTab() {
        const body = aiView === 'pick' ? aiPickerHtml() : aiView === 'edit' ? aiEditorHtml() : aiListHtml();
        tabContainers.ai.innerHTML = body + (aiView !== 'list' ? '' : `
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
            </div>`);
        if (aiView === 'pick') bindAiPicker();
        else if (aiView === 'edit') bindAiEditor();
        else bindAiList();
    }

    function aiListHtml() {
        const cards = config.providers.map(p => {
            const preset = presetOf(p);
            const on = p.id === config.activeProvider;
            let host = '';
            try { host = new URL(p.baseUrl).host; } catch(e) {}
            const sub = [p.model, host].filter(Boolean).map(escHtml).join(' · ') || t('provNotSet');
            return `
                <div class="qah-prov${on ? ' active' : ''}" data-use="${p.id}" tabindex="0" role="button" aria-pressed="${on}">
                    <span class="qah-prov-icon">${providerIcon(preset)}</span>
                    <span class="qah-prov-text">
                        <span class="qah-prov-name">${escHtml(providerName(p))}</span>
                        <span class="qah-prov-sub">${sub}</span>
                    </span>
                    ${on ? `<span class="qah-prov-badge">${t('provActive')}</span>` : ''}
                    <button class="qah-prov-act" data-edit="${p.id}" title="${t('provEdit')}" aria-label="${t('provEdit')}">${icon('edit')}</button>
                    <button class="qah-prov-act danger" data-del="${p.id}" title="${t('del')}" aria-label="${t('del')}">${icon('trash')}</button>
                </div>`;
        }).join('');
        return `
            <div class="qah-prov-head">
                ${groupTitle('cpu', 'blue', t('providerLabel'))}
                <button class="qah-btn secondary" id="qah-prov-add">${icon('plus')}${t('provAdd')}</button>
            </div>
            ${cards || `<div class="qah-empty">${chip('cpu', 'blue')}<span>${t('provEmpty')}</span></div>`}
            ${config.providers.length > 1 ? `<div class="qah-prov-tip">${t('provSwitchTip')}</div>` : ''}
            <span id="qah-prov-status" class="qah-status" style="font-size:11px;margin-top:6px"></span>`;
    }

    function bindAiList() {
        document.getElementById('qah-answer-lang').onchange = (e) => {
            config.answerLang = e.target.value;
            saveConfigToStorage();
        };
        document.getElementById('qah-prov-add').onclick = () => { aiView = 'pick'; renderAiTab(); };
        tabContainers.ai.querySelectorAll('[data-use]').forEach(el => {
            el.onclick = () => setActiveProvider(el.dataset.use);
            el.onkeydown = (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); el.click(); } };
        });
        tabContainers.ai.querySelectorAll('[data-edit]').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                aiDraft = Object.assign({}, config.providers.find(p => p.id === b.dataset.edit));
                aiDraftIsNew = false;
                aiModels = [];
                aiView = 'edit';
                renderAiTab();
            };
        });
        tabContainers.ai.querySelectorAll('[data-del]').forEach(b => {
            b.onclick = (e) => {
                e.stopPropagation();
                const entry = config.providers.find(p => p.id === b.dataset.del);
                if (!entry || !confirm(t('provDelConfirm', providerName(entry)))) return;
                config.providers = config.providers.filter(p => p !== entry);
                if (config.activeProvider === entry.id) config.activeProvider = config.providers.length ? config.providers[0].id : '';
                saveConfigToStorage();
                renderAiTab();
                renderQuickProvider();
            };
        });
    }

    function aiPickerHtml() {
        const tiles = PROVIDER_PRESETS.map(p => `
            <button class="qah-preset" data-preset="${p.id}">
                <span class="qah-prov-icon">${providerIcon(p)}</span>
                <span class="qah-preset-name">${escHtml(presetName(p))}</span>
            </button>`).join('');
        return `
            <div class="qah-prov-head">
                ${groupTitle('plus', 'violet', t('provPickTitle'))}
                <button class="qah-btn secondary" id="qah-prov-back">${t('cancel')}</button>
            </div>
            <div class="qah-preset-grid">${tiles}</div>`;
    }

    function bindAiPicker() {
        document.getElementById('qah-prov-back').onclick = () => { aiView = 'list'; renderAiTab(); };
        tabContainers.ai.querySelectorAll('[data-preset]').forEach(b => {
            b.onclick = () => {
                aiDraft = newProvider(b.dataset.preset);
                aiDraftIsNew = true;
                aiModels = [];
                aiView = 'edit';
                renderAiTab();
            };
        });
    }

    function aiEditorHtml() {
        const d = aiDraft;
        const preset = presetOf(d);
        const custom = preset.id.startsWith('custom-');
        const urlPh = d.protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1';
        const notes = [];
        if (preset.vision === false) notes.push(t('provNoVision'));
        if (preset.hintKey) notes.push(t(preset.hintKey));
        return `
            <div class="qah-prov-head">
                <div class="qah-group-title"><span class="qah-prov-icon sm">${providerIcon(preset)}</span><span>${escHtml(aiDraftIsNew ? t('provAddTitle', presetName(preset)) : providerName(d))}</span></div>
                ${preset.keyUrl ? `<a class="qah-prov-link" href="${preset.keyUrl}" target="_blank" rel="noopener noreferrer">${t('provGetKey')} ↗</a>` : ''}
            </div>
            ${notes.map(n => `<div class="qah-prov-note">${icon('alert')}<span>${n}</span></div>`).join('')}
            <div class="qah-field">
                <label>${t('provName')}</label>
                <input id="qah-prov-name" value="${escHtml(d.name)}" placeholder="${escHtml(presetName(preset))}">
            </div>
            <div class="qah-field">
                <label>${t('provProtocol')}</label>
                <select id="qah-prov-protocol" ${custom ? '' : 'disabled'}>
                    <option value="openai" ${d.protocol==='openai'?'selected':''}>${t('protoOpenai')}</option>
                    <option value="anthropic" ${d.protocol==='anthropic'?'selected':''}>${t('protoAnthropic')}</option>
                </select>
            </div>
            <div class="qah-field">
                <label>API Base URL</label>
                <input id="qah-prov-url" value="${escHtml(d.baseUrl)}" placeholder="${urlPh}">
            </div>
            <div class="qah-field">
                <label>API Key${preset.noKey ? ` <span style="color:var(--qah-muted);font-weight:400">(${t('provOptional')})</span>` : ''}</label>
                <input id="qah-prov-key" type="password" value="${escHtml(d.apiKey)}" placeholder="${d.protocol === 'anthropic' ? 'sk-ant-...' : 'sk-...'}">
            </div>
            <div class="qah-field">
                <label>${t('modelLabel')}</label>
                <div style="display:flex;gap:6px">
                    <div class="qah-combo" id="qah-model-combo">
                        <input id="qah-prov-model" value="${escHtml(d.model)}" placeholder="${t('provModelPh')}" autocomplete="off" spellcheck="false"
                            role="combobox" aria-expanded="false" aria-controls="qah-model-menu" aria-autocomplete="list">
                        <button type="button" class="qah-combo-toggle" id="qah-model-toggle" tabindex="-1" aria-label="${t('modelShowAll')}" title="${t('modelShowAll')}">${icon('chevron')}</button>
                        <div class="qah-combo-menu" id="qah-model-menu" role="listbox"></div>
                    </div>
                    <button class="qah-btn secondary" id="qah-fetch-models" style="padding:6px 10px;font-size:11px">${t('refreshBtn')}</button>
                </div>
                <span id="qah-models-status" style="display:block;font-size:11px;color:var(--qah-muted);margin-top:4px"></span>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
                <button class="qah-btn" id="qah-prov-save">${icon('check')}${t('saveBtn')}</button>
                <button class="qah-btn secondary" id="qah-prov-cancel">${t('cancel')}</button>
                <span id="qah-prov-edit-status" style="font-size:11px"></span>
            </div>`;
    }

    function bindAiEditor() {
        document.getElementById('qah-fetch-models').onclick = () => fetchModels();
        bindModelCombo();
        document.getElementById('qah-prov-protocol').onchange = (e) => {
            collectAiDraft();
            aiDraft.protocol = e.target.value;
            renderAiTab();
        };
        document.getElementById('qah-prov-cancel').onclick = () => {
            aiDraft = null;
            aiView = aiDraftIsNew ? 'pick' : 'list';
            renderAiTab();
        };
        document.getElementById('qah-prov-save').onclick = () => {
            collectAiDraft();
            const status = document.getElementById('qah-prov-edit-status');
            if (!aiDraft.baseUrl) { status.style.color = 'var(--qah-err)'; status.textContent = t('provNeedUrl'); return; }
            const i = config.providers.findIndex(p => p.id === aiDraft.id);
            if (i >= 0) config.providers[i] = aiDraft;
            else config.providers.push(aiDraft);
            // A freshly added provider becomes the active one: that is almost always why it was added
            if (aiDraftIsNew || !activeProvider()) config.activeProvider = aiDraft.id;
            saveConfigToStorage((err) => {
                if (err) {
                    status.style.color = 'var(--qah-err)';
                    status.textContent = t('saveFail', err.message);
                    return;
                }
                aiDraft = null;
                aiView = 'list';
                renderAiTab();
                renderQuickProvider();
                const s = document.getElementById('qah-prov-status');
                if (s) {
                    s.style.color = 'var(--qah-ok)';
                    s.textContent = t('saved');
                    setTimeout(() => { if (s.isConnected) s.textContent = ''; }, 2000);
                }
            });
        };
    }

    // Editor inputs → aiDraft (not saved). Also called before renderAll() so a language switch keeps the edits.
    function collectAiDraft() {
        if (aiView !== 'edit' || !aiDraft || !document.getElementById('qah-prov-url')) return;
        aiDraft.name = document.getElementById('qah-prov-name').value.trim();
        aiDraft.baseUrl = document.getElementById('qah-prov-url').value.trim();
        aiDraft.apiKey = document.getElementById('qah-prov-key').value.trim();
        aiDraft.model = document.getElementById('qah-prov-model').value.trim();
    }

    // Small provider switcher on the Answer tab (only with 2+ providers)
    function renderQuickProvider() {
        const box = document.getElementById('qah-quick-provider');
        if (!box) return;
        if (config.providers.length < 2) { box.innerHTML = ''; return; }
        box.innerHTML = `<select aria-label="${t('providerLabel')}" title="${t('providerLabel')}">${config.providers.map(p =>
            `<option value="${p.id}" ${p.id === config.activeProvider ? 'selected' : ''}>${escHtml(providerName(p))}${p.model ? ' · ' + escHtml(p.model) : ''}</option>`
        ).join('')}</select>`;
        box.querySelector('select').onchange = (e) => {
            collectAiDraft();
            setActiveProvider(e.target.value);
        };
    }

    function renderSupportTab() {
        tabContainers.support.innerHTML = `
            <div style="text-align:center;padding:20px 10px">
                <div class="qah-chip coral" style="width:44px;height:44px;border-radius:14px;margin-bottom:10px"><svg class="qah-ic" style="width:22px;height:22px" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICON_PATHS.heart}</svg></div>
                <div style="font-size:16px;font-weight:600;color:var(--qah-ink);margin-bottom:8px">${t('supportTitle')}</div>
                <p style="color:var(--qah-muted);font-size:12px;margin-bottom:16px;line-height:1.6">${t('supportText')}</p>
                <img class="qah-pay" src="${chrome.runtime.getURL('images/support-qr.png')}" alt="${t('payWechat')} / ${t('payAlipay')}">
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

    // Model picker: free-text input + dropdown of aiModels. The arrow always lists every
    // model (current value highlighted); typing filters. A native <datalist> can't do this:
    // it filters by the input's value, so a prefilled model hides all the others.
    function bindModelCombo() {
        const combo = document.getElementById('qah-model-combo');
        const input = document.getElementById('qah-prov-model');
        const menu = document.getElementById('qah-model-menu');
        let hi = -1; // highlighted option index
        const items = () => [...menu.querySelectorAll('.qah-combo-opt')];
        const setHi = (i) => {
            const opts = items();
            hi = opts.length ? (i + opts.length) % opts.length : -1;
            opts.forEach((o, n) => o.classList.toggle('hi', n === hi));
            const o = opts[hi]; // scroll the menu only (scrollIntoView would also scroll the panel)
            if (o && o.offsetTop < menu.scrollTop) menu.scrollTop = o.offsetTop - 4;
            else if (o && o.offsetTop + o.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = o.offsetTop + o.offsetHeight - menu.clientHeight + 4;
        };
        // The tab body scrolls and clips overflow: open upward when there is more room above
        const place = () => {
            const box = combo.closest('.qah-section').getBoundingClientRect();
            const r = input.getBoundingClientRect();
            const below = box.bottom - r.bottom - 10, above = r.top - box.top - 10;
            const up = below < 180 && above > below;
            combo.classList.toggle('up', up);
            menu.style.maxHeight = Math.max(80, Math.min(240, up ? above : below)) + 'px';
        };
        const close = () => { combo.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); hi = -1; };
        const open = (filter) => {
            const cur = input.value.trim();
            const q = filter ? cur.toLowerCase() : '';
            const list = aiModels.filter(m => m.toLowerCase().includes(q));
            menu.innerHTML = list.length
                ? list.map(m => `<div class="qah-combo-opt${m === cur ? ' sel' : ''}" role="option" data-model="${escHtml(m)}">${icon('check')}<span>${escHtml(m)}</span></div>`).join('')
                : `<div class="qah-combo-empty">${aiModels.length ? t('modelNoMatch') : t('modelNoneYet')}</div>`;
            combo.classList.add('open');
            input.setAttribute('aria-expanded', 'true');
            place();
            menu.querySelectorAll('.qah-combo-opt').forEach(o => {
                o.onmousedown = (e) => e.preventDefault(); // keep focus in the input
                o.onclick = () => { input.value = o.dataset.model; close(); };
            });
            setHi(Math.max(0, list.indexOf(cur)));
        };
        combo.openAll = () => open(false);
        document.getElementById('qah-model-toggle').onmousedown = (e) => e.preventDefault();
        document.getElementById('qah-model-toggle').onclick = () => {
            if (combo.classList.contains('open')) return close();
            input.focus();
            if (!aiModels.length) fetchModels(true); // nothing loaded yet: fetch, then open
            else open(false);
        };
        input.oninput = () => open(true);
        input.onblur = close;
        input.onkeydown = (e) => {
            const isOpen = combo.classList.contains('open');
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!isOpen) return open(false);
                setHi(hi + (e.key === 'ArrowDown' ? 1 : -1));
            } else if (e.key === 'Enter' && isOpen) {
                e.preventDefault();
                const opt = items()[hi];
                if (opt) input.value = opt.dataset.model;
                close();
            } else if (e.key === 'Escape' && isOpen) {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        };
    }

    // Load the endpoint's /models list into the model picker (editor fields, not yet saved).
    // openAfter: show the dropdown once loaded (used by the arrow when nothing was loaded).
    function fetchModels(openAfter) {
        collectAiDraft();
        const d = aiDraft;
        const preset = presetOf(d);
        const status = document.getElementById('qah-models-status');
        const combo = document.getElementById('qah-model-combo');
        if (!d.apiKey && !preset.noKey) { alert(t('needKey')); return; }
        const base = d.baseUrl.replace(/\/$/, '');
        const ant = d.protocol === 'anthropic';
        const headers = ant
            ? { 'x-api-key': d.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
            : (d.apiKey ? { 'Authorization': 'Bearer ' + d.apiKey } : {});
        status.style.color = 'var(--qah-muted)';
        status.textContent = t('loading');
        const show = (models, msg) => {
            if (!combo.isConnected) return;
            aiModels = models;
            status.textContent = msg;
            if (openAfter || models.length) combo.openAll();
        };
        chrome.runtime.sendMessage({ type: 'API_REQUEST', url: base + (ant ? '/v1/models' : '/models'), method: 'GET', headers }, (resp) => {
            let models = [];
            try {
                const data = JSON.parse(resp.text);
                models = (data.data || data.models || data).map(m => m.id || m.name || m).filter(m => typeof m === 'string').sort();
            } catch(e) {}
            if (models.length) show(models, t('modelsFound', models.length));
            else if (ant) show(ANTHROPIC_MODELS, t('modelsDefault'));
            else { show([], t(resp && resp.ok ? 'noModels' : 'loadFailed')); status.style.color = 'var(--qah-err)'; }
        });
    }

    // Read the Settings-tab fields into `config` (without persisting); the provider editor keeps its draft
    function collectConfigFields() {
        collectAiDraft();
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
        if (screenshots.length >= MAX_SHOTS) {
            panel.classList.add('show');
            if (preview) setPreview(preview, t('shotLimit', MAX_SHOTS));
            return;
        }
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
                await addShot(resp.dataUrl, 'shotOk');
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
                    addShot(reader.result, 'pasteOk').catch(err => {
                        const preview = document.getElementById('qah-question-preview');
                        if (preview) setPreview(preview, t('shotFail', err.message));
                    });
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

        if (!question && !screenshots.length) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoQuestion')}</div>`;
            return;
        }
        if (!noDocMode && !pdfDocs.length) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoDocs')}</div>`;
            return;
        }
        const prov = activeProvider();
        if (!prov) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoProvider')}</div>`;
            return;
        }
        if (!prov.apiKey && !presetOf(prov).noKey) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoKey', escHtml(providerName(prov)))}</div>`;
            return;
        }
        if (!prov.model) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoModel', escHtml(providerName(prov)))}</div>`;
            return;
        }
        if (screenshots.length && presetOf(prov).vision === false) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${t('errNoVision', escHtml(providerName(prov)))}</div>`;
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
            if (prov.protocol === 'anthropic') {
                answer = await callAnthropic(prov, systemPrompt, userText, screenshots);
            } else {
                answer = await callOpenAI(prov, systemPrompt, userText, screenshots);
            }
            try { await ensureLib('lib/marked.min.js'); } catch(e) { /* fall back to plain text */ }
            answerArea.innerHTML = `<div class="qah-answer-box"><div class="qah-answer-head">${chip('answer', 'gold')}<span>${t('answerTitle')}</span></div>${renderMarkdown(answer)}</div>`;
        } catch(e) {
            answerArea.innerHTML = `<div class="qah-answer-box error">${e.message}</div>`;
        } finally {
            setLogoThinking(false);
        }
    }

    // With several images, label each one so the model can refer to them in order
    function imageLabel(i, total) {
        return total > 1 ? { type: 'text', text: t('imageN', i + 1, total) } : null;
    }

    // Newer models reject a custom temperature (Claude Opus 4.7+ / Sonnet 5+ / Haiku 5.5 / Fable /
    // Mythos, OpenAI o-series / gpt-5), so it is only sent to models known to accept it.
    // Anything else that refuses it (relays, renamed ids) is retried once without it.
    const NO_TEMPERATURE = /claude-(opus-(4-[7-9]|[5-9])|sonnet-[5-9]|haiku-[5-9]|fable|mythos)|(^|\/)(o\d|gpt-5)/i;

    // POST via the background proxy; resolves with the parsed JSON body
    function postJson(url, headers, body) {
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: 'API_REQUEST', url, method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
                body: JSON.stringify(body)
            }, (resp) => {
                if (!resp || !resp.ok) { reject(new Error(resp ? resp.error : t('netFail'))); return; }
                let data;
                try { data = JSON.parse(resp.text); } catch(e) {
                    reject(new Error(t('parseFail', (resp.text || '').slice(0, 200))));
                    return;
                }
                if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
                else resolve(data);
            });
        });
    }

    async function postWithTemperature(prov, url, headers, body) {
        if (NO_TEMPERATURE.test(prov.model)) return postJson(url, headers, body);
        try {
            return await postJson(url, headers, Object.assign({ temperature: 0.1 }, body));
        } catch(e) {
            if (!/temperature/i.test(e.message)) throw e;
            return postJson(url, headers, body);
        }
    }

    async function callOpenAI(prov, system, user, images) {
        const userContent = [];
        images.forEach((b64, i) => {
            const label = imageLabel(i, images.length);
            if (label) userContent.push(label);
            userContent.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
        });
        userContent.push({ type: 'text', text: user });

        const data = await postWithTemperature(prov,
            prov.baseUrl.replace(/\/$/, '') + '/chat/completions',
            prov.apiKey ? { 'Authorization': 'Bearer ' + prov.apiKey } : {},
            {
                model: prov.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: userContent }
                ]
            });
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        if (!msg || !msg.content) throw new Error(t('emptyAnswer'));
        return msg.content;
    }

    async function callAnthropic(prov, system, user, images) {
        const userContent = [];
        images.forEach((b64, i) => {
            const label = imageLabel(i, images.length);
            if (label) userContent.push(label);
            userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
        });
        userContent.push({ type: 'text', text: user });

        const data = await postWithTemperature(prov,
            prov.baseUrl.replace(/\/$/, '') + '/v1/messages',
            {
                'x-api-key': prov.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            {
                model: prov.model,
                max_tokens: 16000, // newer models always think first; leave room for the answer
                system: system,
                messages: [
                    { role: 'user', content: userContent }
                ]
            });
        if (data.stop_reason === 'refusal') throw new Error(t('refused'));
        // Thinking models put a thinking block first, so collect the text blocks
        const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
        if (!text) throw new Error(t('emptyAnswer'));
        return text;
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
        collectAiDraft(); // keep unsaved provider-editor input
        const q = document.getElementById('qah-question');
        const a = document.getElementById('qah-answer-area');
        const qVal = q ? q.value : '';
        const aHtml = a ? a.innerHTML : '';
        applyTheme();
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
