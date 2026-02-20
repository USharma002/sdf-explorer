import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';

import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { cpp } from "@codemirror/lang-cpp";
import { indentWithTab } from "@codemirror/commands";
import { selectNextOccurrence } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";


import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';

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

const scheduleCompile = () => {
    setStatus('typing');
    clearTimeout(compileTimer);
    compileTimer = setTimeout(compile, 500);
};

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
// Monokai Theme
// ─────────────────────────────────────────────────────────────────────────────
const monokaiTheme = EditorView.theme({
    "&": {
        color: "#f8f8f2",
        backgroundColor: "transparent",
        height: "100%"
    },
    ".cm-content": {
        caretColor: "#f8f8f0",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "13px"
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#f8f8f0" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "#49483e !important" },
    ".cm-panels": { backgroundColor: "#272822", color: "#f8f8f2" },
    ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
    ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },
    ".cm-searchMatch": {
        backgroundColor: "#72a114",
        outline: "1px solid #457d00"
    },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#6199ff2f" },
    ".cm-activeLine": { backgroundColor: "#3e3d32" },
    ".cm-selectionMatch": { backgroundColor: "#aafe661a" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: "#bad0f847",
        outline: "1px solid #515a6b"
    },
    ".cm-gutters": {
        backgroundColor: "transparent",
        color: "#75715e",
        border: "none"
    },
    ".cm-activeLineGutter": {
        backgroundColor: "#3e3d32",
        color: "#c2c1b4"
    },
    ".cm-tooltip": {
        border: "none",
        backgroundColor: "#35342f"
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "#504f46",
        color: "#f8f8f2"
    }
}, { dark: true });

const monokaiHighlightStyle = HighlightStyle.define([
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
]);

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
    iconPlay:       document.getElementById('icon-play'),
    iconPause:      document.getElementById('icon-pause'),
    modeLabel:      document.getElementById('mode-label'),
    canvas:         document.getElementById('canvas-container'),
    // panels
    slicePanel:     document.getElementById('slice-panel'),
    pbrPanel:       document.getElementById('pbr-panel'),
    heatPanel:      document.getElementById('heat-panel'),
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
    // pbr
    roughness:      document.getElementById('pbr-roughness'),
    roughnessVal:   document.getElementById('pbr-roughness-val'),
    metalness:      document.getElementById('pbr-metalness'),
    metalnessVal:   document.getElementById('pbr-metalness-val'),
    color1:         document.getElementById('pbr-color1'),
    color2:         document.getElementById('pbr-color2'),
    // heatmap
    cmSelect:       document.getElementById('cm-select'),
    cmSwatch:       document.getElementById('cm-swatch'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Editor
// ─────────────────────────────────────────────────────────────────────────────
function createEditor(element, initialCode, onUpdate) {
    return new EditorView({
        doc: initialCode,
        extensions: [
            basicSetup, cpp(),
            keymap.of([indentWithTab, { key:'Mod-d', run:selectNextOccurrence }]),
            EditorView.updateListener.of(u => { if (u.docChanged) onUpdate(); }),
            monokaiTheme,                                  // NEW: Add the UI theme
            syntaxHighlighting(monokaiHighlightStyle)      // NEW: Add the syntax highlighting
        ],
        parent: element
    });
}

let stats;
// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
    scene  = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    renderer = new THREE.WebGLRenderer({ 
        antialias: false, 
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
    });

    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

    if (debugInfo) {
        const rendererName = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        console.log("Currently rendering on: ", rendererName);
    } else {
        console.log("Could not read GPU info.");
    }
    
    renderer.setSize(window.innerWidth, window.innerHeight);
    pixelRatio = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(pixelRatio);
    dom.canvas.appendChild(renderer.domElement);

    // Initialize Stats
    stats = new Stats();
    stats.dom.style.zIndex = '50';

    // stats.showPanel(0); // 0: fps, 1: ms, 2: mb
    document.body.appendChild(stats.dom);

    try {
        const [vert, frag] = await Promise.all([
            fetch('shaders/vertex.glsl').then(r => { if (!r.ok) throw r.statusText; return r.text(); }),
            fetch('shaders/fragment.glsl').then(r => { if (!r.ok) throw r.statusText; return r.text(); }),
        ]);
        editorVertView = createEditor(dom.editorVert, vert, scheduleCompile);
        editorFragView = createEditor(dom.editorFrag, frag, scheduleCompile);
        buildScene(vert, frag);
        setupUI();
        animate();
        setStatus('live');
    } catch (e) {
        console.error(e);
        setStatus('error', String(e));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scene
// ─────────────────────────────────────────────────────────────────────────────
const clean = src => src.replace(/^\s*#version\s+\S+[^\n]*\n?/m,'');

function hexToVec3(hex) {
    const r = parseInt(hex.slice(1,3),16)/255;
    const g = parseInt(hex.slice(3,5),16)/255;
    const b = parseInt(hex.slice(5,7),16)/255;
    return new THREE.Vector3(r,g,b);
}

function buildScene(vert, frag) {
    sdfCamera = new THREE.PerspectiveCamera(40, window.innerWidth/window.innerHeight, 0.1, 100);
    sdfCamera.position.set(5.0, 5.0, 8.0);
    sdfCamera.lookAt(0,0,0);
    sdfCamera.updateMatrixWorld();

    controls = new OrbitControls(sdfCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    uniforms = {
        iResolution: { value: new THREE.Vector2(window.innerWidth*pixelRatio, window.innerHeight*pixelRatio) },
        iTime:       { value: 0.0 },
        uCameraPos:                     { value: sdfCamera.position },
        uCameraWorldMatrix:             { value: sdfCamera.matrixWorld },
        uCameraProjectionMatrixInverse: { value: sdfCamera.projectionMatrixInverse },
        iMode:       { value: 0 },
        uColorLUT:   { value: COLORMAPS['magma'].tex },
        uShowFloor:  { value: true },
        // PBR
        uRoughness:  { value: 0.4 },
        uMetalness:  { value: 0.0 },
        uColor1:     { value: hexToVec3('#6699cc') },
        uColor2:     { value: hexToVec3('#cc8844') },
        // Slice
        uSliceOffset:    { value: 0.0 },
        uSliceYaw:       { value: 0.0 },
        uSlicePitch:     { value: 0.0 },
        uContourSpacing: { value: 0.15 },
        uContourWidth:   { value: 0.003 },
        uContourWidth:       { value: 0.003 },
        uSweepSpeed:         { value: 0.0 },
        uSliceObjectOpacity: { value: 0.5 },
        uSweepPhase:         { value: 0.0 },
    };

    material = new THREE.RawShaderMaterial({
        vertexShader:   clean(vert),
        fragmentShader: clean(frag),
        uniforms,
        glslVersion: THREE.GLSL3,
    });

    quad = new THREE.Mesh(new THREE.PlaneGeometry(2,2), material);
    scene.add(quad);
}

// ─────────────────────────────────────────────────────────────────────────────
// Render loop
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let lastTime = 0; // Track time to get the delta

function animate() {
    requestAnimationFrame(animate);
    
    const now = clock.getElapsedTime();
    const delta = now - lastTime;
    lastTime = now;

    stats.update(); 
    
    if (!isPaused) {
        uniforms.iTime.value = now;
        // Cleanly accumulate the phase using the CURRENT speed and delta time
        uniforms.uSweepPhase.value += delta * uniforms.uSweepSpeed.value;
    }
    
    if (controls) controls.update();
    if (sdfCamera) sdfCamera.updateMatrixWorld();
    renderer.render(scene, camera);
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
            if (!dom.panel.classList.contains('open'))
                dom.uiElements.forEach(el => el.classList.add('idle'));
        }, 4000);
    }

    document.querySelectorAll('.panel-title').forEach(title => {
        title.addEventListener('click', () => {
            // Toggle the 'minimized' class on the parent .controls-panel
            title.parentElement.classList.toggle('minimized');
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
    });

    // ── Edit shaders — TOGGLE open/closed ────────────────────────────────────
    dom.btnEdit.onclick = () => { dom.panel.classList.toggle('open'); resetIdle(); };
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
        if (sdfCamera) { sdfCamera.position.set(5,5,8); sdfCamera.lookAt(0,0,0); }
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
        dom.pbrPanel.classList.toggle('visible',   m.id === 0);
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

    // ── PBR sliders ───────────────────────────────────────────────────────────
    slider('pbr-roughness', 'pbr-roughness-val', 'uRoughness', v => v.toFixed(2));
    slider('pbr-metalness', 'pbr-metalness-val', 'uMetalness', v => v.toFixed(2));

    // ── Color pickers ─────────────────────────────────────────────────────────
    dom.color1.addEventListener('input', () => {
        uniforms.uColor1.value.copy(hexToVec3(dom.color1.value));
    });
    dom.color2.addEventListener('input', () => {
        uniforms.uColor2.value.copy(hexToVec3(dom.color2.value));
    });

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
}

// ─────────────────────────────────────────────────────────────────────────────
// Live compile
// ─────────────────────────────────────────────────────────────────────────────
function compile() {
    const gl   = renderer.getContext();
    const vSrc = editorVertView.state.doc.toString();
    const fSrc = editorFragView.state.doc.toString();
    const vErr = shaderError(gl, gl.VERTEX_SHADER,   vSrc, 'Vertex');
    if (vErr) { setStatus('error', vErr); return; }
    const fErr = shaderError(gl, gl.FRAGMENT_SHADER, fSrc, 'Fragment');
    if (fErr) { setStatus('error', fErr); return; }
    material.vertexShader   = clean(vSrc);
    material.fragmentShader = clean(fSrc);
    material.needsUpdate    = true;
    setStatus('live');
}

function shaderError(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    const ok  = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    const log = ok ? null : `[${label}] ${gl.getShaderInfoLog(sh)}`;
    gl.deleteShader(sh);
    return log;
}

function setStatus(state, msg) {
    const s = dom.status;
    dom.errTooltip.classList.add('hidden');
    if      (state==='live')   { s.textContent='● live';     s.style.color='#4dffaa'; }
    else if (state==='typing') { s.textContent='◌ editing…'; s.style.color='#ffcc44'; }
    else                       { s.textContent='✕ error';    s.style.color='#ff4466'; dom.errText.textContent=msg; dom.errTooltip.classList.remove('hidden'); }
}

init();