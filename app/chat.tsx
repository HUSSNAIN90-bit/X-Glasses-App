import * as Speech from "expo-speech";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { sendChat } from "@/lib/api";
import {
  cleanAssistantText,
  toUserFacingAssistantError,
} from "@/lib/assistant";
import { useAppStore } from "@/store/useAppStore";

export default function Chat() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const session = useAppStore((state) => state.sessionId);
  const messages = useAppStore((state) => state.messages);
  const addMessage = useAppStore((state) => state.addMessage);
  const scene = useAppStore((state) => state.lastVision?.scene);

  async function send() {
    const message = text.trim();

    if (!message || busy) {
      return;
    }

    setBusy(true);
    setError("");
    addMessage({
      id: `${Date.now()}u`,
      role: "user",
      text: message,
      createdAt: Date.now(),
    });
    setText("");

    try {
      const response = await sendChat(session, message);
      const reply =
        cleanAssistantText(response.reply) || "Sorry, I couldn't process that request.";

      addMessage({
        id: `${Date.now()}a`,
        role: "assistant",
        text: reply,
        createdAt: Date.now(),
      });

      Speech.stop();
      Speech.speak(reply, { rate: 0.94 });
    } catch (requestError) {
      setError(
        toUserFacingAssistantError(
          requestError,
          "Sorry, I couldn't process that request.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.list}>
        <View style={styles.ctx}>
          <Text style={styles.label}>ASSISTANT</Text>
          <Text style={styles.ctxText}>
            Chat is separate from Live Vision. Ask follow-up questions here
            without continuously sending camera frames.
          </Text>
          {scene ? <Text style={styles.scene}>Last scene: {scene}</Text> : null}
        </View>

        {messages.map((message) => (
          <View
            key={message.id}
            style={[
              styles.bubble,
              message.role === "user" ? styles.user : styles.assistant,
            ]}
          >
            <Text style={styles.role}>
              {message.role === "user" ? "YOU" : "X-GLASSES"}
            </Text>
            <Text
              style={[styles.msg, message.role === "user" && styles.userMsg]}
            >
              {message.text}
            </Text>
            {message.role === "assistant" ? (
              <Pressable
                onPress={() => {
                  Speech.stop();
                  Speech.speak(cleanAssistantText(message.text), { rate: 0.94 });
                }}
              >
                <Text style={styles.speak}>Speak</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.composer}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Ask the assistant..."
          placeholderTextColor="#69717D"
          style={styles.input}
          multiline
        />
        <Pressable
          onPress={() => void send()}
          disabled={busy}
          style={[styles.send, busy && styles.sendDisabled]}
        >
          <Text style={styles.sendText}>{busy ? "..." : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#090A0D" },
  list: { padding: 16, gap: 12 },
  ctx: { padding: 16, borderRadius: 20, backgroundColor: "rgba(255,255,255,.06)" },
  label: {
    color: "#727A87",
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "900",
    marginBottom: 7,
  },
  ctxText: { color: "#AEB5C0", lineHeight: 21 },
  scene: { color: "#FFF", marginTop: 10, lineHeight: 21 },
  bubble: { maxWidth: "91%", padding: 15, borderRadius: 19 },
  user: { alignSelf: "flex-end", backgroundColor: "#FFF" },
  assistant: { alignSelf: "flex-start", backgroundColor: "rgba(255,255,255,.07)" },
  role: {
    fontSize: 9,
    letterSpacing: 2,
    fontWeight: "900",
    color: "#737B87",
    marginBottom: 5,
  },
  msg: { color: "#FFF", lineHeight: 22 },
  userMsg: { color: "#090A0D" },
  speak: { color: "#AEB5C0", fontWeight: "800", fontSize: 12, marginTop: 10 },
  error: { color: "#FF7777", padding: 16 },
  composer: {
    padding: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,.08)",
  },
  input: {
    minHeight: 52,
    maxHeight: 120,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,.06)",
    color: "#FFF",
    padding: 14,
    fontSize: 16,
  },
  send: {
    minHeight: 50,
    borderRadius: 16,
    backgroundColor: "#FFF",
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: "#090A0D", fontWeight: "900", fontSize: 15 },
});
