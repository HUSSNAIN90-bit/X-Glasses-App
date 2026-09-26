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

async function encryptionKey() {
  let key = await SecureStore.getItemAsync(KEY_KEY);
  if (!key) {
    key = Crypto.randomUUID();
    await SecureStore.setItemAsync(KEY_KEY, key, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }
  return key;
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
  if (!NitroRecognizer.isSupported()) {
    throw new Error("On-device face recognition is only available on Android and iOS.");
  }

  if (NitroRecognizer.isModelReady()) return true;

  const modelAsset = Asset.fromModule(
    require("../assets/models/mobile_facenet.tflite"),
  );
  await modelAsset.downloadAsync();

  const modelUri = modelAsset.localUri ?? modelAsset.uri;
  if (!modelUri) {
    throw new Error("The bundled MobileFaceNet model could not be located.");
  }

  const loaded = await NitroRecognizer.loadModel(modelUri);
  if (!loaded) throw new Error("The on-device face model could not be loaded.");
  return true;
}

async function extractFaceEmbeddings(imageUris: string[]) {
  const embeddings: Array<{ frame: number; vector: number[] }> = [];

  for (let frame = 0; frame < imageUris.length; frame += 1) {
    const crops = await NitroFace.cropFaces(imageUris[frame], 0.28);
    if (crops.length !== 1) continue;

    const result = await NitroRecognizer.extractEmbedding(crops[0].uri);
    if (result?.vector?.length) {
      embeddings.push({ frame, vector: normalize(result.vector) });
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
  if (!vectors.length) return [];
  const size = vectors[0].length;
  const result = new Array<number>(size).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < size; i += 1) result[i] += vector[i] ?? 0;
  }
  return normalize(result.map((value) => value / vectors.length));
}

function cosine(a: number[], b: number[]) {
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < size; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
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
  await initializeFaceRecognition();

  const embeddings = await extractFaceEmbeddings(imageUris.slice(0, 8));
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
      const embeddingResult = await NitroRecognizer.extractEmbedding(crops[faceIndex].uri);
      const probe = normalize(embeddingResult.vector);

      const ranked = people
        .map((person) => ({
          person,
          similarity: cosine(probe, person.embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity);

      const best = ranked[0];
      const second = ranked[1];
      const recognized =
        Boolean(best) &&
        best.similarity >= MATCH_THRESHOLD &&
        (!second || best.similarity - second.similarity >= MIN_MARGIN);

      matches.push({
        faceIndex,
        name: recognized ? best.person.name : null,
        relationship: recognized ? best.person.relationship : undefined,
        similarity: best?.similarity ?? null,
        recognized,
      });
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
