import { CameraView, useCameraPermissions } from "expo-camera";
import * as Speech from "expo-speech";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { analyzeCommandMulti, CommandResponse, enrollFaceMulti } from "@/lib/api";
import {
  AssistantStatus,
  cleanAssistantText,
  toUserFacingAssistantError,
} from "@/lib/assistant";
import { GlassCard } from "@/components/GlassCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { useAppStore } from "@/store/useAppStore";

type SpeechRecognitionModule = {
  abort: () => void;
  stop: () => void;
  isRecognitionAvailable: () => boolean;
  start: (options: {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    maxAlternatives: number;
  }) => void;
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
};

type SpeechRecognitionPackage = {
  ExpoSpeechRecognitionModule: SpeechRecognitionModule;
  useSpeechRecognitionEvent: (
    event: string,
    listener: (payload: {
      error?: string;
      isFinal?: boolean;
      message?: string;
      results?: Array<{ transcript?: string }>;
    }) => void,
  ) => void;
};

let speechRecognition: SpeechRecognitionPackage | null = null;
try {
  speechRecognition = require("expo-speech-recognition");
} catch {}

const QUICK_COMMANDS = [
  "What is in front of me?",
  "Identify this product.",
  "Read the label and price.",
  "What is the brand and model?",
];
const MAX_CAPTURE_ATTEMPTS = 2;

function needsAnotherFrameBatch(response: CommandResponse) {
  const processing = response.processing;
  return Boolean(
    processing?.quality_checked &&
      processing.ai_called === false &&
      processing.frame_quality?.length &&
      processing.frame_quality.every((frame) => !frame.good),
  );
}

function parseEnrollmentCommand(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim();
  const relationships = "friend|frnd|brother|sister|mother|father|wife|husband|colleague|coworker|teacher";
  const relationMatch = normalized.match(
    new RegExp(
      `\\b(?:this(?:\\s+person)?\\s+is|he\\s+is|she\\s+is|they\\s+are|meet)\\s+(?:my\\s+)?(${relationships})\\s*[,:]?\\s*(?:named\\s+)?([A-Za-z][A-Za-z' -]{0,48})(?:[.!?]|$)`,
      "i",
    ),
  );
  if (relationMatch) {
    return {
      name: relationMatch[2].trim().replace(/[.!?]+$/, ""),
      relationship: relationMatch[1].toLowerCase().replace("frnd", "friend").replace("coworker", "coworker"),
    };
  }

  const nameMatch = normalized.match(
    /\b(?:this(?:\s+person)?\s+is|he\s+is|she\s+is|they\s+are|meet)\s+(?:named\s+)?([A-Za-z][A-Za-z' -]{0,48})(?:[.!?]|$)/i,
  );
  if (nameMatch) {
    return { name: nameMatch[1].trim(), relationship: undefined };
  }

  const saveMatch = normalized.match(
    /\b(?:remember|save|introduce)\s+(?:this\s+(?:person|face)|him|her|them)\s+(?:as|is)\s+(?:(?:my\s+)?(friend|frnd|brother|sister|mother|father|wife|husband|colleague|coworker|teacher)\s+)?([A-Za-z][A-Za-z' -]{0,48})(?:[.!?]|$)/i,
  );
  if (saveMatch) {
    return {
      name: saveMatch[2].trim(),
      relationship: saveMatch[1]?.toLowerCase().replace("frnd", "friend"),
    };
  }

  return null;
}

export default function Camera() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const inFlightRef = useRef(false);
  const preferredVoiceRef = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");
  const [answer, setAnswer] = useState<CommandResponse | null>(null);
  const [notice, setNotice] = useState("");
  const [recognizing, setRecognizing] = useState(false);
  const [status, setStatus] = useState<AssistantStatus>("idle");
  const session = useAppStore((state) => state.sessionId);

  if (speechRecognition) {
    speechRecognition.useSpeechRecognitionEvent("start", () => {
      setRecognizing(true);
      if (!inFlightRef.current) setStatus("listening");
    });

    speechRecognition.useSpeechRecognitionEvent("end", () => {
      setRecognizing(false);
      if (!inFlightRef.current) setStatus("idle");
    });

    speechRecognition.useSpeechRecognitionEvent("result", (event) => {
      const transcript = event.results?.[0]?.transcript?.trim() ?? "";
      if (event.isFinal && transcript && !inFlightRef.current) {
        setCommand(transcript);
        void runCommand(transcript);
      }
    });

    speechRecognition.useSpeechRecognitionEvent("error", (event) => {
      setRecognizing(false);
      if (event.error === "aborted" || inFlightRef.current) return;
      setStatus("error");
      setNotice(cleanAssistantText(event.message) || "Voice recognition failed.");
    });
  }

  useEffect(() => {
    void choosePreferredVoice();
    return () => {
      try {
        speechRecognition?.ExpoSpeechRecognitionModule.abort();
      } catch {}
      Speech.stop();
    };
  }, []);

  async function choosePreferredVoice() {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      const englishVoices = voices.filter((voice) =>
        voice.language.toLowerCase().startsWith("en"),
      );
      const enhancedVoice = englishVoices.find(
        (voice) => voice.quality === "Enhanced",
      );
      preferredVoiceRef.current = (enhancedVoice ?? englishVoices[0])?.identifier;
    } catch {
      // Use the device's default voice if its voice catalog cannot be read.
    }
  }

  async function captureCommandFrames(count = 3) {
    if (!cameraRef.current) throw new Error("Camera is not ready.");
    const uris: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.78,
        skipProcessing: true,
      });
      if (photo?.uri) uris.push(photo.uri);
      if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, 120));
    }

    if (!uris.length) throw new Error("Camera did not return a frame.");
    return uris;
  }

  function speakFinalReply(text: string) {
    const spoken = cleanAssistantText(text);
    if (!spoken) {
      setStatus("idle");
      return;
    }

    setStatus("speaking");
    Speech.stop();
    Speech.speak(spoken, {
      rate: 0.94,
      pitch: 1.0,
      voice: preferredVoiceRef.current,
      onDone: () => setStatus("idle"),
      onStopped: () => setStatus("idle"),
      onError: () => setStatus("idle"),
    });
  }

  async function runCommand(nextCommand = command) {
    const trimmedCommand = nextCommand.trim();
    if (!trimmedCommand || inFlightRef.current || !cameraRef.current) return;

    inFlightRef.current = true;
    setBusy(true);
    setStatus("capturing");
    setNotice("");
    setAnswer(null);

    try {
      const enrollment = parseEnrollmentCommand(trimmedCommand);

      if (enrollment) {
        setNotice("Saving several clear face views automatically...");
        const uris = await captureCommandFrames(8);
        setStatus("processing");
        const result = await enrollFaceMulti(
          enrollment.name,
          enrollment.relationship,
          uris,
        );
        const reply = cleanAssistantText(result.reply) || "I couldn't complete face enrollment.";
        setNotice(reply);
        speakFinalReply(reply);
        return;
      }

      let response: CommandResponse | null = null;
      for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        const uris = await captureCommandFrames(3);
        setStatus("processing");
        response = await analyzeCommandMulti(session, trimmedCommand, uris, "en");

        if (
          !needsAnotherFrameBatch(response) ||
          attempt === MAX_CAPTURE_ATTEMPTS - 1
        ) {
          break;
        }

        setStatus("capturing");
        setNotice("The view was unclear. Capturing a clearer set of frames.");
      }

      const reply =
        cleanAssistantText(response?.reply) ||
        "Sorry, I couldn't analyze that image.";
      setAnswer({ ...response!, reply });
      setNotice(reply);
      speakFinalReply(reply);
    } catch (error) {
      const message = toUserFacingAssistantError(error);
      setNotice(message);
      setStatus("error");
      speakFinalReply(message);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  async function startVoice() {
    setNotice("");

    if (!speechRecognition) {
      setStatus("error");
      setNotice("Voice recognition requires an Expo development build.");
      return;
    }

    try {
      if (!speechRecognition.ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        throw new Error("Speech recognition is unavailable on this device.");
      }

      const speechPermission =
        await speechRecognition.ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!speechPermission.granted) {
        throw new Error("Microphone and speech-recognition permission is required.");
      }

      speechRecognition.ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
      });
    } catch (error) {
      setStatus("error");
      setNotice(
        cleanAssistantText(error instanceof Error ? error.message : "") ||
          "Unable to start voice recognition.",
      );
    }
  }

  if (!permission) {
    return <View style={styles.center}><ActivityIndicator color="#FFF" /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Camera permission required</Text>
        <PrimaryButton title="Allow Camera" onPress={() => void requestPermission()} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.camWrap}>
          <CameraView
            ref={cameraRef}
            style={styles.cam}
            facing="back"
            animateShutter={false}
          />
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.badgeText}>LIVE CAMERA</Text>
          </View>
        </View>

        <GlassCard>
          <Text style={styles.label}>ASK X-GLASSES</Text>
          <TextInput
            value={command}
            onChangeText={setCommand}
            placeholder="e.g. What is in front of me?"
            placeholderTextColor="#68717E"
            style={styles.input}
            multiline
          />
          <View style={styles.actions}>
            <Pressable
              disabled={busy || !command.trim()}
              onPress={() => void runCommand()}
              style={[styles.capture, !command.trim() && styles.disabled]}
            >
              <Text style={styles.captureText}>Analyze current view</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={
                recognizing
                  ? () => speechRecognition?.ExpoSpeechRecognitionModule.stop()
                  : () => void startVoice()
              }
              style={[styles.mic, recognizing && styles.micOn]}
            >
              <Text style={styles.micText}>{recognizing ? "STOP" : "MIC"}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            {status === "listening"
              ? "Listening. Say your command normally."
              : status === "capturing"
                ? "Capturing frames from the live camera."
                : status === "processing"
                  ? "Analyzing while the camera stays live."
                  : status === "speaking"
                    ? "Speaking the final answer."
                    : "Tap MIC to speak, or type a command and tap Analyze."}
          </Text>
        </GlassCard>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {QUICK_COMMANDS.map((quickCommand) => (
            <Pressable
              key={quickCommand}
              disabled={busy}
              onPress={() => {
                setCommand(quickCommand);
                void runCommand(quickCommand);
              }}
              style={styles.chip}
            >
              <Text style={styles.chipText}>{quickCommand}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {answer || notice ? (
          <Result text={answer?.reply ?? notice} />
        ) : (
          <GlassCard>
            <Text style={styles.muted}>
              Use the MIC button, enter your own command, or choose a quick command.
            </Text>
          </GlassCard>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Result({ text }: { text: string }) {
  return (
    <GlassCard>
      <Text style={styles.label}>ASSISTANT</Text>
      <Text style={styles.answer}>{text}</Text>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#090A0D" },
  content: { padding: 14, gap: 12, paddingBottom: 30 },
  camWrap: { height: 430, borderRadius: 28, overflow: "hidden", backgroundColor: "#15171B" },
  cam: { flex: 1 },
  liveBadge: { position: "absolute", top: 14, left: 14, flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 8, paddingHorizontal: 11, borderRadius: 20, backgroundColor: "rgba(0,0,0,.65)" },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#62F59B" },
  badgeText: { color: "#FFF", fontSize: 11, fontWeight: "900", letterSpacing: 0.4 },
  label: { color: "#727A87", fontSize: 10, letterSpacing: 2, fontWeight: "900", marginBottom: 9 },
  input: { minHeight: 58, maxHeight: 100, borderRadius: 16, backgroundColor: "rgba(255,255,255,.055)", color: "#FFF", padding: 14, fontSize: 16, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: 10, marginTop: 10 },
  capture: { flex: 1, minHeight: 52, borderRadius: 17, backgroundColor: "#FFF", alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.45 },
  captureText: { color: "#090A0D", fontWeight: "900" },
  mic: { width: 64, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,.09)", borderWidth: 1, borderColor: "rgba(255,255,255,.14)" },
  micOn: { backgroundColor: "rgba(255,90,90,.25)", borderColor: "rgba(255,100,100,.5)" },
  micText: { fontSize: 12, color: "#FFF", fontWeight: "900", letterSpacing: 0.5 },
  hint: { color: "#737C88", fontSize: 12, marginTop: 9, lineHeight: 18 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18, backgroundColor: "rgba(255,255,255,.065)", borderWidth: 1, borderColor: "rgba(255,255,255,.1)" },
  chipText: { color: "#D9DEE5", fontSize: 12, fontWeight: "700" },
  answer: { color: "#FFF", fontSize: 19, lineHeight: 28, fontWeight: "700" },
  muted: { color: "#8E97A4", lineHeight: 21 },
  center: { flex: 1, backgroundColor: "#090A0D", padding: 24, justifyContent: "center", gap: 20 },
  title: { color: "#FFF", fontSize: 22, fontWeight: "900", textAlign: "center" },
});
