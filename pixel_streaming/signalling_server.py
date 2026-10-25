"""
signalling_server.py — Standalone Pixel Streaming 2 Signalling Server
=====================================================================
A lightweight, zero-dependency (using Python + websockets) Signalling Server
designed specifically for Unreal Engine 5.8 PixelStreaming2.

It replaces the embedded Editor signalling server so the packaged Unreal
Engine MetaHuman application can stream to the AI Interview Coach website
without needing Unreal Editor to remain open.

Features:
- Streamer WebSocket Server (default port: 8888)
- Player Web Server + WebSocket Server (default port: 80, fallback: 8088)
- Static file serving for Epic's pre-built WebRTC player (player.html, player.js)
- Automatic protocol negotiation (config, identify, subscribe, SDP offer/answer, ICE)
- Diagnostics / Health JSON endpoint (/api/status)
- Configurable STUN/TURN servers for production NAT traversal
"""

import os
import sys
import json
import uuid
import mimetypes
import logging
import argparse
import asyncio
from pathlib import Path

try:
    import websockets
    from websockets.asyncio.server import serve as ws_serve, Response
    from websockets.datastructures import Headers
except ImportError:
    print("Error: 'websockets' library is required. Install via: pip install websockets")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [SignallingServer] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("PixelStreamingSignalling")

# Map MIME types
mimetypes.init()
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/x-icon", ".ico")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("image/svg+xml", ".svg")


class SignallingServer:
    def __init__(self, streamer_port=8888, player_port=80, http_root=None, peer_options=None):
        self.streamer_port = streamer_port
        self.player_port = player_port
        self.http_root = Path(http_root).resolve() if http_root else self._find_http_root()
        self.peer_options = peer_options or {}

        # Streamers: { streamer_id: WebSocketConnection }
        self.streamers = {}
        # Players: { player_id: { "ws": WebSocketConnection, "streamer_id": str } }
        self.players = {}

        logger.info("Serving WebRTC player frontend from: %s", self.http_root)

    def _find_http_root(self):
        # 1. Local copy in pixel_streaming/www
        local = Path(__file__).parent / "www"
        if local.exists() and (local / "player.html").exists():
            return local
        # 2. Project relative
        proj = Path(__file__).parent.parent / "pixel_streaming" / "www"
        if proj.exists() and (proj / "player.html").exists():
            return proj
        # 3. UE 5.8 installation
        ue_path = Path("C:/Program Files/Epic Games/UE_5.8/Engine/Plugins/Media/PixelStreaming2/Resources/WebServers/SignallingWebServer/www")
        if ue_path.exists():
            return ue_path
        return local

    def get_peer_config(self):
        return {
            "type": "config",
            "protocolVersion": "1.1.0",
            "peerConnectionOptions": self.peer_options
        }

    # =========================================================================
    # HTTP REQUEST HANDLER (Serves Player Web Page, JS, CSS, Assets)
    # =========================================================================
    def handle_http_request(self, connection, request):
        # Allow WebSocket upgrade to proceed normally
        upgrade = request.headers.get("Upgrade", "")
        if upgrade.lower() == "websocket":
            return None

        path = request.path.split("?")[0]
        if path == "/" or path == "":
            path = "/player.html"

        # Health / status endpoint
        if path == "/api/status" or path == "/health":
            body = json.dumps({
                "status": "online",
                "streamers": list(self.streamers.keys()),
                "players_count": len(self.players),
                "http_root": str(self.http_root),
                "streamer_port": self.streamer_port,
                "player_port": self.player_port,
            }, indent=2).encode("utf-8")
            headers = Headers([
                ("Content-Type", "application/json"),
                ("Access-Control-Allow-Origin", "*"),
                ("Cache-Control", "no-cache"),
            ])
            return Response(200, "OK", headers, body)

        # Static file resolution
        rel_path = path.lstrip("/")
        target_file = (self.http_root / rel_path).resolve()

        # Prevent directory traversal
        try:
            target_file.relative_to(self.http_root)
        except ValueError:
            return Response(403, "Forbidden", Headers([("Content-Type", "text/plain")]), b"Forbidden")

        if target_file.is_file():
            mime_type, _ = mimetypes.guess_type(str(target_file))
            if not mime_type:
                mime_type = "application/octet-stream"

            try:
                with open(target_file, "rb") as f:
                    content = f.read()

                headers = Headers([
                    ("Content-Type", mime_type),
                    ("Access-Control-Allow-Origin", "*"),
                    ("Content-Length", str(len(content))),
                ])
                return Response(200, "OK", headers, content)
            except Exception as e:
                logger.error("Error reading file %s: %s", target_file, e)
                return Response(500, "Internal Server Error", Headers(), b"Internal Server Error")

        # 404 Not Found
        not_found_body = f"404 Not Found: {path}\n".encode("utf-8")
        return Response(404, "Not Found", Headers([("Content-Type", "text/plain")]), not_found_body)

    # =========================================================================
    # STREAMER HANDLER (Unreal Engine connects here: ws://127.0.0.1:8888)
    # =========================================================================
    async def handle_streamer(self, ws):
        streamer_id = None
        remote = ws.remote_address
        logger.info("[Streamer] Connected from %s", remote)

        try:
            # Send initial config and identify request
            await ws.send(json.dumps(self.get_peer_config()))
            await ws.send(json.dumps({"type": "identify"}))

            async for raw_message in ws:
                try:
                    msg = json.parse(raw_message) if isinstance(raw_message, dict) else json.loads(raw_message)
                except Exception:
                    logger.warning("[Streamer] Received non-JSON message: %s", raw_message[:100])
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "endpointId":
                    streamer_id = msg.get("id", "DefaultStreamer") or "DefaultStreamer"
                    self.streamers[streamer_id] = ws
                    logger.info("[Streamer] Registered ID: '%s'", streamer_id)
                    # Confirm endpoint ID
                    await ws.send(json.dumps({
                        "type": "endpointIdConfirm",
                        "committedId": streamer_id
                    }))

                elif msg_type == "ping":
                    await ws.send(json.dumps({"type": "pong", "time": msg.get("time")}))

                elif msg_type in ("offer", "answer", "iceCandidate"):
                    # Forward to the target player
                    target_player_id = msg.get("playerId")
                    if target_player_id and target_player_id in self.players:
                        player_ws = self.players[target_player_id]["ws"]
                        await player_ws.send(json.dumps(msg))
                    else:
                        logger.debug("[Streamer] Message '%s' dropped — player '%s' not found", msg_type, target_player_id)

                elif msg_type == "disconnectPlayer":
                    target_player_id = msg.get("playerId")
                    if target_player_id and target_player_id in self.players:
                        player_ws = self.players[target_player_id]["ws"]
                        await player_ws.close(1000, msg.get("reason", "Streamer requested disconnect"))

                else:
                    logger.debug("[Streamer] Unhandled message type: %s", msg_type)

        except websockets.exceptions.ConnectionClosed:
            logger.info("[Streamer] Disconnected: '%s'", streamer_id or remote)
        except Exception as e:
            logger.error("[Streamer] Error on streamer connection: %s", e)
        finally:
            if streamer_id and streamer_id in self.streamers:
                del self.streamers[streamer_id]
                logger.info("[Streamer] Removed streamer '%s'", streamer_id)

    # =========================================================================
    # PLAYER HANDLER (Web Browser / player.js connects here)
    # =========================================================================
    async def handle_player(self, ws):
        player_id = str(uuid.uuid4())[:8]
        remote = ws.remote_address
        self.players[player_id] = {"ws": ws, "streamer_id": None}
        logger.info("[Player] Connected (ID: %s, Remote: %s)", player_id, remote)

        try:
            # Send initial config to player
            await ws.send(json.dumps(self.get_peer_config()))

            async for raw_message in ws:
                try:
                    msg = json.loads(raw_message)
                except Exception:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "listStreamers":
                    ids = list(self.streamers.keys())
                    await ws.send(json.dumps({
                        "type": "streamerList",
                        "ids": ids
                    }))

                elif msg_type == "subscribe":
                    target_streamer_id = msg.get("streamerId")
                    # If not specified or not found, pick first available streamer
                    if not target_streamer_id or target_streamer_id not in self.streamers:
                        if self.streamers:
                            target_streamer_id = list(self.streamers.keys())[0]

                    if target_streamer_id and target_streamer_id in self.streamers:
                        self.players[player_id]["streamer_id"] = target_streamer_id
                        streamer_ws = self.streamers[target_streamer_id]
                        logger.info("[Player %s] Subscribed to streamer '%s'", player_id, target_streamer_id)
                        # Notify streamer that a player has subscribed
                        await streamer_ws.send(json.dumps({
                            "type": "playerConnected",
                            "playerId": player_id,
                            "dataChannel": True,
                            "sfu": False
                        }))
                    else:
                        await ws.send(json.dumps({
                            "type": "subscribeFailed",
                            "message": "No active Unreal Engine streamer connected yet."
                        }))

                elif msg_type == "unsubscribe":
                    cur_streamer = self.players[player_id]["streamer_id"]
                    if cur_streamer and cur_streamer in self.streamers:
                        await self.streamers[cur_streamer].send(json.dumps({
                            "type": "playerDisconnected",
                            "playerId": player_id
                        }))
                    self.players[player_id]["streamer_id"] = None

                elif msg_type == "ping":
                    await ws.send(json.dumps({"type": "pong", "time": msg.get("time")}))

                elif msg_type in ("offer", "answer", "iceCandidate", "dataChannelRequest", "peerDataChannelsReady"):
                    cur_streamer = self.players[player_id]["streamer_id"]
                    if not cur_streamer and self.streamers:
                        cur_streamer = list(self.streamers.keys())[0]
                        self.players[player_id]["streamer_id"] = cur_streamer

                    if cur_streamer and cur_streamer in self.streamers:
                        msg["playerId"] = player_id
                        await self.streamers[cur_streamer].send(json.dumps(msg))
                    else:
                        logger.warning("[Player %s] Cannot forward '%s' — no streamer active", player_id, msg_type)

        except websockets.exceptions.ConnectionClosed:
            logger.info("[Player %s] Disconnected", player_id)
        except Exception as e:
            logger.error("[Player %s] Error: %s", player_id, e)
        finally:
            cur_streamer = self.players.get(player_id, {}).get("streamer_id")
            if cur_streamer and cur_streamer in self.streamers:
                try:
                    await self.streamers[cur_streamer].send(json.dumps({
                        "type": "playerDisconnected",
                        "playerId": player_id
                    }))
                except Exception:
                    pass
            if player_id in self.players:
                del self.players[player_id]

    async def start(self):
        # 1. Start Streamer WebSocket server (port 8888)
        streamer_server = await ws_serve(
            self.handle_streamer,
            "0.0.0.0",
            self.streamer_port,
        )
        logger.info("Streamer server listening on ws://0.0.0.0:%d", self.streamer_port)

        # 2. Start Player HTTP + WebSocket server (port 80 or user specified)
        try:
            player_server = await ws_serve(
                self.handle_player,
                "0.0.0.0",
                self.player_port,
                process_request=self.handle_http_request,
            )
            logger.info("Player server listening on http://0.0.0.0:%d (WebRTC Player & WS)", self.player_port)
        except OSError as e:
            if self.player_port == 80:
                logger.warning("Port 80 requires Administrator or is in use (%s). Falling back to port 8088...", e)
                self.player_port = 8088
                player_server = await ws_serve(
                    self.handle_player,
                    "0.0.0.0",
                    self.player_port,
                    process_request=self.handle_http_request,
                )
                logger.info("Player server listening on http://0.0.0.0:%d (WebRTC Player & WS)", self.player_port)
            else:
                raise

        print("\n" + "=" * 70)
        print("  PIXEL STREAMING SIGNALLING SERVER IS RUNNING")
        print(f"  • Unreal Engine Streamer endpoint: ws://127.0.0.1:{self.streamer_port}")
        print(f"  • WebRTC Player Browser URL:       http://127.0.0.1:{self.player_port}")
        print(f"  • Status / Health Check:           http://127.0.0.1:{self.player_port}/api/status")
        print("=" * 70 + "\n")

        # Keep server running forever
        await asyncio.Event().wait()


def main():
    parser = argparse.ArgumentParser(description="Standalone Pixel Streaming Signalling Server for Unreal Engine 5.8")
    parser.add_argument("--streamer-port", type=int, default=8888, help="Port for Unreal Engine streamer (default: 8888)")
    parser.add_argument("--player-port", type=int, default=80, help="Port for browser player HTTP & WebSocket (default: 80, fallback 8088)")
    parser.add_argument("--http-root", type=str, default=None, help="Directory containing player.html & player.js")
    parser.add_argument("--stun", type=str, default="stun.l.google.com:19302", help="STUN server hostname:port")
    parser.add_argument("--turn", type=str, default=None, help="TURN server hostname:port")
    parser.add_argument("--turn-user", type=str, default=None, help="TURN username")
    parser.add_argument("--turn-pass", type=str, default=None, help="TURN credential")

    args = parser.parse_args()

    peer_options = {}
    ice_servers = []
    if args.stun:
        ice_servers.append({"urls": [f"stun:{args.stun}"]})
    if args.turn:
        turn_entry = {"urls": [f"turn:{args.turn}"]}
        if args.turn_user:
            turn_entry["username"] = args.turn_user
        if args.turn_pass:
            turn_entry["credential"] = args.turn_pass
        ice_servers.append(turn_entry)

    if ice_servers:
        peer_options["iceServers"] = ice_servers

    server = SignallingServer(
        streamer_port=args.streamer_port,
        player_port=args.player_port,
        http_root=args.http_root,
        peer_options=peer_options,
    )

    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        logger.info("Signalling Server stopped by user.")


if __name__ == "__main__":
    main()
