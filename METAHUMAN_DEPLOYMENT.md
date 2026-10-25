# Standalone MetaHuman Pixel Streaming Deployment Guide

## 1. Root Cause Analysis

### Why the Website Previously Depended on Unreal Editor Being Open
In Unreal Engine 5.8, your project `MyProject4` has the **PixelStreaming2** plugin enabled (`DefaultEngine.ini` has `EditorStartOnLaunch=True`).
- When Unreal Editor opened the project, the editor module (`PixelStreaming2EditorModule.cpp`) automatically spun up an **in-process embedded C++ HTTP and WebSocket server** listening on:
  - **Port 80**: Served Epic's pre-built WebRTC player HTML/JS frontend and handled browser player WebSocket connections.
  - **Port 8888**: Handled the Unreal Engine streamer WebSocket connection.
- Because this signalling server was embedded inside the **Editor process**, closing Unreal Editor terminated the process, killing both port 80 and port 8888 immediately.
- Standalone packaged executables (or `-game` runtime) do **not** run the Unreal Editor module. Instead, they act strictly as a **Streamer client** that attempts to connect outward to an external Signalling Server at `ws://127.0.0.1:8888`.
- Because no external signalling server was running outside the editor, the website's iframe received connection errors or showed a blank black box as soon as Unreal Editor was closed.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                   STANDALONE UNREAL ENGINE                      │
│   • Packaged Build: MyProject4.exe                               │
│   • Or Standalone Mode: UnrealEditor.exe MyProject4.uproject -game│
│   • Existing MetaHuman character, animations, & Modern House map │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Streamer WebSocket (Port 8888)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│            STANDALONE SIGNALLING SERVER (Python / Wilbur)        │
│   • pixel_streaming/signalling_server.py                         │
│   • Relays WebRTC SDP Offer / Answer & ICE candidates            │
│   • Serves pre-built WebRTC player assets (pixel_streaming/www)  │
│   • Health check endpoint: /api/status                           │
└───────────────────────────────┬──────────────────────────────────┘
                                │ WebRTC Video/Audio & Player WS (Port 80 / 8088)
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│             AI INTERVIEW COACH WEBSITE (Port 5000)               │
│   • Flask app (http://localhost:5000/interview)                  │
│   • Live MetaHuman inside responsive stage with status pill      │
│   • Connecting / Connected / Reconnecting / Offline handling     │
│   • Automatic fallback toggle to SVG Avatar                      │
│   • All interview questions, voice STT, timers, AI preserved     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Quick Start (Local Development)

### Method A: One-Click Startup (No Unreal Editor GUI)
To run your MetaHuman and start streaming immediately without opening the Unreal Editor GUI:

1. Close any running Unreal Editor instances.
2. In the project directory, run:
   ```cmd
   scripts\run_metahuman_standalone.bat
   ```
   *(Or using PowerShell: `powershell -ExecutionPolicy Bypass -File scripts\run_metahuman_standalone.ps1`)*

**What this does automatically:**
- Launches the standalone Signalling Server (`pixel_streaming/signalling_server.py`) on ports 8888 and 80 (or 8088).
- Detects if a packaged build exists at `C:\Users\USER\Desktop\Metahuman_Build\Windows\MyProject4.exe`.
- If packaged, runs the packaged executable directly. If not yet packaged, runs the project in **Standalone Game Mode** (`-game` flag), loading your exact MetaHuman and Modern House room without the Unreal Editor interface.
- Open `http://localhost:5000/interview` in your browser to view your MetaHuman live!

To stop all standalone services, run:
```cmd
scripts\stop_metahuman.bat
```

---

## 4. How to Package the Unreal Engine Project

To produce a completely independent Windows executable that can run on any Windows machine (with or without Unreal Engine installed):

### Automated Packaging via Script:
Run:
```cmd
scripts\package_metahuman.bat
```
This script calls Unreal Automation Tool (`RunUAT.bat`) with:
```cmd
"C:\Program Files\Epic Games\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun ^
  -project="C:\Users\USER\Desktop\Metahuman_Background\MyProject4\MyProject4.uproject" ^
  -noP4 ^
  -platform=Win64 ^
  -clientconfig=Shipping ^
  -cook -build -stage -pak -archive ^
  -archivedirectory="C:\Users\USER\Desktop\Metahuman_Build"
```

### Manual Packaging via Unreal Editor:
1. Open `MyProject4.uproject` in Unreal Editor.
2. Go to **Edit → Project Settings → Maps & Modes**.
   - Ensure **Game Default Map** is set to `/Game/Modern_House_V1/Maps/Demo`.
3. Go to **Edit → Project Settings → Plugins → Pixel Streaming 2**.
   - Ensure Pixel Streaming 2 is enabled.
4. From the top toolbar, select **Platforms → Windows → Package Project**.
5. Select the destination folder (e.g. `C:\Users\USER\Desktop\Metahuman_Build`).
6. Once completed, your executable will be located at:
   `C:\Users\USER\Desktop\Metahuman_Build\Windows\MyProject4.exe`.

---

## 5. Website Configuration & Resilience

### Environment Variables
Configure these in `.env` if using a custom port or remote streaming server:
```ini
# Leave unset or empty for automatic local host resolution (http://<host>:80)
# Or specify a custom port:
PIXEL_STREAMING_PLAYER_PORT=80

# For remote cloud streaming:
METAHUMAN_STREAM_URL=https://stream.yourdomain.com/?AutoConnect=true&AutoPlayAudio=true&HoveringMouse=true
```

### Connection State UI & Graceful Fallback
The interview interface now provides clear user-facing feedback:
- **Connecting**: Animated spinner overlay indicating the WebRTC stream handshake is initializing.
- **Connected / Live**: Top status pill turns green (`● Live Stream`) and the stage chip reflects `MetaHuman Live`.
- **Reconnecting**: Clicking `🔄 Reconnect` re-probes the stream with zero downtime.
- **Offline / Disconnected**: If the standalone application is not running, the stage displays a helpful error message with a **Retry Connection** button and a **Use SVG Avatar Instead** button, guaranteeing the interview can continue even if the 3D stream drops.

---

## 6. Production Cloud Deployment

### 1. Cloud GPU Instance Requirements
For cloud streaming, deploy the packaged Unreal application on a GPU-accelerated server:
- **AWS**: `g4dn.xlarge` (NVIDIA T4) or `g5.xlarge` (NVIDIA A10G).
- **Azure**: `Standard_NV4as_v4` or `Standard_NV6ads_A10_v5`.
- **GCP**: `g2-standard-4` (NVIDIA L4).
- **GPU Driver**: NVIDIA Grid / Studio driver with NVENC support.

### 2. Launching Headless / Off-Screen on Server
Run the packaged build with offscreen rendering so no physical display monitor is required:
```cmd
MyProject4.exe -RenderOffScreen -Windowed -ResX=1280 -ResY=720 -PixelStreaming2.ConnectionURL=ws://127.0.0.1:8888
```

### 3. Networking & Firewall Ports
Configure the firewall/security groups:
- **Port 80 / 443 (TCP)**: Public web access for player frontend.
- **Port 8888 (TCP)**: Bind **only to 127.0.0.1** (internal loopback) so external users cannot hijack the Unreal Engine streamer connection.
- **Ports 10000–20000 (UDP)**: WebRTC media traffic (RTP/RTCP).

### 4. STUN & TURN Server Setup
To allow clients behind symmetric NAT or corporate firewalls to connect:
```cmd
python pixel_streaming\signalling_server.py --player-port 80 --streamer-port 8888 --stun stun.l.google.com:19302 --turn turn.yourdomain.com:3478 --turn-user user --turn-pass pass
```

### 5. Nginx HTTPS & WSS Reverse Proxy Example
```nginx
server {
    listen 443 ssl http2;
    server_name stream.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/stream.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stream.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
