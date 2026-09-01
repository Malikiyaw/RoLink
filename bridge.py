#!/usr/bin/env python3
"""
RoLink Bridge — hardened WS 127.0.0.1:17613 <-> StudioMCP stdio + RoLink MCP HTTP fallback
SPDX-License-Identifier: GPL-3.0-or-later
Single dependency: websockets
"""
import asyncio, json, sys, os, subprocess, pathlib, threading, queue, time, signal, collections
from concurrent.futures import ThreadPoolExecutor

try:
    import websockets
    from websockets.server import serve
except ImportError:
    print("[RoLink] missing websockets — run: pip install websockets", file=sys.stderr)
    sys.exit(1)

BRIDGE_VERSION = "1.1.3"
PORT = int(os.environ.get("ROLINK_BRIDGE_PORT") or "17613")
CONFIG_PATH = pathlib.Path(__file__).parent / "config.json"
STUDIO_MCP_PORT = 13469  # Studio MCP squatter detection

clients = set()
start_time = time.time()
pending = {}  # id -> queue for WS awaiting MCP reply (bridge->extension correlation)
servers = {}  # name -> MCPClient

def log(msg, level="info"):
    prefix = {"info":"[RoLink]","warn":"[WARN]","error":"[ERROR]"}[level]
    print(f"{prefix} {msg}", flush=True)

# ---------- Config hot-reload + restart ----------
def load_config():
    if CONFIG_PATH.exists():
        try: return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except: return {"mcpServers":{}}
    return {"mcpServers":{}}

# ---------- MCPClient: one per config server, hardened ----------
class MCPClient:
    def __init__(self, name, cmd, args):
        self.name = name
        self.cmd = cmd
        self.args = args or []
        self.proc = None
        self.reader_thread = None
        self.pending = {}  # id -> Queue
        self.lock = threading.Lock()
        self.call_lock = threading.Lock()
        self.stderr_tail = collections.deque(maxlen=8)
        self.running = False

    def _spawn(self):
        # .py via sys.executable, else cmd directly; npx etc via cmd.exe /c on win
        if self.cmd.endswith(".py"):
            full = [sys.executable, self.cmd] + self.args
        elif self.cmd in ("npx","npm","yarn","pnpm","bunx"):
            full = ["cmd.exe","/c", self.cmd] + self.args if sys.platform=="win32" else [self.cmd]+self.args
        else:
            full = [self.cmd] + self.args
        log(f"spawning {self.name}: {' '.join(full)}")
        self.proc = subprocess.Popen(full, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, cwd=str(pathlib.Path(__file__).parent))
        self.running = True
        self.reader_thread = threading.Thread(target=self._reader, daemon=True)
        self.reader_thread.start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        # handshake with retries: initialize + tools/list 12x
        try:
            self.call({"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rolink-bridge","version":BRIDGE_VERSION}}}, timeout=5)
            self.call({"jsonrpc":"2.0","id":"init2","method":"notifications/initialized","params":{}}, timeout=2)
            for i in range(12):
                try: self.call({"jsonrpc":"2.0","id":f"tools-{i}","method":"tools/list","params":{}}, timeout=3); break
                except: time.sleep(1)
        except Exception as e:
            log(f"{self.name} handshake warn: {e}", "warn")

    def _reader(self):
        try:
            for line in self.proc.stdout:
                line=line.strip()
                if not line: continue
                try:
                    data=json.loads(line)
                    cid=data.get("id")
                    if cid and cid in self.pending:
                        try: self.pending[cid].put(data, timeout=1)
                        except: pass
                except: pass
        except: pass
        self.running=False

    def _drain_stderr(self):
        try:
            for line in self.proc.stderr:
                self.stderr_tail.append(line.strip())
        except: pass

    def call(self, payload, timeout=30):
        cid = str(payload.get("id"))
        q = queue.Queue()
        with self.lock: self.pending[cid]=q
        with self.call_lock:
            try:
                self.proc.stdin.write(json.dumps(payload)+"\n"); self.proc.stdin.flush()
            except Exception as e:
                with self.lock: self.pending.pop(cid,None)
                raise RuntimeError(f"write failed: {e} stderr: {';'.join(self.stderr_tail)}")
        try: return q.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"timeout {cid} stderr: {';'.join(self.stderr_tail)}")
        finally:
            with self.lock: self.pending.pop(cid,None)

    def ensure(self):
        if not self.proc or self.proc.poll() is not None:
            log(f"{self.name} crashed, restarting... stderr: {';'.join(self.stderr_tail)}", "warn")
            try: self._spawn()
            except Exception as e: log(f"restart failed: {e}", "error")

    def stop(self):
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                try: self.proc.wait(timeout=2)
                except: self.proc.kill()
        except: pass

def ensure_servers():
    cfg = load_config()
    for name, spec in cfg.get("mcpServers", {}).items():
        if name not in servers:
            c = MCPClient(name, spec.get("command",""), spec.get("args",[]))
            try: c._spawn()
            except Exception as e: log(f"failed {name}: {e}", "error")
            else: servers[name]=c
        else:
            servers[name].ensure()
    # remove deleted
    for k in list(servers.keys()):
        if k not in cfg.get("mcpServers", {}):
            servers[k].stop(); del servers[k]

# Fallback: also proxy to Node HTTP mcp-server on 3001 if StudioMCP not yet ready
async def http_fallback(payload):
    import urllib.request, urllib.error
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request("http://127.0.0.1:3001/queue/enqueue", data=data, headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"ok":False,"error":str(e)}

# ---------- WS handler ----------
async def ws_handler(ws):
    # websockets 12+: ws.request.path
    try:
        path = ws.request.path if hasattr(ws,"request") else "/"
    except: path="/"
    clients.add(ws)
    log(f"WS client connected {ws.remote_address} clients={len(clients)}")
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except:
                await ws.send(json.dumps({"id":"err","error":"invalid json"}))
                continue
            method = msg.get("method") or msg.get("tool")
            mid = msg.get("id") or str(int(time.time()*1000))
            # heartbeat
            if method in ("heartbeat","ping"):
                await ws.send(json.dumps({"id":mid,"result":{"ok":True,"pong":True}}))
                continue
            # config hot-reload
            if method == "add_server":
                cfg = load_config()
                cfg.setdefault("mcpServers",{})[msg["name"]] = {"command":msg["command"],"args":msg.get("args",[])}
                tmp = CONFIG_PATH.with_suffix(".tmp")
                tmp.write_text(json.dumps(cfg,indent=2),encoding="utf-8")
                tmp.replace(CONFIG_PATH)
                ensure_servers()
                await ws.send(json.dumps({"id":mid,"result":{"ok":True}}))
                continue
            if method == "restart":
                await ws.send(json.dumps({"id":mid,"result":{"ok":True,"restarting":True}}))
                # kill children then exec self
                if sys.platform=="win32":
                    subprocess.run(["taskkill","/F","/T","/PID",str(os.getpid())], capture_output=True)
                os.execv(sys.executable, [sys.executable, __file__])
            # tool dispatch: try roblox server first, then http fallback
            ensure_servers()
            payload = msg
            # normalize MCP tool call: {jsonrpc, method: tools/call, params:{name, arguments}}
            dispatched=False
            for name, client in servers.items():
                try:
                    client.ensure()
                    # if msg is already JSON-RPC, send as-is; else wrap
                    if "jsonrpc" in msg:
                        res = await asyncio.to_thread(client.call, msg, 30)
                    else:
                        # map RoLink enqueue style -> tools/call if needed
                        res = await asyncio.to_thread(client.call, {"jsonrpc":"2.0","id":mid,"method":"tools/call","params":{"name": msg.get("tool") or msg.get("method"), "arguments": msg.get("args") or msg.get("params") or {}}}, 30)
                    await ws.send(json.dumps({"id":mid,"result":res}))
                    dispatched=True
                    break
                except Exception as e:
                    log(f"{name} call failed: {e}", "warn")
                    continue
            if not dispatched:
                # HTTP fallback to Node mcp-server
                loop = asyncio.get_event_loop()
                res = await http_fallback(msg)
                await ws.send(json.dumps({"id":mid,"result":res}))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)
        log(f"WS disconnect clients={len(clients)}")

async def health_handler(reader, writer):
    try:
        data = await reader.read(1024)
        txt = data.decode(errors="ignore")
        # Minimal CORS preflight
        if "OPTIONS" in txt.split("\r\n")[0]:
            resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\n\r\n"
            writer.write(resp.encode()); await writer.drain()
            writer.close(); return
        body = json.dumps({"ok":True,"version":BRIDGE_VERSION,"bridge":PORT,"clients":len(clients),"servers":list(servers.keys()),"uptime": int(time.time()-start_time)})
        resp = f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n\r\n{body}"
        writer.write(resp.encode()); await writer.drain()
    except: pass
    finally:
        try: writer.close()
        except: pass

async def http_ws_process_request(path, request_headers):
    # websockets process_request hook: serve health on HTTP GET, else WS upgrade
    # path includes "?role=extension&token=dummy"
    clean = path.split("?")[0] if path else "/"
    if clean in ("/health", "/health/", "/"):
        if request_headers.get("Upgrade", "").lower() != "websocket":
            body = json.dumps({"ok":True,"version":BRIDGE_VERSION,"bridge":PORT,"clients":len(clients),"servers":list(servers.keys()),"uptime": int(time.time()-start_time)}).encode()
            return (200, [("Content-Type","application/json"),("Access-Control-Allow-Origin","*"),("Content-Length",str(len(body)))], body)
    return None

async def main():
    ensure_servers()
    import socket as _socket
    _sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    _sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    _sock.bind(("127.0.0.1", PORT))
    _sock.listen(128)
    ws_server = await serve(ws_handler, sock=_sock, max_size=10*1024*1024, process_request=http_ws_process_request)
    log(f"RoLink Bridge {BRIDGE_VERSION} WS ws://127.0.0.1:{PORT} (+ http://127.0.0.1:{PORT}/health)")
    await asyncio.Future()

if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: log("shutdown")



