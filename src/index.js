import {
    WebGLRenderer,
    Clock,
    Scene,
    PerspectiveCamera,
    Object3D,
    AmbientLight,
    PointLight,
    MeshStandardMaterial,
    BufferGeometry,
    Mesh,
    LoadingManager,
    MathUtils,
    TextureLoader, WebGLCubeRenderTarget, EquirectangularReflectionMapping,
    VectorKeyframeTrack, AnimationClip, AnimationMixer, InterpolateSmooth,
    sRGBEncoding, LoopOnce,
    Vector2,
} from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'

function lerp(a, b, n) {
    return (1 - n) * a + n * b;
}

export class Renderer {
    constructor(canvas, cameraDistance, onBlendChanged) {
        this.canvas = canvas;
        this.renderer = new WebGLRenderer({
            antialias: true,
            alpha: true,
            canvas,
        });
        this.renderer.setPixelRatio(2);  // window.devicePixelRatio
        this.renderer.setClearColor(0x000000, 0.);

        this.scene = new Scene();
        this.camera = new PerspectiveCamera(75, canvas.clientWidth/canvas.clientHeight, 10, 1000);
        this.camera.position.z = cameraDistance;
        this.onResize();

        this.clock = new Clock();

        this.parent = new Object3D();
        this.parent.rotation.set(MathUtils.degToRad(90), 0, 0);
        this.scene.add(this.parent);

        const lightCamera = new PointLight(0xffffff, 0.5, 500, 2);
        lightCamera.position.x = 100;
        lightCamera.position.y = 100;
        this.scene.add(this.camera);
        this.camera.add(lightCamera);

        const ambientLight = new AmbientLight(0xffffff, 0.8);
        this.scene.add(ambientLight);

        this.blend = 0.0;
        this.blendOrigin = this.blend;
        this.blendTarget = this.blend;
        this.onBlendChanged = onBlendChanged;

        this.bladesMaterial = new MeshStandardMaterial();
        const materialScope = this.bladesMaterial;
        this.bladesMaterial.onBeforeCompile = function (shader) {
            shader.uniforms.blend = { value: 0 };
            shader.vertexShader = 'uniform float blend;\nattribute vec3 position2;\nattribute vec3 normal2;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                'vec3 transformed = vec3(mix(position, position2, blend));\n'
            );
            shader.vertexShader = shader.vertexShader.replace(
                '#include <beginnormal_vertex>',
                'vec3 objectNormal = vec3(mix(normalize(normal), normalize(normal2), blend));\n'
            );
            materialScope.userData.shader = shader;
        };
        this.bladesMaterial.needsUpdate = true;
        this._loadBladesGeometry();
        this._loadBulbGeometry();

        this.bulbPlasticMaterial = new MeshStandardMaterial();
        this.bulbPlasticMaterial.transparent = true;
        this.bulbPlasticMaterial.color.setScalar(0.5);
        this.bulbPlasticMaterial.roughness = 1;

        this.bulbGlassMaterial = new MeshStandardMaterial();
        this.bulbGlassMaterial.transparent = true;
        this.bulbGlassMaterial.roughness = 0;

        this._updateMaterials();

        const textureLoader = new TextureLoader();
        textureLoader.load('images/envMap.png', (texture) => {
            texture.mapping = EquirectangularReflectionMapping;
            texture.encoding = sRGBEncoding;
            const cubeMapRT = new WebGLCubeRenderTarget(64);
            const envMap = cubeMapRT.fromEquirectangularTexture(this.renderer, texture);

            this.bladesMaterial.envMap = envMap.texture;
            this.bladesMaterial.envMapIntensity = 2.2;

            this.bulbGlassMaterial.envMap = envMap.texture;
            this.bulbGlassMaterial.envMapIntensity = 2.2;

            texture.dispose();
        });

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.minAzimuthAngle = MathUtils.degToRad(-55);
        this.controls.maxAzimuthAngle = MathUtils.degToRad(55);
        this.controls.minPolarAngle = MathUtils.degToRad(90-55);
        this.controls.maxPolarAngle = MathUtils.degToRad(90+55);
        this.controls.enableZoom = false;
        this.controls.enablePan = false;
        this.controls.enableDamping = true;
        this.controls.update();
        this.controls.addEventListener('start', this._onBeginInteration.bind(this));
        this.controls.addEventListener('change', this._render.bind(this));
        this.controls.addEventListener('end', this._onEndInteration.bind(this));
        this._render();

        this.isInteracting = false;
        this._onPointerMove = this._onPointerMove.bind(this);
    }

    onResize() {
        this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
        this.camera.aspect = this.canvas.clientWidth / this.canvas.clientHeight;
        this.camera.updateProjectionMatrix();
    }

    dispose() {
        this.controls.dispose();
        this.controls = null;

        this.renderer.dispose();

        const cleanMaterial = function(material) {
            material.dispose();

            // dispose textures
            for (const key of Object.keys(material)) {
                const value = material[key];
                if (value && typeof value === 'object' && 'minFilter' in value) {
                    value.dispose();
                }
            }
        }
        this.scene.traverse(function (object) {
            if (object.isMesh) {
                object.geometry.deleteAttribute('position');
                object.geometry.deleteAttribute('position2');
                object.geometry.deleteAttribute('normal');
                object.geometry.deleteAttribute('normal2');
                object.geometry.dispose();

                if (object.material.isMaterial) {
                    cleanMaterial(object.material);
                }
                else {
                    for (const material of object.material) {
                        cleanMaterial(material);
                    }
                }
            }
        });

        this._disposed = true;
    }

    _animateBlendTo(blendTarget) {
        this.blendOrigin = this.blend;
        this.blendTarget = blendTarget;
        this.clock.start();
        this._animateLoop();
    }

    _animateClip(clip) {
        this.currentAction = this.mixer.clipAction(clip, this.parent);
        this.currentAction.setLoop(LoopOnce);
        this.currentAction.play();

        this.clock.start();
        this._animateLoop();
    }

    _animateLoop() {
        const deltaTime = this.clock.getDelta();  // call before other clock functions
        const doBlend = (!this.isInteracting && this.blend !== this.blendTarget);
        const doAnim = this.currentAction.isRunning();
        const doControlDamping = (this.clock.elapsedTime < 1);
        if (doBlend || doAnim || doControlDamping) {
            requestAnimationFrame(this._animateLoop.bind(this));

            let changed = false;
            if (doBlend)
            {
                if (this.clock.getElapsedTime() > 1) {
                    this.blend = this.blendTarget;
                }
                else {
                    const diff = this.blendTarget - this.blendOrigin;
                    this.blend += diff * deltaTime;
                }
                this.onBlendChanged(this.blend);

                this._updateMaterials();
                this._updateControls();
                this.parent.rotation.set(MathUtils.degToRad(lerp(90, -20, this.blend)), 0, 0);
                changed = true;
            }

            if (doAnim) {
                this.mixer.update(deltaTime);
                changed = true;
            }

            if (this.controls.update() || changed) {
                this._render();
            }
        }
    };

    _render() {
        this.renderer.render(this.scene, this.camera);
    }

    _loadBladesGeometry() {
        let brooch_children, lamp_children;

        function loadModel() {
            if (brooch_children && lamp_children && brooch_children.length === lamp_children.length) {
                const compareName = (a, b) => a.name.localeCompare(b.name);
                brooch_children.sort(compareName);
                lamp_children.sort(compareName);

                for (let i=0; i<brooch_children.length; ++i) {
                    const brooch = brooch_children[i].geometry;
                    const lamp = lamp_children[i].geometry;

                    const geometry = new BufferGeometry();
                    geometry.setAttribute('position', brooch.attributes['position']);
                    geometry.setAttribute('position2', lamp.attributes['position']);
                    geometry.setAttribute('normal', brooch.attributes['normal']);
                    geometry.setAttribute('normal2', lamp.attributes['normal']);

                    const mesh = new Mesh(geometry, this.bladesMaterial);
                    this.parent.add(mesh);
                }

                const track1  = new VectorKeyframeTrack('.position[z]', [0.3, 1, 1.7, 2], [400, 50, 10, 0]);
                const track2  = new VectorKeyframeTrack('.rotation[z]', [0.9, 1.3], [MathUtils.degToRad(-180), 0], InterpolateSmooth);
                const tracks = [track1, track2];
                const clip = new AnimationClip(undefined, 2, tracks);
                this.mixer = new AnimationMixer(this.parent);

                this._animateClip(clip);
                this._render();
            }
        }
        const manager = new LoadingManager(loadModel.bind(this));
        const loader = new OBJLoader(manager);
        loader.load('models/brooch.obj', function (obj) {
            brooch_children = obj.children;
        });
        loader.load('models/lamp.obj', function (obj) {
            lamp_children = obj.children;
        });
    }

    _loadBulbGeometry() {
        const manager = new LoadingManager();
        const loader = new OBJLoader(manager);
        loader.load('models/bulb.obj', (obj) => {
            for (let i=0; i<obj.children.length; ++i) {
                const child = obj.children[i];
                if (child.name.indexOf("glass") !== -1) {
                    child.material = this.bulbGlassMaterial;
                }
                else {
                    child.material = this.bulbPlasticMaterial;
                }
            }
            this.parent.add(obj);
        });
    }

    _updateMaterials() {
        if (this.bladesMaterial.userData.shader) {
            this.bladesMaterial.userData.shader.uniforms.blend.value = this.blend;
        }
        this.bladesMaterial.metalness = 1.0 - this.blend;
        this.bladesMaterial.color.setScalar(lerp(1.0, 1.0, this.blend));
        this.bladesMaterial.roughness = lerp(0.7, 1.0, this.blend);

        const range = 0.5;
        const opacity = Math.sqrt(MathUtils.clamp((this.blend - 1 + range) / range, 0, 1));
        this.bulbPlasticMaterial.opacity = opacity;
        this.bulbGlassMaterial.opacity = opacity;
    }

    _updateControls() {
        const azimuth = lerp(55, 0.1, this.blend);
        this.controls.minAzimuthAngle = MathUtils.degToRad(-azimuth);
        this.controls.maxAzimuthAngle = MathUtils.degToRad(azimuth);

    }

    _onBeginInteration() {
        this._previousPos = new Vector2(-1, -1);
        this.interationDistance = this._blendToDistance(this.blend);
        this.blendTarget = this.blend;  // stop animation loop
        this.isInteracting = true;
        this.canvas.ownerDocument.addEventListener('pointermove', this._onPointerMove, false);
    }

    _onEndInteration() {
        this.canvas.ownerDocument.removeEventListener('pointermove', this._onPointerMove, false);
        this.isInteracting = false;
        this._animateBlendTo(this.blend < 0.8 ? 0 : 1);
    }

    _onPointerMove(event) {
        if (this._previousPos.x >= 0) {
            const scale = 1.0 / Math.min(this.canvas.clientWidth, this.canvas.clientHeight);  // resolution independance
            const deltaX = Math.abs(this._previousPos.x - event.clientX) * scale;
            const deltaY = Math.abs(this._previousPos.y - event.clientY) * scale;

            this.interationDistance += Math.sqrt(deltaX*deltaX + deltaY*deltaY);

            const newBlend = this._distanceToBlend(this.interationDistance);
            if (this.blend !== newBlend) {
                this.blend = newBlend;

                this.onBlendChanged(this.blend);
                this._updateMaterials();
                this._updateControls();
                this.parent.rotation.set(MathUtils.degToRad(lerp(90, -20, this.blend)), 0, 0);

                this._render();
            }
        }

        this._previousPos.x = event.clientX;
        this._previousPos.y = event.clientY;
    }

    _distanceToBlend(distance) {
        const offset = 0.2;
        const scale = 0.5;
        return MathUtils.clamp((distance - offset) * scale, 0, 1);
    }

    _blendToDistance(blend) {
        if (blend === 0) {
            return 0;  // do not add the offset
        }
        const offset = 0.2;
        const scale = 0.5;
        return (blend / scale + offset);
    }
}
