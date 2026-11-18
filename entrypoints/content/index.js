import './style.css';
import { main } from './main.js';

// Injected on every HTTPS page and every frame. Subframes run headless (scan relay only),
// see the top of main(). Third-party libs in public/lib are injected on demand by background.js.
export default defineContentScript({
    matches: ['https://*/*'],
    allFrames: true,
    runAt: 'document_idle',
    main,
});
