import {StyleSheet,View,ViewStyle} from "react-native";
export function GlassCard({children,style}:{children:React.ReactNode;style?:ViewStyle}){return <View style={[s.card,style]}>{children}</View>}
const s=StyleSheet.create({card:{borderRadius:24,padding:18,backgroundColor:"rgba(255,255,255,.065)",borderWidth:1,borderColor:"rgba(255,255,255,.11)"}});