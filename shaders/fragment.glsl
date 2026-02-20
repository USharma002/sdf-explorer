#version 300 es
precision highp float;

// ── Uniforms ─────────────────────────────────────────────────────────────────
uniform vec2  iResolution;
uniform float iTime;
uniform int   iMode;   // 0=shaded 1=heatmap 2=normals 3=depth 4=slice 5=AO

uniform sampler2D uColorLUT;  // Active colormap LUT
uniform vec3  uCameraPos;
uniform mat4  uCameraWorldMatrix;
uniform mat4  uCameraProjectionMatrixInverse;

uniform bool  uShowFloor;

// ── PBR uniforms (used by custom material only) ───────────────────────────────
uniform float uRoughness;
uniform float uMetalness;
uniform vec3  uColor1;     // Sphere base color
uniform vec3  uColor2;     // Box base color

// ── Slice ─────────────────────────────────────────────────────────────────────
uniform float uSliceOffset;
uniform float uSliceYaw;    // Degrees -- rotate plane normal in XZ
uniform float uSlicePitch;  // Degrees -- tilt plane normal up/down
uniform float uContourSpacing;
uniform float uContourWidth;
uniform float uSweepSpeed;
uniform float uSliceObjectOpacity;
uniform float uSweepPhase;

in  vec2 vUv;
in  vec3 worldPosition;
out vec4 fragColor;

// ═════════════════════════════════════════════════════════════════════════════
//  MATERIAL SELECTION
//  Change these two defines to swap materials on the sphere and box.
//
//  Available IDs:
//    0  Custom     -- uses uRoughness / uMetalness / uColor1 / uColor2 from the UI
//    1  Gold       -- polished gold metal
//    2  Copper     -- warm copper metal
//    3  Iron       -- dark rough iron
//    4  Rubber     -- matte black rubber
//    5  Glass      -- clear refractive glass
//    6  FrostedGlass -- hazy/frosted glass
// ═════════════════════════════════════════════════════════════════════════════
#define MAT_SPHERE  0   // <- change this
#define MAT_BOX     0   // <- change this

// ─────────────────────────────────────────────────────────────────────────────
// Raymarching constants
#define MAX_STEPS 128
#define MAX_DIST  30.0
#define SURF_EPS  0.000005
#define PI        3.14159265
#define FLOOR_Y  -1.5

// ─────────────────────────────────────────────────────────────────────────────
// Standard 2D rotation matrix
mat2 rot2(float a) { float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }

// ── SDF Primitives ────────────────────────────────────────────────────────────
// Signed distance to a sphere
float sdSphere(vec3 p, float r) { return length(p) - r; }

// Signed distance to a box
float sdBox(vec3 p, vec3 b) {
    vec3 q = abs(p) - b;
    return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0);
}

// Polynomial smooth min for blending SDFs seamlessly
float opSmoothUnion(float a, float b, float k) {
    float h = clamp(0.5+0.5*(b-a)/k,0.0,1.0);
    return mix(b,a,h) - k*h*(1.0-h);
}

// Defines the core geometry: an animated sphere and box blended together
vec2 mapObjects(vec3 p) {
    // Oscillating sphere
    vec3 sp = p - vec3(sin(iTime*0.6)*0.8, 0.0, 0.0);
    float dS = sdSphere(sp, 0.55);

    // Oscillating and rotating box
    vec3 bp = p - vec3(cos(iTime*0.6)*0.8, 0.0, 0.0);
    bp.xz *= rot2(iTime*0.4);
    bp.xy *= rot2(iTime*0.2);
    float dB = sdBox(bp, vec3(0.38));

    // Smoothly combine them
    float d   = opSmoothUnion(dS, dB, 0.3);
    
    // Assign material ID based on which object's center is closer
    float mat = (dS < dB) ? 1.0 : 2.0;
    return vec2(d, mat);
}

// Combines objects with the optional floor plane
vec2 map(vec3 p) {
    vec2 obj = mapObjects(p);
    if (!uShowFloor) return obj;
    
    float dFloor = p.y - FLOOR_Y;
    // Return floor if it's closer than the mapped objects
    if (dFloor < obj.x) return vec2(dFloor, 0.0);
    return obj;
}

// Core raymarching loop
vec2 march(vec3 ro, vec3 rd) {
    float t=0.001, steps=0.0;
    for (int i=0; i<MAX_STEPS; i++) {
        float d = map(ro + rd*t).x;
        // Stop if close enough to surface
        if (d < max(SURF_EPS*t, 0.0005)) break;
        // Stop if ray goes too far
        if (t > MAX_DIST) break;
        t += d; steps += 1.0;
    }
    return vec2(t, steps);
}

// Estimate surface normal using central differences (gradient of the SDF)
vec3 calcNormal(vec3 p) {
    const vec2 e = vec2(0.001,-0.001);
    return normalize(
        e.xyy*map(p+e.xyy).x + e.yyx*map(p+e.yyx).x +
        e.yxy*map(p+e.yxy).x + e.xxx*map(p+e.xxx).x);
}

// Approximate ambient occlusion by sampling the SDF at intervals along the normal
float calcAO(vec3 p, vec3 n) {
    float occ=0.0, sca=1.0;
    for (int i=0; i<6; i++) {
        float h = 0.01 + 0.18*float(i)/5.0;
        occ += (h - map(p + h*n).x)*sca;
        sca *= 0.92;
    }
    return clamp(1.0 - 2.8*occ, 0.0, 1.0);
}

// Calculate soft shadows by tracking the closest ray misses to geometry
float calcShadow(vec3 ro, vec3 rd, float tmax) {
    float res=1.0, t=0.02, ph=1e10;
    for (int i=0; i<20; i++) {
        float h = map(ro+rd*t).x;
        if (h < 0.0001) return 0.0; // Hit something, full shadow
        float y = h*h/(2.0*ph);
        float d = sqrt(max(0.0, h*h-y*y));
        res = min(res, 10.0*d/max(0.0001, t-y));
        ph=h; t+=clamp(h,0.01,0.2);
        if (res<0.005 || t>tmax) break;
    }
    return res*res*(3.0-2.0*res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Material descriptor
struct MatDef {
    vec3  baseColor;
    float roughness;
    float metalness;
    float ior;          // index of refraction (glass only, else 0)
    float transmission; // 0 = opaque, 1 = glass
};

// ── Material library ─────────────────────────────────────────────────────────
// Each function returns a fully-populated MatDef for a surface point.

MatDef matCustom(vec3 pos, float objId) {
    // Driven entirely by the UI sliders and colour pickers with a slight animated pulse
    float tp   = length(pos)*0.5 + iTime*0.1;
    vec3  base = (objId < 1.5)
        ? uColor1 + vec3(0.15)*cos(6.28318*(tp + vec3(0.0,0.1,0.2)))
        : uColor2 + vec3(0.12)*cos(6.28318*(tp + vec3(0.1,0.2,0.3)));
    return MatDef(base, uRoughness, uMetalness, 0.0, 0.0);
}

MatDef matGold(vec3 pos) {
    return MatDef(vec3(1.00, 0.766, 0.336), 0.12, 1.0, 0.0, 0.0);
}

MatDef matCopper(vec3 pos) {
    return MatDef(vec3(0.955, 0.637, 0.538), 0.28, 1.0, 0.0, 0.0);
}

MatDef matIron(vec3 pos) {
    // Slight grunge via world-space noise mapped onto the iron surface
    float n = fract(sin(dot(floor(pos*18.0), vec3(127.1,311.7,74.7)))*43758.5);
    vec3 base = mix(vec3(0.18,0.17,0.16), vec3(0.28,0.26,0.24), n);
    return MatDef(base, 0.78 + n*0.1, 0.85, 0.0, 0.0);
}

MatDef matRubber(vec3 pos) {
    return MatDef(vec3(0.04, 0.04, 0.04), 0.95, 0.0, 0.0, 0.0);
}

MatDef matGlass(vec3 pos) {
    return MatDef(vec3(0.92, 0.96, 1.00), 0.02, 0.0, 1.52, 1.0);
}

MatDef matFrostedGlass(vec3 pos) {
    return MatDef(vec3(0.88, 0.92, 0.96), 0.45, 0.0, 1.48, 1.0);
}

// ── Dispatch by preset ID ─────────────────────────────────────────────────────
// Returns the MatDef for a given preset constant and surface point.
// objId is the matID from mapObjects (1=sphere, 2=box) for the Custom preset.
MatDef getMaterial(int preset, vec3 pos, float objId) {
    if (preset == 1) return matGold(pos);
    if (preset == 2) return matCopper(pos);
    if (preset == 3) return matIron(pos);
    if (preset == 4) return matRubber(pos);
    if (preset == 5) return matGlass(pos);
    if (preset == 6) return matFrostedGlass(pos);
    return matCustom(pos, objId); // 0 = custom
}

// Pick the right preset for each object ID
MatDef getObjectMaterial(float objId, vec3 pos) {
    if (objId < 1.5) return getMaterial(MAT_SPHERE, pos, objId); // sphere
    else             return getMaterial(MAT_BOX,    pos, objId); // box
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment / sky helpers (shared across shaders)
vec3 envSky(vec3 dir) {
    // Simple gradient for the sky zenith
    return mix(vec3(0.08,0.10,0.30), vec3(0.60,0.70,0.95),
               clamp(dir.y*0.5+0.5, 0.0, 1.0));
}

vec3 envHorizon(vec3 dir) {
    // Warmer gradient representing light bouncing from the horizon
    return mix(vec3(0.10,0.15,0.40), vec3(0.85,0.78,0.60),
               clamp(dir.y*0.5+0.5, 0.0, 1.0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Cook-Torrance BRDF for opaque surfaces
vec3 shadePBR(vec3 pos, vec3 nor, vec3 rd, MatDef m) {
    // Lighting vectors
    vec3 lig = normalize(vec3(0.6,0.8,-0.5));
    vec3 ref = reflect(rd, nor);
    vec3 hal = normalize(lig - rd);

    // Scene occlusion and shadowing
    float ao  = calcAO(pos, nor);
    float sha = calcShadow(pos, lig, 4.0);

    // Dot products for BRDF math
    float NdL = max(dot(nor,lig),  0.0);
    float NdH = max(dot(nor,hal),  0.0);
    float NdV = max(dot(nor,-rd),  0.0);

    // Schlick Fresnel (View-dependent reflection)
    float f0  = mix(0.04, 1.0, m.metalness);
    float fre = f0 + (1.0-f0)*pow(1.0-NdV, 5.0);

    // GGX NDF (Microfacet normal distribution)
    float alpha  = max(m.roughness*m.roughness, 0.001);
    float alpha2 = alpha*alpha;
    float denom  = NdH*NdH*(alpha2-1.0)+1.0;
    float D      = alpha2/(PI*denom*denom);

    // Schlick-GGX geometry (Self-shadowing of microfacets)
    float k  = (m.roughness+1.0)*(m.roughness+1.0)/8.0;
    float Gv = NdV/(NdV*(1.0-k)+k);
    float Gl = NdL/(NdL*(1.0-k)+k+0.0001);

    // Specular and diffuse compilation
    float spec   = D*Gv*Gl*fre / max(4.0*NdV*NdL, 0.001);
    vec3  diff   = m.baseColor*(1.0-m.metalness)/PI;
    vec3  specCol= mix(vec3(1.0), m.baseColor, m.metalness);

    // Direct lighting formulation
    vec3 col = (diff + specCol*spec)*NdL*sha*vec3(1.2,1.1,0.95)*2.2;

    // Sky / bounce / back-scatter ambient (Fake Global Illumination)
    float skyD = sqrt(clamp(0.5+0.5*nor.y, 0.0, 1.0))*ao;
    col += m.baseColor*0.55*skyD*vec3(0.35,0.50,1.00); // Top down light
    col += m.baseColor*0.18*clamp(dot(nor, normalize(vec3(0.5,0.0,0.6))),0.0,1.0)*ao; // Backlight bounce

    // Environment reflection
    vec3 envCol = envHorizon(ref);
    col += envCol*specCol*fre*(1.0 - m.roughness*m.roughness)*ao*0.9;

    // Subsurface scatter approximation (Light bleeding through edges)
    col += m.baseColor*0.14*pow(clamp(1.0+dot(nor,rd),0.0,1.0),2.0)*ao;

    // Distance fog to blend into background
    float dist = length(pos-uCameraPos);
    col = mix(col, vec3(0.04,0.04,0.09), 1.0-exp(-0.003*dist*dist));

    return clamp(col, 0.0, 1.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Floor grid  (defined early -- needed by shadeTransmitHit inside glass shader)
vec3 shadeFloor(vec3 pos, vec3 rd, float t) {
    vec3 nor = vec3(0.0,1.0,0.0);
    vec3 lig = normalize(vec3(0.6,0.8,-0.5));
    float ao  = calcAO(pos, nor);
    float sha = calcShadow(pos, lig, 6.0);
    float dif = max(dot(nor,lig),0.0)*sha;

    // Procedural grid generation using derivatives for anti-aliasing
    vec2 gp   = pos.xz;
    vec2 grid = abs(fract(gp-0.5)-0.5)/fwidth(gp);
    float line = min(grid.x,grid.y);

    vec3 col = mix(vec3(0.08,0.09,0.12), vec3(0.14,0.15,0.20), 1.0-min(line,1.0));
    col *= (0.5 + 0.5*ao);
    col += col*dif*vec3(1.1,1.0,0.8);
    col = mix(col, vec3(0.04,0.04,0.09), 1.0-exp(-0.003*t*t));
    return col;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for glass

// Hash: deterministic 3D noise for frosted normal perturbation
float hash3(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
}

// Shade whatever the transmitted ray lands on (no further glass bounce to avoid recursion)
vec3 shadeTransmitHit(vec3 ro, vec3 rd) {
    vec2  hit     = march(ro, rd);
    float tHit    = hit.x;
    bool  missed  = tHit >= MAX_DIST;
    if (missed) return envSky(rd); // Show sky if ray hits nothing
    
    vec3  pos2    = ro + rd * tHit;
    float matId2  = map(pos2).y;
    bool  isFloor2 = matId2 < 0.5;
    vec3  nor2    = calcNormal(pos2);
    
    if (isFloor2) return shadeFloor(pos2, rd, tHit);
    
    // Non-glass hit: shade with PBR directly (avoid another glass bounce)
    MatDef m2 = getObjectMaterial(matId2, pos2);
    if (m2.transmission > 0.5) {
        // Second glass surface -- just do a simple env lookup to cap recursion limits
        vec3 rd2 = refract(rd, nor2, m2.ior); // glass→air (approx)
        if (dot(rd2,rd2) < 0.001) rd2 = rd; // Handle Total Internal Reflection safety
        return envSky(rd2) * m2.baseColor;
    }
    return shadePBR(pos2, nor2, rd, m2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Glass / transmission shading
//
// Two-bounce raymarched refraction:
//   1. Refract into the glass at front face (air→glass)
//   2. March through the interior to find the back face
//   3. Refract out at the back face (glass→air)
//   4. March the exit ray to shade whatever is behind the glass
//
// Frosted glass: adds GGX-distributed normal perturbation before step 1
//   so the exit ray fans out, producing blurred-but-still-refractive transmission
//
// Chromatic aberration: clear glass splits into 3 wavelengths (R/G/B)
//   with slightly different IOR, producing colour fringing at edges
//
// Beer-Lambert absorption: exponential tint over interior path length
vec3 shadeGlass(vec3 pos, vec3 nor, vec3 rd, MatDef m) {
    vec3  lig  = normalize(vec3(0.6,0.8,-0.5));
    float NdV  = max(dot(nor,-rd), 0.0);
    float f0   = pow((m.ior-1.0)/(m.ior+1.0), 2.0);
    float fre  = f0 + (1.0-f0)*pow(1.0-NdV, 5.0); // Surface reflection intensity
    float ao   = calcAO(pos, nor);

    // ── Reflection ─────────────────────────────────────────────────────────
    vec3 reflectDir = reflect(rd, nor);
    vec3 reflectCol = envHorizon(reflectDir)
                    + vec3(0.05) * calcShadow(pos, reflectDir, 6.0);

    // ── Transmission ────────────────────────────────────────────────────────
    // For frosted glass: perturb the surface normal with GGX-distributed noise.
    // This mimics micro-facet scatter without a full computationally heavy BSDF integral.
    vec3 pertNor = nor;
    if (m.roughness > 0.02) {
        float r1 = hash3(pos * 37.1 + rd * 13.7);
        float r2 = hash3(pos * 71.3 + rd * 29.1);
        
        // GGX importance sample tangent-space direction
        float alpha = m.roughness * m.roughness;
        float phi   = 2.0*PI*r1;
        float cosTheta = sqrt((1.0-r2) / (1.0 + (alpha*alpha-1.0)*r2));
        float sinTheta = sqrt(max(0.0, 1.0-cosTheta*cosTheta));
        
        // Build TBN frame around normal
        vec3 up  = abs(nor.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0);
        vec3 tbn_t = normalize(cross(up, nor));
        vec3 tbn_b = cross(nor, tbn_t);
        vec3 microNor = normalize(
            tbn_t * (sinTheta*cos(phi)) +
            tbn_b * (sinTheta*sin(phi)) +
            nor * cosTheta
        );
        // Blend: more roughness = more normal perturbation
        pertNor = normalize(mix(nor, microNor, m.roughness * 0.9));
    }

    // ── Chromatic aberration for clear glass ────────────────────────────────
    // Dispersion: R/G/B have slightly different IOR (Cauchy coefficients approximation)
    float iorR = m.ior + (m.roughness < 0.1 ? +0.012 : 0.0);
    float iorG = m.ior;
    float iorB = m.ior + (m.roughness < 0.1 ? -0.012 : 0.0);

    // Refract entering each wavelength (air -> glass)
    vec3 rdR = refract(rd, pertNor, 1.0/iorR);
    vec3 rdG = refract(rd, pertNor, 1.0/iorG);
    vec3 rdB = refract(rd, pertNor, 1.0/iorB);
    
    // Safety: Total Internal Reflection fallback
    if (dot(rdR,rdR)<0.001) rdR = rd;
    if (dot(rdG,rdG)<0.001) rdG = rd;
    if (dot(rdB,rdB)<0.001) rdB = rd;

    // March inside the glass to find the back face (offset slightly inward to avoid self-intersection)
    // We skip objects of the same matId by stepping past the front surface.
    // Use the Green channel ray to find geometry; Red/Blue only diverge slightly.
    vec3  pIn  = pos + rdG * 0.015; // Step inside the glass volume
    float tExit;
    {
        // March until we leave the glass (SDF goes positive from inside)
        float t = 0.002;
        for (int i = 0; i < 16; i++) {
            float d = -map(pIn + rdG*t).x; // Negative inside = positive distance to exit
            if (d < 0.0005 || t > 4.0) break;
            t += d * 0.5; // Conservative step inside concave SDF
        }
        tExit = t;
    }
    vec3  pExit  = pIn + rdG * tExit;
    vec3  norExit= -calcNormal(pExit); // Flip: outward normal at back face

    // Refract exiting (glass→air) for each channel
    vec3 exitR = refract(rdR, norExit, iorR);   // glass→air: eta = ior/1
    vec3 exitG = refract(rdG, norExit, iorG);
    vec3 exitB = refract(rdB, norExit, iorB);
    
    // TIR on exit: total internal reflection -- mirror direction inside
    if (dot(exitR,exitR)<0.001) exitR = reflect(rdR, norExit);
    if (dot(exitG,exitG)<0.001) exitG = reflect(rdG, norExit);
    if (dot(exitB,exitB)<0.001) exitB = reflect(rdB, norExit);

    // Beer-Lambert absorption over interior path length
    float pathLen = tExit;
    // Tint colour controls absorption per channel (complement = absorbed)
    vec3 absorb = vec3(1.0) - m.baseColor; // How much each channel is absorbed
    vec3 beer   = exp(-absorb * pathLen * 2.5); // Exponential decay

    // March the exit rays into the scene to find what we are looking at through the glass
    vec3 transR = shadeTransmitHit(pExit + exitR*0.01, exitR) * beer;
    vec3 transG = shadeTransmitHit(pExit + exitG*0.01, exitG) * beer;
    vec3 transB = shadeTransmitHit(pExit + exitB*0.01, exitB) * beer;
    vec3 transmitCol = vec3(transR.r, transG.g, transB.b);

    // ── Specular highlight on front face ────────────────────────────────────
    vec3  hal  = normalize(lig - rd);
    float NdH  = max(dot(nor,hal), 0.0);
    float NdL  = max(dot(nor,lig), 0.0);
    float alpha  = max(m.roughness*m.roughness, 0.001);
    float alpha2 = alpha*alpha;
    float denom  = NdH*NdH*(alpha2-1.0)+1.0;
    float D      = alpha2/(PI*denom*denom);
    float k      = (m.roughness+1.0)*(m.roughness+1.0)/8.0;
    float Gv     = NdV/(NdV*(1.0-k)+k);
    float Gl     = NdL/(NdL*(1.0-k)+k+0.0001);
    float spec   = D*Gv*Gl*fre / max(4.0*NdV*NdL, 0.001);
    vec3  specCol= vec3(spec) * calcShadow(pos, lig, 4.0) * vec3(1.2,1.1,0.95) * 1.5;

    // ── Caustic brightening ─────────────────────────────────────────────────
    // Approximate internal caustic: light focused near Brewster's angle
    float caustic = pow(max(dot(-rd, lig), 0.0), 8.0) * (1.0-m.roughness) * 0.4;
    transmitCol *= 1.0 + caustic;

    // ── Combine via Fresnel ──────────────────────────────────────────────────
    // Blend transmission and reflection based on view angle
    vec3 col = mix(transmitCol, reflectCol, fre) + specCol;
    col *= mix(1.0, ao, 0.35); // Apply partial ambient occlusion

    // Distance fog
    float dist = length(pos-uCameraPos);
    col = mix(col, vec3(0.04,0.04,0.09), 1.0-exp(-0.003*dist*dist));

    return clamp(col, 0.0, 1.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level surface shader: dispatches to glass or PBR based on material props
vec3 shadeObject(vec3 pos, vec3 nor, vec3 rd, float objId) {
    MatDef m = getObjectMaterial(objId, pos);
    if (m.transmission > 0.5)
        return shadeGlass(pos, nor, rd, m);
    return shadePBR(pos, nor, rd, m);
}

// ─────────────────────────────────────────────────────────────────────────────
// Map normalized step count to a color palette texture (used in Heatmap)
vec3 applyColormap(float t) {
    return texture(uColorLUT, vec2(pow(clamp(t,0.0,1.0),0.4), 0.5)).rgb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice mode helpers (unchanged from original)

// Retrieve base colors dynamically based on material ID and time
vec3 getBaseColor(float mat, vec3 pos) {
    float tp = length(pos)*0.5 + iTime*0.1;
    vec3 a1 = uColor1; vec3 b1 = vec3(0.15);
    vec3 a2 = uColor2; vec3 b2 = vec3(0.12);
    if (mat < 1.5) return a1 + b1*cos(6.28318*(tp + vec3(0.0,0.1,0.2)));
    else           return a2 + b2*cos(6.28318*(tp + vec3(0.1,0.2,0.3)));
}

// Calculates the color and transparency of the slice plane at a given 3D point
vec4 getSliceColor(vec3 p) {
    // Smoothly fade out the plane the further it gets from the origin
    float distFromCenter = length(p);
    float fadeMask = 1.0 - smoothstep(3.0, 6.0, distFromCenter);
    if (fadeMask <= 0.0) return vec4(0.0);

    float d = map(p).x; // Evaluate SDF geometry

    // Generate contour rings via repeating fractions of the distance
    float spacing    = max(uContourSpacing, 0.01);
    float bandFrac   = fract(d/spacing);
    float distToBand = min(bandFrac, 1.0-bandFrac)*spacing;
    float lineHalfW  = max(uContourWidth, 0.0005);
    float aa         = fwidth(d)*1.5; // Anti-aliasing width based on screen derivatives
    float lineMask   = 1.0 - smoothstep(lineHalfW-aa, lineHalfW+aa, distToBand);

    // Highlight the intersection point exactly on the surface boundary
    float zeroW   = max(uContourWidth*2.5, 0.009);
    float zeroAA  = fwidth(d)*2.0;
    float zeroMask= 1.0 - smoothstep(zeroW-zeroAA, zeroW+zeroAA, abs(d));

    vec3 col; float alpha = fadeMask; // Base transparency
    
    // Color distinction: red inside, blue outside
    if (d <= 0.0) {
        float depth = clamp(-d*1.5, 0.0, 1.0);
        col = mix(vec3(1.00,0.28,0.14), vec3(0.50,0.06,0.04), depth);
        col = mix(col, col*0.38, lineMask*0.80);
        alpha *= 0.85; // Mostly opaque inside
    } else {
        float depth = clamp(d*1.2, 0.0, 1.0);
        col = mix(vec3(0.14,0.42,0.96), vec3(0.06,0.16,0.48), depth);
        col = mix(col, col*0.36, lineMask*0.72);
        alpha *= 0.5; // Translucent outside
    }
    col = mix(col, vec3(0.015), zeroMask*0.96); // Solid surface line
    return vec4(col, alpha);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
void main() {
    // Convert fragment coordinates to Normalized Device Coordinates (NDC)
    vec2 ndc = (gl_FragCoord.xy/iResolution.xy)*2.0-1.0;
    
    // Calculate ray origin and direction from camera matrices
    vec4 vp  = uCameraProjectionMatrixInverse * vec4(ndc,-1.0,1.0);
    vec3 rd  = normalize((uCameraWorldMatrix * vec4(normalize(vp.xyz/vp.w),0.0)).xyz);
    vec3 ro  = uCameraPos;
    vec3 col = vec3(0.0);

    // Perform initial raymarching to hit standard scene geometry
    vec2  hit     = march(ro, rd);
    float tHit    = hit.x, steps = hit.y;
    bool  missed  = tHit >= MAX_DIST;
    float matId   = missed ? -1.0 : map(ro + rd*tHit).y;
    bool  isFloor = !missed && matId < 0.5;

    // ── Slice mode (iMode == 4) ───────────────────────────────────────────────
    if (iMode == 4) {
        vec3 bg = vec3(0.055, 0.055, 0.085);

        // Did we hit an object (ignoring the floor)?
        bool hitObj = (tHit < MAX_DIST) && (map(ro + rd*tHit).y > 0.5);

        // Define plane normal mathematically
        float yaw   = uSliceYaw   * PI/180.0;
        float pitch = uSlicePitch * PI/180.0;
        vec3  pn    = normalize(vec3(cos(pitch)*sin(yaw), sin(pitch), cos(pitch)*cos(yaw)));
        
        // Ray-plane intersection
        float denom = dot(rd, pn);
        float currentOffset = uSliceOffset + sin(uSweepPhase)*1.5; // Animating offset
        float tPlane = (abs(denom) > 0.0001) ? (currentOffset - dot(ro, pn))/denom : -1.0;
        bool  hitPlane = tPlane > 0.0;

        // Render target: Object 
        vec4 objCol = vec4(0.0);
        if (hitObj) {
            vec3 p = ro + rd * tHit;
            vec3 n = calcNormal(p);
            
            // Hologram style calculations
            float fresnel = pow(1.0 - max(dot(n,-rd),0.0), 2.0);
            vec3 holoCol  = getBaseColor(map(p).y, p) + fresnel*0.5;
            float holoAlpha = 0.15 + fresnel*0.4;
            
            // Solid shading using our full lighting rig
            vec3 solidCol = shadeObject(p, n, rd, map(p).y);
            
            // Alpha blend between hologram and solid shading based on UI Opacity Slider
            if (uSliceObjectOpacity < 0.5) {
                objCol = vec4(holoCol, mix(0.0, holoAlpha, uSliceObjectOpacity*2.0));
            } else {
                float t2 = (uSliceObjectOpacity - 0.5)*2.0;
                objCol = vec4(mix(holoCol, solidCol, t2), mix(holoAlpha, 1.0, t2));
            }
        }

        // Render target: Intersecting Plane
        vec4 planeCol = vec4(0.0);
        if (hitPlane) planeCol = getSliceColor(ro + rd * tPlane);

        // Alpha Compositing: Draw back-to-front depending on which distance is closer
        vec3 finalCol = bg;
        if (hitObj && hitPlane) {
            if (tPlane < tHit) {
                // Plane is closer. Draw object first, blend plane on top.
                finalCol = mix(finalCol, objCol.rgb,   objCol.a);
                finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
            } else {
                // Object is closer. Draw plane first, blend object on top.
                finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
                finalCol = mix(finalCol, objCol.rgb,   objCol.a);
            }
        } else if (hitObj)   finalCol = mix(finalCol, objCol.rgb,   objCol.a);
          else if (hitPlane) finalCol = mix(finalCol, planeCol.rgb, planeCol.a);

        // Gamma correction
        fragColor = vec4(pow(max(finalCol,0.0), vec3(0.4545)), 1.0);
        return;
    }

    // ── All other modes ───────────────────────────────────────────────────────
    if (iMode == 0) {
        // PBR shaded -- routes to specific material logic (Glass vs PBR)
        if (missed) {
            col  = vec3(0.05,0.05,0.12) - rd.y*0.08; // Sky gradient
            col += vec3(0.02,0.04,0.08)*pow(max(dot(rd,normalize(vec3(0.6,0.8,-0.5))),0.0),8.0); // Sun glow
        } else {
            vec3 pos = ro + tHit*rd;
            vec3 nor = calcNormal(pos);
            col = isFloor ? shadeFloor(pos,rd,tHit) : shadeObject(pos, nor, rd, matId);
        }
    }
    else if (iMode == 1) {
        // Heatmap: Visualizes the number of marching steps
        if (missed) col = vec3(0.02);
        else        col = applyColormap(steps/float(MAX_STEPS));
    }
    else if (iMode == 2) {
        // Normals: Visualizes local XYZ directions as RGB colors
        if (missed) col = vec3(0.02);
        else        col = calcNormal(ro + tHit*rd)*0.5 + 0.5;
    }
    else if (iMode == 3) {
        // Depth: Grayscale inverse representation of linear distance
        if (missed) col = vec3(0.0);
        else        col = vec3(1.0 - tHit/MAX_DIST);
    }
    else if (iMode == 5) {
        // Ambient Occlusion: Renders geometry purely with self-shadowing/crevice detection
        if (missed) col = vec3(0.02);
        else {
            vec3 pos = ro + tHit*rd;
            float ao = calcAO(pos, calcNormal(pos));
            col = vec3(ao)*vec3(0.55,0.65,1.0) + vec3(0.0,0.0,0.04);
        }
    }

    // Apply linear to sRGB gamma correction (approx 1.0/2.2)
    fragColor = vec4(pow(max(col,0.0), vec3(0.4545)), 1.0);
}