import { Asset } from "expo-asset";
import { Platform } from "react-native";
import * as jpeg from "jpeg-js";
import { loadTensorflowModel, type TfliteModel } from "react-native-fast-tflite";
import { api, getBackendBaseUrl, type Detection } from "@/lib/api";

type ModelManifest = {
  model: string;
  format: string;
  input_size: number;
  labels: string[];
  sha256: string;
};

let modelPromise: Promise<{ model: TfliteModel; labels: string[]; inputSize: number }> | null = null;
const CONFIDENCE_THRESHOLD = 0.28;

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

async function loadModel() {
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
  if (!inputShape || inputShape.length !== 4 || inputShape[3] !== 3 || !outputShape) {
    throw new Error("YOLO26 LiteRT tensor shapes do not match the expected image detector.");
  }
  return { model, labels: manifest.labels, inputSize: inputShape[1] };
}

async function getModel() {
  if (!modelPromise) {
    modelPromise = loadModel().catch((error) => { modelPromise = null; throw error; });
  }
  return modelPromise;
}

function makeLetterboxedInput(base64: string, inputSize: number, dataType: string) {
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
      pixels[targetOffset] = decoded.data[sourceOffset];
      pixels[targetOffset + 1] = decoded.data[sourceOffset + 1];
      pixels[targetOffset + 2] = decoded.data[sourceOffset + 2];
    }
  }
  let input: ArrayBuffer;
  if (dataType === "float32") {
    const floats = new Float32Array(pixels.length);
    for (let index = 0; index < pixels.length; index += 1) floats[index] = pixels[index] / 255;
    input = floats.buffer.slice(0) as ArrayBuffer;
  } else if (dataType === "uint8") {
    input = pixels.buffer.slice(0) as ArrayBuffer;
  } else {
    throw new Error(`Unsupported YOLO26 input tensor type: ${dataType}`);
  }
  return { input, width: decoded.width, height: decoded.height, scale, padX, padY };
}

function describePosition(x: number, y: number) {
  const horizontal = x < 0.33 ? "left" : x > 0.66 ? "right" : "center";
  const vertical = y < 0.33 ? "top" : y > 0.66 ? "bottom" : "middle";
  return { horizontal, vertical };
}

export async function detectObjectsOnDevice(base64: string): Promise<Detection[]> {
  const { model, labels, inputSize } = await getModel();
  const inputTensor = model.inputs[0];
  const prepared = makeLetterboxedInput(base64, inputSize, inputTensor.dataType);
  const outputs = await model.run([prepared.input]);
  const outputTensor = model.outputs[0];
  if (outputTensor.dataType !== "float32") throw new Error(`Unsupported YOLO26 output type: ${outputTensor.dataType}`);
  const values = new Float32Array(outputs[0]);
  const shape = outputTensor.shape;
  const columns = shape[shape.length - 1];
  const rows = shape[shape.length - 2];
  if (columns !== 6 || values.length < rows * 6) {
    throw new Error(`Unexpected YOLO26 output tensor shape: ${shape.join("x")}`);
  }
  const detections: Detection[] = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = row * 6;
    const score = values[offset + 4];
    if (!Number.isFinite(score) || score < CONFIDENCE_THRESHOLD) continue;
    const classId = Math.round(values[offset + 5]);
    const x1 = Math.max(0, Math.min(prepared.width, (values[offset] - prepared.padX) / prepared.scale));
    const y1 = Math.max(0, Math.min(prepared.height, (values[offset + 1] - prepared.padY) / prepared.scale));
    const x2 = Math.max(0, Math.min(prepared.width, (values[offset + 2] - prepared.padX) / prepared.scale));
    const y2 = Math.max(0, Math.min(prepared.height, (values[offset + 3] - prepared.padY) / prepared.scale));
    if (x2 <= x1 || y2 <= y1) continue;
    const position = describePosition((x1 + x2) / 2 / prepared.width, (y1 + y2) / 2 / prepared.height);
    detections.push({
      class_name: labels[classId] ?? `object ${classId}`,
      confidence: score, x1, y1, x2, y2,
      relative_position: position.horizontal,
      vertical_position: position.vertical,
    });
  }
  return detections.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
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
