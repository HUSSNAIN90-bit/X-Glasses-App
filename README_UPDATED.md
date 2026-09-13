# X-Glasses Mobile Companion — Updated

## Included

- Always-on local live camera preview.
- No automatic frame-by-frame AI analysis.
- One explicit command triggers three rapid camera captures.
- Backend chooses the clearest usable frame using blur, brightness and clarity scoring.
- If all frames are poor, the AI request is skipped and the app asks the user to hold steady.
- Voice command button on Live Vision.
- Text command input and quick commands.
- Automatic spoken AI replies with `expo-speech`.
- Separate Assistant Chat screen.
- People enrollment screen.
- Backend/session settings screen.
- Product-oriented quick prompts for brand/model/label/price questions.

## Product identification behavior

The multimodal backend can answer from visible evidence:
- product/object type
- visible brand/logo
- readable model name/number
- visible price tag
- visible text/labels
- whether a barcode/QR code is visible

Do not treat an image-only guess as a current market price. Current market price requires a separate web/product lookup service. Barcode number decoding is best handled by a dedicated barcode decoder.

## Voice recognition

The project uses `expo-speech-recognition` with the SDK 54 build target. Because this is a native speech-recognition module, use an Expo development build (`npx expo run:android` / `npx expo run:ios`) rather than plain Expo Go.

## Install

```bash
npm install
npx expo start
```

For native voice recognition:

```bash
npx expo run:android
# or
npx expo run:ios
```

## Backend URL

Create `.env` from `.env.example` and set:

```env
EXPO_PUBLIC_API_URL=http://YOUR-PC-LAN-IP:8000
```

Do not use `localhost` from a physical phone.

## Flow

```text
Live Camera
   ↓
User says/taps a command
   ↓
Capture 3 rapid frames
   ↓
POST /api/vision/analyze-command-multi
   ↓
Backend quality gate
   ├─ no good frame → no AI call → retry message
   └─ good frame → YOLO + verification + Qwen Vision
   ↓
Short reply
   ↓
TTS
   ↓
Live camera remains available
```
