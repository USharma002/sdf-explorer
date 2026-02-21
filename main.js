import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let scene, camera, renderer;
let uniforms, material, quad;
let isPaused = false;
let idleTimer;
let controls;
let compileTimer;
let editorVertView, editorFragView;
let sdfCamera, pixelRatio;
let transformControl, raycaster, mouse;
let isGizmoDragging = false;
let editorModulesPromise = null;
let editorInitPromise = null;
let shaderSourceCache = { vert: '', frag: '' };
let webglContextLost = false;
let firstFrameLogged = false;
let usingFallbackShader = false;
let renderDisabled = false;
let renderFailureCount = 0;
let runtimeVertexShaderSource = '';

const HARD_MAX_SHAPES = 8;
const SAFE_STARTUP_SHAPE_CAP = 5;
const SAFE_PIXEL_RATIO_CAP = 1.25;
const SAFE_PREVIEW_PIXEL_RATIO_CAP = 1.0;
const SAFE_PREVIEW_SEGMENTS = 28;
let maxShapes = HARD_MAX_SHAPES;
const MAX_MATERIALS = 8;
const SHAPE_TYPES = { sphere: 0, box: 1 };
const SHAPE_LABELS = { sphere: 'Sphere', box: 'Box' };
const SHAPE_OPS = { union: 0, intersect: 1, subtract: 2 };
const SHAPE_OP_LABELS = ['Union', 'Intersect', 'Subtract'];
const MATERIALS = [
    { id: 0, name: 'Custom Matte',   color: '#6699cc', useGradient: true,  gradientColor: '#cc8844', roughness: 0.42, metalness: 0.05, ior: 1.00, transmission: 0.00 },
    { id: 1, name: 'Gold',           color: '#f6c86b', useGradient: true,  gradientColor: '#8f6a2f', roughness: 0.14, metalness: 1.00, ior: 1.00, transmission: 0.00 },
    { id: 2, name: 'Copper',         color: '#e78f5f', useGradient: true,  gradientColor: '#7f4e3b', roughness: 0.28, metalness: 1.00, ior: 1.00, transmission: 0.00 },
    { id: 3, name: 'Iron',           color: '#7f858f', useGradient: false, gradientColor: '#7f858f', roughness: 0.80, metalness: 0.88, ior: 1.00, transmission: 0.00 },
    { id: 4, name: 'Rubber',         color: '#31363c', useGradient: false, gradientColor: '#31363c', roughness: 0.94, metalness: 0.00, ior: 1.00, transmission: 0.00 },
    { id: 5, name: 'Glass',          color: '#d9edff', useGradient: true,  gradientColor: '#95bee0', roughness: 0.03, metalness: 0.00, ior: 1.52, transmission: 1.00 },
    { id: 6, name: 'Frosted Glass',  color: '#d1e0ed', useGradient: true,  gradientColor: '#95a8b8', roughness: 0.45, metalness: 0.00, ior: 1.48, transmission: 1.00 },
    { id: 7, name: 'Custom Gloss',   color: '#91d8b8', useGradient: true,  gradientColor: '#267f66', roughness: 0.18, metalness: 0.25, ior: 1.00, transmission: 0.00 },
];

let managedShapes = [];
let selectedShapeId = null;
let selectedMaterialId = 0;
let shapeIdCounter = 1;
let shapeUniformA, shapeUniformB, shapeUniformC, shapeUniformD;
let csgNodeUniformA, csgNodeUniformB, csgRootUniformA;
let maxCsgNodes = 0;
let matUniformA, matUniformB, matUniformC;
let csgNodes = [];
let csgNodeIdCounter = 1;
let selectedNodeKeys = new Set();
let activeNodeKey = null;
let proxyGeometries;
let cameraState = {
    focus: 8.0,
    aperture: 0.0,
    focalLength: 50.0,
    sensorWidth: 36.0,
};
let isSyncingCameraInputs = false;
const shapeBounds = new THREE.Box3();
const shapeBoundsSphere = new THREE.Sphere();
const tempBounds = new THREE.Box3();
const axisVecX = new THREE.Vector3();
const axisVecY = new THREE.Vector3();
const axisVecZ = new THREE.Vector3();
const axisInvQuat = new THREE.Quaternion();
const CONTENT_TABS = ['objects', 'shapes', 'materials', 'ops'];
const CONTENT_TAB_TITLES = {
    objects: 'Scene Objects',
    shapes: 'Shape Library',
    materials: 'Material Presets',
    ops: 'CSG Operations',
};
let contentUI = {
    activeTab: 'objects',
    inspectorOpen: false,
    inspectorType: null,
    inspectorTargetId: null,
    contentHeightPx: null,
    listDirty: true,
    collapsedSections: { contentList: false },
};
const materialPreview = {
    initialized: false,
    disabled: false,
    renderer: null,
    scene: null,
    camera: null,
    mesh: null,
    texture: null,
    environment: null,
    canvas: null,
    size: { w: 0, h: 0 },
    dirty: false,
};
const materialThumbs = {
    initialized: false,
    disabled: false,
    renderer: null,
    scene: null,
    camera: null,
    mesh: null,
    texture: null,
    environment: null,
    canvas: null,
    cache: new Map(),
};

const proxyScene = new THREE.Scene();

const scheduleCompile = () => {
    setStatus('typing');
    clearTimeout(compileTimer);
    compileTimer = setTimeout(compile, 500);
};

const bootStartTs = performance.now();
function bootLog(message) {
    const elapsed = (performance.now() - bootStartTs).toFixed(1);
    console.log(`[boot +${elapsed}ms] ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Colormaps — built as 256×1 canvas textures
// ─────────────────────────────────────────────────────────────────────────────
const COLORMAP_STOPS = {
    magma:    ['#000004','#2d115e','#721c84','#ba3471','#f06852','#fcb572','#fbfcbf'],
    viridis:  ['#440154','#3b528b','#21918c','#5ec962','#fde725'],
    plasma:   ['#0d0887','#7e03a8','#cc4778','#f89540','#f0f921'],
    inferno:  ['#000004','#420a68','#932667','#dd513a','#fca50a','#fcffa4'],
    coolwarm: ['#3b4cc0','#6788ee','#b0c4de','#f7b89c','#e8694a','#b40426'],
    gray:     ['#111111','#eeeeee'],
};


const COLORMAPS = {};
for (const [name, stops] of Object.entries(COLORMAP_STOPS)) {
    const c = document.createElement('canvas'); c.width=256; c.height=1;
    const cx = c.getContext('2d');
    const g = cx.createLinearGradient(0,0,256,0);
    stops.forEach((col,i) => g.addColorStop(i/(stops.length-1), col));
    cx.fillStyle=g; cx.fillRect(0,0,256,1);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    COLORMAPS[name] = { tex, stops };
}


// ─────────────────────────────────────────────────────────────────────────────
// Editor runtime
// ─────────────────────────────────────────────────────────────────────────────
const editorThemeSpec = {
    "&": {
        color: "#f8f8f2",
        backgroundColor: "transparent",
        height: "100%",
    },
    ".cm-content": {
        caretColor: "#f8f8f0",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "13px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#f8f8f0" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "#49483e !important" },
    ".cm-panels": { backgroundColor: "#272822", color: "#f8f8f2" },
    ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
    ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },
    ".cm-searchMatch": {
        backgroundColor: "#72a114",
        outline: "1px solid #457d00",
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#6199ff2f" },
    ".cm-activeLine": { backgroundColor: "#3e3d32" },
    ".cm-selectionMatch": { backgroundColor: "#aafe661a" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "#bad0f847",
        outline: "1px solid #515a6b",
    },
    ".cm-gutters": {
        backgroundColor: "transparent",
        color: "#75715e",
        border: "none",
    },
    ".cm-activeLineGutter": {
        backgroundColor: "#3e3d32",
        color: "#c2c1b4",
    },
    ".cm-tooltip": {
        border: "none",
        backgroundColor: "#35342f",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "#504f46",
        color: "#f8f8f2",
    },
};

function buildMonokaiHighlightSpec(t) {
    return [
        { tag: t.keyword, color: "#f92672" }, // Pink
        { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "#f8f8f2" },
        { tag: [t.function(t.variableName), t.labelName], color: "#a6e22e" }, // Green
        { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "#ae81ff" }, // Purple
        { tag: [t.definition(t.name), t.separator], color: "#fd971f" }, // Orange
        { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: "#ae81ff" }, // Purple
        { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: "#f92672" }, // Pink
        { tag: [t.meta, t.comment], color: "#75715e" }, // Grey
        { tag: t.strong, fontWeight: "bold" },
        { tag: t.emphasis, fontStyle: "italic" },
        { tag: t.strikethrough, textDecoration: "line-through" },
        { tag: t.link, color: "#75715e", textDecoration: "underline" },
        { tag: t.heading, fontWeight: "bold", color: "#fd971f" },
        { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#ae81ff" }, // Purple
        { tag: [t.processingInstruction, t.string, t.inserted], color: "#e6db74" }, // Yellow
        { tag: t.invalid, color: "#f8f8f0", backgroundColor: "#f92672" },
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────────────
const MODES = [
    { id:0, label:'shaded',  cls:'mode-shaded'  },
    { id:1, label:'heatmap', cls:'mode-heatmap' },
    { id:2, label:'normals', cls:'mode-normals' },
    { id:3, label:'depth',   cls:'mode-depth'   },
    { id:4, label:'slice',   cls:'mode-slice'   },
    { id:5, label:'ao',      cls:'mode-ao'      },
    { id:6, label:'curvature', cls:'mode-curvature'}
];
let currentMode = 0;

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────
const dom = {
    panel:          document.getElementById('editor-panel'),
    dragHandle:     document.getElementById('drag-handle'),
    btnEdit:        document.getElementById('btn-edit'),
    btnClose:       document.getElementById('close-editor'),
    editorVert:     document.getElementById('editor-vert'),
    editorFrag:     document.getElementById('editor-frag'),
    status:         document.getElementById('compile-status'),
    errTooltip:     document.getElementById('error-tooltip'),
    errText:        document.getElementById('error-text'),
    tabVert:        document.getElementById('tab-vert'),
    tabFrag:        document.getElementById('tab-frag'),
    uiElements:     document.querySelectorAll('.ui-element'),
    btnPause:       document.getElementById('btn-pause'),
    btnReset:       document.getElementById('btn-reset'),
    btnMode:        document.getElementById('btn-mode'),
    btnModeMenu:    document.getElementById('btn-mode-menu'),
    modeMenuList:   document.getElementById('mode-menu-list'),
    btnShot:        document.getElementById('btn-screenshot'),
    btnCamera:      document.getElementById('btn-camera'),
    btnGizmoMode:   document.getElementById('btn-gizmo-mode'),
    gizmoModeLabel: document.getElementById('gizmo-mode-label'),
    iconPlay:       document.getElementById('icon-play'),
    iconPause:      document.getElementById('icon-pause'),
    modeLabel:      document.getElementById('mode-label'),
    canvas:         document.getElementById('canvas-container'),
    bootLoader:     document.getElementById('boot-loader'),
    bootLoaderStep: document.getElementById('boot-loader-step'),
    bootProgressFill:document.getElementById('boot-progress-fill'),
    axisWidget:     document.getElementById('axis-widget'),
    axisLineX:      document.getElementById('axis-line-x'),
    axisLineY:      document.getElementById('axis-line-y'),
    axisLineZ:      document.getElementById('axis-line-z'),
    axisDotX:       document.getElementById('axis-dot-x'),
    axisDotY:       document.getElementById('axis-dot-y'),
    axisDotZ:       document.getElementById('axis-dot-z'),
    axisLabelX:     document.getElementById('axis-label-x'),
    axisLabelY:     document.getElementById('axis-label-y'),
    axisLabelZ:     document.getElementById('axis-label-z'),
    // panels
    slicePanel:     document.getElementById('slice-panel'),
    heatPanel:      document.getElementById('heat-panel'),
    cameraPanel:    document.getElementById('camera-panel'),
    // slice
    sliceOffset:    document.getElementById('slice-offset'),
    sliceOffsetVal: document.getElementById('slice-offset-val'),
    sliceYaw:       document.getElementById('slice-yaw'),
    sliceYawVal:    document.getElementById('slice-yaw-val'),
    slicePitch:     document.getElementById('slice-pitch'),
    slicePitchVal:  document.getElementById('slice-pitch-val'),
    contourSpacing: document.getElementById('contour-spacing'),
    contourSpacVal: document.getElementById('contour-spac-val'),
    contourWidth:   document.getElementById('contour-width'),
    contourWidthVal:document.getElementById('contour-width-val'),
    // camera
    camFov:         document.getElementById('cam-fov'),
    camFovVal:      document.getElementById('cam-fov-val'),
    camNear:        document.getElementById('cam-near'),
    camNearVal:     document.getElementById('cam-near-val'),
    camFar:         document.getElementById('cam-far'),
    camFarVal:      document.getElementById('cam-far-val'),
    camFocus:       document.getElementById('cam-focus'),
    camFocusVal:    document.getElementById('cam-focus-val'),
    camAperture:    document.getElementById('cam-aperture'),
    camApertureVal: document.getElementById('cam-aperture-val'),
    camFocal:       document.getElementById('cam-focal'),
    camFocalVal:    document.getElementById('cam-focal-val'),
    camSensor:      document.getElementById('cam-sensor'),
    camSensorVal:   document.getElementById('cam-sensor-val'),
    camFx:          document.getElementById('cam-fx'),
    camFy:          document.getElementById('cam-fy'),
    camCx:          document.getElementById('cam-cx'),
    camCy:          document.getElementById('cam-cy'),
    // heatmap
    cmSelect:       document.getElementById('cm-select'),
    cmSwatch:       document.getElementById('cm-swatch'),
    // content browser
    btnContent:     document.getElementById('btn-content'),
    contentBar:     document.getElementById('content-bar'),
    contentBodyWrap:document.querySelector('.content-body-wrap'),
    contentClose:   document.getElementById('content-close'),
    contentResizeHandle: document.getElementById('content-list-resize-handle'),
    contentTabs:    document.getElementById('content-tabs'),
    contentListPane:document.getElementById('content-list-pane'),
    contentListGrid:document.getElementById('content-list-grid'),
    contentInlineHint:document.getElementById('content-inline-hint'),
    // floating inspector
    inspectorFloat: document.getElementById('inspector-float'),
    inspectorPane:  document.getElementById('inspector-float'), // alias for compat
    inspectorHeader:document.getElementById('inspector-float-titlebar'),
    inspectorBody:  document.getElementById('inspector-body'),
    inspectorTitle: document.getElementById('inspector-title'),
    inspectorSubtitle:document.getElementById('inspector-subtitle'),
    inspectorClose: document.getElementById('inspector-close'),
    inspectorEmpty: document.getElementById('inspector-empty'),
    inspectorShape: document.getElementById('inspector-shape'),
    inspectorMaterial:document.getElementById('inspector-material'),
    inspectorOp:    document.getElementById('inspector-op'),
    shapeEditor:    document.getElementById('shape-editor'),
    shapeName:      document.getElementById('shape-name'),
    shapePosX:      document.getElementById('shape-pos-x'),
    shapePosY:      document.getElementById('shape-pos-y'),
    shapePosZ:      document.getElementById('shape-pos-z'),
    shapeRotX:      document.getElementById('shape-rot-x'),
    shapeRotY:      document.getElementById('shape-rot-y'),
    shapeRotZ:      document.getElementById('shape-rot-z'),
    shapeRadiusRow: document.getElementById('shape-radius-row'),
    shapeRadius:    document.getElementById('shape-radius'),
    shapeSizeRow:   document.getElementById('shape-size-row'),
    shapeSizeX:     document.getElementById('shape-size-x'),
    shapeSizeY:     document.getElementById('shape-size-y'),
    shapeSizeZ:     document.getElementById('shape-size-z'),
    shapeMaterial:  document.getElementById('shape-material'),
    shapeOp:        document.getElementById('shape-op'),
    shapeOpHint:    document.getElementById('shape-op-hint'),
    btnDeleteShape: document.getElementById('btn-delete-shape'),
    opEditorSelect: document.getElementById('op-editor-select'),
    opEditorApply:  document.getElementById('op-editor-apply'),
    opEditorHint:   document.getElementById('op-editor-hint'),
    materialPreviewCanvas: document.getElementById('material-preview-canvas'),
    matRoughness:   document.getElementById('mat-roughness'),
    matRoughnessVal:document.getElementById('mat-roughness-val'),
    matMetalness:   document.getElementById('mat-metalness'),
    matMetalnessVal:document.getElementById('mat-metalness-val'),
    matIor:         document.getElementById('mat-ior'),
    matIorVal:      document.getElementById('mat-ior-val'),
    matTransmission:document.getElementById('mat-transmission'),
    matTransmissionVal:document.getElementById('mat-trans-val'),
    matColor:       document.getElementById('mat-color'),
    matGradientEnabled:document.getElementById('mat-gradient-enabled'),
    matGradientColor:document.getElementById('mat-gradient-color'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────────
function createEditor(editorRuntime, element, initialCode, onUpdate) {
    const {
        EditorView,
        basicSetup,
        keymap,
        cpp,
        indentWithTab,
        selectNextOccurrence,
        syntaxHighlighting,
        monokaiTheme,
        monokaiHighlightStyle,
    } = editorRuntime;
    return new EditorView({
        doc: initialCode,
        extensions: [
            basicSetup, cpp(),
            keymap.of([indentWithTab, { key:'Mod-d', run:selectNextOccurrence }]),
            EditorView.updateListener.of(u => { if (u.docChanged) onUpdate(); }),
            monokaiTheme,
            syntaxHighlighting(monokaiHighlightStyle),
        ],
        parent: element,
    });
}

function getCurrentShaderSources() {
    if (editorVertView && editorFragView) {
        return {
            vert: editorVertView.state.doc.toString(),
            frag: editorFragView.state.doc.toString(),
        };
    }
    return shaderSourceCache;
}

async function loadEditorRuntime() {
    if (editorModulesPromise) return editorModulesPromise;
    editorModulesPromise = (async () => {
        const [
            codemirrorModule,
            viewModule,
            cppModule,
            commandsModule,
            searchModule,
            lezerHighlightModule,
            languageModule,
        ] = await Promise.all([
            import('codemirror'),
            import('@codemirror/view'),
            import('@codemirror/lang-cpp'),
            import('@codemirror/commands'),
            import('@codemirror/search'),
            import('@lezer/highlight'),
            import('@codemirror/language'),
        ]);

        const monokaiTheme = codemirrorModule.EditorView.theme(editorThemeSpec, { dark: true });
        const monokaiHighlightStyle = languageModule.HighlightStyle.define(
            buildMonokaiHighlightSpec(lezerHighlightModule.tags)
        );

        return {
            EditorView: codemirrorModule.EditorView,
            basicSetup: codemirrorModule.basicSetup,
            keymap: viewModule.keymap,
            cpp: cppModule.cpp,
            indentWithTab: commandsModule.indentWithTab,
            selectNextOccurrence: searchModule.selectNextOccurrence,
            syntaxHighlighting: languageModule.syntaxHighlighting,
            monokaiTheme,
            monokaiHighlightStyle,
        };
    })();
    return editorModulesPromise;
}

async function ensureEditorsInitialized() {
    if (editorVertView && editorFragView) return;
    if (editorInitPromise) return editorInitPromise;
    editorInitPromise = (async () => {
        const runtime = await loadEditorRuntime();
        const sources = getCurrentShaderSources();
        editorVertView = createEditor(runtime, dom.editorVert, sources.vert, scheduleCompile);
        editorFragView = createEditor(runtime, dom.editorFrag, sources.frag, scheduleCompile);
    })();
    try {
        await editorInitPromise;
    } catch (err) {
        editorInitPromise = null;
        throw err;
    }
}

function scheduleEditorRuntimePreload() {
    const preload = () => {
        loadEditorRuntime().catch(err => {
            console.warn('Editor module preload failed:', err);
        });
    };
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(preload, { timeout: 2200 });
    } else {
        window.setTimeout(preload, 900);
    }
}

async function fetchTextWithTimeout(url, timeoutMs = 8000) {
    const started = performance.now();
    bootLog(`fetch start ${url}`);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
        });
        bootLog(`fetch response ${url} status=${response.status}`);
        if (!response.ok) {
            throw new Error(`Failed to load ${url} (${response.status} ${response.statusText})`);
        }
        const text = await response.text();
        bootLog(`fetch text ${url} bytes=${text.length} in ${(performance.now() - started).toFixed(1)}ms`);
        return text;
    } catch (err) {
        bootLog(`fetch failed ${url}: ${String(err)}`);
        if (err && err.name === 'AbortError') {
            // Fallback path in case fetch hangs on cache revalidation.
            return await xhrTextWithTimeout(url, timeoutMs);
        }
        // Also fallback on fetch pipeline issues (e.g. live-reload proxy quirks).
        return await xhrTextWithTimeout(url, timeoutMs);
    } finally {
        window.clearTimeout(timer);
    }
}

function xhrTextWithTimeout(url, timeoutMs = 8000) {
    bootLog(`xhr fallback start ${url}`);
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'text';
        xhr.timeout = timeoutMs;
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const text = xhr.responseText || '';
                bootLog(`xhr fallback ok ${url} status=${xhr.status} bytes=${text.length}`);
                resolve(text);
            } else {
                reject(new Error(`XHR failed ${url} (${xhr.status} ${xhr.statusText})`));
            }
        };
        xhr.onerror = () => reject(new Error(`XHR network error ${url}`));
        xhr.ontimeout = () => reject(new Error(`XHR timeout ${url} after ${timeoutMs}ms`));
        xhr.send();
    });
}

let stats;
// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
    bootLog('init enter');
    setBootProgress(0.02, 'Booting runtime');
    // Start fetching shaders immediately — runs in parallel with renderer setup below.
    const shaderFetchPromise = Promise.all([
        fetchTextWithTimeout('shaders/vertex.glsl'),
        fetchTextWithTimeout('shaders/fragment.glsl'),
    ]);

    scene  = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    setBootProgress(0.08, 'Creating WebGL renderer');
    renderer = new THREE.WebGLRenderer({ 
        antialias: false, 
        preserveDrawingBuffer: false,
        powerPreference: "high-performance"
    });

    renderer.domElement.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        webglContextLost = true;
        renderDisabled = true;
        materialThumbs.disabled = true;
        materialPreview.disabled = true;
        if (dom.bootLoaderStep) dom.bootLoaderStep.textContent = 'WebGL context lost';
        setStatus('error', 'WebGL context lost. Reload the page.');
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
        webglContextLost = false;
        renderDisabled = false;
        renderFailureCount = 0;
    });

    const gl = renderer.getContext();
    const rendererName = gl.getParameter(gl.RENDERER);
    console.log("Currently rendering on: ", rendererName);
    
    renderer.setSize(window.innerWidth, window.innerHeight);
    pixelRatio = Math.min(window.devicePixelRatio, SAFE_PIXEL_RATIO_CAP);
    renderer.setPixelRatio(pixelRatio);
    dom.canvas.appendChild(renderer.domElement);
    setBootProgress(0.18, 'Renderer ready');

    // Initialize Stats
    stats = new Stats();
    stats.dom.style.zIndex = '50';

    // stats.showPanel(0); // 0: fps, 1: ms, 2: mb
    document.body.appendChild(stats.dom);
    setBootProgress(0.24, 'Loading shaders');
    bootLog('awaiting shaderFetchPromise');

    try {
        const [vert, frag] = await shaderFetchPromise;
        bootLog(`shaderFetchPromise resolved vert=${vert.length} frag=${frag.length}`);
        shaderSourceCache.vert = vert;
        shaderSourceCache.frag = frag;
        setBootProgress(0.46, 'Building scene');
        bootLog('calling buildScene');
        buildScene(vert, frag);
        bootLog('buildScene complete');
        setBootProgress(0.72, 'Binding UI');
        bootLog('calling setupUI');
        setupUI();
        setBootProgress(0.84, 'Seeding default scene');
        bootLog('calling seedDefaultShapes');
        seedDefaultShapes();
        setBootProgress(0.93, 'Starting render loop');
        setStatus('live');
        scheduleEditorRuntimePreload();
        setBootProgress(1.0, 'Ready');
        bootLog('init ready');
        hideBootLoader();
        bootLog('starting animate');
        animate();
    } catch (e) {
        console.error(e);
        bootLog(`init failed: ${String(e)}`);
        setBootProgress(1.0, 'Startup failed');
        if (dom.bootLoaderStep) dom.bootLoaderStep.textContent = `Startup error: ${String(e)}`;
        setStatus('error', String(e));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────────────────────────
function normalizeShaderSource(src) {
    return String(src || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n');
}

const clean = src => normalizeShaderSource(src).replace(/^\s*#version\s+\S+[^\n]*\n?/m, '');

function stripShaderComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\n{3,}/g, '\n\n');
}

function replaceShaderDefine(src, key, value) {
    const pattern = new RegExp(`(^\\s*#define\\s+${key}\\s+)\\d+`, 'm');
    if (!pattern.test(src)) return src;
    return src.replace(pattern, `$1${value}`);
}

function applyRuntimeShaderDefines(fragmentSource, shapeLimit = maxShapes) {
    let src = clean(fragmentSource);
    src = replaceShaderDefine(src, 'MAX_SHAPES', shapeLimit);
    src = replaceShaderDefine(src, 'MAX_MATERIALS', MAX_MATERIALS);
    src = replaceShaderDefine(src, 'MAX_STEPS', 128);
    src = replaceShaderDefine(src, 'SHADOW_STEPS', 16);
    src = replaceShaderDefine(src, 'GLASS_EXIT_STEPS', 16);
    return stripShaderComments(src);
}

function getMaxFragmentUniformVectors(gl) {
    const vec = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    if (Number.isFinite(vec) && vec > 0) return vec;
    const comps = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_COMPONENTS);
    if (Number.isFinite(comps) && comps > 0) return Math.floor(comps / 4);
    return 256;
}

function estimateShapeBudget(gl) {
    const maxVec4 = getMaxFragmentUniformVectors(gl);
    // Keep headroom for non-shape uniforms and driver overhead.
    const reservedVec4 = 48;
    const budget = Math.floor((maxVec4 - reservedVec4) / 4);
    return THREE.MathUtils.clamp(budget, 8, HARD_MAX_SHAPES);
}

function shaderError(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    const log = gl.getShaderInfoLog(sh) || '';
    if (!ok) {
        gl.deleteShader(sh);
        return { shader: null, error: `[${label}] ${log || 'compile failed (no log)'}` };
    }
    return { shader: sh, error: null };
}

function validateShaderProgram(gl, vertexSource, fragmentSource) {
    const vertSource = `#version 300 es\n${stripShaderComments(clean(vertexSource))}`;
    const fragSource = `#version 300 es\n${stripShaderComments(clean(fragmentSource))}`;
    const vert = shaderError(gl, gl.VERTEX_SHADER, vertSource, 'Vertex');
    if (vert.error) return { ok: false, error: vert.error };
    const frag = shaderError(gl, gl.FRAGMENT_SHADER, fragSource, 'Fragment');
    if (frag.error) {
        if (vert.shader) gl.deleteShader(vert.shader);
        return { ok: false, error: frag.error };
    }

    const program = gl.createProgram();
    gl.attachShader(program, vert.shader);
    gl.attachShader(program, frag.shader);
    gl.linkProgram(program);
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    const linkLog = gl.getProgramInfoLog(program) || '';

    gl.deleteShader(vert.shader);
    gl.deleteShader(frag.shader);
    if (!linked) {
        gl.deleteProgram(program);
        return { ok: false, error: `[Link] ${linkLog || 'program link failed (no log)'}` };
    }
    gl.validateProgram(program);
    const validated = gl.getProgramParameter(program, gl.VALIDATE_STATUS);
    const validateLog = gl.getProgramInfoLog(program) || '';
    gl.deleteProgram(program);
    if (!validated) {
        return { ok: false, error: `[Validate] ${validateLog || 'program validate failed (no log)'}` };
    }
    return { ok: true };
}

function clearGlErrors(gl) {
    if (!gl) return;
    while (gl.getError() !== gl.NO_ERROR) {
        // drain error queue before/after probes
    }
}

function getFallbackFragmentShader() {
    return `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform float iTime;

void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float g = 0.5 + 0.5 * (1.0 - length(p));
    vec3 col = mix(vec3(0.04, 0.05, 0.08), vec3(0.09, 0.12, 0.18), g);
    col += 0.02 * sin(vec3(1.0, 1.7, 2.3) * (iTime * 0.6 + p.xyx * 2.2));
    fragColor = vec4(col, 1.0);
}`;
}

function switchToFallbackShader(reason = '') {
    if (!renderer || !material || usingFallbackShader) return false;
    const gl = renderer.getContext();
    const fallbackFragment = getFallbackFragmentShader();
    const vertexSource = runtimeVertexShaderSource || stripShaderComments(clean(shaderSourceCache.vert));
    const validation = validateShaderProgram(gl, vertexSource, fallbackFragment);
    if (!validation.ok) {
        bootLog(`fallback shader validation failed: ${validation.error}`);
        return false;
    }

    material.vertexShader = vertexSource;
    material.fragmentShader = fallbackFragment;
    material.needsUpdate = true;
    usingFallbackShader = true;
    renderDisabled = false;
    renderFailureCount = 0;
    bootLog(`fallback shader engaged${reason ? ` (${reason})` : ''}`);
    if (dom.bootLoaderStep && dom.bootLoader && !dom.bootLoader.classList.contains('hidden')) {
        dom.bootLoaderStep.textContent = 'Using safe shader mode for this GPU';
    }
    return true;
}

function checkRenderHealth(stage) {
    if (!renderer || renderDisabled) return false;
    const gl = renderer.getContext();
    const err = gl.getError();
    if (err === gl.NO_ERROR) {
        renderFailureCount = 0;
        return true;
    }
    renderFailureCount += 1;
    bootLog(`WebGL error ${err} at ${stage} (count=${renderFailureCount})`);
    if (!usingFallbackShader && switchToFallbackShader(`WebGL error ${err} at ${stage}`)) {
        clearGlErrors(gl);
        return false;
    }
    if (renderFailureCount >= 3) {
        renderDisabled = true;
        setStatus('error', `WebGL render failure (${err}). Rendering halted to avoid browser lockup.`);
    }
    return false;
}

function hexToRgb01(hex) {
    return [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
    ];
}

function radToDeg(v) {
    return v * (180 / Math.PI);
}

function degToRad(v) {
    return v * (Math.PI / 180);
}

function setGizmoMode(mode) {
    if (!transformControl) return;
    const next = mode === 'rotate' ? 'rotate' : 'translate';
    transformControl.setMode(next);
    transformControl.setSpace(next === 'rotate' ? 'local' : 'world');
    if (dom.gizmoModeLabel) dom.gizmoModeLabel.textContent = next === 'translate' ? 'Move' : 'Rotate';
    if (dom.btnGizmoMode) dom.btnGizmoMode.classList.toggle('active-btn', next !== 'translate');
}

function setBootProgress(progress, label) {
    const p = THREE.MathUtils.clamp(progress, 0, 1);
    if (dom.bootProgressFill) dom.bootProgressFill.style.width = `${(p * 100).toFixed(0)}%`;
    if (label && dom.bootLoaderStep) dom.bootLoaderStep.textContent = label;
    if (label) console.log(`[boot] ${label} (${(p * 100).toFixed(0)}%)`);
}

function hideBootLoader() {
    if (!dom.bootLoader) return;
    dom.bootLoader.classList.add('hidden');
    window.setTimeout(() => {
        if (dom.bootLoader) dom.bootLoader.style.display = 'none';
    }, 400);
}

function buildScene(vert, frag) {
    bootLog('buildScene enter');
    sdfCamera = new THREE.PerspectiveCamera(40, window.innerWidth/window.innerHeight, 0.1, 100);
    sdfCamera.position.set(5.0, 5.0, 8.0);
    sdfCamera.lookAt(0,0,0);
    sdfCamera.updateMatrixWorld();

    controls = new OrbitControls(sdfCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const gl = renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (!isWebGL2) {
        throw new Error('WebGL2 is required by this shader pipeline.');
    }
    const runtimeVertexSource = stripShaderComments(clean(vert));
    runtimeVertexShaderSource = runtimeVertexSource;
    usingFallbackShader = false;
    renderDisabled = false;
    renderFailureCount = 0;
    maxShapes = Math.min(estimateShapeBudget(gl), SAFE_STARTUP_SHAPE_CAP, 8);
    if (maxShapes < HARD_MAX_SHAPES) {
        console.warn(`[boot] Using MAX_SHAPES=${maxShapes} for fast startup`);
    }
    bootLog(`buildScene shader budget maxShapes=${maxShapes}`);
    const runtimeFragmentSource = applyRuntimeShaderDefines(frag, maxShapes);
    const startupFragmentSource = runtimeFragmentSource;
    const startupValidation = validateShaderProgram(gl, runtimeVertexSource, runtimeFragmentSource);
    if (!startupValidation.ok) {
        bootLog(`startup shader validation failed: ${startupValidation.error}`);
        bootLog('startup continuing to runtime warmup probe');
    }

    uniforms = {
        iResolution: { value: new THREE.Vector2(window.innerWidth*pixelRatio, window.innerHeight*pixelRatio) },
        iTime:       { value: 0.0 },
        uCameraPos:                     { value: sdfCamera.position },
        uCameraWorldMatrix:             { value: sdfCamera.matrixWorld },
        uCameraProjectionMatrixInverse: { value: sdfCamera.projectionMatrixInverse },
        uCameraFocusDistance:           { value: cameraState.focus },
        uCameraAperture:                { value: cameraState.aperture },
        uCameraFocalLength:             { value: cameraState.focalLength },
        uCameraSensorWidth:             { value: cameraState.sensorWidth },
        iMode:       { value: 0 },
        uColorLUT:   { value: COLORMAPS['magma'].tex },
        uShowFloor:  { value: true },
        // Slice
        uSliceOffset:    { value: 0.0 },
        uSliceYaw:       { value: 0.0 },
        uSlicePitch:     { value: 0.0 },
        uSliceCenter:    { value: new THREE.Vector3(0, 0, 0) },
        uSliceRadius:    { value: 3.0 },
        uContourSpacing: { value: 0.15 },
        uContourWidth:   { value: 0.003 },
        uSweepSpeed:         { value: 0.0 },
        uSliceObjectOpacity: { value: 0.5 },
        uSweepPhase:         { value: 0.0 },
    };

    shapeUniformA = new Float32Array(maxShapes * 4);
    shapeUniformB = new Float32Array(maxShapes * 4);
    shapeUniformC = new Float32Array(maxShapes * 4);
    shapeUniformD = new Float32Array(maxShapes * 4);
    uniforms.uShapeCount = { value: 0 };
    uniforms.uShapeA = { value: shapeUniformA };
    uniforms.uShapeB = { value: shapeUniformB };
    uniforms.uShapeC = { value: shapeUniformC };
    uniforms.uShapeD = { value: shapeUniformD };

    matUniformA = new Float32Array(MAX_MATERIALS * 4);
    matUniformB = new Float32Array(MAX_MATERIALS * 4);
    matUniformC = new Float32Array(MAX_MATERIALS * 4);
    uniforms.uMaterialCount = { value: 0 };
    uniforms.uMatA = { value: matUniformA };
    uniforms.uMatB = { value: matUniformB };
    uniforms.uMatC = { value: matUniformC };

    // Main SDF Material and Quad
    bootLog('buildScene creating RawShaderMaterial');
    material = new THREE.RawShaderMaterial({
        vertexShader: runtimeVertexSource,
        fragmentShader: startupFragmentSource,
        uniforms,
        glslVersion: THREE.GLSL3,
    });
    bootLog('buildScene RawShaderMaterial created');
    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(quad);

    // Preflight one render before entering RAF to avoid a lockup loop on invalid programs.
    clearGlErrors(gl);
    renderer.autoClear = true;
    renderer.render(scene, camera);
    const warmupError = gl.getError();
    if (warmupError !== gl.NO_ERROR) {
        bootLog(`startup warmup render failed with ${warmupError}`);
        if (!usingFallbackShader) {
            if (!switchToFallbackShader(`startup warmup ${warmupError}`)) {
                throw new Error(`Startup shader failed to render (${warmupError})`);
            }
            clearGlErrors(gl);
            renderer.render(scene, camera);
            const fallbackWarmupError = gl.getError();
            if (fallbackWarmupError !== gl.NO_ERROR) {
                renderDisabled = true;
                throw new Error(`Fallback shader failed to render (${fallbackWarmupError})`);
            }
        } else {
            renderDisabled = true;
            throw new Error(`Fallback shader failed to render (${warmupError})`);
        }
    }
    if (usingFallbackShader) {
        bootLog('startup continuing with fallback shader');
    }

    proxyGeometries = {
        sphere: new THREE.SphereGeometry(1, 20, 14),
        box: new THREE.BoxGeometry(2, 2, 2),
    };

    // Gizmo and Proxy Setup
    transformControl = new TransformControls(sdfCamera, renderer.domElement);
    setGizmoMode('translate');

    transformControl.addEventListener('dragging-changed', (event) => {
        controls.enabled = !event.value;
        isGizmoDragging = event.value;
        updateProxyVisuals();
    });

    // VERY IMPORTANT: Only add to proxyScene, nowhere else
    proxyScene.add(transformControl);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Attach logic
    renderer.domElement.addEventListener('pointerdown', (event) => {
        if (isGizmoDragging) return;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, sdfCamera);
        const intersects = raycaster.intersectObjects(proxyScene.children, true);

        const target = intersects.find(i => i.object.userData.shapeId !== undefined);
        if (target) {
            const shapeId = target.object.userData.shapeId;
            if (shapeId === selectedShapeId) selectShape(null);
            else selectShape(shapeId, { openInspector: true, inspectorType: 'shape' });
            return;
        }

        // Keep current selection only when clicking a gizmo handle.
        const onGizmoHandle = !!(transformControl && transformControl.axis);
        if (!onGizmoHandle) selectShape(null);
    });

    transformControl.addEventListener('change', () => {
        if (!transformControl.object) return;
        const shape = getShapeById(transformControl.object.userData.shapeId);
        if (!shape) return;
        shape.pos.copy(transformControl.object.position);
        shape.rot.copy(transformControl.object.rotation);
        updateShapeUniforms();
        if (contentUI.inspectorType === 'shape') renderInspector();
    });

    updateMaterialUniforms();
    updateSliceBoundsUniforms();
    updateCameraIntrinsicsUI();
    updateAxisWidget();
    bootLog('buildScene exit');
}



// ─────────────────────────────────────────────────────────────────────────────
// Managed Shapes
// ─────────────────────────────────────────────────────────────────────────────
function getShapeById(id) {
    return managedShapes.find(shape => shape.id === id) || null;
}

function getSelectedShape() {
    return selectedShapeId === null ? null : getShapeById(selectedShapeId);
}

function getMaterialName(id) {
    return MATERIALS.find(mat => mat.id === id)?.name || `Material ${id}`;
}

function getMaterialById(id) {
    return MATERIALS.find(mat => mat.id === id) || MATERIALS[0];
}

function createShapeProxy(shape) {
    // The group holds the position/rotation for the Gizmo
    const group = new THREE.Group();
    group.userData.shapeId = shape.id; // Needed for TransformControls
    
    const geometry = proxyGeometries[shape.type] || proxyGeometries.box;
    const material = new THREE.MeshBasicMaterial({
        color: 0x00ffaa,
        transparent: true,
        opacity: 0.12,
        wireframe: true,
        depthTest: true,
        depthWrite: false,
    });
    
    // The mesh holds the scale for the green wireframe
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.shapeId = shape.id; // Needed for the click raycaster
    
    group.add(mesh);
    shape.proxyMesh = mesh; // Store a reference to the scaled mesh
    
    proxyScene.add(group);
    return group; // Return the group so the gizmo attaches to it
}

function syncProxyFromShape(shape) {
    if (!shape.proxy) return;
    
    // Position and Rotation go on the main group (Gizmo level)
    shape.proxy.position.copy(shape.pos);
    shape.proxy.rotation.copy(shape.rot);
    
    if (!shape.proxyMesh) return;
    
    // Scale goes ONLY on the inner mesh so it doesn't distort the Gizmo
    if (shape.type === 'sphere') {
        const r = Math.max(shape.radius, 0.01);
        shape.proxyMesh.scale.set(r, r, r);
    } else {
        const sx = Math.max(shape.size.x, 0.01);
        const sy = Math.max(shape.size.y, 0.01);
        const sz = Math.max(shape.size.z, 0.01);
        shape.proxyMesh.scale.set(sx, sy, sz);
    }
}

function updateProxyVisuals() {
    const hasSelection = selectedShapeId !== null;
    if (transformControl) transformControl.visible = hasSelection;

    managedShapes.forEach(shape => {
        const isSelected = shape.id === selectedShapeId;
        if (!shape.proxy || !shape.proxyMesh) return;
        
        // Target the proxyMesh's material instead of proxy
        shape.proxyMesh.material.visible = true;
        shape.proxyMesh.material.opacity = isSelected ? 0.35 : 0.0;
        shape.proxyMesh.material.color.setHex(isSelected ? 0xffcc00 : 0x00ffaa);
    });
}

function updateShapeUniforms() {
    if (!uniforms) return;
    const count = Math.min(managedShapes.length, maxShapes);
    uniforms.uShapeCount.value = count;

    for (let i = 0; i < count; i++) {
        const shape = managedShapes[i];
        const base = i * 4;

        shapeUniformA[base + 0] = shape.pos.x;
        shapeUniformA[base + 1] = shape.pos.y;
        shapeUniformA[base + 2] = shape.pos.z;
        shapeUniformA[base + 3] = shape.type === 'sphere' ? shape.radius : 0.0;

        shapeUniformB[base + 0] = shape.size.x;
        shapeUniformB[base + 1] = shape.size.y;
        shapeUniformB[base + 2] = shape.size.z;
        shapeUniformB[base + 3] = SHAPE_TYPES[shape.type] ?? 0;

        shapeUniformC[base + 0] = shape.materialId;
        shapeUniformC[base + 1] = shape.op;
        shapeUniformC[base + 2] = 0.0;
        shapeUniformC[base + 3] = 0.0;

        shapeUniformD[base + 0] = shape.rot.x;
        shapeUniformD[base + 1] = shape.rot.y;
        shapeUniformD[base + 2] = shape.rot.z;
        shapeUniformD[base + 3] = 0.0;
    }

    for (let i = count; i < maxShapes; i++) {
        const base = i * 4;
        shapeUniformA[base + 0] = 0.0;
        shapeUniformA[base + 1] = 0.0;
        shapeUniformA[base + 2] = 0.0;
        shapeUniformA[base + 3] = 0.0;
        shapeUniformB[base + 0] = 0.0;
        shapeUniformB[base + 1] = 0.0;
        shapeUniformB[base + 2] = 0.0;
        shapeUniformB[base + 3] = 0.0;
        shapeUniformC[base + 0] = 0.0;
        shapeUniformC[base + 1] = 0.0;
        shapeUniformC[base + 2] = 0.0;
        shapeUniformC[base + 3] = 0.0;
        shapeUniformD[base + 0] = 0.0;
        shapeUniformD[base + 1] = 0.0;
        shapeUniformD[base + 2] = 0.0;
        shapeUniformD[base + 3] = 0.0;
    }

    uniforms.uShapeA.needsUpdate = true;
    uniforms.uShapeB.needsUpdate = true;
    uniforms.uShapeC.needsUpdate = true;
    uniforms.uShapeD.needsUpdate = true;

    updateSliceBoundsUniforms();
}

function updateSliceBoundsUniforms() {
    if (!uniforms || !uniforms.uSliceCenter || !uniforms.uSliceRadius) return;
    if (managedShapes.length === 0) {
        uniforms.uSliceCenter.value.set(0, 0, 0);
        uniforms.uSliceRadius.value = 3.0;
        return;
    }

    let hasBounds = false;
    shapeBounds.makeEmpty();

    managedShapes.forEach(shape => {
        // Target the proxyMesh group that contains the scale
        if (!shape.proxyMesh) return;
        shape.proxyMesh.updateMatrixWorld(true);
        tempBounds.setFromObject(shape.proxyMesh);
        if (!hasBounds) {
            shapeBounds.copy(tempBounds);
            hasBounds = true;
        } else {
            shapeBounds.union(tempBounds);
        }
    });

    if (!hasBounds) {
        uniforms.uSliceCenter.value.set(0, 0, 0);
        uniforms.uSliceRadius.value = 3.0;
        return;
    }

    shapeBounds.getBoundingSphere(shapeBoundsSphere);
    uniforms.uSliceCenter.value.copy(shapeBoundsSphere.center);
    uniforms.uSliceRadius.value = Math.max(shapeBoundsSphere.radius * 1.4, 1.5);

    // Dynamically update UI Slider to cover the absolute world bounding box
    const maxExtent = shapeBoundsSphere.center.length() + shapeBoundsSphere.radius * 1.2;
    const sliceSlider = document.getElementById('slice-offset');
    if (sliceSlider) {
        sliceSlider.min = (-maxExtent).toFixed(2);
        sliceSlider.max = maxExtent.toFixed(2);
    }
}

function updateMaterialUniforms() {
    if (!uniforms) return;
    const count = Math.min(MATERIALS.length, MAX_MATERIALS);
    uniforms.uMaterialCount.value = count;

    for (let i = 0; i < count; i++) {
        const mat = MATERIALS[i];
        const a = i * 4;
        const baseCol = hexToRgb01(mat.color);
        const gradCol = hexToRgb01(mat.useGradient ? mat.gradientColor : mat.color);

        matUniformA[a + 0] = baseCol[0];
        matUniformA[a + 1] = baseCol[1];
        matUniformA[a + 2] = baseCol[2];
        matUniformA[a + 3] = mat.roughness;

        matUniformB[a + 0] = gradCol[0];
        matUniformB[a + 1] = gradCol[1];
        matUniformB[a + 2] = gradCol[2];
        matUniformB[a + 3] = mat.metalness;

        matUniformC[a + 0] = mat.ior;
        matUniformC[a + 1] = mat.transmission;
        matUniformC[a + 2] = mat.useGradient ? 1.0 : 0.0;
        matUniformC[a + 3] = 0.0;
    }

    for (let i = count; i < MAX_MATERIALS; i++) {
        const a = i * 4;
        matUniformA[a + 0] = 0.0;
        matUniformA[a + 1] = 0.0;
        matUniformA[a + 2] = 0.0;
        matUniformA[a + 3] = 0.0;
        matUniformB[a + 0] = 0.0;
        matUniformB[a + 1] = 0.0;
        matUniformB[a + 2] = 0.0;
        matUniformB[a + 3] = 0.0;
        matUniformC[a + 0] = 1.0;
        matUniformC[a + 1] = 0.0;
        matUniformC[a + 2] = 0.0;
        matUniformC[a + 3] = 0.0;
    }

    uniforms.uMatA.needsUpdate = true;
    uniforms.uMatB.needsUpdate = true;
    uniforms.uMatC.needsUpdate = true;
}

function addManagedShape(type, overrides = {}, selectNew = true) {
    if (!SHAPE_TYPES.hasOwnProperty(type)) return null;
    if (managedShapes.length >= maxShapes) return null;

    const id = shapeIdCounter++;
    const shape = {
        id,
        type,
        name: overrides.name || `${SHAPE_LABELS[type]} ${id}`,
        pos: (overrides.pos || new THREE.Vector3(0, 0, 0)).clone(),
        rot: (overrides.rot || new THREE.Euler(0, 0, 0, 'XYZ')).clone(),
        radius: overrides.radius ?? 0.5,
        size: (overrides.size || new THREE.Vector3(1, 1, 1)).clone(),
        materialId: overrides.materialId ?? 0,
        op: overrides.op ?? SHAPE_OPS.union,
        proxy: null,
    };

    shape.proxy = createShapeProxy(shape);
    syncProxyFromShape(shape);
    managedShapes.push(shape);

    updateShapeUniforms();
    renderContentList();
    updateProxyVisuals();
    if (selectNew) selectShape(shape.id, { openInspector: true, inspectorType: 'shape' });
    return shape;
}

function selectShape(id, options = {}) {
    const { openInspector = false, inspectorType = 'shape' } = options;

    if (id === null || id === undefined) {
        selectedShapeId = null;
        if (transformControl) transformControl.detach();
        updateProxyVisuals();
        renderContentList();
        closeInspector();
        return;
    }

    const shape = getShapeById(id);
    if (!shape) {
        selectedShapeId = null;
        if (transformControl) transformControl.detach();
        updateProxyVisuals();
        renderContentList();
        closeInspector();
        return;
    }

    selectedShapeId = id;
    selectedMaterialId = shape.materialId;
    if (transformControl) transformControl.attach(shape.proxy);
    updateProxyVisuals();
    renderContentList();
    if (openInspector) openInspectorPane(inspectorType, id);
    else if (contentUI.inspectorType === 'shape') renderInspector();
}

function deleteSelectedShape() {
    const shape = getSelectedShape();
    if (!shape) return;

    const index = managedShapes.findIndex(s => s.id === shape.id);
    if (transformControl.object === shape.proxy) transformControl.detach();
    proxyScene.remove(shape.proxy);
    managedShapes.splice(index, 1);

    updateShapeUniforms();
    updateProxyVisuals();

    const next = managedShapes[index] || managedShapes[index - 1];
    selectShape(next ? next.id : null, { openInspector: !!next, inspectorType: 'shape' });
}

function seedDefaultShapes() {
    if (managedShapes.length > 0) return;
    
    // Add Glass Sphere (Material ID: 5)
    addManagedShape('sphere', {
        pos: new THREE.Vector3(-0.8, 0.0, 0.0),
        radius: 0.55,
        materialId: 5, 
    }, false);
    
    // Add Rubber Box (Material ID: 4)
    addManagedShape('box', {
        pos: new THREE.Vector3(0.8, 0.0, 0.0),
        size: new THREE.Vector3(0.76, 0.76, 0.76),
        materialId: 4, 
        op: SHAPE_OPS.union,
    }, false);
    
    if (managedShapes.length) selectShape(managedShapes[0].id);
}

function toggleCollapsible(buttonEl) {
    if (!buttonEl) return;
    const targetId = buttonEl.dataset.collapseTarget;
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    const expanded = buttonEl.getAttribute('aria-expanded') !== 'false';
    const nextExpanded = !expanded;
    buttonEl.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
    const glyph = buttonEl.querySelector('.collapse-glyph');
    if (glyph) glyph.textContent = nextExpanded ? 'v' : '^';
    target.classList.toggle('collapsed', !nextExpanded);
    if (targetId === 'content-list-grid') {
        contentUI.collapsedSections.contentList = !nextExpanded;
    }
}

function setInlineHint(message = '') {
    if (!dom.contentInlineHint) return;
    dom.contentInlineHint.textContent = message;
    dom.contentInlineHint.classList.toggle('hidden', !message);
    syncContentPaneHeights();
}

function getVisibleInspectorSection() {
    if (dom.inspectorShape && !dom.inspectorShape.classList.contains('hidden')) return dom.inspectorShape;
    if (dom.inspectorMaterial && !dom.inspectorMaterial.classList.contains('hidden')) return dom.inspectorMaterial;
    if (dom.inspectorOp && !dom.inspectorOp.classList.contains('hidden')) return dom.inspectorOp;
    if (dom.inspectorEmpty && !dom.inspectorEmpty.classList.contains('hidden')) return dom.inspectorEmpty;
    return null;
}

function syncContentPaneHeights() {
    if (!dom.contentBar || !dom.contentListGrid) return;

    const firstCard = dom.contentListGrid.querySelector('.content-card');
    if (!firstCard) return; // nothing to measure yet
    const listGridStyles = window.getComputedStyle(dom.contentListGrid);
    const listPadTop = parseFloat(listGridStyles.paddingTop) || 0;
    const listPadBottom = parseFloat(listGridStyles.paddingBottom) || 0;
    const cardHeight = firstCard.getBoundingClientRect().height;
    // A single row should show the cards + minimal padding
    const hintHeight = dom.contentInlineHint && !dom.contentInlineHint.classList.contains('hidden')
        ? dom.contentInlineHint.getBoundingClientRect().height + 4 : 0;
    // Resize handle height
    const handleHeight = 10;
    const idealH = Math.ceil(handleHeight + cardHeight + listPadTop + listPadBottom + hintHeight + 4);
    // Only set if not user-overridden (user drag sets contentUI.contentHeightPx)
    if (!Number.isFinite(contentUI.contentHeightPx)) {
        dom.contentListPane.style.height = `${idealH}px`;
    }
}

function createPreviewEnvironmentTexture(size = 256) {
    const envCanvas = document.createElement('canvas');
    envCanvas.width = size;
    envCanvas.height = Math.max(2, Math.floor(size / 2));
    const ctx = envCanvas.getContext('2d');
    if (!ctx) return null;

    const skyGradient = ctx.createLinearGradient(0, 0, 0, envCanvas.height);
    skyGradient.addColorStop(0.0, '#f6fbff');
    skyGradient.addColorStop(0.24, '#a8c8e8');
    skyGradient.addColorStop(0.55, '#5a7fa0');
    skyGradient.addColorStop(1.0, '#2c4060');
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, envCanvas.width, envCanvas.height);

    const glow = ctx.createRadialGradient(
        envCanvas.width * 0.76,
        envCanvas.height * 0.22,
        6,
        envCanvas.width * 0.76,
        envCanvas.height * 0.22,
        envCanvas.height * 0.8
    );
    glow.addColorStop(0.0, 'rgba(255, 240, 216, 0.95)');
    glow.addColorStop(1.0, 'rgba(255, 240, 216, 0.0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, envCanvas.width, envCanvas.height);

    const envTex = new THREE.CanvasTexture(envCanvas);
    envTex.colorSpace = THREE.SRGBColorSpace;
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.minFilter = THREE.LinearFilter;
    envTex.magFilter = THREE.LinearFilter;
    return envTex;
}

function createContentCard({
    title,
    meta,
    thumbClass,
    onClick,
    isActive = false,
    styleVars = null,
    symbol = null,
    thumbBackground = null,
    thumbFilter = null,
}) {
    const btn = document.createElement('button');
    btn.className = 'content-card';
    btn.type = 'button';
    if (isActive) btn.classList.add('active');

    const thumb = document.createElement('div');
    thumb.className = `content-card-thumb ${thumbClass}`;
    if (styleVars) {
        Object.entries(styleVars).forEach(([k, v]) => thumb.style.setProperty(k, v));
    }
    if (symbol) thumb.textContent = symbol;
    if (thumbBackground) {
        thumb.style.backgroundImage = thumbBackground;
        thumb.style.backgroundSize = 'cover';
        thumb.style.backgroundPosition = 'center';
    }
    if (thumbFilter) thumb.style.filter = thumbFilter;

    const titleEl = document.createElement('div');
    titleEl.className = 'content-card-title';
    titleEl.textContent = title;

    const metaEl = document.createElement('div');
    metaEl.className = 'content-card-meta';
    metaEl.textContent = meta;

    btn.appendChild(thumb);
    btn.appendChild(titleEl);
    btn.appendChild(metaEl);
    btn.addEventListener('click', onClick);
    return btn;
}

function isContentBarOpen() {
    return !!(dom.contentBar && dom.contentBar.classList.contains('open'));
}

function setActiveContentTab(tab) {
    if (!CONTENT_TABS.includes(tab)) return;
    contentUI.activeTab = tab;
    if (dom.contentTabs) {
        dom.contentTabs.querySelectorAll('.content-tab').forEach(btn => {
            const active = btn.dataset.tab === tab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
    if (dom.contentListTitle) dom.contentListTitle.textContent = CONTENT_TAB_TITLES[tab] || 'Content';
    renderContentList();
}

function getMaterialThumbKey(mat) {
    return `${mat.id}:${mat.color}|${mat.useGradient ? '1' : '0'}|${mat.gradientColor}|${mat.roughness.toFixed(3)}|${mat.metalness.toFixed(3)}|${mat.ior.toFixed(3)}|${mat.transmission.toFixed(3)}`;
}

function pruneMaterialThumbCacheForId(materialId) {
    if (!materialThumbs.cache || materialThumbs.cache.size === 0) return;
    const prefix = `${materialId}:`;
    for (const key of materialThumbs.cache.keys()) {
        if (key.startsWith(prefix)) materialThumbs.cache.delete(key);
    }
}

function ensureMaterialThumbRenderer() {
    if (materialThumbs.initialized || materialThumbs.disabled) return;
    if (webglContextLost) {
        materialThumbs.disabled = true;
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    let thumbRenderer;
    try {
        thumbRenderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance',
        });
    } catch (err) {
        materialThumbs.disabled = true;
        console.warn('Material thumbnail renderer unavailable:', err);
        return;
    }
    const renderer = thumbRenderer;
    renderer.setPixelRatio(1);
    renderer.setSize(96, 96, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.24;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f18);
    const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    cam.position.set(0.0, 0.0, 3.2);
    cam.lookAt(0, 0, 0);

    const ambient = new THREE.HemisphereLight(0xeaf4ff, 0x7090b0, 1.4);
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(2.4, 2.7, 2.2);
    const fill = new THREE.DirectionalLight(0x9dc5ff, 1.0);
    fill.position.set(-2.3, 1.2, 1.7);
    const rim = new THREE.DirectionalLight(0x8ad4ff, 0.6);
    rim.position.set(-1.2, -1.4, -2.4);
    const bottom = new THREE.DirectionalLight(0x6090c0, 0.55);
    bottom.position.set(0, -3, 0);
    scene.add(ambient, key, fill, rim, bottom);

    const envTex = createPreviewEnvironmentTexture(256);
    if (envTex) scene.environment = envTex;

    const texCanvas = document.createElement('canvas');
    texCanvas.width = 128;
    texCanvas.height = 128;
    const gradientTex = new THREE.CanvasTexture(texCanvas);
    gradientTex.colorSpace = THREE.SRGBColorSpace;
    gradientTex.minFilter = THREE.LinearFilter;
    gradientTex.magFilter = THREE.LinearFilter;

    const sphereMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.4,
        metalness: 0.0,
        ior: 1.0,
        transmission: 0.0,
        thickness: 0.0,
        attenuationDistance: 1.5,
        attenuationColor: new THREE.Color('#ffffff'),
        clearcoat: 0.15,
        clearcoatRoughness: 0.2,
        envMapIntensity: 1.1,
        map: gradientTex,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.86, SAFE_PREVIEW_SEGMENTS, Math.max(12, Math.floor(SAFE_PREVIEW_SEGMENTS * 0.75))), sphereMat);
    scene.add(sphere);

    materialThumbs.initialized = true;
    materialThumbs.renderer = renderer;
    materialThumbs.scene = scene;
    materialThumbs.camera = cam;
    materialThumbs.mesh = sphere;
    materialThumbs.texture = gradientTex;
    materialThumbs.environment = envTex;
    materialThumbs.canvas = canvas;
}

function applyMaterialToPreviewMaterial(targetMat, targetTexture, mat) {
    if (targetTexture) updateMaterialGradientTexture(targetTexture, mat);
    targetMat.roughness = THREE.MathUtils.clamp(mat.roughness, 0.0, 1.0);
    targetMat.metalness = THREE.MathUtils.clamp(mat.metalness, 0.0, 1.0);
    targetMat.ior = THREE.MathUtils.clamp(mat.ior, 1.0, 2.2);
    targetMat.transmission = THREE.MathUtils.clamp(mat.transmission, 0.0, 1.0);
    targetMat.thickness = THREE.MathUtils.lerp(0.08, 0.42, targetMat.transmission);
    targetMat.attenuationDistance = THREE.MathUtils.lerp(1000.0, 6.5, targetMat.transmission);
    targetMat.attenuationColor.set(mat.color);
    targetMat.envMapIntensity = 1.15;
    targetMat.needsUpdate = true;
}

function getMaterialThumbDataUrl(mat) {
    ensureMaterialThumbRenderer();
    if (!materialThumbs.initialized || !materialThumbs.renderer || !materialThumbs.mesh || !materialThumbs.canvas) return '';
    const key = getMaterialThumbKey(mat);
    const cached = materialThumbs.cache.get(key);
    if (cached) return cached;
    const thumbMat = materialThumbs.mesh.material;
    applyMaterialToPreviewMaterial(thumbMat, materialThumbs.texture, mat);
    materialThumbs.renderer.render(materialThumbs.scene, materialThumbs.camera);
    const url = materialThumbs.canvas.toDataURL('image/png');
    materialThumbs.cache.set(key, url);
    return url;
}

function renderContentList() {
    if (!dom.contentListGrid) return;
    if (!isContentBarOpen()) {
        contentUI.listDirty = true;
        return;
    }
    contentUI.listDirty = false;
    dom.contentListGrid.innerHTML = '';
    if (dom.contentListTitle) dom.contentListTitle.textContent = CONTENT_TAB_TITLES[contentUI.activeTab] || 'Content';
    if (contentUI.activeTab !== 'ops') setInlineHint('');

    if (contentUI.activeTab === 'objects') {
        managedShapes.forEach((shape, index) => {
            const opLabel = index === 0 ? 'Base' : (SHAPE_OP_LABELS[shape.op] || 'Union');
            const mat = getMaterialById(shape.materialId);
            const meta = `${SHAPE_LABELS[shape.type]} · ${getMaterialName(shape.materialId)} · ${opLabel}`;
            const matB = mat.useGradient ? mat.gradientColor : mat.color;
            const styleVars = {
                '--mat-a': mat.color,
                '--mat-b': matB,
                '--mat-r': String(mat.roughness),
                '--mat-m': String(mat.metalness),
                '--mat-t': String(mat.transmission),
            };
            const thumbFilter = shape.type === 'box'
                ? `saturate(${(0.9 + mat.metalness * 0.35).toFixed(2)}) brightness(${(0.88 + (1.0 - mat.roughness) * 0.25 + mat.transmission * 0.08).toFixed(2)}) contrast(${(0.95 + mat.metalness * 0.25).toFixed(2)})`
                : null;
            const card = createContentCard({
                title: shape.name,
                meta,
                thumbClass: shape.type === 'sphere' ? 'sphere' : 'box',
                styleVars,
                thumbBackground: shape.type === 'sphere' ? `url("${getMaterialThumbDataUrl(mat)}")` : null,
                thumbFilter,
                isActive: shape.id === selectedShapeId,
                onClick: () => selectShape(shape.id, { openInspector: true, inspectorType: 'shape' }),
            });
            dom.contentListGrid.appendChild(card);
        });
        if (!managedShapes.length) setInlineHint('No scene objects yet. Open Shapes tab to add one.');
        syncContentPaneHeights();
        return;
    }

    if (contentUI.activeTab === 'shapes') {
        const defaultSphereMat = getMaterialById(0) || MATERIALS[0];
        const entries = [
            { type: 'sphere', title: 'Sphere', meta: 'Position + radius' },
            { type: 'box', title: 'Box', meta: 'Position + size' },
        ];
        entries.forEach(entry => {
            const card = createContentCard({
                title: entry.title,
                meta: entry.meta,
                thumbClass: entry.type,
                thumbBackground: entry.type === 'sphere' ? `url("${getMaterialThumbDataUrl(defaultSphereMat)}")` : null,
                onClick: () => {
                    const shape = addManagedShape(entry.type);
                    if (shape) {
                        setActiveContentTab('objects');
                        openInspectorPane('shape', shape.id);
                    }
                },
            });
            dom.contentListGrid.appendChild(card);
        });
        syncContentPaneHeights();
        return;
    }

    if (contentUI.activeTab === 'materials') {
        const selectedShape = getSelectedShape();
        const activeId = selectedShape ? selectedShape.materialId : selectedMaterialId;
        MATERIALS.forEach(mat => {
            const card = createContentCard({
                title: mat.name,
                meta: `r ${mat.roughness.toFixed(2)} · m ${mat.metalness.toFixed(2)} · t ${mat.transmission.toFixed(2)}`,
                thumbClass: 'material',
                isActive: mat.id === activeId,
                styleVars: { '--mat-a': mat.color, '--mat-b': mat.useGradient ? mat.gradientColor : mat.color },
                thumbBackground: `url("${getMaterialThumbDataUrl(mat)}")`,
                onClick: () => {
                    selectedMaterialId = mat.id;
                    const shape = getSelectedShape();
                    if (shape) {
                        shape.materialId = mat.id;
                        updateShapeUniforms();
                    }
                    renderContentList();
                    openInspectorPane('material', mat.id);
                },
            });
            dom.contentListGrid.appendChild(card);
        });
        syncContentPaneHeights();
        return;
    }

    const opCards = [
        { id: SHAPE_OPS.union, title: 'Union', meta: 'Combine with previous shape', symbol: 'U' },
        { id: SHAPE_OPS.intersect, title: 'Intersect', meta: 'Keep overlap volume', symbol: 'I' },
        { id: SHAPE_OPS.subtract, title: 'Subtract', meta: 'Cut shape from previous', symbol: 'S' },
    ];
    const selectedShape = getSelectedShape();
    opCards.forEach(op => {
        const card = createContentCard({
            title: op.title,
            meta: op.meta,
            thumbClass: 'op',
            symbol: op.symbol,
            isActive: !!selectedShape && selectedShape.op === op.id,
            onClick: () => applyOpToSelected(op.id),
        });
        dom.contentListGrid.appendChild(card);
    });
    syncContentPaneHeights();
}

function updateShapeEditorFields(shape) {
    if (!dom.shapeEditor || !shape) return;

    if (dom.shapeName) dom.shapeName.value = shape.name;
    if (dom.shapePosX) dom.shapePosX.value = shape.pos.x.toFixed(2);
    if (dom.shapePosY) dom.shapePosY.value = shape.pos.y.toFixed(2);
    if (dom.shapePosZ) dom.shapePosZ.value = shape.pos.z.toFixed(2);
    if (dom.shapeRotX) dom.shapeRotX.value = radToDeg(shape.rot.x).toFixed(1);
    if (dom.shapeRotY) dom.shapeRotY.value = radToDeg(shape.rot.y).toFixed(1);
    if (dom.shapeRotZ) dom.shapeRotZ.value = radToDeg(shape.rot.z).toFixed(1);
    if (dom.shapeRadius) dom.shapeRadius.value = shape.radius.toFixed(2);
    if (dom.shapeSizeX) dom.shapeSizeX.value = shape.size.x.toFixed(2);
    if (dom.shapeSizeY) dom.shapeSizeY.value = shape.size.y.toFixed(2);
    if (dom.shapeSizeZ) dom.shapeSizeZ.value = shape.size.z.toFixed(2);
    if (dom.shapeMaterial) dom.shapeMaterial.value = String(shape.materialId);
    if (dom.shapeOp) dom.shapeOp.value = String(shape.op);

    if (dom.shapeRadiusRow)
        dom.shapeRadiusRow.style.display = shape.type === 'sphere' ? 'flex' : 'none';
    if (dom.shapeSizeRow)
        dom.shapeSizeRow.style.display = shape.type === 'box' ? 'flex' : 'none';

    const baseShape = managedShapes[0];
    const isBase = baseShape && baseShape.id === shape.id;
    if (dom.shapeOp) dom.shapeOp.disabled = !!isBase;
    if (dom.shapeOpHint)
        dom.shapeOpHint.textContent = isBase
            ? 'Base shape: operation locked to Union.'
            : 'Operation is applied vs. previous shape.';
}

function updateMaterialGradientTexture(texture, mat) {
    if (!texture) return;
    const canvas = texture.image;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (mat.useGradient) {
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, mat.color);
        gradient.addColorStop(1, mat.gradientColor);
        ctx.fillStyle = gradient;
    } else {
        ctx.fillStyle = mat.color;
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
}

function ensureMaterialPreview() {
    if (materialPreview.initialized || materialPreview.disabled || !dom.materialPreviewCanvas) return;
    if (webglContextLost) {
        materialPreview.disabled = true;
        return;
    }
    materialPreview.canvas = dom.materialPreviewCanvas;
    let previewRenderer;
    try {
        previewRenderer = new THREE.WebGLRenderer({
            canvas: dom.materialPreviewCanvas,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
    } catch (err) {
        materialPreview.disabled = true;
        console.warn('Material preview renderer unavailable:', err);
        return;
    }
    previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
    previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    previewRenderer.toneMappingExposure = 1.24;
    previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, SAFE_PREVIEW_PIXEL_RATIO_CAP));

    const previewScene = new THREE.Scene();
    previewScene.background = new THREE.Color(0x0a0f18);
    const previewCam = new THREE.PerspectiveCamera(32, 1, 0.1, 30);
    previewCam.position.set(0.0, 0.0, 3.2);
    previewCam.lookAt(0, 0, 0);

    const ambient = new THREE.HemisphereLight(0xeaf4ff, 0x7090b0, 1.4);
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(2.4, 2.7, 2.2);
    const fill = new THREE.DirectionalLight(0x9dc5ff, 1.0);
    fill.position.set(-2.3, 1.2, 1.7);
    const rim = new THREE.DirectionalLight(0x8ad4ff, 0.6);
    rim.position.set(-1.2, -1.4, -2.4);
    const bottom = new THREE.DirectionalLight(0x6090c0, 0.55);
    bottom.position.set(0, -3, 0);
    previewScene.add(ambient, key, fill, rim, bottom);

    const envTex = createPreviewEnvironmentTexture(256);
    if (envTex) previewScene.environment = envTex;

    const texCanvas = document.createElement('canvas');
    texCanvas.width = 256;
    texCanvas.height = 256;
    const gradientTex = new THREE.CanvasTexture(texCanvas);
    gradientTex.colorSpace = THREE.SRGBColorSpace;
    gradientTex.minFilter = THREE.LinearFilter;
    gradientTex.magFilter = THREE.LinearFilter;

    const sphereMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.4,
        metalness: 0.0,
        ior: 1.0,
        transmission: 0.0,
        thickness: 0.0,
        attenuationDistance: 1.5,
        attenuationColor: new THREE.Color('#ffffff'),
        clearcoat: 0.15,
        clearcoatRoughness: 0.2,
        envMapIntensity: 1.1,
        map: gradientTex,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.86, SAFE_PREVIEW_SEGMENTS, Math.max(12, Math.floor(SAFE_PREVIEW_SEGMENTS * 0.75))), sphereMat);
    previewScene.add(sphere);

    materialPreview.initialized = true;
    materialPreview.renderer = previewRenderer;
    materialPreview.scene = previewScene;
    materialPreview.camera = previewCam;
    materialPreview.mesh = sphere;
    materialPreview.texture = gradientTex;
    materialPreview.environment = envTex;
    materialPreview.dirty = true;
}

function resizeMaterialPreviewIfNeeded() {
    if (!materialPreview.initialized || !materialPreview.canvas) return;
    const wrap = materialPreview.canvas.parentElement;
    // Measure from parent container, not canvas itself (canvas distorts its own rect when unsized)
    const rect = wrap ? wrap.getBoundingClientRect() : materialPreview.canvas.getBoundingClientRect();
    const width  = Math.max(80, Math.floor(rect.width));
    const height = Math.max(80, Math.floor(rect.height));
    if (width === materialPreview.size.w && height === materialPreview.size.h) return;
    materialPreview.size.w = width;
    materialPreview.size.h = height;
    // setSize(w, h, false) sets the drawing buffer but doesn't touch CSS
    materialPreview.renderer.setSize(width, height, false);
    materialPreview.camera.aspect = width / height;
    materialPreview.camera.updateProjectionMatrix();
    materialPreview.dirty = true;
}

function updateMaterialInspectorFields() {
    const mat = getMaterialById(selectedMaterialId);
    if (!mat) return;

    if (dom.matRoughness) dom.matRoughness.value = mat.roughness.toFixed(2);
    if (dom.matRoughnessVal) dom.matRoughnessVal.textContent = mat.roughness.toFixed(2);
    if (dom.matMetalness) dom.matMetalness.value = mat.metalness.toFixed(2);
    if (dom.matMetalnessVal) dom.matMetalnessVal.textContent = mat.metalness.toFixed(2);
    if (dom.matIor) dom.matIor.value = mat.ior.toFixed(2);
    if (dom.matIorVal) dom.matIorVal.textContent = mat.ior.toFixed(2);
    if (dom.matTransmission) dom.matTransmission.value = mat.transmission.toFixed(2);
    if (dom.matTransmissionVal) dom.matTransmissionVal.textContent = mat.transmission.toFixed(2);
    if (dom.matColor) dom.matColor.value = mat.color;
    if (dom.matGradientEnabled) dom.matGradientEnabled.checked = !!mat.useGradient;
    if (dom.matGradientColor) {
        dom.matGradientColor.value = mat.gradientColor;
        dom.matGradientColor.disabled = !mat.useGradient;
        dom.matGradientColor.style.opacity = mat.useGradient ? '1' : '0.5';
    }

    ensureMaterialPreview();
    if (!materialPreview.initialized || !materialPreview.mesh) return;
    const previewMat = materialPreview.mesh.material;
    applyMaterialToPreviewMaterial(previewMat, materialPreview.texture, mat);
    materialPreview.dirty = true;
    syncContentPaneHeights();
}

function renderMaterialPreview(delta) {
    if (!materialPreview.initialized || !materialPreview.renderer || !materialPreview.mesh) return;
    const isVisible = contentUI.inspectorOpen
        && contentUI.inspectorType === 'material'
        && dom.inspectorFloat
        && !dom.inspectorFloat.classList.contains('hidden')
        && dom.inspectorMaterial
        && !dom.inspectorMaterial.classList.contains('hidden');
    if (!isVisible) return;
    resizeMaterialPreviewIfNeeded();
    materialPreview.mesh.rotation.y += delta * 0.42;
    materialPreview.renderer.render(materialPreview.scene, materialPreview.camera);
    materialPreview.dirty = false;
}

function openInspectorPane(type, targetId = null) {
    contentUI.inspectorOpen = true;
    contentUI.inspectorType = type;
    contentUI.inspectorTargetId = targetId;
    if (dom.inspectorFloat) dom.inspectorFloat.classList.remove('hidden');
    renderInspector();
    syncContentPaneHeights();
}

function closeInspector() {
    contentUI.inspectorOpen = false;
    contentUI.inspectorType = null;
    contentUI.inspectorTargetId = null;
    if (dom.inspectorFloat) dom.inspectorFloat.classList.add('hidden');
    syncContentPaneHeights();
}

function renderInspector() {
    if (!dom.inspectorFloat || !contentUI.inspectorOpen) {
        syncContentPaneHeights();
        return;
    }
    if (dom.inspectorShape) dom.inspectorShape.classList.add('hidden');
    if (dom.inspectorMaterial) dom.inspectorMaterial.classList.add('hidden');
    if (dom.inspectorOp) dom.inspectorOp.classList.add('hidden');
    if (dom.inspectorEmpty) dom.inspectorEmpty.classList.add('hidden');

    if (contentUI.inspectorType === 'shape') {
        const shape = getShapeById(contentUI.inspectorTargetId ?? selectedShapeId);
        if (!shape) {
            closeInspector();
            return;
        }
        if (dom.inspectorTitle) dom.inspectorTitle.textContent = 'Shape';
        if (dom.inspectorSubtitle) dom.inspectorSubtitle.textContent = `${shape.name} · ${SHAPE_LABELS[shape.type]}`;
        if (dom.inspectorShape) dom.inspectorShape.classList.remove('hidden');
        updateShapeEditorFields(shape);
        syncContentPaneHeights();
        return;
    }

    if (contentUI.inspectorType === 'material') {
        const matId = contentUI.inspectorTargetId ?? selectedMaterialId;
        const mat = getMaterialById(matId);
        if (!mat) return;
        selectedMaterialId = mat.id;
        if (dom.inspectorTitle) dom.inspectorTitle.textContent = 'Material';
        if (dom.inspectorSubtitle) dom.inspectorSubtitle.textContent = mat.name;
        if (dom.inspectorMaterial) dom.inspectorMaterial.classList.remove('hidden');
        updateMaterialInspectorFields();
        syncContentPaneHeights();
        return;
    }

    if (contentUI.inspectorType === 'op') {
        if (dom.inspectorTitle) dom.inspectorTitle.textContent = 'Operation';
        const shape = getSelectedShape();
        if (dom.inspectorSubtitle) dom.inspectorSubtitle.textContent = shape ? shape.name : 'No shape selected';
        if (dom.inspectorOp) dom.inspectorOp.classList.remove('hidden');
        if (dom.opEditorSelect) dom.opEditorSelect.value = String(shape ? shape.op : SHAPE_OPS.union);
        if (dom.opEditorHint) {
            if (!shape) dom.opEditorHint.textContent = 'Select a shape first, then apply Union/Intersect/Subtract.';
            else if (managedShapes[0] && managedShapes[0].id === shape.id) dom.opEditorHint.textContent = 'Base shape operation is fixed to Union.';
            else dom.opEditorHint.textContent = 'Operation is evaluated against the previous shape order.';
        }
        syncContentPaneHeights();
        return;
    }

    if (dom.inspectorTitle) dom.inspectorTitle.textContent = 'Inspector';
    if (dom.inspectorSubtitle) dom.inspectorSubtitle.textContent = 'Select an item';
    if (dom.inspectorEmpty) dom.inspectorEmpty.classList.remove('hidden');
    syncContentPaneHeights();
}

function applyOpToSelected(opId, options = {}) {
    const { showInspector = true } = options;
    const shape = getSelectedShape();
    if (!shape) {
        setInlineHint('Select an object first to apply a CSG operation.');
        closeInspector();
        return;
    }
    const baseShape = managedShapes[0];
    if (baseShape && baseShape.id === shape.id) {
        if (opId !== SHAPE_OPS.union) {
            setInlineHint('Base object is locked to Union.');
        } else {
            setInlineHint('');
        }
        shape.op = SHAPE_OPS.union;
    } else {
        shape.op = opId;
        setInlineHint('');
    }
    updateShapeUniforms();
    renderContentList();
    if (showInspector) openInspectorPane('op', shape.id);
    else if (contentUI.inspectorType === 'shape') renderInspector();
}

function applyMaterialField(field, value) {
    const mat = getMaterialById(selectedMaterialId);
    if (!mat) return;
    pruneMaterialThumbCacheForId(mat.id);
    mat[field] = value;
    updateMaterialUniforms();
    renderContentList();
    updateMaterialInspectorFields();
}

function initContentResize() {
    // ── List pane top-drag resize ─────────────────────────────────────────────
    const listHandle = dom.contentResizeHandle;
    const listPane = dom.contentListPane;
    if (listHandle && listPane) {
        let dragging = false;
        let startY = 0;
        let startH = 0;
        const minH = 108;
        const maxH = () => Math.round(window.innerHeight * 0.55);

        listHandle.addEventListener('pointerdown', (e) => {
            dragging = true;
            startY = e.clientY;
            startH = listPane.getBoundingClientRect().height;
            listHandle.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        listHandle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            // Dragging UP increases height (handle is at top, list grows upward)
            const dy = startY - e.clientY;
            const newH = THREE.MathUtils.clamp(startH + dy, minH, maxH());
            contentUI.contentHeightPx = newH;
            listPane.style.height = `${newH}px`;
        });
        listHandle.addEventListener('pointerup', (e) => {
            dragging = false;
            listHandle.releasePointerCapture(e.pointerId);
        });
    }

    // ── Floating inspector: drag + resize ─────────────────────────────────────
    initFloatingInspector();

    syncContentPaneHeights();
}

function initFloatingInspector() {
    const floatEl = dom.inspectorFloat;
    if (!floatEl) return;

    const titlebar = document.getElementById('inspector-float-titlebar');
    const corner   = floatEl.querySelector('.inspector-float-resize-corner');
    const edges    = floatEl.querySelectorAll('.inspector-float-resize-edge');

    // Normalize to left/top/width/height coordinates, clearing right/bottom
    function getRect() {
        const r = floatEl.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    function applyRect(x, y, w, h) {
        const minW = 220, minH = 180;
        w = Math.max(w, minW); h = Math.max(h, minH);
        x = Math.max(0, Math.min(x, window.innerWidth  - w));
        y = Math.max(0, Math.min(y, window.innerHeight - h));
        floatEl.style.right  = 'auto';
        floatEl.style.bottom = 'auto';
        floatEl.style.left   = x + 'px';
        floatEl.style.top    = y + 'px';
        floatEl.style.width  = w + 'px';
        floatEl.style.height = h + 'px';
    }

    let state = null; // { mode, startX, startY, startRect, edge }

    // ── Drag (move) ───────────────────────────────────────────────────────────
    titlebar && titlebar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.asset-close')) return;
        e.preventDefault();
        const r = getRect();
        state = { mode: 'move', startX: e.clientX, startY: e.clientY, startRect: r };
        floatEl.style.boxShadow = '0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(100,190,255,0.35)';
        floatEl.style.transition = 'none';
        document.addEventListener('pointermove', onDocMove);
        document.addEventListener('pointerup',   onDocUp);
    });

    // ── Resize ────────────────────────────────────────────────────────────────
    function startResize(e, edge) {
        e.preventDefault();
        const r = getRect();
        state = { mode: 'resize', edge, startX: e.clientX, startY: e.clientY, startRect: r };
        floatEl.style.transition = 'none';
        document.addEventListener('pointermove', onDocMove);
        document.addEventListener('pointerup',   onDocUp);
    }
    corner && corner.addEventListener('pointerdown', (e) => startResize(e, 'corner'));
    edges.forEach(el => {
        const cls = Array.from(el.classList).find(c => c.startsWith('edge-')) || 'corner';
        el.addEventListener('pointerdown', (e) => startResize(e, cls));
    });

    // ── Shared doc listeners ─────────────────────────────────────────────────
    function onDocMove(e) {
        if (!state) return;
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        const r  = state.startRect;

        if (state.mode === 'move') {
            applyRect(r.x + dx, r.y + dy, r.w, r.h);
        } else {
            let { x, y, w, h } = r;
            const edge = state.edge;
            if (edge === 'corner' || edge === 'edge-e') w = r.w + dx;
            if (edge === 'corner' || edge === 'edge-s') h = r.h + dy;
            if (edge === 'edge-w') { x = r.x + dx; w = r.w - dx; }
            if (edge === 'edge-n') { y = r.y + dy; h = r.h - dy; }
            applyRect(x, y, w, h);
            // Tell material preview to re-measure
            if (materialPreview.initialized) {
                materialPreview.size.w = 0;
                resizeMaterialPreviewIfNeeded();
            }
        }
    }
    function onDocUp() {
        state = null;
        floatEl.style.boxShadow = '';
        floatEl.style.transition = '';
        document.removeEventListener('pointermove', onDocMove);
        document.removeEventListener('pointerup',   onDocUp);
    }
}

function setupContentUI() {
    if (dom.btnContent && dom.contentBar) {
        const toggleContent = () => {
            const isOpen = dom.contentBar.classList.toggle('open');
            dom.btnContent.classList.toggle('active-btn', isOpen);
            if (isOpen && contentUI.listDirty) renderContentList();
            syncContentPaneHeights();
        };
        dom.btnContent.addEventListener('click', () => {
            toggleContent();
            window.dispatchEvent(new Event('mousemove'));
        });
        if (dom.contentClose) {
            dom.contentClose.addEventListener('click', () => {
                dom.contentBar.classList.remove('open');
                dom.btnContent.classList.remove('active-btn');
                syncContentPaneHeights();
            });
        }
    }

    if (dom.contentTabs) {
        dom.contentTabs.querySelectorAll('.content-tab').forEach(btn => {
            btn.addEventListener('click', () => setActiveContentTab(btn.dataset.tab));
        });
    }

    if (dom.inspectorClose) dom.inspectorClose.addEventListener('click', closeInspector);
    if (dom.btnDeleteShape) dom.btnDeleteShape.addEventListener('click', deleteSelectedShape);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeInspector();
            return;
        }
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || active.closest('.cm-editor')))
            return;
        deleteSelectedShape();
    });

    if (dom.shapeMaterial) {
        dom.shapeMaterial.innerHTML = '';
        MATERIALS.forEach(mat => {
            const opt = document.createElement('option');
            opt.value = String(mat.id);
            opt.textContent = mat.name;
            dom.shapeMaterial.appendChild(opt);
        });
    }

    if (dom.shapeName) {
        dom.shapeName.addEventListener('input', () => {
            const shape = getSelectedShape();
            if (!shape) return;
            shape.name = dom.shapeName.value.trim() || `${SHAPE_LABELS[shape.type]} ${shape.id}`;
            renderContentList();
            if (contentUI.inspectorType === 'shape') renderInspector();
        });
    }

    const bindRotation = (el, axis) => {
        if (!el) return;
        el.addEventListener('input', () => {
            const v = parseFloat(el.value);
            if (!Number.isFinite(v)) return;
            const shape = getSelectedShape();
            if (!shape) return;
            shape.rot[axis] = degToRad(v);
            syncProxyFromShape(shape);
            updateShapeUniforms();
        });
    };

    const bindNumber = (el, apply) => {
        if (!el) return;
        el.addEventListener('input', () => {
            const v = parseFloat(el.value);
            if (!Number.isFinite(v)) return;
            const shape = getSelectedShape();
            if (!shape) return;
            apply(shape, v);
            syncProxyFromShape(shape);
            updateShapeUniforms();
        });
    };

    bindNumber(dom.shapePosX, (shape, v) => shape.pos.x = v);
    bindNumber(dom.shapePosY, (shape, v) => shape.pos.y = v);
    bindNumber(dom.shapePosZ, (shape, v) => shape.pos.z = v);
    bindRotation(dom.shapeRotX, 'x');
    bindRotation(dom.shapeRotY, 'y');
    bindRotation(dom.shapeRotZ, 'z');
    bindNumber(dom.shapeRadius, (shape, v) => shape.radius = Math.max(v, 0.01));
    bindNumber(dom.shapeSizeX, (shape, v) => shape.size.x = Math.max(v, 0.01));
    bindNumber(dom.shapeSizeY, (shape, v) => shape.size.y = Math.max(v, 0.01));
    bindNumber(dom.shapeSizeZ, (shape, v) => shape.size.z = Math.max(v, 0.01));

    if (dom.shapeMaterial) {
        dom.shapeMaterial.addEventListener('change', () => {
            const shape = getSelectedShape();
            if (!shape) return;
            shape.materialId = parseInt(dom.shapeMaterial.value, 10);
            selectedMaterialId = shape.materialId;
            updateShapeUniforms();
            renderContentList();
            if (contentUI.inspectorType === 'material') renderInspector();
        });
    }

    if (dom.shapeOp) {
        dom.shapeOp.addEventListener('change', () => {
            const nextOp = parseInt(dom.shapeOp.value, 10);
            if (!Number.isFinite(nextOp)) return;
            applyOpToSelected(nextOp, { showInspector: false });
        });
    }

    if (dom.opEditorApply) {
        dom.opEditorApply.addEventListener('click', () => {
            const value = dom.opEditorSelect ? parseInt(dom.opEditorSelect.value, 10) : SHAPE_OPS.union;
            applyOpToSelected(Number.isFinite(value) ? value : SHAPE_OPS.union);
        });
    }

    if (dom.matRoughness) dom.matRoughness.addEventListener('input', () => {
        const v = parseFloat(dom.matRoughness.value);
        if (!Number.isFinite(v)) return;
        if (dom.matRoughnessVal) dom.matRoughnessVal.textContent = v.toFixed(2);
        applyMaterialField('roughness', v);
    });
    if (dom.matMetalness) dom.matMetalness.addEventListener('input', () => {
        const v = parseFloat(dom.matMetalness.value);
        if (!Number.isFinite(v)) return;
        if (dom.matMetalnessVal) dom.matMetalnessVal.textContent = v.toFixed(2);
        applyMaterialField('metalness', v);
    });
    if (dom.matIor) dom.matIor.addEventListener('input', () => {
        const v = parseFloat(dom.matIor.value);
        if (!Number.isFinite(v)) return;
        if (dom.matIorVal) dom.matIorVal.textContent = v.toFixed(2);
        applyMaterialField('ior', v);
    });
    if (dom.matTransmission) dom.matTransmission.addEventListener('input', () => {
        const v = parseFloat(dom.matTransmission.value);
        if (!Number.isFinite(v)) return;
        if (dom.matTransmissionVal) dom.matTransmissionVal.textContent = v.toFixed(2);
        applyMaterialField('transmission', v);
    });
    if (dom.matColor) dom.matColor.addEventListener('input', () => {
        applyMaterialField('color', dom.matColor.value);
    });
    if (dom.matGradientEnabled) dom.matGradientEnabled.addEventListener('change', () => {
        applyMaterialField('useGradient', !!dom.matGradientEnabled.checked);
    });
    if (dom.matGradientColor) dom.matGradientColor.addEventListener('input', () => {
        applyMaterialField('gradientColor', dom.matGradientColor.value);
    });

    initContentResize();
    setActiveContentTab(contentUI.activeTab);
    syncContentPaneHeights();
}

function updateAxisWidget() {
    if (!sdfCamera || !dom.axisLineX || !dom.axisLineY || !dom.axisLineZ) return;

    axisInvQuat.copy(sdfCamera.quaternion).invert();
    axisVecX.set(1, 0, 0).applyQuaternion(axisInvQuat);
    axisVecY.set(0, 1, 0).applyQuaternion(axisInvQuat);
    axisVecZ.set(0, 0, 1).applyQuaternion(axisInvQuat);

    const cx = 40;
    const cy = 40;
    const len = 24;

    const updateAxis = (v, line, dot, label) => {
        const x = cx + v.x * len;
        const y = cy - v.y * len;
        const depth = 0.45 + ((v.z + 1.0) * 0.275);
        line.setAttribute('x1', String(cx));
        line.setAttribute('y1', String(cy));
        line.setAttribute('x2', x.toFixed(2));
        line.setAttribute('y2', y.toFixed(2));
        line.style.opacity = depth.toFixed(3);
        dot.setAttribute('cx', x.toFixed(2));
        dot.setAttribute('cy', y.toFixed(2));
        dot.style.opacity = depth.toFixed(3);
        label.setAttribute('x', x.toFixed(2));
        label.setAttribute('y', y.toFixed(2));
        label.style.opacity = depth.toFixed(3);
    };

    updateAxis(axisVecX, dom.axisLineX, dom.axisDotX, dom.axisLabelX);
    updateAxis(axisVecY, dom.axisLineY, dom.axisDotY, dom.axisLabelY);
    updateAxis(axisVecZ, dom.axisLineZ, dom.axisDotZ, dom.axisLabelZ);
}

function updateCameraIntrinsicsUI() {
    if (!sdfCamera) return;
    const width = Math.max(1, window.innerWidth * pixelRatio);
    const height = Math.max(1, window.innerHeight * pixelRatio);
    const fovRad = THREE.MathUtils.degToRad(sdfCamera.fov);
    const fx = 0.5 * width / Math.tan(fovRad * 0.5);
    const fy = 0.5 * height / Math.tan(fovRad * 0.5);

    if (dom.camFx) dom.camFx.textContent = fx.toFixed(2);
    if (dom.camFy) dom.camFy.textContent = fy.toFixed(2);
    if (dom.camCx) dom.camCx.textContent = '0.50';
    if (dom.camCy) dom.camCy.textContent = '0.50';
}

// ─────────────────────────────────────────────────────────────────────────────
// Render loop
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let lastTime = 0; // Track time to get the delta

function animate() {
    requestAnimationFrame(animate);
    if (!firstFrameLogged) {
        firstFrameLogged = true;
        bootLog('first animation frame');
    }
    
    const now = clock.getElapsedTime();
    const delta = now - lastTime;
    lastTime = now;
    stats.update();

    if (renderDisabled || webglContextLost || !renderer || !uniforms) return;
    
    if (!isPaused) {
        uniforms.iTime.value = now;
        uniforms.uSweepPhase.value += delta * uniforms.uSweepSpeed.value;
    }
    
    if (controls) controls.update();
    if (sdfCamera) {
        sdfCamera.updateMatrixWorld();
        // Keep shader in sync with 3D camera
        uniforms.uCameraPos.value.copy(sdfCamera.position);
        uniforms.uCameraWorldMatrix.value.copy(sdfCamera.matrixWorld);
        uniforms.uCameraProjectionMatrixInverse.value.copy(sdfCamera.projectionMatrixInverse);
        updateAxisWidget();
    }

    // 1. Render the Background (SDF)
    renderer.autoClear = true;
    renderer.render(scene, camera);
    if (!checkRenderHealth('main scene')) return;

    // 2. Render the Foreground (Gizmos & Proxies)
    renderer.autoClear = false; // Don't wipe the SDF we just drew
    renderer.clearDepth();      // Wipe the depth buffer so 3D objects draw correctly
    
    // proxyScene now contains both the proxies and the transformControl
    if (selectedShapeId !== null || isGizmoDragging) {
        renderer.render(proxyScene, sdfCamera);
        if (!checkRenderHealth('proxy scene')) return;
    }
    renderMaterialPreview(delta);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI
// ─────────────────────────────────────────────────────────────────────────────
function setupUI() {
    // ── Idle detection ───────────────────────────────────────────────────────
    // Reset on ALL user interactions — mousemove, click, keydown, wheel.
    // This fixes the bug where clicking UI without moving mouse would let
    // the idle timer still fire and hide controls.
    function resetIdle() {
        dom.uiElements.forEach(el => el.classList.remove('idle'));
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            const contentOpen = dom.contentBar && dom.contentBar.classList.contains('open');
            const cameraOpen = dom.cameraPanel && dom.cameraPanel.classList.contains('open');
            if (!dom.panel.classList.contains('open') && !contentOpen && !cameraOpen)
                dom.uiElements.forEach(el => el.classList.add('idle'));
        }, 4000);
    }

    document.querySelectorAll('.panel-title').forEach(title => {
        if (!title.hasAttribute('aria-expanded')) title.setAttribute('aria-expanded', 'true');
        title.addEventListener('click', () => {
            // Toggle the 'minimized' class on the parent .controls-panel
            title.parentElement.classList.toggle('minimized');
            const expanded = !title.parentElement.classList.contains('minimized');
            title.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            // Reset idle timer so the UI doesn't vanish while you are interacting
            resetIdle(); 
        });
    });

    window.addEventListener('mousemove', resetIdle);
    window.addEventListener('mousedown', resetIdle);  // catches all clicks
    window.addEventListener('keydown',   resetIdle);
    window.addEventListener('wheel',     resetIdle);
    resetIdle();

    // ── Resize ───────────────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        uniforms.iResolution.value.set(window.innerWidth*pixelRatio, window.innerHeight*pixelRatio);
        if (sdfCamera) { sdfCamera.aspect=window.innerWidth/window.innerHeight; sdfCamera.updateProjectionMatrix(); }
        if (contentUI.contentHeightPx && dom.contentBar) {
            const minH = Math.max(170, Math.round(window.innerHeight * 0.2));
            const maxH = Math.round(window.innerHeight * 0.82);
            const clamped = THREE.MathUtils.clamp(contentUI.contentHeightPx, minH, maxH);
            contentUI.contentHeightPx = clamped;
        }
        updateCameraIntrinsicsUI();
        updateAxisWidget();
        resizeMaterialPreviewIfNeeded();
        syncContentPaneHeights();
    });

    // ── Edit shaders — TOGGLE open/closed ────────────────────────────────────
    dom.btnEdit.onclick = async () => {
        const opening = !dom.panel.classList.contains('open');
        dom.panel.classList.toggle('open');
        resetIdle();
        if (!opening || (editorVertView && editorFragView)) return;
        setStatus('loading');
        try {
            await ensureEditorsInitialized();
            setStatus('live');
        } catch (err) {
            setStatus('error', `Editor load failed: ${String(err)}`);
        }
    };
    dom.btnClose.onclick = () => { dom.panel.classList.remove('open'); resetIdle(); };

    // ── Tabs ──────────────────────────────────────────────────────────────────
    const switchTab = (v) => {
        dom.tabVert.classList.toggle('active',  v);
        dom.tabFrag.classList.toggle('active', !v);
        dom.editorVert.classList.toggle('hidden', !v);
        dom.editorFrag.classList.toggle('hidden',  v);
    };
    dom.tabVert.onclick = () => switchTab(true);
    dom.tabFrag.onclick = () => switchTab(false);

    // ── Pause ─────────────────────────────────────────────────────────────────
    dom.btnPause.onclick = () => {
        isPaused = !isPaused;
        dom.iconPlay.classList.toggle('hidden',  !isPaused);
        dom.iconPause.classList.toggle('hidden',  isPaused);
        dom.btnPause.classList.toggle('active-btn', isPaused);
    };

    // ── Reset camera ──────────────────────────────────────────────────────────
    dom.btnReset.onclick = () => {
        if (sdfCamera) {
            sdfCamera.position.set(5,5,8);
            sdfCamera.lookAt(0,0,0);
            controls.target.set(0, 0, 0);
            controls.update();
            sdfCamera.updateProjectionMatrix();
        }
        updateCameraIntrinsicsUI();
        updateAxisWidget();
        clock.start();
    };

    // ── Floor toggle ──────────────────────────────────────────────────────────
    const btnFloor = document.getElementById('btn-floor');
    if (btnFloor) {
        btnFloor.onclick = () => {
            const next = !uniforms.uShowFloor.value;
            uniforms.uShowFloor.value = next;
            btnFloor.classList.toggle('active-btn', !next);
            btnFloor.title = next ? 'Toggle floor (on)' : 'Toggle floor (off)';
        };
    }

    // ── Screenshot ────────────────────────────────────────────────────────────
    dom.btnShot.onclick = () => {
        renderer.render(scene, camera);
        const a = document.createElement('a');
        a.download = `sdf-${Date.now()}.png`;
        a.href = renderer.domElement.toDataURL(); a.click();
    };

    if (dom.btnGizmoMode) {
        dom.btnGizmoMode.onclick = () => {
            if (!transformControl) return;
            const next = transformControl.mode === 'translate' ? 'rotate' : 'translate';
            setGizmoMode(next);
        };
        window.addEventListener('keydown', (event) => {
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || active.closest('.cm-editor'))) {
                return;
            }
            if (event.key.toLowerCase() === 'w') {
                setGizmoMode('translate');
            } else if (event.key.toLowerCase() === 'e') {
                setGizmoMode('rotate');
            }
        });
        setGizmoMode(transformControl && transformControl.mode === 'rotate' ? 'rotate' : 'translate');
    }

    if (dom.btnCamera && dom.cameraPanel) {
        dom.btnCamera.onclick = () => {
            dom.cameraPanel.classList.toggle('open');
            dom.btnCamera.classList.toggle('active-btn', dom.cameraPanel.classList.contains('open'));
            resetIdle();
        };
    }

    // ── Mode menu — build items ───────────────────────────────────────────────
    MODES.forEach((m, i) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'mode-menu-item';
        btn.textContent = m.label;
        btn.onclick = (e) => {
            e.stopPropagation();
            currentMode = i; applyMode(i);
            dom.modeMenuList.classList.remove('open');
        };
        li.appendChild(btn);
        dom.modeMenuList.appendChild(li);
    });

    dom.btnModeMenu.onclick = (e) => {
        e.stopPropagation();
        dom.modeMenuList.classList.toggle('open');
    };
    document.addEventListener('click', () => dom.modeMenuList.classList.remove('open'));

    // ── Mode pill cycle ───────────────────────────────────────────────────────
    dom.btnMode.onclick = () => {
        currentMode = (currentMode + 1) % MODES.length;
        applyMode(currentMode);
    };

    function applyMode(idx) {
        const m = MODES[idx];
        uniforms.iMode.value = m.id;
        dom.modeLabel.textContent = m.label;
        MODES.forEach(x => dom.btnMode.classList.remove(x.cls));
        dom.btnMode.classList.add(m.cls);
        // Show correct panel
        dom.slicePanel.classList.toggle('visible', m.id === 4);
        dom.heatPanel.classList.toggle('visible',   m.id === 1);
        // Highlight active item in menu
        dom.modeMenuList.querySelectorAll('.mode-menu-item').forEach((el,i) => {
            el.classList.toggle('active', i === idx);
        });
    }
    applyMode(0);

    // ── Slider helper ─────────────────────────────────────────────────────────
    function slider(elId, valId, uniformKey, fmt) {
        const el = document.getElementById(elId);
        const ve = document.getElementById(valId);
        if (!el || !ve) return;
        el.addEventListener('input', () => {
            const v = parseFloat(el.value);
            if (uniformKey) uniforms[uniformKey].value = v;
            ve.textContent = fmt(v);
        });
    }

    // ── Slice sliders ─────────────────────────────────────────────────────────
    slider('slice-offset',   'slice-offset-val',   'uSliceOffset',    v => v.toFixed(2));
    slider('slice-yaw',      'slice-yaw-val',       'uSliceYaw',       v => v.toFixed(0) + '°');
    slider('slice-pitch',    'slice-pitch-val',     'uSlicePitch',     v => v.toFixed(0) + '°');
    slider('contour-spacing','contour-spac-val',    'uContourSpacing', v => v.toFixed(2));
    slider('contour-width',  'contour-width-val',   'uContourWidth',   v => v.toFixed(3));
    slider('slice-sweep',    'slice-sweep-val',    'uSweepSpeed',         v => v.toFixed(0));
    slider('slice-opacity',  'slice-opacity-val',  'uSliceObjectOpacity', v => v.toFixed(2));

    const bindCameraSlider = (sliderEl, labelEl, apply, fmt) => {
        if (!sliderEl || !labelEl) return;
        sliderEl.addEventListener('input', () => {
            if (isSyncingCameraInputs) return;
            const v = parseFloat(sliderEl.value);
            if (!Number.isFinite(v)) return;
            apply(v);
            labelEl.textContent = fmt(v);
            sdfCamera.updateProjectionMatrix();
            uniforms.uCameraProjectionMatrixInverse.value.copy(sdfCamera.projectionMatrixInverse);
            updateCameraIntrinsicsUI();
        });
    };

    bindCameraSlider(dom.camFov, dom.camFovVal, (v) => {
        sdfCamera.fov = v;
    }, (v) => `${v.toFixed(0)}°`);

    bindCameraSlider(dom.camNear, dom.camNearVal, (v) => {
        sdfCamera.near = Math.max(0.01, v);
    }, (v) => v.toFixed(2));

    bindCameraSlider(dom.camFar, dom.camFarVal, (v) => {
        sdfCamera.far = Math.max(sdfCamera.near + 0.5, v);
    }, (v) => v.toFixed(0));

    bindCameraSlider(dom.camFocus, dom.camFocusVal, (v) => {
        cameraState.focus = v;
        uniforms.uCameraFocusDistance.value = v;
    }, (v) => v.toFixed(1));

    bindCameraSlider(dom.camAperture, dom.camApertureVal, (v) => {
        cameraState.aperture = v;
        uniforms.uCameraAperture.value = v;
    }, (v) => v.toFixed(2));

    const syncFovFromLens = () => {
        const sensorHeight = cameraState.sensorWidth / Math.max(0.001, sdfCamera.aspect);
        const fov = THREE.MathUtils.radToDeg(2.0 * Math.atan((sensorHeight * 0.5) / Math.max(1.0, cameraState.focalLength)));
        const clamped = THREE.MathUtils.clamp(fov, 20, 110);
        sdfCamera.fov = clamped;
        if (dom.camFov && dom.camFovVal) {
            isSyncingCameraInputs = true;
            dom.camFov.value = clamped.toFixed(0);
            dom.camFovVal.textContent = `${clamped.toFixed(0)}°`;
            isSyncingCameraInputs = false;
        }
    };

    bindCameraSlider(dom.camFocal, dom.camFocalVal, (v) => {
        cameraState.focalLength = v;
        uniforms.uCameraFocalLength.value = v;
        syncFovFromLens();
    }, (v) => v.toFixed(0));

    bindCameraSlider(dom.camSensor, dom.camSensorVal, (v) => {
        cameraState.sensorWidth = v;
        uniforms.uCameraSensorWidth.value = v;
        syncFovFromLens();
    }, (v) => v.toFixed(0));

    // ── Colormap selector ─────────────────────────────────────────────────────
    Object.keys(COLORMAPS).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        if (name === 'magma') opt.selected = true;
        dom.cmSelect.appendChild(opt);
    });
    function updateSwatch() {
        const stops = COLORMAPS[dom.cmSelect.value]?.stops || [];
        if (dom.cmSwatch) dom.cmSwatch.style.background =
            `linear-gradient(90deg,${stops.join(',')})`;
    }
    dom.cmSelect.addEventListener('change', () => {
        uniforms.uColorLUT.value = COLORMAPS[dom.cmSelect.value].tex;
        updateSwatch();
    });
    updateSwatch();

    // ── Panel drag-resize ─────────────────────────────────────────────────────
    let resizing = false;
    dom.dragHandle.addEventListener('mousedown', () => {
        resizing=true; dom.panel.classList.add('resizing'); document.body.style.cursor='ew-resize';
    });
    document.addEventListener('mousemove', e => { if (resizing) dom.panel.style.width = Math.max(300,e.clientX)+'px'; });
    document.addEventListener('mouseup',   () => { resizing=false; dom.panel.classList.remove('resizing'); document.body.style.cursor=''; });

    if (dom.camFov) dom.camFov.value = sdfCamera.fov.toFixed(0);
    if (dom.camFovVal) dom.camFovVal.textContent = `${sdfCamera.fov.toFixed(0)}°`;
    if (dom.camNear) dom.camNear.value = sdfCamera.near.toFixed(2);
    if (dom.camNearVal) dom.camNearVal.textContent = sdfCamera.near.toFixed(2);
    if (dom.camFar) dom.camFar.value = sdfCamera.far.toFixed(0);
    if (dom.camFarVal) dom.camFarVal.textContent = sdfCamera.far.toFixed(0);
    if (dom.camFocus) dom.camFocus.value = cameraState.focus.toFixed(1);
    if (dom.camFocusVal) dom.camFocusVal.textContent = cameraState.focus.toFixed(1);
    if (dom.camAperture) dom.camAperture.value = cameraState.aperture.toFixed(2);
    if (dom.camApertureVal) dom.camApertureVal.textContent = cameraState.aperture.toFixed(2);
    if (dom.camFocal) dom.camFocal.value = cameraState.focalLength.toFixed(0);
    if (dom.camFocalVal) dom.camFocalVal.textContent = cameraState.focalLength.toFixed(0);
    if (dom.camSensor) dom.camSensor.value = cameraState.sensorWidth.toFixed(0);
    if (dom.camSensorVal) dom.camSensorVal.textContent = cameraState.sensorWidth.toFixed(0);
    updateCameraIntrinsicsUI();
    updateAxisWidget();

    setupContentUI();
}

// ─────────────────────────────────────────────────────────────────────────────
// Live compile
// ─────────────────────────────────────────────────────────────────────────────
function compile() {
    if (!renderer || !material || webglContextLost) {
        setStatus('error', 'WebGL is unavailable');
        return;
    }
    const gl = renderer.getContext();
    const { vert: vSrc, frag: fSrc } = getCurrentShaderSources();
    const runtimeVert = stripShaderComments(clean(vSrc));
    const runtimeFrag = applyRuntimeShaderDefines(fSrc, maxShapes);
    const validation = validateShaderProgram(gl, runtimeVert, runtimeFrag);
    if (!validation.ok) {
        setStatus('error', validation.error);
        return;
    }
    shaderSourceCache.vert = vSrc;
    shaderSourceCache.frag = fSrc;
    runtimeVertexShaderSource = runtimeVert;
    usingFallbackShader = false;
    renderDisabled = false;
    renderFailureCount = 0;
    material.vertexShader = runtimeVert;
    material.fragmentShader = runtimeFrag;
    material.needsUpdate    = true;
    setStatus('live');
}

function setStatus(state, msg) {
    const s = dom.status;
    dom.errTooltip.classList.add('hidden');
    if (!s) return;
    if (state === 'live') {
        s.textContent = '● live';
        s.style.color = '#4dffaa';
    } else if (state === 'typing') {
        s.textContent = '◌ editing…';
        s.style.color = '#ffcc44';
    } else if (state === 'loading') {
        s.textContent = '◌ loading editor…';
        s.style.color = '#8fbfff';
    } else {
        s.textContent = '✕ error';
        s.style.color = '#ff4466';
        dom.errText.textContent = msg;
        dom.errTooltip.classList.remove('hidden');
    }
}

init();