# คู่มือติดตั้ง VaultLink Bot

คู่มือนี้พาเดินตั้งแต่ "เพิ่งโคลนโปรเจกต์มา" จนถึง "บอท + Mini App รันได้บนเครื่องตัวเอง" และเชื่อม Telegram ของจริง บนเครื่อง Windows ใช้ PowerShell หรือ CMD ก็ได้ คำสั่งทั้งหมดเป็น pnpm + node ล้วน — ถ้าใช้ระบบอื่นแค่เปลี่ยน path separator

> สั้นมากแบบไม่ต้องอ่านยาว: `setup.bat` แล้ว `start.bat` ถ้าตั้งสคริปต์ไว้แล้ว ที่เหลือคือ token + ngrok สำหรับ Mini App

---

## 1. สิ่งที่ต้องมีในเครื่อง

| ของ                    | เวอร์ชัน                         | หมายเหตุ                                                            |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------- |
| Node.js                | >= 20                            | `engines.node: >=20.0.0` ในการ runtime ใช้ `--env-file` ของ Node 20 |
| pnpm                   | 9.12.0 (pin ใน `packageManager`) | `npm install -g pnpm@9.12.0`                                        |
| Git                    | ล่าสุด                           | สำหรับ clone และ pull update                                        |
| ngrok หรือ cloudflared | (เลือกอย่างเดียว)                | ใช้เฉพาะตอนทดสอบ Mini App ใน Telegram จริง                          |

ตรวจว่าครบไหม:

```powershell
node --version       # v20.x ขึ้นไป
pnpm --version       # 9.x.x
```

---

## 2. สร้างบอทกับ BotFather

### 2.1 สร้างบอทใหม่

1. เปิด Telegram → คุยกับ [@BotFather](https://t.me/BotFather)
2. ส่ง `/newbot`
3. ตอบชื่อบอท (display name) เช่น `My VaultLink` — เปลี่ยนภายหลังได้ผ่าน `/setname`
4. ตอบ username (ต้องลงท้าย `bot` หรือ `_bot`) เช่น `my_vaultlink_bot` — **เปลี่ยนไม่ได้** เลือกให้ดี
5. BotFather จะส่ง **token** หน้าตาแบบ `8729457750:AAH...` มาให้ — copy ไปใส่ `MAIN_BOT_TOKEN` ใน `.env`

### 2.2 แต่งหน้าโปรไฟล์บอท

คำสั่งใน BotFather (ส่งทีละบรรทัด):

| คำสั่ง            | ใช้ทำ                                                             |
| ----------------- | ----------------------------------------------------------------- |
| `/setname`        | เปลี่ยนชื่อที่แสดง                                                |
| `/setdescription` | คำอธิบายในหน้าก่อนกด `/start` (ภาพใหญ่ ตัวเทา) — ภาษาไทยได้       |
| `/setabouttext`   | bio สั้นในการ์ดโปรไฟล์ (ที่กดดูใต้ avatar) — สั้นกว่า description |
| `/setuserpic`     | อัปโหลดรูปโปรไฟล์ (square 640x640 ขึ้นไป)                         |
| `/setbotpic`      | alias ของ `/setuserpic`                                           |

ตัวอย่างข้อความที่ผมใช้:

```
/setdescription
VaultLink — เปลี่ยนไฟล์ Telegram เป็นรหัสแชร์ที่ควบคุมเองได้
รหัสรหัสเดียวจะ resolve เป็นไฟล์เดียวหรือชุดสื่อทั้งคอลเลคชัน
ทุกอย่างจัดการในแชท ไม่ต้องเปิด web admin
```

```
/setabouttext
Secure file shares with codes you control.
```

### 2.3 ตั้งค่าพฤติกรรมบอท

| คำสั่ง               | ค่าที่แนะนำสำหรับ VaultLink | เหตุผล                                                                           |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `/setjoingroups`     | `Disable`                   | บอทออกแบบสำหรับ DM ไม่ใช่งานในกลุ่ม                                              |
| `/setprivacy`        | `Enable`                    | ถ้าวันหนึ่งใส่ในกลุ่มจริง บอทจะเห็นแค่ข้อความที่ขึ้นต้นด้วย `/` หรือ reply หาบอท |
| `/setinline`         | (ข้าม)                      | บอทไม่ใช้ inline mode                                                            |
| `/setinlinefeedback` | (ข้าม)                      | ใช้คู่กับ inline                                                                 |

> หลังเปลี่ยน `/setprivacy` ต้อง remove บอทออกจากกลุ่มแล้วเพิ่มกลับเข้าใหม่ค่าจะ apply

### 2.4 รายการคำสั่งใน menu (auto-sync)

**ไม่ต้อง** เรียก `/setcommands` ใน BotFather — บอทรัน `setMyCommands` ให้อัตโนมัติทุกครั้งที่ boot รายการคำสั่งสาธารณะมาจาก `src/bot/commands.ts`:

```
/start    เปิดเมนูหลัก / Open main menu
/help     วิธีใช้งาน / How to use
/new      สร้างรหัสแชร์ / Create a share
/files    ไฟล์ของฉัน / My files
/bots     บอทส่วนตัว / My bots
/settings ตั้งค่า / Settings
/cancel   ยกเลิก / Cancel
```

`/admin` register แบบ chat-scope ให้เฉพาะ user ID ที่อยู่ใน `ADMIN_IDS` — คนอื่นจะไม่เห็นใน menu (แม้พิมพ์เองก็โดน auth ปฏิเสธ)

ถ้าต้องการเปลี่ยนรายการคำสั่งให้แก้ในไฟล์โค้ด ห้ามแก้ใน BotFather — ทุก restart มันจะ overwrite

### 2.5 จัดการ token

- **Revoke token** (กรณี leak): `/mybots` → เลือกบอท → **API Token** → **Revoke current token** — token เก่าจะ 401 ทันที, ของใหม่ออกมาแทน
- **ห้ามเขียน token ลง git** — `.env` อยู่ใน `.gitignore` แล้ว ตรวจอีกทีก่อน push: `git status` ต้องไม่เห็น `.env`
- **Production** ใช้ environment variable ของระบบ deploy (Docker compose `environment:`, systemd `EnvironmentFile=`, etc) ไม่ต้อง mount `.env` ถ้าเลี่ยงได้

### 2.6 ลบบอท / เปลี่ยน owner

| คำสั่ง       | ใช้ตอนไหน                                             |
| ------------ | ----------------------------------------------------- |
| `/deletebot` | ลบบอททิ้งถาวร username จะถูกล็อก 7 วันก่อนใช้ใหม่ได้  |
| `/transfer`  | โอน owner ไปบัญชี Telegram อื่น (ผ่าน BotFather flow) |
| `/cancel`    | ยกเลิก operation BotFather ที่กำลังทำอยู่             |

---

## 3. หา Telegram User ID ของตัวเอง

จำเป็นเพราะคำสั่ง admin (`/admin`, broadcast, ban/unban, lock/unlock) เช็คจาก ID เท่านั้น ไม่เช็ค username

1. คุยกับ [@userinfobot](https://t.me/userinfobot)
2. ส่ง `/start`
3. มันจะตอบ `Id: 125104675` — เลขนี้คือ `ADMIN_IDS`
4. ถ้ามีหลาย admin ใส่คั่นด้วย comma เช่น `ADMIN_IDS=125104675,98765432`

---

## 4. ตั้งค่า `.env`

```powershell
Copy-Item .env.example .env
pnpm generate:key   # คัดลอก output ไปวางใน TOKEN_ENCRYPTION_KEY
```

แก้ `.env` (อย่างน้อย 4 บรรทัด):

```env
NODE_ENV=development
MAIN_BOT_TOKEN=8729457750:AAH...                # token จาก BotFather
TOKEN_ENCRYPTION_KEY=BDjKEnPlV9AKw2HSEnKy0...   # output จาก pnpm generate:key
ADMIN_IDS=125104675                              # user ID ของคุณ
```

ฟิลด์อื่นที่ควรปรับสำหรับ dev:

| ฟิลด์              | ค่าแนะนำ dev                                | เหตุผล                                |
| ------------------ | ------------------------------------------- | ------------------------------------- |
| `LOG_LEVEL`        | `debug`                                     | เห็น log ครบเวลา debug                |
| `ENABLE_MINI_APP`  | `false` (ก่อน), `true` ตอนพร้อมต่อ Mini App | ลด moving parts ตอนทดสอบบอทอย่างเดียว |
| `MAX_FILE_SIZE_MB` | ตามต้องการ                                  | default 50                            |

> ทุกฟิลด์ที่ใส่ผิดประเภท env จะ **fail fast** ตอน boot พร้อมรายงาน redacted ดูได้จาก console — ค่อยๆ แก้ทีละบรรทัด

---

## 5. ติดตั้ง dependencies + migrate ฐานข้อมูล

```powershell
pnpm install
pnpm db:migrate
```

ต้องเห็น `migrations complete` และ list `applied: ["001", "002"]` แสดงว่า DB พร้อม

ถ้าใช้ Mini App ด้วยให้ติดตั้ง deps ของ frontend แยก:

```powershell
Set-Location apps\mini-app
pnpm install
Copy-Item .env.example .env   # ถ้ายังไม่มี
Set-Location ..\..
```

---

## 6. รันบอท

```powershell
pnpm dev
```

ที่ควรเห็น:

```
INFO: starting
INFO: db opened
INFO: main bot started   username: "my_vaultlink_bot"
INFO: child bots started started: 1
```

ทดสอบ: เปิด Telegram → DM บอท → `/start` → ต้องตอบกลับเมนูภาษาไทยพร้อมปุ่ม

ถ้าเปิด `ENABLE_MINI_APP=true` จะมีอีกบรรทัด `mini app api listening on :8081` — แปลว่า API ของ Mini App พร้อม

หยุด: กด `Ctrl+C` ในหน้าต่าง

---

## 7. Mini App: รัน frontend แยก

หน้าต่างใหม่:

```powershell
Set-Location apps\mini-app
pnpm dev
```

จะเห็น `Local: http://localhost:5173/` — เปิดใน browser ดูได้แต่จะติด **OutsideTelegramScreen** เพราะไม่มี `initData` (ปกติ — ตั้งใจให้รัน inside Telegram เท่านั้น)

โครงสร้าง dev:

```
Browser inside Telegram --(HTTPS tunnel)--> Vite :5173 --proxy /api--> Bot API :8081
```

---

## 8. เปิด Mini App ใน Telegram จริง (ngrok)

ต้องมี HTTPS เพราะ Telegram client ปฏิเสธ http URL ใน WebApp

### 8.1 เปิด tunnel

```powershell
ngrok http 5173
```

คัดลอก URL ที่ขึ้นต้นด้วย `https://...ngrok-free.app`

> หรือใช้ cloudflared: `cloudflared tunnel --url http://localhost:5173` — ฟรีไม่ต้องสมัคร

### 8.2 อัปเดต `.env`

แก้ 3 บรรทัดให้ชี้ tunnel URL เดียวกัน (frontend ผ่าน proxy ไปยัง backend ภายในเอง):

```env
ENABLE_MINI_APP=true
MINI_APP_URL=https://abcd-1234.ngrok-free.app
MINI_APP_API_BASE_URL=https://abcd-1234.ngrok-free.app
MINI_APP_ALLOWED_ORIGINS=https://abcd-1234.ngrok-free.app
```

restart `pnpm dev` (config อ่านครั้งเดียวตอน boot)

### 8.3 ตั้ง Menu Button ใน BotFather

ใช้ flow แบบ click-through:

1. `/mybots` → เลือกบอท → **Bot Settings** → **Menu Button** → **Configure Menu Button**
2. ใส่ URL ngrok (เหมือนใน `.env`)
3. ตั้งชื่อปุ่ม เช่น `เปิดแอป` (สูงสุด 14 ตัวอักษร)

หรือใช้คำสั่งตรงๆ:

```
/setmenubutton
```

แล้วเลือกบอท → ตอบ URL → ตอบชื่อปุ่ม

เปิดแชทบอท → ปุ่ม menu (รูป hamburger ☰ ข้างกล่องพิมพ์) จะมีให้กด → เปิด WebApp พร้อม `initData` → API auth ผ่าน ✅

> ngrok free tier มีหน้าเตือน "You are about to visit..." ครั้งแรก กดผ่านได้ ถ้าใช้บ่อยให้สมัคร authtoken หรือเปลี่ยนไปใช้ cloudflared

### 8.4 ทางเลือก: Direct Link Mini App (ลิงก์เปิด WebApp ตรงๆ)

ถ้าอยากมี short link `https://t.me/<bot>/<app>` ที่เปิด Mini App โดยไม่ต้องผ่าน menu button:

1. ใน BotFather ส่ง `/newapp`
2. เลือกบอท
3. ตั้ง title (display ในหน้าเปิด), description, photo, GIF/screenshot (optional)
4. ตอบ short name เช่น `vault` → ลิงก์จะเป็น `https://t.me/<bot>/vault`
5. ใส่ Web App URL เป็น URL ngrok เดียวกัน

จัดการแอปที่ตั้งไว้: `/myapps` → เลือก app → edit / delete

> Direct Link Mini App ไม่จำเป็นถ้าใช้ menu button แต่สะดวกถ้าต้องการแชร์ลิงก์ให้คนอื่นเปิดตรงเข้าแอป

### 8.5 Domain whitelist (ถ้าใช้ Login Widget)

ตอนนี้ VaultLink ไม่ใช้ Telegram Login Widget (auth ผ่าน Mini App initData ล้วน) ส่วน `/setdomain` จึงไม่จำเป็น เก็บไว้อ้างอิงเผื่ออนาคต:

- `/setdomain` → กำหนดโดเมนที่เปิด Login Widget ได้ — ทุก subdomain ของโดเมนนี้ผ่านได้

---

## 9. หยุด / รีเซ็ตฐานข้อมูล

หยุดทุก process ของโปรเจกต์ (ไล่ kill node.exe ที่ command line มี `vaultlinktg`):

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'vaultlinktg' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

ล้าง DB ทั้งหมด (ลบไฟล์ + migrate ใหม่):

```powershell
pnpm db:reset
```

ระวัง: ทำแล้วข้อมูลผู้ใช้/ไฟล์/รหัสแชร์ทั้งหมดหายหมด

---

## 10. แก้ปัญหาที่เจอบ่อย

### `409 Conflict: terminated by other getUpdates request`

มี instance อื่นใช้ token เดียวกัน poll Telegram อยู่ Telegram อนุญาตแค่ 1 ผู้ poll ต่อ token

ตามลำดับ:

1. ปิด `pnpm dev` ที่อาจค้างอยู่หน้าต่างอื่น
2. kill orphan node:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -match 'tsx.*watch' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```
3. ถ้ายัง: เปิด browser ไป `https://api.telegram.org/bot<TOKEN>/close` (เรียกได้ครั้งเดียวต่อ ~10 นาที)
4. ถ้ายังอีก = มีเครื่องอื่น/server ของคุณ poll อยู่ → regen token ใน BotFather เป็นทางลัด token ใหม่ทำให้ตัวเก่า invalid ทันที

### `401 Unauthorized` ตอน boot

`MAIN_BOT_TOKEN` ผิดหรือถูก revoke แล้ว — copy token ใหม่จาก BotFather

### `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`

รันคำสั่ง pnpm นอก root โปรเจกต์ — `cd` กลับเข้าโฟลเดอร์ที่มี `package.json`

### Port 5173 / 8081 ถูกใช้

มี Vite/Bot ค้างจากรอบก่อน หยุดด้วยขั้นตอนข้อ 9 หรือ:

```powershell
Get-NetTCPConnection -LocalPort 5173,8081 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### Vite ขึ้น "Blocked request. This host is not allowed"

Vite 5 บล็อก host ที่ไม่รู้จักโดย default — `apps/mini-app/vite.config.ts` ไวต์ลิสต์ `.ngrok-free.app` `.ngrok.io` `.trycloudflare.com` ไว้แล้ว ถ้าใช้ tunnel โดเมนอื่นให้เพิ่มใน `server.allowedHosts`

### Mini App เปิดมาแต่ API call เป็น 500

ลำดับเช็ค:

1. `curl http://127.0.0.1:8081/healthz` ตอบ `{"status":"ok"}` ไหม → ถ้าไม่ = Bot ไม่ได้รัน หรือ `ENABLE_MINI_APP=false`
2. ดู log Vite ในหน้าต่าง mini-app — ถ้าเขียน `ECONNREFUSED 127.0.0.1:8081` แปลว่า proxy ไปที่ที่ไม่มีคนรับ
3. ดู log Bot — ตรวจว่า "mini app api listening on :8081" ขึ้นไหม

---

## 11. Production (สั้น)

ใช้ Docker:

```powershell
docker compose up -d --build
docker compose logs -f
```

`./data` ถูก mount เป็น volume → DB อยู่ครบหลัง restart container เป็น non-root user หลัง `tini` พร้อม healthcheck

ดูรายละเอียดที่ `README.md` section "Quick start (Docker)"

---

## 12. ภาคผนวก: คำสั่ง pnpm ที่ใช้บ่อย

| คำสั่ง                              | ใช้ตอนไหน                                      |
| ----------------------------------- | ---------------------------------------------- |
| `pnpm dev`                          | รันบอท + Mini App API ในโหมด dev (`tsx watch`) |
| `pnpm db:migrate`                   | apply migration ใหม่                           |
| `pnpm db:reset`                     | drop + re-migrate (ทำลายข้อมูล)                |
| `pnpm generate:key`                 | สร้าง `TOKEN_ENCRYPTION_KEY`                   |
| `pnpm test`                         | รัน vitest                                     |
| `pnpm typecheck`                    | ตรวจ TypeScript ไม่ build                      |
| `pnpm lint`                         | ESLint                                         |
| `pnpm format` / `pnpm format:check` | Prettier autofix / check                       |
| `pnpm build`                        | compile ไป `dist/` (สำหรับ `pnpm start`)       |
| `pnpm start`                        | รันจาก `dist/` (production-style ใน local)     |

ทุกคำสั่งโหลด `.env` ผ่าน `--env-file` ของ Node 20 ยกเว้น `test` (vitest จัดการ env เอง) และ `build` (ไม่ต้องอ่าน env)

---

## 13. ภาคผนวก: BotFather cheat sheet

คำสั่งทั้งหมดที่ใช้กับ [@BotFather](https://t.me/BotFather) เรียงตามวงจรชีวิตบอท

### สร้าง / ลบ

| คำสั่ง       | ผล                                        |
| ------------ | ----------------------------------------- |
| `/newbot`    | สร้างบอทใหม่ ได้ token                    |
| `/mybots`    | list บอทที่ถือไว้ + เมนูจัดการของแต่ละตัว |
| `/deletebot` | ลบบอทถาวร username ล็อก 7 วัน             |
| `/transfer`  | โอน owner ไปบัญชีอื่น                     |
| `/cancel`    | ยกเลิก operation BotFather ที่กำลังทำอยู่ |

### โปรไฟล์

| คำสั่ง            | ผล                                                        |
| ----------------- | --------------------------------------------------------- |
| `/setname`        | เปลี่ยน display name (เปลี่ยนได้ตลอด ไม่เกิน 64 ตัวอักษร) |
| `/setdescription` | คำอธิบายในหน้าก่อน `/start` (สูงสุด 512 ตัวอักษร)         |
| `/setabouttext`   | bio สั้นในการ์ดโปรไฟล์ (สูงสุด 120 ตัวอักษร)              |
| `/setuserpic`     | รูปโปรไฟล์ (square ≥ 640x640)                             |

### พฤติกรรม

| คำสั่ง               | ผล                                                                  | แนะนำสำหรับ VaultLink |
| -------------------- | ------------------------------------------------------------------- | --------------------- |
| `/setjoingroups`     | อนุญาต/ห้ามเพิ่มบอทเข้ากลุ่ม                                        | **Disable**           |
| `/setprivacy`        | ในกลุ่ม บอทเห็นแค่ command/reply (Enable) หรือทุก message (Disable) | **Enable**            |
| `/setinline`         | เปิด inline mode (`@bot query`) + ตั้ง placeholder                  | ปิด                   |
| `/setinlinegeo`      | เปิดส่ง location จาก inline                                         | ปิด                   |
| `/setinlinefeedback` | รับ chosen_inline_result update                                     | ปิด                   |

### คำสั่งใน menu

| คำสั่ง         | ผล                                                                               |
| -------------- | -------------------------------------------------------------------------------- |
| `/setcommands` | ตั้งรายการคำสั่งที่ขึ้นใน menu **— VaultLink sync ให้อัตโนมัติ ไม่ต้องเรียกเอง** |
| `/mycommands`  | ดูรายการคำสั่งปัจจุบัน                                                           |

### Mini App / WebApp

| คำสั่ง           | ผล                                                             |
| ---------------- | -------------------------------------------------------------- |
| `/setmenubutton` | ตั้งปุ่ม WebApp ให้ติดข้างกล่องพิมพ์ — ใส่ HTTPS URL           |
| `/newapp`        | สร้าง Direct Link Mini App (`t.me/<bot>/<short>`)              |
| `/myapps`        | จัดการ Mini App ที่ตั้งไว้ (edit/delete)                       |
| `/editapp`       | แก้ Mini App ที่มีอยู่ (title, description, photo, URL)        |
| `/deleteapp`     | ลบ Mini App                                                    |
| `/setdomain`     | กำหนดโดเมนของ Telegram Login Widget (VaultLink ไม่ใช้ ข้ามได้) |

### Token / payment

| คำสั่ง        | ผล                                                       |
| ------------- | -------------------------------------------------------- |
| `/token`      | ดู token ปัจจุบัน                                        |
| `/revoke`     | revoke token เก่าออก token ใหม่ — token เก่ากลายเป็น 401 |
| `/setpayment` | ผูก payment provider (VaultLink ไม่ใช้)                  |

> ทุกคำสั่งของ BotFather ทำงานแบบ guided — กด/พิมพ์คำสั่ง → BotFather ถามทีละ step คำสั่งเยอะที่สุดที่ต้องจำคือ `/mybots` แล้วกดเมนูเอา

---

## 14. ภาคผนวก: Webhook vs Long polling

VaultLink รัน **long polling** (`getUpdates`) ผ่าน `@grammyjs/runner` ตลอดในทั้ง dev และ Docker — ไม่ใช้ webhook เลย เหตุผล:

- ไม่ต้องเปิด port public, ไม่ต้องมี HTTPS reverse proxy
- รันหลังบ้าน home network ก็ได้
- Single-process model ทำให้ logic ง่าย และ throttle/retry คาดเดาได้

ผลตามมา:

- **บอท 1 token รันได้แค่ 1 instance พร้อมกัน** ถ้ารันสองที่ตัวที่สองจะโดน 409 Conflict (ดูข้อ 10)
- ห้ามใช้ webhook พร้อม polling — ถ้าเคยตั้ง webhook ไว้ต้องลบก่อน:
  ```
  https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=true
  ```

ถ้าวันหนึ่งจะย้ายไป webhook (เช่น deploy บน Cloudflare Workers): ต้องเขียน HTTP handler ใหม่และเรียก `setWebhook` ตอน deploy ข้อมูลและ schema ของ DB ใช้ได้ตามเดิม

---

## 15. ภาคผนวก: Telegram Bot API limits ที่กระทบโปรเจกต์

ค่าทั้งหมดเป็น default ของ Bot API cloud ปรับได้ผ่าน env (ดู section "Telegram API limits" ใน `.env.example`):

| รายการ                                      | Limit            | ตัวแปร env ที่เกี่ยวข้อง                                                  |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| ส่ง message ทั่วโลกจาก bot                  | 30 / วินาที      | `TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC`                                      |
| ส่งใน chat เดียวกัน (DM)                    | 1 / วินาที       | `TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC`                                    |
| ส่งในกลุ่ม / ช่อง                           | 20 / นาที        | `TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN`                                   |
| ความยาว message                             | 4,096 ตัวอักษร   | `TELEGRAM_MESSAGE_MAX_LENGTH`                                             |
| Media group                                 | 10 รายการ        | `TELEGRAM_MEDIA_GROUP_MAX_ITEMS`                                          |
| Inline keyboard                             | สูงสุด 100 ปุ่ม  | `TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS`                                    |
| ขนาดปุ่มต่อแถว                              | 8 ปุ่ม           | `TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH`                                  |
| `callback_data`                             | 64 bytes         | `TELEGRAM_CALLBACK_DATA_MAX_BYTES`                                        |
| Long poll timeout                           | 50 วินาที (≤ 50) | `TELEGRAM_LONG_POLL_TIMEOUT_SECONDS`                                      |
| ขนาดไฟล์ที่ bot **อัปโหลด** ส่งให้ user     | 50 MB            | (ฝั่ง Telegram bound — สูงกว่านี้ต้อง local Bot API server)               |
| ขนาดไฟล์ที่ bot **ดาวน์โหลดผ่าน `getFile`** | 20 MB            | (ของจริงไฟล์ใหญ่กว่านี้ใช้ได้ผ่าน file_id แต่ทำต่อใน bot ไม่ได้)          |
| Auto retry เมื่อโดน 429                     | สูงสุด 5 ครั้ง   | `TELEGRAM_AUTORETRY_MAX_ATTEMPTS`, `TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS` |

`MAX_FILE_SIZE_MB` (default 50) ของโปรเจกต์เป็น cap ที่บอทบังคับอีกชั้น — ถ้าตั้งเกิน Telegram limit จะส่งไม่ได้แม้ผ่าน validation

> ถ้าต้องการ bypass 50 MB limit (เช่น share clip ขนาดใหญ่) ต้อง host **Local Bot API Server** เอง: <https://github.com/tdlib/telegram-bot-api> — `TELEGRAM_API_BASE_URL` รองรับชี้ไป local server ได้ทันที
