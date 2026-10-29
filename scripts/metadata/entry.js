import {parseBlob} from 'music-metadata';
export async function sampleRate(file){
 try{
  const metadata=await parseBlob(file,{duration:false,skipCovers:true,skipPostHeaders:true});
  const rate=metadata.format.sampleRate;
  return Number.isFinite(rate)&&rate>0?rate:null;
 }catch{return null;}
}
