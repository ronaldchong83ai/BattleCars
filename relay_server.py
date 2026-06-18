import asyncio
import json
import logging
import websockets

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

PORT = 3002

# rooms mapping: roomCode -> { "host": ws, "guests": [ws1, ws2, ...], "name": str, "isPrivate": bool, "code": str }
rooms = {}

async def handler(ws):
    logging.info("Client connected")
    ws._room_code = None
    ws._is_host = False
    ws._client_id = None
    
    try:
        async for raw_msg in ws:
            try:
                msg = json.loads(raw_msg)
            except Exception:
                continue
                
            mtype = msg.get("type")
            data = msg.get("data", {})
            
            if mtype == "register_client":
                ws._client_id = data.get("clientId")
                logging.info(f"Client registered: {ws._client_id}")
                
            elif mtype == "ping":
                try:
                    await ws.send(json.dumps({"type": "pong", "data": data}))
                except Exception:
                    pass
                
            elif mtype == "create_room":
                code = data.get("roomCode")
                room_name = data.get("roomName", "Battle Arena")
                is_private = data.get("isPrivate", False)
                
                # Close old room hosted by this client if any
                if code in rooms:
                    old_room = rooms[code]
                    for g in old_room["guests"]:
                        g._room_code = None
                        try:
                            await g.send(json.dumps({"type": "room_closed", "data": {}}))
                        except Exception:
                            pass
                    rooms.pop(code, None)
                
                rooms[code] = {
                    "host": ws,
                    "guests": [],
                    "name": room_name,
                    "isPrivate": is_private,
                    "code": code
                }
                ws._room_code = code
                ws._is_host = True
                logging.info(f"Room created: {code} ({room_name})")
                
            elif mtype == "join_room":
                code = data.get("roomCode")
                if code in rooms:
                    room = rooms[code]
                    if len(room["guests"]) >= 7:  # max 8 players (1 host + 7 guests)
                        try:
                            await ws.send(json.dumps({"type": "error", "data": {"message": "Room is full!"}}))
                        except Exception:
                            pass
                        continue
                    
                    room["guests"].append(ws)
                    ws._room_code = code
                    ws._is_host = False
                    logging.info(f"Client joined room: {code}")
                else:
                    try:
                        await ws.send(json.dumps({"type": "error", "data": {"message": "Room not found!"}}))
                    except Exception:
                        pass
                        
            elif mtype == "leave_room":
                code = ws._room_code
                if code in rooms:
                    room = rooms[code]
                    if ws._is_host:
                        # Close room
                        for g in room["guests"]:
                            g._room_code = None
                            try:
                                await g.send(json.dumps({"type": "room_closed", "data": {}}))
                            except Exception:
                                pass
                        rooms.pop(code, None)
                        logging.info(f"Host left. Room closed: {code}")
                    else:
                        if ws in room["guests"]:
                            room["guests"].remove(ws)
                        ws._room_code = None
                        # Notify host
                        try:
                            await room["host"].send(json.dumps({
                                "type": "room_relay",
                                "data": {
                                    "type": "LEAVE_REQUEST",
                                    "data": { "playerId": ws._client_id }
                                }
                            }))
                        except Exception:
                            pass
                        logging.info(f"Guest left room: {code}")
                        
            elif mtype == "list_rooms":
                open_rooms = []
                for rcode, room in rooms.items():
                    if not room["isPrivate"]:
                        open_rooms.append({
                            "roomCode": rcode,
                            "roomName": room["name"],
                            "hostName": "Host Player",
                            "playersCount": len(room["guests"]) + 1,
                            "isPrivate": False,
                            "isStarted": False
                        })
                try:
                    await ws.send(json.dumps({"type": "room_list", "data": { "rooms": open_rooms }}))
                except Exception:
                    pass
                    
            elif mtype == "room_relay":
                code = ws._room_code
                if code in rooms:
                    room = rooms[code]
                    relay_msg = json.dumps({
                        "type": "room_relay",
                        "data": data
                    })
                    
                    if ws._is_host:
                        # Send to all guests
                        for g in room["guests"]:
                            try:
                                await g.send(relay_msg)
                            except Exception:
                                pass
                    else:
                        # Send to host
                        try:
                            await room["host"].send(relay_msg)
                        except Exception:
                            pass
                            
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logging.error(f"Error in connection handler: {e}")
    finally:
        logging.info("Client disconnected")
        # Cleanup
        code = ws._room_code
        if code in rooms:
            room = rooms[code]
            if ws._is_host:
                # Close room
                for g in room["guests"]:
                    g._room_code = None
                    try:
                        await g.send(json.dumps({"type": "room_closed", "data": {}}))
                    except Exception:
                        pass
                rooms.pop(code, None)
                logging.info(f"Host disconnected. Room closed: {code}")
            else:
                if ws in room["guests"]:
                    room["guests"].remove(ws)
                # Notify host
                try:
                    await room["host"].send(json.dumps({
                        "type": "room_relay",
                        "data": {
                            "type": "LEAVE_REQUEST",
                            "data": { "playerId": ws._client_id }
                        }
                    }))
                except Exception:
                    pass
                logging.info(f"Guest disconnected from room: {code}")

async def main():
    logging.info(f"Starting Battle Cars Relay Server on ws://0.0.0.0:{PORT}...")
    async with websockets.serve(handler, "0.0.0.0", PORT):
        await asyncio.Future()  # run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logging.info("Relay server stopped.")
