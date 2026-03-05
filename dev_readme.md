# OpenMeet — Developer Guide

## Prerequisites

- **Go 1.21+** — [golang.org/dl](https://golang.org/dl/)
- **MongoDB Atlas** account — [cloud.mongodb.com](https://cloud.mongodb.com) (free tier works)
- **MailHog** — local SMTP catcher for dev email testing

---

## 1. Clone & install dependencies

```bash
git clone https://github.com/shubhamatkal/OpenMeet
cd OpenMeet
go mod download
```

---

## 2. MongoDB Atlas setup

1. Create a free cluster at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Go to **Database Access** → create a user with read/write permissions
3. Go to **Network Access** → add your IP (or `0.0.0.0/0` for dev)
4. Go to **Clusters → Connect → Drivers** → copy the connection string
   ```
   mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

---

## 3. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required — paste your Atlas connection string here
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority

# Change this in production!
JWT_SECRET=any-long-random-string

# Leave as-is for local dev with MailHog
APP_URL=http://localhost:8080
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@openmeet.local

PORT=8080
```

---

## 4. Install & run MailHog

MailHog catches all outgoing emails locally so you can test without a real SMTP server.

```bash
go install github.com/mailhog/MailHog@latest
```

After install, make sure `$(go env GOPATH)/bin` is in your PATH:

```bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$PATH:$(go env GOPATH)/bin"

# Apply immediately
source ~/.bashrc
```

Then run MailHog:

```bash
MailHog
```

| Service | URL |
|---------|-----|
| SMTP listener | `localhost:1025` |
| Web inbox UI  | [localhost:8025](http://localhost:8025) |

> Leave MailHog running in a separate terminal while developing.

---

## 5. Run the server

```bash
go run main.go
```

Open [http://localhost:8080](http://localhost:8080)

---

## Project structure

```
OpenMeet/
├── main.go              # Route wiring + server startup
├── config/
│   └── config.go        # Loads .env into Config struct
├── db/
│   └── mongo.go         # MongoDB Atlas client + Users() collection
├── models/
│   └── user.go          # User struct (bson + json tags)
├── handlers/
│   ├── auth.go          # Auth REST API handlers
│   └── ws.go            # WebSocket signaling handler
├── middleware/
│   └── auth.go          # JWT validation middleware
├── email/
│   └── smtp.go          # Email sending (verify + reset)
└── static/
    ├── index.html        # Vue 3 CDN single-page app
    ├── app.js            # Vue 3 setup() — all client logic
    └── avatars/          # Local profile picture options
        ├── female1.png
        ├── female2.png
        ├── male1.png
        └── male2.png
```

---

## API reference

All API routes are under `/api/auth/`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | — | Create account. Body: `{name, email, password, avatar}` |
| `POST` | `/api/auth/verify-email` | — | Verify email. Body: `{token}` |
| `POST` | `/api/auth/login` | — | Sign in. Body: `{email, password}` → returns `{token, user}` |
| `POST` | `/api/auth/forgot-password` | — | Send reset email. Body: `{email}` |
| `POST` | `/api/auth/reset-password` | — | Set new password. Body: `{token, password}` |
| `GET`  | `/api/auth/me` | Bearer JWT | Return current user |
| `GET`  | `/ws?meetID=X&token=JWT` | JWT query param | WebSocket signaling |

### Avatar values
`avatar` must be one of: `female1.png`, `female2.png`, `male1.png`, `male2.png`

### JWT
- Algorithm: `HS256`
- Expiry: 30 days
- Claim: `sub = userID (hex ObjectID)`
- Send as: `Authorization: Bearer <token>` header

---

## Auth flow (end to end)

```
Register ──► Server saves user (unverified)
         └─► Sends verify email (MailHog captures it)

Verify link ──► GET /verify-email?token=X
            └─► Redirects to /?verify_token=X
            └─► Frontend POSTs /api/auth/verify-email
            └─► Returns JWT + user → auto-login

Login ──► POST /api/auth/login
      └─► Returns JWT + user
      └─► Stored in localStorage as om_token

Forgot password ──► POST /api/auth/forgot-password
                └─► MailHog gets reset email
                └─► Link → /?reset_token=X
                └─► Frontend shows reset form
                └─► POST /api/auth/reset-password → done
```

---

## Meet flow (WebRTC signaling)

```
Host   ──► GET /?meetID=X  (sessionStorage marks as host)
       └─► Connects WS: /ws?meetID=X&token=JWT
       └─► Waits for knock

Guest  ──► GET /?meetID=X  (no host flag)
       └─► Knock screen → "Ask to join"
       └─► Connects WS: /ws?meetID=X&token=JWT
       └─► Sends {type:"knock", name, avatar, id}

Host   ──► Sees knock notification with guest name + avatar
       └─► Clicks Admit → sends {type:"admit"}

Guest  ──► Receives admit → starts camera → creates offer
Host   ──► Receives offer → creates answer → WebRTC handshake
Both   ──► ICE candidates trickle → video connected
```

---

## Common issues

**`MONGODB_URI` not set** → Server exits immediately at startup. Check `.env` exists and has the correct URI.

**MailHog `command not found`** → `$(go env GOPATH)/bin` is not in your PATH. Add `export PATH="$PATH:$(go env GOPATH)/bin"` to your shell rc file.

**Camera permission denied** → Browser blocks camera on non-HTTPS origins other than `localhost`. Always use `http://localhost:8080` in dev, not `127.0.0.1`.

**WebSocket 401** → JWT token missing or expired. Clear `localStorage` in browser devtools and log in again.

**MongoDB duplicate key error on register** → Email already registered. Use a different email or check MailHog for the original verification link.
