import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import {
  MToonMaterialLoaderPlugin,
  VRMExpressionPresetName,
  VRMLoaderPlugin,
  VRMUtils,
  type VRMCore,
  type VRMHumanBoneName
} from '@pixiv/three-vrm';
import { mixamoVRMRigMap } from '../lib/vrm/rigMap';
import type { CompanionState } from '../lib/realtime';

interface AvatarStageProps {
  state: CompanionState;
  expression: string;
  modelName?: string;
  analyser?: AnalyserNode | null;
  floating?: boolean;
}

const modelUrls: Record<string, string> = {
  AI_Maid: '/assets/models/AI_Maid.vrm',
  AI_Casual: '/assets/models/AI_Casual.vrm',
  AI_Future: '/assets/models/AI_Future.vrm',
  AI_Military: '/assets/models/AI_Military.vrm',
  AI_Party: '/assets/models/AI_Party.vrm',
  AI_Nude: '/assets/models/AI_Nude.vrm'
};

const animationByState: Record<CompanionState, string> = {
  idle: '/assets/animations/Idle.fbx',
  listening: '/assets/animations/Listening To Music.fbx',
  thinking: '/assets/animations/Sitting Idle.fbx',
  speaking: '/assets/animations/Idle.fbx',
  reacting: '/assets/animations/Angry.fbx'
};

interface LoadedAvatarModel {
  modelName: string;
  vrm: VRMCore;
  mixer: THREE.AnimationMixer;
  actions: Map<CompanionState, THREE.AnimationAction>;
}

export function AvatarStage({ state, expression, modelName = 'AI_Maid', analyser, floating = false }: AvatarStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<AvatarRuntime | null>(null);

  useEffect(() => {
    if (!containerRef.current || runtimeRef.current) {
      return;
    }
    const runtime = new AvatarRuntime(containerRef.current, floating);
    runtimeRef.current = runtime;
    void runtime.start();
    return () => runtime.dispose();
  }, [floating]);

  useEffect(() => {
    runtimeRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    runtimeRef.current?.setExpression(expression);
  }, [expression]);

  useEffect(() => {
    runtimeRef.current?.setModel(modelName);
  }, [modelName]);

  useEffect(() => {
    runtimeRef.current?.setAnalyser(analyser ?? null);
  }, [analyser]);

  return <div className={floating ? 'avatar-stage floating' : 'avatar-stage'} ref={containerRef} />;
}

class AvatarRuntime {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  private readonly clock = new THREE.Clock();
  private readonly gltfLoader = new GLTFLoader();
  private readonly fbxLoader = new FBXLoader();
  private currentVrm: VRMCore | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private animationActions = new Map<CompanionState, THREE.AnimationAction>();
  private currentState: CompanionState = 'idle';
  private currentModelName = '';
  private modelChangeInProgress = false;
  private frame = 0;
  private blinkCountdown = 2;
  private blinkValue = 0;
  private speechEnergy = 0;
  private lipOh = 0;
  private lipAa = 0;
  private lipEe = 0;
  private analyser: AnalyserNode | null = null;
  private readonly bounds = new THREE.Box3();
  private readonly boundsSize = new THREE.Vector3();
  private readonly boundsCenter = new THREE.Vector3();
  private fitInProgress = false;
  private lastFitAt = 0;
  private envelopeWidth = 0;
  private envelopeHeight = 0;
  private modelChangeRotation: { startedAt: number; durationMs: number } | null = null;
  private transitionParticles: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private transitionParticleVelocities: Float32Array | null = null;
  private transitionParticleAge = 0;
  private transitionParticleDuration = 0;

  constructor(private readonly container: HTMLElement, private readonly floating: boolean) {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false
    });
    this.renderer.autoClear = true;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, floating ? 0.001 : 0);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.background = 'transparent';
    this.container.appendChild(this.renderer.domElement);
    this.camera.position.set(0, 1.35, 4.2);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(1, 2, 3);
    this.scene.add(key);
    this.gltfLoader.register((parser) => new VRMLoaderPlugin(parser, {
      mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser)
    }));
    window.addEventListener('resize', this.resize);
  }

  async start() {
    this.resize();
    await this.loadModel('AI_Maid');
    this.clock.start();
    this.animate();
  }

  dispose() {
    window.removeEventListener('resize', this.resize);
    cancelAnimationFrame(this.frame);
    this.stopModelChangeParticles();
    this.renderer.dispose();
    this.currentVrm?.scene.removeFromParent();
  }

  setState(state: CompanionState) {
    if (state === this.currentState) {
      return;
    }
    const previous = this.animationActions.get(this.currentState);
    const next = this.animationActions.get(state);
    previous?.fadeOut(0.25);
    next?.reset().fadeIn(0.25).play();
    this.currentState = state;
  }

  setExpression(_expression: string) {
    this.clearExpressiveFace();
  }

  setAnalyser(analyser: AnalyserNode | null) {
    this.analyser = analyser;
  }

  setModel(modelName: string) {
    const normalized = modelName.replace(/\.vrm$/i, '');
    if (normalized === this.currentModelName || this.modelChangeInProgress || !modelUrls[normalized]) {
      return;
    }
    void this.changeModel(normalized);
  }

  private async changeModel(modelName: string) {
    this.modelChangeInProgress = true;
    try {
      await this.playModelChangeTransition(modelName);
      this.setState(this.currentState);
    } finally {
      this.currentVrm?.scene.rotation.set(0, 0, 0);
      this.modelChangeRotation = null;
      this.stopModelChangeParticles();
      this.modelChangeInProgress = false;
    }
  }

  private async loadModel(modelName: string) {
    this.installModel(await this.prepareModel(modelName));
  }

  private async prepareModel(modelName: string): Promise<LoadedAvatarModel> {
    const url = modelUrls[modelName];
    if (!url) {
      throw new Error(`Unknown avatar model: ${modelName}`);
    }
    const gltf = await this.gltfLoader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRMCore;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(vrm);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
    });
    const nextMixer = new THREE.AnimationMixer(vrm.scene);
    const nextActions = new Map<CompanionState, THREE.AnimationAction>();

    for (const state of Object.keys(animationByState) as CompanionState[]) {
      const clip = await this.loadMixamoAnimation(animationByState[state], vrm);
      const action = nextMixer.clipAction(clip);
      action.enabled = true;
      nextActions.set(state, action);
    }

    const activeState = nextActions.has(this.currentState) ? this.currentState : 'idle';
    nextActions.get(activeState)?.reset().play();
    nextMixer.update(0.016);
    vrm.update(0.016);

    return {
      modelName,
      vrm,
      mixer: nextMixer,
      actions: nextActions
    };
  }

  private installModel(model: LoadedAvatarModel) {
    const previousVrm = this.currentVrm;
    this.mixer?.stopAllAction();
    model.vrm.scene.rotation.y = this.currentModelChangeRotationY();
    this.currentVrm = model.vrm;
    this.currentModelName = model.modelName;
    this.mixer = model.mixer;
    this.animationActions = model.actions;
    this.scene.add(model.vrm.scene);

    if (previousVrm) {
      this.scene.remove(previousVrm.scene);
      VRMUtils.deepDispose(previousVrm.scene);
    }

    this.clearExpressiveFace();
    this.frameCameraToAvatar();
  }

  private async playModelChangeTransition(modelName: string) {
    const nextModel = await this.prepareModel(modelName);
    if (!this.currentVrm) {
      this.installModel(nextModel);
      return;
    }

    const durationMs = 1050;
    this.modelChangeRotation = { startedAt: performance.now(), durationMs };
    this.startModelChangeParticles(durationMs);
    await wait(durationMs * 0.5);
    this.installModel(nextModel);
    await wait(durationMs * 0.5);
  }

  private async loadMixamoAnimation(url: string, vrm: VRMCore) {
    const fbx = await this.fbxLoader.loadAsync(url);
    const sourceClip = fbx.animations[0];
    if (!sourceClip) {
      throw new Error(`No animation clip in ${url}`);
    }
    const tracks: THREE.KeyframeTrack[] = [];
    const restRotationInverse = new THREE.Quaternion();
    const parentRestWorldRotation = new THREE.Quaternion();
    const quat = new THREE.Quaternion();
    const motionHipsHeight = fbx.getObjectByName('mixamorigHips')?.position.y ?? 1;
    const vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 1;
    const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

    for (const track of sourceClip.tracks) {
      const [mixamoRigName, propertyName] = track.name.split('.');
      const vrmBoneName = mixamoRigName ? mixamoVRMRigMap[mixamoRigName] : undefined;
      const vrmNodeName = vrmBoneName
        ? vrm.humanoid?.getNormalizedBoneNode(vrmBoneName as VRMHumanBoneName)?.name
        : undefined;
      const mixamoRigNode = mixamoRigName ? fbx.getObjectByName(mixamoRigName) : null;
      if (!vrmNodeName || !propertyName || !mixamoRigNode) {
        continue;
      }

      mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation);

      if (track instanceof THREE.QuaternionKeyframeTrack) {
        const values = [...track.values];
        for (let index = 0; index < values.length; index += 4) {
          quat.fromArray(values, index);
          quat.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
          quat.toArray(values, index);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, values));
      } else if (track instanceof THREE.VectorKeyframeTrack) {
        tracks.push(new THREE.VectorKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          Array.from(track.values, (value) => value * hipsPositionScale)
        ));
      }
    }
    return new THREE.AnimationClip(`${url}-vrm`, sourceClip.duration, tracks);
  }

  private resize = () => {
    const { clientWidth, clientHeight } = this.container;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
  };

  private animate = () => {
    const delta = this.clock.getDelta();
    this.mixer?.update(delta);
    this.updateModelChangeRotation();
    this.updateModelChangeParticles(delta);
    this.updateBlink(delta);
    this.updateLipSync();
    this.applyExpressionLayer();
    this.currentVrm?.update(delta);
    this.frameCameraToAvatar();
    this.fitFloatingWindowToAvatar();
    this.frame = requestAnimationFrame(this.animate);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
  };

  private updateModelChangeRotation() {
    if (!this.modelChangeRotation || !this.currentVrm) {
      return;
    }
    const progress = clamp((performance.now() - this.modelChangeRotation.startedAt) / this.modelChangeRotation.durationMs, 0, 1);
    this.currentVrm.scene.rotation.y = this.currentModelChangeRotationY(progress);
    if (progress >= 1) {
      this.currentVrm.scene.rotation.y = 0;
      this.modelChangeRotation = null;
    }
  }

  private currentModelChangeRotationY(progress = this.currentModelChangeProgress()) {
    return easeInOutCubic(progress) * Math.PI * 2;
  }

  private currentModelChangeProgress() {
    if (!this.modelChangeRotation) {
      return 0;
    }
    return clamp((performance.now() - this.modelChangeRotation.startedAt) / this.modelChangeRotation.durationMs, 0, 1);
  }

  private startModelChangeParticles(durationMs: number) {
    this.stopModelChangeParticles();
    if (!this.currentVrm) {
      return;
    }

    this.bounds.setFromObject(this.currentVrm.scene);
    this.bounds.getSize(this.boundsSize);
    this.bounds.getCenter(this.boundsCenter);

    const count = 180;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const height = Math.max(this.boundsSize.y, 1.4);
    const radius = Math.max(this.boundsSize.x * 0.62, 0.42);

    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const angle = Math.random() * Math.PI * 2;
      const heightOffset = (Math.random() - 0.5) * height;
      const ringRadius = radius * (0.65 + Math.random() * 0.65);
      const spinDirection = Math.random() > 0.5 ? 1 : -1;

      positions[offset] = this.boundsCenter.x + Math.cos(angle) * ringRadius;
      positions[offset + 1] = this.boundsCenter.y + heightOffset;
      positions[offset + 2] = this.boundsCenter.z + Math.sin(angle) * ringRadius;

      velocities[offset] = Math.cos(angle + spinDirection * Math.PI * 0.5) * (0.45 + Math.random() * 0.55);
      velocities[offset + 1] = 0.2 + Math.random() * 0.8;
      velocities[offset + 2] = Math.sin(angle + spinDirection * Math.PI * 0.5) * (0.45 + Math.random() * 0.55);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x8fe8ff,
      size: 0.035,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const particles = new THREE.Points(geometry, material);
    particles.renderOrder = 20;
    this.scene.add(particles);
    this.transitionParticles = particles;
    this.transitionParticleVelocities = velocities;
    this.transitionParticleAge = 0;
    this.transitionParticleDuration = durationMs / 1000;
  }

  private updateModelChangeParticles(delta: number) {
    if (!this.transitionParticles || !this.transitionParticleVelocities) {
      return;
    }

    this.transitionParticleAge += delta;
    const geometry = this.transitionParticles.geometry;
    const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const velocities = this.transitionParticleVelocities;

    for (let index = 0; index < positions.length; index += 3) {
      positions[index] = (positions[index] ?? 0) + (velocities[index] ?? 0) * delta;
      positions[index + 1] = (positions[index + 1] ?? 0) + (velocities[index + 1] ?? 0) * delta;
      positions[index + 2] = (positions[index + 2] ?? 0) + (velocities[index + 2] ?? 0) * delta;
    }
    positionAttribute.needsUpdate = true;

    const progress = clamp(this.transitionParticleAge / Math.max(this.transitionParticleDuration, 0.001), 0, 1);
    this.transitionParticles.material.opacity = 0.92 * (1 - easeInCubic(progress));

    if (progress >= 1) {
      this.stopModelChangeParticles();
    }
  }

  private stopModelChangeParticles() {
    if (!this.transitionParticles) {
      return;
    }
    this.scene.remove(this.transitionParticles);
    this.transitionParticles.geometry.dispose();
    this.transitionParticles.material.dispose();
    this.transitionParticles = null;
    this.transitionParticleVelocities = null;
    this.transitionParticleAge = 0;
    this.transitionParticleDuration = 0;
  }

  private frameCameraToAvatar() {
    if (!this.currentVrm) {
      return;
    }
    this.bounds.setFromObject(this.currentVrm.scene);
    this.bounds.getSize(this.boundsSize);
    this.bounds.getCenter(this.boundsCenter);
    if (this.boundsSize.y <= 0 || this.boundsSize.x <= 0) {
      return;
    }

    if (this.floating) {
      const fov = THREE.MathUtils.degToRad(this.camera.fov);
      const distanceForHeight = (this.boundsSize.y * 1.03) / (2 * Math.tan(fov / 2));
      const distanceForWidth = (this.boundsSize.x * 1.12) / (2 * Math.tan(fov / 2) * Math.max(this.camera.aspect, 0.1));
      const distance = Math.max(distanceForHeight, distanceForWidth, 2.2);
      const worldHeight = 2 * distance * Math.tan(fov / 2);
      this.camera.position.x = this.boundsCenter.x;
      this.camera.position.y = this.bounds.min.y + worldHeight / 2 - 0.015;
      this.camera.position.z = distance;
      this.camera.lookAt(this.boundsCenter.x, this.bounds.min.y + this.boundsSize.y * 0.56, 0);
      return;
    }

    this.camera.position.set(0, 1.35, 4.2);
    this.camera.lookAt(0, 1.25, 0);
  }

  private fitFloatingWindowToAvatar() {
    if (!this.floating || this.fitInProgress) {
      return;
    }

    const now = performance.now();
    if (now - this.lastFitAt < 180 || this.boundsSize.y <= 0 || this.boundsSize.x <= 0) {
      return;
    }
    this.lastFitAt = now;

    const pixelsPerWorldUnit = 430;
    const targetWidthRaw = clamp(Math.ceil(this.boundsSize.x * pixelsPerWorldUnit + 48), 132, 360);
    const targetHeightRaw = clamp(Math.ceil(this.boundsSize.y * pixelsPerWorldUnit + 18), 420, 720);
    if (targetWidthRaw > this.envelopeWidth) this.envelopeWidth = targetWidthRaw;
    if (targetHeightRaw > this.envelopeHeight) this.envelopeHeight = targetHeightRaw;

    const targetWidth = Math.ceil(this.envelopeWidth);
    const targetHeight = Math.ceil(this.envelopeHeight);
    if (Math.abs(window.innerWidth - targetWidth) < 8 && Math.abs(window.innerHeight - targetHeight) < 8) {
      return;
    }

    this.fitInProgress = true;
    const win = getCurrentWindow();
    void currentMonitor()
      .then(async (monitor) => {
        await win.setSize(new LogicalSize(targetWidth, targetHeight));
        if (monitor) {
          const scale = monitor.scaleFactor || window.devicePixelRatio || 1;
          const x = (monitor.workArea.position.x + monitor.workArea.size.width - targetWidth * scale - 12) / scale;
          const y = (monitor.workArea.position.y + monitor.workArea.size.height - targetHeight * scale) / scale;
          await win.setPosition(new LogicalPosition(Math.max(0, x), y));
        }
      })
      .finally(() => {
        this.fitInProgress = false;
      });
  }

  private updateBlink(delta: number) {
    const manager = this.currentVrm?.expressionManager;
    if (!manager) {
      return;
    }
    this.blinkCountdown -= delta;
    if (this.blinkCountdown <= 0) {
      this.blinkValue = 1;
      window.setTimeout(() => {
        this.blinkValue = 0;
      }, 110);
      this.blinkCountdown = 2.5 + Math.random() * 3;
    }
  }

  private updateLipSync() {
    const manager = this.currentVrm?.expressionManager;
    if (!manager) {
      return;
    }
    if (!this.analyser) {
      this.speechEnergy = 0;
      this.setMouthTargets(0, 0, 0);
      return;
    }

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    const low = average(data, 2, 12) / 255;
    const mid = average(data, 12, 36) / 255;
    const high = average(data, 36, 90) / 255;
    this.speechEnergy = Math.max(low, mid, high);

    const active = this.speechEnergy > 0.025;
    this.setMouthTargets(
      active ? Math.min(0.5, low * 0.9) : 0,
      active ? Math.min(0.48, mid * 0.85) : 0,
      active ? Math.min(0.36, high * 0.65) : 0
    );
  }

  private setMouthTargets(oh: number, aa: number, ee: number) {
    const manager = this.currentVrm?.expressionManager;
    if (!manager) {
      return;
    }
    this.lipOh += (oh - this.lipOh) * 0.32;
    this.lipAa += (aa - this.lipAa) * 0.32;
    this.lipEe += (ee - this.lipEe) * 0.32;
    manager.setValue(VRMExpressionPresetName.Oh, this.lipOh);
    manager.setValue(VRMExpressionPresetName.Aa, this.lipAa);
    manager.setValue(VRMExpressionPresetName.Ee, this.lipEe);
  }

  private applyExpressionLayer() {
    this.clearExpressiveFace();
  }

  private clearExpressiveFace() {
    const manager = this.currentVrm?.expressionManager;
    if (!manager) {
      return;
    }

    const expressions = ['happy', 'angry', 'sad', 'surprised', 'relaxed'];
    for (const expression of expressions) {
      manager.setValue(expression, 0);
    }

    manager.setValue(VRMExpressionPresetName.Blink, this.blinkValue);
  }
}

function average(data: Uint8Array, start: number, end: number) {
  let total = 0;
  let count = 0;
  for (let index = start; index < Math.min(end, data.length); index += 1) {
    total += data[index] ?? 0;
    count += 1;
  }
  return count ? total / count : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function easeInOutCubic(value: number) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function easeInCubic(value: number) {
  return value * value * value;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
