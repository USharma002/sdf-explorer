#version 300 es
precision highp float;

in vec3 position; // Three.js built-in, covers NDC with 2x2 PlaneGeometry
out vec2 vUv;
out vec3 worldPosition;
void main() {
    vUv = position.xy * 0.5 + 0.5;
    worldPosition = position.xyz;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
