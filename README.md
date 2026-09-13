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
