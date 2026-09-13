import AsyncStorage from "@react-native-async-storage/async-storage";
import { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { api, healthCheck } from "@/lib/api";
import { GlassCard } from "@/components/GlassCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { useAppStore } from "@/store/useAppStore";

export default function Settings() {
  const currentSession = useAppStore((state) => state.sessionId);
  const setSessionId = useAppStore((state) => state.setSessionId);
  const connected = useAppStore((state) => state.apiConnected);
  const setConnected = useAppStore((state) => state.setApiConnected);
  const [session, setSession] = useState(currentSession);

  async function test() {
    try {
      await healthCheck();
      setConnected(true);
      Alert.alert("Connected", String(api.defaults.baseURL));
    } catch {
      setConnected(false);
      Alert.alert("Connection failed", `Could not reach ${api.defaults.baseURL}`);
    }
  }

  async function save() {
    const nextSession = session.trim() || "mobile_001";
    setSessionId(nextSession);
    await AsyncStorage.setItem("xglasses.sessionId", nextSession);
    Alert.alert("Saved", "Session ID updated.");
  }

  return (
    <View style={styles.root}>
      <GlassCard>
        <Text style={styles.label}>BACKEND</Text>
        <Text style={styles.url}>{api.defaults.baseURL}</Text>
        <Text
          style={[styles.status, { color: connected ? "#67F59A" : "#FF7777" }]}
        >
          {connected ? "Connected" : "Offline"}
        </Text>
        <PrimaryButton title="Test Connection" onPress={() => void test()} />
      </GlassCard>

      <GlassCard>
        <Text style={styles.label}>SESSION ID</Text>
        <TextInput
          value={session}
          onChangeText={setSession}
          style={styles.input}
          placeholder="mobile_001"
          placeholderTextColor="#68717E"
        />
        <PrimaryButton title="Save Session" onPress={() => void save()} />
      </GlassCard>

      <GlassCard>
        <Text style={styles.label}>VOICE</Text>
        <Text style={styles.note}>
          English voice commands stay on the Live Vision screen. The app speaks
          only the final sanitized backend reply.
        </Text>
      </GlassCard>

      <Text style={styles.note}>
        Keep only `EXPO_PUBLIC_API_URL` in the mobile `.env`. Do not place any
        OpenAI or model API keys in the frontend app. Use your PC LAN IPv4, not
        `localhost`, and run the backend with `--host 0.0.0.0` so the phone can
        reach it on the same Wi-Fi.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#090A0D", padding: 16, gap: 12 },
  label: {
    color: "#727A87",
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "900",
    marginBottom: 8,
  },
  url: { color: "#FFF", fontWeight: "700", marginBottom: 6 },
  status: { fontWeight: "800", marginBottom: 14 },
  input: {
    height: 52,
    backgroundColor: "rgba(255,255,255,.06)",
    color: "#FFF",
    borderRadius: 15,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  note: { color: "#8D95A1", lineHeight: 21, padding: 3 },
});
