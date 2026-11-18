import { defineConfig } from 'wxt';

// The manifest is generated per target browser (`wxt build -b chrome|firefox|edge|safari`).
// Version comes from package.json.
export default defineConfig({
    // Don't launch a browser on `npm run dev`; load .output/chrome-mv3-dev into your own Chrome instead
    webExt: { disabled: true },
    manifestVersion: 3,
    manifest: ({ browser }) => ({
        name: '__MSG_extName__',
        description: '__MSG_extDescription__',
        default_locale: 'en',
        author: 'Sean Zou <zouchao2008@gmail.com>',
        icons: {
            16: 'images/icons/icon16.png',
            32: 'images/icons/icon32.png',
            48: 'images/icons/icon48.png',
            128: 'images/icons/icon128.png',
        },
        permissions: ['tabs', 'storage', 'scripting'],
        host_permissions: ['<all_urls>'],
        web_accessible_resources: [
            {
                resources: ['lib/pdf.worker.min.js', 'images/buy-me-a-coffee.jpeg'],
                matches: ['https://*/*'],
            },
        ],
        // Firefox needs a fixed add-on id (also required for storage.sync), plus a data
        // disclosure: question text / screenshots / document excerpts are sent to the
        // AI provider the user configures
        ...(browser === 'firefox' && {
            browser_specific_settings: {
                gecko: {
                    id: 'quiz-ai-helper@seanzou',
                    data_collection_permissions: { required: ['websiteContent'] },
                },
            },
        }),
    }),
});
