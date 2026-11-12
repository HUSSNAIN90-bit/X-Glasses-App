import { Asset } from "expo-asset";
import { Platform } from "react-native";
import * as jpeg from "jpeg-js";
import { loadTensorflowModel, type TfliteModel } from "react-native-fast-tflite";
import { api, getBackendBaseUrl, type Detection } from "@/lib/api";

type ModelManifest = { model: string; format: string; input_size: number; labels: string[]; sha256: string };
type InputLayout = "NCHW" | "NHWC";
type LoadedModel = { model: TfliteModel; labels: string[]; inputSize: number; inputLayout: InputLayout };
type PreparedInput = { input: ArrayBuffer; width: number; height: number; scale: number; padX: number; padY: number };
type Candidate = { classId: number; score: number; x1: number; y1: number; x2: number; y2: number };

let modelPromise: Promise<LoadedModel> | null = null;
const CONFIDENCE_THRESHOLD = 0.28;
const NMS_IOU_THRESHOLD = 0.45;

function decodeBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/^data:image\/[^;]+;base64,/, "").replace(/\s/g, "");
  const output = new Uint8Array(Math.floor(clean.length * 3 / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    if (char === "=") break;
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (offset < output.length) output[offset++] = (buffer >> bits) & 255;
    }
  }
  return output;
}

async function loadModel(): Promise<LoadedModel> {
  if (Platform.OS !== "android") throw new Error("On-device YOLO26 is currently enabled on Android only.");
  const baseUrl = await getBackendBaseUrl();
  const manifest = (await api.get<ModelManifest>("/api/models/yolo26n/manifest")).data;
  if (manifest.model !== "yolo26n" || manifest.format !== "litert" || !manifest.labels?.length) {
    throw new Error("The backend returned an unsupported YOLO26 model manifest.");
  }
  const asset = Asset.fromURI(`${baseUrl}/api/models/yolo26n.tflite`);
  await asset.downloadAsync();
  const uri = asset.localUri || asset.uri;
  let model: TfliteModel;
  try {
    model = await loadTensorflowModel({ url: uri }, ["android-gpu"]);
  } catch {
    model = await loadTensorflowModel({ url: uri }, []);
  }
  const inputShape = model.inputs[0]?.shape;
  const outputShape = model.outputs[0]?.shape;
  if (!inputShape || inputShape.length !== 4 || !outputShape) {
    throw new Error("YOLO26 LiteRT tensor shapes do not match the expected image detector.");
  }
  let inputLayout: InputLayout;
  let inputSize: number | undefined;
  if (inputShape[1] === 3 && inputShape[3] !== 3) {
    inputLayout = "NCHW";
    inputSize = inputShape[2];
  } else if (inputShape[3] === 3) {
    inputLayout = "NHWC";
    inputSize = inputShape[1];
  } else {
    throw new Error(`Unsupported YOLO26 image tensor layout: ${inputShape.join("x")}`);
  }
  if (!inputSize || inputSize < 32) throw new Error("YOLO26 input tensor has an invalid image size.");
  return { model, labels: manifest.labels, inputSize, inputLayout };
}

async function getModel(): Promise<LoadedModel> {
  if (!modelPromise) {
    modelPromise = loadModel().catch((error) => { modelPromise = null; throw error; });
  }
  const pending = modelPromise;
  if (!pending) throw new Error("YOLO26 model could not be initialized.");
  return pending;
}

function makeLetterboxedInput(base64: string, inputSize: number, dataType: string, layout: InputLayout): PreparedInput {
  const decoded = jpeg.decode(decodeBase64(base64), { useTArray: true });
  if (!decoded.width || !decoded.height || !decoded.data?.length) throw new Error("Camera JPEG could not be decoded.");
  const scale = Math.min(inputSize / decoded.width, inputSize / decoded.height);
  const resizedWidth = Math.max(1, Math.round(decoded.width * scale));
  const resizedHeight = Math.max(1, Math.round(decoded.height * scale));
  const padX = Math.floor((inputSize - resizedWidth) / 2);
  const padY = Math.floor((inputSize - resizedHeight) / 2);
  const pixels = new Uint8Array(inputSize * inputSize * 3);
  pixels.fill(114);
  for (let y = 0; y < resizedHeight; y += 1) {
    const sourceY = Math.min(decoded.height - 1, Math.floor(y / scale));
    for (let x = 0; x < resizedWidth; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(x / scale));
      const sourceOffset = (sourceY * decoded.width + sourceX) * 4;
      const targetOffset = ((y + padY) * inputSize + x + padX) * 3;
      pixels[targetOffset] = decoded.data[sourceOffset] ?? 0;
      pixels[targetOffset + 1] = decoded.data[sourceOffset + 1] ?? 0;
      pixels[targetOffset + 2] = decoded.data[sourceOffset + 2] ?? 0;
    }
  }
  const pixelCount = inputSize * inputSize;
  let input: ArrayBuffer;
  if (dataType === "float32") {
    const floats = new Float32Array(pixels.length);
    if (layout === "NHWC") {
      for (let index = 0; index < pixels.length; index += 1) floats[index] = (pixels[index] ?? 0) / 255;
    } else {
      for (let index = 0; index < pixelCount; index += 1) {
        floats[index] = (pixels[index * 3] ?? 0) / 255;
        floats[pixelCount + index] = (pixels[index * 3 + 1] ?? 0) / 255;
        floats[pixelCount * 2 + index] = (pixels[index * 3 + 2] ?? 0) / 255;
      }
    }
    input = floats.buffer.slice(0) as ArrayBuffer;
  } else if (dataType === "uint8") {
    if (layout === "NHWC") {
      input = pixels.buffer.slice(0) as ArrayBuffer;
    } else {
      const planar = new Uint8Array(pixels.length);
      for (let index = 0; index < pixelCount; index += 1) {
        planar[index] = pixels[index * 3] ?? 0;
        planar[pixelCount + index] = pixels[index * 3 + 1] ?? 0;
        planar[pixelCount * 2 + index] = pixels[index * 3 + 2] ?? 0;
      }
      input = planar.buffer.slice(0) as ArrayBuffer;
    }
  } else {
    throw new Error(`Unsupported YOLO26 input tensor type: ${dataType}`);
  }
  return { input, width: decoded.width, height: decoded.height, scale, padX, padY };
}

function boxIou(a: Candidate, b: Candidate) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(candidates: Candidate[]) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const candidate of sorted) {
    if (kept.every((other) => other.classId !== candidate.classId || boxIou(candidate, other) <= NMS_IOU_THRESHOLD)) {
      kept.push(candidate);
    }
    if (kept.length >= 20) break;
  }
  return kept;
}

function toDetection(candidate: Candidate, labels: string[], prepared: PreparedInput): Detection | null {
  const x1 = Math.max(0, Math.min(prepared.width, (candidate.x1 - prepared.padX) / prepared.scale));
  const y1 = Math.max(0, Math.min(prepared.height, (candidate.y1 - prepared.padY) / prepared.scale));
  const x2 = Math.max(0, Math.min(prepared.width, (candidate.x2 - prepared.padX) / prepared.scale));
  const y2 = Math.max(0, Math.min(prepared.height, (candidate.y2 - prepared.padY) / prepared.scale));
  if (x2 <= x1 || y2 <= y1) return null;
  const centerX = (x1 + x2) / 2 / prepared.width;
  const centerY = (y1 + y2) / 2 / prepared.height;
  return {
    class_name: labels[candidate.classId] ?? `object ${candidate.classId}`,
    confidence: candidate.score,
    x1, y1, x2, y2,
    relative_position: centerX < 0.33 ? "left" : centerX > 0.66 ? "right" : "center",
    vertical_position: centerY < 0.33 ? "top" : centerY > 0.66 ? "bottom" : "middle",
  };
}

function decodeEndToEnd(values: Float32Array, rows: number, inputSize: number): Candidate[] {
  const candidates: Candidate[] = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = row * 6;
    const score = values[offset + 4] ?? Number.NaN;
    if (!Number.isFinite(score) || score < CONFIDENCE_THRESHOLD) continue;
    const classId = Math.round(values[offset + 5] ?? -1);
    let x1 = values[offset] ?? 0;
    let y1 = values[offset + 1] ?? 0;
    let x2 = values[offset + 2] ?? 0;
    let y2 = values[offset + 3] ?? 0;
    if (Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2)) <= 1.5) {
      x1 *= inputSize; y1 *= inputSize; x2 *= inputSize; y2 *= inputSize;
    }
    candidates.push({ classId, score, x1, y1, x2, y2 });
  }
  return candidates;
}

function decodeRawOneToMany(values: Float32Array, channels: number, anchors: number, inputSize: number, channelFirst: boolean): Candidate[] {
  if (channels < 5) throw new Error(`Unsupported YOLO26 raw output shape: ${channels}x${anchors}`);
  const candidates: Candidate[] = [];
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let score = 0;
    let classId = -1;
    for (let channel = 4; channel < channels; channel += 1) {
      const classScore = values[channelFirst ? channel * anchors + anchor : anchor * channels + channel] ?? 0;
      if (classScore > score) { score = classScore; classId = channel - 4; }
    }
    if (score < CONFIDENCE_THRESHOLD) continue;
    const read = (channel: number) => values[channelFirst ? channel * anchors + anchor : anchor * channels + channel] ?? 0;
    let centerX = read(0);
    let centerY = read(1);
    let width = read(2);
    let height = read(3);
    if (Math.max(Math.abs(centerX), Math.abs(centerY), Math.abs(width), Math.abs(height)) <= 1.5) {
      centerX *= inputSize; centerY *= inputSize; width *= inputSize; height *= inputSize;
    }
    candidates.push({
      classId,
      score,
      x1: centerX - width / 2,
      y1: centerY - height / 2,
      x2: centerX + width / 2,
      y2: centerY + height / 2,
    });
  }
  return nonMaximumSuppression(candidates);
}

export async function detectObjectsOnDevice(base64: string): Promise<Detection[]> {
  const { model, labels, inputSize, inputLayout } = await getModel();
  const inputTensor = model.inputs[0];
  const outputTensor = model.outputs[0];
  if (!inputTensor || !outputTensor) throw new Error("YOLO26 model is missing an input or output tensor.");
  const prepared = makeLetterboxedInput(base64, inputSize, inputTensor.dataType, inputLayout);
  const outputs = await model.run([prepared.input]);
  const outputBuffer = outputs[0];
  if (!outputBuffer) throw new Error("YOLO26 did not return an output tensor.");
  if (outputTensor.dataType !== "float32") throw new Error(`Unsupported YOLO26 output type: ${outputTensor.dataType}`);
  const values = new Float32Array(outputBuffer);
  const shape = outputTensor.shape;
  const channels = shape[shape.length - 2] ?? 0;
  const columns = shape[shape.length - 1] ?? 0;
  let candidates: Candidate[];
  if (columns === 6) {
    candidates = decodeEndToEnd(values, channels, inputSize);
  } else if (channels >= 5 && columns > 6) {
    candidates = decodeRawOneToMany(values, channels, columns, inputSize, true);
  } else if (columns >= 5 && channels > 6) {
    candidates = decodeRawOneToMany(values, columns, channels, inputSize, false);
  } else {
    throw new Error(`Unexpected YOLO26 output tensor shape: ${shape.join("x")}`);
  }
  return nonMaximumSuppression(candidates)
    .map((candidate) => toDetection(candidate, labels, prepared))
    .filter((item): item is Detection => item !== null)
    .slice(0, 20);
}

export function formatLocalDetections(detections: Detection[]) {
  if (!detections.length) return "I could not identify a clear object in the camera view.";
  const descriptions = detections.slice(0, 6).map((item) => {
    const confidence = Math.round(item.confidence * 100);
    const horizontal = item.relative_position === "center" ? "in front" : `to your ${item.relative_position}`;
    const vertical = item.vertical_position && item.vertical_position !== "middle" ? `, ${item.vertical_position}` : "";
    return `${item.class_name} ${horizontal}${vertical} (${confidence}% confidence)`;
  });
  return `On-device YOLO detected ${detections.length} object${detections.length === 1 ? "" : "s"}. ${descriptions.join("; ")}.`;
}
