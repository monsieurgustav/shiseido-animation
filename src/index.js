import {
    WebGLRenderer,
    Clock,
    Scene,
    PerspectiveCamera,
    Object3D,
    RawShaderMaterial,
    MeshNormalMaterial,
    MeshStandardMaterial,
    HemisphereLight,
    AmbientLight,
    PointLight,
    BufferGeometry,
    Mesh,
    LoadingManager,
    MathUtils,
    WebGLCubeRenderTarget, VectorKeyframeTrack,
    AnimationClip, AnimationMixer, AnimationAction, EquirectangularReflectionMapping,
    sRGBEncoding, TextureLoader, Vector2, Vector3, LoopOnce, InterpolateSmooth
} from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'

function lerp(a, b, n) {
    return (1 - n) * a + n * b;
}

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.renderer = new WebGLRenderer({
            antialias: true,
            alpha: true,
            canvas,
        });
        //this.renderer.setSize( window.innerWidth, window.innerHeight );
        this.renderer.setPixelRatio(2);  // window.devicePixelRatio
        this.renderer.setClearColor(0x000000, 0.5);

        this.scene = new Scene();
        this.camera = new PerspectiveCamera(75, canvas.clientWidth/canvas.clientHeight, 10, 1000);
        this.camera.position.z = 300;
        this.onResize();

        this.clock = new Clock();

        this.parent = new Object3D();
        this.parent.rotation.set(MathUtils.degToRad(90), 0, 0);
        this.scene.add(this.parent);

        const lightCamera = new PointLight( 0xffffff, 0.5, 500, 2 );
        lightCamera.position.x = 100;
        lightCamera.position.y = 100;
        this.scene.add(this.camera);
        this.camera.add(lightCamera);

        this.blend = 0.0;
        this.blendTarget = this.blend;

        this.material = new MeshStandardMaterial();
        const materialScope = this.material;
        this.material.onBeforeCompile = function (shader) {
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
        this._updateMaterial();
        this.material.needsUpdate = true;
        this._loadGeometry();

        const textureLoader = new TextureLoader();
        textureLoader.load('images/envMap.png', (texture) => {
            texture.mapping = EquirectangularReflectionMapping;
            texture.encoding = sRGBEncoding;
            const cubeMapRT = new WebGLCubeRenderTarget(64);
            const envMap = cubeMapRT.fromEquirectangularTexture(this.renderer, texture);

            this.material.envMap = envMap.texture;
            this.material.envMapIntensity = 2.2;

            texture.dispose();
            //cubeMapRT.dispose();
        });

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.minAzimuthAngle = MathUtils.degToRad(-45);
        this.controls.maxAzimuthAngle = MathUtils.degToRad(45);
        this.controls.minPolarAngle = MathUtils.degToRad(90-45);
        this.controls.maxPolarAngle = MathUtils.degToRad(90+45);
        this.controls.enableZoom = false;
        this.controls.enablePan = false;
        this.controls.enableDamping = true;
        this.controls.update();
        this.controls.addEventListener('start', this._onBeginInteration.bind(this));
        this.controls.addEventListener('change', this._render.bind(this));
        this.controls.addEventListener('end', this._onEndInteration.bind(this));
        this._render();



    //    function resetCamera() {
    //        const azimuthal = controls.getAzimuthalAngle();
    //        const polar = controls.getPolarAngle();
    //        controls.rotateLeft
    //    }
        this._onPointerMove = this._onPointerMove.bind(this);
    }

    onResize() {
        //this.canvas.width  = this.canvas.clientWidth;
        //this.canvas.height = this.canvas.clientHeight;
        this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight);
        //this.renderer.setViewport(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
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
        this.blendTarget = blendTarget;
        this.clock.start();
        this._animateLoop();
    }

    _animateClip(clip) {
        this.action = this.mixer.clipAction(clip, this.parent);
        this.action.setLoop(LoopOnce);
        this.action.play();

        this.clock.start();
        this._animateLoop();
    }

    _animateLoop() {
        if (this.blend !== this.blendTarget || this.action.isRunning()) {
            const deltaTime = this.clock.getDelta();
            requestAnimationFrame(this._animateLoop.bind(this));

            if (this.blend !== this.blendTarget)
            {
                const diff = this.blendTarget - this.blend;
                if (Math.abs(diff) > 0.01) {
                    this.blend += diff * deltaTime;
                }
                else {
                    this.blend = this.blendTarget;
                }
                //this.blend = this.blend % 1;
                this._updateMaterial();
                this.parent.rotation.set(MathUtils.degToRad(lerp(90, -20, this.blend)), 0, 0);
            }

            this.mixer.update(deltaTime);
            this.controls.update();
            this._render();
        }
    };

    _render() {
        this.renderer.render(this.scene, this.camera);
    }

    _loadGeometry() {
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

                    const mesh = new Mesh(geometry, this.material);
                    this.parent.add(mesh);
                }

                const track1  = new VectorKeyframeTrack('.position[z]', [0.3, 1, 1.7, 2], [400, 50, 10, 0]);
                const track2  = new VectorKeyframeTrack('.rotation[z]', [0.9, 1.5], [MathUtils.degToRad(180), 0], InterpolateSmooth);
                const tracks = [track1, track2];
                const clip = new AnimationClip('init', 2, tracks);
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

    _updateMaterial() {
        if (this.material.userData.shader) {
            this.material.userData.shader.uniforms.blend.value = this.blend;
        }
        this.material.metalness = 1.0 - this.blend;
        this.material.color.setScalar(lerp(1.0, 1.0, this.blend));
        this.material.roughness = lerp(0.7, 1.0, this.blend);
    }

    _onBeginInteration() {
        this._previousPos = new Vector2(-1, -1);
        this.interationDistance = this._blendToDistance(this.blend);
        this.blendTarget = this.blend;  // stop aimation loop
        this.canvas.ownerDocument.addEventListener('pointermove', this._onPointerMove, false);
    }

    _onEndInteration() {
        this.canvas.ownerDocument.removeEventListener('pointermove', this._onPointerMove, false);
        this._animateBlendTo(this.blend < 0.8 ? 0 : 1);
    }

    _onPointerMove(event) {
        if (this._previousPos.x >= 0) {
            const scale = 1.0 / this.canvas.clientWidth;  // resolution independance
            const deltaX = Math.abs(this._previousPos.x - event.clientX) * scale;
            const deltaY = Math.abs(this._previousPos.y - event.clientY) * scale;

            this.interationDistance += Math.sqrt(deltaX*deltaX + deltaY*deltaY);

            this.blend = this._distanceToBlend(this.interationDistance);
            this._updateMaterial();
            this.parent.rotation.set(MathUtils.degToRad(lerp(90, -20, this.blend)), 0, 0);
        }

        this._previousPos.x = event.clientX;
        this._previousPos.y = event.clientY;
    }

    _distanceToBlend(distance) {
        return MathUtils.clamp((distance - 0.2) * 0.3, 0, 1);
    }

    _blendToDistance(blend) {
        return (blend / 0.3 + 0.2);
    }
}
