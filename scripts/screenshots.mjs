// Regenerates the README screenshots in docs/screenshots/ (EN + ZH). Run `npm run screenshots`
// (builds first). Loads the real .output/chrome-mv3 build in Playwright's Chromium against a mock
// quiz page and a mock OpenAI-compatible API on localhost, so no key or network is needed.
// Panel shots are RGBA PNGs: the page is hidden and the background left transparent, keeping the
// panel's shadow. First run: `npx playwright install chromium`. macOS only (see setBrowserLanguage).
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, '.output/chrome-mv3');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs/screenshots'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qah-shots-'));
const PORT = 8765;
const LOCAL = `http://localhost:${PORT}`;

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
    console.error('No build in .output/chrome-mv3, run `npm run build` first');
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// Chrome on macOS takes its UI language (e.g. the native file input's "Choose Files")
// from the app's AppleLanguages default, not --lang. Set it for Chrome for Testing only
// and put back whatever was there before.
const BUNDLE = 'com.google.chrome.for.testing';
let prevLanguages = null;
try { prevLanguages = execSync(`defaults export ${BUNDLE} -`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) {}
const hadLanguages = !!prevLanguages && prevLanguages.includes('<key>AppleLanguages</key>');
function setBrowserLanguage(L) {
    if (process.platform !== 'darwin') return;
    execSync(`defaults write ${BUNDLE} AppleLanguages -array ${L === 'zh' ? 'zh-Hans' : 'en-US'}`);
}
function restoreBrowserLanguage() {
    if (process.platform !== 'darwin') return;
    if (hadLanguages) execSync(`defaults import ${BUNDLE} -`, { input: prevLanguages });
    else try { execSync(`defaults delete ${BUNDLE} AppleLanguages`, { stdio: 'ignore' }); } catch (e) {}
}

const QUIZ = {
    en: {
        title: 'Network Basics · Unit 3 Quiz', meta: 'Question 4 of 10 · Single choice',
        q: 'Which layer of the OSI model is responsible for end-to-end delivery, segmentation and flow control?',
        opts: ['Network layer', 'Transport layer', 'Data link layer', 'Session layer'],
        next: 'Next question', read: 'Reading:', link: 'Chapter 3 — The OSI model (PDF)',
        answer: '**Answer: B. Transport layer**\n\nThe transport layer (layer 4) provides end-to-end delivery between hosts, splits data into segments and handles flow control — this is where TCP and UDP operate.\n\n- *Network layer* — logical addressing and routing\n- *Data link layer* — frames on a single link\n- *Session layer* — dialogue control\n\nSource: network-basics-ch3.pdf, page 1'
    },
    zh: {
        title: '网络基础 · 第 3 单元测验', meta: '第 4 / 10 题 · 单选',
        q: 'OSI 模型中，哪一层负责端到端传输、数据分段和流量控制？',
        opts: ['网络层', '传输层', '数据链路层', '会话层'],
        next: '下一题', read: '阅读材料：', link: '第 3 章 — OSI 模型（PDF）',
        answer: '**答案：B. 传输层**\n\n传输层（第 4 层）负责主机之间的端到端传输，把数据分段并进行流量控制，TCP 和 UDP 都工作在这一层。\n\n- *网络层* — 逻辑寻址与路由\n- *数据链路层* — 单条链路上的帧传输\n- *会话层* — 会话管理\n\n来源：network-basics-ch3.pdf，第 1 页'
    }
};

// Page styles use classes only: bare element selectors (label, button) would leak into the panel
const quizHtml = (L) => {
    const q = QUIZ[L];
    return `<!doctype html><html><head><meta charset="utf-8"><title>${q.title}</title><style>
body{margin:0;font-family:-apple-system,system-ui,"PingFang SC",sans-serif;background:#F3F4F6;color:#111827}
.top{background:#fff;border-bottom:1px solid #E5E7EB;padding:14px 32px;font-weight:600;font-size:15px}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:10px;margin:40px auto;padding:24px;max-width:620px}
.meta{color:#6B7280;font-size:11px}.q{font-size:13px;line-height:1.6;margin:8px 0 14px}
.opt{display:flex;gap:8px;align-items:center;border:1px solid #E5E7EB;border-radius:8px;padding:9px 14px;margin:6px 0;font-size:12px}
.next{background:#2563EB;color:#fff;border:0;border-radius:6px;padding:8px 14px;margin-top:14px;font-size:12px}
.read{color:#6B7280;font-size:11px;margin-top:16px}</style></head><body>
<div class="top">${q.title}</div><div class="card"><div class="meta">${q.meta}</div><div class="q">${q.q}</div>
${q.opts.map((o, i) => `<label class="opt"><input type="radio" name="a"> ${'ABCD'[i]}. ${o}</label>`).join('')}
<button class="next">${q.next}</button>
<div class="read">${q.read} <a href="${LOCAL}/network-basics-ch3.pdf">${q.link}</a></div></div></body></html>`;
};

// Providers shown on the AI tab. While answering, p1 points at the mock API instead.
const PROVIDERS = [
    { id: 'p1', preset: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo', model: 'gpt-4o' },
    { id: 'p2', preset: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-demo', model: 'claude-sonnet-5-5' },
    { id: 'p3', preset: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-demo', model: 'deepseek-chat' },
    { id: 'p4', preset: 'ollama', name: '', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5vl:7b' }
];

// Hide the page (and the floating button) so only the panel is drawn on a transparent background.
// Animations are frozen so re-runs give identical images (the logo twinkles).
const PANEL_ONLY_CSS = `html,body{background:transparent!important}
body>*:not(#qah-panel):not(#qah-viewer){visibility:hidden!important}
#qah-panel *{animation:none!important}`;

// ---- Reference documents: a 2-page PDF (rendered by Chromium) and a markdown file ----
const pdfBrowser = await chromium.launch();
const pdfPage = await pdfBrowser.newPage();
await pdfPage.setContent(`<h1>Chapter 3 — The OSI model</h1>
<p>The transport layer (layer 4) provides end-to-end delivery between hosts, segmentation and flow control. TCP and UDP operate here.</p>
<p>The network layer handles logical addressing and routing.</p><div style="page-break-before:always"></div>
<p>The data link layer moves frames across a single link. The session layer manages dialogues.</p>`);
const PDF = await pdfPage.pdf({ format: 'A4' });
await pdfBrowser.close();
const MD = path.join(TMP, 'osi-notes.md');
fs.writeFileSync(MD, '# OSI notes\n\n' + 'Layer 4, the transport layer, provides end-to-end delivery, segmentation and flow control. '.repeat(30));

// ---- Mock server: the PDF, /models and /chat/completions ----
let lang = 'en';
const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.url.endsWith('.pdf')) { res.setHeader('Content-Type', 'application/pdf'); return res.end(PDF); }
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }));
        setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: QUIZ[lang].answer } }] })), 600);
    });
}).listen(PORT);

async function run(L) {
    lang = L;
    setBrowserLanguage(L);
    const locale = L === 'zh' ? 'zh-CN' : 'en-US';
    const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile-' + L), {
        headless: false, // extensions need a headed browser
        deviceScaleFactor: 2, viewport: { width: 1280, height: 1200 }, locale,
        args: [`--lang=${locale}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });
    try {
        let [sw] = ctx.serviceWorkers();
        if (!sw) sw = await ctx.waitForEvent('serviceworker');
        const setConfig = (patch) => sw.evaluate((p) => new Promise(done => chrome.storage.local.get('qah_config',
            (r) => chrome.storage.local.set({ qah_config: Object.assign({}, r.qah_config, p) }, done))), patch);
        await sw.evaluate(() => chrome.storage.local.set({ qah_sync: false }));
        await setConfig({
            providers: PROVIDERS.map(p => p.id === 'p1' ? { ...p, baseUrl: LOCAL + '/v1' } : p),
            activeProvider: 'p1', language: L, theme: 'light'
        });

        await ctx.route('https://quiz.test/**', r => r.fulfill({ contentType: 'text/html', body: quizHtml(L) }));
        const page = await ctx.newPage();
        page.on('pageerror', e => console.error('page error:', e.message));
        await page.goto('https://quiz.test/unit3');
        await page.waitForSelector('#qah-btn');
        await page.waitForTimeout(600);
        const sfx = L === 'zh' ? '-zh' : '';

        // 01: the page with the floating button (opaque, it shows the page context)
        await page.setViewportSize({ width: 1100, height: 620 });
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/01-floating-button${sfx}.png` });
        await page.setViewportSize({ width: 1280, height: 1200 });
        await page.waitForTimeout(200);

        let panelOnly = null;
        const panelShot = async (name) => {
            if (!panelOnly) panelOnly = await page.addStyleTag({ content: PANEL_ONLY_CSS });
            await page.mouse.move(0, 0);
            await page.waitForTimeout(250);
            const b = await page.$eval('#qah-panel', e => e.getBoundingClientRect().toJSON());
            const pad = 28; // room for the shadow (0 10px 30px), which sits slightly lower
            await page.screenshot({
                path: `${OUT}/${name}${sfx}.png`, omitBackground: true,
                clip: { x: b.x - pad, y: b.y - pad + 4, width: b.width + pad * 2, height: b.height + pad * 2 }
            });
        };
        // The page must be visible again before capturing it with the Screenshot button
        const showPage = async () => { if (panelOnly) { await panelOnly.evaluate(e => e.remove()); panelOnly = null; } };
        const tab = async (name) => { await page.click(`.qah-tab[data-tab=${name}]`); await page.waitForTimeout(150); };

        await page.click('#qah-btn');
        await page.waitForTimeout(300);

        // 03 Docs: upload the markdown file, scan the page, load the PDF it finds
        await tab('docs');
        await page.setInputFiles('#qah-pdf-file', MD);
        await page.waitForTimeout(400);
        await page.click('#qah-scan-pdfs');
        await page.waitForSelector('#qah-scan-result [data-load]', { timeout: 8000 });
        await page.click('#qah-scan-result [data-load]');
        await page.waitForFunction(() => document.querySelectorAll('#qah-tab-docs .qah-pdf-item').length >= 3, null, { timeout: 15000 });
        await page.waitForTimeout(300);
        await panelShot('03-docs-tab');
        await showPage();

        // 02 Answer: two page screenshots + the question, answered by the mock API
        await tab('answer');
        for (let i = 0; i < 2; i++) {
            await page.click('#qah-screenshot');
            await page.waitForSelector(`.qah-shot[data-shot="${i}"]`, { timeout: 8000 });
            await page.waitForTimeout(700); // captureVisibleTab is rate-limited
        }
        await page.fill('#qah-question', QUIZ[L].q + '\n' + QUIZ[L].opts.map((o, i) => 'ABCD'[i] + '. ' + o).join('  '));
        await page.click('#qah-ask-ai');
        await page.waitForSelector('#qah-answer-area .qah-answer-box', { timeout: 10000 });
        await page.waitForTimeout(500);
        await panelShot('02-answer-tab');

        // 06 Dark theme: same state (renderAll() on the storage change keeps the answer)
        await page.emulateMedia({ colorScheme: 'dark' });
        await setConfig({ theme: 'dark' });
        await page.waitForTimeout(400);
        await page.waitForSelector('#qah-answer-area .qah-answer-box');
        await panelShot('06-dark-theme');
        await page.emulateMedia({ colorScheme: 'light' });
        await setConfig({ theme: 'auto', providers: PROVIDERS });
        await page.waitForTimeout(400);

        // 04 AI tab provider list, 07 preset picker
        await tab('ai');
        await panelShot('04-ai-tab');
        await page.click('#qah-prov-add');
        await page.waitForTimeout(200);
        await panelShot('07-ai-presets');
        await page.click('#qah-prov-back');

        // 05 Settings
        await tab('config');
        await page.fill('#qah-domains', '*.example.com\nquiz.test');
        await page.$eval('#qah-domains', e => e.blur());
        await panelShot('05-settings-tab');
    } finally {
        await ctx.close();
    }
}

try {
    await run('en');
    await run('zh');
    console.log('Screenshots written to ' + path.relative(process.cwd(), OUT));
} finally {
    restoreBrowserLanguage();
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
}
