#version 300 es
precision highp float;

// ── Uniforms ─────────────────────────────────────────────────────────────────
uniform vec2  iResolution;
uniform float iTime;
uniform int   iMode;   // 0=shaded 1=heatmap 2=normals 3=depth 4=slice 5=AO

uniform sampler2D uColorLUT;  // active colormap LUT (swapped from JS)
uniform vec3  uCameraPos;
uniform mat4  uCameraWorldMatrix;
uniform mat4  uCameraProjectionMatrixInverse;

uniform bool  uShowFloor;

// ── PBR uniforms (overrideable from controls, or hardcode in getBaseColor) ────
uniform float uRoughness;
uniform float uMetalness;
uniform vec3  uColor1;     // sphere base color
uniform vec3  uColor2;     // box base color

// ── Slice ─────────────────────────────────────────────────────────────────────
uniform float uSliceOffset;
uniform float uSliceYaw;    // degrees — rotate plane normal in XZ
uniform float uSlicePitch;  // degrees — tilt plane normal up/down
uniform float uContourSpacing;
uniform float uContourWidth;
uniform float uSweepSpeed; 
uniform float uSliceObjectOpacity; 
uniform float uSweepPhase;

in  vec2 vUv;
in  vec3 worldPosition;
out vec4 fragColor;

// Raymarching constants
#define MAX_STEPS 256
#define MAX_DIST  40.0
#define SURF_EPS  0.000005
#define PI        3.14159265
#define FLOOR_Y  -1.5

// Bbox of animated objects — used by slice to clip the visible region
#define BBOX_X 2.1
#define BBOX_Y 1.1
#define BBOX_Z 1.3

// Checks if a point is within the defined bounding box
bool inBbox(vec3 p) {
    return abs(p.x) < BBOX_X && abs(p.y) < BBOX_Y && abs(p.z) < BBOX_Z;
}

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

// Polynomial smooth min for blending SDFs
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
    
    // Assign material ID based on which object is closer
    float mat = (dS < dB) ? 1.0 : 2.0;
    return vec2(d, mat);
}

// Combines objects with the optional floor plane
vec2 map(vec3 p) {
    vec2 obj = mapObjects(p);
    if (!uShowFloor) return obj;
    
    float dFloor = p.y - FLOOR_Y;
    // Return floor if it's closer than the objects
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

// Estimate surface normal using central differences
vec3 calcNormal(vec3 p) {
    const vec2 e = vec2(0.001,-0.001);
    return normalize(
        e.xyy*map(p+e.xyy).x + e.yyx*map(p+e.yyx).x +
        e.yxy*map(p+e.yxy).x + e.xxx*map(p+e.xxx).x);
}

// Approximate ambient occlusion by sampling the SDF along the normal
float calcAO(vec3 p, vec3 n) {
    float occ=0.0, sca=1.0;
    for (int i=0; i<6; i++) {
        float h = 0.01 + 0.18*float(i)/5.0;
        occ += (h - map(p + h*n).x)*sca;
        sca *= 0.92;
    }
    return clamp(1.0 - 2.8*occ, 0.0, 1.0);
}

// Calculate soft shadows by keeping track of the closest ray misses
float calcShadow(vec3 ro, vec3 rd, float tmax) {
    float res=1.0, t=0.02, ph=1e10;
    for (int i=0; i<20; i++) {
        float h = map(ro+rd*t).x;
        if (h < 0.0001) return 0.0; // Hit something, in shadow
        float y = h*h/(2.0*ph);
        float d = sqrt(max(0.0, h*h-y*y));
        res = min(res, 10.0*d/max(0.0001, t-y));
        ph=h; t+=clamp(h,0.01,0.2);
        if (res<0.005 || t>tmax) break;
    }
    return res*res*(3.0-2.0*res);
}

// ── Color — uColor1/uColor2 are UI defaults; override getBaseColor freely ─────
// Cosine-based color palette generator
vec3 pal(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b*cos(6.28318*(c*t+d));
}

vec3 getBaseColor(float mat, vec3 pos) {
    // uColor1 = sphere, uColor2 = box
    // Animate with a subtle palette shift — remove pal() call to use flat colors
    float tp = length(pos)*0.5 + iTime*0.1;
    vec3 a1 = uColor1; vec3 b1 = vec3(0.15);
    vec3 a2 = uColor2; vec3 b2 = vec3(0.12);
    if (mat < 1.5) return pal(tp, a1, b1, vec3(1.0), vec3(0.0,0.1,0.2));
    else           return pal(tp, a2, b2, vec3(1.0), vec3(0.1,0.2,0.3));
}

// ── PBR ───────────────────────────────────────────────────────────────────────
// Physically Based Rendering: Cook-Torrance BRDF implementation
vec3 shadePBR(vec3 pos, vec3 nor, vec3 rd, float mat) {
    // Lighting vectors
    vec3 lig = normalize(vec3(0.6,0.8,-0.5));
    vec3 ref = reflect(rd, nor);
    vec3 hal = normalize(lig - rd);
    
    // Scene lighting data
    float ao  = calcAO(pos, nor);
    float sha = calcShadow(pos, lig, 4.0);
    
    // Dot products for BRDF
    float NdL = max(dot(nor,lig),0.0);
    float NdH = max(dot(nor,hal),0.0);
    float NdV = max(dot(nor,-rd),0.0);
    
    vec3 baseCol = getBaseColor(mat, pos);
    
    // Fresnel term (Schlick approximation)
    float f0  = mix(0.04, 0.85, uMetalness);
    float fre = f0 + (1.0-f0)*pow(1.0-NdV,5.0);
    
    // Normal Distribution Function (GGX)
    float alpha  = max(uRoughness*uRoughness, 0.001);
    float alpha2 = alpha*alpha;
    float denom  = NdH*NdH*(alpha2-1.0)+1.0;
    float D      = alpha2/(PI*denom*denom);
    
    // Geometry term (Schlick-GGX)
    float k      = (uRoughness+1.0)*(uRoughness+1.0)/8.0;
    float Gv     = NdV/(NdV*(1.0-k)+k);
    float Gl     = NdL/(NdL*(1.0-k)+k+0.0001);
    
    // Specular and diffuse components
    float spec   = D*Gv*Gl*fre/max(4.0*NdV*NdL, 0.001);
    vec3 diffuse = baseCol*(1.0-uMetalness)/PI;
    vec3 specCol = mix(vec3(1.0), baseCol, uMetalness);
    
    // Direct light compilation
    vec3 col = (diffuse + specCol*spec)*NdL*sha*vec3(1.2,1.1,0.95)*2.2;
    
    // Ambient / Fake Global Illumination
    float skyD = sqrt(clamp(0.5+0.5*nor.y,0.0,1.0))*ao;
    col += baseCol*0.55*skyD*vec3(0.35,0.5,1.0); // Sky light bounce
    col += baseCol*0.18*clamp(dot(nor,normalize(vec3(0.5,0.0,0.6))),0.0,1.0)*ao; // Backlight bounce
    
    // Environment reflection
    vec3 envCol = mix(vec3(0.1,0.15,0.4),vec3(0.85,0.78,0.6),clamp(ref.y*0.5+0.5,0.0,1.0));
    col += envCol*specCol*fre*(1.0-uRoughness*uRoughness)*ao*0.9;
    
    // Subsurface scattering approximation
    col += baseCol*0.14*pow(clamp(1.0+dot(nor,rd),0.0,1.0),2.0)*ao;
    
    // Distance fog
    float dist = length(pos-uCameraPos);
    col = mix(col, vec3(0.04,0.04,0.09), 1.0-exp(-0.003*dist*dist));
    
    return clamp(col,0.0,1.0);
}

// Simple shader for the floor grid
vec3 shadeFloor(vec3 pos, vec3 rd, float t) {
    vec3 nor = vec3(0.0,1.0,0.0);
    vec3 lig = normalize(vec3(0.6,0.8,-0.5));
    float ao  = calcAO(pos, nor);
    float sha = calcShadow(pos, lig, 6.0);
    float dif = max(dot(nor,lig),0.0)*sha;
    
    // Procedural grid generation using derivatives
    vec2 gp   = pos.xz;
    vec2 grid = abs(fract(gp-0.5)-0.5)/fwidth(gp);
    float line = min(grid.x,grid.y);
    
    vec3 col = mix(vec3(0.08,0.09,0.12), vec3(0.14,0.15,0.20), 1.0-min(line,1.0));
    col *= (0.5 + 0.5*ao);
    col += col*dif*vec3(1.1,1.0,0.8);
    
    // Distance fog
    col = mix(col, vec3(0.04,0.04,0.09), 1.0-exp(-0.003*t*t));
    return col;
}

// ── LUT colormap sampling ─────────────────────────────────────────────────────
vec3 applyColormap(float t) {
    // Map normalized step count to a color palette texture
    return texture(uColorLUT, vec2(pow(clamp(t,0.0,1.0),0.4), 0.5)).rgb;
}

// ── SLICE & TRANSLUCENCY ──────────────────────────────────────────────────────

// Calculates the color and transparency of the slice plane at a given 3D point
vec4 getSliceColor(vec3 p) {
    // Smoothly fade out the plane the further it gets from the origin (0,0,0)
    float distFromCenter = length(p);
    float fadeMask = 1.0 - smoothstep(3.0, 6.0, distFromCenter);
    if (fadeMask <= 0.0) return vec4(0.0);

    float d = map(p).x; // Evaluates all geometry in the scene

    float spacing    = max(uContourSpacing, 0.01);
    float bandFrac   = fract(d/spacing);
    float distToBand = min(bandFrac, 1.0-bandFrac)*spacing;
    float lineHalfW  = max(uContourWidth, 0.0005);
    float aa         = fwidth(d)*1.5;
    float lineMask   = 1.0 - smoothstep(lineHalfW-aa, lineHalfW+aa, distToBand);
    
    float zeroW      = max(uContourWidth*2.5, 0.009);
    float zeroAA     = fwidth(d)*2.0;
    float zeroMask   = 1.0 - smoothstep(zeroW-zeroAA, zeroW+zeroAA, abs(d));

    vec3 col;
    float alpha = fadeMask; // Base transparency connected to the fade mask
    
    if (d <= 0.0) {
        // Inside the object
        float depth = clamp(-d*1.5, 0.0, 1.0);
        col = mix(vec3(1.00,0.28,0.14), vec3(0.50,0.06,0.04), depth);
        col = mix(col, col*0.38, lineMask*0.80);
        alpha *= 0.85; // Mostly opaque inside
    } else {
        // Outside the object
        float depth = clamp(d*1.2, 0.0, 1.0);
        col = mix(vec3(0.14,0.42,0.96), vec3(0.06,0.16,0.48), depth);
        col = mix(col, col*0.36, lineMask*0.72);
        alpha *= 0.5; // Highly translucent outside so we can see 3D objects behind it
    }
    col = mix(col, vec3(0.015), zeroMask*0.96); // Solid surface line
    
    return vec4(col, alpha);
}

// ── Main ──────────────────────────────────────────────────────────────────────
void main() {
    // Convert fragment coordinates to Normalized Device Coordinates (NDC)
    vec2 ndc = (gl_FragCoord.xy/iResolution.xy)*2.0-1.0;
    
    // Calculate ray origin and direction from camera matrices
    vec4 vp  = uCameraProjectionMatrixInverse * vec4(ndc,-1.0,1.0);
    vec3 rd  = normalize((uCameraWorldMatrix * vec4(normalize(vp.xyz/vp.w),0.0)).xyz);
    vec3 ro  = uCameraPos;
    vec3 col = vec3(0.0);

    // Perform raymarching for 3D modes
    vec2  hit    = march(ro, rd);
    float tHit   = hit.x, steps = hit.y;
    bool  missed = tHit >= MAX_DIST;
    float mat    = missed ? -1.0 : map(ro + rd*tHit).y;
    bool  isFloor = !missed && mat < 0.5;

    // 4 = Slice view with translucent 3D overlay
    if (iMode == 4) {
        vec3 bg = vec3(0.055, 0.055, 0.085);
        
        // 1. Raymarch to find the 3D object
        vec2 hit = march(ro, rd);
        float tHit = hit.x;
        bool hitObj = (tHit < MAX_DIST) && (map(ro + rd*tHit).y > 0.5); // Ignore floor
        
        // 2. Intersect with the 2D Slice Plane
        float yaw   = uSliceYaw   * PI/180.0;
        float pitch = uSlicePitch * PI/180.0;
        vec3 pn = normalize(vec3(cos(pitch)*sin(yaw), sin(pitch), cos(pitch)*cos(yaw)));
        float denom = dot(rd, pn);
        
        // --- Use the JS-accumulated phase to prevent snapping ---
        float currentOffset = uSliceOffset + sin(uSweepPhase) * 1.5; 
        
        float tPlane = (abs(denom) > 0.0001) ? (currentOffset - dot(ro, pn)) / denom : -1.0;
        bool hitPlane = tPlane > 0.0;
        
        // 3. Set up Colors and Transparency
        vec4 objCol = vec4(0.0);
        if (hitObj) {
            vec3 p = ro + rd * tHit;
            vec3 n = calcNormal(p);
            
            // Hologram style calculations
            float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 2.0);
            vec3 holoCol = getBaseColor(map(p).y, p) + fresnel * 0.5;
            float holoAlpha = 0.15 + fresnel * 0.4;
            
            // Solid PBR style calculations
            vec3 solidCol = shadePBR(p, n, rd, map(p).y);
            
            // --- Map the Opacity Slider smoothly ---
            // 0.0 to 0.5: Fades in the glowing hologram
            // 0.5 to 1.0: Morphs the hologram into the solid, shaded PBR object
            if (uSliceObjectOpacity < 0.5) {
                objCol = vec4(holoCol, mix(0.0, holoAlpha, uSliceObjectOpacity * 2.0));
            } else {
                float t = (uSliceObjectOpacity - 0.5) * 2.0;
                objCol = vec4(mix(holoCol, solidCol, t), mix(holoAlpha, 1.0, t));
            }
        }
        
        vec4 planeCol = vec4(0.0);
        if (hitPlane) {
            planeCol = getSliceColor(ro + rd * tPlane);
        }
        
        // 4. Alpha Blending (Draw back-to-front based on distance)
        vec3 finalCol = bg;
        
        if (hitObj && hitPlane) {
            if (tPlane < tHit) {
                // Plane is closer. Draw object first, blend plane on top.
                finalCol = mix(finalCol, objCol.rgb, objCol.a);
                finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
            } else {
                // Object is closer. Draw plane first, blend object on top.
                finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
                finalCol = mix(finalCol, objCol.rgb, objCol.a);
            }
        } else if (hitObj) {
            finalCol = mix(finalCol, objCol.rgb, objCol.a);
        } else if (hitPlane) {
            finalCol = mix(finalCol, planeCol.rgb, planeCol.a);
        }
        
        fragColor = vec4(pow(max(finalCol,0.0), vec3(0.4545)), 1.0);
        return;
    }


    // Output based on selected visualization mode
    if (iMode == 0) {
        // Shaded (PBR)
        if (missed) {
            // Draw background gradient
            col = vec3(0.05,0.05,0.12) - rd.y*0.08;
            col += vec3(0.02,0.04,0.08)*pow(max(dot(rd,normalize(vec3(0.6,0.8,-0.5))),0.0),8.0);
        } else {
            vec3 pos = ro + tHit*rd;
            vec3 nor = calcNormal(pos);
            col = isFloor ? shadeFloor(pos,rd,tHit) : shadePBR(pos,nor,rd,mat);
        }
    } 
    
    else if (iMode == 1) {
        // Heatmap (Visualizes rendering cost/steps)
        if (missed) col = vec3(0.02);
        else        col = applyColormap(steps/float(MAX_STEPS));
    } 
    
    else if (iMode == 2) {
        // Normals (Visualizes surface directions)
        if (missed) col = vec3(0.02);
        else        col = calcNormal(ro + tHit*rd)*0.5 + 0.5;
    } 
    
    else if (iMode == 3) {
        // Depth (Grayscale representation of distance)
        if (missed) col = vec3(0.0);
        else        col = vec3(1.0 - tHit/MAX_DIST);
    } 
    
    else if (iMode == 5) {
        // Ambient Occlusion (Visualizes crevices and shadowing)
        if (missed) {
            col = vec3(0.02);
        } else {
            vec3 pos = ro + tHit*rd;
            float ao = calcAO(pos, calcNormal(pos));
            col = vec3(ao)*vec3(0.55,0.65,1.0) + vec3(0.0,0.0,0.04);
        }
    }

    // Apply linear to sRGB gamma correction (approx 1.0/2.2)
    fragColor = vec4(pow(max(col,0.0), vec3(0.4545)), 1.0);
}