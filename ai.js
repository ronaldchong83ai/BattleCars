// ai.js - AI Bot Decision Making and Input Generation

/**
 * Computes inputs (throttle, steer, shoot, aimYaw) for a bot car on the host.
 * @param {Object} bot - The physics state of the bot car.
 * @param {Array} allCars - List of all cars in the game (including human players and other bots).
 * @param {Array} powerups - List of active powerups in the scene.
 * @param {number} dt - Delta time in seconds.
 */
function updateAIBot(bot, allCars, powerups, dt) {
    if (!bot.alive) return;

    // Default inputs
    bot.inputThrottle = 0;
    bot.inputSteer = 0;
    let triggerShoot = false;
    let targetYaw = bot.yaw;

    // 1. Boundary Check: Critical safety override with predictive edge braking to avoid falling off
    const distFromCenter = Math.sqrt(bot.x * bot.x + bot.z * bot.z);
    
    // Calculate speed heading outwards (radial speed)
    const radialSpeed = (bot.vx * bot.x + bot.vz * bot.z) / (distFromCenter || 1);
    
    // Predict distance in 1.5 seconds to prevent high-speed overshoot
    const predictedDist = distFromCenter + Math.max(0, radialSpeed) * 1.5;
    const dangerZone = ARENA_RADIUS * 0.60; // Start heading back to center at 60% radius
    
    if (predictedDist > ARENA_RADIUS * 0.70 || distFromCenter > dangerZone) {
        // Drive towards the center of the arena (0, 0)
        const angleToCenter = Math.atan2(bot.x, bot.z);
        steerTowardAngle(bot, angleToCenter);
        
        const diff = getAngleDifference(bot.yaw, angleToCenter);
        
        // Smart braking: if not aligned with safety direction, kill speed first to turn in place
        if (Math.abs(diff) > 0.25) {
            if (bot.speed > 1.0) {
                bot.inputThrottle = -1.0; // brake forward speed
            } else if (bot.speed < -1.0) {
                bot.inputThrottle = 1.0;  // brake reverse speed
            } else {
                bot.inputThrottle = 0.0;  // speed is low, turn in place safely
            }
        } else {
            // Facing center: accelerate back to safety
            bot.inputThrottle = 1.0;
        }
        return; // Skip targeting while recovering
    }

    // 2. Find Nearest Opponent
    let nearestOpponent = null;
    let minDistOpponent = Infinity;
    
    for (let car of allCars) {
        if (!car.alive || car.id === bot.id) continue;
        
        const dx = car.x - bot.x;
        const dz = car.z - bot.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < minDistOpponent) {
            minDistOpponent = dist;
            nearestOpponent = car;
        }
    }

    // 3. Find Nearest Powerup
    let nearestPowerup = null;
    let minDistPowerup = Infinity;
    
    for (let p of powerups) {
        if (!p.active) continue;
        
        const dx = p.x - bot.x;
        const dz = p.z - bot.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < minDistPowerup) {
            minDistPowerup = dist;
            nearestPowerup = p;
        }
    }

    // 4. Race Mode: Steer toward next checkpoint waypoint
    if (window.currentGameMode === 'race' && window.raceTrackWaypoints && window.raceCheckpointIndices) {
        const waypoints = window.raceTrackWaypoints;
        const cpIndices = window.raceCheckpointIndices;
        const numCp = cpIndices.length;
        const nextCpWpIdx = cpIndices[bot.nextCheckpoint % numCp];
        const targetWp = waypoints[nextCpWpIdx];

        if (targetWp) {
            const dx = targetWp.x - bot.x;
            const dz = targetWp.z - bot.z;
            const angleToWp = Math.atan2(-dx, -dz);
            targetYaw = angleToWp;
            steerTowardAngle(bot, angleToWp);

            const angleDiff = getAngleDifference(bot.yaw, angleToWp);
            bot.inputThrottle = Math.abs(angleDiff) < Math.PI / 3 ? 1.0 : 0.8;

            // Still shoot at nearby opponents while racing
            if (nearestOpponent && minDistOpponent < 30) {
                const angleToOpp = Math.atan2(-(nearestOpponent.x - bot.x), -(nearestOpponent.z - bot.z));
                const oppAngleDiff = getAngleDifference(bot.yaw, angleToOpp);
                if (Math.abs(oppAngleDiff) < 0.35) {
                    triggerShoot = true;
                    targetYaw = angleToOpp;
                }
            }

            // Shoot execution
            if (triggerShoot && bot.shootCooldown <= 0) {
                bot.wantsToShoot = true;
                bot.aimYaw = targetYaw;
            } else {
                bot.wantsToShoot = false;
            }
            return;
        }
    }

    // 4. Decision Node: Target powerup or opponent (non-race modes)
    // Bots will prioritize powerups if they are very close or if they aren't fully charged
    let currentTarget = null;
    let targetType = 'opponent'; // 'opponent' or 'powerup'

    if (nearestPowerup && minDistPowerup < 50 && bot.impactForce < 3.5) {
        // Collect powerup eagerly
        currentTarget = nearestPowerup;
        targetType = 'powerup';
    } else if (nearestOpponent) {
        currentTarget = nearestOpponent;
        targetType = 'opponent';
    }

    // 5. Navigate toward current target
    if (currentTarget) {
        const dx = currentTarget.x - bot.x;
        const dz = currentTarget.z - bot.z;
        const angleToTarget = Math.atan2(-dx, -dz);
        
        targetYaw = angleToTarget;
        steerTowardAngle(bot, angleToTarget);

        // Calculate heading difference
        let angleDiff = getAngleDifference(bot.yaw, angleToTarget);
        
        // Drive forward at high speeds even when turning to maintain kinetic energy and drift
        if (Math.abs(angleDiff) < Math.PI / 3) {
            bot.inputThrottle = 1.0; // full throttle
        } else {
            bot.inputThrottle = 0.8; // aggressive turning speed
        }

        // 6. Shooting behavior (Only for opponent targets)
        if (targetType === 'opponent' && minDistOpponent < 65) {
            // Widen fire angle to be more aggressive
            if (Math.abs(angleDiff) < 0.35) {
                triggerShoot = true;
            }
        }
    } else {
        // No target, just cruise in circles
        bot.inputThrottle = 0.5;
        bot.inputSteer = 0.3;
    }

    // Shoot execution
    if (triggerShoot && bot.shootCooldown <= 0) {
        bot.wantsToShoot = true;
        bot.aimYaw = targetYaw; // Fire in the direction of the target
    } else {
        bot.wantsToShoot = false;
    }
}

/**
 * Adjusts the bot's inputSteer to align its yaw with a target angle.
 */
function steerTowardAngle(bot, targetAngle) {
    let diff = getAngleDifference(bot.yaw, targetAngle);
    
    // Set steering inputs based on angular offset
    if (diff > 0.05) {
        bot.inputSteer = -1.0; // steer right (Three.js coordinates/yaw)
    } else if (diff < -0.05) {
        bot.inputSteer = 1.0;  // steer left
    } else {
        bot.inputSteer = 0;
    }
}

/**
 * Returns normalized difference between two angles in range [-PI, PI].
 */
function getAngleDifference(current, target) {
    let diff = target - current;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    return diff;
}
