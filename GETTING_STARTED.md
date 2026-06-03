# 🚀 Getting Started with OpenWA

Welcome to **OpenWA**, a free, open-source, self-hosted WhatsApp API Gateway. This guide will walk you through setting up OpenWA from scratch, authenticating your API requests, connecting your WhatsApp account, and sending your first message.

---

## 📋 Table of Contents
1. [Prerequisites](#-prerequisites)
2. [Setup Options](#%EF%B8%8F-setup-options)
   - [Option A: Docker Compose (Recommended)](#option-a-docker-compose-recommended)
   - [Option B: Local Node.js Development](#option-b-local-nodejs-development)
3. [🔑 Authenticating Your Requests](#-authenticating-your-requests)
4. [📱 Connecting a WhatsApp Session](#-connecting-a-whatsapp-session)
5. [✉️ Sending Messages](#%EF%B8%8F-sending-messages)
6. [🔗 Setting Up Webhooks (Real-Time Events)](#-setting-up-webhooks-real-time-events)
7. [📖 Interactive API Reference (Swagger)](#-interactive-api-reference-swagger)
8. [⚠️ Tips & Best Practices](#%EF%B8%8F-tips--best-practices)

---

## 🛠 Prerequisites

Ensure you have the following installed on your system:
- **Node.js** (v20 LTS or v22 LTS recommended)
- **npm** (v10+)
- **Docker & Docker Compose** (Optional, but highly recommended for containerized setup)
- A smartphone with **WhatsApp** installed and an active internet connection.

---

## ⚙️ Setup Options

Choose one of the two setup paths below to get OpenWA up and running.

### Option A: Docker Compose (Recommended)

Docker handles all system dependencies (such as Chrome/Puppeteer libraries) automatically.

1. **Clone the repository:**
   ```bash
   git clone https://github.com/rmyndharis/OpenWA.git
   cd OpenWA
   ```

2. **Start the stack in development/minimal mode:**
   This starts the OpenWA API gateway (with SQLite) and the Web Dashboard.
   ```bash
   docker compose -f docker-compose.dev.yml up -d
   ```
   *Note: For a full-scale production setup with PostgreSQL, Redis, and Traefik proxy, refer to the [Production Deployment section in README.md](./README.md#-production-deployment).*

3. **Verify the services are running:**
   - **Web Dashboard:** [http://localhost:2886](http://localhost:2886)
   - **REST API:** [http://localhost:2785/api](http://localhost:2785/api)
   - **API Documentation (Swagger):** [http://localhost:2785/api/docs](http://localhost:2785/api/docs)

---

### Option B: Local Node.js Development

If you prefer to run OpenWA directly on your machine:

1. **Clone the repository and install dependencies:**
   Running `npm install` automatically installs the backend dependencies and triggers the dashboard's installation step.
   ```bash
   git clone https://github.com/rmyndharis/OpenWA.git
   cd OpenWA
   npm install
   ```

2. **Configure Environment Variables:**
   For a quick start, copy the minimal SQLite configuration template:
   ```bash
   cp .env.minimal .env
   ```
   *(On Windows PowerShell: `copy .env.minimal .env`)*

3. **Create necessary directories for runtime data:**
   ```bash
   mkdir -p data/sessions data/media
   ```
   *(On Windows PowerShell: `New-Item -ItemType Directory -Force -Path data/sessions, data/media`)*

4. **Launch Backend + Web Dashboard:**
   ```bash
   npm run dev
   ```
   This script runs both NestJS API watch mode and Vite React Dashboard simultaneously.

---

## 🔑 Authenticating Your Requests

OpenWA requires API key authentication to keep your WhatsApp gateway secure.

### How to Retrieve Your Seeding API Key
When OpenWA runs for the first time, it automatically generates a default API key.
1. Check the newly created `.api-key` file in the `data` folder:
   ```bash
   cat data/.api-key
   ```
   *(On Windows PowerShell: `Get-Content data/.api-key`)*
2. Save this key. You will need to pass it in the HTTP headers of all API requests:
   ```http
   X-API-Key: <your-retrieved-api-key>
   ```

---

## 📱 Connecting a WhatsApp Session

An active WhatsApp account is represented as a **Session** in OpenWA. You can run multiple sessions simultaneously.

### Step 1: Create a Session
Submit a POST request to register a new session identifier (e.g., `bot-session`).

```bash
curl -X POST http://localhost:2785/api/sessions \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"name": "bot-session"}'
```

### Step 2: Start the Session
Tell OpenWA to launch the underlying headless browser for this session.

```bash
curl -X POST http://localhost:2785/api/sessions/bot-session/start \
  -H "X-API-Key: YOUR_API_KEY"
```

### Step 3: Scan the QR Code
Once the session is started, OpenWA fetches a QR code from WhatsApp.
- **Via Dashboard (easiest):** Open [http://localhost:2886](http://localhost:2886), select your session, and scan the QR code displayed on the screen.
- **Via API:** Retrieve the raw base64 or text QR code by calling:
  ```bash
  curl http://localhost:2785/api/sessions/bot-session/qr \
    -H "X-API-Key: YOUR_API_KEY"
  ```
- **To scan:**
  1. Open **WhatsApp** on your phone.
  2. Tap **Menu** (Android) or **Settings** (iOS).
  3. Select **Linked Devices** > **Link a Device**.
  4. Point your camera at the QR code.

---

## ✉️ Sending Messages

Once your session status is `CONNECTED`, you are ready to send messages.

### Send a Text Message
To send a message, make a POST request with the recipient's `chatId`.

```bash
curl -X POST http://localhost:2785/api/sessions/bot-session/messages/send-text \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "chatId": "1234567890@c.us",
    "text": "Hello! This message is sent from OpenWA Gateway 🚀"
  }'
```

> [!IMPORTANT]
> **Understanding chatIds:**
> - **Individual chats:** Must follow the pattern `{country_code}{phone_number}@c.us`. For example: `15550199@c.us` (US number) or `447700900077@c.us` (UK number).
> - **Group chats:** Must follow the pattern `{group_id}@g.us`.
> - Do not include symbols like `+`, `-`, or spaces in the phone number.

---

## 🔗 Setting Up Webhooks (Real-Time Events)

To receive incoming messages and session updates, configure a webhook URL. OpenWA will POST event payloads to this URL in real-time.

### Register a Webhook for Your Session

```bash
curl -X POST http://localhost:2785/api/sessions/bot-session/webhooks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "url": "https://your-server.com/webhook-receiver",
    "events": ["message.received", "message.sent", "session.status"],
    "secret": "optional-signature-secret-for-hmac"
  }'
```

### Supported Event Types
- `message.received`: Fired whenever a new message is received.
- `message.sent`: Fired when a message is successfully sent from the session.
- `session.status`: Fired when session status changes (`INITIALIZING`, `QR_READY`, `CONNECTED`, `DISCONNECTED`).

---

## 📖 Interactive API Reference (Swagger)

OpenWA has built-in interactive Swagger documentation. When the server is running, visit:
👉 **[http://localhost:2785/api/docs](http://localhost:2785/api/docs)**

From there, you can:
- Explore all available endpoints (Group management, media messaging, labels, contacts, etc.).
- Authenticate and test API requests directly from your browser.
- Inspect JSON request and response schemas.

---

## ⚠️ Tips & Best Practices

1. **Avoid Account Bans:** Do not use newly registered WhatsApp SIM cards for bulk automated outreach. Warm up your numbers gradually, and ensure users are expecting your messages.
2. **Persistence:** Session credentials (cookies and browser state) are persisted in the `data/sessions` folder. Keep this folder secure.
3. **Webhook Security:** Always specify a `secret` when registering webhooks. OpenWA will sign the request body with a `x-openwa-signature` header, allowing your receiver to verify that the request came from your gateway.
4. **Running Headless on Linux Server:** If deploying outside Docker on a Linux VPS, ensure dependencies for Puppeteer (Chromium) are installed:
   ```bash
   sudo apt-get install -y libxss1 libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxtst6 libnss3
   ```
