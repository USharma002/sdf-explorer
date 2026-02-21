#version 300 es
precision highp float;

#define MAX_SHAPES 8
#define MAX_MATERIALS 8
#define MAX_STEPS 80
#define MAX_STEPS_INSIDE 24
#define MAX_STEPS_BG 40
#define MAX_DIST 30.0
#define SURF_EPS 0.001
#define PI 3.14159265
#define FLOOR_Y -1.5

// ── General Uniforms ─────────────────────────────────────────────────────────
uniform vec2  iResolution;
uniform float iTime;
uniform int   iMode;

uniform sampler2D uColorLUT;
uniform vec3  uCameraPos;
uniform mat4  uCameraWorldMatrix;
uniform mat4  uCameraProjectionMatrixInverse;
uniform bool  uShowFloor;

// ── Shape Uniforms ───────────────────────────────────────────────────────────
uniform int   uShapeCount;
uniform vec4 uShapeA[MAX_SHAPES]; 
uniform vec4 uShapeB[MAX_SHAPES]; 
uniform vec4 uShapeC[MAX_SHAPES]; 
uniform vec4 uShapeD[MAX_SHAPES]; 

// ── Material Uniforms ────────────────────────────────────────────────────────
uniform int   uMaterialCount;
uniform vec4 uMatA[MAX_MATERIALS]; 
uniform vec4 uMatB[MAX_MATERIALS]; 
uniform vec4 uMatC[MAX_MATERIALS]; 

// ── Slice Uniforms ───────────────────────────────────────────────────────────
uniform float uSliceOffset;
uniform float uSliceYaw;
uniform float uSlicePitch;
uniform vec3  uSliceCenter;
uniform float uSliceRadius;
uniform float uContourSpacing;
uniform float uContourWidth;
uniform float uSweepSpeed;
uniform float uSliceObjectOpacity;
uniform float uSweepPhase;

out vec4 fragColor;

// ── Global Step Counter for Heatmap ──────────────────────────────────────────
float g_steps = 0.0;

// ─────────────────────────────────────────────────────────────────────────────
struct MatDef {
    vec3  baseColor;
    float roughness;
    float metalness;
    float ior;
    float transmission;
};

MatDef getObjectMaterial(float matId, vec3 pos) {
    int idx = clamp(int(matId), 0, MAX_MATERIALS - 1);
    vec4 a = uMatA[idx];
    vec4 b = uMatB[idx];
    vec4 c = uMatC[idx];
    
    MatDef m;
    m.roughness = clamp(a.w, 0.0, 1.0);
    m.metalness = clamp(b.w, 0.0, 1.0);
    m.ior = max(c.x, 1.0);
    m.transmission = clamp(c.y, 0.0, 1.0);
    bool useGradient = (c.z > 0.5);
    
    if (useGradient) {
        float t = clamp(pos.y * 0.4 + 0.5, 0.0, 1.0);
        m.baseColor = mix(a.xyz, b.xyz, t);
    } else {
        m.baseColor = a.xyz;
    }
    return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDF Primitives & Math
float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0);
}

vec3 rotateLocal(vec3 p, vec3 rot) {
    float cx = cos(-rot.x), sx = sin(-rot.x);
    p = vec3(p.x, p.y*cx - p.z*sx, p.y*sx + p.z*cx);
    float cy = cos(-rot.y), sy = sin(-rot.y);
    p = vec3(p.x*cy + p.z*sy, p.y, -p.x*sy + p.z*cy);
    float cz = cos(-rot.z), sz = sin(-rot.z);
    p = vec3(p.x*cz - p.y*sz, p.x*sz + p.y*cz, p.z);
    return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core CSG Evaluation
vec2 mapObjects(vec3 p) {
    if (uShapeCount == 0) return vec2(MAX_DIST, 0.0);

    float resD = MAX_DIST;
    float resMat = 0.0;
    
    for (int i = 0; i < MAX_SHAPES; i++) {
        if (i >= uShapeCount) break;
        
        vec4 a = uShapeA[i]; 
        vec4 b = uShapeB[i]; 
        vec4 c = uShapeC[i]; 
        vec4 d_rot = uShapeD[i]; 
        
        vec3 localP = p - a.xyz;
        localP = rotateLocal(localP, d_rot.xyz);
        
        float dist = 0.0;
        if (int(b.w) == 0) dist = sdSphere(localP, a.w);
        else               dist = sdBox(localP, b.xyz);
        
        float matId = c.x;
        int op = int(c.y);
        
        if (i == 0) {
            resD = dist;
            resMat = matId;
        } else {
            if (op == 0) { // Union
                if (dist < resD) { resD = dist; resMat = matId; }
            } else if (op == 1) { // Intersect
                if (dist > resD) { resD = dist; resMat = matId; }
            } else if (op == 2) { // Subtract
                if (-dist > resD) { resD = -dist; resMat = matId; }
            }
        }
    }
    return vec2(resD, resMat);
}

vec2 map(vec3 p) {
    vec2 obj = mapObjects(p);
    
    if (!uShowFloor) return obj;
    
    // Making the floor a thin slab instead of an infinite half-space. 
    // This fixes the noise artifacts when the camera flies underneath it!
    float dFloor = p.y - FLOOR_Y - 0.001; 
    if (dFloor < obj.x) return vec2(dFloor, -1.0);
    return obj;
}

vec2 march(vec3 ro, vec3 rd) {
    float t=0.01;
    for (int i=0; i<MAX_STEPS; i++) {
        g_steps += 1.0;
        float d = map(ro + rd*t).x;
        if (abs(d) < SURF_EPS) break;
        if (t > MAX_DIST) break;
        t += abs(d);
    }
    return vec2(t, 0.0);
}

vec3 calcNormal(vec3 p) {
    const vec2 e = vec2(0.005,-0.005);
    return normalize(
        e.xyy*map(p+e.xyy).x + e.yyx*map(p+e.yyx).x +
        e.yxy*map(p+e.yxy).x + e.xxx*map(p+e.xxx).x);
}

// ── Lighting Helpers ─────────────────────────────────────────────────────────
float calcShadow(vec3 ro, vec3 rd) {
    float res = 1.0, t = 0.05;
    for (int i=0; i<16; i++) {
        g_steps += 1.0;
        float h = mapObjects(ro + rd*t).x; 
        res = min(res, 8.0 * h / t);
        t += clamp(h, 0.02, 0.2);
        if (h < 0.001 || t > 8.0) break;
    }
    return clamp(res, 0.0, 1.0);
}

// Restored Exact Pasted AO
float calcAO(vec3 p, vec3 n) {
    float occ=0.0, sca=1.0;
    for (int i=0; i<6; i++) {
        g_steps += 1.0;
        float h = 0.01 + 0.18*float(i)/5.0;
        occ += (h - map(p + h*n).x)*sca;
        sca *= 0.92;
    }
    return clamp(1.0 - 2.8*occ, 0.0, 1.0);
}

vec3 envMap(vec3 dir, float roughness) {
    vec3 sky = mix(vec3(0.05, 0.08, 0.15), vec3(0.4, 0.6, 0.8), clamp(dir.y * 0.5 + 0.5, 0.0, 1.0));
    vec3 ground = vec3(0.06, 0.07, 0.09);
    vec3 col = mix(ground, sky, smoothstep(-0.1, 0.1, dir.y));
    
    // Key Light
    vec3 lig = normalize(vec3(0.6, 0.8, -0.5));
    float sun = pow(max(dot(dir, lig), 0.0), mix(256.0, 16.0, roughness));
    col += sun * vec3(1.0, 0.9, 0.8) * (1.0 - roughness);
    
    // Studio Rim Light
    vec3 rim = normalize(vec3(-0.5, 0.2, 0.8));
    float sunRim = pow(max(dot(dir, rim), 0.0), mix(128.0, 16.0, roughness));
    col += sunRim * vec3(0.5, 0.7, 1.0) * (1.0 - roughness) * 0.5;

    return col;
}

vec3 shadeFloorFast(vec3 pos) {
    vec2 grid = abs(fract(pos.xz - 0.5) - 0.5) / fwidth(pos.xz);
    float line = min(grid.x, grid.y);
    return mix(vec3(0.08, 0.09, 0.12), vec3(0.14, 0.15, 0.20), 1.0 - min(line, 1.0));
}

// ── Tone Mapping ─────────────────────────────────────────────────────────────
vec3 applyColormap(float t) {
    return texture(uColorLUT, vec2(pow(clamp(t,0.0,1.0),0.4), 0.5)).rgb;
}

vec3 ACESFilmic(vec3 x) {
    x *= 1.24; 
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// ── Shading Pipeline ─────────────────────────────────────────────────────────
vec3 shadePBR(vec3 pos, vec3 nor, vec3 rd, MatDef m, float ao, float sha) {
    vec3 lig = normalize(vec3(0.6, 0.8, -0.5));
    vec3 hal = normalize(lig - rd);
    
    float NdL = max(dot(nor, lig), 0.0);
    float NdV = max(dot(nor, -rd), 0.0);
    float NdH = max(dot(nor, hal), 0.0);

    float f0 = mix(0.04, 1.0, m.metalness);
    vec3 F0 = mix(vec3(f0), m.baseColor, m.metalness);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);

    float alpha = max(m.roughness * m.roughness, 0.001);
    float alpha2 = alpha * alpha;
    float denom = NdH * NdH * (alpha2 - 1.0) + 1.0;
    float D = alpha2 / (PI * denom * denom);

    float k = (m.roughness + 1.0); k = (k * k) / 8.0;
    float G = (NdV / (NdV * (1.0 - k) + k)) * (NdL / (NdL * (1.0 - k) + k));

    vec3 spec = (D * G * F) / max(4.0 * NdV * NdL, 0.001);
    vec3 diff = m.baseColor * (1.0 - m.metalness) / PI;

    vec3 direct = (diff + spec) * NdL * sha * vec3(1.2, 1.15, 1.1) * 2.0;

    vec3 refDir = reflect(rd, nor);
    vec3 indirectSpec = envMap(refDir, m.roughness) * F * ao;
    vec3 indirectDiff = m.baseColor * (1.0 - m.metalness) * envMap(nor, 1.0) * ao * 0.4;

    return direct + indirectSpec + indirectDiff;
}

vec3 shadeGlass(vec3 pos, vec3 nor, vec3 rd, MatDef m, float ao, float sha) {
    float NdV = max(dot(nor, -rd), 0.0);
    float f0 = pow((m.ior - 1.0) / (m.ior + 1.0), 2.0);
    vec3 F0 = mix(vec3(f0), m.baseColor, m.metalness);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0);

    vec3 refDir = reflect(rd, nor);
    vec3 reflectCol = envMap(refDir, m.roughness) * F;

    vec3 pertNor = nor;
    if (m.roughness > 0.02) {
        float r1 = fract(sin(dot(pos + rd, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        float r2 = fract(sin(dot(pos - rd, vec3(93.989, 67.345, 54.256))) * 43758.5453);
        float alpha = m.roughness * m.roughness;
        float phi = 2.0 * PI * r1;
        float cosTheta = sqrt((1.0 - r2) / (1.0 + (alpha*alpha - 1.0) * r2));
        float sinTheta = sqrt(max(0.0, 1.0 - cosTheta*cosTheta));
        vec3 up = abs(nor.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0);
        vec3 tX = normalize(cross(up, nor));
        vec3 tY = cross(nor, tX);
        vec3 microNor = normalize(tX * sinTheta * cos(phi) + tY * sinTheta * sin(phi) + nor * cosTheta);
        pertNor = normalize(mix(nor, microNor, m.roughness));
    }

    vec3 rdIn = refract(rd, pertNor, 1.0 / m.ior);
    if (dot(rdIn, rdIn) < 0.001) rdIn = reflect(rd, pertNor);

    float tIn = 0.01;
    for(int i=0; i<MAX_STEPS_INSIDE; i++) {
        g_steps += 1.0;
        float d = -mapObjects(pos + rdIn * tIn).x;
        if(d < 0.002 || tIn > 5.0) break;
        tIn += d;
    }
    
    vec3 pExit = pos + rdIn * tIn;
    vec3 nExit = -calcNormal(pExit); 

    vec3 rdOut = refract(rdIn, nExit, m.ior);
    if (dot(rdOut, rdOut) < 0.001) rdOut = reflect(rdIn, nExit);

    float tBg = 0.02;
    float matBg = -2.0;
    for(int i=0; i<MAX_STEPS_BG; i++) {
        g_steps += 1.0;
        vec2 res = map(pExit + rdOut * tBg);
        if(res.x < 0.002) { matBg = res.y; break; }
        if(tBg > MAX_DIST) break;
        tBg += res.x;
    }

    vec3 bgCol = envMap(rdOut, m.roughness * 0.5);
    if (tBg < MAX_DIST) {
        vec3 pBg = pExit + rdOut * tBg;
        if (matBg < -0.5) {
            bgCol = shadeFloorFast(pBg) * mix(1.0, 0.4, exp(-0.5 * tBg));
        } else {
            MatDef mBg = getObjectMaterial(matBg, pBg);
            vec3 nBg = calcNormal(pBg);
            vec3 lig = normalize(vec3(0.6, 0.8, -0.5));
            float dif = max(dot(nBg, lig), 0.0);
            vec3 Fbg = mix(vec3(0.04), mBg.baseColor, mBg.metalness);
            vec3 diffBg = mBg.baseColor * (1.0 - mBg.metalness);
            bgCol = (diffBg + Fbg * pow(max(dot(nBg, normalize(lig - rdOut)), 0.0), 32.0)) * dif;
            bgCol += mBg.baseColor * 0.2; 
        }
    }

    vec3 absorb = vec3(1.0) - m.baseColor;
    vec3 beer = exp(-absorb * tIn * 2.5);
    vec3 transmitCol = bgCol * beer;

    vec3 lig = normalize(vec3(0.6, 0.8, -0.5));
    vec3 hal = normalize(lig - rd);
    float NdH = max(dot(nor, hal), 0.0);
    vec3 specCol = pow(NdH, mix(256.0, 16.0, m.roughness)) * F * sha * 2.0;

    return mix(transmitCol, reflectCol, F) * mix(1.0, ao, 0.5) + specCol;
}

// ── Slice Mode GUI ───────────────────────────────────────────────────────────
vec4 getSliceColor(vec3 p) {
    float distFromCenter = length(p - uSliceCenter);
    float fadeMask = 1.0 - smoothstep(uSliceRadius * 0.8, uSliceRadius, distFromCenter);
    if (fadeMask <= 0.0) return vec4(0.0);

    // CHANGED: Use map(p) instead of mapObjects(p) to include the floor contours
    float d = map(p).x; 
    
    float spacing    = max(uContourSpacing, 0.01);
    float bandFrac   = fract(d/spacing);
    float distToBand = min(bandFrac, 1.0-bandFrac)*spacing;
    float lineHalfW  = max(uContourWidth, 0.0005);
    float aa         = fwidth(d)*1.5; 
    float lineMask   = 1.0 - smoothstep(lineHalfW-aa, lineHalfW+aa, distToBand);

    float zeroW   = max(uContourWidth*2.5, 0.009);
    float zeroAA  = fwidth(d)*2.0;
    float zeroMask= 1.0 - smoothstep(zeroW-zeroAA, zeroW+zeroAA, abs(d));

    vec3 col; float alpha = fadeMask; 
    
    if (d <= 0.0) {
        float depth = clamp(-d*1.5, 0.0, 1.0);
        col = mix(vec3(1.00,0.28,0.14), vec3(0.50,0.06,0.04), depth);
        col = mix(col, col*0.38, lineMask*0.80);
        alpha *= 0.85; 
    } else {
        float depth = clamp(d*1.2, 0.0, 1.0);
        col = mix(vec3(0.14,0.42,0.96), vec3(0.06,0.16,0.48), depth);
        col = mix(col, col*0.36, lineMask*0.72);
        alpha *= 0.5; 
    }
    col = mix(col, vec3(0.015), zeroMask*0.96); 
    return vec4(col, alpha);
}

// ── Curvature Estimation ─────────────────────────────────────────────────────
float calcCurvature(vec3 p) {
    const float e = 0.01; // Step size for finite difference
    float d = map(p).x;
    
    // The Laplacian of an SDF yields twice the mean curvature
    float laplacian = 
        map(p + vec3(e, 0, 0)).x + map(p - vec3(e, 0, 0)).x +
        map(p + vec3(0, e, 0)).x + map(p - vec3(0, e, 0)).x +
        map(p + vec3(0, 0, e)).x + map(p - vec3(0, 0, e)).x - 6.0 * d;
        
    return laplacian / (e * e);
}

// ─────────────────────────────────────────────────────────────────────────────
void main() {
    vec2 ndc = (gl_FragCoord.xy/iResolution.xy)*2.0-1.0;
    vec4 vp  = uCameraProjectionMatrixInverse * vec4(ndc,-1.0,1.0);
    vec3 rd  = normalize((uCameraWorldMatrix * vec4(normalize(vp.xyz/vp.w),0.0)).xyz);
    vec3 ro  = uCameraPos;

    g_steps = 0.0;
    vec3 outCol = envMap(rd, 1.0); // Default BG for misses

    vec2  hit     = march(ro, rd);
    float tHit    = hit.x;
    bool  missed  = tHit >= MAX_DIST;
    float matId   = missed ? -2.0 : map(ro + rd*tHit).y;

    if (!missed) {
        vec3 pos = ro + rd * tHit;
        vec3 nor = calcNormal(pos);

        // Run full shading logic first so Heatmap accurately tracks all mathematical steps!
        float ao = calcAO(pos, nor);
        float sha = calcShadow(pos, normalize(vec3(0.6, 0.8, -0.5)));

        vec3 solidCol;
        if (matId < -0.5) {
            vec3 floorBase = shadeFloorFast(pos);
            vec3 lig = normalize(vec3(0.6, 0.8, -0.5));
            float dif = max(dot(nor, lig), 0.0);
            solidCol = floorBase * (dif * sha * 1.5 + 0.2) * ao;
        } else {
            MatDef m = getObjectMaterial(matId, pos);
            if (m.transmission > 0.01) {
                vec3 glass = shadeGlass(pos, nor, rd, m, ao, sha);
                if (m.transmission < 0.99) {
                    vec3 pbr = shadePBR(pos, nor, rd, m, ao, sha);
                    solidCol = mix(pbr, glass, m.transmission);
                } else solidCol = glass;
            } else {
                solidCol = shadePBR(pos, nor, rd, m, ao, sha);
            }
        }
        solidCol = mix(solidCol, vec3(0.05, 0.08, 0.15), 1.0 - exp(-0.002 * tHit * tHit)); // Fog

        if (iMode == 4) {
            // ── SLICE MODE ───────────────────────────────────────────────────────
            vec3 bg = vec3(0.055, 0.055, 0.085);
            
            // CHANGED: Exclude floor from being rendered as a solid/holographic object
            bool hitObj = matId > -0.5; 

            float yaw   = uSliceYaw   * PI/180.0;
            float pitch = uSlicePitch * PI/180.0;
            vec3  pn    = normalize(vec3(cos(pitch)*sin(yaw), sin(pitch), cos(pitch)*cos(yaw)));
            float denom = dot(rd, pn);
            float currentOffset = uSliceOffset + sin(uSweepPhase) * uSliceRadius * 0.5; 
            float tPlane = (abs(denom) > 0.0001) ? (dot(uSliceCenter, pn) + currentOffset - dot(ro, pn)) / denom : -1.0;
            bool  hitPlane = tPlane > 0.0;
            
            vec4 objCol = vec4(0.0);
            if (hitObj) {
                MatDef m = getObjectMaterial(matId, pos);
                float fresnel = pow(1.0 - max(dot(nor, -rd), 0.0), 2.0);
                vec3 holoCol = m.baseColor + fresnel * 0.5;
                float holoAlpha = 0.15 + fresnel * 0.4;
                if (uSliceObjectOpacity < 0.5) {
                    objCol = vec4(holoCol, mix(0.0, holoAlpha, uSliceObjectOpacity * 2.0));
                } else {
                    float t2 = (uSliceObjectOpacity - 0.5) * 2.0;
                    objCol = vec4(mix(holoCol, solidCol, t2), mix(holoAlpha, 1.0, t2));
                }
            }

            vec4 planeCol = vec4(0.0);
            if (hitPlane) planeCol = getSliceColor(ro + rd * tPlane);

            vec3 finalCol = bg;
            
            // CHANGED: Blending tree perfectly mimics the second shader (floor doesn't occlude plane)
            if (hitObj && hitPlane) {
                if (tPlane < tHit) {
                    finalCol = mix(finalCol, objCol.rgb,   objCol.a);
                    finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
                } else {
                    finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
                    finalCol = mix(finalCol, objCol.rgb,   objCol.a);
                }
            } else if (hitObj) {
                finalCol = mix(finalCol, objCol.rgb,   objCol.a);
            } else if (hitPlane) {
                finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
            }
            
            outCol = finalCol;

        } else if (iMode == 5) {
            // ── AO MODE ──────────────────────────────────────────────────────────
            outCol = vec3(ao) * vec3(0.55, 0.65, 1.0) + vec3(0.0, 0.0, 0.04);
        } else if (iMode == 6) {
            // ── CURVATURE MODE ───────────────────────────────────────────────────
            float curv = calcCurvature(pos);
            
            // Multiply by a small factor to scale the visual sensitivity. 
            // Adjust this 0.02 if the colors are too blown out or too subtle.
            float c = clamp(curv * 0.02, -1.0, 1.0); 
            
            vec3 concaveCol = vec3(0.1, 0.4, 0.9); // Deep blue for inner corners
            vec3 flatCol    = vec3(0.2, 0.2, 0.2); // Dark grey for flat planes
            vec3 convexCol  = vec3(1.0, 0.4, 0.1); // Bright orange for sharp outer edges
            
            if (c < 0.0) outCol = mix(flatCol, concaveCol, -c);
            else         outCol = mix(flatCol, convexCol, c);
            
        } else if (iMode == 2) {
            // ── NORMALS MODE ─────────────────────────────────────────────────────
            outCol = nor * 0.5 + 0.5;
        } else {
            // ── SHADED MODE ──────────────────────────────────────────────────────
            outCol = solidCol;
        }
    } else {
        // Handle Background Misses depending on specific Modes
        if (iMode == 4) {
            float yaw   = uSliceYaw   * PI/180.0;
            float pitch = uSlicePitch * PI/180.0;
            vec3  pn    = normalize(vec3(cos(pitch)*sin(yaw), sin(pitch), cos(pitch)*cos(yaw)));
            float denom = dot(rd, pn);
            float currentOffset = uSliceOffset + sin(uSweepPhase) * uSliceRadius * 0.5; 
            float tPlane = (abs(denom) > 0.0001) ? (dot(uSliceCenter, pn) + currentOffset - dot(ro, pn)) / denom : -1.0;
            
            vec3 bg = vec3(0.055, 0.055, 0.085);
            if (tPlane > 0.0) {
                vec4 planeCol = getSliceColor(ro + rd * tPlane);
                outCol = mix(bg, planeCol.rgb, planeCol.a);
            } else {
                outCol = bg;
            }
        } else if (iMode == 5) {
            outCol = vec3(0.02); // Near Black Background for AO
        } else if (iMode == 2) {
            outCol = vec3(0.05); // Dark Background for Normals
        }
    }

    // ── FINAL OVERRIDES & MAPPING ────────────────────────────────────────────
    if (iMode == 1) { 
        // ── HEATMAP MODE ─────────────────────────────────────────────────────
        outCol = applyColormap(g_steps / 160.0);
    }
    else if (iMode == 3) { 
        // ── DEPTH MODE ───────────────────────────────────────────────────────
        outCol = vec3(1.0 - min(tHit, MAX_DIST)/MAX_DIST);
    }
    else if (iMode == 0 || iMode == 4) {
        // ── ACES TONEMAPPING (Only for Shaded / Sliced colors) ───────────────
        outCol = ACESFilmic(outCol);
    }

    fragColor = vec4(pow(max(outCol, 0.0), vec3(0.4545)), 1.0);
}