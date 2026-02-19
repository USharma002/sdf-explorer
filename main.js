import * as THREE from 'three';
import { CodeJar } from 'codejar';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';

// ── State ─────────────────────────────────────────────────────────────────────
let scene, camera, renderer;
let uniforms, material, quad;
let isPaused = false;
let isDragging = false;
let idleTimer;
let controls;

// ── DOM ───────────────────────────────────────────────────────────────────────
const dom = {
    panel:      document.getElementById('editor-panel'),
    dragHandle: document.getElementById('drag-handle'),
    btnEdit:    document.getElementById('btn-edit'),
    btnClose:   document.getElementById('close-editor'),
    editorVert: document.getElementById('editor-vert'),
    editorFrag: document.getElementById('editor-frag'),
    status:     document.getElementById('compile-status'),
    errTooltip: document.getElementById('error-tooltip'),
    errText:    document.getElementById('error-text'),
    tabVert:    document.getElementById('tab-vert'),
    tabFrag:    document.getElementById('tab-frag'),
    uiElements: document.querySelectorAll('.ui-element'),
    btnPause:   document.getElementById('btn-pause'),
    btnReset:   document.getElementById('btn-reset'),
    btnMode:    document.getElementById('btn-mode'),
    btnShot:    document.getElementById('btn-screenshot'),
    iconPlay:   document.getElementById('icon-play'),
    iconPause:  document.getElementById('icon-pause'),
    modeLabel:  document.getElementById('mode-label'),
    canvas:     document.getElementById('canvas-container'),
};

// ── Editor (CodeJar) ─────────────────────────────────────────────────────────
// Fix Enter key: CodeJar intercepts it; we re-bind to insert a real newline
const highlight = (el) => window.Prism?.highlightElement(el);

function makeJar(el) {
    const jar = CodeJar(el, highlight, { tab: '    ' });

    // Override Enter to insert newline + auto-indent without triggering compile
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.stopPropagation(); // prevent CodeJar's own handler bubbling to our debounce
    }, true); // capture phase — fires before CodeJar

    return jar;
}

const jarVert = makeJar(dom.editorVert);
const jarFrag = makeJar(dom.editorFrag);

let pixelRatio;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    scene  = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    pixelRatio = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(pixelRatio);

    dom.canvas.appendChild(renderer.domElement);

    try {
        const [vert, frag] = await Promise.all([
            fetch('shaders/vertex.glsl').then(r => { if (!r.ok) throw r.statusText; return r.text(); }),
            fetch('shaders/fragment.glsl').then(r => { if (!r.ok) throw r.statusText; return r.text(); }),
        ]);
        jarVert.updateCode(vert);
        jarFrag.updateCode(frag);
        buildScene(vert, frag);
        setupUI();
        setupInteraction();
        animate();
        setStatus('live');
    } catch (e) {
        console.error(e);
        setStatus('error', String(e));
    }
}

// Strip #version — Three.js GLSL3 mode injects its own
const clean = src => src.replace(/^\s*#version\s+\S+[^\n]*\n?/m, '');

// At the top with your state variables
let sdfCamera;

function buildScene(vert, frag) {
// 1. Create a virtual camera for SDF calculations
    sdfCamera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
    sdfCamera.position.set(5.0, 5.0, 8.0); 
    sdfCamera.lookAt(0, 0, 0);
    sdfCamera.updateMatrixWorld(); 

    // 2. Add OrbitControls
    controls = new OrbitControls(sdfCamera, renderer.domElement);
    controls.enableDamping = true; // Adds smooth momentum
    controls.dampingFactor = 0.05;

    uniforms = {
        iResolution: { value: new THREE.Vector2(
            window.innerWidth * pixelRatio, 
            window.innerHeight * pixelRatio
        )},
        iTime:       { value: 0.0 },
        uCameraPos:                     { value: sdfCamera.position },
        uCameraWorldMatrix:             { value: sdfCamera.matrixWorld },
        uCameraProjectionMatrixInverse: { value: sdfCamera.projectionMatrixInverse },
        iMode:       { value: 0 },
    };

    material = new THREE.RawShaderMaterial({
        vertexShader:   clean(vert),
        fragmentShader: clean(frag),
        uniforms,
        glslVersion: THREE.GLSL3,
    });

    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    scene.add(quad);
}


// ── Render loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    if (!isPaused) uniforms.iTime.value = clock.getElapsedTime();
    // Update controls and push new matrices to the shader
    if (controls) controls.update();
    if (sdfCamera) sdfCamera.updateMatrixWorld();

    renderer.render(scene, camera);
}

// ── Mouse & zoom interaction ──────────────────────────────────────────────────
function setupInteraction() {
    const cvs = renderer.domElement;
    cvs.addEventListener('contextmenu', e => e.preventDefault());

    let dragStart = { x: 0, y: 0 };
    let mouseAtDragStart = { x: 0, y: 0 };

    cvs.addEventListener('mousedown', (e) => {
        if (dom.panel.classList.contains('open')) return;
        isDragging = true;
        const r = cvs.getBoundingClientRect();
        // Record where drag started — don't move camera yet
        dragStart.x = e.clientX - r.left;
        dragStart.y = e.clientY - r.top;
        mouseAtDragStart.x = uniforms.iMouse.value.x;
        mouseAtDragStart.y = uniforms.iMouse.value.y;
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const r = cvs.getBoundingClientRect();
        const dx = (e.clientX - r.left) - dragStart.x;
        const dy = (e.clientY - r.top)  - dragStart.y;
        // Accumulate delta so camera continues from where it was
        uniforms.iMouse.value.x = mouseAtDragStart.x + dx;
        uniforms.iMouse.value.y = mouseAtDragStart.y + dy;
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    cvs.addEventListener('wheel', (e) => {
        e.preventDefault();
        uniforms.iCamDist.value = Math.max(1.0, Math.min(20.0,
            uniforms.iCamDist.value + e.deltaY * 0.01));
    }, { passive: false });
}

// ── UI wiring ─────────────────────────────────────────────────────────────────
function setupUI() {
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        
        uniforms.iResolution.value.set(
            window.innerWidth * pixelRatio, 
            window.innerHeight * pixelRatio
        );

        // Keep the SDF camera aspect ratio from stretching
        if (sdfCamera) {
            sdfCamera.aspect = window.innerWidth / window.innerHeight;
            sdfCamera.updateProjectionMatrix();
        }
    });

    // Panel open/close
    dom.btnEdit.onclick  = () => dom.panel.classList.add('open');
    dom.btnClose.onclick = () => dom.panel.classList.remove('open');

    // Tabs
    const switchTab = (vert) => {
        dom.tabVert.classList.toggle('active',  vert);
        dom.tabFrag.classList.toggle('active', !vert);
        dom.editorVert.classList.toggle('hidden', !vert);
        dom.editorFrag.classList.toggle('hidden',  vert);
    };
    dom.tabVert.onclick = () => switchTab(true);
    dom.tabFrag.onclick = () => switchTab(false);

    // Pause/Play
    dom.btnPause.onclick = () => {
        isPaused = !isPaused;
        dom.iconPlay.classList.toggle('hidden',  !isPaused);
        dom.iconPause.classList.toggle('hidden',  isPaused);
        dom.btnPause.classList.toggle('active-btn', isPaused);
    };

    // Reset
    dom.btnReset.onclick = () => {
        uniforms.iCamDist.value = 4.0;
        uniforms.iMouse.value.set(0, 0, 0, 0);
        clock.start();
    };

    // Mode toggle (shaded ↔ heatmap)
    dom.btnMode.onclick = () => {
        const next = (uniforms.iMode.value + 1) % 3;
        uniforms.iMode.value = next;
        dom.modeLabel.textContent = next === 0 ? 'shaded' : next === 1 ? 'heatmap' : 'normal';
        dom.btnMode.classList.toggle('shaded-btn', next === 0);
        dom.btnMode.classList.toggle('heatmap-btn', next === 1);
        dom.btnMode.classList.toggle('normal-btn', next === 2);
    };

    // Screenshot
    dom.btnShot.onclick = () => {
        renderer.render(scene, camera);
        const a = document.createElement('a');
        a.download = `sdf-${Date.now()}.png`;
        a.href = renderer.domElement.toDataURL();
        a.click();
    };

    // Idle fade
    const resetIdle = () => {
        dom.uiElements.forEach(el => el.classList.remove('idle'));
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (!dom.panel.classList.contains('open'))
                dom.uiElements.forEach(el => el.classList.add('idle'));
        }, 3000);
    };
    window.addEventListener('mousemove', resetIdle);

    // Live compile — 900 ms debounce after last keystroke
    let compileTimer;
    const scheduleCompile = () => {
        setStatus('typing');
        clearTimeout(compileTimer);
        compileTimer = setTimeout(compile, 900);
    };
    jarVert.onUpdate(scheduleCompile);
    jarFrag.onUpdate(scheduleCompile);

    // Panel resize drag
    let resizing = false;
    dom.dragHandle.addEventListener('mousedown', () => {
        resizing = true;
        dom.panel.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
    });
    document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        dom.panel.style.width = Math.max(300, e.clientX) + 'px';
    });
    document.addEventListener('mouseup', () => {
        resizing = false;
        dom.panel.classList.remove('resizing');
        document.body.style.cursor = '';
    });
}

// ── Live compile ──────────────────────────────────────────────────────────────
function compile() {
    const gl   = renderer.getContext();
    const vSrc = jarVert.toString();
    const fSrc = jarFrag.toString();

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

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(state, msg) {
    const s = dom.status;
    dom.errTooltip.classList.add('hidden');
    if (state === 'live') {
        s.textContent = '● live'; s.style.color = '#4dffaa';
    } else if (state === 'typing') {
        s.textContent = '◌ editing…'; s.style.color = '#ffcc44';
    } else {
        s.textContent = '✕ error'; s.style.color = '#ff4466';
        dom.errText.textContent = msg;
        dom.errTooltip.classList.remove('hidden');
    }
}

init();