import AsyncStorage from "@react-native-async-storage/async-storage";
import { Asset } from "expo-asset";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import CryptoJS from "crypto-js";
import { NitroFace } from "@nitro-mlkit/face-detection";
import { NitroRecognizer } from "@nitro-mlkit/face-recognition";

export type LocalFacePerson = {
  id: string;
  name: string;
  relationship?: string;
  embedding: number[];
  sampleCount: number;
  createdAt: string;
};

export type LocalFaceMatch = {
  faceIndex: number;
  name: string | null;
  relationship?: string;
  similarity: number | null;
  recognized: boolean;
};

const INDEX_KEY = "xglasses.face.people.index";
const KEY_KEY = "xglasses.face.aes.key";
const PROFILE_PREFIX = "xglasses.face.profile.";
const MATCH_THRESHOLD = 0.68;
const MIN_MARGIN = 0.04;
const MAX_ENROLL_SAMPLES = 5;

async function generateSecureEncryptionKey() {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(): Promise<string> {
  let key = (await SecureStore.getItemAsync(KEY_KEY)) ?? null;
  const needsReplacement = !key || key.length !== 64 || !/^[0-9a-f]+$/i.test(key);

  if (needsReplacement) {
    key = await generateSecureEncryptionKey();
    await SecureStore.setItemAsync(KEY_KEY, key, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    console.log("[XGLASSES_FACE] encryption key generated");
  }

  return key as string;
}

async function saveProfile(profile: LocalFacePerson) {
  const key = await encryptionKey();
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(profile), key).toString();
  await AsyncStorage.setItem(PROFILE_PREFIX + profile.id, encrypted);
  const rawIndex = await AsyncStorage.getItem(INDEX_KEY);
  const ids: string[] = rawIndex ? JSON.parse(rawIndex) : [];
  if (!ids.includes(profile.id)) {
    ids.push(profile.id);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(ids));
  }
  console.log(`[XGLASSES_FACE] profile saved: samples=${profile.sampleCount}`);
}

export async function listLocalFacePeople(): Promise<LocalFacePerson[]> {
  const rawIndex = await AsyncStorage.getItem(INDEX_KEY);
  const ids: string[] = rawIndex ? JSON.parse(rawIndex) : [];
  const key = await encryptionKey();
  const people: LocalFacePerson[] = [];

  for (const id of ids) {
    const encrypted = await AsyncStorage.getItem(PROFILE_PREFIX + id);
    if (!encrypted) continue;
    try {
      const bytes = CryptoJS.AES.decrypt(encrypted, key);
      const decoded = bytes.toString(CryptoJS.enc.Utf8);
      if (decoded) people.push(JSON.parse(decoded) as LocalFacePerson);
    } catch {}
  }

  return people;
}

export async function deleteLocalFacePerson(id: string) {
  await AsyncStorage.removeItem(PROFILE_PREFIX + id);
  const rawIndex = await AsyncStorage.getItem(INDEX_KEY);
  const ids: string[] = rawIndex ? JSON.parse(rawIndex) : [];
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(ids.filter((value) => value !== id)));
}

export async function initializeFaceRecognition() {
  console.log("[XGLASSES_FACE] initializing recognizer");

  if (!NitroRecognizer.isSupported()) {
    throw new Error("On-device face recognition is only available on Android and iOS.");
  }

  if (NitroRecognizer.isModelReady()) {
    console.log("[XGLASSES_FACE] model already loaded");
    return true;
  }

  // The Nitro recognizer expects a MobileFaceNet-style RGB input tensor shaped
  // [1, 112, 112, 3] and a fixed 192-d embedding output. Do not use the other
  // paired model variant bundled in this repo, which uses a different tensor layout.
  const modelAsset = Asset.fromModule(
    require("../assets/models/mobile_face_net.tflite"),
  );
  await modelAsset.downloadAsync();

  const modelUri = modelAsset.localUri ?? modelAsset.uri;
  if (!modelUri) {
    throw new Error("The bundled MobileFaceNet model could not be located.");
  }

  console.log("[XGLASSES_FACE] model loading", modelUri);
  const loaded = await NitroRecognizer.loadModel(modelUri);
  if (!loaded) throw new Error("The on-device face model could not be loaded.");
  console.log("[XGLASSES_FACE] model loaded");
  return true;
}

async function extractFaceEmbeddings(imageUris: string[]) {
  const embeddings: Array<{ frame: number; vector: number[] }> = [];

  for (let frame = 0; frame < imageUris.length; frame += 1) {
    const uri = imageUris[frame];
    if (!uri) continue;

    const crops = await NitroFace.cropFaces(uri, 0.28);
    console.log("[XGLASSES_FACE] faces detected:", crops.length);
    if (crops.length !== 1) continue;

    const crop = crops[0];
    if (!crop) continue;

    const result = await NitroRecognizer.extractEmbedding(crop.uri);
    if (result?.vector) {
      console.log("[XGLASSES_FACE] embedding dimension:", result.vector.length);
      if (result.vector.length) {
        embeddings.push({ frame, vector: normalize(result.vector) });
      }
    }
  }

  return embeddings;
}

function normalize(vector: number[]) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  return vector.map((value) => value / length);
}

function averageVectors(vectors: number[][]) {
  if (!vectors.length || !vectors[0]?.length) return [];
  const size = vectors[0].length;
  const result = new Array<number>(size).fill(0);
  for (const vector of vectors) {
    if (!vector) continue;
    for (let i = 0; i < size; i += 1) {
      const value = vector[i] ?? 0;
      result[i] = (result[i] ?? 0) + value;
    }
  }
  return normalize(result.map((value) => value / vectors.length));
}

function cosine(a: number[], b: number[]) {
  if (!a.length || !b.length) return 0;
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < size; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  if (!aa || !bb) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

function personId(name: string) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `person-${Date.now()}`
  );
}

export async function enrollLocalFace(
  name: string,
  relationship: string | undefined,
  imageUris: string[],
) {
  console.log("[XGLASSES_FACE] enrollment started");
  await initializeFaceRecognition();

  const embeddings = await extractFaceEmbeddings(imageUris.slice(0, 8));
  console.log("[XGLASSES_FACE] valid embeddings:", embeddings.length);
  if (embeddings.length < 3) {
    throw new Error("I need at least 3 clear face views. Look straight at the camera and try again.");
  }

  const vector = averageVectors(
    embeddings.slice(0, MAX_ENROLL_SAMPLES).map((item) => item.vector),
  );
  const id = personId(name);

  const profile: LocalFacePerson = {
    id,
    name,
    relationship: relationship?.trim() || undefined,
    embedding: vector,
    sampleCount: embeddings.length,
    createdAt: new Date().toISOString(),
  };

  await saveProfile(profile);
  return profile;
}

export async function recognizeLocalFaces(imageUris: string[]): Promise<LocalFaceMatch[]> {
  await initializeFaceRecognition();

  const people = await listLocalFacePeople();
  if (!people.length) return [];

  const matches: LocalFaceMatch[] = [];

  for (const uri of imageUris.slice(0, 3)) {
    const crops = await NitroFace.cropFaces(uri, 0.28);

    for (let faceIndex = 0; faceIndex < crops.length; faceIndex += 1) {
      const crop = crops[faceIndex];
      if (!crop) continue;

      const embeddingResult = await NitroRecognizer.extractEmbedding(crop.uri);
      const probe = normalize(embeddingResult.vector);

      const ranked = people
        .map((person) => ({
          person,
          similarity: cosine(probe, person.embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity);
      ranked.forEach((candidate, candidateIndex) => {
        console.log(
          `[XGLASSES_FACE] recognition similarity: face=${faceIndex} candidate=${candidateIndex} score=${candidate.similarity.toFixed(4)}`,
        );
      });

      const best = ranked[0] ?? null;
      const second = ranked[1] ?? null;
      if (!best) continue;

      const recognized =
        best.similarity >= MATCH_THRESHOLD &&
        (!second || best.similarity - second.similarity >= MIN_MARGIN);

      matches.push({
        faceIndex,
        name: recognized ? best.person.name : null,
        relationship: recognized ? best.person.relationship : undefined,
        similarity: best.similarity,
        recognized,
      });
      console.log(
        `[XGLASSES_FACE] recognition result: face=${faceIndex} recognized=${recognized}`,
      );
    }

    if (matches.length) break;
  }

  return matches;
}

export function isFaceIdentityCommand(command: string) {
  const value = command.toLowerCase().replace(/[?!.]/g, " ").replace(/\s+/g, " ").trim();
  return (
    /\bwho is (in front of me|this|that|there)\b/.test(value) ||
    /\bwho(?:'s| is) (this person|that person|in front of me)\b/.test(value) ||
    /\bdo you know (this|that) person\b/.test(value) ||
    /\bidentify (this|that) person\b/.test(value) ||
    /\brecognize (this|that) person\b/.test(value)
  );
}

export async function answerLocalFaceCommand(imageUris: string[]) {
  const matches = await recognizeLocalFaces(imageUris);

  if (!matches.length) return "I don't see a clear face.";
  const unique = new Map<string, LocalFaceMatch>();
  for (const match of matches) {
    if (match.recognized && match.name) unique.set(match.name, match);
  }

  if (!unique.size) {
    return matches.length === 1
      ? "I don't recognize this person."
      : "I can see the people, but I don't recognize them.";
  }

  const names = Array.from(unique.values()).map((match) =>
    match.relationship ? `${match.name}, your ${match.relationship}` : match.name!,
  );

  if (names.length === 1) return `${names[0]} is in front of you.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in front of you.`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]} are in front of you.`;
}
