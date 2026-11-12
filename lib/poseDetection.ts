import { NitroPose } from "@nitro-mlkit/pose-detection";

export type PoseLandmark = { type: number; x: number; y: number; z: number; inFrameLikelihood: number };
export type PoseAnalysis = {
  detected: boolean;
  posture: "standing" | "sitting" | "bending" | "unknown";
  confidence: number;
  landmarks: PoseLandmark[];
  kneeAngle?: number;
  hipAngle?: number;
  torsoLeanDegrees?: number;
  explanation: string;
};

const midpoint = (a: PoseLandmark, b: PoseLandmark) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function angle(a: PoseLandmark, b: PoseLandmark, c: PoseLandmark) {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
  if (!mag) return undefined;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
}

export async function analyzeHumanPose(uri: string): Promise<PoseAnalysis> {
  if (!NitroPose.isAvailable()) throw new Error("On-device pose detection is unavailable on this device.");
  const landmarks = await NitroPose.detect(uri) as PoseLandmark[];
  if (!landmarks.length) return { detected: false, posture: "unknown", confidence: 0, landmarks: [], explanation: "I cannot see a complete human body clearly enough to analyze posture." };
  const byType = new Map(landmarks.map((point) => [point.type, point]));
  const leftShoulder = byType.get(11), rightShoulder = byType.get(12);
  const leftHip = byType.get(23), rightHip = byType.get(24);
  const leftKnee = byType.get(25), rightKnee = byType.get(26);
  const leftAnkle = byType.get(27), rightAnkle = byType.get(28);
  const pairs = [[leftShoulder,rightShoulder],[leftHip,rightHip],[leftKnee,rightKnee],[leftAnkle,rightAnkle]];
  const visible = pairs.map((pair) => pair.filter((p): p is PoseLandmark => Boolean(p && p.inFrameLikelihood >= 0.5))).filter((pair) => pair.length > 0);
  const confidence = visible.length ? visible.reduce((sum,pair) => sum + pair.reduce((n,p) => n + p.inFrameLikelihood,0)/pair.length,0)/visible.length : 0;
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip || !leftKnee || !rightKnee) {
    return { detected: true, posture: "unknown", confidence, landmarks, explanation: "A person is visible, but the shoulders, hips, and knees are not all clear enough for reliable posture analysis." };
  }
  const shoulder = midpoint(leftShoulder,rightShoulder);
  const hip = midpoint(leftHip,rightHip);
  const knee = midpoint(leftKnee,rightKnee);
  const kneeAngle = angle(hip,leftKnee,leftAnkle ?? leftKnee) ?? angle(hip,rightKnee,rightAnkle ?? rightKnee);
  const hipAngle = angle(shoulder,leftHip,leftKnee) ?? angle(shoulder,rightHip,rightKnee);
  const torsoLeanDegrees = Math.abs(Math.atan2(shoulder.x-hip.x, hip.y-shoulder.y) * 180 / Math.PI);
  let posture: PoseAnalysis["posture"] = "unknown";
  if (kneeAngle !== undefined && kneeAngle < 125) posture = "sitting";
  else if (torsoLeanDegrees > 35) posture = "bending";
  else if (kneeAngle !== undefined && kneeAngle > 145) posture = "standing";
  const explanation = posture === "standing" ? "The visible body landmarks suggest the person is standing." : posture === "sitting" ? "The visible knee angle suggests the person is sitting." : posture === "bending" ? "The upper body is leaning forward or sideways, suggesting a bending posture." : "The person is visible, but the posture is uncertain from this camera angle.";
  return { detected: true, posture, confidence, landmarks, kneeAngle, hipAngle, torsoLeanDegrees, explanation };
}
