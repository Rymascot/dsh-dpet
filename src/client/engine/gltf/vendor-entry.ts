/**
 * 3D vendor bundle entry — builds the slice of three.js the renderer uses
 * (WebGL renderer, scene graph, GLTFLoader) into lib/gltf-vendor.js, an IIFE
 * exposing 'window.__dshDpetGltf'. The main client bundle never pays for
 * three.js: the renderer lazy-loads this file through the plugin's runtime
 * route the first time a 3D pet mounts.
 *
 * Redistribution: three.js is MIT-licensed and may ship inside this plugin.
 */
export {
  Box3,
  CanvasTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
