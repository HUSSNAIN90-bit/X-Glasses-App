export type GeminiLiveCallbacks = {
  onOpen?: () => void;
  onSetupComplete?: () => void;
  onMessage?: (message: Record<string, unknown>) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

type LiveTokenResponse = { token: string; model: string; expires_at?: string | null };

/**
 * Direct mobile-to-Gemini Live WebSocket. The backend only provisions a
 * short-lived, single-use token; camera frames do not pass through FastAPI.
 */
export class GeminiLiveVisionSession {
  private socket: WebSocket | null = null;
  private ready = false;
  private closed = false;
  constructor(private readonly callbacks: GeminiLiveCallbacks = {}) {}

  async connect(tokenProvider: () => Promise<LiveTokenResponse>) {
    if (this.socket) throw new Error("Gemini Live session is already connected.");
    const credentials = await tokenProvider();
    if (!credentials.token || !credentials.model) throw new Error("Gemini Live token response is incomplete.");
    const url = "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      "?access_token=" + encodeURIComponent(credentials.token);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        this.callbacks.onOpen?.();
        socket.send(JSON.stringify({ setup: {
          model: credentials.model.startsWith("models/") ? credentials.model : "models/" + credentials.model,
          generationConfig: { responseModalities: ["AUDIO"] },
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: "You are X-Glasses, a concise visual assistant. Describe only what is visible and clearly distinguish uncertainty." }] },
        } }));
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          const apiError = message.error as { message?: string } | undefined;
          if (apiError) {
            const detail = apiError.message || "Gemini Live rejected the session setup.";
            this.callbacks.onError?.(detail);
            if (!this.ready) reject(new Error(detail));
            return;
          }
          if (message.setupComplete) { this.ready = true; this.callbacks.onSetupComplete?.(); resolve(); }
          this.callbacks.onMessage?.(message);
        } catch { this.callbacks.onError?.("Received an unreadable Gemini Live message."); }
      };
      socket.onerror = () => {
        const error = "Gemini Live connection failed.";
        this.callbacks.onError?.(error);
        if (!this.ready) reject(new Error(error));
      };
      socket.onclose = () => {
        const wasReady = this.ready;
        this.ready = false;
        this.socket = null;
        this.callbacks.onClose?.();
        if (!wasReady) reject(new Error("Gemini Live closed before setup completed."));
        else if (!this.closed) this.callbacks.onError?.("Gemini Live connection closed.");
      };
    });
  }

  sendVideoFrame(jpegBase64: string) {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Gemini Live is not ready to receive video.");
    const data = jpegBase64.replace(/^data:image\/[^;]+;base64,/, "");
    this.socket.send(JSON.stringify({ realtimeInput: { video: { mimeType: "image/jpeg", data } } }));
  }

  sendText(text: string) {
    const value = text.trim();
    if (!value || !this.ready || !this.socket) return;
    this.socket.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: value }] }], turnComplete: true } }));
  }

  disconnect() { this.closed = true; this.ready = false; this.socket?.close(); this.socket = null; }
  get isReady() { return this.ready; }
}
