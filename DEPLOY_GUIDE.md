# AquaNav Cloud Station — Deployment & Custom Domain Guide

This standalone `AquaNav_Hosting` package is engineered for **Render's Free Tier** (< 120 MB server RAM) and runs real-time AI object detection directly in the user's browser (laptop or smartphone) using **TensorFlow.js + COCO-SSD (`lite_mobilenet_v2`)**.

---

## 1. Project Structure

```text
AquaNav_Hosting/
├── app.py                     # Ultra-lightweight Flask relay (~95 MB RAM)
├── requirements.txt           # flask==3.0.3, flask-cors==4.0.1, gunicorn==22.0.0
├── runtime.txt                # python-3.11.9
├── Procfile                   # Gunicorn gthread entrypoint
├── render.yaml                # Render Blueprint configuration
├── DEPLOY_GUIDE.md            # This guide
├── esp32_cloud_bridge/
│   └── esp32_cloud_bridge.ino # Domain-agnostic ESP32-S3-CAM cloud firmware
├── test_samples/              # Marine Review Gallery sample images (7 scenarios)
└── web_ui/
    ├── index.html             # Ground Station UI + TensorFlow.js CDN loader
    ├── style.css              # Glassmorphic dark theme (desktop & mobile)
    └── app.js                 # Browser Edge-AI (COCO-SSD + 3-frame tracker + spectral surface analysis)
```

---

## 2. Step 1 — Push `AquaNav_Hosting` to GitHub

Open a terminal inside `C:\Users\shiva\OneDrive\Desktop\AquaNav_Hosting`:

```bash
git init
git add .
git commit -m "Initial AquaNav Cloud Hosting release"
git branch -M main
git remote add origin https://github.com/<your-username>/aquanav-hosting.git
git push -u origin main
```

---

## 3. Step 2 — Deploy to Render (Free Tier)

### Option A: Automatic Blueprint (`render.yaml`)
1. Log in to [Render](https://dashboard.render.com/).
2. Click **New +** → **Blueprint**.
3. Select your `aquanav-hosting` GitHub repository.
4. Render automatically reads `render.yaml` (`plan: free`, `healthCheckPath: /health`, `gunicorn --worker-class gthread --workers 1 --threads 4 --bind 0.0.0.0:$PORT app:app`).
5. Click **Apply** and wait ~1–2 minutes for the build to go **Live**.

### Option B: Manual Web Service
1. Click **New +** → **Web Service** and connect your GitHub repository.
2. Configure:
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn --worker-class gthread --workers 1 --threads 4 --bind 0.0.0.0:$PORT app:app`
   - **Health Check Path:** `/health`
   - **Instance Type:** Free

Your cloud Ground Station will be live at `https://<your-service>.onrender.com`.

---

## 4. Step 3 — Connect Any Custom Domain (`.in`, `.com`, `.tech`, `.me`)

You can attach any custom domain (e.g., `aquanav.in`, `app.aquanav.tech`, `aquanav.me`, or `aquanav.com`):

1. In your Render service dashboard, go to **Settings** → **Custom Domains** → **Add Custom Domain**.
2. Enter your domain (e.g., `www.aquanav.in` or `aquanav.tech`).
3. Log in to your DNS registrar (Namecheap, GoDaddy, Hostinger, Cloudflare, Porkbun, etc.) and add the DNS records shown by Render:
   - **For a subdomain (`www.aquanav.in`, `station.aquanav.tech`, etc.):**
     - **Type:** `CNAME`
     - **Host / Name:** `www` (or `station`)
     - **Value / Target:** `<your-service>.onrender.com`
   - **For an apex / root domain (`aquanav.in`, `aquanav.com`, `aquanav.me`):**
     - **Type:** `A` (using the Render static IP shown in Custom Domains) **or** `ALIAS` / `ANAME` / Cloudflare flattened `CNAME` pointing to `<your-service>.onrender.com`.
4. Return to Render and click **Verify**. Render automatically provisions a free Let's Encrypt **TLS/SSL certificate** (`https://`) within a few minutes.

> **Note:** CORS (`Access-Control-Allow-Origin: *`) is enabled on all `/api/*` endpoints, so you can even host the frontend on one domain and point it to another via the ⚙️ Settings modal.

---

## 5. Step 4 — Flash & Configure the ESP32-S3-CAM Firmware

1. Open `esp32_cloud_bridge/esp32_cloud_bridge.ino` in **Arduino IDE** (select **ESP32S3 Dev Module**, PSRAM: **OPI PSRAM**).
2. Flash the firmware to your GOOUUU ESP32-S3-CAM over USB.
3. Open **Serial Monitor** at `115200` baud — you can update your cloud domain or Wi-Fi **without recompiling**:
   ```text
   SET_URL:https://www.aquanav.in
   SET_WIFI:YourHotspotName,YourPassword
   GET_CONFIG
   ```
   Settings are saved permanently in ESP32 NVS Flash (`Preferences`).

---

## 6. Local Verification

```bash
pip install -r requirements.txt
python app.py
```
Open `http://localhost:5000` in Chrome, Edge, or any mobile browser on the same Wi-Fi.

