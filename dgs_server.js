/**
 * dgs_server.js — Battle Cars Authoritative Dedicated Game Server (DGS)
 *
 * Architecture:
 *  - Handles lobby management (create/join/leave/list rooms)
 *  - On START_GAME: spins up an authoritative 60 Hz physics simulation loop per room
 *  - Ingests INPUT_UPDATE from ALL clients (host and guests equally)
 *  - Broadcasts GAME_UPDATE at 20 Hz to ALL clients in the room (including the host)
 *  - Sends HIT_NOTIFY, ELIMINATED_NOTIFY, GAME_OVER events from server physics results
 *
 * Node.js dependencies: ws  (npm install ws)
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = 3002;

// ─────────────────────────────────────────────────────────────────────────────
// Load physics.js and ai.js into the global context using vm.runInThisContext.
// This makes all top-level function declarations and var variables available
// in the module scope without the strict-mode eval scoping issue.
// ─────────────────────────────────────────────────────────────────────────────
const physicsCode = fs.readFileSync(path.join(__dirname, 'physics.js'), 'utf8');
const aiCode      = fs.readFileSync(path.join(__dirname, 'ai.js'),      'utf8');

// runInThisContext runs the script in the current V8 context (the global object),
// so all top-level declarations become global and are accessible throughout this file.
vm.runInThisContext(physicsCode, { filename: 'physics.js' });
vm.runInThisContext(aiCode,      { filename: 'ai.js' });

console.log('[DGS] physics.js and ai.js loaded successfully.');
console.log('[DGS] Physics check - ARENA_RADIUS:', typeof ARENA_RADIUS !== 'undefined' ? ARENA_RADIUS : 'NOT FOUND');

// ─────────────────────────────────────────────────────────────────────────────
// Room registry
// ─────────────────────────────────────────────────────────────────────────────
const rooms = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Physics tick constants
// ─────────────────────────────────────────────────────────────────────────────
const TICK_MS            = 1000 / 60;   // 60 Hz
const BROADCAST_INTERVAL = 0.05;        // 20 Hz broadcast
const MAX_POWERUPS       = 5;
const POWERUP_SPAWN_SEC  = 6.0;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function broadcast(room, msgObj) {
    const raw = JSON.stringify(msgObj);
    for (const [ws] of room.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(raw);
        }
    }
}

function broadcastRelay(room, innerType, innerData) {
    broadcast(room, { type: 'room_relay', data: { type: innerType, data: innerData } });
}

function sendTo(ws, msgObj) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msgObj));
    }
}

function spawnPowerup() {
    const angle  = Math.random() * Math.PI * 2;
    const radius = Math.random() * (ARENA_RADIUS * 0.7);
    return {
        id:     'p_' + Math.random().toString(36).substr(2, 9),
        x:      Math.cos(angle) * radius,
        z:      Math.sin(angle) * radius,
        active: true
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Game room simulation lifecycle
// ─────────────────────────────────────────────────────────────────────────────
function startGameRoom(room, players, skybox) {
    // Allow restart if the previous match ended (matchOver=true).
    // Block only if a match is actively running.
    if (room.isStarted && !room.matchOver) return;

    // Stop any lingering physics interval before starting fresh
    if (room.physicsInterval) {
        clearInterval(room.physicsInterval);
        room.physicsInterval = null;
    }

    room.isStarted    = true;

    room.matchOver    = false;
    room.gameTime     = 0;
    room.powerupTimer = 0;
    room.bullets      = [];
    room.powerups     = [];
    room.broadcastTimer = 0;
    room.skybox       = skybox;

    // Spawn initial powerups
    for (let i = 0; i < 3; i++) {
        room.powerups.push(spawnPowerup());
    }

    // Create authoritative car states from player list
    room.cars = [];
    for (let i = 0; i < players.length; i++) {
        const p     = players[i];
        const angle = (i / players.length) * Math.PI * 2;
        const car   = createCarPhysicsState(
            p.id, p.name, p.brand,
            Math.cos(angle) * 30,
            Math.sin(angle) * 30
        );
        car.yaw   = angle + Math.PI;
        car.isBot = !!p.isBot;
        // Pending shoot state (set from INPUT_UPDATE messages)
        car._pendingShoot  = false;
        car._pendingAimYaw = 0;
        car._pendingBulletId = null;
        car._lastProcessedSeq = 0;
        car.latency = 100; // default latency estimation (100ms)
        car.inputQueue = [];
        car.positionHistory = [];
        room.cars.push(car);
    }

    console.log(`[DGS] Room ${room.code} simulation started with ${room.cars.length} entities.`);

    // Start physics loop
    let lastTick = Date.now();
    room.physicsInterval = setInterval(() => {
        if (room.matchOver) return;

        const now   = Date.now();
        const dt    = Math.min((now - lastTick) / 1000, 0.05);
        lastTick    = now;
        room.gameTime += dt;

        // ── Track position history for lag-compensated rollback ──────────
        const nowTime = Date.now();
        for (const car of room.cars) {
            if (!car.positionHistory) {
                car.positionHistory = [];
            }
            car.positionHistory.push({
                time: nowTime,
                x: car.x,
                y: car.y,
                z: car.z,
                alive: car.alive
            });
            // Keep history up to 1.5 seconds (at 60Hz tick, ~90 entries)
            if (car.positionHistory.length > 90) {
                car.positionHistory.shift();
            }
        }

        // ── Human player input processing and physics ────────────────────
        for (const car of room.cars) {
            if (car.isBot || !car.alive) continue;

            if (!car.inputQueue) car.inputQueue = [];

            let appliedInput = null;
            if (car.inputQueue.length > 0) {
                // Coalesce inputs in the queue to completely eliminate latency accumulation
                let mergedShoot = false;
                let mergedBulletId = null;
                let lastSeq = car._lastProcessedSeq;
                let latestInput = null;

                while (car.inputQueue.length > 0) {
                    latestInput = car.inputQueue.shift();
                    if (latestInput.inputs.shoot) {
                        mergedShoot = true;
                        if (latestInput.inputs.bulletId) {
                            mergedBulletId = latestInput.inputs.bulletId;
                        }
                    }
                    lastSeq = latestInput.seq;
                }

                if (latestInput) {
                    appliedInput = {
                        inputs: {
                            ...latestInput.inputs,
                            shoot: mergedShoot,
                            bulletId: mergedBulletId
                        },
                        seq: lastSeq
                    };
                }
            }

            if (appliedInput) {
                // Apply the queued inputs
                car.inputThrottle = appliedInput.inputs.inputThrottle;
                car.inputSteer = appliedInput.inputs.inputSteer;
                car._lastProcessedSeq = appliedInput.seq;

                // Handle shooting if triggered
                if (appliedInput.inputs.shoot && car.shootCooldown <= 0) {
                    const b = shootBullet(car, appliedInput.inputs.aimYaw !== undefined ? appliedInput.inputs.aimYaw : car.yaw);
                    if (b) {
                        if (appliedInput.inputs.bulletId) {
                            b.id = appliedInput.inputs.bulletId;
                        }
                        
                        // Fast-forward bullet position by one-way trip delay
                        const latencySec = (car.latency || 100) / 1000.0;
                        const oneWayDelay = Math.min(latencySec / 2.0, 0.45);
                        
                        b.x += b.vx * oneWayDelay;
                        b.z += b.vz * oneWayDelay;
                        b.life -= oneWayDelay;
                        
                        room.bullets.push(b);
                    }
                }
            }

            // Always run physics exactly once per server tick using the server's tick dt
            const wasAlive = car.alive;
            updateCarPhysics(car, dt);

            if (wasAlive && !car.alive) {
                const aliveCount = room.cars.filter(c => c.alive).length;
                broadcastRelay(room, 'ELIMINATED_NOTIFY', {
                    playerName: car.name,
                    remainsCount: aliveCount
                });
            }
        }

        // ── Bot AI inputs and physics ────────────────────────────────────
        for (const car of room.cars) {
            if (!car.isBot || !car.alive) continue;
            
            updateAIBot(car, room.cars, room.powerups, dt);
            
            if (car.wantsToShoot && car.shootCooldown <= 0) {
                const b = shootBullet(car, car.aimYaw);
                if (b) room.bullets.push(b);
                car.wantsToShoot = false;
            }

            const wasAlive = car.alive;
            updateCarPhysics(car, dt);

            if (wasAlive && !car.alive) {
                const aliveCount = room.cars.filter(c => c.alive).length;
                broadcastRelay(room, 'ELIMINATED_NOTIFY', {
                    playerName: car.name,
                    remainsCount: aliveCount
                });
            }
        }

        // ── Car-car collisions ───────────────────────────────────────────
        resolveCarCollisions(room.cars);

        // ── Bullet updates & hit detection ───────────────────────────────
        const bulletResult = updateBullets(room.bullets, room.cars, dt);
        room.bullets = bulletResult.bullets;

        for (const hit of bulletResult.hits) {
            const shooter = room.cars.find(c => c.id === hit.shooterId);
            const target  = room.cars.find(c => c.id === hit.targetId);
            if (shooter && target) {
                broadcastRelay(room, 'HIT_NOTIFY', {
                    shooterName: shooter.name,
                    targetName:  target.name,
                    force:       Math.round(hit.forceApplied * 100)
                });
            }
        }

        // ── Powerup collection ───────────────────────────────────────────
        const collected = checkPowerupCollections(room.powerups, room.cars);
        for (const idx of collected.reverse()) {
            room.powerups[idx].active = false;
            room.powerups.splice(idx, 1);
        }

        // ── Powerup spawn ────────────────────────────────────────────────
        room.powerupTimer += dt;
        if (room.powerupTimer >= POWERUP_SPAWN_SEC && room.powerups.length < MAX_POWERUPS) {
            room.powerups.push(spawnPowerup());
            room.powerupTimer = 0;
        }

        // ── Win condition ────────────────────────────────────────────────
        const survivors = room.cars.filter(c => c.alive);
        if (survivors.length <= 1 && room.gameTime > 2.0) {
            room.matchOver = true;
            const winnerName = survivors.length === 1 ? survivors[0].name : 'No one';
            const ranking    = [...room.cars].sort((a, b) => {
                if (a.alive && !b.alive) return -1;
                if (!a.alive && b.alive) return 1;
                return b.y - a.y;
            });
            broadcastRelay(room, 'GAME_OVER', {
                winnerName,
                leaderboard: ranking.map(r => ({
                    name:  r.name,
                    force: r.impactForce,
                    alive: r.alive
                }))
            });
            clearInterval(room.physicsInterval);
            room.physicsInterval = null;
            return;
        }

        // ── Broadcast authoritative state at 20 Hz ───────────────────────
        room.broadcastTimer += dt;
        if (room.broadcastTimer >= BROADCAST_INTERVAL) {
            room.broadcastTimer -= BROADCAST_INTERVAL;

            const stateData = {
                cars: room.cars.map(c => ({
                    id:          c.id,
                    name:        c.name,
                    brand:       c.brand,
                    alive:       c.alive,
                    x:           c.x,
                    y:           c.y,
                    z:           c.z,
                    yaw:         c.yaw,
                    speed:       c.speed,
                    vx:          c.vx,
                    vy:          c.vy,
                    vz:          c.vz,
                    inputSteer:  c.inputSteer,
                    impactForce: c.impactForce,
                    lastProcessedSeq: c._lastProcessedSeq || 0
                })),
                bullets: room.bullets.map(b => ({
                    id:      b.id,
                    ownerId: b.ownerId,
                    x:  b.x,  y:  b.y,  z:  b.z,
                    vx: b.vx, vy: b.vy, vz: b.vz,
                    life: b.life
                })),
                powerups: room.powerups.map(p => ({
                    id: p.id, x: p.x, z: p.z
                }))
            };
            broadcastRelay(room, 'GAME_UPDATE', stateData);
        }

    }, TICK_MS);
}

function stopGameRoom(room) {
    if (room.physicsInterval) {
        clearInterval(room.physicsInterval);
        room.physicsInterval = null;
    }
    room.isStarted = false;
    console.log(`[DGS] Room ${room.code} simulation stopped.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket server
// ─────────────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

console.log(`[DGS] Battle Cars DGS listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', (ws) => {
    ws._clientId  = null;
    ws._roomCode  = null;
    ws._isHost    = false;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        const { type, data = {} } = msg;

        // ── register_client ────────────────────────────────────────────
        if (type === 'register_client') {
            ws._clientId = data.clientId;
            console.log(`[DGS] Client registered: ${ws._clientId}`);
        }

        // ── ping ───────────────────────────────────────────────────────
        else if (type === 'ping') {
            sendTo(ws, { type: 'pong', data });
        }

        // ── create_room ────────────────────────────────────────────────
        else if (type === 'create_room') {
            // Clean up any existing room associations for this socket
            handleLeave(ws);

            const code      = data.roomCode;
            const roomName  = data.roomName  || 'Battle Arena';
            const isPrivate = data.isPrivate || false;

            // Close any existing room under this code
            if (rooms.has(code)) {
                const old = rooms.get(code);
                stopGameRoom(old);
                for (const [gWs] of old.clients) {
                    sendTo(gWs, { type: 'room_closed', data: {} });
                    gWs._roomCode = null;
                }
                rooms.delete(code);
            }

            const room = {
                code,
                name:            roomName,
                isPrivate,
                hostWs:          ws,
                clients:         new Map(),
                cars:            [],
                bullets:         [],
                powerups:        [],
                gameTime:        0,
                powerupTimer:    0,
                broadcastTimer:  0,
                isStarted:       false,
                matchOver:       false,
                physicsInterval: null,
                skybox:          null,
            };
            room.clients.set(ws, { clientId: ws._clientId, isHost: true });
            rooms.set(code, room);

            ws._roomCode = code;
            ws._isHost   = true;
            console.log(`[DGS] Room created: ${code} ("${roomName}")`);
        }

        // ── join_room ──────────────────────────────────────────────────
        else if (type === 'join_room') {
            // Clean up any existing room associations for this socket
            handleLeave(ws);

            const code = data.roomCode;
            if (!rooms.has(code)) {
                sendTo(ws, { type: 'error', data: { message: 'Room not found!' } });
                return;
            }
            const room = rooms.get(code);
            if (room.clients.size >= 8) {
                sendTo(ws, { type: 'error', data: { message: 'Room is full!' } });
                return;
            }
            room.clients.set(ws, { clientId: ws._clientId, isHost: false });
            ws._roomCode = code;
            ws._isHost   = false;
            console.log(`[DGS] Client ${ws._clientId} joined room ${code}`);
        }

        // ── leave_room ─────────────────────────────────────────────────
        else if (type === 'leave_room') {
            handleLeave(ws);
        }

        // ── list_rooms ─────────────────────────────────────────────────
        else if (type === 'list_rooms') {
            const openRooms = [];
            for (const [, room] of rooms) {
                if (!room.isPrivate) {
                    openRooms.push({
                        roomCode:     room.code,
                        roomName:     room.name,
                        hostName:     'Host Player',
                        playersCount: room.clients.size,
                        isPrivate:    false,
                        isStarted:    room.isStarted
                    });
                }
            }
            sendTo(ws, { type: 'room_list', data: { rooms: openRooms } });
        }

        // ── room_relay ─────────────────────────────────────────────────
        else if (type === 'room_relay') {
            const code = ws._roomCode;
            if (!code || !rooms.has(code)) return;
            const room      = rooms.get(code);
            const innerType = data.type;
            const innerData = data.data || {};

            // ── INPUT_UPDATE: update authoritative car inputs on server ──
            if (innerType === 'INPUT_UPDATE') {
                const { playerId, inputs, inputSeq, latency, dt } = innerData;
                if (room.isStarted && room.cars) {
                    const car = room.cars.find(c => c.id === playerId);
                    if (car && car.alive) {
                        if (!car.inputQueue) {
                            car.inputQueue = [];
                        }
                        car.inputQueue.push({
                            seq: inputSeq,
                            inputs: inputs,
                            dt: dt || (TICK_MS / 1000)
                        });
                        // Limit queue size to prevent memory bloat/latency accumulation
                        if (car.inputQueue.length > 60) {
                            car.inputQueue.shift();
                        }
                        if (latency !== undefined) {
                            car.latency = latency;
                        }
                    }
                }
                return; // Never relay INPUT_UPDATE to others
            }

            // ── START_GAME: start server simulation, relay to all clients ──
            if (innerType === 'START_GAME') {
                const { players, skybox } = innerData;
                startGameRoom(room, players, skybox);
                // Relay START_GAME to ALL clients in the room (including the host)
                broadcast(room, {
                    type: 'room_relay',
                    data: { type: 'START_GAME', data: innerData }
                });
                return;
            }

            // ── Lobby relay: host ↔ guests ────────────────────────────────
            if (ws._isHost) {
                // Host → all guests
                const relayMsg = JSON.stringify({ type: 'room_relay', data });
                for (const [gWs, meta] of room.clients) {
                    if (!meta.isHost && gWs.readyState === WebSocket.OPEN) {
                        gWs.send(relayMsg);
                    }
                }
            } else {
                // Guest → host
                if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
                    room.hostWs.send(JSON.stringify({ type: 'room_relay', data }));
                }
            }
        }
    });

    ws.on('close', () => {
        handleLeave(ws);
    });

    ws.on('error', (err) => {
        console.error(`[DGS] WebSocket error for ${ws._clientId}:`, err.message);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup on disconnect / explicit leave
// ─────────────────────────────────────────────────────────────────────────────
function handleLeave(ws) {
    const code = ws._roomCode;
    if (!code || !rooms.has(code)) return;

    const room = rooms.get(code);
    ws._roomCode = null;

    if (ws._isHost) {
        // Host left → close room for everyone
        stopGameRoom(room);
        for (const [gWs] of room.clients) {
            gWs._roomCode = null;
            sendTo(gWs, { type: 'room_closed', data: {} });
        }
        rooms.delete(code);
        console.log(`[DGS] Host left. Room ${code} closed.`);
    } else {
        // Guest left
        room.clients.delete(ws);

        // Notify host via relay (lobby UI updates)
        if (room.hostWs && room.hostWs.readyState === WebSocket.OPEN) {
            sendTo(room.hostWs, {
                type: 'room_relay',
                data: {
                    type: 'LEAVE_REQUEST',
                    data: { playerId: ws._clientId }
                }
            });
        }
        console.log(`[DGS] Guest ${ws._clientId} left room ${code}`);
    }
}
