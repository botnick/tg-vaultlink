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

## 2. สร้างบอทใน Telegram

1. เปิด Telegram → คุยกับ [@BotFather](https://t.me/BotFather)
2. ส่ง `/newbot`
3. ตอบชื่อบอท (display name) เช่น `My VaultLink`
4. ตอบ username (ต้องลงท้าย `bot`) เช่น `my_vaultlink_bot`
5. BotFather จะส่ง **token** มาให้หน้าตาแบบ `8729457750:AAH...` — copy เก็บไว้
6. (แนะนำ) ส่ง `/setdescription` `/setabouttext` `/setuserpic` เพื่อแต่งหน้าโปรไฟล์บอท

> ถ้า token หลุดให้รีบเปลี่ยน: `/mybots` → เลือกบอท → **API Token** → **Revoke current token** ระบบจะออก token ใหม่ ตัวเก่าจะใช้ไม่ได้ทันที

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

1. `/mybots` → เลือกบอท → **Bot Settings** → **Menu Button** → **Configure Menu Button**
2. ใส่ URL ngrok (เหมือนใน `.env`)
3. ตั้งชื่อปุ่ม เช่น `เปิดแอป`

เปิดแชทบอท → ปุ่ม menu จะมีให้กด → เปิด WebApp พร้อม `initData` → API auth ผ่าน ✅

> ngrok free tier มีหน้าเตือน "You are about to visit..." ครั้งแรก กดผ่านได้ ถ้าใช้บ่อยให้สมัคร authtoken หรือเปลี่ยนไปใช้ cloudflared

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
