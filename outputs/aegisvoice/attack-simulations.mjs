// Deterministic signal transformations used by both calibration and the visible lab.
// These are controlled proxies, not recordings of real attacks.
export const ATTACK_SIM_RATE=16000;
const rng=seed=>()=>{seed=(Math.imul(seed>>>0,1664525)+1013904223)>>>0;return seed/0x100000000;};

function speechLike(seconds,seed){
  const random=rng(seed),out=new Float32Array(Math.floor(seconds*ATTACK_SIM_RATE));let phase=random()*Math.PI*2;
  for(let i=0;i<out.length;i++){
    const t=i/ATTACK_SIM_RATE,f0=108+(seed%27)+17*Math.sin(2*Math.PI*.72*t+seed*.03);phase+=2*Math.PI*f0/ATTACK_SIM_RATE;
    const syllable=Math.sin(2*Math.PI*2.15*t+seed*.19),envelope=syllable>-.28?.55+.35*Math.sin(2*Math.PI*3.7*t)**2:.018;
    let voiced=0;
    for(let h=1;h<=48;h++){const f=f0*h;if(f>=7800)break;const formant=.45+1.5*Math.exp(-(((f-720)/330)**2))+Math.exp(-(((f-1900)/520)**2))+.65*Math.exp(-(((f-3300)/850)**2));voiced+=formant*Math.sin(h*phase+h*.07)/h**.92;}
    const fricative=Math.sin(2*Math.PI*1.35*t+seed)>.78?(random()*2-1)*.18:0;out[i]=envelope*(.105*voiced+fricative);
  }return out;
}
function normalize(samples,peak=.72){let max=0;for(const v of samples)max=Math.max(max,Math.abs(v));const scale=max?peak/max:1,out=new Float32Array(samples.length);for(let i=0;i<out.length;i++)out[i]=samples[i]*scale;return out;}
function noise(samples,amount,seed,colored=false){const random=rng(seed),out=new Float32Array(samples.length);let state=0;for(let i=0;i<out.length;i++){const white=random()*2-1;state=colored?.92*state+.08*white:white;out[i]=samples[i]+state*amount;}return out;}
function fir(samples,taps){const out=new Float32Array(samples.length);for(let i=0;i<out.length;i++)for(const [delay,gain] of taps)if(i>=delay)out[i]+=gain*samples[i-delay];return out;}
function lowPass(samples,cutoff){const alpha=1-Math.exp(-2*Math.PI*cutoff/ATTACK_SIM_RATE),out=new Float32Array(samples.length);let state=0;for(let i=0;i<out.length;i++){state+=alpha*(samples[i]-state);out[i]=state;}return out;}
function allPass(samples,coefficient){const out=new Float32Array(samples.length);let input=0,output=0;for(let i=0;i<out.length;i++){const current=-coefficient*samples[i]+input+coefficient*output;out[i]=current;input=samples[i];output=current;}return out;}
function smooth(samples){const taps=[.04,.1,.2,.32,.2,.1,.04],middle=3,out=new Float32Array(samples.length);for(let i=0;i<out.length;i++)for(let j=0;j<taps.length;j++)out[i]+=samples[Math.max(0,Math.min(samples.length-1,i+j-middle))]*taps[j];return out;}
function quantize(samples,steps){const out=new Float32Array(samples.length);for(let i=0;i<out.length;i++)out[i]=Math.round(samples[i]*steps)/steps;return out;}

export const ATTACK_SIMULATIONS=Object.freeze([
  {id:'direct-clean-digital',label:'Direct digital proxy',expectedClass:'direct-injection',context:{captureKind:'digital-file',knownSource:true},description:'Clean digital speech with deterministic low-level dither.',transform:(x,s)=>normalize(noise(x,.00004,s),.70)},
  {id:'noisy-live-like-acoustic',label:'Live-human proxy',expectedClass:'live-human',context:{captureKind:'microphone',knownSource:false},description:'Speech-like signal with early reflections and colored background noise.',transform:(x,s)=>normalize(noise(fir(x,[[0,1],[144,.08],[336,-.05]]),.006,s,true),.68)},
  {id:'speaker-replay-fir',label:'Speaker-replay proxy',expectedClass:'speaker-replay',context:{captureKind:'microphone',knownSource:false},description:'Low-pass speaker coloration, sparse echoes and recapture noise.',transform:(x,s)=>normalize(lowPass(noise(fir(lowPass(x,1750+(s%4)*90),[[0,.78],[64,-.14],[416,.27],[832,.19],[1376,.11]]),.0035,s+700,true),3100),.66)},
  {id:'voice-conversion-proxy',label:'VC-processing proxy',expectedClass:'live-voice-conversion',context:{captureKind:'shared-audio',knownSource:false},description:'Quantization, all-pass phase change and spectral smoothing; not a real vocoder.',transform:(x,s)=>normalize(quantize(smooth(allPass(x,.61+(s%3)*.04)),192),.69)}
]);

export function simulateAttackCondition(id,{windows=5,seconds=1.1,seed=5000}={}){
  const condition=ATTACK_SIMULATIONS.find(item=>item.id===id);if(!condition)throw new Error(`Unknown attack simulation: ${id}`);
  return {condition,rate:ATTACK_SIM_RATE,windows:Array.from({length:windows},(_,index)=>condition.transform(speechLike(seconds,seed+index*37),seed+index*53))};
}
