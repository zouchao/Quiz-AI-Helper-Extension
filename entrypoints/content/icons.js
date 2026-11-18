// SVG assets + icon helpers, imported by main.js.

// Logo: an answer sheet with three options; the gold bubble ticks the picked answer, sparkle = AI.
// Animated via CSS (see .qah-logo rules): idle sparkle twinkle, hover pop + tick redraw,
// and .qah-thinking (while askAI runs) where the bubble scans the options before settling.
const LOGO_SVG = '<svg class="qah-logo" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle class="qah-opt qah-opt-1" cx="5" cy="5" r="2.1" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="1.6"/>'
    + '<path class="qah-row qah-row-1" d="M10 5h7" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="2"/>'
    + '<path class="qah-row qah-row-2" d="M10.5 12h10" stroke="#FBF7EF" stroke-width="2.2"/>'
    + '<circle class="qah-opt qah-opt-3" cx="5" cy="19" r="2.1" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="1.6"/>'
    + '<path class="qah-row qah-row-3" d="M10 19h5" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="2"/>'
    + '<circle class="qah-opt qah-opt-2" cx="5" cy="12" r="2.1" stroke="#FBF7EF" stroke-opacity=".45" stroke-width="1.6"/>'
    + '<g class="qah-mark-pick"><circle cx="5" cy="12" r="3.3" fill="#F2A93B"/>'
    + '<path class="qah-tick" d="M3.6 12.1l1 1 1.9-2.1" stroke="#1F2A44" stroke-width="1.5" pathLength="1"/></g>'
    + '<path class="qah-spark" d="M20.5 2.2l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z" fill="#F2A93B"/>'
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
    cloud: '<path d="M17.5 19H8a6 6 0 1 1 5.7-7.9A4.5 4.5 0 1 1 17.5 19z"/>',
    keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>'
};
const icon = (name) => '<svg class="qah-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATHS[name] + '</svg>';
const chip = (name, tone) => '<span class="qah-chip ' + tone + '">' + icon(name) + '</span>';
const groupTitle = (name, tone, text) => '<div class="qah-group-title">' + chip(name, tone) + '<span>' + text + '</span></div>';
// File-type chip colour: PDF coral, Word blue, text/markdown teal
const fileTone = (name) => /\.pdf$/i.test(name) ? 'coral' : /\.docx?$/i.test(name) ? 'blue' : 'teal';

export { LOGO_SVG, ICON_PATHS, icon, chip, groupTitle, fileTone };
