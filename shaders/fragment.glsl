#version 300 es
precision highp float;

// ── Uniforms ─────────────────────────────────────────────────────────────────
uniform vec2  iResolution;   // canvas size in pixels
uniform float iTime;         // elapsed seconds
uniform int   iMode;         // 0 = shaded, 1 = step heatmap, 2 = normal map

uniform sampler2D uMagmaLUT; // New uniform passed from Three.js

// New Camera Uniforms passed from Three.js PerspectiveCamera
uniform vec3  uCameraPos;
uniform mat4  uCameraWorldMatrix;
uniform mat4  uCameraProjectionMatrixInverse;

in  vec2 vUv;
in vec3 worldPosition;
out vec4 fragColor;

// ── Constants ─────────────────────────────────────────────────────────────────
#define MAX_STEPS 256
#define MAX_DIST  40.0
#define SURF_EPS  0.000005
#define PI        3.14159265

// ── Math helpers ─────────────────────────────────────────────────────────────
mat2 rot2(float a) { float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }

// ── SDF Primitives ────────────────────────────────────────────────────────────

// Sphere centred at origin, radius r
float sdSphere(vec3 p, float r) {
    return length(p) - r;
}

float sdMandelbulb(vec3 p) {
    vec3 z = p;
    float dr = 1.0;
    float r = 0.0;

    const int ITER = 8;
    const float POWER = 8.0;

    for (int i = 0; i < ITER; i++) {
        r = length(z);
        if (r > 2.0) break;

        // spherical coordinates
        float theta = acos(z.z / r);
        float phi   = atan(z.y, z.x);

        dr = pow(r, POWER - 1.0) * POWER * dr + 1.0;

        float zr = pow(r, POWER);
        theta *= POWER;
        phi   *= POWER;

        z = zr * vec3(
            sin(theta) * cos(phi),
            sin(theta) * sin(phi),
            cos(theta)
        );
        z += p;
    }

    return 0.5 * log(r) * r / dr;
}


// Box centred at origin, half-extents b
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// ── SDF Operations ────────────────────────────────────────────────────────────
float opUnion(float a, float b)        { return min(a, b); }
float opIntersect(float a, float b)    { return max(a, b); }
float opSubtract(float base, float cut){ return max(base, -cut); }
float opSmoothUnion(float a, float b, float k) {
    float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
    return mix(b, a, h) - k*h*(1.0-h);
}

// ── Scene ─────────────────────────────────────────────────────────────────────
// Returns vec2(distance, materialID)
//   materialID 0 = floor, 1 = sphere, 2 = box for now
vec2 map(vec3 p) {
    // --- raw distances ---
    float dFloor  = p.y + 1.5;

    vec3 sp = p - vec3(sin(iTime * 0.6) * 0.8, 0.0, 0.0);
    float dSphere = sdSphere(sp, 0.55);

    vec3 bp = p - vec3(cos(iTime * 0.6) * 0.8, 0.0, 0.0);
    bp.xz *= rot2(iTime * 0.4);
    bp.xy *= rot2(iTime * 0.2);
    float dBox = sdBox(bp, vec3(0.38));

    vec3 mp = p - vec3(0.0, 0.0, cos(iTime * 0.5) * 0.8);
    // float dMandelbulb = sdMandelbulb(mp);

    // --- distance field (can be smooth) ---
    float d = dSphere;
    d = opSmoothUnion(d, dBox, 0.3);
    // d = opSmoothUnion(d, dMandelbulb, 0.3);
    d = min(d, dFloor);

    // --- material selection (NO smoothing) ---
    float mat = 0.0;
    float dMin = dFloor;

    if (dSphere < dMin) { dMin = dSphere; mat = 1.0; }
    if (dBox    < dMin) { dMin = dBox;    mat = 2.0;    }

    return vec2(d, mat);
}

// ── Raymarcher ────────────────────────────────────────────────────────────────
// Returns vec2(tHit, stepCount)
vec2 march(vec3 ro, vec3 rd) {
    float t = 0.001;
    float steps = 0.0;

    for (int i = 0; i < MAX_STEPS; i++) {
        float d = map(ro + rd * t).x;
        if (d < max(SURF_EPS * t, 0.0005)) break;
        if (t > MAX_DIST) break;
        t += d;
        steps += 1.0;
    }
    return vec2(t, steps);
}

// ── Lighting helpers ─────────────────────────────────────────────────────────
vec3 calcNormal(vec3 p) {
    // Tetrahedron normal -> 4 samples instead of 6
    const vec2 e = vec2(0.001, -0.001);
    return normalize(
        e.xyy * map(p + e.xyy).x +
        e.yyx * map(p + e.yyx).x +
        e.yxy * map(p + e.yxy).x +
        e.xxx * map(p + e.xxx).x
    );
}

float calcAO(vec3 p, vec3 n) {
    float occ = 0.0, sca = 1.0;
    for (int i = 0; i < 5; i++) {
        float h = 0.01 + 0.12 * float(i) / 4.0;
        occ += (h - map(p + h * n).x) * sca;
        sca *= 0.95;
    }
    return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
}

float calcShadow(vec3 ro, vec3 rd, float tmax) {
    float res = 1.0, t = 0.02;
    for (int i = 0; i < 12; i++) {
        float h = map(ro + rd * t).x;
        res = min(res, clamp(8.0 * h / t, 0.0, 1.0));
        t += clamp(h, 0.01, 0.2);
        if (res < 0.005 || t > tmax) break;
    }
    return res * res * (3.0 - 2.0 * res);
}

// Cosine colour palette  (iq's classic)
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.28318 * (c * t + d));
}

// ── Shading ───────────────────────────────────────────────────────────────────
vec3 shade(vec3 ro, vec3 rd, vec2 hit, float mat) {
    vec3 pos = ro + hit.x * rd;
    vec3 nor = calcNormal(pos);
    vec3 lig = normalize(vec3(0.6, 0.8, -0.5));

    float ao  = calcAO(pos, nor);
    float dif = max(dot(nor, lig), 0.0) * calcShadow(pos, lig, 3.0);
    float spe = pow(max(dot(reflect(rd, nor), lig), 0.0), 48.0);
    float fre = pow(1.0 - max(dot(-rd, nor), 0.0), 3.0);

    vec3 col;

    if (mat < 0.5) {
        // Floor -> subtle grid
        vec2 gp = pos.xz;
        vec2 grid = abs(fract(gp - 0.5) - 0.5) / fwidth(gp);
        float line = min(grid.x, grid.y);
        col = mix(vec3(0.08, 0.09, 0.12), vec3(0.14, 0.15, 0.20), 1.0 - min(line, 1.0));
        col *= 0.6 + 0.4 * ao;
        col += col * dif * vec3(1.1, 1.0, 0.8);
    } else if (mat < 1.5) {
        // Sphere -> cool cyan/blue palette
        col = palette(length(pos) * 0.5 + iTime * 0.1,
            vec3(0.4, 0.5, 0.6), vec3(0.3, 0.3, 0.3),
            vec3(1.0), vec3(0.00, 0.15, 0.30));
        vec3 lin = col * (0.5 * ao + 1.2 * dif * vec3(1.1,1.0,0.9));
        lin += spe * dif * 0.8;
        lin += fre * col * 0.5;
        col = lin;
    } else {
        // Box -> warm amber/gold palette
        col = palette(length(pos) * 0.4 + iTime * 0.15,
            vec3(0.6, 0.5, 0.4), vec3(0.3, 0.25, 0.2),
            vec3(1.0), vec3(0.10, 0.25, 0.40));
        vec3 lin = col * (0.5 * ao + 1.2 * dif * vec3(1.2,1.1,0.8));
        lin += spe * dif * 1.0;
        lin += fre * col * 0.4;
        col = lin;
    }

    // Atmospheric fog
    col = mix(col, vec3(0.05, 0.05, 0.10), 1.0 - exp(-0.003 * hit.x * hit.x));
    return clamp(col, 0.0, 1.0);
}

vec3 magma(float t) {
    // Clamp t to prevent wrapping, and sample from the vertical center (0.5)
    return texture(uMagmaLUT, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb;
}

vec3 magmaHighContrast(float t) {
    // Clamp to prevent weird behavior
    t = clamp(t, 0.0, 1.0);
    
    // A power of 0.4 will stretch a tiny value like 0.05 all the way up to 0.3!
    // Tweak this exponent: Lower = more contrast at the bottom end.
    float shapedT = pow(t, 0.4); 
    
    return texture(uMagmaLUT, vec2(shapedT, 0.5)).rgb;
}

// ── Main ──────────────────────────────────────────────────────────────────────
void main() {
    // 1. Convert pixel coordinates to Normalized Device Coordinates (-1.0 to 1.0)
    vec2 ndc = (gl_FragCoord.xy / iResolution.xy) * 2.0 - 1.0;

    // 2. Unproject from clip space to camera space using the inverse projection matrix
    vec4 clipPos = vec4(ndc, -1.0, 1.0); // Z is -1.0 for the near clipping plane
    vec4 viewPos = uCameraProjectionMatrixInverse * clipPos;
    
    // Perspective division to get the direction in camera space
    vec3 dirCameraSpace = normalize(viewPos.xyz / viewPos.w);
    
    // 3. Transform the camera space direction into world space using the world matrix
    vec3 rd = (uCameraWorldMatrix * vec4(dirCameraSpace, 0.0)).xyz;
    vec3 ro = uCameraPos;

    // March
    vec2 hit = march(ro, rd); // (tHit, stepCount)
    float stepCount = hit.y;
    float tHit = hit.x;


    float mat = -1.0;
    if (tHit < MAX_DIST) {
        mat = map(ro + rd * tHit).y; 
    }

    vec3 col;
    if (iMode == 0) {
        // Normal shaded render
        if (tHit >= MAX_DIST) {
            // Miss -> sky gradient
            col = vec3(0.05, 0.05, 0.12) - rd.y * 0.08;
        } else {
            // Hit -> shade based on material
            col = shade(ro, rd, hit, mat);
        }
    } else

    if (iMode == 1) {
        // Step heatmap -> cool diagnostic view
        float s = stepCount / float(MAX_STEPS);

        col = magma(s);
        
        if (tHit >= MAX_DIST || mat == 0.0) col = vec3(0.03); // miss = near black
    }

    if (iMode == 2) {
        if (tHit >= MAX_DIST || mat == 0.0) {
            // miss -> black
            col = vec3(0.03);
        } else {
            vec3 n = calcNormal(ro + tHit * rd);
            col = n * 0.5 + 0.5;
            
        }
    }

    if (iMode == 3) {
        if (tHit >= MAX_DIST || mat == 0.0) {
            // miss -> black
            col = vec3(0.03);
        } else {
            vec3 n = calcNormal(ro + tHit * rd);
            col = 1.0 - vec3(tHit / MAX_DIST); // Depth map (grayscale based on distance)
            
        }
    }

    // Gamma correction
    col = pow(max(col, 0.0), vec3(0.4545));
    fragColor = vec4(col, 1.0);
}