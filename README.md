# Signed Distance Field Explorer
A real-time Signed Distance Field (SDF) raymarching engine built with WebGL 2.0 (#version 300 es) and Three.js. It features a live-editable shader UI, allowing for rapid experimentation with mathematical geometry, boolean operations, and advanced lighting.

## Render Mode Comparison

| Standard RGB | Surface Normals |
| :---: | :---: |
| <img src="media/rgb.png" width="100%"> | <img src="media/normals.png" width="100%"> |
| *Final shading with light.* | *Gradient vectors.* |

| Depthmap | Step Count Heatmap |
| :---: | :---: |
| <img src="media/depthmap.png" width="100%"> | <img src="media/heatmap.png" width="100%"> |
| *Depth map of surface* | *Number of steps* |

## Observations
- As expected, around the edges of the primitives, more steps are required.
- We can union the primitives smoothly
- The render is sensitive to number of steps and epsilon