chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CAPTURE_TAB') {
        chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ dataUrl });
            }
        });
        return true;
    }

    if (msg.type === 'API_REQUEST') {
        fetch(msg.url, {
            method: msg.method || 'GET',
            headers: msg.headers || {},
            body: msg.body || undefined
        })
        .then(resp => resp.text())
        .then(text => sendResponse({ ok: true, text }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    if (msg.type === 'INJECT_LIB') {
        const ALLOWED_LIBS = ['lib/pdf.min.js', 'lib/marked.min.js', 'lib/mammoth.min.js'];
        if (!ALLOWED_LIBS.includes(msg.file)) {
            sendResponse({ ok: false, error: 'not allowed: ' + msg.file });
            return true;
        }
        chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            files: [msg.file]
            // default world is ISOLATED (shared with content scripts); omitting
            // the explicit param for compatibility with older Chrome versions
        })
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    if (msg.type === 'FETCH_BINARY') {
        fetch(msg.url)
        .then(resp => resp.arrayBuffer())
        .then(buf => {
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            sendResponse({ ok: true, base64: btoa(binary) });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }
});
