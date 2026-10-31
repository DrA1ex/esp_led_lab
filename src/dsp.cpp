// ESP LED Music Lab: portable DSP experiments compiled directly to WebAssembly.
// Does not depend on browser APIs or Arduino. Designed for subsequent ESP32-C3 port.
#include "tables.h"

// FFT sizes 64..8192 at a host-selected analysis rate (default 16 kHz).
static constexpr int MAX_N = 8192;
static constexpr int BANDS = 16;
static float sample_rate=16000.f;
static float input_pcm[MAX_N];
static float real_fft[MAX_N];
static float imag_fft[MAX_N];
static float spectrum[MAX_N/2];
// Remote-only spectral resolutions share the exact same FFT and AGC reference.
// The 16-band legacy visualization remains intentionally unchanged.
static float remote32[32], remote64[64];
// Band edges: logarithmic inside the analysed frequency range [range_lo,
// range_hi] (set_frequency_range). 64 edges are computed; 32 and 16 bands use
// every 2nd / 4th edge. The default 40..8000 Hz equals the former fixed 32/64
// remote tables.
static double range_lo=40.0,range_hi=8000.0;
static float edges64[65];
static float twiddle_cos[MAX_N],twiddle_sin[MAX_N];
static float bands[BANDS];
static float raw_bands[BANDS];
static float noise_floor[BANDS],group_levels[3];
static float prev_bands[BANDS];
static float baseline[BANDS];
static float raw_group[3], pulse[3], events[3], flux_avg[3], flux_dev[3], refractory[3];
// Intermediate signals for the lab's DSP view: each band's level before the
// attack/release envelope and each group's current onset threshold.
static float targets[BANDS], thresholds[3];
static float metrics[10]; // flux x3, RMS, activity, AGC ref, BPM, beat confidence, phase, beat pulse
static float novelty_ring[256];
static int novelty_pos=0,novelty_filled=0,novelty_updates=0;
static float novelty_elapsed=0,novelty_sum=0;
static constexpr float NOVELTY_STEP=.016f;
static float bpm=0.f,bpm_confidence=0.f,beat_phase=0.f,beat_pulse=0.f;
static float new_wave_elapsed=0.f;
static float level_ref = 0.04f;
static unsigned int warm_count=0;
// Analyzer settings outside new_process()'s arguments (set_*). They survive
// reset_dsp(); the defaults reproduce the fixed values used before.
// Tilt: dB per octave around 1 kHz, applied to every band before anything else.
static float tilt_db=0.f,tilt16[BANDS],tilt32[32],tilt64[64];
// Band balance: the share of each band's own reference (its average over
// ~4 s) in the reference it is normalised to; 0 = the global AGC only.
static float band_balance=0.f,band_avg[BANDS],band_ref[BANDS];
// Adaptive floor: seconds the learned background takes to rise to a louder
// background, and to fall back when it gets quieter.
static float floor_rise=8.f,floor_fall=.1f;
// Groups: first band of mid and of high (16 bands).
static int split_mid=5,split_high=12;
// Onsets per group: threshold trim, hold-off after a hit, flash decay (seconds).
static float onset_trim[3]={1.f,1.f,1.f},holdoff[3]={.16f,.085f,.085f},flash_decay[3]={.22f,.13f,.13f};
// Tempo search range; the lags of 16 ms novelty steps it covers.
static int tempo_minlag=21,tempo_maxlag=58;
// For the lab's tempo view: the periodicity score of every lag searched and
// [first lag, last lag, best lag, best score] of the last search.
static float tempo_scores[128],tempo_info[4];
// Window: generalized cosine a0 - a1 cos x + a2 cos 2x - a3 cos 3x + a4 cos 4x.
// The spectrum is divided by a0 (the coherent gain), so a tone reads the same
// in every window; the frame RMS is scaled to the Hann window's power.
static const float WINDOWS[5][5]={
    {.5f,.5f,0,0,0},                                             // Hann
    {.54f,.46f,0,0,0},                                           // Hamming
    {.35875f,.48829f,.14128f,.01168f,0},                         // Blackman-Harris
    {.21557895f,.41663158f,.277263158f,.083578947f,.006947368f}, // flat-top
    {1.f,0,0,0,0}};                                              // rectangular
static int window_type=0;
// Group trims in front of the analyzer (with the tilt), as amplitude gains.
static float group_gain[3]={1.f,1.f,1.f};
// Band smoothing: share of the neighbors' average in each band's level.
static float band_smoothing=0.f;
// Peak hold: seconds a band stays at its peak before it releases; per band.
static float peak_hold=0.f,hold16[BANDS],hold32[32],hold64[64];
// Onset threshold memory: the time scale of the flux mean and deviation.
static float onset_memory=.7f;
// Chroma (chroma_process): 12 pitch classes from a separate long analysis.
// The short FFT stays for onsets: at 16 kHz a 512-point bin is 31 Hz, while
// a semitone at 100 Hz is 6 Hz. The last ~0.5 s are low-passed and decimated
// by chroma_d to about 8 kHz and analysed with CHROMA_N points (~2 Hz per bin).
static constexpr int CHROMA_N=4096,CHROMA_MAX_D=6,CHROMA_MAX_TAPS=24*CHROMA_MAX_D+1;
static float chroma_pcm[CHROMA_N*CHROMA_MAX_D+CHROMA_MAX_TAPS],chroma_fir[CHROMA_MAX_TAPS];
static float chroma_mag[CHROMA_N/2+1],chroma_cum[CHROMA_N/2+2];
static int chroma_d=2,chroma_taps=49;
// Normalised, smoothed chroma (C, C#, ... B: 0..1); the strongest recent
// class (the reference, ~8 s); [analysis rate, FFT size, decimation, tonal level].
static float chroma_out[12],chroma_ref=0.f,chroma_info[4];

// VolumeAnalyzer<16> @40Hz and VolumeAnalyzer<64> @30Hz (different from spectrum @10Hz).
static unsigned short old_wave_input[16],old_param_input[64];
static float old_wave[128],new_wave[128];
static float old_param_level=0.f,new_param_level=0.f;
// True time-domain loudness and fast line envelope. Both are independent of
// the spectral mean that previously made Speed Control nearly stationary.
static float loudness_peak=0.006f,new_loudness_level=0.f,new_line_level=0.f;
static unsigned short wave_min_hist[200],wave_max_hist[200];
static unsigned short param_min_hist[151],param_max_hist[151];
static unsigned wave_frames=0,param_frames=0,wave_write=0,new_wave_write=0;
static unsigned short old_input[128];
static unsigned short old_now[64], old_prev[64], old_out[16];
static unsigned short old_min_hist[50], old_max_hist[50];
static unsigned int old_frames=0;

static inline float absf(float x) { return x < 0 ? -x : x; }
static inline float maxf(float a,float b){return a>b?a:b;}
static inline float minf(float a,float b){return a<b?a:b;}
static inline float clamp(float x,float lo,float hi){return minf(hi,maxf(lo,x));}
static inline float sqrt_fast(float x){return __builtin_sqrtf(maxf(0.0f,x));}
static inline int absi(int x){return x<0?-x:x;}
// Level of the band between two frequencies: RMS of the FFT magnitudes,
// scaled by sqrt((n / sample_rate) / (512 / 16000)) so tone levels remain
// comparable across FFT sizes and analysis rates
// (a wider FFT spreads a band over more, individually weaker bins).
// Fractional overlap with FFT bins avoids empty logarithmic bands at small FFT
// sizes or narrow ranges; neighboring narrow bands still cannot be considered
// independently resolved.
static float band_magnitude(float lo_hz,float hi_hz,int n){
    const float hz=sample_rate/n,lo=lo_hz/hz,hi=hi_hz/hz,scale=(float)n/512.f*16000.f/sample_rate;
    float sum=0.f,weight=0.f;
    int first=(int)lo-1,last=(int)hi+2;
    if(first<1)first=1;
    if(last>=n/2)last=n/2-1;
    for(int k=first;k<=last;k++){
        float overlap=minf((float)k+0.5f,hi)-maxf((float)k-0.5f,lo);
        if(overlap>0){sum+=spectrum[k]*spectrum[k]*overlap;weight+=overlap;}
    }
    if(weight<0.0001f){
        int k=(int)((lo+hi)*.5f+0.5f);
        if(k<1)k=1;if(k>=n/2)k=n/2-1;
        return spectrum[k]*sqrt_fast(scale);
    }
    return sqrt_fast(sum/weight*scale);
}
// Compression > 0 blends toward the square root (quiet bands come up, less
// contrast); < 0 toward the square (expansion: quiet bands go down, more contrast).
static inline float dynamics(float x,float c){
    return c>=0.f?(1.f-c)*x+c*sqrt_fast(x):(1.f+c)*x-c*x*x;
}
// The 32/64 remote bands use the tilt of their own center and the reference
// of the 16-band they lie in.
static inline int group_of(int b){return b<split_mid?0:(b<split_high?1:2);}
// Neighbor blend of the targets (Band smoothing); edges blend their one neighbor.
static void smooth_targets(float* t,int count){
    if(band_smoothing<=0.f)return;
    float prev=t[0];
    for(int b=0;b<count;b++){
        const float here=t[b],next=b+1<count?t[b+1]:here,left=b?prev:here;
        // Toward the binomial ¼ ½ ¼ at full smoothing: a lone peak spreads, never vanishes.
        t[b]=(1.f-.5f*band_smoothing)*here+band_smoothing*.25f*(left+next);
        prev=here;
    }
}
// Attack, or hold the peak for peak_hold seconds, then release.
static inline void envelope(float& out,float& hold,float target,float attack,float release,float hop_seconds){
    if(target>out){out+=(target-out)*attack;hold=peak_hold;}
    else if(hold>0.f)hold-=hop_seconds;
    else out+=(target-out)*release;
}
static void remote_spectrum(int count,float* out,float* hold,const float* tilt,int n,float hop_seconds,
                            float attack,float release,float noise_gate,
                            float gain,float compression){
    const int step=64/count;
    float target[64];
    for(int b=0;b<count;b++){
        const int b16=b*BANDS/count;
        float raw=band_magnitude(edges64[b*step],edges64[(b+1)*step],n)*tilt[b]*group_gain[group_of(b16)];
        float v=maxf(0.f,raw-noise_gate);
        float normalized=v*gain/(band_ref[b16]*6.5f);
        float compressed=dynamics(normalized,compression);
        target[b]=compressed/(.85f+compressed);
    }
    smooth_targets(target,count);
    for(int b=0;b<count;b++){
        envelope(out[b],hold[b],target[b],attack,release,hop_seconds);
        out[b]=clamp(out[b],0.f,1.f);
    }
}

// Logarithmic edges between range_lo and range_hi: q = (hi/lo)^(1/64) by six
// square roots (no libm).
// ln / exp without libm, for the tilt gains (recomputed only on a change).
static double ln_d(double x){
    int e=0;
    while(x>2.0){x*=.5;e++;}
    while(x<1.0){x*=2.0;e--;}
    const double s=(x-1.0)/(x+1.0),s2=s*s;
    double t=s,sum=0;
    for(int k=1;k<40;k+=2){sum+=t/k;t*=s2;}
    return 2.0*sum+e*0.69314718055994531;
}
static double exp_d(double y){
    int n=(int)(y/0.69314718055994531);
    const double r=y-n*0.69314718055994531;
    double term=1,sum=1;
    for(int k=1;k<30;k++){term*=r/k;sum+=term;}
    for(;n>0;n--)sum*=2.0;
    for(;n<0;n++)sum*=.5;
    return sum;
}
// Amplitude gain of the tilt at a band's geometric center: tilt_db per octave
// from 1 kHz, i.e. (f / 1000) ^ (tilt_db / 20 / log10(2)).
static void compute_tilt(){
    for(int count=16;count<=64;count*=2){
        float* out=count==16?tilt16:count==32?tilt32:tilt64;
        const int step=64/count;
        for(int b=0;b<count;b++){
            const double fc=__builtin_sqrt((double)edges64[b*step]*edges64[(b+1)*step]);
            out[b]=tilt_db==0.f?1.f:(float)exp_d(tilt_db*0.16609640474436813*ln_d(fc/1000.0));
        }
    }
}
static void compute_edges(){
    double q=range_hi/range_lo;
    for(int i=0;i<6;i++)q=__builtin_sqrt(q);
    double edge=range_lo;
    for(int i=0;i<64;i++){edges64[i]=(float)edge;edge*=q;}
    edges64[64]=(float)range_hi;
    compute_tilt();
}
// Twiddles for every FFT size: cos/sin(2*pi*k/MAX_N). Anchored on the
// 1024-entry tables every 8th entry (sizes <= 1024 use exactly the table
// values) and rotated by k%8 steps of 2*pi/8192 in between.
static void compute_twiddles(){
    static const double c8[8]={1,0.99999970586288223,0.99999882345170188,0.99999735276697821,0.99999529380957619,0.99999264658070719,0.9999894110819284,0.9999855873151432};
    static const double s8[8]={0,0.00076699031874270449,0.0015339801862847655,0.002300969151425805,0.0030679567629659761,0.0038349425697062275,0.0046019261204485705,0.0053689069639963425};
    for(int k=0;k<MAX_N;k++){
        const double c=cos1024[k>>3],sn=sin1024[k>>3];
        const int r=k&7;
        twiddle_cos[k]=(float)(c*c8[r]-sn*s8[r]);
        twiddle_sin[k]=(float)(sn*c8[r]+c*s8[r]);
    }
}

// sin(2 pi x) from the twiddle table, interpolated (error < 1e-7).
static double sin_turns(double x){
    double pos=(x-(double)(long long)x)*MAX_N;
    if(pos<0)pos+=MAX_N;
    const int i=(int)pos;const double f=pos-i;
    return twiddle_sin[i&(MAX_N-1)]*(1.0-f)+twiddle_sin[(i+1)&(MAX_N-1)]*f;
}
static double cos_turns(double x){return sin_turns(x+.25);}
// log2 without libm: exponent plus the atanh series of the mantissa (error < 3e-5).
static float log2_fast(float x){
    if(!(x>1e-30f))x=1e-30f;
    unsigned bits;__builtin_memcpy(&bits,&x,4);
    const int e=(int)((bits>>23)&255)-127;
    bits=(bits&0x7fffffu)|0x3f800000u;
    float m;__builtin_memcpy(&m,&bits,4);
    const float s=(m-1.f)/(m+1.f),s2=s*s;
    return (float)e+2.8853900817779268f*s*(1.f+s2*(1.f/3.f+s2*(.2f+s2*(1.f/7.f))));
}
// Chroma decimation to about 8 kHz: a Blackman-windowed sinc low-pass at
// 2.7 kHz (the notes stop at 2 kHz), 24 taps per decimation step, unity gain.
static void compute_chroma_filter(){
    chroma_d=(int)(sample_rate/8000.f+.5f);
    if(chroma_d<1)chroma_d=1;if(chroma_d>CHROMA_MAX_D)chroma_d=CHROMA_MAX_D;
    if(chroma_d==1){chroma_taps=1;chroma_fir[0]=1.f;return;}
    chroma_taps=24*chroma_d+1;
    const double fc=2700.0/sample_rate;const int mid=chroma_taps/2;
    double sum=0;
    for(int t=0;t<chroma_taps;t++){
        const int m=t-mid;const double x=(double)t/(chroma_taps-1);
        const double h=(m==0?2.0*fc:sin_turns(fc*m)/(3.14159265358979323846*m))*(.42-.5*cos_turns(x)+.08*cos_turns(2.0*x));
        chroma_fir[t]=(float)h;sum+=h;
    }
    for(int t=0;t<chroma_taps;t++)chroma_fir[t]=(float)(chroma_fir[t]/sum);
}

static bool tables_ready=false;
static void ensure_tables(){if(!tables_ready){compute_twiddles();compute_edges();compute_chroma_filter();tables_ready=true;}}
// Radix-2 complex FFT of real_fft / imag_fft in place. No libm or heap allocation.
static void fft(int n){
    for(int i=1,j=0;i<n;i++){
        int bit=n>>1;
        for(;j&bit;bit>>=1) j^=bit;
        j^=bit;
        if(i<j){float t=real_fft[i];real_fft[i]=real_fft[j];real_fft[j]=t;}
    }
    for(int len=2;len<=n;len<<=1){
        int stride=MAX_N/len;
        for(int offset=0;offset<n;offset+=len){
            for(int j=0;j<len/2;j++){
                int k=j*stride;
                float wr=twiddle_cos[k],wi=-twiddle_sin[k];
                float r=real_fft[offset+j+len/2],im=imag_fft[offset+j+len/2];
                float tr=wr*r-wi*im,ti=wr*im+wi*r;
                float ar=real_fft[offset+j],ai=imag_fft[offset+j];
                real_fft[offset+j]=ar+tr; imag_fft[offset+j]=ai+ti;
                real_fft[offset+j+len/2]=ar-tr; imag_fft[offset+j+len/2]=ai-ti;
            }
        }
    }
}

extern "C" {
// Analysed frequency range in Hz; bands are spread logarithmically inside it.
// Clamped to 20 Hz .. Nyquist, at least half an octave wide.
__attribute__((visibility("default"))) void set_frequency_range(float lo_hz,float hi_hz){
    const float nyquist=sample_rate*.5f;
    double lo=clamp(lo_hz,20.f,nyquist),hi=clamp(hi_hz,20.f,nyquist);
    if(hi<lo*1.5)hi=lo*1.5;
    if(hi>nyquist){hi=nyquist;lo=hi/1.5;}
    ensure_tables();range_lo=lo;range_hi=hi;compute_edges();
}
__attribute__((visibility("default"))) void set_sample_rate(int rate){
    if(rate<8000||rate>48000)return;
    sample_rate=(float)rate;set_frequency_range((float)range_lo,(float)range_hi);compute_chroma_filter();
}
// Spectral tilt in dB per octave around 1 kHz (-12..+12); +3 makes pink noise flat.
__attribute__((visibility("default"))) void set_spectral_tilt(float db_per_octave){
    const float t=clamp(db_per_octave,-12.f,12.f);
    ensure_tables();
    if(t!=tilt_db){tilt_db=t;compute_tilt();}
}
// 0..1: how far each band is normalised to its own average instead of the global one.
__attribute__((visibility("default"))) void set_band_balance(float amount){band_balance=clamp(amount,0.f,1.f);}
__attribute__((visibility("default"))) void set_noise_floor_timing(float rise_s,float fall_s){floor_rise=clamp(rise_s,.5f,120.f);floor_fall=clamp(fall_s,.02f,10.f);}
// First band of the mid and of the high group; every group keeps at least one band.
__attribute__((visibility("default"))) void set_band_groups(int mid_start,int high_start){
    split_mid=mid_start<1?1:(mid_start>BANDS-2?BANDS-2:mid_start);
    split_high=high_start<=split_mid?split_mid+1:(high_start>BANDS-1?BANDS-1:high_start);
}
// FFT window: 0 Hann, 1 Hamming, 2 Blackman-Harris, 3 flat-top, 4 rectangular.
__attribute__((visibility("default"))) void set_window(int type){window_type=type<0||type>4?0:type;}
// Trims of the bass / mid / high group in dB (-24..+24), in front of the analyzer.
__attribute__((visibility("default"))) void set_group_gains(float bass_db,float mid_db,float high_db){
    const float db[3]={bass_db,mid_db,high_db};
    for(int g=0;g<3;g++){const float d=clamp(db[g],-24.f,24.f);group_gain[g]=d==0.f?1.f:(float)exp_d(d*0.11512925464970229);}
}
__attribute__((visibility("default"))) void set_band_smoothing(float amount){band_smoothing=clamp(amount,0.f,1.f);}
__attribute__((visibility("default"))) void set_peak_hold(float ms){peak_hold=clamp(ms,0.f,2000.f)/1000.f;}
__attribute__((visibility("default"))) void set_onset_memory(float seconds){onset_memory=clamp(seconds,.1f,5.f);}
__attribute__((visibility("default"))) int group_first_band(int g){return g<=0?0:g==1?split_mid:g==2?split_high:BANDS;}
// One group's onsets: threshold trim (x), hold-off after a hit and flash decay (ms).
__attribute__((visibility("default"))) void set_onset_group(int g,float trim,float holdoff_ms,float flash_ms){
    if(g<0||g>2)return;
    onset_trim[g]=clamp(trim,.1f,5.f);
    holdoff[g]=clamp(holdoff_ms,10.f,2000.f)/1000.f;
    flash_decay[g]=clamp(flash_ms,20.f,3000.f)/1000.f;
}
// Tempo search range in BPM (40..240, at least 10 BPM wide).
__attribute__((visibility("default"))) void set_tempo_range(float lo_bpm,float hi_bpm){
    const float lo=clamp(lo_bpm,40.f,230.f),hi=clamp(hi_bpm,lo+10.f,240.f);
    tempo_minlag=(int)(60.f/(hi*NOVELTY_STEP)+0.5f);
    tempo_maxlag=(int)(60.f/(lo*NOVELTY_STEP)+0.5f);
    if(tempo_maxlag>120)tempo_maxlag=120;
    if(tempo_maxlag<=tempo_minlag)tempo_maxlag=tempo_minlag+1;
}
__attribute__((visibility("default"))) int max_fft_size(){return MAX_N;}
__attribute__((visibility("default"))) float* new_input_ptr(){return input_pcm;}
__attribute__((visibility("default"))) float* new_spectrum_ptr(){return spectrum;}
__attribute__((visibility("default"))) float* new_bands_ptr(){return bands;}
__attribute__((visibility("default"))) float* new_remote32_ptr(){return remote32;}
__attribute__((visibility("default"))) float* new_remote64_ptr(){return remote64;}
__attribute__((visibility("default"))) float* new_raw_ptr(){return raw_bands;}
__attribute__((visibility("default"))) float* new_targets_ptr(){return targets;}
__attribute__((visibility("default"))) float* new_floor_ptr(){return noise_floor;}
__attribute__((visibility("default"))) float* new_thresholds_ptr(){return thresholds;}
__attribute__((visibility("default"))) float* new_tilt_ptr(){return tilt16;}
__attribute__((visibility("default"))) float* new_band_ref_ptr(){return band_ref;}
__attribute__((visibility("default"))) float* new_novelty_ptr(){return novelty_ring;}
__attribute__((visibility("default"))) int new_novelty_head(){return novelty_pos;}
__attribute__((visibility("default"))) float* new_tempo_scores_ptr(){return tempo_scores;}
__attribute__((visibility("default"))) float* new_tempo_info_ptr(){return tempo_info;}
__attribute__((visibility("default"))) float* new_pulses_ptr(){return pulse;}
__attribute__((visibility("default"))) float* new_levels_ptr(){return group_levels;}
__attribute__((visibility("default"))) float* new_events_ptr(){return events;}
__attribute__((visibility("default"))) float* new_metrics_ptr(){return metrics;}
__attribute__((visibility("default"))) unsigned short* old_input_ptr(){return old_input;}
__attribute__((visibility("default"))) unsigned short* old_wave_input_ptr(){return old_wave_input;}
__attribute__((visibility("default"))) unsigned short* old_param_input_ptr(){return old_param_input;}
__attribute__((visibility("default"))) float* old_wave_ptr(){return old_wave;}
__attribute__((visibility("default"))) float* new_wave_ptr(){return new_wave;}
__attribute__((visibility("default"))) float old_param_value(){return old_param_level;}
__attribute__((visibility("default"))) float new_param_value(){return new_param_level;}
__attribute__((visibility("default"))) float new_loudness_value(){return new_loudness_level;}
__attribute__((visibility("default"))) float new_line_value(){return new_line_level;}
__attribute__((visibility("default"))) unsigned short* old_bands_ptr(){return old_out;}
__attribute__((visibility("default"))) float* chroma_input_ptr(){return chroma_pcm;}
__attribute__((visibility("default"))) float* chroma_ptr(){return chroma_out;}
__attribute__((visibility("default"))) float* chroma_info_ptr(){return chroma_info;}
// Samples chroma_process() reads at the current rate (oldest first): ~0.5 s plus the filter.
__attribute__((visibility("default"))) int chroma_input_size(){ensure_tables();return CHROMA_N*chroma_d+chroma_taps-1;}

__attribute__((visibility("default"))) void reset_dsp() {
    ensure_tables();
    for(int i=0;i<MAX_N;i++){input_pcm[i]=0;real_fft[i]=0;imag_fft[i]=0;}
    for(int i=0;i<BANDS;i++){bands[i]=0;raw_bands[i]=0;targets[i]=0;prev_bands[i]=0;baseline[i]=0.003f;noise_floor[i]=0;old_out[i]=0;band_avg[i]=band_ref[i]=0.04f;}
    for(int i=0;i<128;i++)tempo_scores[i]=0;
    for(int i=0;i<4;i++)tempo_info[i]=0;
    for(int i=0;i<64;i++){hold64[i]=0;if(i<32)hold32[i]=0;if(i<BANDS)hold16[i]=0;}
    for(int i=0;i<32;i++)remote32[i]=0;
    for(int i=0;i<64;i++)remote64[i]=0;
    for(int i=0;i<3;i++){thresholds[i]=0;pulse[i]=events[i]=flux_avg[i]=flux_dev[i]=refractory[i]=raw_group[i]=group_levels[i]=0;}
    for(int i=0;i<10;i++)metrics[i]=0;
    for(int i=0;i<256;i++)novelty_ring[i]=0;
    novelty_pos=novelty_filled=novelty_updates=0;novelty_elapsed=novelty_sum=0;
    bpm=bpm_confidence=beat_phase=beat_pulse=new_wave_elapsed=0;
    for(int i=0;i<64;i++){old_now[i]=old_prev[i]=0;}
    for(int i=0;i<50;i++){old_min_hist[i]=65535;old_max_hist[i]=0;}
    old_frames=0;warm_count=0;level_ref=0.04f;
    wave_frames=param_frames=wave_write=new_wave_write=0;old_param_level=new_param_level=0;loudness_peak=.006f;new_loudness_level=new_line_level=0;
    for(int i=0;i<128;i++)old_wave[i]=new_wave[i]=0;
    for(int i=0;i<200;i++)wave_min_hist[i]=65535,wave_max_hist[i]=0;
    for(int i=0;i<151;i++)param_min_hist[i]=65535,param_max_hist[i]=0;
    for(int i=0;i<12;i++)chroma_out[i]=0;
    chroma_ref=chroma_info[3]=0;
}

// Host supplies N = 64..8192 (power of two) PCM values at set_sample_rate().
// All state is separate from hardware acquisition and framebuffer rendering.
__attribute__((visibility("default"))) void new_process(int n,float hop_seconds,float attack_ms,float release_ms,
                    float noise_gate,float sensitivity,float user_gain,float compression,float agc_ms,float adaptive_floor) {
    if (n < 64 || n > MAX_N || (n & (n - 1))) return;
    ensure_tables();
    // Frame-local DC removal; a continuous high-pass filter is a future alternative.
    float mean=0;
    for(int i=0;i<n;i++)mean+=input_pcm[i];
    mean/=n;
    float frame_rms=0;
    const float* wc=WINDOWS[window_type];
    for(int i=0;i<n;i++){
        // Cosine window from the fixed lookup, <1-sample phase rounding.
        const int ci=(int)((long long)i*(MAX_N-1)/(n-1));
        const int k=(int)((long long)ci*MAX_N/(MAX_N-1))%MAX_N;
        float win=wc[0]-wc[1]*twiddle_cos[k];
        if(window_type>=2)win+=wc[2]*twiddle_cos[(2*k)%MAX_N]-wc[3]*twiddle_cos[(3*k)%MAX_N]+wc[4]*twiddle_cos[(4*k)%MAX_N];
        float v=(input_pcm[i]-mean)*win;
        frame_rms+=v*v;
        real_fft[i]=v;imag_fft[i]=0;
    }
    frame_rms=sqrt_fast(frame_rms/n);
    if(window_type){ // the loudness envelopes keep the Hann window's scale
        float power=wc[0]*wc[0];
        for(int j=1;j<5;j++)power+=wc[j]*wc[j]*.5f;
        frame_rms*=sqrt_fast(.375f/power);
    }
    // A slowly decaying reference prevents the line/parameter modes from
    // sitting near a constant spectral mean. A fast envelope retains the
    // separate attack/release dynamics of musical hits.
    // Below the loudness threshold the reference holds: silence (a pause) must
    // not lower it, or the next hit flashes at full scale.
    if(frame_rms>=0.0015f)loudness_peak=maxf(frame_rms,loudness_peak*maxf(0.0f,1.0f-hop_seconds/1.5f));
    float loudness_target=clamp((frame_rms-0.0015f)/maxf(0.004f,loudness_peak*1.05f),0.f,1.f);
    loudness_target=loudness_target*loudness_target; // more contrast in verse vs hit
    float al=clamp(hop_seconds/(loudness_target>new_loudness_level?0.025f:0.15f),0.0f,1.0f);
    new_loudness_level+=(loudness_target-new_loudness_level)*al;
    float line_target=clamp((frame_rms-0.002f)/maxf(0.004f,loudness_peak*1.15f),0.f,1.f);
    line_target=line_target*line_target;
    float line_a=clamp(hop_seconds/(line_target>new_line_level?0.016f:0.105f),0.0f,1.0f);
    new_line_level+=(line_target-new_line_level)*line_a;
    fft(n);
    for(int k=0;k<n/2;k++){
        spectrum[k]=2.0f*sqrt_fast(real_fft[k]*real_fft[k]+imag_fft[k]*imag_fft[k])/(wc[0]*n);
    }
    spectrum[0]=0;
    // Average spectral magnitudes in 16 logarithmic bands of the range, after the tilt.
    float total=0;
    for(int b=0;b<BANDS;b++){
        float raw=band_magnitude(edges64[b*4],edges64[b*4+4],n)*tilt16[b]*group_gain[group_of(b)];
        raw_bands[b]=raw;
        total+=raw;
    }
    float average=total/BANDS;
    // Slow global AGC; retains inter-band balance (does not normalize each FFT frame to its own max).
    // Gated: bands at or below the noise gate are silence, which would otherwise
    // pump the gain up during a pause and overshoot when the music returns.
    const bool silent=average<=noise_gate;
    float agc_alpha=clamp(hop_seconds / maxf(0.02f,agc_ms/1000.0f),0.002f,0.4f);
    if(!silent)level_ref+=(average-level_ref)*agc_alpha;
    const float ref=maxf(0.003f,level_ref);
    // Band balance: each band's own average (~4 s, also gated) pulls its
    // reference away from the global one, by at most 18 dB either way.
    const float band_alpha=clamp(hop_seconds/4.f,0.0005f,0.05f);
    for(int b=0;b<BANDS;b++){
        if(!silent)band_avg[b]+=(raw_bands[b]-band_avg[b])*band_alpha;
        band_ref[b]=(1.f-band_balance)*ref+band_balance*clamp(band_avg[b],ref*.125f,ref*8.f);
    }
    const int group_size[3]={split_mid,split_high-split_mid,BANDS-split_high};
    float attack=clamp(hop_seconds/maxf(0.005f,attack_ms/1000.0f),0.005f,1);
    float release=clamp(hop_seconds/maxf(0.015f,release_ms/1000.0f),0.005f,1);
    float activity=0;
    for(int g=0;g<3;g++)group_levels[g]=0;
    float smoothed[BANDS];
    for(int b=0;b<BANDS;b++){
        float raw=raw_bands[b];
        const int g=group_of(b);
        baseline[b]+=(raw-baseline[b])*clamp(hop_seconds/1.2f,0.002f,0.08f);
        // Optional slow-adapting noise estimate: follows quieter conditions
        // quickly (floor_fall, 0.1 s) but rises only slowly (floor_rise, 8 s),
        // to avoid interpreting music as noise. adaptive_floor 0..2 is how much
        // of it is subtracted (above 1 also part of what rises just above it).
        float floor_alpha=clamp(hop_seconds/(raw<noise_floor[b]?floor_fall:floor_rise),0.00005f,0.5f);
        if(!silent)noise_floor[b]+=(raw-noise_floor[b])*floor_alpha;
        float v=maxf(0,raw-noise_gate-noise_floor[b]*clamp(adaptive_floor,0.f,2.f));
        // Previous implementation hard-clipped most active bands to 1.0 after AGC,
        // causing the display and parameter-control envelope to remain constant.
        // Use a continuous soft knee: the response stays monotonic for loud audio
        // and still has headroom for rhythmic peaks. Global AGC (not per-frame max)
        // preserves relative energy between frequency bands.
        float normalized=maxf(0.f,v*user_gain/(band_ref[b]*6.5f));
        float compressed=dynamics(normalized,compression);
        float target=compressed/(0.85f+compressed);
        targets[b]=smoothed[b]=target;
        // Relative onset = rising spectral energy above slowly tracked baseline.
        float flux=maxf(0.0f,raw-prev_bands[b]);
        float rel=flux/(baseline[b]+0.008f);
        raw_group[g]+=rel/group_size[g];
        prev_bands[b]=raw;
    }
    // Band smoothing, then the attack / peak hold / release envelope.
    smooth_targets(smoothed,BANDS);
    for(int b=0;b<BANDS;b++){
        envelope(bands[b],hold16[b],smoothed[b],attack,release,hop_seconds);
        activity+=bands[b];
        group_levels[group_of(b)]+=bands[b]/group_size[group_of(b)];
    }
    for(int g=0;g<3;g++){
        const float flux=raw_group[g];
        // Adaptive mean and deviation over the onset memory (default ~0.7 s).
        float a=clamp(hop_seconds/onset_memory,0.005f,0.12f);
        flux_avg[g]+=(flux-flux_avg[g])*a;
        flux_dev[g]+=(absf(flux-flux_avg[g])-flux_dev[g])*a;
        float threshold=0.07f+sensitivity*onset_trim[g]*(flux_avg[g]+1.2f*flux_dev[g]);
        thresholds[g]=threshold;
        refractory[g]=maxf(0,refractory[g]-hop_seconds);
        events[g]=0;
        if(warm_count>5 && flux>threshold && refractory[g]<=0 && activity>0.035f){
            events[g]=1;
            pulse[g]=clamp(flux/(threshold+0.0001f),0.6f,1.0f);
            refractory[g]=holdoff[g];
        } else {
            pulse[g]=maxf(0,pulse[g]-hop_seconds/flash_decay[g]);
        }
        raw_group[g]=0;
        metrics[g]=flux;
    }
    // Remote 32/64 bands are calculated after the original 16-band AGC update.
    // They do not influence or change the local 16-band visualizer.
    remote_spectrum(32,remote32,hold32,tilt32,n,hop_seconds,attack,release,noise_gate,user_gain,compression);
    remote_spectrum(64,remote64,hold64,tilt64,n,hop_seconds,attack,release,noise_gate,user_gain,compression);
    metrics[3]=frame_rms;
    metrics[4]=activity/BANDS;
    metrics[5]=level_ref;
    // Optional experimental tempo tracker: normalized spectral-flux autocorrelation
    // over 3-4 s. 30-50k multiplications/s at 16kHz/hop256, no allocation.
    float novelty=clamp(0.55f*metrics[0]+0.45f*metrics[1],0.f,5.f);
    // Short, overlapping FFTs must not shorten the tempo tracker's time window.
    novelty_elapsed+=hop_seconds;novelty_sum+=novelty;
    if(novelty_elapsed+0.000001f>=NOVELTY_STEP){
        novelty_elapsed=maxf(0.f,novelty_elapsed-NOVELTY_STEP);
        novelty_ring[novelty_pos]=novelty_sum;novelty_sum=0;
        novelty_pos=(novelty_pos+1)&255;
        if(novelty_filled<256)novelty_filled++;
        novelty_updates++;
        if(novelty_filled>=192 && (novelty_updates&15)==0){
            float mean=0,variance=0;
            for(int i=0;i<192;i++)mean+=novelty_ring[(novelty_pos-1-i)&255];
            mean/=192.f;
            for(int i=0;i<192;i++){float v=novelty_ring[(novelty_pos-1-i)&255]-mean;variance+=v*v;}
            float best=-1.f;int best_lag=0;
            // Lags of the tempo range (default 65..180 BPM: lags 21..58).
            const int minlag=tempo_minlag,maxlag=tempo_maxlag;
            for(int i=0;i<128;i++)tempo_scores[i]=0;
            for(int lag=minlag;lag<=maxlag;lag++){
                float dot=0;
                for(int i=0;i<192-lag;i++){
                    float a=novelty_ring[(novelty_pos-1-i)&255]-mean;
                    float b=novelty_ring[(novelty_pos-1-i-lag)&255]-mean;
                    dot+=a*b;
                }
                float score=dot/maxf(0.00001f,variance)*(192.f/(192-lag));
                tempo_scores[lag]=score;
                if(score>best){best=score;best_lag=lag;}
            }
            tempo_info[0]=(float)minlag;tempo_info[1]=(float)maxlag;tempo_info[2]=(float)best_lag;tempo_info[3]=best;
            float observed=best_lag>0?60.f/(best_lag*NOVELTY_STEP):0;
            if(best>0.17f && observed>0.f){
                if(bpm==0 || absf(bpm-observed)>45.f)bpm=observed;
                else bpm+=(observed-bpm)*0.20f;
                bpm_confidence=clamp(best*1.7f,0.f,1.f);
            }else{
                bpm_confidence*=0.85f;
                if(bpm_confidence<0.08f)bpm=0.f;
            }
        }
    }
    beat_pulse=maxf(0.f,beat_pulse-hop_seconds/0.23f);
    if(bpm>0 && bpm_confidence>0.21f){
        float advanced=beat_phase+hop_seconds*bpm/60.f;
        if(advanced>=1.f){advanced-=1.f;beat_pulse=1.f;}
        beat_phase=advanced;
        // Phase-lock to bass onsets only close to the predicted beat. A hit
        // just before the predicted beat is that beat: it pulses now (the
        // phase restarting at 0 would otherwise skip the pulse).
        if(events[0]>0 && (beat_phase<0.18f||beat_phase>0.82f)){
            if(beat_phase>0.82f)beat_pulse=1.f;
            beat_phase=0.f;
        }
    }else beat_phase=0.f;
    metrics[6]=bpm;metrics[7]=bpm_confidence;metrics[8]=beat_phase;metrics[9]=beat_pulse;
    // Normalized envelope for parameter control; independent from audio brightness overlay.
    float peak=0;
    for(int i=0;i<16;i++)peak=maxf(peak,bands[i]);
    float weighted=0.45f*peak+0.55f*(activity/16.f);
    new_param_level=clamp(weighted*1.55f,0.f,1.f);
    new_wave_elapsed+=hop_seconds;
    if(new_wave_elapsed>=0.025f){
        new_wave_elapsed-=0.025f;
        new_wave_write=(new_wave_write+127)%128;
        // Wave history follows loudness, the same signal the ESP receives as
        // AUDIO_FRAME.rms and stores in its own 25 ms wave history.
        new_wave[new_wave_write]=new_loudness_level;
    }
    ++warm_count;
}

// Chroma of the chroma_input_size() samples in chroma_input_ptr() (oldest
// first), seconds_since the previous call (for the smoothing). Peaks of the
// spectrum between A1 (55 Hz) and B6 (1976 Hz) count with what they rise
// above twice their background (+-2 semitones: noise and drums cancel), are
// put between bins by a parabola through the log magnitudes and split
// between the two nearest semitones; octaves fold into C, C#, ... B.
// Normalised to the strongest class, but at least 5% of all the magnitude
// in that range (noise stays dim) and 10% of the recent strongest class
// (a fade dims), then attack 80 ms / release 250 ms.
__attribute__((visibility("default"))) void chroma_process(float seconds_since){
    ensure_tables();
    const int n=CHROMA_N,d=chroma_d,taps=chroma_taps;
    const float rate=sample_rate/d,bin=rate/n;
    // Low-pass and decimate, remove DC, Hann window.
    float mean=0.f;
    for(int j=0;j<n;j++){
        const float* x=chroma_pcm+j*d;float acc=0.f;
        for(int t=0;t<taps;t++)acc+=chroma_fir[t]*x[t];
        real_fft[j]=acc;mean+=acc;
    }
    mean/=n;
    for(int j=0;j<n;j++){real_fft[j]=(real_fft[j]-mean)*(.5f-.5f*twiddle_cos[j*(MAX_N/n)]);imag_fft[j]=0.f;}
    fft(n);
    // Magnitudes (a full-scale tone reads 1) and their running sum for the backgrounds.
    chroma_cum[0]=0.f;
    for(int k=0;k<=n/2;k++){
        chroma_mag[k]=k?4.f*sqrt_fast(real_fft[k]*real_fft[k]+imag_fft[k]*imag_fft[k])/n:0.f;
        chroma_cum[k+1]=chroma_cum[k]+chroma_mag[k];
    }
    float raw[12]={0},total=0.f;
    const int k0=maxf(2.f,50.f/bin),k1=minf(n/2-2,2150.f/bin);
    for(int k=k0;k<=k1;k++){
        const float m=chroma_mag[k];
        total+=m;
        if(m<1e-4f||m<=chroma_mag[k-1]||m<chroma_mag[k+1])continue;
        const int w=k/8<4?4:k/8,a=k-w<1?1:k-w,b=k+w>n/2?n/2:k+w;
        const float excess=m-2.f*(chroma_cum[b+1]-chroma_cum[a])/(b-a+1);
        if(excess<=0.f)continue;
        const float l=log2_fast(chroma_mag[k-1]),c=log2_fast(m),r=log2_fast(chroma_mag[k+1]),den=l-2.f*c+r;
        const float delta=den<0.f?clamp(.5f*(l-r)/den,-.5f,.5f):0.f;
        const float midi=69.f+12.f*log2_fast((k+delta)*bin/440.f);
        if(midi<32.f||midi>=96.f)continue;
        // Half a semitone of fade below A1 and above B6.
        const float weight=excess*clamp(minf(midi-32.f,96.f-midi),0.f,1.f);
        const int note=(int)midi;const float frac=midi-note;
        raw[note%12]+=weight*(1.f-frac);raw[(note+1)%12]+=weight*frac;
    }
    float peak=0.f;
    for(int i=0;i<12;i++)peak=maxf(peak,raw[i]);
    if(peak>1e-4f)chroma_ref=maxf(peak,chroma_ref*maxf(0.f,1.f-seconds_since/8.f));
    const float norm=maxf(maxf(peak,.05f*total),maxf(.1f*chroma_ref,1e-4f));
    const float attack=clamp(seconds_since/.08f,0.f,1.f),release=clamp(seconds_since/.25f,0.f,1.f);
    for(int i=0;i<12;i++){
        const float target=raw[i]/norm;
        chroma_out[i]+=(target-chroma_out[i])*(target>chroma_out[i]?attack:release);
    }
    chroma_info[0]=rate;chroma_info[1]=(float)n;chroma_info[2]=(float)d;chroma_info[3]=peak/norm;
}

// Legacy VolumeAnalyzer amplitude, 5-second rolling min/max. Out-of-bounds
// log LUT index is clamped rather than emulating the firmware undefined read.
static float legacy_volume(unsigned short* sample,int count,
                           unsigned short* min_history,unsigned short* max_history,
                           unsigned slots,unsigned& frames,int gain,int gate){
    unsigned short low=65535,high=0;
    for(int i=0;i<count;i++){
        unsigned short v=sample[i];if(v<gate)v=0;
        if(gain>0)v=(unsigned short)(v*(unsigned)gain);
        if(v<low)low=v;if(v>high)high=v;
    }
    unsigned slot=frames%slots;min_history[slot]=low;max_history[slot]=high;
    unsigned short hlow=65535,hhigh=0;
    unsigned filled=frames<slots?frames+1:slots;
    for(unsigned i=0;i<filled;i++){
        if(min_history[i]<hlow)hlow=min_history[i];
        if(max_history[i]>hhigh)hhigh=max_history[i];
    }
    frames++;
    if(hhigh==hlow)return 0.f;
    int idx=(int(high)-int(low))*256/(hhigh-hlow);
    if(idx>255)idx=255;
    if(idx<0)idx=0;
    return clamp((float)oldlog[idx]/4096.f,0.f,1.f);
}
__attribute__((visibility("default"))) void old_volume_process(int mode,int gain,int gate){
    if(mode==0){
        float v=legacy_volume(old_wave_input,16,wave_min_hist,wave_max_hist,200,wave_frames,gain,gate);
        wave_write=(wave_write+127)%128;old_wave[wave_write]=v;
    } else {
        old_param_level=legacy_volume(old_param_input,64,param_min_hist,param_max_hist,151,param_frames,gain,gate);
    }
}
__attribute__((visibility("default"))) int old_wave_head(){return (int)wave_write;}
__attribute__((visibility("default"))) int new_wave_head(){return (int)new_wave_write;}

// Faithful *core* model of existing SpectrumAnalyzer/Fourier/LogScale:
// unsigned 10-bit ADC input, cosine-only DFT, uint16 scaling, 50-frame rolling extrema,
// logarithmic LUT, 16-column frequency mapping and 100ms interpolation.
// Excludes real ESP8266 ADC jitter, LED timing and undefined out-of-bounds behavior.
__attribute__((visibility("default"))) void old_process(int gain, int gate){
    for(int k=0;k<64;k++)old_prev[k]=old_now[k];
    for(int k=0;k<64;k++){
        int accum=0;
        for(int i=0;i<128;i++){
            unsigned short v=old_input[i];
            if(v<gate)v=0;
            if(gain>0)v=(unsigned short)(v*(unsigned int)gain);
            int ci=(k*i)%128;
            int cosine=(int)(cos1024[ci*8]*4096.0f);
            accum+=(int)v*cosine;
        }
        int amplitude=(absi(accum)/4096/64);
        old_now[k]=(unsigned short)amplitude;
    }
    old_now[0]=old_now[1];
    unsigned short fmin=65535,fmax=0;
    for(int k=0;k<64;k++){
        if(old_now[k]<fmin)fmin=old_now[k];
        if(old_now[k]>fmax)fmax=old_now[k];
    }
    int slot=(int)(old_frames%50);
    old_min_hist[slot]=fmin;old_max_hist[slot]=fmax;
    unsigned short minval=65535,maxval=0;
    int filled=old_frames<50?(int)old_frames+1:50;
    for(int i=0;i<filled;i++){
        if(old_min_hist[i]<minval)minval=old_min_hist[i];
        if(old_max_hist[i]>maxval)maxval=old_max_hist[i];
    }
    int width=maxval-minval;
    if(width>0){
        for(int k=0;k<64;k++){
            int rel=((int)old_now[k]-minval)*256/width;
            // Legacy code could read log_table[256] OOB; clamp only to keep lab stable.
            rel=rel<0?0:(rel>255?255:rel);
            old_now[k]=oldlog[rel];
        }
    }
    old_frames++;
}
__attribute__((visibility("default"))) void old_interpolate(int frac,int gate){
    if(frac<0)frac=0;if(frac>255)frac=255;
    for(int b=0;b<16;b++){
        int left=old_idx[b>0?b-1:0],right=old_idx[b];
        unsigned int sum=0;int valid=0;
        for(int j=left;j<=right;j++){
            int val=(int)old_prev[j]-((int)old_prev[j]-(int)old_now[j])*frac/255;
            if(val<0)val=0;
            sum+=(unsigned int)val;
            if(val>=gate)valid++;
        }
        old_out[b]=(unsigned short)minf(valid>0?sum/valid:0,4096);
    }
}
}
// Tiny compiler runtime shims for freestanding WASM. (Not needed for ESP-IDF build.)
extern "C" __attribute__((optnone)) void* memset(void* dest,int val,unsigned long count) {
    volatile unsigned char* p=(volatile unsigned char*)dest;
    for(unsigned long i=0;i<count;i++)p[i]=(unsigned char)val;
    return dest;
}
extern "C" __attribute__((optnone)) void* memcpy(void* dest,const void* src,unsigned long count) {
    volatile unsigned char* d=(volatile unsigned char*)dest;
    volatile const unsigned char* s=(volatile const unsigned char*)src;
    for(unsigned long i=0;i<count;i++)d[i]=s[i];
    return dest;
}
