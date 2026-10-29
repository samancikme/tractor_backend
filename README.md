# ESP32-CAM monitoring (Node.js + Render)

ESP32-CAM har ~5 soniyada yuboradigan JPEG rasmlarni qabul qiladigan kichik Express serveri va ularni ko'rsatadigan monitoring sahifasi.

> **Bu video emas.** Sahifa rasmlarni har 2 soniyada tekshiradi va yangi rasm kelganda almashtiradi; rasmning o'zi taxminan har 5 soniyada yangilanadi.
>
> **Rasmlar faqat serverning RAM xotirasida saqlanadi.** Server qayta ishga tushsa, qayta deploy qilinsa yoki bepul instansiya uyquga ketib qayta uyg'onsa, saqlangan rasmlar yo'qoladi. Bu bepul demo uchun ataylab qilingan qaror.

## Tarkib

```
server.js            Express ilovasi: /upload, API, rasm endpointi, statik fayllar
storage.js           RAMdagi rasm ombori (alohida modul, keyin almashtirish mumkin)
public/              index.html, style.css, app.js  (frontend, o'zbek tilida)
tests/               node:test testlari (qo'shimcha kutubxonasiz)
render.yaml          Render Blueprint (bepul plan)
.env.example         Muhit o'zgaruvchilari namunasi
package-lock.json    haqiqiy `npm install` natijasi; `npm ci` ishlatish uchun
```

Bog'liqliklar: `express`, `sharp`. Frontend'da tashqi kutubxona yoki CDN yo'q.

## Lokal ishga tushirish

Node.js 22 kerak (`package.json` → `engines`).

```bash
npm ci
cp .env.example .env          # kerak bo'lsa API_TOKEN ni to'ldiring
node --env-file=.env server.js
# yoki tokensiz, faqat lokal test uchun:
npm start
```

Brauzerda: <http://localhost:3000>. Sinov uchun rasm yuborish:

```bash
curl -X POST http://localhost:3000/upload \
  -H "Content-Type: image/jpeg" \
  -H "X-Device-ID: TRAKTOR-CAM-01" \
  -H "X-Uptime-Ms: 123456" \
  -H "Authorization: Bearer SIZNING_TOKEN" \
  --data-binary @rasm.jpg
```

`API_TOKEN` bo'sh bo'lsa, `Authorization` sarlavhasi talab qilinmaydi (server ishga tushganda logda ogohlantirish chiqadi).

## Muhit o'zgaruvchilari

| O'zgaruvchi | Standart | Izoh |
|---|---|---|
| `PORT` | `3000` | Server `0.0.0.0:PORT` da tinglaydi. Render buni o'zi beradi. |
| `API_TOKEN` | bo'sh | Bo'sh bo'lmasa, `/upload` uchun `Authorization: Bearer <token>` shart. Frontendga chiqarilmaydi. |
| `MAX_PIXELS` | `8000000` | Dekodlash uchun maksimal piksel soni (8 megapiksel). |
| `JPEG_FAIL_ON` | `error` | JPEG tekshiruvi qattiqligi: `truncated`, `error`, `warning`. `warning` ozgina shikastlangan kadrlarni ham rad etadi. |

Kodda qat'iy belgilangan limitlar: rasm ≤ 2 MB, 2 ta qurilma, qurilmaga 10 ta rasm, jami 40 MB (`storage.js` va `server.js` boshidagi konstantalar).

## `POST /upload`

ESP32-CAM yuboradigan so'rov (multipart, base64 yoki JSON **emas**; tana — JPEG baytlarining o'zi):

```
POST /upload
Content-Type: image/jpeg
X-Device-ID: TRAKTOR-CAM-01
X-Uptime-Ms: 123456
Authorization: Bearer TOKEN        <- faqat API_TOKEN sozlangan bo'lsa
```

- `X-Device-ID`: faqat harf, raqam, `-` va `_`, 1–64 belgi.
- `X-Uptime-Ms`: qurilma yoqilganidan beri o'tgan millisekundlar (sana emas). Ixtiyoriy; yuborilsa, manfiy bo'lmagan butun son bo'lishi kerak.
- Qabul vaqti serverda UTC (ISO 8601, `Z` bilan) yoziladi.
- JPEG `sharp` orqali tekshiriladi: sarlavha, piksel limiti va to'liq dekodlash. Kesilgan yoki buzilgan fayl rad etiladi.

Muvaffaqiyatli javob `201`:

```json
{
  "ok": true,
  "image_id": "0bfb4146525f561e531b7d9a",
  "device_id": "TRAKTOR-CAM-01",
  "received_at": "2026-10-29T16:44:54.040Z",
  "image_url": "/images/0bfb4146525f561e531b7d9a"
}
```

`image_url` nisbiy manzil (`https://LOYIHA-NOMI.onrender.com` + `image_url`).

Xatolar har doim `{"ok": false, "error": "<kod>", "message": "<tushuntirish>"}` ko'rinishida:

| HTTP | `error` | Qachon |
|---|---|---|
| 400 | `missing_device_id`, `invalid_device_id`, `invalid_uptime`, `empty_body` | Sarlavha yo'q/noto'g'ri yoki tana bo'sh |
| 401 | `unauthorized` | Token noto'g'ri yoki yo'q |
| 409 | `device_limit_reached` | Uchinchi qurilma (maksimum 2) |
| 413 | `image_too_large` | Rasm 2 MB dan katta |
| 415 | `unsupported_media_type`, `unsupported_encoding` | `Content-Type` `image/jpeg` emas |
| 422 | `invalid_jpeg`, `image_too_many_pixels` | JPEG buzilgan yoki piksel limitidan katta |
| 503 | `server_busy` (+ `Retry-After: 5`) | Bir vaqtda 4 tadan ortiq yuklash |

## Boshqa endpointlar

| Endpoint | Javob |
|---|---|
| `GET /health` | `{"ok": true, "status": "ok", ...}` (Render health check shu yerga qaraydi) |
| `GET /api/devices` | Qurilmalar ro'yxati, limitlar, saqlash statistikasi, `server_time` |
| `GET /api/latest?device_id=...` | Qurilmaning oxirgi rasmi. `device_id` berilmasa, oxirgi rasm yuborgan qurilma. Rasm kelmagan bo'lsa `404 no_images`, noma'lum qurilma uchun `404 device_not_found` |
| `GET /api/images?device_id=...` | Oxirgi 10 tagacha rasm, eng yangisi birinchi. Rasm kelmagan bo'lsa bo'sh ro'yxat |
| `GET /images/:imageId` | `Content-Type: image/jpeg`. `?download=1` qo'shilsa, `attachment` sifatida yuklab olinadi. Eskirib o'chirilgan rasm uchun `404 image_not_found` |
| `GET /` | Monitoring sahifasi |

## Saqlash va RAM limitlari

- Har bir qurilma uchun oxirgi **10** ta rasm, ko'pi bilan **2** ta qurilma.
- Rasm baytlarining umumiy limiti **40 MB**. Oshib ketsa, butun ombordagi eng eski rasmlar o'chiriladi.
- Hisobga faqat rasm baytlari kiradi; Node.js va `sharp`ning o'z xotirasi alohida.
- Qurilma slotlari server qayta ishga tushguncha band qoladi: uchinchi qurilma `409` oladi.
- Doimiy saqlash kerak bo'lsa, `storage.js` dagi `add / getLatest / list / get / devices / stats / mostRecentDeviceId / hasDevice` interfeysini saqlagan holda yangi sinf yozing va `createApp({ store })` ga bering. Hozirgi variant hech qanday pulli xizmat talab qilmaydi.

## Render'ga deploy qilish

### Render bepul rejasi haqida (rasmiy hujjatlardan)

Quyidagilar 2026-10-29 kuni Render hujjatlaridan olindi (manbalar pastda). Hujjatlar o'zgarishi mumkin, deploy oldidan qayta qarab chiqing.

- **Uyquga ketish:** bepul web service 15 daqiqa davomida kiruvchi trafik olmasa, uyquga ketadi. Keyingi HTTP so'rov uni qayta uyg'otadi.
- **Uyg'onish kechikishi:** hujjatda "taxminan bir daqiqa" deb yozilgan. Brauzerlarga Render yuklanish sahifasini ko'rsatadi.
- **Soatlar:** workspace uchun oyiga **750** bepul instansiya soati (barcha bepul servislar uchun umumiy). Tugasa, hamma bepul servislar oy oxirigacha to'xtatiladi. Bir servis 24/7 ishlasa ham 31 kunlik oyda 744 soat sarflaydi, ya'ni limitga juda yaqin: shu workspace'da boshqa bepul servis bo'lsa, limit tugashi mumkin.
- **Vaqtinchalik fayl tizimi:** qayta deploy, qayta ishga tushish yoki uyquga ketishda lokal o'zgarishlar yo'qoladi. Bepul servisda doimiy disk yo'q.
- **Qayta ishga tushish:** Render bepul servisni istalgan vaqtda qayta ishga tushirishi mumkin.
- **Kafolat yo'q:** hujjat bepul instansiyalarni production uchun emas, sinov va hobbi loyihalari uchun deb ataydi va uzluksiz ishlashni kafolatlamaydi. **Bu loyiha ham kafolatlamaydi.**
- **Resurslar:** `plan: free` web service uchun 0.1 CPU va 512 MB RAM (Blueprint spetsifikatsiyasi sahifasida).
- **Trafik:** bepul servislar oylik chiquvchi trafik va build daqiqalari limitiga hisoblanadi. Monitoring sahifasini ochish chiquvchi trafik hosil qiladi (har bir rasm ko'rinishi uchun).
- **HTTPS:** barcha HTTP so'rovlar HTTPS'ga yo'naltiriladi. ESP32'da `https://` manzilini to'g'ridan-to'g'ri ishlating.

**Sun'iy keep-alive ping qo'shilmagan** va limitlarni aylanib o'tishga urinilmagan. ESP32 har 5 soniyada rasm yuborib turgani oddiy foydalanish bo'lib, u servisni uyg'oq ushlab turishi mumkin, lekin bu kafolat emas: Render istalgan paytda qayta ishga tushirishi mumkin va qurilma o'chiq bo'lsa, 15 daqiqadan keyin servis uxlaydi.

### 1. Kodni GitHub'ga yuklash

```bash
git init -b main
git add .
git status        # node_modules/ va .env ro'yxatda bo'lmasligi kerak, package-lock.json bo'lishi kerak
git commit -m "ESP32-CAM monitor"
git remote add origin https://github.com/FOYDALANUVCHI/esp32-cam-monitor.git
git push -u origin main
```

### 2. Token tayyorlash

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Natijani saqlab qo'ying: Render'ga ham, ESP32 kodiga ham aynan shu qiymat kerak. Tokenni GitHub'ga yozmang.

### 3. Servisni yaratish: A variant, Blueprint orqali (tavsiya etiladi)

1. Render Dashboard → **New** → **Blueprint**.
2. GitHub akkauntingizni ulang va repository'ni tanlang. Render ildizdagi `render.yaml` ni o'qiydi.
3. `API_TOKEN` qiymati so'ralganda 2-qadamdagi tokenni kiriting (`render.yaml` da `sync: false`, shuning uchun qiymat repository'ga yozilmaydi va faqat Blueprint birinchi marta yaratilganda so'raladi).
4. Blueprint'ni tasdiqlang. Render `npm ci` bilan build qiladi va `npm start` bilan ishga tushiradi.

`render.yaml` dagi `region: frankfurt` O'zbekistonga yaqinroq tanlov sifatida qo'yilgan. Render hujjatiga ko'ra, mintaqani servis yaratilgandan keyin o'zgartirib bo'lmaydi. Boshqa mintaqa kerak bo'lsa, deploydan oldin faylni tahrirlang.

### 3. Servisni yaratish: B variant, qo'lda web service

Dashboard → **New** → **Web Service** → repository'ni tanlang, so'ng:

| Maydon | Qiymat |
|---|---|
| Language / Runtime | Node |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Instance Type | Free |
| Health Check Path (Advanced) | `/health` |
| Environment → `API_TOKEN` | 2-qadamdagi token |

Maydon nomlari Dashboard yangilanishi bilan biroz farq qilishi mumkin.

### Node.js versiyasi

`package.json` da `"engines": {"node": ">=22.0.0 <23"}` berilgan. Render hujjatiga ko'ra, versiya ustuvorligi: `NODE_VERSION` muhit o'zgaruvchisi, `.node-version`, `.nvmrc`, keyin `engines.node`; yuqori chegarasiz diapazon eng so'nggi Node'ga hal bo'ladi, hech narsa berilmasa, yangi servislar 24.x ni oladi. Loyiha Node 22 da sinalgan, Node 24 da sinalmagan.

### 4. Deploydan keyin tekshirish

```bash
curl https://LOYIHA-NOMI.onrender.com/health
curl -X POST https://LOYIHA-NOMI.onrender.com/upload \
  -H "Content-Type: image/jpeg" -H "X-Device-ID: TRAKTOR-CAM-01" -H "X-Uptime-Ms: 1000" \
  -H "Authorization: Bearer SIZNING_TOKEN" --data-binary @rasm.jpg
```

Servis uxlab yotgan bo'lsa, birinchi so'rov taxminan bir daqiqa kutishi mumkin. Keyin `https://LOYIHA-NOMI.onrender.com` ni oching.

## ESP32-CAM sozlamalari

```cpp
const char* SERVER_URL = "https://LOYIHA-NOMI.onrender.com/upload";
const char* API_TOKEN  = "Render'dagi token bilan bir xil";
```

### HTTPS: ROOT_CA va to'g'ri vaqt

ESP32 sertifikatni tekshirishi uchun ikkita narsa kerak:

1. **Ishonchli root sertifikat (`ROOT_CA`)**, `WiFiClientSecure::setCACert()` ga beriladi.
2. **To'g'ri vaqt.** Sertifikatning amal qilish muddati qurilma soati bo'yicha tekshiriladi. Wi-Fi'ga ulangach NTP bilan vaqtni sinxronlang va soat o'rnatilgunga qadar yuklamang.

**TLS tekshiruvini o'chirish (`setInsecure()`) bu loyihada standart yechim emas** va tavsiya etilmaydi: token ochiq tarmoqda o'g'irlanishi mumkin.

Qaysi root kerakligini o'zingiz aniqlang. Render TLS hujjati sertifikatlarni Let's Encrypt va Google Trust Services chiqarishini yozadi, lekin `onrender.com` subdomenlari uchun aniq CA'ni ko'rsatmaydi, shuning uchun zanjirni tekshiring:

```bash
openssl s_client -showcerts -servername LOYIHA-NOMI.onrender.com -connect LOYIHA-NOMI.onrender.com:443 </dev/null
```

Zanjirdagi oxirgi sertifikatning `issuer` qatoriga qarang va aynan shu **root** CA sertifikatini CA'ning rasmiy saytidan (PEM formatda) oling. Barg (leaf) sertifikatni emas, root'ni qo'ying: barg sertifikat tez-tez yangilanadi. CA zanjirni almashtirsa, `ROOT_CA` ni yangilash kerak bo'ladi. Bir nechta root'ni ketma-ket bitta PEM satriga joylash mumkin.

### Render uyg'onganda: timeoutlar

Servis uxlab yotganda birinchi so'rov taxminan bir daqiqa davom etishi mumkin, qurilmadagi 4 soniyalik timeoutdan ancha uzoq. Natijada:

- birinchi ulanish urinishi muvaffaqiyatsiz tugashi mumkin;
- qurilma har 5 soniyada yangi urinish qilishda davom etadi, servis uyg'ongach urinishlar muvaffaqiyatli bo'ladi;
- muvaffaqiyatsiz kadrlar yo'qoladi (server navbat saqlamaydi).

Bu normal holat, kodni o'zgartirish shart emas. Timeoutlarni uzaytirmoqchi bo'lsangiz, Arduino-ESP32 `HTTPClient` da aynan shu qatorlar (millisekundlarda):

```cpp
http.setConnectTimeout(15000);  // ulanish uchun kutish
http.setTimeout(15000);         // javob uchun kutish
```

Kamchiligi: uzun timeout paytida sikl bloklanadi va kadrlar kamroq olinadi.

### Namuna (qurilmada sinalmagan)

Quyidagi parcha tushuntirish uchun yozilgan; ESP32 qurilmasida **sinalmagan** va kompilyatsiya qilinmagan. O'z kodingizdagi tegishli qatorlarga moslang:

```cpp
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "esp_camera.h"

const char* DEVICE_ID = "TRAKTOR-CAM-01";
const char* ROOT_CA = R"PEM(
-----BEGIN CERTIFICATE-----
... yuqorida aniqlagan root sertifikat ...
-----END CERTIFICATE-----
)PEM";

void syncTime() {                                   // Wi-Fi ulangandan keyin chaqiring
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  time_t now = time(nullptr);
  for (int i = 0; i < 40 && now < 1700000000; i++) { delay(500); now = time(nullptr); }
}

bool uploadFrame(camera_fb_t* fb) {
  WiFiClientSecure client;
  client.setCACert(ROOT_CA);

  HTTPClient http;
  http.setConnectTimeout(15000);
  http.setTimeout(15000);
  if (!http.begin(client, SERVER_URL)) return false;

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("X-Device-ID", DEVICE_ID);
  http.addHeader("X-Uptime-Ms", String((unsigned long)millis()));
  http.addHeader("Authorization", String("Bearer ") + API_TOKEN);

  int code = http.POST(fb->buf, fb->len);           // tana: JPEG baytlari
  http.end();
  return code == 201;
}
```

## Testlar

```bash
npm test
```

Node'ning o'rnatilgan `node:test` ishlatiladi. Testlar quyidagilarni qamrab oladi: muvaffaqiyatli yuklash va `201` javob shakli; token (yo'q, noto'g'ri, noto'g'ri sxema, to'g'ri, bo'sh token rejimi, tokenning frontend va API'ga chiqmasligi); buzilgan JPEG (kesilgan, axlat, PNG, matn, bo'sh tana, piksel limiti); hajm cheklovi (2 MB va chegara qiymati); `X-Device-ID`, `X-Uptime-Ms`, `Content-Type` tekshiruvi; qurilma limiti; RAMda eski rasmlarni o'chirish (qurilma bo'yicha va umumiy bayt limiti bo'yicha); bir vaqtdagi yuklashlar cheklovi; barcha o'qish endpointlari va "hali rasm kelmagan" holati; `start()` ning `0.0.0.0` va `PORT` bo'yicha tinglashi.

## Xavfsizlik va cheklovlar

- **Monitoring sahifasi va rasmlar ochiq:** `GET /`, `/api/*` va `/images/*` uchun autentifikatsiya yo'q (bu talab qilinmagan). URL'ni biladigan har kim rasmlarni ko'ra oladi. Maxfiy kadrlar uchun ko'rish tomoniga ham himoya qo'shing.
- `API_TOKEN` faqat `/upload` uchun. Uni uzun va tasodifiy qiling, kerak bo'lsa Render'da almashtirib, ESP32'ni qayta yuklang.
- `/upload` uchun so'rovlar chastotasini cheklash (rate limit) yo'q; faqat bir vaqtdagi yuklashlar soni cheklangan.
- Bepul Render CPU'si kichik (0.1 CPU), shuning uchun yirik rasmlarni dekodlash sekinroq bo'lishi mumkin. Bu loyihada Render'da o'lchanmagan.

## Manbalar

- Render bepul reja: <https://render.com/docs/free>
- Blueprint spetsifikatsiyasi: <https://render.com/docs/blueprint-spec>
- Node.js versiyasi: <https://render.com/docs/node-version>
- Boshqariladigan TLS sertifikatlari: <https://render.com/docs/tls>
