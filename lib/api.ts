import axios from "axios";
import type { AxiosInstance } from "axios";
import * as Network from "expo-network";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cleanAssistantText } from "@/lib/assistant";

const ENV_API_URL=(process.env.EXPO_PUBLIC_API_URL??"http://xglasses.local:8000").replace(/\/+$/,"");
const SAVED_API_URL_KEY="xglasses.backend_url";
const BACKEND_PORT=8000;
const DISCOVERY_TIMEOUT_MS=450;

export let API_URL=ENV_API_URL;
export const api:AxiosInstance=axios.create({baseURL:API_URL,timeout:120000});

let discoveryPromise:Promise<string>|null=null;

async function pingBackend(baseUrl:string,timeout=DISCOVERY_TIMEOUT_MS){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const response=await fetch(`${baseUrl.replace(/\/+$/,"")}/health`,{method:"GET",signal:controller.signal});
    return response.ok;
  }catch{
    return false;
  }finally{clearTimeout(timer);}
}

async function discoverBackend():Promise<string>{
  const candidates:string[]=[];
  const saved=await AsyncStorage.getItem(SAVED_API_URL_KEY).catch(()=>null);
  if(saved) candidates.push(saved.replace(/\/+$/,"").trim());
  if(ENV_API_URL && !candidates.includes(ENV_API_URL)) candidates.push(ENV_API_URL);

  for(const candidate of candidates){
    if(await pingBackend(candidate)) return candidate;
  }

  const ip=await Network.getIpAddressAsync().catch(()=>null);
  if(!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("Could not determine local Wi-Fi network");

  const parts=ip.split(".");
  const prefix=parts.slice(0,3).join(".");
  const ownLast=Number(parts[3]);
  const hosts=Array.from({length:254},(_,i)=>i+1).filter(n=>n!==ownLast);

  for(let start=0;start<hosts.length;start+=24){
    const batch=hosts.slice(start,start+24);
    const found=await Promise.all(batch.map(async n=>{
      const url=`http://${prefix}.${n}:${BACKEND_PORT}`;
      return (await pingBackend(url))?url:null;
    }));
    const match=found.find((value):value is string=>Boolean(value));
    if(match){
      await AsyncStorage.setItem(SAVED_API_URL_KEY,match).catch(()=>undefined);
      return match;
    }
  }

  throw new Error("X-Glasses backend not found on this Wi-Fi");
}

export async function ensureBackendConnection(force=false){
  if(discoveryPromise && !force) return discoveryPromise;
  discoveryPromise=(async()=>{
    const url=await discoverBackend();
    API_URL=url;
    api.defaults.baseURL=url;
    return url;
  })();
  try{return await discoveryPromise;}finally{discoveryPromise=null;}
}

// Every request verifies/re-discovers the backend when the configured hostname/IP changes.
api.interceptors.request.use(async config=>{
  if(!config.url?.endsWith("/health")){
    await ensureBackendConnection();
  }
  return config;
});

export type Detection={class_name:string;confidence:number;x1:number;y1:number;x2:number;y2:number;relative_position?:string|null;vertical_position?:string|null};
export type PersonDetection={face_id:string;person_index:number|null;name:string|null;similarity:number|null;recognized:boolean;confidence:number;x1:number;y1:number;x2:number;y2:number;person_bbox?:number[]|null;relative_position?:string|null;vertical_position?:string|null;posture?:string|null;posture_confidence?:number|null};
export type Relationship={subject:string;relation:string;object:string;confidence:number};
export type FrameQuality={index:number;good:boolean;blur_score:number;brightness:number;clarity_score?:number;quality_score?:number};
export type VisionResponse={success:boolean;scene:string;objects:Detection[];people:PersonDetection[];poses:Array<{person_index:number;posture:string;confidence:number;bbox:number[];keypoints:number[][]}>;relationships:Relationship[]};
export type CommandResponse={success:boolean;session_id:string;command:string;reply:string;language:string;objects:Detection[];processing?:{mode:string;frame_count:number;quality_checked?:boolean;selected_frame?:number|null;ai_called?:boolean;yolo_verified?:boolean;frame_quality?:FrameQuality[]}};
export type ChatResponse={success:boolean;session_id:string;user_message:string;reply:string;intent:string};
export type PersonListItem={person_id:string;name:string;created_at:string;embedding_count:number};
export type MultiEnrollmentResponse={success:boolean;reply:string;person_id?:string|null;accepted_frames:number;attempted_frames:number;good_quality_frames:number};

const part=(uri:string,name="frame.jpg")=>({uri,name,type:"image/jpeg"} as unknown as Blob);
function isProductCommand(command:string){return /\b(product|barcode|bar code|qr|price|pricing|cost|label|brand|model|sku|upc|ean|gtin|packaging|package)\b/i.test(command);}
export async function healthCheck(){await ensureBackendConnection();return (await api.get("/health")).data}
export async function analyzeCommandMulti(sessionId:string,command:string,uris:string[],language="en"){
  if(isProductCommand(command)) return analyzeProductCommand(sessionId,command,uris,false,language);
  const f=new FormData();f.append("session_id",sessionId);f.append("command",command);f.append("language",language);uris.slice(0,3).forEach((uri,i)=>f.append("images",part(uri,`command-${i+1}.jpg`)));
  const data=(await api.post<CommandResponse>("/api/vision/analyze-command-multi",f,{headers:{"Content-Type":"multipart/form-data"}})).data;data.reply=cleanAssistantText(data.reply);return data;
}
export async function analyzeProductCommand(sessionId:string,command:string,uris:string[],barcodeRetry=false,language="en"){
  const f=new FormData();f.append("session_id",sessionId);f.append("command",command);f.append("language",language);f.append("barcode_retry",String(barcodeRetry));uris.slice(0,6).forEach((uri,i)=>f.append("frames",part(uri,`product-${i+1}.jpg`)));
  const data=(await api.post<CommandResponse>("/api/product/command",f,{headers:{"Content-Type":"multipart/form-data"}})).data;data.reply=cleanAssistantText(data.reply);return data;
}
export async function enrollFaceMulti(name:string,relationship:string|undefined,uris:string[]){const f=new FormData();f.append("name",name);if(relationship?.trim())f.append("relationship",relationship.trim());uris.slice(0,8).forEach((uri,i)=>f.append("images",part(uri,`enrollment-${i+1}.jpg`)));const data=(await api.post<MultiEnrollmentResponse>("/api/faces/enroll-multi",f,{headers:{"Content-Type":"multipart/form-data"}})).data;data.reply=cleanAssistantText(data.reply);return data;}
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
