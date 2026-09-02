#!/usr/bin/env python3
"""
RoLink Bridge — WebSocket server on 127.0.0.1:17613
Forwards extension <-> MCP server at 127.0.0.1:3001
"""
import asyncio, json, logging, urllib.parse, hashlib, hmac
from aiohttp import web, ClientSession
import websockets
from auth import get_or_create_token, verify_token

PORT = 17613
MCP_URL = "http://127.0.0.1:3001"
clients = set()
EXPECTED_TOKEN = get_or_create_token()
start_time = asyncio.get_event_loop().time() if asyncio._get_running_loop() else 0

logging.basicConfig(level=logging.INFO, format="[bridge] %(message)s")
log = logging.getLogger("rolink")

async def forward_to_mcp(payload: dict):
    """Forward enqueue payload to MCP POST /queue/enqueue"""
    try:
        async with ClientSession() as sess:
            async with sess.post(f"{MCP_URL}/queue/enqueue", json=payload, timeout=10) as resp:
                return await resp.json()
    except Exception as e:
        log.error(f"MCP forward failed: {e}")
        return {"ok": False, "error": str(e)}

async def ws_handler(websocket):
    # websockets 12+ passes only websocket; path/query via websocket.request
    try:
        req = websocket.request  # type: ignore
        uri = req.path  # includes ?query
        query = urllib.parse.parse_qs(urllib.parse.urlparse(uri).query)
        token = query.get("token", [""])[0] or (req.headers.get("Authorization","").replace("Bearer ",""))
        role = query.get("role", ["unknown"])[0]
        # allow token via first message hello as fallback
    except Exception:
        token = ""
        role = "unknown"
    if not verify_token(token, EXPECTED_TOKEN):
        # try hello handshake: wait one message with token
        try:
            raw = await asyncio.wait_for(websocket.recv(), timeout=5)
            data = json.loads(raw)
            t2 = data.get("token") or data.get("payload",{}).get("token","")
            if not verify_token(t2, EXPECTED_TOKEN):
                await websocket.send(json.dumps({"v":1,"id":"auth","method":"error","payload":{"error":"unauthorized"}}))
                await websocket.close(code=1008)
                return
            role = data.get("role", role)
        except asyncio.TimeoutError:
            await websocket.close(code=1008)
            return
        except Exception:
            await websocket.close(code=1008)
            return

    clients.add(websocket)
    log.info(f"client connected role={role} clients={len(clients)}")
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                method = msg.get("method")
                # heartbeat
                if method == "heartbeat":
                    await websocket.send(json.dumps({"v":1,"id":msg.get("id","hb"),"method":"heartbeat","payload":{"ok":True}}))
                    continue
                # enqueue from extension
                if method == "enqueue_command":
                    payload = msg.get("payload",{})
                    # optional S43/S45/S48 passthrough
                    res = await forward_to_mcp(payload)
                    await websocket.send(json.dumps({"v":1,"id":msg.get("id",""),"method":"enqueue_command","payload":res}))
                    # broadcast to plugin clients if any
                    for c in list(clients):
                        if c is not websocket:
                            try:
                                await c.send(json.dumps({"v":1,"id":msg.get("id",""),"method":"enqueue_command","payload":payload}))
                            except: pass
                elif method == "poll_next":
                    # plugin polling fallback via WS: proxy to MCP
                    async with ClientSession() as sess:
                        async with sess.get(f"{MCP_URL}/queue/next", params={"projectId": msg.get("payload",{}).get("projectId","")}) as resp:
                            data = await resp.json()
                            await websocket.send(json.dumps({"v":1,"id":msg.get("id",""),"method":"poll_next","payload":data}))
                else:
                    # generic forward
                    await websocket.send(json.dumps({"v":1,"id":msg.get("id",""),"method":"error","payload":{"error": f"unknown method {method}"}}))
            except json.JSONDecodeError:
                await websocket.send(json.dumps({"method":"error","payload":{"error":"invalid json"}}))
    finally:
        clients.discard(websocket)
        log.info(f"client disconnected clients={len(clients)}")

# also expose HTTP health on same port via aiohttp
async def health_handler(request):
    token = request.query.get("token","")
    # health is public but rate-limited; no auth needed
    return web.json_response({"ok": True, "version": 1, "wsClients": len(clients), "bridge": "17613", "mcp": MCP_URL})

async def main():
    app = web.Application()
    app.router.add_get("/health", health_handler)
    app.router.add_get("/", health_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", PORT)
    await site.start()
    log.info(f"HTTP health on http://127.0.0.1:{PORT}/health")
    log.info(f"Token: {EXPECTED_TOKEN[:8]}... (stored in bridge/config.json)")
    log.info(f"MCP target {MCP_URL}")
    # also start WS server
    async with websockets.serve(ws_handler, "127.0.0.1", PORT):
        log.info(f"WS listening ws://127.0.0.1:{PORT}/ws?role=...&token=...")
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("shutdown")
