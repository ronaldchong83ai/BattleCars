// game.js - Core 3D Scene, UI Controller, and Main Game Loop

// Detect Mobile Browser and screen properties
const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function checkOrientation() {
    const warning = document.getElementById('rotation-warning');
    if (!warning) return;
    if (isMobileDevice) {
        if (window.innerHeight > window.innerWidth) {
            warning.classList.remove('hidden');
        } else {
            warning.classList.add('hidden');
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }
        }
    }
}
window.addEventListener('resize', checkOrientation);
window.addEventListener('orientationchange', checkOrientation);

// Initial trigger if mobile
if (isMobileDevice) {
    document.body.classList.add('is-mobile');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkOrientation);
    } else {
        checkOrientation();
    }
}

// Game Settings
let scene, camera, renderer;
let gameManager = null;
Object.defineProperty(window, 'gameManager', {
    get: () => gameManager,
    set: (val) => { gameManager = val; },
    configurable: true
});
let activeCarMeshes = {};       // Maps playerId -> Three.js group
let activeBulletMeshes = {};    // Maps bulletId -> Three.js mesh
let activePowerupMeshes = [];   // Array of Three.js meshes
let skyboxMesh;                 // Singapore skyline dome
let arenaPlatform;              // 3D Battle platform

// UI Elements
const uiScreens = {
    mainMenu: document.getElementById('main-menu'),
    aiScreen: document.getElementById('ai-screen'),
    hostScreen: document.getElementById('host-screen'),
    hostLobbyScreen: document.getElementById('host-lobby-screen'),
    joinScreen: document.getElementById('join-screen'),
    waitingScreen: document.getElementById('lobby-waiting-screen'),
    instructionsScreen: document.getElementById('instructions-screen'),
    hud: document.getElementById('game-hud'),
    gameOver: document.getElementById('game-over-screen')
};

// Global inputs for the local player
const playerInputs = {
    inputThrottle: 0,
    inputSteer: 0,
    shoot: false,
    aimYaw: 0
};

// Camera orbit state
let cameraOffsetYaw = 0; // Relative yaw angle from behind the car
let isRightMouseDown = false;
let previousMouseX = 0;

// Local Player Metadata
let localPlayerName = "Player";
let localPlayerBrand = "BMW";
var localPlayerTeam = "blue"; // 'blue' or 'red' — only used in team battle mode
var currentGameMode = "ffa"; // 'ffa' (Free For All) or 'team' (Team Battle)

// Brand definitions: styling colors and visual configurations
const CAR_BRANDS = {
    BMW: { color: 0x0055ff, emissive: 0x002288, name: "BMW", badgeColor: 0xffffff },
    Mercedes: { color: 0xcccccc, emissive: 0x444444, name: "Mercedes", badgeColor: 0x00f2fe },
    Audi: { color: 0xff1133, emissive: 0x550000, name: "Audi", badgeColor: 0xff0055 },
    Toyota: { color: 0xff8800, emissive: 0x552200, name: "Toyota", badgeColor: 0xffaa00 },
    Porsche: { color: 0x39ff14, emissive: 0x0a4402, name: "Porsche", badgeColor: 0x39ff14 },
    Ford: { color: 0x000088, emissive: 0x000022, name: "Ford", badgeColor: 0x4facfe },
    Ferrari: { color: 0xd10000, emissive: 0x3a0000, name: "Ferrari", badgeColor: 0xffcc00 },
    Tesla: { color: 0xffffff, emissive: 0x888888, name: "Tesla", badgeColor: 0xff00ff }
};

const BRAND_KEYS = Object.keys(CAR_BRANDS);

function getDifferentRandomBrand(currentBrand) {
    const remainingBrands = BRAND_KEYS.filter(b => b !== currentBrand);
    if (remainingBrands.length === 0) return currentBrand;
    return remainingBrands[Math.floor(Math.random() * remainingBrands.length)];
}

/**
 * Switch active UI overlay screens.
 */
function showScreen(screenKey) {
    for (let key in uiScreens) {
        if (key === screenKey) {
            uiScreens[key].classList.add('active');
        } else {
            uiScreens[key].classList.remove('active');
        }
    }
}

/**
 * Initializes Three.js Scene, Camera, Lights, and Renderer.
 */
function init3D() {
    const container = document.getElementById('canvas-container');
    
    // Scene & Fog (adds cyber aesthetic depth)
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07050d, 0.0035);

    // Camera
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    
    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    // Directional light (Simulates neon moonlight)
    const sunLight = new THREE.DirectionalLight(0xb128ff, 0.85);
    sunLight.position.set(50, 100, 30);
    sunLight.castShadow = true;
    scene.add(sunLight);

    // Create the circular arena
    createArenaGeometry();

    // Create Default Skyline Skybox
    createSkybox('singapore_skyline.png');

    // Window Resize Event
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

}

/**
 * Creates the circular glowing battle arena platform.
 */
function createArenaGeometry() {
    const arenaGroup = new THREE.Group();

    // Main circular platform geometry
    const platformGeo = new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS + 2, 4, 64);
    
    // Cool metallic dark grids material (translucent during battle)
    const platformMat = new THREE.MeshStandardMaterial({
        color: 0x110f1a,
        roughness: 0.4,
        metalness: 0.8,
        transparent: true,
        opacity: 0.6
    });
    
    arenaPlatform = new THREE.Mesh(platformGeo, platformMat);
    arenaPlatform.position.y = -2; // top at y=0
    arenaPlatform.receiveShadow = true;
    arenaGroup.add(arenaPlatform);

    // Glowing edge boundary ring
    const ringGeo = new THREE.RingGeometry(ARENA_RADIUS - 0.5, ARENA_RADIUS + 0.5, 64);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x00f2fe,
        side: THREE.DoubleSide
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.position.y = 0.05; // slightly above floor
    arenaGroup.add(ringMesh);

    // Outer grid guidelines on floor
    const gridHelper = new THREE.GridHelper(ARENA_RADIUS * 2, 28, 0xb128ff, 0x1f1a30);
    gridHelper.position.y = 0.02;
    arenaGroup.add(gridHelper);

    scene.add(arenaGroup);
}

/**
 * Returns a random skybox option.
 */
function getRandomSkybox() {
    const options = [
        { file: 'singapore_skyline.png', name: 'Singapore Arena' },
        { file: 'tokyo_skyline.png', name: 'Tokyo Arena' },
        { file: 'paris_skyline.png', name: 'Paris Arena' },
        { file: 'new_york_skyline.png', name: 'New York Arena' },
        { file: 'london_skyline.png', name: 'London Arena' },
        { file: 'sydney_skyline.png', name: 'Sydney Arena' },
        { file: 'cairo_skyline.png', name: 'Cairo Arena' },
        { file: 'rio_skyline.png', name: 'Rio Arena' }
    ];
    return options[Math.floor(Math.random() * options.length)];
}

/**
 * Loads the chosen panorama image into a spherical dome.
 */
function createSkybox(chosenFile) {
    const skyGeo = new THREE.SphereGeometry(320, 64, 48);
    
    // Load texture
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(chosenFile, (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.repeat.x = -1; // Invert to face inward correctly
        
        const skyMat = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.BackSide,
            fog: false // background unaffected by fog
        });
        
        // Remove old skybox if it exists
        if (skyboxMesh) {
            scene.remove(skyboxMesh);
        }
        
        skyboxMesh = new THREE.Mesh(skyGeo, skyMat);
        scene.add(skyboxMesh);
    }, undefined, (err) => {
        console.warn("Could not load skybox texture: " + chosenFile + ", falling back to gradient.", err);
        // Fallback simple dark cyan dome
        const skyMat = new THREE.MeshBasicMaterial({
            color: 0x0c071a,
            side: THREE.BackSide,
            fog: false
        });
        if (skyboxMesh) {
            scene.remove(skyboxMesh);
        }
        skyboxMesh = new THREE.Mesh(skyGeo, skyMat);
        scene.add(skyboxMesh);
    });
}

/**
 * Generates a canvas texture for a specific brand's logo.
 */
function createBrandLogoTexture(brand) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    
    // Transparent background
    ctx.clearRect(0, 0, 128, 128);
    
    // Draw brand-specific logo
    switch (brand) {
        case 'BMW':
            // Black circle border
            ctx.beginPath();
            ctx.arc(64, 64, 54, 0, Math.PI * 2);
            ctx.fillStyle = '#111111';
            ctx.fill();
            ctx.lineWidth = 5;
            ctx.strokeStyle = '#e0e0e0';
            ctx.stroke();
            
            // White inner background
            ctx.beginPath();
            ctx.arc(64, 64, 34, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            
            // Blue quadrants (top-left, bottom-right)
            ctx.fillStyle = '#0055ff';
            ctx.beginPath();
            ctx.moveTo(64, 64);
            ctx.arc(64, 64, 34, -Math.PI, -Math.PI / 2);
            ctx.fill();
            
            ctx.beginPath();
            ctx.moveTo(64, 64);
            ctx.arc(64, 64, 34, 0, Math.PI / 2);
            ctx.fill();
            
            // Inner circle border
            ctx.beginPath();
            ctx.arc(64, 64, 34, 0, Math.PI * 2);
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 2;
            ctx.stroke();
            break;
            
        case 'Mercedes':
            // Silver outer ring
            ctx.beginPath();
            ctx.arc(64, 64, 48, 0, Math.PI * 2);
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 8;
            ctx.stroke();
            
            // 3-pointed star
            ctx.fillStyle = '#e0e0e0';
            for (let i = 0; i < 3; i++) {
                const angle = -Math.PI / 2 + (i * Math.PI * 2 / 3);
                ctx.beginPath();
                ctx.moveTo(64, 64);
                const tipX = 64 + Math.cos(angle) * 44;
                const tipY = 64 + Math.sin(angle) * 44;
                const leftX = 64 + Math.cos(angle - 0.22) * 8;
                const leftY = 64 + Math.sin(angle - 0.22) * 8;
                const rightX = 64 + Math.cos(angle + 0.22) * 8;
                const rightY = 64 + Math.sin(angle + 0.22) * 8;
                ctx.lineTo(leftX, leftY);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(rightX, rightY);
                ctx.closePath();
                ctx.fill();
            }
            break;
            
        case 'Audi':
            // Four interlocking silver rings
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 6;
            const ringRadius = 18;
            const spacing = 22;
            const startX = 64 - (1.5 * spacing);
            for (let i = 0; i < 4; i++) {
                ctx.beginPath();
                ctx.arc(startX + i * spacing, 64, ringRadius, 0, Math.PI * 2);
                ctx.stroke();
            }
            break;
            
        case 'Toyota':
            // Overlapping ellipses
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 6;
            
            // Outer ellipse
            ctx.beginPath();
            ctx.ellipse(64, 64, 50, 32, 0, 0, Math.PI * 2);
            ctx.stroke();
            
            // Vertical ellipse
            ctx.beginPath();
            ctx.ellipse(64, 54, 16, 22, 0, 0, Math.PI * 2);
            ctx.stroke();
            
            // Horizontal ellipse
            ctx.beginPath();
            ctx.ellipse(64, 46, 32, 14, 0, 0, Math.PI * 2);
            ctx.stroke();
            break;
            
        case 'Porsche':
            // Golden shield
            ctx.beginPath();
            ctx.moveTo(39, 24);
            ctx.lineTo(89, 24);
            ctx.lineTo(84, 74);
            ctx.quadraticCurveTo(64, 104, 64, 104);
            ctx.quadraticCurveTo(44, 74, 44, 74);
            ctx.closePath();
            ctx.fillStyle = '#d4af37';
            ctx.fill();
            ctx.strokeStyle = '#111111';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            // Red/black stripes
            ctx.fillStyle = '#d10000';
            ctx.fillRect(49, 34, 12, 15);
            ctx.fillRect(67, 54, 12, 15);
            ctx.fillStyle = '#111111';
            ctx.fillRect(67, 34, 12, 15);
            ctx.fillRect(49, 54, 12, 15);
            break;
            
        case 'Ford':
            // Blue oval with script
            ctx.beginPath();
            ctx.ellipse(64, 64, 54, 34, 0, 0, Math.PI * 2);
            ctx.fillStyle = '#000088';
            ctx.fill();
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 4;
            ctx.stroke();
            
            ctx.beginPath();
            ctx.ellipse(64, 64, 46, 26, 0, 0, Math.PI * 2);
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            
            ctx.font = 'italic bold 22px "Times New Roman", serif';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Ford', 64, 64);
            break;
            
        case 'Ferrari':
            // Yellow shield with black prancing horse
            ctx.beginPath();
            ctx.moveTo(44, 24);
            ctx.lineTo(84, 24);
            ctx.lineTo(84, 74);
            ctx.quadraticCurveTo(64, 104, 64, 104);
            ctx.quadraticCurveTo(44, 74, 44, 74);
            ctx.closePath();
            ctx.fillStyle = '#ffcc00';
            ctx.fill();
            ctx.strokeStyle = '#111111';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            ctx.fillStyle = '#111111';
            ctx.beginPath();
            ctx.arc(64, 64, 14, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillRect(60, 50, 8, 20);
            
            // Italian flag stripes
            ctx.fillStyle = '#009f3d';
            ctx.fillRect(44, 24, 13, 6);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(57, 24, 14, 6);
            ctx.fillStyle = '#e00000';
            ctx.fillRect(71, 24, 13, 6);
            break;
            
        case 'Tesla':
            // Tesla Red T
            ctx.fillStyle = '#e00000';
            ctx.beginPath();
            ctx.moveTo(34, 34);
            ctx.quadraticCurveTo(64, 40, 94, 34);
            ctx.quadraticCurveTo(64, 48, 34, 34);
            ctx.closePath();
            ctx.fill();
            
            ctx.beginPath();
            ctx.moveTo(39, 44);
            ctx.quadraticCurveTo(64, 48, 89, 44);
            ctx.lineTo(69, 54);
            ctx.lineTo(69, 88);
            ctx.quadraticCurveTo(64, 94, 64, 94);
            ctx.quadraticCurveTo(64, 94, 59, 88);
            ctx.lineTo(59, 54);
            ctx.closePath();
            ctx.fill();
            break;
            
        default:
            ctx.beginPath();
            ctx.arc(64, 64, 45, 0, Math.PI * 2);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 4;
            ctx.stroke();
            break;
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

/**
 * Generates a stylized 3D procedural vehicle model.
 * Each brand has unique features (grilles, emblems, wheel sizes, colors).
 */
function create3DCarMesh(brand, name, team) {
    const carGroup = new THREE.Group();
    const info = CAR_BRANDS[brand] || CAR_BRANDS.BMW;

    // Override colors for Team Battle mode
    let bodyColor = info.color;
    let bodyEmissive = info.emissive;
    if (currentGameMode === 'team' && team) {
        if (team === 'red') {
            bodyColor = 0xff2222;       // Bright Red
            bodyEmissive = 0x550000;    // Dark Red
        } else {
            bodyColor = 0x00f2fe;       // Bright Cyan/Blue
            bodyEmissive = 0x003344;    // Dark Cyan/Blue
        }
    }

    // 1. Car Body Chassis (Sexy aerodynamic shape)
    const bodyShape = new THREE.Shape();
    bodyShape.moveTo(-2.0, 0.2);
    bodyShape.quadraticCurveTo(-2.0, 0.6, -1.8, 0.65);
    bodyShape.lineTo(-1.1, 0.65);
    bodyShape.quadraticCurveTo(0.0, 0.6, 1.2, 0.5);
    bodyShape.quadraticCurveTo(1.7, 0.45, 1.95, 0.3);
    bodyShape.quadraticCurveTo(2.05, 0.15, 1.9, 0.15);
    bodyShape.lineTo(-1.9, 0.15);
    bodyShape.closePath();

    const bodyExtrudeSettings = {
        depth: 1.8,
        bevelEnabled: true,
        bevelSegments: 5,
        steps: 1,
        bevelSize: 0.15,
        bevelThickness: 0.15,
        curveSegments: 24
    };
    
    const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, bodyExtrudeSettings);
    bodyGeo.center();
    
    const bodyMat = new THREE.MeshStandardMaterial({
        color: bodyColor,
        roughness: 0.15,
        metalness: 0.85,
        emissive: bodyEmissive,
        emissiveIntensity: 0.3
    });
    
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.rotation.y = Math.PI / 2;
    bodyMesh.position.y = 0.45;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    carGroup.add(bodyMesh);

    // 2. Cabin Structure (Aerodynamic dome)
    const cabinShape = new THREE.Shape();
    cabinShape.moveTo(-1.0, 0.0);
    cabinShape.quadraticCurveTo(-0.7, 0.65, 0.0, 0.65);
    cabinShape.lineTo(0.4, 0.65);
    cabinShape.quadraticCurveTo(0.9, 0.55, 1.3, 0.0);
    cabinShape.closePath();

    const cabinExtrudeSettings = {
        depth: 1.4,
        bevelEnabled: true,
        bevelSegments: 4,
        steps: 1,
        bevelSize: 0.1,
        bevelThickness: 0.1,
        curveSegments: 16
    };
    const cabinGeo = new THREE.ExtrudeGeometry(cabinShape, cabinExtrudeSettings);
    cabinGeo.center();
    
    const cabinMat = new THREE.MeshStandardMaterial({
        color: 0x0d0d0d,
        roughness: 0.05,
        metalness: 0.95,
        transparent: true,
        opacity: 0.85
    });
    
    const cabinMesh = new THREE.Mesh(cabinGeo, cabinMat);
    cabinMesh.rotation.y = Math.PI / 2;
    cabinMesh.position.set(0, 0.98, 0.15);
    cabinMesh.castShadow = true;
    carGroup.add(cabinMesh);

    // 3. Headlights (glowing specs, positioned at front nose z = -2.01)
    const lightGeo = new THREE.SphereGeometry(0.18, 8, 8);
    const lightMatLeft = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const lightMatRight = new THREE.MeshBasicMaterial({ color: 0xffffff });
    
    const headlightL = new THREE.Mesh(lightGeo, lightMatLeft);
    headlightL.position.set(-0.8, 0.52, -2.01);
    const headlightR = new THREE.Mesh(lightGeo, lightMatRight);
    headlightR.position.set(0.8, 0.52, -2.01);
    carGroup.add(headlightL);
    carGroup.add(headlightR);

    // Adding stylized headlight beams (spotlights) pointing forward (-Z)
    const spotL = new THREE.SpotLight(0xffffff, 2.0, 30, Math.PI / 6, 0.5, 1.0);
    spotL.position.set(-0.8, 0.52, -2.05);
    spotL.target.position.set(-0.8, 0.52, -10.0);
    carGroup.add(spotL);
    carGroup.add(spotL.target);

    // 4. Wheels (front at z = -1.3, rear at z = 1.3)
    const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.45, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 0.8,
        metalness: 0.2
    });

    const wheels = [];
    const wheelOffsets = [
        { x: -1.2, z: -1.3 }, // Front Left
        { x: 1.2, z: -1.3 },  // Front Right
        { x: -1.2, z: 1.3 },  // Rear Left
        { x: 1.2, z: 1.3 }   // Rear Right
    ];

    for (let offset of wheelOffsets) {
        const wheelGroup = new THREE.Group();
        wheelGroup.position.set(offset.x, 0.55, offset.z);
        
        const wMesh = new THREE.Mesh(wheelGeo, wheelMat);
        wMesh.castShadow = true;
        wheelGroup.add(wMesh);

        // Add a glowing rim caps for futuristic look
        const rimGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.48, 8);
        rimGeo.rotateZ(Math.PI / 2);
        let rimColor = info.badgeColor;
        if (currentGameMode === 'team' && team) {
            rimColor = team === 'red' ? 0xff2222 : 0x00f2fe;
        }
        const rimMat = new THREE.MeshStandardMaterial({
            color: rimColor,
            emissive: rimColor,
            emissiveIntensity: 0.6
        });
        const rimMesh = new THREE.Mesh(rimGeo, rimMat);
        wheelGroup.add(rimMesh);

        carGroup.add(wheelGroup);
        wheels.push(wheelGroup);
    }
    carGroup.userData.wheels = wheels;

    // 5. Stylized Spoiler (Added standard spoiler to all cars, no brand-specific decor)
    const spoilerGeo = new THREE.BoxGeometry(2.0, 0.1, 0.6);
    const spoilerSupportGeo = new THREE.BoxGeometry(0.15, 0.4, 0.15);
    const spoilerMat = new THREE.MeshStandardMaterial({ color: bodyColor });
    
    const spoiler = new THREE.Mesh(spoilerGeo, spoilerMat);
    spoiler.position.set(0, 1.25, 1.7);
    spoiler.castShadow = true;
    carGroup.add(spoiler);

    const supportL = new THREE.Mesh(spoilerSupportGeo, spoilerMat);
    supportL.position.set(-0.7, 0.95, 1.7);
    const supportR = new THREE.Mesh(spoilerSupportGeo, spoilerMat);
    supportR.position.set(0.7, 0.95, 1.7);
    carGroup.add(supportL);
    carGroup.add(supportR);

    // Name tag overlay (flat canvas billboard above car)
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 28px Orbitron';
    
    // Choose team name color
    let nameColor = '#ffffff';
    if (currentGameMode === 'team' && team) {
        nameColor = team === 'red' ? '#ff3333' : '#00f2fe';
    }
    ctx.fillStyle = nameColor;
    ctx.textAlign = 'center';
    ctx.fillText(name, 128, 42);

    const textTexture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: textTexture, transparent: true });
    const nameSprite = new THREE.Sprite(spriteMat);
    nameSprite.position.set(0, 2.3, 0);
    nameSprite.scale.set(3.5, 0.875, 1);
    carGroup.add(nameSprite);

    scene.add(carGroup);
    return carGroup;
}

/**
 * Creates a glowing 3D bullet mesh.
 */
function createBulletMesh() {
    const geo = new THREE.CylinderGeometry(BULLET_RADIUS, BULLET_RADIUS, 1.6, 8);
    geo.rotateX(Math.PI / 2); // face forward
    const mat = new THREE.MeshStandardMaterial({
        color: 0xdddddd,        // Light silver base
        metalness: 0.95,        // Highly reflective metal
        roughness: 0.05,        // Very glossy
        emissive: 0xffffff,     // Silver/white emissive glow
        emissiveIntensity: 0.6
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    return mesh;
}

/**
 * Generates a glowing, spinning powerup mesh.
 */
function createPowerupMesh(x, z) {
    const powerupGroup = new THREE.Group();
    powerupGroup.position.set(x, 0.8, z);

    // Floating octahedron
    const geo = new THREE.OctahedronGeometry(1.2, 0);
    const mat = new THREE.MeshStandardMaterial({
        color: 0x39ff14,
        emissive: 0x116602,
        roughness: 0.1,
        metalness: 0.9,
        transparent: true,
        opacity: 0.95
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    powerupGroup.add(mesh);

    // Halo ring base
    const ringGeo = new THREE.RingGeometry(1.4, 1.6, 16);
    const ringMat = new THREE.MeshBasicMaterial({
        color: 0x39ff14,
        side: THREE.DoubleSide
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.rotation.x = Math.PI / 2;
    powerupGroup.add(ringMesh);

    // Add a light source pointing upwards
    const light = new THREE.PointLight(0x39ff14, 1.2, 6);
    light.position.y = 0.5;
    powerupGroup.add(light);

    scene.add(powerupGroup);
    return powerupGroup;
}

// -------------------------------------------------------------
// GAME STATE MANAGER CLASS
// -------------------------------------------------------------
class GameManager {
    constructor(isMultiplayer, chosenBots = 0, multiplayerPlayers = null, chosenSkybox = null) {
        this.isMultiplayer = isMultiplayer;
        this.chosenBots = chosenBots;
        this.multiplayerPlayers = multiplayerPlayers;
        this.chosenSkybox = chosenSkybox;
        
        // Physics lists
        this.cars = [];
        this.bullets = [];
        this.powerups = [];
        
        // Powerup spawner clock
        this.powerupTimer = 0;
        this.gameTime = 0;
        
        this.isMatchOver = false;

        // Multiplayer low-latency history buffer
        this.serverStateHistory = [];

        this.initEntities();
    }

    /**
     * Spawns all entities (players, bots, initial powerups).
     */
    initEntities() {
        // Load skybox background
        let skyboxFile = 'singapore_skyline.png';
        let skyboxName = 'Singapore Arena';
        
        if (this.isMultiplayer) {
            skyboxFile = this.chosenSkybox || 'singapore_skyline.png';
            // Find matching name
            const options = [
                { file: 'singapore_skyline.png', name: 'Singapore Arena' },
                { file: 'tokyo_skyline.png', name: 'Tokyo Arena' },
                { file: 'paris_skyline.png', name: 'Paris Arena' },
                { file: 'new_york_skyline.png', name: 'New York Arena' },
                { file: 'london_skyline.png', name: 'London Arena' },
                { file: 'sydney_skyline.png', name: 'Sydney Arena' },
                { file: 'cairo_skyline.png', name: 'Cairo Arena' },
                { file: 'rio_skyline.png', name: 'Rio Arena' }
            ];
            const match = options.find(o => o.file === skyboxFile);
            skyboxName = match ? match.name : 'Battle Arena';
        } else {
            const sb = getRandomSkybox();
            skyboxFile = sb.file;
            skyboxName = sb.name;
        }

        createSkybox(skyboxFile);
        setTimeout(() => {
            addHUDNotification(`Welcome to ${skyboxName}!`);
        }, 1000);

        // Clear old visual meshes
        for (let id in activeCarMeshes) {
            scene.remove(activeCarMeshes[id]);
        }
        activeCarMeshes = {};

        for (let id in activeBulletMeshes) {
            scene.remove(activeBulletMeshes[id]);
        }
        activeBulletMeshes = {};

        for (let pMesh of activePowerupMeshes) {
            scene.remove(pMesh);
        }
        activePowerupMeshes = [];

        // 1. Spawning Cars
        if (!this.isMultiplayer) {
            // Local game with AI
            // Player
            const pState = createCarPhysicsState(clientId, localPlayerName, localPlayerBrand, 0, 20);
            this.cars.push(pState);
            activeCarMeshes[pState.id] = create3DCarMesh(pState.brand, pState.name);

            // AI Bots
            for (let i = 0; i < this.chosenBots; i++) {
                const bBrand = BRAND_KEYS[Math.floor(Math.random() * BRAND_KEYS.length)];
                const bName = "Bot " + (i + 1);
                
                // Spawn randomly on circle circumference
                const angle = (i / this.chosenBots) * Math.PI * 2 + Math.PI / 4;
                const spawnX = Math.cos(angle) * 35;
                const spawnZ = Math.sin(angle) * 35;

                const botState = createCarPhysicsState('bot_' + i, bName, bBrand, spawnX, spawnZ);
                botState.yaw = angle + Math.PI; // point inwards
                this.cars.push(botState);
                activeCarMeshes[botState.id] = create3DCarMesh(botState.brand, botState.name);
            }
        } 
        else {
            // Multiplayer Mode
            if (this.multiplayerPlayers) {
                // Spawn host, guests, and bots exactly as specified in this.multiplayerPlayers (both host and guest do this)
                for (let i = 0; i < this.multiplayerPlayers.length; i++) {
                    const player = this.multiplayerPlayers[i];
                    
                    // Spawn randomly/circularly on circumference
                    const angle = (i / this.multiplayerPlayers.length) * Math.PI * 2;
                    const spawnX = Math.cos(angle) * 30;
                    const spawnZ = Math.sin(angle) * 30;

                    const pState = createCarPhysicsState(player.id, player.name, player.brand, spawnX, spawnZ);
                    pState.yaw = angle + Math.PI;
                    pState.team = player.team;
                    this.cars.push(pState);
                    activeCarMeshes[pState.id] = create3DCarMesh(pState.brand, pState.name, pState.team);
                }
            } else {
                if (isHost) {
                    // Fallback to old behavior
                    // Host player
                    const pState = createCarPhysicsState(clientId, localPlayerName, localPlayerBrand, 0, 25);
                    pState.team = localPlayerTeam;
                    this.cars.push(pState);
                    activeCarMeshes[pState.id] = create3DCarMesh(pState.brand, pState.name, pState.team);

                    // Add connected guests
                    for (let i = 0; i < lobbyPlayers.length; i++) {
                        const guest = lobbyPlayers[i];
                        
                        const angle = ((i + 1) / (lobbyPlayers.length + 1)) * Math.PI * 2;
                        const spawnX = Math.cos(angle) * 30;
                        const spawnZ = Math.sin(angle) * 30;

                        const guestState = createCarPhysicsState(guest.id, guest.name, guest.brand, spawnX, spawnZ);
                        guestState.yaw = angle + Math.PI;
                        guestState.team = guest.team;
                        this.cars.push(guestState);
                        activeCarMeshes[guestState.id] = create3DCarMesh(guestState.brand, guestState.name, guestState.team);
                    }
                } else {
                    // Clients receive layout initialization in client state updates, so we do lazy creation
                }
            }
        }

        // Spawn 3 initial powerups (only on host/local)
        if (!this.isMultiplayer || isHost) {
            for (let i = 0; i < 3; i++) {
                this.spawnRandomPowerup();
            }
        }
    }

    /**
     * Adds a powerup at a random location inside the platform.
     */
    spawnRandomPowerup() {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * (ARENA_RADIUS * 0.7);
        const px = Math.cos(angle) * radius;
        const pz = Math.sin(angle) * radius;

        const pState = {
            id: 'p_' + Math.random().toString(36).substr(2, 9),
            x: px,
            z: pz,
            active: true
        };

        this.powerups.push(pState);

        const mesh = createPowerupMesh(px, pz);
        activePowerupMeshes.push(mesh);
    }

    /**
     * Host captures inputs sent from client tabs.
     */
    handleClientInputs(playerId, inputs) {
        const car = this.cars.find(c => c.id === playerId);
        if (car && car.alive) {
            car.inputThrottle = inputs.inputThrottle;
            car.inputSteer = inputs.inputSteer;
            
            if (inputs.shoot && car.shootCooldown <= 0) {
                const b = shootBullet(car, inputs.aimYaw);
                if (b) {
                    if (inputs.bulletId) b.id = inputs.bulletId;
                    this.bullets.push(b);
                }
            }
        }
    }

    /**
     * Executes primary physics and simulation loop step.
     */
    update(dt) {
        if (this.isMatchOver) return;

        this.gameTime += dt;
        this.updateHUDTimer();

        // -------------------------------------------------------------
        // SINGLE-PLAYER AUTHORITATIVE LOGIC (AI games only)
        // In multiplayer, the DGS runs physics — all clients use
        // client-side prediction + server LERP interpolation instead.
        // -------------------------------------------------------------
        if (!this.isMultiplayer) {
            // Apply local keyboard controls to host's car
            const localCar = this.cars.find(c => c.id === clientId);
            if (localCar && localCar.alive) {
                localCar.inputThrottle = playerInputs.inputThrottle;
                localCar.inputSteer = playerInputs.inputSteer;
                if (playerInputs.shoot && localCar.shootCooldown <= 0) {
                    const b = shootBullet(localCar, playerInputs.aimYaw);
                    if (b) this.bullets.push(b);
                    playerInputs.shoot = false; // consume shoot
                }
            }

            // Update AI Bots
            for (let car of this.cars) {
                if (car.id.startsWith('bot_')) {
                    updateAIBot(car, this.cars, this.powerups, dt);
                    if (car.wantsToShoot && car.shootCooldown <= 0) {
                        const b = shootBullet(car, car.aimYaw);
                        if (b) this.bullets.push(b);
                        car.wantsToShoot = false;
                    }
                }
            }

            // Update cars movement and velocities
            for (let car of this.cars) {
                const wasAlive = car.alive;
                updateCarPhysics(car, dt);
                
                // If just fell off, notify elimination
                if (wasAlive && !car.alive) {
                    const aliveCount = this.cars.filter(c => c.alive).length;
                    
                    if (this.isMultiplayer) {
                        hostSendEliminationNotification(car.name, aliveCount);
                    } else {
                        addHUDNotification(`${car.name} flew off the platform! (${aliveCount} left)`);
                    }
                }
            }

            // Resolve car-to-car rigid collisions
            resolveCarCollisions(this.cars);

            // Update bullets, check hits
            const bulletResult = updateBullets(this.bullets, this.cars, dt);
            this.bullets = bulletResult.bullets;

            // Trigger visual knockback messages
            for (let hit of bulletResult.hits) {
                const shooter = this.cars.find(c => c.id === hit.shooterId);
                const target = this.cars.find(c => c.id === hit.targetId);
                if (shooter && target) {
                    const forcePercent = Math.round(hit.forceApplied * 100);
                    if (this.isMultiplayer) {
                        hostSendHitNotification(shooter.name, target.name, forcePercent);
                    } else {
                        addHUDNotification(`${shooter.name} hit ${target.name}! Knockback: ${forcePercent}%`);
                    }
                }
            }

            // Check powerup colliders
            const collected = checkPowerupCollections(this.powerups, this.cars);
            if (collected.length > 0) {
                // Remove powerups in reverse order to avoid index shifting
                for (let idx of collected.reverse()) {
                    this.powerups[idx].active = false;
                    scene.remove(activePowerupMeshes[idx]);
                    
                    this.powerups.splice(idx, 1);
                    activePowerupMeshes.splice(idx, 1);
                }
            }

            // Spawn powerups over time (limit max 5 at once)
            this.powerupTimer += dt;
            if (this.powerupTimer > 6.0 && this.powerups.length < 5) {
                this.spawnRandomPowerup();
                this.powerupTimer = 0;
            }

            // (DGS broadcasts game updates — no client-side broadcast needed)

            // Match Win Condition Evaluation
            const survivors = this.cars.filter(c => c.alive);
            
            if (currentGameMode === 'team') {
                // Team Battle: check if all alive players are on the same team
                if (survivors.length >= 1 && this.gameTime > 2.0) {
                    const aliveTeams = new Set(survivors.map(c => c.team || 'blue'));
                    if (aliveTeams.size <= 1) {
                        this.isMatchOver = true;
                        const winningTeam = survivors[0] ? (survivors[0].team || 'blue') : 'none';
                        const winnerName = winningTeam === 'red' ? '🔴 Red Team' : '🔵 Blue Team';
                        
                        const ranking = [...this.cars].sort((a, b) => {
                            if (a.alive && !b.alive) return -1;
                            if (!a.alive && b.alive) return 1;
                            return b.y - a.y;
                        });

                        if (this.isMultiplayer) {
                            hostSendGameOver(winnerName, ranking.map(r => ({ name: r.name, force: r.impactForce, alive: r.alive, team: r.team })));
                            displayGameOver(winnerName, ranking);
                        } else {
                            displayGameOver(winnerName, ranking);
                        }
                    }
                }
            } else {
                // FFA: last player standing
                if (survivors.length <= 1 && this.gameTime > 2.0) {
                    this.isMatchOver = true;
                    const winnerName = survivors.length === 1 ? survivors[0].name : "No one";
                    
                    const ranking = [...this.cars].sort((a, b) => {
                        if (a.alive && !b.alive) return -1;
                        if (!a.alive && b.alive) return 1;
                        return b.y - a.y;
                    });

                    if (this.isMultiplayer) {
                        hostSendGameOver(winnerName, ranking.map(r => ({ name: r.name, force: r.impactForce, alive: r.alive })));
                        displayGameOver(winnerName, ranking);
                    } else {
                        displayGameOver(winnerName, ranking);
                    }
                }
            }
        } else {
            // Client-side simulation of local car
            const localCar = this.cars.find(c => c.id === clientId);
            if (localCar && localCar.alive) {
                localCar.inputThrottle = playerInputs.inputThrottle;
                localCar.inputSteer = playerInputs.inputSteer;
                
                // Track input sequence locally in history buffer
                window.clientInputSeq++;
                window.clientInputHistory.push({
                    seq: window.clientInputSeq,
                    inputs: {
                        inputThrottle: playerInputs.inputThrottle,
                        inputSteer: playerInputs.inputSteer
                    },
                    dt: dt
                });
                
                updateCarPhysics(localCar, dt);
                
                // Guest/client predicted shooting
                if (playerInputs.shoot && localCar.shootCooldown <= 0) {
                    const bulletId = 'b_' + clientId + '_' + Math.random().toString(36).substr(2, 5);
                    playerInputs.bulletId = bulletId;
                    
                    const b = shootBullet(localCar, playerInputs.aimYaw);
                    if (b) {
                        b.id = bulletId;
                        b.spawnTime = performance.now();
                        b.serverAck = false;
                        this.bullets.push(b);
                    }
                }
            }

            if (localCar) {
                // Decay the prediction error visual offset towards zero smoothly
                const decay = Math.exp(-12.0 * dt);
                localCar.visualOffsetX = (localCar.visualOffsetX || 0) * decay;
                localCar.visualOffsetY = (localCar.visualOffsetY || 0) * decay;
                localCar.visualOffsetZ = (localCar.visualOffsetZ || 0) * decay;
                localCar.visualOffsetYaw = (localCar.visualOffsetYaw || 0) * decay;
            }

            // Timeline-based entity interpolation and extrapolation for guest players and bots
            const interpolationDelay = 100; // 100ms interpolation buffer delay to handle high latency & jitter
            const renderTime = Date.now() - interpolationDelay;
            let stateA = null;
            let stateB = null;
            
            // Find two states in history that bracket the target renderTime
            for (let i = 0; i < this.serverStateHistory.length - 1; i++) {
                const s1 = this.serverStateHistory[i];
                const s2 = this.serverStateHistory[i + 1];
                if (s1.time <= renderTime && s2.time >= renderTime) {
                    stateA = s1;
                    stateB = s2;
                    break;
                }
            }
            
            if (stateA && stateB) {
                const t = (renderTime - stateA.time) / (stateB.time - stateA.time);
                const clampedT = Math.max(0.0, Math.min(1.0, t));
                
                for (let car of this.cars) {
                    if (car.id === clientId) continue;
                    
                    const carA = stateA.cars.find(c => c.id === car.id);
                    const carB = stateB.cars.find(c => c.id === car.id);
                    
                    if (carA && carB) {
                        car.x = carA.x + (carB.x - carA.x) * clampedT;
                        car.y = carA.y + (carB.y - carA.y) * clampedT;
                        car.z = carA.z + (carB.z - carA.z) * clampedT;
                        
                        // Spherically interpolate angle
                        let diffYaw = carB.yaw - carA.yaw;
                        diffYaw = Math.atan2(Math.sin(diffYaw), Math.cos(diffYaw));
                        car.yaw = carA.yaw + diffYaw * clampedT;
                        
                        car.alive = carB.alive;
                        car.speed = carB.speed;
                        car.impactForce = carB.impactForce;
                    } else if (carB) {
                        car.x = carB.x;
                        car.y = carB.y;
                        car.z = carB.z;
                        car.yaw = carB.yaw;
                        car.alive = carB.alive;
                        car.speed = carB.speed;
                        car.impactForce = carB.impactForce;
                    }
                }
            } else {
                // If we run out of timeline states (due to latency/jitter), we EXTRAPOLATE!
                const latestState = this.serverStateHistory[this.serverStateHistory.length - 1];
                if (latestState) {
                    // Calculate how far into the future (after the latest state) we are rendering
                    const timeElapsedSec = Math.max(0, (renderTime - latestState.time) / 1000.0);
                    // Clamp extrapolation to max 1.0 second to avoid runaway cars on disconnect
                    const clampedElapsed = Math.min(timeElapsedSec, 1.0);

                    for (let car of this.cars) {
                        if (car.id === clientId) continue;
                        
                        const sCar = latestState.cars.find(c => c.id === car.id);
                        if (sCar) {
                            // Calculate velocity components if not directly present
                            const vx = sCar.vx !== undefined ? sCar.vx : (-Math.sin(sCar.yaw) * sCar.speed);
                            const vy = sCar.vy !== undefined ? sCar.vy : 0;
                            const vz = sCar.vz !== undefined ? sCar.vz : (-Math.cos(sCar.yaw) * sCar.speed);

                            car.x = sCar.x + vx * clampedElapsed;
                            car.y = sCar.y + vy * clampedElapsed;
                            car.z = sCar.z + vz * clampedElapsed;
                            car.yaw = sCar.yaw;
                            car.alive = sCar.alive;
                            car.speed = sCar.speed;
                            car.impactForce = sCar.impactForce;
                        }
                    }
                }
            }
        }        
            // Client-side predicted bullets movement
            for (let b of this.bullets) {
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                b.z += b.vz * dt;
                b.life -= dt;
            }
            this.bullets = this.bullets.filter(b => b.life > 0);
        

        // -------------------------------------------------------------
        // CLIENT INTERPOLATION AND RENDER LOGIC
        // -------------------------------------------------------------
        // In local/host mode, render local data
        this.renderEntities();
        this.updateCamera();
        this.updateHUDValues();
    }

    /**
     * Renders and updates coordinates of 3D meshes based on latest states.
     */
    renderEntities() {
        // 1. Render Cars
        for (let car of this.cars) {
            let mesh = activeCarMeshes[car.id];
            
            // Lazy load mesh if it doesn't exist (e.g. clients connecting mid game or initial sync)
            if (!mesh) {
                mesh = create3DCarMesh(car.brand, car.name);
                activeCarMeshes[car.id] = mesh;
            }

            if (car.alive) {
                const posX = (car.x || 0) + (car.visualOffsetX || 0);
                const posY = (car.y || 0) + (car.visualOffsetY || 0);
                const posZ = (car.z || 0) + (car.visualOffsetZ || 0);
                const rotY = (car.yaw || 0) + (car.visualOffsetYaw || 0);

                mesh.position.set(posX, posY, posZ);
                mesh.rotation.y = rotY;
                mesh.visible = true;

                // Animate wheels spin based on car speed
                if (mesh.userData.wheels) {
                    const wheelRotationSpeed = (car.speed / 2.0) * 0.1;
                    for (let w = 0; w < mesh.userData.wheels.length; w++) {
                        const wheel = mesh.userData.wheels[w];
                        wheel.children[0].rotation.x += wheelRotationSpeed;
                        
                        // Rotate front steering wheels slightly
                        if (w < 2) {
                            wheel.rotation.y = -car.inputSteer * 0.45;
                        }
                    }
                }
            } else {
                // If dead/out, plummet down and hide
                mesh.position.set(car.x, car.y, car.z);
                mesh.rotation.x += 0.05; // spinning fall
                if (car.y < -30) {
                    mesh.visible = false;
                }
            }
        }

        // 2. Render Bullets
        // Deactivate old client meshes no longer present
        const currentBulletIds = new Set(this.bullets.map(b => b.id));
        for (let bId in activeBulletMeshes) {
            if (!currentBulletIds.has(bId)) {
                scene.remove(activeBulletMeshes[bId]);
                delete activeBulletMeshes[bId];
            }
        }

        // Move active bullets
        for (let b of this.bullets) {
            let bMesh = activeBulletMeshes[b.id];
            if (!bMesh) {
                bMesh = createBulletMesh();
                activeBulletMeshes[b.id] = bMesh;
            }
            bMesh.position.set(b.x, b.y, b.z);
            
            // Align bullet rotation with velocity heading
            const heading = Math.atan2(b.vx, b.vz);
            bMesh.rotation.y = heading;
        }

        // 3. Render Powerups
        // Spin powerups
        for (let i = 0; i < this.powerups.length; i++) {
            const pMesh = activePowerupMeshes[i];
            if (pMesh) {
                // Hover animation
                pMesh.position.y = 0.8 + Math.sin(this.gameTime * 4 + i) * 0.25;
                pMesh.rotation.y += 0.045; // rotate
                pMesh.children[0].rotation.x += 0.02; // spin octahedron
            }
        }
    }

    /**
     * Follows local player with right-mouse orbit adjustment.
     */
    updateCamera() {
        let followCar = this.cars.find(c => c.id === clientId);
        if (!followCar) return;

        let isSpectating = false;
        if (!followCar.alive) {
            const aliveCars = this.cars.filter(c => c.alive);
            if (aliveCars.length > 0) {
                if (this.spectatedIndex === undefined || this.spectatedIndex >= aliveCars.length) {
                    this.spectatedIndex = 0;
                }
                followCar = aliveCars[this.spectatedIndex];
                isSpectating = true;
            }
        }

        // Get visual position (physical position + smoothed visual offset)
        const carVisualX = (followCar.x || 0) + (followCar.visualOffsetX || 0);
        const carVisualY = (followCar.y || 0) + (followCar.visualOffsetY || 0);
        const carVisualZ = (followCar.z || 0) + (followCar.visualOffsetZ || 0);
        const carVisualYaw = (followCar.yaw || 0) + (followCar.visualOffsetYaw || 0);

        // Camera yaw angle = car visual yaw + user offset yaw
        const totalYaw = carVisualYaw + cameraOffsetYaw;

        // Spherical offsets
        const distance = 13.5;
        const height = 5.2;

        const targetCamX = carVisualX + Math.sin(totalYaw) * distance;
        const targetCamZ = carVisualZ + Math.cos(totalYaw) * distance;
        const targetCamY = carVisualY + height;

        // Smooth camera lerp
        camera.position.x += (targetCamX - camera.position.x) * 0.15;
        camera.position.y += (targetCamY - camera.position.y) * 0.15;
        camera.position.z += (targetCamZ - camera.position.z) * 0.15;

        // Look slightly in front of the car using its visual coordinates
        const lookTarget = new THREE.Vector3(
            carVisualX - Math.sin(carVisualYaw) * 4,
            carVisualY + 0.5,
            carVisualZ - Math.cos(carVisualYaw) * 4
        );
        camera.lookAt(lookTarget);

        // Update Spectating HUD Status and Spectator Exit Button
        const exitBtn = document.getElementById('btn-spectator-exit');
        if (exitBtn) {
            if (isSpectating && this.isMultiplayer && !this.isMatchOver) {
                exitBtn.classList.remove('hidden');
            } else {
                exitBtn.classList.add('hidden');
            }
        }

        const controlsHelper = document.querySelector('.controls-helper');
        if (controlsHelper) {
            if (isSpectating) {
                controlsHelper.innerHTML = `Spectating: <strong style="color:var(--neon-cyan);">${followCar.name}</strong> | [Left Click] Cycle Player`;
            } else {
                controlsHelper.innerHTML = `<span>[W][A][S][D] Drive</span> | <span>[Left Click] Shoot</span>`;
            }
        }
    }

    /**
     * Updates the HUD lists of players and statuses.
     */
    updateHUDValues() {
        const selfCar = this.cars.find(c => c.id === clientId);
        if (selfCar) {
            document.getElementById('hud-player-force').innerText = Math.round(selfCar.impactForce * 100) + '%';
        }

        const listContainer = document.getElementById('hud-players-list');
        listContainer.innerHTML = '';

        // Sort by status and name
        const sorted = [...this.cars].sort((a, b) => b.alive - a.alive);

        for (let car of sorted) {
            const item = document.createElement('div');
            item.className = 'hud-player-item';
            if (!car.alive) item.classList.add('out');
            if (car.id === clientId) item.classList.add('self');

            const statusText = car.alive ? 'ALIVE' : 'OUT';
            const forceText = Math.round(car.impactForce * 100) + '%';

            item.innerHTML = `
                <span class="hud-player-name">${car.name}</span>
                <div class="hud-player-info">
                    <span class="hud-player-force-val">${statusText} [${forceText}]</span>
                </div>
            `;
            listContainer.innerHTML += item.outerHTML;
        }
    }

    /**
     * Formats elapsed gameplay timer.
     */
    updateHUDTimer() {
        const m = Math.floor(this.gameTime / 60);
        const s = Math.floor(this.gameTime % 60);
        const padM = m < 10 ? '0' + m : m;
        const padS = s < 10 ? '0' + s : s;
        document.getElementById('hud-timer').innerText = `${padM}:${padS}`;
    }

    /**
     * Updates client tab representation with host game state broadcasts.
     */
    applyServerState(serverState) {
        // DGS model: both host and guest apply authoritative server state

        // Update or add cars from server state without replacing the array
        const serverCarIds = new Set(serverState.cars.map(c => c.id));
        this.cars = this.cars.filter(c => serverCarIds.has(c.id));
        
        // Store state in history buffer for timeline interpolation of other players
        this.serverStateHistory.push({
            time: Date.now(),
            cars: serverState.cars.map(c => ({ ...c }))
        });
        if (this.serverStateHistory.length > 50) {
            this.serverStateHistory.shift();
        }

        for (let serverCar of serverState.cars) {
            let car = this.cars.find(c => c.id === serverCar.id);
            if (!car) {
                car = createCarPhysicsState(serverCar.id, serverCar.name, serverCar.brand, serverCar.x, serverCar.z);
                car.y = serverCar.y;
                car.yaw = serverCar.yaw;
                car.team = serverCar.team;
                this.cars.push(car);
            }
            car.team = serverCar.team;
            
            if (serverCar.id === clientId) {
                // Save current predicted state before reconciliation
                const preX = car.x;
                const preY = car.y;
                const preZ = car.z;
                const preYaw = car.yaw;

                // Apply authoritative properties
                car.alive = serverCar.alive;
                car.impactForce = serverCar.impactForce;
                
                // Snap to starting state from server for reconciliation
                car.x = serverCar.x;
                car.y = serverCar.y;
                car.z = serverCar.z;
                car.yaw = serverCar.yaw;
                car.speed = serverCar.speed;
                car.vx = serverCar.vx !== undefined ? serverCar.vx : 0;
                car.vy = serverCar.vy !== undefined ? serverCar.vy : 0;
                car.vz = serverCar.vz !== undefined ? serverCar.vz : 0;
                if (serverCar.shootCooldown !== undefined) {
                    car.shootCooldown = serverCar.shootCooldown;
                }
                
                // Client-side prediction reconciliation: discard already processed inputs
                const lastProcessedSeq = serverCar.lastProcessedSeq || 0;
                window.clientInputHistory = window.clientInputHistory.filter(input => input.seq > lastProcessedSeq);
                
                // Replay all remaining inputs in history to catch up to present
                for (let input of window.clientInputHistory) {
                    car.inputThrottle = input.inputs.inputThrottle;
                    car.inputSteer = input.inputs.inputSteer;
                    updateCarPhysics(car, input.dt);
                }

                // Calculate prediction error
                const errX = (preX || 0) - (car.x || 0);
                const errY = (preY || 0) - (car.y || 0);
                const errZ = (preZ || 0) - (car.z || 0);
                let errYaw = (preYaw || 0) - (car.yaw || 0);
                errYaw = Math.atan2(Math.sin(errYaw), Math.cos(errYaw)) || 0;

                // If error is small, smooth it out. If massive (e.g. spawn/restart), snap immediately.
                const errDistSq = errX * errX + errZ * errZ;
                if (errDistSq < 25.0) {
                    car.visualOffsetX = ((car.visualOffsetX || 0) + errX) || 0;
                    car.visualOffsetY = ((car.visualOffsetY || 0) + errY) || 0;
                    car.visualOffsetZ = ((car.visualOffsetZ || 0) + errZ) || 0;
                    car.visualOffsetYaw = ((car.visualOffsetYaw || 0) + errYaw) || 0;
                } else {
                    car.visualOffsetX = 0;
                    car.visualOffsetY = 0;
                    car.visualOffsetZ = 0;
                    car.visualOffsetYaw = 0;
                }
            }
        }

        // Match bullets list (Merge server bullets and recent local predicted bullets)
        const serverBulletIds = new Set(serverState.bullets.map(b => b.id));
        const now = performance.now();
        
        // Update acknowledgment status and filter our locally predicted bullets
        const myBullets = this.bullets.filter(b => {
            if (b.ownerId !== clientId) return false; // only process our own bullets here
            
            const inServer = serverBulletIds.has(b.id);
            if (inServer) {
                b.serverAck = true;
                return true; // keep predicting locally
            } else {
                if (b.serverAck) {
                    // Server destroyed it (hit or expired) -> discard it
                    return false;
                }
                // Not acknowledged yet, keep it if it's fresh (safety timeout 2.0s)
                return b.spawnTime !== undefined && (now - b.spawnTime < 2000);
            }
        });
        
        // Other players' bullets from the server state
        const otherBullets = serverState.bullets.filter(b => b.ownerId !== clientId);
        
        this.bullets = [...otherBullets, ...myBullets];

        // Match powerups list
        const currentPowerupIds = new Set(serverState.powerups.map(p => p.id));
        
        // Remove powerup meshes no longer in server states
        for (let i = activePowerupMeshes.length - 1; i >= 0; i--) {
            const pState = this.powerups[i];
            if (pState && !currentPowerupIds.has(pState.id)) {
                scene.remove(activePowerupMeshes[i]);
                activePowerupMeshes.splice(i, 1);
            }
        }
        
        // Add new powerup meshes
        this.powerups = serverState.powerups;
        while (activePowerupMeshes.length < this.powerups.length) {
            const newP = this.powerups[activePowerupMeshes.length];
            activePowerupMeshes.push(createPowerupMesh(newP.x, newP.z));
        }
    }

    /**
     * Cycles spectated target index among alive players.
     */
    cycleSpectator(dir) {
        const aliveCars = this.cars.filter(c => c.alive);
        if (aliveCars.length === 0) return;
        
        if (this.spectatedIndex === undefined) {
            this.spectatedIndex = 0;
        } else {
            this.spectatedIndex = (this.spectatedIndex + dir + aliveCars.length) % aliveCars.length;
        }
        
        const spectatedCar = aliveCars[this.spectatedIndex];
        addHUDNotification(`Spectating: ${spectatedCar.name}`);
    }
}

// -------------------------------------------------------------
// USER INPUT LISTENERS
// -------------------------------------------------------------
const activeKeys = {};
window.addEventListener('keydown', (e) => {
    activeKeys[e.code] = true;
    updateInputBuffer();
});

window.addEventListener('keyup', (e) => {
    activeKeys[e.code] = false;
    updateInputBuffer();
});

window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && gameManager && !gameManager.isMatchOver) { // Left Click Shoot / Spectate
        const localCar = gameManager.cars.find(c => c.id === clientId);
        if (localCar && !localCar.alive) {
            // Dead: cycle spectated target
            gameManager.cycleSpectator(1);
            return;
        }

        playerInputs.shoot = true;
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        playerInputs.aimYaw = Math.atan2(-camDir.x, -camDir.z);
    }
});

function updateInputBuffer() {
    // Throttle input W/S or Up/Down
    if (activeKeys['KeyW'] || activeKeys['ArrowUp']) {
        playerInputs.inputThrottle = 1.0;
    } else if (activeKeys['KeyS'] || activeKeys['ArrowDown']) {
        playerInputs.inputThrottle = -1.0; // full power reverse
    } else {
        playerInputs.inputThrottle = 0;
    }

    // Steering input A/D or Left/Right (Corrected directions)
    if (activeKeys['KeyA'] || activeKeys['ArrowLeft']) {
        playerInputs.inputSteer = -1.0; // steer left
    } else if (activeKeys['KeyD'] || activeKeys['ArrowRight']) {
        playerInputs.inputSteer = 1.0; // steer right
    } else {
        playerInputs.inputSteer = 0;
    }
}

// Mobile touch controls setup
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMobileControls);
} else {
    setupMobileControls();
}

function setupMobileControls() {
    const joystick = document.getElementById('mobile-joystick');
    const joystickBase = document.getElementById('joystick-base');
    const knob = document.getElementById('joystick-knob');
    const shootBtn = document.getElementById('btn-mobile-shoot');
    
    if (!joystick || !joystickBase || !knob || !shootBtn) return;
    
    let joystickActive = false;
    
    joystickBase.addEventListener('pointerdown', (e) => {
        joystickActive = true;
        try {
            joystickBase.setPointerCapture(e.pointerId);
        } catch (err) {
            console.warn("setPointerCapture failed:", err);
        }
        updateJoystick(e);
        e.preventDefault();
    });

    joystickBase.addEventListener('pointermove', (e) => {
        if (!joystickActive) return;
        updateJoystick(e);
        e.preventDefault();
    });

    joystickBase.addEventListener('pointerup', (e) => {
        joystickActive = false;
        knob.style.transform = 'translate(0px, 0px)';
        playerInputs.inputThrottle = 0;
        playerInputs.inputSteer = 0;
        e.preventDefault();
    });

    joystickBase.addEventListener('pointercancel', (e) => {
        joystickActive = false;
        knob.style.transform = 'translate(0px, 0px)';
        playerInputs.inputThrottle = 0;
        playerInputs.inputSteer = 0;
    });

    function updateJoystick(e) {
        const rect = joystickBase.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = e.clientX - centerX;
        const dy = e.clientY - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxRadius = rect.width / 2;
        
        let angle = Math.atan2(dy, dx);
        let moveX = dx;
        let moveY = dy;
        
        if (dist > maxRadius) {
            moveX = Math.cos(angle) * maxRadius;
            moveY = Math.sin(angle) * maxRadius;
        }
        
        knob.style.transform = `translate(${moveX}px, ${moveY}px)`;
        
        // Map to player inputs:
        // Y is negative for up (throttle), X is positive for right (steering)
        playerInputs.inputThrottle = -moveY / maxRadius;
        playerInputs.inputSteer = moveX / maxRadius;
    }

    // Shoot Button
    shootBtn.addEventListener('pointerdown', (e) => {
        if (gameManager && !gameManager.isMatchOver) {
            const localCar = gameManager.cars.find(c => c.id === clientId);
            if (localCar && !localCar.alive) {
                gameManager.cycleSpectator(1);
                return;
            }
            
            playerInputs.shoot = true;
            const camDir = new THREE.Vector3();
            camera.getWorldDirection(camDir);
            playerInputs.aimYaw = Math.atan2(-camDir.x, -camDir.z);
        }
        e.preventDefault();
    });

}

// -------------------------------------------------------------
// GAME LOOP IMPLEMENTATION
// -------------------------------------------------------------
let lastTime = performance.now();
function gameLoop(now) {
    requestAnimationFrame(gameLoop);

    let dt = (now - lastTime) / 1000.0;
    
    // Clamp delta time to avoid huge simulation jumps (e.g. background tabs paused)
    if (dt > 0.1) dt = 0.1;
    lastTime = now;

    if (gameManager) {
        // Local simulation (singleplayer) or client-prediction (multiplayer)
        gameManager.update(dt);
        
        // DGS model: ALL multiplayer clients (host AND guests) stream inputs to the server
        if (gameManager.isMultiplayer) {
            const camDir = new THREE.Vector3();
            camera.getWorldDirection(camDir);
            playerInputs.aimYaw = Math.atan2(-camDir.x, -camDir.z);
            clientSendInputs(playerInputs, dt, window.clientInputSeq);
            playerInputs.shoot = false; // consume shoot input
            playerInputs.bulletId = undefined; // clear predicted bullet ID
        }
    }

    renderer.render(scene, camera);
}

// Start Game Loops
init3D();
requestAnimationFrame(gameLoop);

// -------------------------------------------------------------
// UI SCREEN AND ACTION EVENT HANDLERS
// -------------------------------------------------------------

const RACER_NAMES = [
    "NeonDrifter", "VoltRider", "ApexRacer", "QuantumDrift", "NitroStriker",
    "TurboChaser", "CyberDriver", "SpeedDemon", "VelocityX", "GearShift",
    "TorqueBeast", "PistonPump", "DriftKing", "ShadowApex", "HyperDrive"
];

function getRandomRacerName() {
    return RACER_NAMES[Math.floor(Math.random() * RACER_NAMES.length)];
}

// Single-player Config Menu Setup
document.getElementById('btn-ai-menu').addEventListener('click', () => {
    showScreen('aiScreen');
    const nameInput = document.getElementById('ai-player-name');
    if (!nameInput.value) {
        nameInput.value = getRandomRacerName();
    }
});

const aiSlider = document.getElementById('ai-bot-count');
aiSlider.addEventListener('input', (e) => {
    document.getElementById('ai-bot-value').innerText = e.target.value + ' Bots';
});

document.getElementById('btn-start-ai').addEventListener('click', () => {
    const botCount = parseInt(aiSlider.value);
    
    localPlayerName = document.getElementById('ai-player-name').value.trim() || getRandomRacerName();
    localPlayerBrand = getDifferentRandomBrand(localPlayerBrand);

    showScreen('hud');
    gameManager = new GameManager(false, botCount);
});

document.getElementById('btn-back-ai').addEventListener('click', () => {
    showScreen('mainMenu');
});

// Instructions Menu
document.getElementById('btn-instructions-menu').addEventListener('click', () => {
    showScreen('instructionsScreen');
});

document.getElementById('btn-back-instructions').addEventListener('click', () => {
    showScreen('mainMenu');
});

// Multiplayer Hosting Menu
document.getElementById('btn-host-menu').addEventListener('click', () => {
    showScreen('hostScreen');
    
    // Default config values
    isHost = true;
    document.getElementById('btn-type-public').classList.add('active');
    document.getElementById('btn-type-private').classList.remove('active');
    
    const nameInput = document.getElementById('host-player-name');
    if (!nameInput.value) {
        nameInput.value = getRandomRacerName();
    }
    localPlayerName = nameInput.value;
    localPlayerBrand = BRAND_KEYS[Math.floor(Math.random() * BRAND_KEYS.length)];
});

// Listen to Host name input changes to update lobby list in real time
document.getElementById('host-player-name').addEventListener('input', (e) => {
    localPlayerName = e.target.value.trim() || "Host Player";
    updateHostLobbyUI();
    if (isHost) {
        broadcastLobbyState();
    }
});

// Toggle public vs private room hosting
document.getElementById('btn-type-public').addEventListener('click', () => {
    document.getElementById('btn-type-public').classList.add('active');
    document.getElementById('btn-type-private').classList.remove('active');
});

document.getElementById('btn-type-private').addEventListener('click', () => {
    document.getElementById('btn-type-private').classList.add('active');
    document.getElementById('btn-type-public').classList.remove('active');
});

// Game Mode toggle: FFA vs Team Battle
document.getElementById('btn-mode-ffa').addEventListener('click', () => {
    document.getElementById('btn-mode-ffa').classList.add('active');
    document.getElementById('btn-mode-team').classList.remove('active');
    currentGameMode = 'ffa';
});

document.getElementById('btn-mode-team').addEventListener('click', () => {
    document.getElementById('btn-mode-team').classList.add('active');
    document.getElementById('btn-mode-ffa').classList.remove('active');
    currentGameMode = 'team';
});

document.getElementById('btn-start-host-game').addEventListener('click', () => {
    const nameInput = document.getElementById('host-player-name');
    localPlayerName = nameInput.value.trim() || getRandomRacerName();
    localPlayerBrand = BRAND_KEYS[Math.floor(Math.random() * BRAND_KEYS.length)];
    
    const roomName = document.getElementById('host-room-name').value.trim() || "Singapore Arena";
    const isPrivate = document.getElementById('btn-type-private').classList.contains('active');

    // Host room
    hostRoom(roomName, isPrivate);
    
    // Configure lobby waiting screen elements
    document.getElementById('host-lobby-room-name').innerText = roomName;
    if (isPrivate) {
        document.getElementById('host-lobby-code-display').classList.remove('hidden');
        document.getElementById('host-lobby-private-code').innerText = currentRoomCode;
    } else {
        document.getElementById('host-lobby-code-display').classList.add('hidden');
    }
    
    // Show/hide team picker in lobby based on game mode
    const teamPicker = document.getElementById('host-lobby-team-picker');
    if (currentGameMode === 'team') {
        teamPicker.classList.remove('hidden');
    } else {
        teamPicker.classList.add('hidden');
    }
    
    showScreen('hostLobbyScreen');
    updateHostLobbyUI();
});

// Team toggle handlers for host lobby
document.getElementById('btn-team-red').addEventListener('click', () => {
    document.getElementById('btn-team-red').classList.add('active');
    document.getElementById('btn-team-blue').classList.remove('active');
    localPlayerTeam = 'red';
    updateHostLobbyUI();
    if (isHost) broadcastLobbyState();
});

document.getElementById('btn-team-blue').addEventListener('click', () => {
    document.getElementById('btn-team-blue').classList.add('active');
    document.getElementById('btn-team-red').classList.remove('active');
    localPlayerTeam = 'blue';
    updateHostLobbyUI();
    if (isHost) broadcastLobbyState();
});

// Team toggle handlers for waiting (joining client) lobby
document.getElementById('btn-waiting-team-red').addEventListener('click', () => {
    document.getElementById('btn-waiting-team-red').classList.add('active');
    document.getElementById('btn-waiting-team-blue').classList.remove('active');
    localPlayerTeam = 'red';
    // Notify host about team change
    if (typeof sendRoomMessage === 'function') {
        sendRoomMessage('TEAM_CHANGE', { playerId: clientId, team: localPlayerTeam });
    }
});

document.getElementById('btn-waiting-team-blue').addEventListener('click', () => {
    document.getElementById('btn-waiting-team-blue').classList.add('active');
    document.getElementById('btn-waiting-team-red').classList.remove('active');
    localPlayerTeam = 'blue';
    if (typeof sendRoomMessage === 'function') {
        sendRoomMessage('TEAM_CHANGE', { playerId: clientId, team: localPlayerTeam });
    }
});


document.getElementById('btn-host-lobby-start').addEventListener('click', () => {
    if (lobbyPlayers.length === 0) return; // prevent start if no opponent joined
    
    window.gameStarted = true;
    
    // Check if host checked the Fill AI bots option
    const wantFillAI = document.getElementById('host-lobby-fill-ai') && document.getElementById('host-lobby-fill-ai').checked;
    
    // Construct list of all human players
    const allPlayers = [
        { id: clientId, name: localPlayerName, brand: localPlayerBrand, team: currentGameMode === 'team' ? localPlayerTeam : undefined }
    ];
    for (let guest of lobbyPlayers) {
        allPlayers.push({ id: guest.id, name: guest.name, brand: guest.brand, team: guest.team });
    }
    
    // Only fill up remaining slots with AI bots when starting with less than 7 opponents
    if (wantFillAI && lobbyPlayers.length < 7) {
        const botsCount = 7 - lobbyPlayers.length;
        for (let i = 0; i < botsCount; i++) {
            const bBrand = BRAND_KEYS[Math.floor(Math.random() * BRAND_KEYS.length)];
            const bName = "Bot " + (i + 1);
            // In team mode, distribute bots evenly across teams
            const botTeam = currentGameMode === 'team' ? (i % 2 === 0 ? 'red' : 'blue') : undefined;
            allPlayers.push({
                id: 'bot_' + i,
                name: bName,
                brand: bBrand,
                isBot: true,
                team: botTeam
            });
        }
    }
    
    // Assign a different random brand to each player/bot in the match
    for (let p of allPlayers) {
        p.brand = getDifferentRandomBrand(p.brand);
    }
    const hostPlayer = allPlayers.find(p => p.id === clientId);
    if (hostPlayer) {
        localPlayerBrand = hostPlayer.brand;
    }
    
    // Pick a random skybox on the host and include it in the START_GAME payload.
    // The DGS will relay START_GAME to ALL clients including the host,
    // which triggers networkCallbacks.onStartGame for everyone — that is where
    // GameManager is created. Do NOT create it here.
    const chosenSkybox = getRandomSkybox();
    
    // Send START_GAME to DGS (which will start physics simulation and relay back to all)
    hostStartGame(allPlayers, chosenSkybox.file);
    
    // Show HUD immediately for the host (GameManager will be created when onStartGame fires)
    // showScreen('hud') is called inside onStartGame
});


document.getElementById('btn-host-lobby-cancel').addEventListener('click', () => {
    leaveRoom();
    showScreen('mainMenu');
});

document.getElementById('btn-back-host').addEventListener('click', () => {
    leaveRoom();
    showScreen('mainMenu');
});

// Multiplayer Join Menu
document.getElementById('btn-join-menu').addEventListener('click', () => {
    showScreen('joinScreen');
    
    const nameInput = document.getElementById('join-player-name');
    if (!nameInput.value) {
        nameInput.value = getRandomRacerName();
    }
    
    // Automatically trigger public rooms table discovery
    refreshRoomsTable();
});

document.getElementById('btn-search-room').addEventListener('click', () => {
    refreshRoomsTable();
});

document.getElementById('btn-join-private').addEventListener('click', () => {
    const code = document.getElementById('join-private-code').value.trim();
    if (code.length !== 6) {
        alert("Please enter a valid 6-digit room code.");
        return;
    }
    
    localPlayerName = document.getElementById('join-player-name').value.trim() || getRandomRacerName();
    localPlayerBrand = BRAND_KEYS[Math.floor(Math.random() * BRAND_KEYS.length)];

    const result = joinPrivateRoom(code, localPlayerName, localPlayerBrand, localPlayerTeam);
    if (!result.success) {
        alert(result.error);
    } else {
        document.getElementById('waiting-room-name').innerText = `Private Room [Code: ${code}]`;
        showScreen('waitingScreen');
    }
});

document.getElementById('btn-back-join').addEventListener('click', () => {
    showScreen('mainMenu');
});

document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    leaveRoom();
    showScreen('mainMenu');
});

// Game Over Exit buttons
document.getElementById('btn-restart').addEventListener('click', () => {
    // If AI game, restart directly
    if (gameManager && !gameManager.isMultiplayer) {
        const bCount = gameManager.chosenBots;
        localPlayerBrand = getDifferentRandomBrand(localPlayerBrand);
        showScreen('hud');
        gameManager = new GameManager(false, bCount);
    } else {
        // Multiplayer
        if (isHost) {
            hostRestartMatch();
        } else {
            // Send restart request to host
            sendRoomMessage('RESTART_REQUEST', {});
        }
    }
});

document.getElementById('btn-exit-lobby').addEventListener('click', () => {
    leaveRoom();
    showScreen('mainMenu');
});

document.getElementById('btn-spectator-exit').addEventListener('click', () => {
    leaveRoom();
    window.location.reload();
});

/**
 * Updates UI lists in host lobby.
 */
function updateHostLobbyUI() {
    const hostList = document.getElementById('host-lobby-players-list');
    if (!hostList) return;
    
    const teamBadge = currentGameMode === 'team' 
        ? `<span style="color: ${localPlayerTeam === 'red' ? 'var(--neon-red)' : 'var(--neon-cyan)'}; margin-left: 6px;">${localPlayerTeam === 'red' ? '🔴' : '🔵'}</span>` 
        : '';
    
    hostList.innerHTML = `
        <li class="host-player">
            <span>${localPlayerName}${teamBadge}</span>
            <span class="player-role">Host</span>
        </li>
    `;
    
    for (let player of lobbyPlayers) {
        const guestTeamBadge = currentGameMode === 'team' && player.team
            ? `<span style="color: ${player.team === 'red' ? 'var(--neon-red)' : 'var(--neon-cyan)'}; margin-left: 6px;">${player.team === 'red' ? '🔴' : '🔵'}</span>`
            : '';
        hostList.innerHTML += `
            <li>
                <span>${player.name}${guestTeamBadge}</span>
            </li>
        `;
    }
    
    const countEl = document.getElementById('host-lobby-count');
    if (countEl) {
        countEl.innerText = `${lobbyPlayers.length + 1}/8`;
    }
    
    // Disable Start Game if there are no opponents in the lobby
    const startBtn = document.getElementById('btn-host-lobby-start');
    if (startBtn) {
        if (lobbyPlayers.length === 0) {
            startBtn.disabled = true;
        } else {
            startBtn.disabled = false;
        }
    }
}

/**
 * Refreshes available public games list.
 */
/**
 * Refreshes available public games list by active querying.
 */
function refreshRoomsTable() {
    const tableBody = document.getElementById('rooms-list-body');
    tableBody.innerHTML = `
        <tr>
            <td colspan="4" class="no-rooms-msg">Searching for active games...</td>
        </tr>
    `;
    
    // Broadcast active query rooms message
    queryRooms();
    
    // Fallback render after 300ms in case no new heartbeats are received (e.g. showing empty list if no rooms exist)
    setTimeout(() => {
        if (tableBody.innerHTML.includes("Searching for active games...")) {
            renderRoomsTableDirect();
        }
    }, 300);
}

/**
 * Direct rendering of the rooms table from cache + localStorage.
 */
function renderRoomsTableDirect() {
    const tableBody = document.getElementById('rooms-list-body');
    const rooms = searchPublicRooms();
    
    if (rooms.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="4" class="no-rooms-msg">No active public rooms found. Try searching again!</td>
            </tr>
        `;
        return;
    }
    
    tableBody.innerHTML = '';
    for (let room of rooms) {
        const isSelfHost = (room.hostId === clientId);
        const actionBtn = isSelfHost 
            ? `<button class="btn-join-disabled" disabled>HOST</button>`
            : `<button class="btn-join-room" onclick="handleJoinPublicRoomClick('${room.hostId}', '${room.roomName}')">JOIN</button>`;
            
        tableBody.innerHTML += `
            <tr>
                <td>${room.roomName}</td>
                <td>${room.hostName}</td>
                <td>${room.playersCount}/8</td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }
}

/**
 * Reactive callback triggered by network.js when a room heartbeat arrives.
 */
window.onRoomDiscovered = () => {
    const joinScreen = document.getElementById('join-screen');
    if (joinScreen && joinScreen.classList.contains('active')) {
        renderRoomsTableDirect();
    }
};

// Global reference for onclick binding in table
window.handleJoinPublicRoomClick = (hostId, roomName) => {
    localPlayerName = document.getElementById('join-player-name').value.trim() || getRandomRacerName();
    localPlayerBrand = BRAND_KEYS[Math.floor(Math.random() * BRAND_KEYS.length)];

    joinRoomByHostId(hostId, localPlayerName, localPlayerBrand, localPlayerTeam);
    
    document.getElementById('waiting-room-name').innerText = roomName;
    showScreen('waitingScreen');
};

// -------------------------------------------------------------
// NETWORK CALLBACK BINDINGS
// -------------------------------------------------------------

// Lobby updates
networkCallbacks.onLobbyUpdate = (players, meta) => {
    // If meta contains gameMode, apply it (so joining clients know the mode)
    if (meta && meta.gameMode) {
        currentGameMode = meta.gameMode;
        const modeInfoEl = document.getElementById('waiting-mode-info');
        const gameModeEl = document.getElementById('waiting-game-mode');
        const teamPicker = document.getElementById('waiting-team-picker');
        if (modeInfoEl && gameModeEl) {
            modeInfoEl.classList.remove('hidden');
            gameModeEl.innerText = currentGameMode === 'team' ? 'Team Battle' : 'Free For All';
        }
        if (teamPicker) {
            if (currentGameMode === 'team') {
                teamPicker.classList.remove('hidden');
            } else {
                teamPicker.classList.add('hidden');
            }
        }
    }
    
    if (isHost) {
        updateHostLobbyUI();
    } else {
        const guestList = document.getElementById('waiting-lobby-players');
        guestList.innerHTML = '';
        
        // Show host first (with team badge if meta contains hostTeam)
        const hostTeam = (meta && meta.hostTeam) || 'blue';
        const hostTeamBadge = currentGameMode === 'team'
            ? `<span style="color: ${hostTeam === 'red' ? 'var(--neon-red)' : 'var(--neon-cyan)'}; margin-left: 6px;">${hostTeam === 'red' ? '🔴' : '🔵'}</span>`
            : '';
        guestList.innerHTML += `
            <li class="host-player">
                <span>Host Player${hostTeamBadge}</span>
                <span class="player-role">Host</span>
            </li>
        `;
        
        for (let player of players) {
            const isMe = (player.id === clientId);
            const teamBadge = currentGameMode === 'team' && player.team
                ? `<span style="color: ${player.team === 'red' ? 'var(--neon-red)' : 'var(--neon-cyan)'}; margin-left: 6px;">${player.team === 'red' ? '🔴' : '🔵'}</span>`
                : '';
            guestList.innerHTML += `
                <li>
                    <span>${player.name}${teamBadge} ${isMe ? '(You)' : ''}</span>
                </li>
            `;
        }
    }
};

// START_GAME — received by ALL clients (host and guest) from the DGS
// The DGS relays this back to every connected client, including the host.
// GameManager is always created here, never in the button handler.
networkCallbacks.onStartGame = (data) => {
    window.gameStarted = true;

    // Update local player brand from the server-confirmed list
    const me = data.players.find(p => p.id === clientId);
    if (me) {
        localPlayerBrand = me.brand;
    }

    // Create the thin-client GameManager (no AI, no physics loops — just renders)
    // Pass multiplayerPlayers and skybox directly so they are initialized once correctly.
    gameManager = new GameManager(true, 0, data.players, data.skybox);

    // Store the full player list so hostRestartMatch can find it after game over.
    window.lastMultiplayerPlayers  = data.players;

    showScreen('hud');
};


// Join response from host
networkCallbacks.onJoinResponse = (response) => {
    if (!response.success) {
        alert("Failed to join: " + response.error);
        showScreen('joinScreen');
    }
};

// Game updates sent from DGS — applied by ALL multiplayer clients (host AND guest)
networkCallbacks.onGameUpdate = (serverState) => {
    if (gameManager && gameManager.isMultiplayer) {
        gameManager.applyServerState(serverState);
    }
};

// Hit notify
networkCallbacks.onHitNotify = (data) => {
    addHUDNotification(`${data.shooterName} hit ${data.targetName}! Knockback: ${data.force}%`);
};

// Elimination notify
networkCallbacks.onEliminatedNotify = (data) => {
    addHUDNotification(`${data.playerName} flew off the platform! (${data.remainsCount} left)`);
};

// Game Over notify — reset gameStarted so reconnect guard doesn't block re-joining
networkCallbacks.onGameOverNotify = (winnerName, ranking) => {
    window.gameStarted = false;
    if (gameManager) {
        gameManager.isMatchOver = true;
    }
    displayGameOver(winnerName, ranking);
};

/**
 * Display the final screen and leaderboard.
 */
function displayGameOver(winnerName, ranking) {
    const isWin = (winnerName === localPlayerName);
    
    const titleEl = document.getElementById('game-over-title');
    titleEl.innerText = isWin ? "VICTORY" : "DEFEAT";
    titleEl.style.color = isWin ? 'var(--neon-green)' : 'var(--neon-red)';
    titleEl.style.textShadow = isWin ? '0 0 15px rgba(57, 255, 20, 0.6)' : '0 0 15px rgba(255, 51, 51, 0.6)';

    document.getElementById('game-over-winner').innerText = `${winnerName} wins the battle!`;

    const leaderboardEl = document.getElementById('game-over-leaderboard');
    leaderboardEl.innerHTML = '';
    
    for (let i = 0; i < ranking.length; i++) {
        const entry = ranking[i];
        const statusText = entry.alive ? 'ALIVE' : 'OUT';
        
        const forceVal = entry.force !== undefined ? entry.force : entry.impactForce;
        const dispForce = forceVal !== undefined ? forceVal : 1.0;
        
        leaderboardEl.innerHTML += `
            <li>
                <span>#${i + 1} ${entry.name}</span>
                <span>${statusText} (${Math.round(dispForce * 100)}% Force)</span>
            </li>
        `;
    }

    showScreen('gameOver');
}

function hostRestartMatch() {
    // Get the player list — prefer gameManager.multiplayerPlayers, fall back to global
    const source = (gameManager && gameManager.multiplayerPlayers && gameManager.multiplayerPlayers.length > 0)
        ? gameManager.multiplayerPlayers
        : (window.lastMultiplayerPlayers || []);

    if (source.length === 0) {
        console.warn('[Restart] No player list found — cannot restart.');
        return;
    }

    // Deep-clone so we can mutate brands without affecting the cache
    const prevPlayers = source.map(p => ({ ...p }));

    // Assign new random brands for the next match
    for (let p of prevPlayers) {
        p.brand = getDifferentRandomBrand(p.brand);
    }
    const hostPlayer = prevPlayers.find(p => p.id === clientId);
    if (hostPlayer) {
        localPlayerBrand = hostPlayer.brand;
    }

    window.gameStarted = true;

    // Pick a new skybox
    const chosenSkybox = getRandomSkybox();

    // Tell the DGS to restart the simulation for this room.
    // The DGS will relay START_GAME back to all clients (including host),
    // which triggers onStartGame and creates a fresh GameManager.
    hostStartGame(prevPlayers, chosenSkybox.file);
}
window.hostRestartMatch = hostRestartMatch;


/**
 * Temp notifications on screen for game actions.
 */
function addHUDNotification(message) {
    const notificationContainer = document.getElementById('game-hud');
    if (!notificationContainer) return;
    
    let alertBox = document.getElementById('hud-alert-container');
    if (!alertBox) {
        alertBox = document.createElement('div');
        alertBox.id = 'hud-alert-container';
        notificationContainer.appendChild(alertBox);
    }

    const msgItem = document.createElement('div');
    msgItem.className = 'hud-alert-item';
    msgItem.innerText = message;

    alertBox.appendChild(msgItem);

    // Only display max 2 damage logs at any one time
    while (alertBox.children.length > 2) {
        alertBox.removeChild(alertBox.firstChild);
    }

    // Fade out and remove after 2.5 seconds
    setTimeout(() => {
        msgItem.style.transition = 'all 0.5s';
        msgItem.style.opacity = '0';
        msgItem.style.transform = 'translateY(-10px)';
        setTimeout(() => {
            if (msgItem.parentNode) {
                msgItem.parentNode.removeChild(msgItem);
            }
        }, 500);
    }, 2500);
}

// Floating Fullscreen Button setup
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFullscreenButton);
} else {
    initFullscreenButton();
}

function initFullscreenButton() {
    const fullscreenBtn = document.getElementById('btn-mobile-fullscreen');
    if (!fullscreenBtn) return;
    
    function requestFullscreenCompat(el) {
        if (el.requestFullscreen) {
            return el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
            return el.webkitRequestFullscreen(); // Safari / iOS
        } else if (el.msRequestFullscreen) {
            return el.msRequestFullscreen();
        }
        return Promise.reject(new Error('Fullscreen API not supported'));
    }
    
    function exitFullscreenCompat() {
        if (document.exitFullscreen) {
            return document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            return document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            return document.msExitFullscreen();
        }
        return Promise.reject(new Error('Exit fullscreen not supported'));
    }
    
    function getFullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
    }
    
    fullscreenBtn.addEventListener('click', () => {
        if (!getFullscreenElement()) {
            requestFullscreenCompat(document.documentElement).catch(err => {
                console.log(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            exitFullscreenCompat();
        }
    });
    
    const fsChangeEvents = ['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'];
    fsChangeEvents.forEach(evName => {
        document.addEventListener(evName, () => {
            if (getFullscreenElement()) {
                fullscreenBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="20" height="20">
                        <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" fill="currentColor" />
                    </svg>
                `;
            } else {
                fullscreenBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="20" height="20">
                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" fill="currentColor" />
                    </svg>
                `;
            }
        });
    });
}

// -------------------------------------------------------------
// PWA INSTALLATION FORCE FLOW
// -------------------------------------------------------------
let deferredPrompt = null;

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('PWA Service Worker registered:', reg.scope))
            .catch(err => console.error('PWA Service Worker registration failed:', err));
    });
}

// Check Standalone Mode
function checkPwaInstallState() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    
    // Check if bypass has been set in session storage (for development/temporary browser playing)
    const isBypassed = sessionStorage.getItem('pwa-install-bypassed') === 'true';

    if (isStandalone || isBypassed) {
        // App is installed or bypassed -> let player access main menu
        const pwaOverlay = document.getElementById('pwa-install-overlay');
        if (pwaOverlay) pwaOverlay.classList.add('hidden');
        const mainMenu = document.getElementById('main-menu');
        if (mainMenu) mainMenu.classList.add('active');
    } else {
        // App NOT installed -> force install screen and hide main menu
        const pwaOverlay = document.getElementById('pwa-install-overlay');
        if (pwaOverlay) {
            pwaOverlay.classList.remove('hidden');
            pwaOverlay.style.display = 'flex';
        }
        const mainMenu = document.getElementById('main-menu');
        if (mainMenu) mainMenu.classList.remove('active');

        // Detect Platform & Browser to show custom install instructions
        detectPwaPlatform();
    }
}

function detectPwaPlatform() {
    const ua = navigator.userAgent.toLowerCase();
    const isIos = /iphone|ipad|ipod/.test(ua);
    
    const chromeTrigger = document.getElementById('pwa-trigger-chrome');
    const iosTrigger = document.getElementById('pwa-trigger-ios');
    const otherTrigger = document.getElementById('pwa-trigger-other');

    if (chromeTrigger) chromeTrigger.classList.add('hidden');
    if (iosTrigger) iosTrigger.classList.add('hidden');
    if (otherTrigger) otherTrigger.classList.add('hidden');

    if (isIos) {
        // iOS Safari Instructions
        if (iosTrigger) iosTrigger.classList.remove('hidden');
    } else if (deferredPrompt) {
        // Chrome / Chromium with prompt available
        if (chromeTrigger) chromeTrigger.classList.remove('hidden');
    } else {
        // Other / Desktop instruction fallback
        if (otherTrigger) otherTrigger.classList.remove('hidden');
    }
}

// Listen to beforeinstallprompt
window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent default browser install banner
    e.preventDefault();
    // Stash the event
    deferredPrompt = e;
    
    // Update platform trigger display to show install button
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const isBypassed = sessionStorage.getItem('pwa-install-bypassed') === 'true';
    if (!isStandalone && !isBypassed) {
        const chromeTrigger = document.getElementById('pwa-trigger-chrome');
        const otherTrigger = document.getElementById('pwa-trigger-other');
        if (chromeTrigger) chromeTrigger.classList.remove('hidden');
        if (otherTrigger) otherTrigger.classList.add('hidden');
    }
});

// Install Button click trigger
document.addEventListener('DOMContentLoaded', () => {
    const installBtn = document.getElementById('btn-pwa-install');
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            
            // Show prompt
            deferredPrompt.prompt();
            // Wait for user choice
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                console.log('User accepted the PWA install prompt');
                deferredPrompt = null;
                // Hide overlay
                const pwaOverlay = document.getElementById('pwa-install-overlay');
                if (pwaOverlay) pwaOverlay.classList.add('hidden');
                const mainMenu = document.getElementById('main-menu');
                if (mainMenu) mainMenu.classList.add('active');
            }
        });
    }

    // Bypass Link Handler (temporary launch in browser)
    const bypassLink = document.getElementById('pwa-bypass-link');
    if (bypassLink) {
        bypassLink.addEventListener('click', () => {
            sessionStorage.setItem('pwa-install-bypassed', 'true');
            checkPwaInstallState();
        });
    }

    // Initial check
    checkPwaInstallState();
});

// Also trigger on appinstalled event
window.addEventListener('appinstalled', () => {
    console.log('Battle Cars has been installed successfully');
    deferredPrompt = null;
    const pwaOverlay = document.getElementById('pwa-install-overlay');
    if (pwaOverlay) pwaOverlay.classList.add('hidden');
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) mainMenu.classList.add('active');
});

