import {CameraView,useCameraPermissions} from "expo-camera";
import {useEffect,useRef,useState} from "react";
import {Modal,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from "react-native";
import {deleteLocalFacePerson, enrollLocalFace, listLocalFacePeople, LocalFacePerson} from "@/lib/faceRecognition";
import {GlassCard} from "@/components/GlassCard";
import {PrimaryButton} from "@/components/PrimaryButton";

const ENROLL_FRAME_COUNT=8;
const ENROLL_FRAME_DELAY_MS=280;

export default function People(){
  const[people,setPeople]=useState<LocalFacePerson[]>([]);
  const[modal,setModal]=useState(false);
  const[error,setError]=useState("");

  async function load(){
    try{
      setPeople(await listLocalFacePeople());
      setError("");
    }catch(e){
      setError(e instanceof Error?e.message:"Unable to load people.");
    }
  }

  useEffect(()=>{void load()},[]);

  async function del(id:string){
    try{
      await deleteLocalFacePerson(id);
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:"Delete failed.");
    }
  }

  return <ScrollView style={s.root} contentContainerStyle={s.content}>
    <PrimaryButton title="Enroll New Person" onPress={()=>{setError("");setModal(true)}}/>
    {error?<Text style={s.error}>{error}</Text>:null}
    {people.map(p=><GlassCard key={p.id}>
      <Text style={s.name}>{p.name}</Text>
      <Text style={s.meta}>{p.sampleCount} local face sample(s)</Text>
      {p.relationship?<Text style={s.meta}>Relationship: {p.relationship}</Text>:null}
      <Pressable onPress={()=>void del(p.id)}>
        <Text style={s.delete}>Delete</Text>
      </Pressable>
    </GlassCard>)}
    {!people.length?<Text style={s.muted}>No enrolled people yet.</Text>:null}
    <Enroll visible={modal} close={()=>setModal(false)} done={load}/>
  </ScrollView>
}

function Enroll({visible,close,done}:{visible:boolean;close:()=>void;done:()=>Promise<void>}){
  const[p,request]=useCameraPermissions();
  const ref=useRef<CameraView|null>(null);
  const[name,setName]=useState("");
  const[relationship,setRelationship]=useState("");
  const[busy,setBusy]=useState(false);
  const[progress,setProgress]=useState(0);
  const[status,setStatus]=useState("");
  const[error,setError]=useState("");

  useEffect(()=>{
    if(!visible){
      setBusy(false);
      setProgress(0);
      setStatus("");
      setError("");
    }
  },[visible]);

  function sleep(ms:number){
    return new Promise<void>(resolve=>setTimeout(resolve,ms));
  }

  async function go(){
    if(!ref.current||!name.trim()||busy)return;

    setBusy(true);
    setError("");
    setProgress(0);
    setStatus("Get your face inside the frame…");

    try{
      const uris:string[]=[];

      // Capture several slightly different frames instead of relying on one photo.
      // The backend's existing quality gate will decide which frames are usable.
      for(let i=0;i<ENROLL_FRAME_COUNT;i++){
        setProgress(i+1);
        setStatus(`Capturing face… ${i+1}/${ENROLL_FRAME_COUNT}`);

        const photo=await ref.current.takePictureAsync({
          quality:0.85,
          skipProcessing:false,
        });

        if(photo?.uri)uris.push(photo.uri);
        if(i<ENROLL_FRAME_COUNT-1)await sleep(ENROLL_FRAME_DELAY_MS);
      }

      if(uris.length<3){
        throw new Error("Could not capture enough face frames. Please try again.");
      }

      setStatus(`Analyzing ${uris.length} face frames…`);
      const result=await enrollLocalFace(name.trim(),relationship.trim()||undefined,uris);

      if(!result){
        throw new Error("Face enrollment failed.");
      }

      setStatus(`Enrolled successfully — ${result.sampleCount} local face sample(s) saved.`);

      await sleep(700);
      setName("");
      setRelationship("");
      close();
      await done();
    }catch(e){
      setError(e instanceof Error?e.message:"Enrollment failed.");
      setStatus("");
    }finally{
      setBusy(false);
    }
  }

  if(!p?.granted)return <Modal visible={visible} onRequestClose={close}>
    <View style={s.modal}>
      <Text style={s.title}>Camera permission required</Text>
      <Text style={s.help}>Allow camera access so Smart Eyes can capture multiple face frames for enrollment.</Text>
      <PrimaryButton title="Allow Camera" onPress={()=>void request()}/>
      <Pressable onPress={close} disabled={busy}>
        <Text style={s.cancel}>Cancel</Text>
      </Pressable>
    </View>
  </Modal>;

  return <Modal visible={visible} animationType="slide" onRequestClose={()=>{if(!busy)close()}}>
    <View style={s.modal}>
      <Text style={s.title}>Enroll New Person</Text>
      <Text style={s.help}>Look at the camera and keep your face steady. We automatically capture 8 frames.</Text>

      <CameraView
        ref={ref}
        style={s.cam}
        facing="front"
        active={visible}
      />

      <View style={s.progressBox}>
        <View style={s.progressTrack}>
          <View style={[s.progressFill,{width:`${Math.min(progress,ENROLL_FRAME_COUNT)/ENROLL_FRAME_COUNT*100}%`}]}/>
        </View>
        <Text style={s.status}>{status||"Ready to capture"}</Text>
      </View>

      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor="#69717D"
        style={s.input}
        editable={!busy}
      />
      <TextInput
        value={relationship}
        onChangeText={setRelationship}
        placeholder="Relationship (optional)"
        placeholderTextColor="#69717D"
        style={s.input}
        editable={!busy}
      />

      {error?<Text style={s.error}>{error}</Text>:null}

      <PrimaryButton
        title={busy?"Enrolling…":"Start Automatic Enrollment"}
        onPress={()=>void go()}
        disabled={busy||!name.trim()}
      />

      <Pressable onPress={close} disabled={busy}>
        <Text style={[s.cancel,busy&&s.disabled]}>Cancel</Text>
      </Pressable>
    </View>
  </Modal>
}

const s=StyleSheet.create({
  root:{flex:1,backgroundColor:"#090A0D"},
  content:{padding:16,gap:12},
  name:{color:"#FFF",fontSize:20,fontWeight:"900"},
  meta:{color:"#8E96A2",marginTop:5},
  delete:{color:"#FF7777",fontWeight:"800",marginTop:14},
  muted:{color:"#8E96A2",textAlign:"center",marginTop:20},
  error:{color:"#FF7777",lineHeight:20},
  modal:{flex:1,backgroundColor:"#090A0D",padding:18,gap:12,justifyContent:"center"},
  title:{color:"#FFF",fontSize:24,fontWeight:"900"},
  help:{color:"#9AA3AF",lineHeight:20},
  cam:{height:330,borderRadius:24,overflow:"hidden"},
  progressBox:{gap:8},
  progressTrack:{height:6,borderRadius:3,backgroundColor:"rgba(255,255,255,.08)",overflow:"hidden"},
  progressFill:{height:6,borderRadius:3,backgroundColor:"#FFF"},
  status:{color:"#D8DDE5",fontSize:14,minHeight:20},
  input:{height:52,borderRadius:15,backgroundColor:"rgba(255,255,255,.06)",color:"#FFF",paddingHorizontal:14},
  cancel:{color:"#FFF",textAlign:"center",padding:12,fontWeight:"800"},
  disabled:{opacity:.4}
});
