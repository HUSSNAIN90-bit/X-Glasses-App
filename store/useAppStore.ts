import AsyncStorage from "@react-native-async-storage/async-storage";
import {create} from "zustand";
import type {VisionResponse} from "@/lib/api";
type Message={id:string;role:"user"|"assistant";text:string;createdAt:number};
type State={sessionId:string;apiConnected:boolean;lastVision:VisionResponse|null;messages:Message[];setSessionId:(id:string)=>void;setApiConnected:(v:boolean)=>void;setLastVision:(v:VisionResponse|null)=>void;addMessage:(m:Message)=>void;hydrate:()=>Promise<void>};
export const useAppStore=create<State>((set,get)=>({
 sessionId:"mobile_001",apiConnected:false,lastVision:null,messages:[],
 setSessionId:id=>{const v=id.trim()||"mobile_001";set({sessionId:v});void AsyncStorage.setItem("xglasses.sessionId",v)},
 setApiConnected:v=>set({apiConnected:v}),setLastVision:v=>set({lastVision:v}),
 addMessage:m=>set({messages:[...get().messages,m]}),
 hydrate:async()=>{const v=await AsyncStorage.getItem("xglasses.sessionId");if(v)set({sessionId:v})}
}));
