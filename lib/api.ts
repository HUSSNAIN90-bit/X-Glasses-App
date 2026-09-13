import axios from "axios";
import type { AxiosInstance } from "axios";
import { cleanAssistantText } from "@/lib/assistant";

export const API_URL=(process.env.EXPO_PUBLIC_API_URL??"http://192.168.1.100:8000").replace(/\/+$/,"");
export const api:AxiosInstance=axios.create({baseURL:API_URL,timeout:120000});

export type Detection={class_name:string;confidence:number;x1:number;y1:number;x2:number;y2:number;relative_position?:string|null;vertical_position?:string|null};
export type PersonDetection={face_id:string;person_index:number|null;name:string|null;similarity:number|null;recognized:boolean;confidence:number;x1:number;y1:number;x2:number;y2:number;person_bbox?:number[]|null;relative_position?:string|null;vertical_position?:string|null;posture?:string|null;posture_confidence?:number|null};
export type Relationship={subject:string;relation:string;object:string;confidence:number};
export type FrameQuality={index:number;good:boolean;blur_score:number;brightness:number;clarity_score?:number;quality_score?:number};
export type VisionResponse={success:boolean;scene:string;objects:Detection[];people:PersonDetection[];poses:Array<{person_index:number;posture:string;confidence:number;bbox:number[];keypoints:number[][]}>;relationships:Relationship[]};
export type CommandResponse={
  success:boolean;session_id:string;command:string;reply:string;language:string;objects:Detection[];
  processing?:{mode:string;frame_count:number;quality_checked?:boolean;selected_frame?:number|null;ai_called?:boolean;yolo_verified?:boolean;frame_quality?:FrameQuality[]};
};
export type ChatResponse={success:boolean;session_id:string;user_message:string;reply:string;intent:string};
export type PersonListItem={person_id:string;name:string;created_at:string;embedding_count:number};

const part=(uri:string,name="frame.jpg")=>({uri,name,type:"image/jpeg"} as unknown as Blob);


export async function healthCheck(){return (await api.get("/health")).data}

export async function analyzeCommandMulti(sessionId:string,command:string,uris:string[],language="en"){
  const f=new FormData();
  f.append("session_id",sessionId);
  f.append("command",command);
  f.append("language",language);
  uris.slice(0,3).forEach((uri,i)=>f.append("images",part(uri,`command-${i+1}.jpg`)));
  const data=(await api.post<CommandResponse>("/api/vision/analyze-command-multi",f,{headers:{"Content-Type":"multipart/form-data"}})).data;
  data.reply=cleanAssistantText(data.reply);
  return data;
}

export async function analyzeImage(sessionId:string,uri:string){const f=new FormData();f.append("session_id",sessionId);f.append("image",part(uri));return (await api.post<VisionResponse>("/api/vision/analyze",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function saveFrame(sessionId:string,uri:string){const f=new FormData();f.append("session_id",sessionId);f.append("image",part(uri));return (await api.post("/api/vision/frame",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function checkFrameQuality(uri:string){const f=new FormData();f.append("image",part(uri));return (await api.post("/api/vision/frame-quality",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function sendChat(sessionId:string,message:string){const data=(await api.post<ChatResponse>("/api/chat/",{session_id:sessionId,message})).data;data.reply=cleanAssistantText(data.reply);return data}
export async function sendChatWithFrame(sessionId:string,message:string,uri:string){const f=new FormData();f.append("session_id",sessionId);f.append("message",message);f.append("image",part(uri));return (await api.post<ChatResponse>("/api/chat/with-frame",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function sendSessionInput(sessionId:string,command:string,uri?:string){const f=new FormData();f.append("session_id",sessionId);f.append("command",command);if(uri)f.append("image",part(uri));return (await api.post<ChatResponse>("/api/session/input",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function listPeople(){return (await api.get<{success:boolean;people:PersonListItem[]}>("/api/faces/people")).data}
export async function enrollFace(name:string,relationship:string,uri:string){const f=new FormData();f.append("name",name);if(relationship.trim())f.append("relationship",relationship.trim());f.append("image",part(uri,"face.jpg"));return (await api.post("/api/faces/enroll",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function recognizeFace(uri:string){const f=new FormData();f.append("image",part(uri,"face.jpg"));return (await api.post("/api/faces/recognize",f,{headers:{"Content-Type":"multipart/form-data"}})).data}
export async function deletePerson(id:string){return (await api.delete(`/api/faces/people/${encodeURIComponent(id)}`)).data}
export async function addPersonEmbedding(id:string,uri:string){const f=new FormData();f.append("image",part(uri,"face.jpg"));return (await api.post(`/api/faces/people/${encodeURIComponent(id)}/embeddings`,f,{headers:{"Content-Type":"multipart/form-data"}})).data}
