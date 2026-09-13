import {Pressable,StyleSheet,Text,ViewStyle} from "react-native";
export function PrimaryButton({title,onPress,disabled,style}:{title:string;onPress:()=>void;disabled?:boolean;style?:ViewStyle}){
 return <Pressable disabled={disabled} onPress={onPress} style={[s.b,style,disabled&&s.d]}><Text style={s.t}>{title}</Text></Pressable>
}
const s=StyleSheet.create({b:{minHeight:52,borderRadius:17,alignItems:"center",justifyContent:"center",paddingHorizontal:18,backgroundColor:"#FFF"},d:{opacity:.45},t:{color:"#090A0D",fontWeight:"900",fontSize:15}});
