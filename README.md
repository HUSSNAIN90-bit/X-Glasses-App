# X-Glasses Mobile Companion

Built against the current X-Glasses FastAPI routes inspected from `HUSSNAIN90-bit/X-Glasses`.

### Run
1. Copy `.env.example` to `.env`.
2. Set `EXPO_PUBLIC_API_URL=http://YOUR_PC_LAN_IP:8000`.
3. Do not add any OpenAI or model API keys to the mobile `.env`.
4. Backend: `uvicorn main:app --host 0.0.0.0 --port 8000`.
5. `npm install`
6. `npx expo run:android`

Use a development build for speech recognition support. `expo start` can still be used afterward to attach Metro, but the native speech module should be launched through a dev build instead of Expo Go.

### Wired backend
`/health`, `/api/vision/analyze-command-multi`, `/api/chat/`, `/api/faces/people`, `/api/faces/enroll`, `/api/faces/recognize`, `/api/faces/people/{id}`, `/api/faces/people/{id}/embeddings`.

Live Vision keeps the camera preview running continuously with no automatic API calls. When the user submits a voice or text command, the app captures up to 3 temporary frames in quick succession and sends them to `/api/vision/analyze-command-multi`. The frontend does not render those frames, does not upload preview-loop frames, and does not call OpenAI directly.

The mobile UI is intentionally native Expo/React Native TypeScript, with Zustand, Axios, AsyncStorage, camera capture, speech recognition, and final-reply-only TTS.


## On-device face recognition

Face identity commands are now routed locally on the phone. The flow is:

`camera capture → ML Kit face detection/crop → MobileFaceNet embedding → encrypted local embedding store → 1:N cosine matching`

The app does not upload face frames for commands such as **“Who is in front of me?”**. Multiple enrolled people can be matched in the same scene. Face embeddings are encrypted before being stored locally; the encryption key is kept in the platform secure store.

### Model setup

The recognition module intentionally does not ship a random third-party model. Configure a MobileFaceNet-compatible `.tflite` model URL in your local `.env`:

`EXPO_PUBLIC_FACE_MODEL_URL=https://your-host/mobilefacenet.tflite`

Use a model whose license permits your intended use. The native recognition package accepts common MobileFaceNet variants and reads their tensor shapes at runtime.

Because this uses native ML Kit/TFLite modules, **Expo Go is not enough**. Build a development/native app after installing dependencies:

`npm install`

`npx expo prebuild`

`npx expo run:android`

The recognition package currently requires Android API 26+; iOS recognition should be tested on a physical device rather than the simulator.



## Gemini Live Vision (mobile streaming)

The camera screen includes a **Start Gemini Live Vision** control. The phone captures and streams one JPEG frame per second directly to the Gemini Live WebSocket; camera frames do not pass through FastAPI. FastAPI only issues a single-use, short-lived Gemini ephemeral token. Configure `GEMINI_API_KEY` on the backend and optionally set `GEMINI_LIVE_MODEL` (default: `gemini-3.8-live`). Never place the Gemini API key in the Expo app or `EXPO_PUBLIC_*` variables. Live video sessions are subject to Gemini model/session limits and require an internet connection.


## On-device human posture analysis

Posture/pose commands now use `@mefitzgerald/expo-pose-detection` through `PoseDetection.detectPose()` on the captured local camera image. The module returns 33 ML Kit body landmarks; the app derives a conservative standing/sitting/bending estimate from visible shoulder, hip, knee and ankle points. The inference stays on-device. The native package requires a fresh development build after `npm install`; This SDK 54-compatible module is Android-only; iOS requires a separate validated implementation.
