# tests/test_queue.py - embedded Studio queue (:3001) round-trips.
#   python3 tests/test_queue.py
# Covers: HTTP shapes the Studio plugin needs (/health, /queue/next,
# /queue/result, /metrics), safe_call routing through the queue with a
# simulated plugin poll, alias canonicalization, and the plugin_offline
# path when no plugin is polling. No Studio, no Node required.
import sys, os, json, time, threading, unittest
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

os.environ["ROLINK_QUEUE_PORT"] = "18081"
sys.path.insert(0, ROOT)
import bridge

BASE = "http://127.0.0.1:18081"


def http(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, json.loads(r.read().decode())


def mark_polled():
    bridge._queue_last_poll[0] = time.time()


class QueueTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert bridge.QUEUE_PORT == 18081, bridge.QUEUE_PORT
        assert bridge.start_queue_server() is True
        assert bridge._queue_server_on[0] is True
        mgr = bridge.MCPManager()
        mgr.load_config()
        bridge.mgr = mgr  # servers never started: StudioMCP path stays mcp_offline

    def test_health(self):
        code, body = http("GET", "/health")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["tools"], 113)

    def test_next_empty_then_result_flow(self):
        code, body = http("GET", "/queue/next?projectId=default")
        self.assertEqual(code, 200)
        self.assertIsNone(body["command"])
        cid = bridge.queue_enqueue("get_instances", "get_instances", {"path": "workspace"})
        code, body = http("GET", "/queue/next?projectId=default")
        cmd = body["command"]
        self.assertEqual(cmd["id"], cid)
        self.assertEqual(cmd["tool"], "get_instances")
        code, body = http("POST", "/queue/result",
                          {"id": cid, "result": {"found": ["workspace"]}, "error": None})
        self.assertTrue(body["ok"])
        res, err = bridge.queue_wait(cid, 5)
        self.assertIsNone(err)
        self.assertEqual(res, {"found": ["workspace"]})

    def test_metrics_sink(self):
        code, body = http("POST", "/metrics", {"projectId": "default"})
        self.assertTrue(body["ok"])

    def test_safe_call_via_simulated_plugin(self):
        mark_polled()
        out = {}

        def run():
            out["res"] = bridge.safe_call("create_instance",
                                          {"className": "Part", "parent": "workspace"}, 10)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        deadline = time.time() + 8
        cmd = None
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == "create_instance":
                cmd = body["command"]
                break
            time.sleep(0.1)
        self.assertIsNotNone(cmd, "safe_call never enqueued")
        http("POST", "/queue/result", {"id": cmd["id"], "result": {"created": "workspace/Part"}})
        t.join(timeout=8)
        self.assertTrue(out["res"]["ok"], out["res"])
        self.assertIn("workspace/Part", out["res"]["text"])

    def test_alias_routes_to_queue(self):
        mark_polled()
        out = {}

        def run():
            out["res"] = bridge.safe_call("search_game_tree", {"query": "x"}, 10)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        deadline = time.time() + 8
        cmd = None
        while time.time() < deadline:
            _, body = http("GET", "/queue/next?projectId=default")
            if body["command"] and body["command"]["tool"] == "get_instances":
                cmd = body["command"]
                break
            time.sleep(0.1)
        self.assertIsNotNone(cmd, "alias did not canonicalize to get_instances")
        http("POST", "/queue/result", {"id": cmd["id"], "result": {"found": []}})
        t.join(timeout=8)
        self.assertTrue(out["res"]["ok"], out["res"])

    def test_plugin_never_polled_falls_through(self):
        # No plugin ever seen: degrade to the StudioMCP path (mcp_offline
        # here since no server was started), never burn a queue timeout.
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("create_instance", {"className": "Part"}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "mcp_offline")

    def test_queue_server_disabled(self):
        bridge._queue_server_on[0] = False
        try:
            bridge._queue_last_poll[0] = time.time()
            res = bridge.safe_call("create_instance", {"className": "Part"}, 5)
            self.assertFalse(res["ok"])
            self.assertEqual(res["kind"], "plugin_offline")
        finally:
            bridge._queue_server_on[0] = True

    def test_queue_wait_timeout_is_plugin_offline(self):
        # Plugin was seen, but nothing completes the command: short timeout
        # must surface plugin_offline (with install guidance), not a hang.
        bridge._queue_last_poll[0] = time.time()
        res = bridge.safe_call("get_instances", {"path": "workspace"}, 0.3)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "plugin_offline")

    def test_original_name_kept_for_studiomcp(self):
        # list_commands must NOT be rewritten: with no plugin and no MCP up,
        # it falls through to the StudioMCP path (mcp_offline), proving the
        # original spelling survived alias handling.
        bridge._queue_last_poll[0] = 0.0
        bridge._queue_last_poll[0] = 0.0
        res = bridge.safe_call("list_commands", {}, 5)
        self.assertFalse(res["ok"])
        self.assertEqual(res["kind"], "mcp_offline")


if __name__ == "__main__":
    unittest.main(verbosity=1)
