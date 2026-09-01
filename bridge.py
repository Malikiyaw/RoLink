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
    try:
        from websockets.asyncio.server import serve
    except ImportError:
        from websockets.server import serve
except ImportError:
    print("[RoLink] missing websockets — run: pip install websockets", file=sys.stderr)
    sys.exit(1)

BRIDGE_VERSION = "1.1.5"
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
            mid = msg.get("id") or str(int(time.time()*1000))
            mtype = msg.get("type") or msg.get("method") or msg.get("tool")

            # ── legacy ping/heartbeat ──
            if mtype in ("heartbeat","ping"):
                await ws.send(json.dumps({"id":mid,"type":"pong","ok":True}))
                continue

            # ── list_tools: aggregate tools across every MCP server ──
            if mtype == "list_tools":
                ensure_servers()
                all_tools=[]
                alive_servers=[]
                for name, client in servers.items():
                    try:
                        client.ensure()
                        res = await asyncio.to_thread(client.call, {"jsonrpc":"2.0","id":mid,"method":"tools/list","params":{}}, 10)
                        if isinstance(res, dict) and "result" in res:
                            tools = res["result"].get("tools",[]) if isinstance(res["result"], dict) else []
                            for t in tools:
                                nm = t.get("name") if isinstance(t, dict) else str(t)
                                all_tools.append({"name":f"{name}/{nm}","server":name,"base":nm,"description":t.get("description","") if isinstance(t, dict) else ""})
                        alive_servers.append({"id":name,"alive":True,"tools":len(all_tools)})
                    except Exception as e:
                        alive_servers.append({"id":name,"alive":False,"tools":0,"error":str(e)[:120]})
                await ws.send(json.dumps({"id":mid,"type":"tools","ok":True,"tools":all_tools,"servers":alive_servers,"mcp_alive":len([s for s in alive_servers if s["alive"]])>0}))
                continue

            # ── call_tool: route to the right server by tool name ──
            if mtype == "call_tool":
                ensure_servers()
                tname = msg.get("name") or ""
                args = msg.get("arguments") or {}
                timeout = int(msg.get("timeout") or 120000) / 1000.0
                # tname may be "server/tool" or just "tool"
                if "/" in tname:
                    sname, bname = tname.split("/",1)
                else:
                    sname = None; bname = tname
                # try specified server first, then any
                order = []
                if sname and sname in servers: order.append(sname)
                for n in servers:
                    if n not in order: order.append(n)
                last_err=None
                for sn in order:
                    if not bname: break
                    client = servers[sn]
                    try:
                        client.ensure()
                        res = await asyncio.to_thread(client.call, {"jsonrpc":"2.0","id":mid,"method":"tools/call","params":{"name":bname,"arguments":args}}, max(5, int(timeout)))
                        await ws.send(json.dumps({"id":mid,"type":"tool_result","ok":True,"text":str(res)[:200000],"server":sn}))
                        break
                    except Exception as e:
                        last_err=str(e); continue
                else:
                    await ws.send(json.dumps({"id":mid,"type":"tool_result","ok":False,"error":last_err or "no MCP server handled this tool"}))
                continue

            # ── restart_mcp: kill + respawn all configured servers ──
            if mtype == "restart_mcp":
                for c in list(servers.values()):
                    try: c.stop()
                    except: pass
                servers.clear()
                ensure_servers()
                await ws.send(json.dumps({"id":mid,"type":"mcp_status","ok":True,"alive":len(servers)>0,"servers":list(servers.keys())}))
                continue

            # ── add_server ──
            if mtype == "add_server":
                cfg = load_config()
                cfg.setdefault("mcpServers",{})[msg["server_id"]] = {"command":msg["command"],"args":msg.get("args",[])}
                if msg.get("env"): cfg["mcpServers"][msg["server_id"]]["env"]=msg["env"]
                tmp = CONFIG_PATH.with_suffix(".tmp")
                tmp.write_text(json.dumps(cfg,indent=2),encoding="utf-8")
                tmp.replace(CONFIG_PATH)
                ensure_servers()
                await ws.send(json.dumps({"id":mid,"type":"server_changed","ok":True}))
                continue

            # ── remove_server ──
            if mtype == "remove_server":
                cfg = load_config()
                cfg.get("mcpServers",{}).pop(msg.get("server_id"), None)
                tmp = CONFIG_PATH.with_suffix(".tmp")
                tmp.write_text(json.dumps(cfg,indent=2),encoding="utf-8")
                tmp.replace(CONFIG_PATH)
                if msg.get("server_id") in servers:
                    try: servers[msg["server_id"]].stop()
                    except: pass
                    del servers[msg["server_id"]]
                await ws.send(json.dumps({"id":mid,"type":"server_changed","ok":True}))
                continue

            # ── studio_status: probe Roblox Studio app via tasklist ──
            if mtype == "studio_status":
                studio_app = False
                try:
                    if sys.platform=="win32":
                        out = subprocess.run(["tasklist","/FI","IMAGENAME eq RobloxStudioBeta.exe"], capture_output=True, text=True, timeout=4).stdout
                        studio_app = "RobloxStudioBeta.exe" in out
                    else:
                        out = subprocess.run(["pgrep","-lf","RobloxStudio"], capture_output=True, text=True, timeout=4).stdout
                        studio_app = "RobloxStudio" in out
                except Exception: pass
                # connected = at least one MCP server is alive and has tools
                connected = False
                for c in servers.values():
                    if c.proc and c.proc.poll() is None and c.tools_cache:
                        connected = True; break
                await ws.send(json.dumps({"id":mid,"type":"studio_status","ok":True,"studio":connected,"studio_app":studio_app}))
                continue

            # ── legacy restart self ──
            if mtype == "restart":
                await ws.send(json.dumps({"id":mid,"ok":True,"restarting":True}))
                if sys.platform=="win32":
                    subprocess.run(["taskkill","/F","/T","/PID",str(os.getpid())], capture_output=True)
                os.execv(sys.executable, [sys.executable, __file__])

            # ── legacy tool dispatch (raw MCP / RoLink enqueue style) ──
            ensure_servers()
            for name, client in servers.items():
                try:
                    client.ensure()
                    if "jsonrpc" in msg:
                        res = await asyncio.to_thread(client.call, msg, 30)
                    else:
                        res = await asyncio.to_thread(client.call, {"jsonrpc":"2.0","id":mid,"method":"tools/call","params":{"name": msg.get("tool") or msg.get("method"), "arguments": msg.get("args") or msg.get("params") or {}}}, 30)
                    await ws.send(json.dumps({"id":mid,"result":res}))
                    break
                except Exception as e:
                    log(f"{name} call failed: {e}", "warn")
                    continue
            else:
                # unknown message
                await ws.send(json.dumps({"id":mid,"type":"error","ok":False,"error":f"unknown message: {mtype}"}))
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
    clean = path.split("?")[0] if path else "/"
    if clean in ("/health", "/health/", "/"):
        if request_headers.get("Upgrade", "").lower() != "websocket":
            tools_count = 0
            try:
                for c in servers.values():
                    if c.proc and c.proc.poll() is None: tools_count += max(0, len(c.tools_cache or []))
            except Exception: pass
            body = json.dumps({"ok":True,"version":BRIDGE_VERSION,"bridge":PORT,"clients":len(clients),"servers":list(servers.keys()),"tools":tools_count,"uptime": int(time.time()-start_time)}).encode()
            return (200, [("Content-Type","application/json"),("Access-Control-Allow-Origin","*"),("Content-Length",str(len(body)))], body)
    return None

async def main():
    ensure_servers()
    ws_server = await serve(ws_handler, "127.0.0.1", PORT, max_size=10*1024*1024, process_request=http_ws_process_request)
    log(f"RoLink Bridge {BRIDGE_VERSION} WS ws://127.0.0.1:{PORT} (+ http://127.0.0.1:{PORT}/health)")
    await asyncio.Future()

if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: log("shutdown")



