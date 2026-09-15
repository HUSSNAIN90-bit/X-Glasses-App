import { CameraView, useCameraPermissions } from "expo-camera";
import * as Speech from "expo-speech";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { analyzeCommandMulti, CommandResponse, enrollFaceMulti } from "@/lib/api";
import { AssistantStatus, cleanAssistantText, toUserFacingAssistantError } from "@/lib/assistant";
import { GlassCard } from "@/components/GlassCard";
import { PrimaryButton } from "@/components/PrimaryButton";
import { useAppStore } from "@/store/useAppStore";

type SpeechRecognitionModule = { abort: () => void; stop: () => void; isRecognitionAvailable: () => boolean; start: (options: { lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number }) => void; requestPermissionsAsync: () => Promise<{ granted: boolean }> };
type SpeechRecognitionPackage = { ExpoSpeechRecognitionModule: SpeechRecognitionModule; useSpeechRecognitionEvent: (event: string, listener: (payload: { error?: string; isFinal?: boolean; message?: string; results?: Array<{ transcript?: string }> }) => void) => void };
let speechRecognition: SpeechRecognitionPackage | null = null;
try { speechRecognition = require("expo-speech-recognition"); } catch {}

const QUICK_COMMANDS = ["What is in front of me?", "Identify this product.", "Read the label and price.", "Who is this person?"];
const MAX_CAPTURE_ATTEMPTS = 2;
const ENROLLMENT_CAPTURE_FRAMES = 6;

function needsAnotherFrameBatch(response: CommandResponse) {
  const processing = response.processing;
  return Boolean(processing?.quality_checked && processing.ai_called === false && processing.frame_quality?.length && processing.frame_quality.every((frame) => !frame.good));
}

function parseEnrollmentCommand(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim();
  const relationships = "friend|frnd|brother|sister|mother|father|wife|husband|colleague|coworker|teacher";
  const relationMatch = normalized.match(new RegExp(`\\b(?:this(?:\\s+person)?\\s+is|he\\s+is|she\\s+is|they\\s+are|meet)\\s+(?:my\\s+)?(${relationships})\\s*[,:]?\\s*(?:named\\s+)?([A-Za-z][A-Za-z' -]{0,48})(?:[.!?]|$)`, "i"));
  if (relationMatch) return { name: relationMatch[2].trim().replace(/[.!?]+$/, ""), relationship: relationMatch[1].toLowerCase().replace("frnd", "friend") };
  const nameMatch = normalized.match(/\b(?:this(?:\s+person)?\s+is|he\s+is|she\s+is|they\s+are|meet)\s+(?:named\s+)?([A-Za-z][A-Za-z' -]{0,48})(?:[.!?]|$)/i);
  if (nameMatch) return { name: nameMatch[1].trim(), relationship: undefined };
  const saveMatch = normalized.match(/\b(?:remember|save|introduce)\s+(?:this\s+(?:person|face)|him|her|them)\s+(?:as|is)\s+(?:(?:my\s+)?(friend|frnd|brother|sister|mother|father|wife|husband|colleague|coworker|teacher)\s+)?([A-Za-z][A-Za-z' -]{0,48})(?:[.!?]|$)/i);
  if (saveMatch) return { name: saveMatch[2].trim(), relationship: saveMatch[1]?.toLowerCase().replace("frnd", "friend") };
  return null;
}

export default function Camera() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null); const scrollRef = useRef<ScrollView>(null); const inputRef = useRef<TextInput>(null); const inFlightRef = useRef(false); const preferredVoiceRef = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false); const [command, setCommand] = useState(""); const [answer, setAnswer] = useState<CommandResponse | null>(null); const [notice, setNotice] = useState(""); const [recognizing, setRecognizing] = useState(false); const [status, setStatus] = useState<AssistantStatus>("idle");
  const session = useAppStore((state) => state.sessionId);

  if (speechRecognition) {
    speechRecognition.useSpeechRecognitionEvent("start", () => { setRecognizing(true); if (!inFlightRef.current) setStatus("listening"); });
    speechRecognition.useSpeechRecognitionEvent("end", () => { setRecognizing(false); if (!inFlightRef.current) setStatus("idle"); });
    speechRecognition.useSpeechRecognitionEvent("result", (event) => { const transcript = event.results?.[0]?.transcript?.trim() ?? ""; if (event.isFinal && transcript && !inFlightRef.current) { setCommand(transcript); void runCommand(transcript); } });
    speechRecognition.useSpeechRecognitionEvent("error", (event) => { setRecognizing(false); if (event.error === "aborted" || inFlightRef.current) return; setStatus("error"); setNotice(cleanAssistantText(event.message) || "Voice recognition failed."); });
  }

  useEffect(() => { void choosePreferredVoice(); return () => { try { speechRecognition?.ExpoSpeechRecognitionModule.abort(); } catch {} Speech.stop(); }; }, []);
  async function choosePreferredVoice() { try { const voices = await Speech.getAvailableVoicesAsync(); const englishVoices = voices.filter((voice) => voice.language.toLowerCase().startsWith("en")); preferredVoiceRef.current = (englishVoices.find((voice) => voice.quality === "Enhanced") ?? englishVoices[0])?.identifier; } catch {} }
  function scrollToBottom(animated = true) { requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated })); }

  async function captureCommandFrames(count = 3) {
    if (!cameraRef.current) throw new Error("Camera is not ready.");
    const uris: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.72, skipProcessing: true });
      if (photo?.uri) uris.push(photo.uri);
      if (index < count - 1) await new Promise((resolve) => setTimeout(resolve, 70));
    }
    if (!uris.length) throw new Error("Camera did not return a frame.");
    return uris;
  }

  function speakFinalReply(text: string) { const spoken = cleanAssistantText(text); if (!spoken) { setStatus("idle"); return; } setStatus("speaking"); Speech.stop(); Speech.speak(spoken, { rate: 0.94, pitch: 1.0, voice: preferredVoiceRef.current, onDone: () => setStatus("idle"), onStopped: () => setStatus("idle"), onError: () => setStatus("idle") }); }

  async function runCommand(nextCommand = command) {
    const trimmedCommand = nextCommand.trim(); if (!trimmedCommand || inFlightRef.current || !cameraRef.current) return;
    Keyboard.dismiss(); inFlightRef.current = true; setBusy(true); setStatus("capturing"); setNotice(""); setAnswer(null);
    try {
      const enrollment = parseEnrollmentCommand(trimmedCommand);
      if (enrollment) {
        setNotice("Saving clear face views automatically…"); scrollToBottom();
        const uris = await captureCommandFrames(ENROLLMENT_CAPTURE_FRAMES);
        setStatus("processing");
        const result = await enrollFaceMulti(enrollment.name, enrollment.relationship, uris);
        const reply = cleanAssistantText(result.reply) || "I couldn't complete face enrollment."; setNotice(reply); scrollToBottom(); speakFinalReply(reply); return;
      }
      let response: CommandResponse | null = null;
      for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        const uris = await captureCommandFrames(3); setStatus("processing"); response = await analyzeCommandMulti(session, trimmedCommand, uris, "en");
        if (!needsAnotherFrameBatch(response) || attempt === MAX_CAPTURE_ATTEMPTS - 1) break;
        setStatus("capturing"); setNotice("The view was unclear. Capturing a clearer set of frames.");
      }
      const reply = cleanAssistantText(response?.reply) || "Sorry, I couldn't analyze that image."; setAnswer({ ...response!, reply }); setNotice(reply); scrollToBottom(); speakFinalReply(reply);
    } catch (error) { const message = toUserFacingAssistantError(error); setNotice(message); setStatus("error"); scrollToBottom(); speakFinalReply(message); }
    finally { inFlightRef.current = false; setBusy(false); }
  }

  async function startVoice() { setNotice(""); if (!speechRecognition) { setStatus("error"); setNotice("Voice recognition requires an Expo development build."); return; } try { if (!speechRecognition.ExpoSpeechRecognitionModule.isRecognitionAvailable()) throw new Error("Speech recognition is unavailable on this device."); const speechPermission = await speechRecognition.ExpoSpeechRecognitionModule.requestPermissionsAsync(); if (!speechPermission.granted) throw new Error("Microphone and speech-recognition permission is required."); speechRecognition.ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: true, continuous: false, maxAlternatives: 1 }); } catch (error) { setStatus("error"); setNotice(cleanAssistantText(error instanceof Error ? error.message : "") || "Unable to start voice recognition."); } }

  if (!permission) return <View style={styles.center}><ActivityIndicator color="#FFF" /></View>;
  if (!permission.granted) return <View style={styles.center}><Text style={styles.title}>Camera permission required</Text><PrimaryButton title="Allow Camera" onPress={() => void requestPermission()} /></View>;
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}>
    <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"} showsVerticalScrollIndicator={false} automaticallyAdjustKeyboardInsets>
      <View style={styles.headerRow}><View><Text style={styles.brand}>X-GLASSES</Text><Text style={styles.subtitle}>See it. Ask it. Hear it.</Text></View><View style={styles.statusPill}><View style={[styles.statusDot, status === "error" && styles.statusDotError]} /><Text style={styles.statusText}>{status.toUpperCase()}</Text></View></View>
      <View style={styles.camWrap}><CameraView ref={cameraRef} style={styles.cam} facing="back" animateShutter={false} /><View style={styles.liveBadge}><View style={styles.liveDot} /><Text style={styles.badgeText}>LIVE</Text></View><View style={styles.cameraHint}><Text style={styles.cameraHintText}>Point the camera at what you want X to see</Text></View></View>
      <GlassCard><View style={styles.askHeader}><Text style={styles.label}>ASK X</Text><Text style={styles.voiceHint}>Voice or text</Text></View><TextInput ref={inputRef} value={command} onChangeText={setCommand} placeholder="What do you want to know?" placeholderTextColor="#68717E" style={styles.input} multiline scrollEnabled blurOnSubmit={false} returnKeyType="default" onFocus={() => setTimeout(() => scrollToBottom(true), 120)} /><View style={styles.actions}><Pressable disabled={busy || !command.trim()} onPress={() => void runCommand()} style={[styles.capture, (!command.trim() || busy) && styles.disabled]}><Text style={styles.captureText}>{busy ? "WORKING…" : "ASK X"}</Text></Pressable><Pressable disabled={busy} onPress={recognizing ? () => speechRecognition?.ExpoSpeechRecognitionModule.stop() : () => void startVoice()} style={[styles.mic, recognizing && styles.micOn]}><Text style={styles.micText}>{recognizing ? "STOP" : "MIC"}</Text></Pressable></View><Text style={styles.hint}>{status === "listening" ? "Listening… say your command normally." : status === "capturing" ? "Capturing the best camera frames…" : status === "processing" ? "X is analyzing the view…" : status === "speaking" ? "X is speaking…" : "Try: “What is this?” or “Read the price.”"}</Text></GlassCard>
      <View style={styles.quickHeader}><Text style={styles.sectionTitle}>QUICK ASK</Text><Text style={styles.sectionHint}>Swipe</Text></View><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">{QUICK_COMMANDS.map((quickCommand) => <Pressable key={quickCommand} disabled={busy} onPress={() => { setCommand(quickCommand); void runCommand(quickCommand); }} style={styles.chip}><Text style={styles.chipText}>{quickCommand}</Text></Pressable>)}</ScrollView>
      {answer || notice ? <Result text={answer?.reply ?? notice} /> : <GlassCard><Text style={styles.muted}>Your answer will appear here. X only analyzes when you ask.</Text></GlassCard>}<View style={styles.bottomSpace} />
    </ScrollView>
  </KeyboardAvoidingView>;
}
function Result({ text }: { text: string }) { return <GlassCard><View style={styles.resultHeader}><Text style={styles.label}>X-GLASSES</Text><Text style={styles.resultLive}>ANSWER</Text></View><Text style={styles.answer}>{text}</Text></GlassCard>; }
const styles = StyleSheet.create({ root:{flex:1,backgroundColor:"#090A0D"},scroll:{flex:1},content:{padding:16,paddingTop:14,paddingBottom:40,gap:14},headerRow:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:2},brand:{color:"#FFF",fontSize:20,fontWeight:"900",letterSpacing:2.4},subtitle:{color:"#737C88",fontSize:12,marginTop:3},statusPill:{flexDirection:"row",alignItems:"center",gap:7,paddingHorizontal:10,paddingVertical:7,borderRadius:16,backgroundColor:"rgba(255,255,255,.06)",borderWidth:1,borderColor:"rgba(255,255,255,.08)"},statusDot:{width:7,height:7,borderRadius:4,backgroundColor:"#7CFF9B"},statusDotError:{backgroundColor:"#FF5E6C"},statusText:{color:"#AAB2BD",fontSize:10,fontWeight:"800",letterSpacing:1},camWrap:{height:300,borderRadius:24,overflow:"hidden",backgroundColor:"#111318",borderWidth:1,borderColor:"rgba(255,255,255,.08)"},cam:{flex:1},liveBadge:{position:"absolute",top:12,left:12,flexDirection:"row",alignItems:"center",gap:6,paddingHorizontal:9,paddingVertical:6,borderRadius:12,backgroundColor:"rgba(0,0,0,.58)"},liveDot:{width:6,height:6,borderRadius:3,backgroundColor:"#FF5666"},badgeText:{color:"#FFF",fontSize:10,fontWeight:"900",letterSpacing:1},cameraHint:{position:"absolute",left:14,right:14,bottom:12,paddingHorizontal:12,paddingVertical:9,borderRadius:12,backgroundColor:"rgba(0,0,0,.48)"},cameraHintText:{color:"#E7EBF0",fontSize:12},askHeader:{flexDirection:"row",justifyContent:"space-between",alignItems:"center"},label:{color:"#FFF",fontSize:11,fontWeight:"900",letterSpacing:1.7},voiceHint:{color:"#69727E",fontSize:11},input:{marginTop:10,minHeight:52,maxHeight:125,borderRadius:16,borderWidth:1,borderColor:"rgba(255,255,255,.08)",backgroundColor:"rgba(255,255,255,.035)",color:"#FFF",paddingHorizontal:14,paddingVertical:12,fontSize:15,textAlignVertical:"top"},actions:{flexDirection:"row",gap:10,marginTop:10},capture:{flex:1,minHeight:48,borderRadius:15,backgroundColor:"#FFF",alignItems:"center",justifyContent:"center"},captureText:{color:"#08090B",fontSize:12,fontWeight:"900",letterSpacing:1.1},mic:{width:78,minHeight:48,borderRadius:15,borderWidth:1,borderColor:"rgba(255,255,255,.12)",alignItems:"center",justifyContent:"center",backgroundColor:"rgba(255,255,255,.05)"},micOn:{backgroundColor:"rgba(255,90,100,.16)",borderColor:"rgba(255,90,100,.35)"},micText:{color:"#FFF",fontSize:11,fontWeight:"900",letterSpacing:1},disabled:{opacity:.45},hint:{color:"#66707C",fontSize:11,lineHeight:16,marginTop:9},quickHeader:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",paddingHorizontal:2},sectionTitle:{color:"#9099A5",fontSize:10,fontWeight:"900",letterSpacing:1.5},sectionHint:{color:"#56606C",fontSize:10},chips:{gap:8,paddingRight:8},chip:{paddingHorizontal:14,paddingVertical:10,borderRadius:14,backgroundColor:"rgba(255,255,255,.045)",borderWidth:1,borderColor:"rgba(255,255,255,.07)"},chipText:{color:"#DCE1E7",fontSize:12},resultHeader:{flexDirection:"row",justifyContent:"space-between",marginBottom:10},resultLive:{color:"#6F7884",fontSize:10,fontWeight:"800",letterSpacing:1.3},answer:{color:"#F3F5F7",fontSize:15,lineHeight:23},muted:{color:"#68717D",fontSize:13,lineHeight:20},bottomSpace:{height:20},center:{flex:1,backgroundColor:"#090A0D",alignItems:"center",justifyContent:"center",padding:24},title:{color:"#FFF",fontSize:18,fontWeight:"800",marginBottom:14}
});
