// network.js - Client/Server Networking layer using WebSockets
// DGS Model: ALL clients (host AND guests) are equal thin clients.
// The server runs physics authoritatively. Clients only stream inputs and apply server state.

window.clientId = 'player_' + Math.random().toString(36).substr(2, 9);
const clientId = window.clientId;
let currentRoomCode = null;
let currentHostId = null;
let currentRoomName = null;   // stored for reconnection
let currentIsPrivate = false; // stored for reconnection
window.isHost = false;
window.currentGameMode = 'ffa';
window.localPlayerTeam = 'blue';

// Low-latency multiplayer prediction variables
window.clientInputSeq = 0;
window.clientInputHistory = [];
window.currentLatency = 50; // default initial latency approximation

// Callbacks to trigger UI or Game actions
const networkCallbacks = {
    onLobbyUpdate: null,
    onStartGame: null,
    onGameUpdate: null,
    onJoinResponse: null,
    onHitNotify: null,
    onEliminatedNotify: null,
    onGameOverNotify: null
};

// WebSocket connection
let socket = null;
let discoveredRoomsCache = {};

function initNetwork() {
    const wsHost = window.location.hostname || 'localhost';
    let wsUrl;
    if (window.location.protocol === 'https:') {
        wsUrl = `wss://${wsHost}/BattleCarsWS/`;
    } else {
        const wsPort = 3002;
        wsUrl = `ws://${wsHost}:${wsPort}`;
    }
    
    console.log(`Connecting to Battle Cars DGS at ${wsUrl}...`);
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        console.log("Connected to Battle Cars DGS");
        // Register client ID with server
        socket.send(JSON.stringify({
            type: 'register_client',
            data: { clientId: clientId }
        }));

        // ── Auto-reconnect: re-register room if we were in one ────────────
        // This handles DGS restarts (e.g. server crash → systemd restart)
        if (currentRoomCode && !window.gameStarted) {
            if (isHost) {
                // Re-create the room on the DGS
                setTimeout(() => {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            type: 'create_room',
                            data: {
                                roomCode:  currentRoomCode,
                                roomName:  currentRoomName  || 'Battle Arena',
                                isPrivate: currentIsPrivate || false
                            }
                        }));
                        // Re-broadcast lobby state so guests know the room is back
                        setTimeout(() => broadcastLobbyState(), 200);
                    }
                }, 100);
            } else if (currentHostId) {
                // Re-join the room as a guest
                setTimeout(() => {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            type: 'join_room',
                            data: { roomCode: currentHostId }
                        }));
                    }
                }, 100);
            }
        }

        // Query rooms for the lobby list
        queryRooms();
    };
    
    socket.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        
        const { type, data } = msg;
        
        // ── Ping / Pong latency measurement ───────────────────────────────
        if (type === 'pong') {
            const latency = Math.round(performance.now() - data.start);
            window.currentLatency = latency; // Store current RTT locally
            const pingEl = document.getElementById('hud-ping');
            if (pingEl) {
                pingEl.classList.remove('hidden');
                pingEl.innerText = `PING: ${latency} ms`;
            }
            return;
        }
        
        // ── Room list response ────────────────────────────────────────────
        if (type === 'room_list') {
            discoveredRoomsCache = {};
            for (let room of data.rooms) {
                discoveredRoomsCache[room.roomCode] = {
                    hostId: room.roomCode,
                    roomName: room.roomName,
                    hostName: room.hostName,
                    isPrivate: room.isPrivate,
                    roomCode: room.roomCode,
                    playersCount: room.playersCount,
                    maxPlayers: 8,
                    isStarted: room.isStarted,
                    lastHeartbeat: Date.now()
                };
            }
            if (typeof window.onRoomDiscovered === 'function') {
                window.onRoomDiscovered();
            }
        }

        // ── room_relay: messages from the DGS ────────────────────────────
        else if (type === 'room_relay') {
            const innerType = data.type;

            // Game simulation events — handled by all clients (host AND guest) identically
            const simulationEvents = [
                'START_GAME', 'GAME_UPDATE', 'HIT_NOTIFY',
                'ELIMINATED_NOTIFY', 'GAME_OVER', 'RACE_LAP_UPDATE'
            ];

            if (simulationEvents.includes(innerType)) {
                // Route to client handler for both host and guest
                handleClientMessage({ data });
            } else {
                // Lobby management events
                if (isHost) {
                    handleHostMessage({ data });
                } else {
                    handleClientMessage({ data });
                }
            }
        }

        // ── Room closed (host disconnected) ───────────────────────────────
        else if (type === 'room_closed') {
            const innerEvent = { data: { type: 'ROOM_CLOSED' } };
            handleClientMessage(innerEvent);
        }

        // ── Error from server ─────────────────────────────────────────────
        else if (type === 'error') {
            alert(data.message || "An error occurred");
            if (typeof showScreen === 'function') {
                showScreen('joinScreen');
            }
        }
    };
    
    socket.onclose = () => {
        console.warn("Connection to Battle Cars DGS lost. Retrying in 3 seconds...");
        setTimeout(initNetwork, 3000);
    };
    
    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

function queryRooms() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'list_rooms',
            data: {}
        }));
    }
}

function hostRoom(roomName, isPrivate) {
    isHost = true;
    currentHostId = clientId;
    currentRoomCode = isPrivate ? Math.floor(100000 + Math.random() * 900000).toString() : clientId;
    currentRoomName = roomName;
    currentIsPrivate = isPrivate;
    window.lobbyPlayers = [];
    window.clientInputSeq = 0;
    window.clientInputHistory = [];
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'create_room',
            data: {
                roomCode: currentRoomCode,
                roomName: roomName,
                isPrivate: isPrivate
            }
        }));
    }
}

function leaveRoom() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'leave_room',
            data: {}
        }));
    }
    isHost = false;
    currentHostId = null;
    currentRoomCode = null;
    window.lobbyPlayers = [];
    window.clientInputSeq = 0;
    window.clientInputHistory = [];
}

function searchPublicRooms() {
    let publicRooms = [];
    for (let hostId in discoveredRoomsCache) {
        const room = discoveredRoomsCache[hostId];
        if (!room.isPrivate && !room.isStarted) {
            publicRooms.push(room);
        }
    }
    return publicRooms;
}

function joinRoomByHostId(hostId, playerName, carBrand, team) {
    isHost = false;
    currentHostId = hostId;
    window.lobbyPlayers = [];
    window.clientInputSeq = 0;
    window.clientInputHistory = [];
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'join_room',
            data: { roomCode: hostId }
        }));
        
        // Send join request after a brief delay to ensure room state association
        setTimeout(() => {
            sendRoomMessage('JOIN_REQUEST', {
                playerId: clientId,
                name: playerName,
                brand: carBrand,
                team: team
            });
        }, 100);
    }
}

function joinPrivateRoom(code, playerName, carBrand, team) {
    isHost = false;
    currentHostId = code;
    window.lobbyPlayers = [];
    window.clientInputSeq = 0;
    window.clientInputHistory = [];
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'join_room',
            data: { roomCode: code }
        }));
        
        // Send join request after a brief delay to ensure room state association
        setTimeout(() => {
            sendRoomMessage('JOIN_REQUEST', {
                playerId: clientId,
                name: playerName,
                brand: carBrand,
                team: team
            });
        }, 100);
        return { success: true };
    } else {
        return { success: false, error: 'Not connected to relay server. Try refreshing.' };
    }
}

function sendRoomMessage(type, data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'room_relay',
            data: { type, data }
        }));
    }
}

function broadcastLobbyState() {
    if (!isHost) return;
    sendRoomMessage('LOBBY_UPDATE', { 
        players: window.lobbyPlayers,
        gameMode: window.currentGameMode || 'ffa',
        hostTeam: window.localPlayerTeam || 'blue'
    });
}

function hostStartGame(playersArray, skyboxName) {
    // Sends START_GAME to DGS which will start the simulation and relay to all clients
    sendRoomMessage('START_GAME', { players: playersArray, skybox: skyboxName, gameMode: window.currentGameMode || 'ffa' });
}

// hostSendGameUpdate, hostSendHitNotification, etc. are now handled server-side.
// These stubs are kept for backward compat but are no-ops.
function hostSendGameUpdate(state) {}
function hostSendHitNotification(shooterName, targetName, force) {}
function hostSendEliminationNotification(playerName, remainsCount) {}
function hostSendGameOver(winnerName, leaderboard) {}

// ─────────────────────────────────────────────────────────────────────────────
// Input streaming — sent by ALL clients (host AND guests) to the DGS
// ─────────────────────────────────────────────────────────────────────────────
function clientSendInputs(inputs, dt, seq) {
    // DGS model: both host and guest send inputs to the server
    // Send input update every frame to allow high-accuracy prediction & reconciliation
    if (socket && socket.readyState === WebSocket.OPEN) {
        sendRoomMessage('INPUT_UPDATE', {
            playerId: clientId,
            inputSeq: seq,
            latency: window.currentLatency || 50,
            dt: dt,
            inputs: {
                inputThrottle: inputs.inputThrottle,
                inputSteer: inputs.inputSteer,
                shoot: inputs.shoot,
                aimYaw: inputs.aimYaw,
                bulletId: inputs.bulletId
            }
        });
    }
}

function updateRoomMetadata(players) {
    // Left for backward compatibility
}

// ─────────────────────────────────────────────────────────────────────────────
// handleHostMessage — LOBBY management only (runs on the host client)
// ─────────────────────────────────────────────────────────────────────────────
function handleHostMessage(event) {
    const { type, data } = event.data;
    
    if (type === 'JOIN_REQUEST') {
        const { playerId, name, brand, team } = data;
        
        if (window.lobbyPlayers.length >= 7) {
            sendRoomMessage('JOIN_RESPONSE', { success: false, playerId, error: 'Room is full! (Max 8 players)' });
            return;
        }

        if (window.gameStarted) {
            sendRoomMessage('JOIN_RESPONSE', { success: false, playerId, error: 'Game already in progress!' });
            return;
        }

        const newPlayer = { id: playerId, name: name, brand: brand, team: team || 'blue' };
        window.lobbyPlayers.push(newPlayer);
        
        sendRoomMessage('JOIN_RESPONSE', { success: true, playerId });
        
        if (networkCallbacks.onLobbyUpdate) {
            networkCallbacks.onLobbyUpdate(window.lobbyPlayers);
        }
        
        broadcastLobbyState();
    }
    
    else if (type === 'TEAM_CHANGE') {
        const { playerId, team } = data;
        const player = window.lobbyPlayers.find(p => p.id === playerId);
        if (player) {
            player.team = team;
            if (networkCallbacks.onLobbyUpdate) {
                networkCallbacks.onLobbyUpdate(window.lobbyPlayers);
            }
            broadcastLobbyState();
        }
    }
    
    else if (type === 'LEAVE_REQUEST') {
        const { playerId } = data;
        window.lobbyPlayers = window.lobbyPlayers.filter(p => p.id !== playerId);
        
        if (networkCallbacks.onLobbyUpdate) {
            networkCallbacks.onLobbyUpdate(window.lobbyPlayers);
        }
        
        broadcastLobbyState();
    }
    
    else if (type === 'RESTART_REQUEST') {
        if (typeof window.hostRestartMatch === 'function') {
            window.hostRestartMatch();
        }
    }
    
    // NOTE: INPUT_UPDATE is no longer handled here — the DGS handles it server-side.
}

// ─────────────────────────────────────────────────────────────────────────────
// handleClientMessage — ALL game simulation events for both host and guest
// ─────────────────────────────────────────────────────────────────────────────
function handleClientMessage(event) {
    const { type, data } = event.data;
    
    if (type === 'JOIN_RESPONSE') {
        const { playerId, success, error } = data;
        if (playerId === clientId && networkCallbacks.onJoinResponse) {
            networkCallbacks.onJoinResponse({ success, error });
        }
    }
    
    else if (type === 'LOBBY_UPDATE') {
        const { players, gameMode, hostTeam } = data;
        window.lobbyPlayers = players;
        if (networkCallbacks.onLobbyUpdate) {
            networkCallbacks.onLobbyUpdate(players, { gameMode, hostTeam });
        }
    }
    
    else if (type === 'START_GAME') {
        if (networkCallbacks.onStartGame) {
            networkCallbacks.onStartGame(data);
        }
    }
    
    else if (type === 'GAME_UPDATE') {
        if (networkCallbacks.onGameUpdate) {
            networkCallbacks.onGameUpdate(data);
        }
    }
    
    else if (type === 'HIT_NOTIFY') {
        if (networkCallbacks.onHitNotify) {
            networkCallbacks.onHitNotify(data);
        }
    }
    
    else if (type === 'ELIMINATED_NOTIFY') {
        if (networkCallbacks.onEliminatedNotify) {
            networkCallbacks.onEliminatedNotify(data);
        }
    }
    
    else if (type === 'GAME_OVER') {
        const { winnerName, leaderboard } = data;
        if (networkCallbacks.onGameOverNotify) {
            networkCallbacks.onGameOverNotify(winnerName, leaderboard);
        }
    }
    
    else if (type === 'RACE_LAP_UPDATE') {
        if (networkCallbacks.onRaceLapUpdate) {
            networkCallbacks.onRaceLapUpdate(data);
        }
    }

    else if (type === 'ROOM_CLOSED') {
        alert("The host closed the game room.");
        leaveRoom();
        window.location.reload();
    }
}

// Global initialization
initNetwork();
window.clientId = clientId;
window.lobbyPlayers = [];
window.gameStarted = false;

// Periodic ping to measure WebSocket latency
setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'ping',
            data: { start: performance.now() }
        }));
    }
}, 2000);
