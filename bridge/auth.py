import os, json, hmac, hashlib, secrets, pathlib

CONFIG_PATH = pathlib.Path(__file__).parent / "config.json"

def get_or_create_token() -> str:
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text())
            if data.get("token"):
                return data["token"]
        except Exception:
            pass
    token = secrets.token_urlsafe(32)
    CONFIG_PATH.write_text(json.dumps({"token": token}, indent=2))
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except Exception:
        pass
    return token

def verify_token(provided: str, expected: str) -> bool:
    if not provided or not expected:
        return False
    # constant time
    a = hashlib.sha256(provided.encode()).hexdigest()
    b = hashlib.sha256(expected.encode()).hexdigest()
    return hmac.compare_digest(a, b)
