# RoLink Bridge

WebSocket server `ws://127.0.0.1:17613` + HTTP `/health`.

## Run
```powershell
pip install -r requirements.txt
python server.py
# token auto-created in bridge/config.json (0600)
# connect: ws://127.0.0.1:17613/ws?role=extension&token=<token>
```

Validates `Origin`/`Host` implicitly by binding 127.0.0.1, uses `hmac.compare_digest` on SHA256 of token.
Heartbeat every 20s, max queue forwarded to MCP at http://127.0.0.1:3001
