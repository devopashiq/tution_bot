# Tuition Bot v2

An automated WhatsApp bot that monitors tuition vacancy groups and replies to matching announcements. Includes a **web dashboard** to manage configuration, scan QR codes, and monitor live logs — all from your browser.

> ⚠️ **Disclaimer:** This uses an unofficial WhatsApp library. Use a secondary number. WhatsApp may ban accounts that behave like bots.

---

## How It Works

```
WhatsApp Group Message
        │
        ▼
  Keyword Filter ──── No match ──▶ Ignored
        │
    Match found
        │
        ▼
  Regex Parse -> AI Fallback if Needed
  (Student, Class, Subject, Sessions, Time, Days)
        │
        ▼
  Match Against Your Preferences
  (Subject ✓, Time ✓, Grade ✓, Days ✓)
        │
  All match ◀──── Fail ──▶ Ignored
        │
        ▼
  Send Reply
  (DM / Group / Both)
        │
        ▼
  Notify Yourself (optional)
```

1. The bot watches the WhatsApp groups you configured.
2. Every incoming message is checked against a **keyword filter** (e.g. "tuition", "student", "required").
3. Matching messages are parsed by the existing regex parser. If required fields are missing or the format is ambiguous, an optional AI fallback may extract them.
4. The extracted data is compared against **your preferences** (subject, class time window, minimum grade, available days).
5. If everything matches, the bot automatically **sends a reply** (DM to the poster, group message, or both).
6. You can optionally receive a **self-notification** with the matched vacancy details.

---

## Project Structure

```
tuition-bot-v2/
├── index.js          # Main bot — WhatsApp client + message processing logic
├── aiParser.js       # Optional Groq structured extraction fallback
├── server.js         # Express + WebSocket dashboard server (port 3000)
├── botState.js       # Shared state bridge between bot and dashboard
├── config.js         # Your settings (auto-managed by the dashboard)
├── .env              # Secret credentials — NEVER commit this file!
├── .env.example      # Template — copy to .env and fill in values
├── public/
│   └── index.html    # Web dashboard UI
├── list-groups.js    # Helper: prints all your group IDs
└── debug.js          # Helper: prints raw incoming messages
```

---

## Setup (First Time)

### 1. Install dependencies
```powershell
npm install
```

### 2. Set your dashboard password
```powershell
cp .env.example .env
```
Then open `.env` and set your credentials:
```env
DASHBOARD_USER=admin
DASHBOARD_PASS=your_strong_password_here
```

### 3. Find your WhatsApp Group IDs
```powershell
npm run groups
```
- This will show a QR code in the terminal.
- Scan it with WhatsApp → Linked Devices → Link a Device.
- It will print all your groups with their IDs.
- Copy the ID of the tuition group (looks like `120363411444428684@g.us`).

### 4. Configure the bot
Either edit `config.js` directly, **or** use the web dashboard (recommended — see below).

### Optional AI parsing fallback

Set `GROQ_API_KEY` in `.env` to enable the fallback. `GROQ_MODEL` defaults to `openai/gpt-oss-20b`, and `GROQ_TIMEOUT_MS` defaults to `8000`. If you change the model, choose one that supports Groq strict JSON-schema output. Leave the API key blank to use regex parsing only.

The bot calls Groq only after the keyword filter and only when regex parsing misses required matching fields, finds conflicting/ambiguous fields, or fails to parse an explicitly labeled student, course, or sessions value. For those fallback cases, it passes the current `SUBJECTS`, `MINIMUM_CLASS`, `TIME_WINDOWS`, and `AVAILABLE_DAYS` preferences to Groq and asks for both extracted fields and a match decision with a reason. Posts with multiple day/time pairs are represented as separate schedule slots, and every required slot must fit the configured preferences. A negative AI decision blocks the reply; a positive decision must also pass the existing local preference matcher. Missing or ambiguous required information is rejected. Student, course, and session fields are optional for matching, so their absence alone does not trigger an API call.

When fallback is needed, the WhatsApp message text and the current matching preferences are sent to Groq's Chat Completions API with a fixed extraction instruction and strict response schema. The API key is read from the environment and is never stored in `config.js`.

---

## Running the Bot

### Start everything (bot + web dashboard)
```powershell
npm start
```

This starts:
- The **WhatsApp bot** — begins watching your groups
- The **Web Dashboard** at **http://localhost:3000**

### First run — Link your WhatsApp
1. Open **http://localhost:3000** in your browser
2. Enter your dashboard username and password when prompted
3. Go to the **QR Code** tab
4. A QR code will appear automatically
5. Scan it with WhatsApp on your phone:
   > WhatsApp → ⋮ Menu → Linked Devices → Link a Device
6. Status will change to **Ready ✓** — the bot is now live

> After the first login, the session is saved in `.wwebjs_auth/`. You won't need to scan again unless you disconnect.

---

## Web Dashboard — http://localhost:3000

The dashboard has 4 tabs:

| Tab | What it does |
|-----|-------------|
| **Overview** | Live status, uptime, group count, recent activity, connect/disconnect controls |
| **QR Code** | Displays the QR image to link WhatsApp. Auto-updates when a new QR is generated |
| **Configuration** | Edit all bot settings — groups, reply messages, keywords, preferences, toggles |
| **Logs** | Real-time log stream of every bot event (matches, decisions, errors) |

### Configuration tab features
- **Group IDs** — add/remove groups with a tag input (paste ID + Enter)
- **Reply Mode** — DM only / Group only / Both
- **Reply Messages** — customize what the bot says
- **Toggles** — enable/disable auto reply, self-notify, keyword filter
- **Keywords** — list of words a message must contain to be processed
- **Match Preferences** — subjects, minimum class grade, multiple class time windows, available days
- Click **Save Configuration** — settings are written to `config.js` immediately

---

## Security

The dashboard is protected by **HTTP Basic Auth**. Credentials are set via environment variables — never hardcoded.

### What is protected
- All dashboard pages (`/`) — login required
- All API endpoints (`/api/*`) — login required
- WebSocket connection — verified on upgrade
- Security headers on every response (`X-Frame-Options`, `X-XSS-Protection`, `X-Content-Type-Options`, `Referrer-Policy`)
- Rate limiting — 120 API requests per IP per minute
- Request body limited to 50 KB (prevents large payload attacks)
- Timing-safe credential comparison (prevents timing attacks)

### Setting credentials

**Local development — `.env` file:**
```env
DASHBOARD_USER=admin
DASHBOARD_PASS=MySuperSecretPassword123!
```

**Production — environment variables:**
```bash
export DASHBOARD_USER=admin
export DASHBOARD_PASS=MySuperSecretPassword123!
```

> ⚠️ If `DASHBOARD_PASS` is not set, the server uses the default password `admin` and prints a warning. **Always set a strong password before exposing the dashboard to the internet.**

### Additional recommendations for production
- Run behind **Nginx** as a reverse proxy with **HTTPS/TLS** (see Deployment → Option C)
- Use a **firewall** (`ufw`) to block port 3000 from the public — let Nginx handle traffic
- Never expose port 3000 directly to the internet

---

## Deployment

### Option A — Railway (easiest, free tier available)

1. Push your project to a GitHub repository (`.env` must be in `.gitignore` ✓)
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo
4. In the Railway dashboard → **Variables**, add:
   ```
   DASHBOARD_USER = admin
   DASHBOARD_PASS = your_strong_password
   PORT           = 3000
   ```
5. Railway auto-deploys. Your URL: `https://tuition-bot.up.railway.app`

> ⚠️ **Session warning:** Railway's filesystem is ephemeral — `.wwebjs_auth/` may be wiped on redeploy. Re-scan QR each time. Use Option C for persistent sessions.

---

### Option B — Render (free tier, paid for always-on)

1. Push code to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
5. Under **Environment**, add:
   ```
   DASHBOARD_USER = admin
   DASHBOARD_PASS = your_strong_password
   ```
6. Deploy. URL: `https://tuition-bot.onrender.com`

> Free tier spins down after 15 min of inactivity. Same session persistence warning as Railway.

---

### Option C — VPS (Ubuntu) with PM2 + Nginx + HTTPS ✅ Recommended for 24/7

This gives you **persistent WhatsApp sessions**, full control, and free HTTPS.
Use any provider: DigitalOcean, Hetzner, Linode, Vultr (~$4–6/month).

#### 1. Connect to your server
```bash
ssh root@your_server_ip
```

#### 2. Install Node.js 18+
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

#### 3. Install PM2 (keeps bot alive after terminal closes)
```bash
npm install -g pm2
```

#### 4. Clone and configure the bot
```bash
git clone https://github.com/yourusername/tuition-bot-v2.git
cd tuition-bot-v2
npm install
cp .env.example .env
nano .env        # Set DASHBOARD_USER and DASHBOARD_PASS
```

#### 5. Start with PM2
```bash
pm2 start index.js --name tuition-bot
pm2 save                   # Persist across reboots
pm2 startup                # Follow the printed command to enable auto-start
```

**Useful PM2 commands:**
```bash
pm2 logs tuition-bot       # View live logs
pm2 restart tuition-bot    # Restart
pm2 stop tuition-bot       # Stop
pm2 status                 # Check all processes
```

#### 6. Install and configure Nginx (reverse proxy)
```bash
sudo apt install nginx -y
sudo nano /etc/nginx/sites-available/tuition-bot
```

Paste (replace `yourdomain.com`):
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required for WebSocket (live logs + QR updates)
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tuition-bot /etc/nginx/sites-enabled/
sudo nginx -t                       # Test config
sudo systemctl reload nginx
```

#### 7. Enable HTTPS (free SSL via Let's Encrypt)
```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

Certbot auto-renews every 90 days. Dashboard is live at:
```
https://yourdomain.com
```

#### 8. Lock down the firewall
```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
# Port 3000 is now private — only Nginx can reach it
```

---

### Option D — Windows (always-on with Task Scheduler)

To keep the bot running in the background on Windows after closing the terminal:

**Using Task Scheduler:**
1. Open **Task Scheduler** → **Create Basic Task**
2. Trigger: **When the computer starts**
3. Action: **Start a program**
   - Program: full path to `node.exe` (e.g. `C:\Program Files\nodejs\node.exe`)
   - Arguments: `index.js`
   - Start in: `D:\project\tuition-bot-v2\tuition-bot-v2`
4. Check **"Run whether user is logged on or not"**

**Using NSSM (recommended for Windows service):**
```powershell
# Download NSSM from https://nssm.cc/download
nssm install TuitionBot "C:\Program Files\nodejs\node.exe" "D:\project\tuition-bot-v2\tuition-bot-v2\index.js"
nssm set TuitionBot AppDirectory "D:\project\tuition-bot-v2\tuition-bot-v2"
nssm start TuitionBot
```

---

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the bot + dashboard (use this normally) |
| `npm run groups` | List all your WhatsApp groups and their IDs |
| `npm run debug` | Print raw incoming messages (useful for testing parsing) |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard shows login prompt | Enter the username/password from your `.env` file |
| Forgot dashboard password | Edit `.env`, change `DASHBOARD_PASS`, restart with `npm start` |
| Bot not responding to messages | Check **Logs** tab — look for "keyword filter" or "Decision:" entries |
| QR code not appearing | Restart with `npm start` and check the QR Code tab |
| Authentication expired | Delete `.wwebjs_auth` folder, restart, scan QR again |
| WhatsApp library error | Delete `.wwebjs_cache` folder and restart |
| Dashboard not loading locally | Make sure port 3000 is free; check terminal for errors |
| WebSocket not connecting on VPS | Check Nginx config has `Upgrade` and `Connection` headers set correctly |
| HTTPS certificate error on VPS | Run `sudo certbot renew --dry-run` to test auto-renewal |
| Bot crashes on Railway/Render | Session wiped on redeploy — re-scan QR from the QR Code tab |

---

## Configuration Reference (`config.js`)

| Key | Type | Description |
|-----|------|-------------|
| `GROUP_IDS` | `string[]` | WhatsApp group IDs to monitor |
| `REPLY_MODE` | `'dm'` / `'group'` / `'both'` | Where to send the reply |
| `DM_REPLY` | `string` | Message sent privately to the poster |
| `GROUP_REPLY` | `string` | Message posted in the group |
| `KEYWORDS` | `string[]` | Filter — message must contain one of these |
| `USE_KEYWORD_FILTER` | `boolean` | Enable/disable keyword filtering |
| `NOTIFY_SELF` | `boolean` | Send yourself a copy of matched vacancies |
| `ENABLE_AUTO_REPLY` | `boolean` | `false` = dry run (log only, no messages sent) |
| `SUBJECTS` | `string[]` | Subjects you are willing to teach |
| `MINIMUM_CLASS` | `number` | Minimum grade level to accept |
| `TIME_WINDOWS` | `object[]` | Allowed class time windows, each with `START_MINUTES` and `END_MINUTES` from midnight; an earlier end time means the window crosses midnight |
| `AVAILABLE_DAYS` | `string[]` | Days you are available |

Example with two allowed time windows (4:30–6:00 PM and 7:00–10:00 PM):

```js
"TIME_WINDOWS": [
  { "START_MINUTES": 990, "END_MINUTES": 1080 },
  { "START_MINUTES": 1140, "END_MINUTES": 1320 }
]
```

For an overnight window from 8:00 PM to 9:30 AM the next day, use `{ "START_MINUTES": 1200, "END_MINUTES": 570 }`.

---

## Notes

- **Community announcement groups:** Only admins post, so use `REPLY_MODE: 'dm'` — the bot cannot reply in the group.
- **Dry Run mode:** Set `ENABLE_AUTO_REPLY: false` to test without sending any messages. Decisions will appear in the Logs tab.
- **Session persistence:** Once authenticated, the session is stored in `.wwebjs_auth/` and reused on restart.
- **Never commit `.env`** — it is already in `.gitignore`. Use `.env.example` as a safe template to share.
