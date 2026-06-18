// physics.js - 3D Car Physics and Collision Handling

// Physics Constants
const ARENA_RADIUS = 70;       // Radius of the circular battle platform
const CAR_RADIUS = 2.2;         // Bounding radius of cars for collisions
const BULLET_RADIUS = 0.5;     // Bounding radius of bullets
const POWERUP_RADIUS = 1.8;    // Bounding radius of powerups
const GRAVITY = -32.0;          // Acceleration downwards off the edge
const CAR_ACCEL = 40.0;        // Acceleration force
const CAR_DRAG = 4.0;          // Air and ground resistance drag
const CAR_MAX_SPEED = 24.0;    // Speed limit
const CAR_STEER_SPEED = 2.8;   // Steering sensitivity
const BULLET_SPEED = 65.0;     // Velocity of shot bullets
const BASE_KNOCKBACK = 38.0;   // Base impulse force of a bullet hit
const CAR_BOUNCE = 0.6;        // Bounciness of car-to-car collisions

/**
 * Initializes a car physics state object.
 */
function createCarPhysicsState(id, name, brand, x = 0, z = 0) {
    return {
        id: id,
        name: name,
        brand: brand,
        
        // 3D Position
        x: x,
        y: 0,
        z: z,
        
        // Velocity vector
        vx: 0,
        vy: 0,
        vz: 0,
        
        // Orientation
        yaw: 0,          // Rotation angle around Y axis
        speed: 0,        // Current scalar forward speed
        
        // Inputs
        inputThrottle: 0, // -1 (reverse) to 1 (forward)
        inputSteer: 0,    // -1 (left) to 1 (right)
        
        // Stats
        impactForce: 1.0, // 100% base force, increased by powerups
        alive: true,
        outOfBounds: false,
        isFalling: false,
        shootCooldown: 0
    };
}

/**
 * Updates a car's physics for a single frame (dt in seconds).
 */
function updateCarPhysics(car, dt) {
    if (!car.alive) return;

    // 1. Steering & Yaw Rotation
    // Steering is more responsive at moderate speeds, and locked if static
    const speedRatio = Math.max(0.65, Math.min(Math.abs(car.speed) / 5.0, 1.0));
    const steerDir = car.speed >= 0 ? 1 : -1;
    car.yaw -= car.inputSteer * CAR_STEER_SPEED * steerDir * speedRatio * dt;

    // 2. Drive Forces
    // Forward unit vector based on yaw
    const forwardX = -Math.sin(car.yaw);
    const forwardZ = -Math.cos(car.yaw);

    // Apply acceleration input
    if (car.inputThrottle !== 0) {
        car.speed += car.inputThrottle * CAR_ACCEL * dt;
        // Clamp to speed limits
        car.speed = Math.max(-CAR_MAX_SPEED * 0.6, Math.min(CAR_MAX_SPEED, car.speed));
    } else {
        // Friction slowdown
        if (car.speed > 0) {
            car.speed = Math.max(0, car.speed - CAR_DRAG * 2 * dt);
        } else if (car.speed < 0) {
            car.speed = Math.min(0, car.speed + CAR_DRAG * 2 * dt);
        }
    }

    // Apply general drag resistance
    car.speed -= car.speed * CAR_DRAG * 0.2 * dt;

    // Calculate target velocity on the X-Z plane
    let targetVx = forwardX * car.speed;
    let targetVz = forwardZ * car.speed;

    // Smoothly interpolate current velocity toward target velocity (adds sliding/drifting feel)
    const driftFactor = 8.0; // Higher = less drift, lower = slippier
    car.vx += (targetVx - car.vx) * driftFactor * dt;
    car.vz += (targetVz - car.vz) * driftFactor * dt;

    // 3. Gravity and Bounds Detection
    const distFromCenter = Math.sqrt(car.x * car.x + car.z * car.z);
    
    if (distFromCenter > ARENA_RADIUS) {
        car.isFalling = true;
    }
    
    if (car.isFalling || car.y < 0) {
        // Falling state off the platform (or already below it)
        car.vy += GRAVITY * dt;
    } else {
        // Safe on the platform
        car.y = 0;
        car.vy = 0;
    }

    // Apply final velocities to position
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    car.z += car.vz * dt;

    // Check if fallen below death plane
    if (car.y < -35) {
        car.alive = false;
        car.outOfBounds = true;
        car.vx = 0;
        car.vy = 0;
        car.vz = 0;
        car.speed = 0;
    }

    // Cooldown decrement
    if (car.shootCooldown > 0) {
        car.shootCooldown -= dt;
    }
}

/**
 * Resolves overlapping and elastic bounces between two cars.
 */
function resolveCarCollisions(cars) {
    for (let i = 0; i < cars.length; i++) {
        if (!cars[i].alive || cars[i].y < 0) continue;
        
        for (let j = i + 1; j < cars.length; j++) {
            if (!cars[j].alive || cars[j].y < 0) continue;

            const dx = cars[j].x - cars[i].x;
            const dz = cars[j].z - cars[i].z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const minDist = CAR_RADIUS * 2;

            if (dist < minDist) {
                // Determine collision normal
                const nx = dx / (dist || 1);
                const nz = dz / (dist || 1);

                // Push them apart equally to solve overlap
                const overlap = minDist - dist;
                cars[i].x -= nx * overlap * 0.5;
                cars[i].z -= nz * overlap * 0.5;
                cars[j].x += nx * overlap * 0.5;
                cars[j].z += nz * overlap * 0.5;

                // Relative velocity along normal
                const rvx = cars[j].vx - cars[i].vx;
                const rvz = cars[j].vz - cars[i].vz;
                const velAlongNormal = rvx * nx + rvz * nz;

                // Only bounce if they are moving towards each other
                if (velAlongNormal < 0) {
                    const impulseScalar = -(1 + CAR_BOUNCE) * velAlongNormal;
                    const impulseX = impulseScalar * nx * 0.5;
                    const impulseZ = impulseScalar * nz * 0.5;

                    cars[i].vx -= impulseX;
                    cars[i].vz -= impulseZ;
                    cars[j].vx += impulseX;
                    cars[j].vz += impulseZ;

                    // Recalculate scalar speed
                    const forwardXi = -Math.sin(cars[i].yaw);
                    const forwardZi = -Math.cos(cars[i].yaw);
                    cars[i].speed = cars[i].vx * forwardXi + cars[i].vz * forwardZi;

                    const forwardXj = -Math.sin(cars[j].yaw);
                    const forwardZj = -Math.cos(cars[j].yaw);
                    cars[j].speed = cars[j].vx * forwardXj + cars[j].vz * forwardZj;
                }
            }
        }
    }
}

/**
 * Spawns a bullet flying from a car's nose in the direction it faces or aim yaw.
 */
function shootBullet(shooter, aimYaw) {
    if (shooter.shootCooldown > 0) return null;
    
    // Set shooter cooldown (e.g. 0.4 seconds)
    shooter.shootCooldown = 0.45;

    // Bullet starts at the nose of the car
    const offsetDist = CAR_RADIUS + 0.5;
    const forwardX = -Math.sin(aimYaw);
    const forwardZ = -Math.cos(aimYaw);

    return {
        id: Math.random().toString(36).substr(2, 9),
        ownerId: shooter.id,
        x: shooter.x + forwardX * offsetDist,
        y: 0.5, // slightly off ground
        z: shooter.z + forwardZ * offsetDist,
        vx: forwardX * BULLET_SPEED,
        vy: 0,
        vz: forwardZ * BULLET_SPEED,
        impactForce: shooter.impactForce, // carries shooter's current power
        life: 1.8 // bullet disappears after 1.8s
    };
}

/**
 * Updates bullets state, processes hits and returns events.
 */
function updateBullets(bullets, cars, dt) {
    const activeBullets = [];
    const hitEvents = [];

    // Helper to get historical position of a car closest to targetTime
    function getHistoricalPosition(car, targetTime) {
        if (!car.positionHistory || car.positionHistory.length === 0) {
            return { x: car.x, y: car.y, z: car.z };
        }
        if (targetTime <= car.positionHistory[0].time) {
            return car.positionHistory[0];
        }
        if (targetTime >= car.positionHistory[car.positionHistory.length - 1].time) {
            return car.positionHistory[car.positionHistory.length - 1];
        }
        for (let i = 0; i < car.positionHistory.length - 1; i++) {
            const p1 = car.positionHistory[i];
            const p2 = car.positionHistory[i + 1];
            if (p1.time <= targetTime && p2.time >= targetTime) {
                const t = (targetTime - p1.time) / (p2.time - p1.time);
                return {
                    x: p1.x + (p2.x - p1.x) * t,
                    y: p1.y + (p2.y - p1.y) * t,
                    z: p1.z + (p2.z - p1.z) * t
                };
            }
        }
        return car.positionHistory[car.positionHistory.length - 1];
    }

    for (let b of bullets) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        b.life -= dt;

        let hitOpponent = false;

        // Check collision against all ALIVE cars (except owner)
        for (let car of cars) {
            if (!car.alive || car.id === b.ownerId || car.y < 0) continue;

            let targetX = car.x;
            let targetZ = car.z;

            // Apply lag compensation rollback on the server if shooter latency & position history are available
            const shooter = cars.find(c => c.id === b.ownerId);
            if (shooter && car.positionHistory) {
                const latency = shooter.latency || 100;
                // shooter RTT is latency in ms. One-way latency is latency / 2.
                // client timeline interpolation buffer is 100ms.
                const rollbackTime = Date.now() - 100 - (latency / 2);
                const histPos = getHistoricalPosition(car, rollbackTime);
                targetX = histPos.x;
                targetZ = histPos.z;
            }

            const dx = targetX - b.x;
            const dz = targetZ - b.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < CAR_RADIUS + BULLET_RADIUS) {
                hitOpponent = true;
                
                // Calculate knockback vector based on bullet speed vector
                const bulletSpd = Math.sqrt(b.vx * b.vx + b.vz * b.vz) || 1;
                const pushDirectionX = b.vx / bulletSpd;
                const pushDirectionZ = b.vz / bulletSpd;

                // Knockback force = base force * impact multiplier of bullet
                const knockbackForce = BASE_KNOCKBACK * b.impactForce;

                // Apply impulse velocity to opponent
                car.vx += pushDirectionX * knockbackForce;
                car.vz += pushDirectionZ * knockbackForce;
                
                // Update scalar speed variable
                const fX = -Math.sin(car.yaw);
                const fZ = -Math.cos(car.yaw);
                car.speed = car.vx * fX + car.vz * fZ;

                // Log hit details for triggers
                hitEvents.push({
                    shooterId: b.ownerId,
                    targetId: car.id,
                    forceApplied: b.impactForce,
                    hitX: b.x,
                    hitZ: b.z
                });
                break;
            }
        }

        // Keep bullet if it didn't hit and has life left
        if (!hitOpponent && b.life > 0) {
            activeBullets.push(b);
        }
    }

    return { bullets: activeBullets, hits: hitEvents };
}

/**
 * Processes powerup collision and returns collected indexes.
 */
function checkPowerupCollections(powerups, cars) {
    const collectedIndexes = [];

    for (let pIdx = 0; pIdx < powerups.length; pIdx++) {
        const p = powerups[pIdx];
        if (!p.active) continue;

        for (let car of cars) {
            if (!car.alive || car.y < 0) continue;

            const dx = car.x - p.x;
            const dz = car.z - p.z;
            const dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < CAR_RADIUS + POWERUP_RADIUS) {
                // Increase impact force by 50% (additive)
                car.impactForce += 0.5;
                collectedIndexes.push(pIdx);
                break; // this powerup is eaten, go to next powerup
            }
        }
    }

    return collectedIndexes;
}
