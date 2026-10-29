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
static float metrics[10]; // flux x3, RMS, activity, AGC ref, BPM, beat confidence, phase, beat pulse
static float novelty_ring[256];
static int novelty_pos=0,novelty_filled=0,novelty_updates=0;
static float novelty_elapsed=0,novelty_sum=0;
static constexpr float NOVELTY_STEP=.016f;
static float bpm=0.f,bpm_confidence=0.f,beat_phase=0.f,beat_pulse=0.f;
static float new_wave_elapsed=0.f;
static float level_ref = 0.04f;
static unsigned int warm_count=0;

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
static void remote_spectrum(int count,float* out,int n,
                            float ref,float attack,float release,float noise_gate,
                            float gain,float compression){
    const int step=64/count;
    for(int b=0;b<count;b++){
        float raw=band_magnitude(edges64[b*step],edges64[(b+1)*step],n);
        float v=maxf(0.f,raw-noise_gate);
        float normalized=v*gain/(ref*6.5f);
        float compressed=(1.f-compression)*normalized+compression*sqrt_fast(normalized);
        float target=compressed/(.85f+compressed);
        out[b]+= (target-out[b])*(target>out[b]?attack:release);
        out[b]=clamp(out[b],0.f,1.f);
    }
}

// Logarithmic edges between range_lo and range_hi: q = (hi/lo)^(1/64) by six
// square roots (no libm).
static void compute_edges(){
    double q=range_hi/range_lo;
    for(int i=0;i<6;i++)q=__builtin_sqrt(q);
    double edge=range_lo;
    for(int i=0;i<64;i++){edges64[i]=(float)edge;edge*=q;}
    edges64[64]=(float)range_hi;
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

static bool tables_ready=false;
static void ensure_tables(){if(!tables_ready){compute_twiddles();compute_edges();tables_ready=true;}}

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
    sample_rate=(float)rate;set_frequency_range((float)range_lo,(float)range_hi);
}
__attribute__((visibility("default"))) int max_fft_size(){return MAX_N;}
__attribute__((visibility("default"))) float* new_input_ptr(){return input_pcm;}
__attribute__((visibility("default"))) float* new_spectrum_ptr(){return spectrum;}
__attribute__((visibility("default"))) float* new_bands_ptr(){return bands;}
__attribute__((visibility("default"))) float* new_remote32_ptr(){return remote32;}
__attribute__((visibility("default"))) float* new_remote64_ptr(){return remote64;}
__attribute__((visibility("default"))) float* new_raw_ptr(){return raw_bands;}
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

__attribute__((visibility("default"))) void reset_dsp() {
    ensure_tables();
    for(int i=0;i<MAX_N;i++){input_pcm[i]=0;real_fft[i]=0;imag_fft[i]=0;}
    for(int i=0;i<BANDS;i++){bands[i]=0;raw_bands[i]=0;prev_bands[i]=0;baseline[i]=0.003f;noise_floor[i]=0;old_out[i]=0;}
    for(int i=0;i<32;i++)remote32[i]=0;
    for(int i=0;i<64;i++)remote64[i]=0;
    for(int i=0;i<3;i++){pulse[i]=events[i]=flux_avg[i]=flux_dev[i]=refractory[i]=raw_group[i]=group_levels[i]=0;}
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
    for(int i=0;i<n;i++){
        // Hann window, fixed lookup with <1-sample phase rounding.
        const int ci=(int)((long long)i*(MAX_N-1)/(n-1));
        const float win=0.5f-0.5f*twiddle_cos[(int)((long long)ci*MAX_N/(MAX_N-1))%MAX_N];
        float v=(input_pcm[i]-mean)*win;
        frame_rms+=v*v;
        real_fft[i]=v;imag_fft[i]=0;
    }
    frame_rms=sqrt_fast(frame_rms/n);
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
    // Radix-2 complex FFT, real input. No libm or heap allocation.
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
    for(int k=0;k<n/2;k++){
        spectrum[k]=2.0f*sqrt_fast(real_fft[k]*real_fft[k]+imag_fft[k]*imag_fft[k])/(0.5f*n);
    }
    spectrum[0]=0;
    // Average spectral magnitudes in 16 logarithmic bands of the range.
    float total=0;
    for(int b=0;b<BANDS;b++){
        float raw=band_magnitude(edges64[b*4],edges64[b*4+4],n);
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
    float attack=clamp(hop_seconds/maxf(0.005f,attack_ms/1000.0f),0.005f,1);
    float release=clamp(hop_seconds/maxf(0.015f,release_ms/1000.0f),0.005f,1);
    float activity=0;
    for(int g=0;g<3;g++)group_levels[g]=0;
    for(int b=0;b<BANDS;b++){
        float raw=raw_bands[b];
        baseline[b]+=(raw-baseline[b])*clamp(hop_seconds/1.2f,0.002f,0.08f);
        // Optional slow-adapting noise estimate: follows quieter conditions
        // quickly but rises only over ~8s, to avoid interpreting music as noise.
        float floor_alpha=clamp(hop_seconds/(raw<noise_floor[b]?0.1f:8.f),0.0003f,0.25f);
        if(!silent)noise_floor[b]+=(raw-noise_floor[b])*floor_alpha;
        float v=maxf(0,raw-noise_gate-noise_floor[b]*clamp(adaptive_floor,0.f,1.f));
        // Previous implementation hard-clipped most active bands to 1.0 after AGC,
        // causing the display and parameter-control envelope to remain constant.
        // Use a continuous soft knee: the response stays monotonic for loud audio
        // and still has headroom for rhythmic peaks. Global AGC (not per-frame max)
        // preserves relative energy between frequency bands.
        float normalized=maxf(0.f,v*user_gain/(ref*6.5f));
        float compressed=(1-compression)*normalized+compression*sqrt_fast(normalized);
        float target=compressed/(0.85f+compressed);
        float coeff=target>bands[b]?attack:release;
        bands[b]+=(target-bands[b])*coeff;
        activity+=bands[b];
        group_levels[b<5?0:b<12?1:2]+=bands[b]/(b<5?5.f:b<12?7.f:4.f);
        // Relative onset = rising spectral energy above slowly tracked baseline.
        float flux=maxf(0.0f,raw-prev_bands[b]);
        float rel=flux/(baseline[b]+0.008f);
        int g= (b<5)?0:((b<12)?1:2);
        raw_group[g]+=rel/(g==0?5.0f:(g==1?7.0f:4.0f));
        prev_bands[b]=raw;
    }
    for(int g=0;g<3;g++){
        const float flux=raw_group[g];
        // Adaptive mean and deviation on a ~0.7s time scale.
        float a=clamp(hop_seconds/0.7f,0.005f,0.12f);
        flux_avg[g]+=(flux-flux_avg[g])*a;
        flux_dev[g]+=(absf(flux-flux_avg[g])-flux_dev[g])*a;
        float threshold=0.07f+sensitivity*(flux_avg[g]+1.2f*flux_dev[g]);
        refractory[g]=maxf(0,refractory[g]-hop_seconds);
        events[g]=0;
        if(warm_count>5 && flux>threshold && refractory[g]<=0 && activity>0.035f){
            events[g]=1;
            pulse[g]=clamp(flux/(threshold+0.0001f),0.6f,1.0f);
            refractory[g]=(g==0)?0.16f:0.085f;
        } else {
            pulse[g]=maxf(0,pulse[g]-hop_seconds/(g==0?0.22f:0.13f));
        }
        raw_group[g]=0;
        metrics[g]=flux;
    }
    // Remote 32/64 bands are calculated after the original 16-band AGC update.
    // They do not influence or change the local 16-band visualizer.
    remote_spectrum(32,remote32,n,ref,attack,release,noise_gate,user_gain,compression);
    remote_spectrum(64,remote64,n,ref,attack,release,noise_gate,user_gain,compression);
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
            const int minlag=(int)(60.f/(180.f*NOVELTY_STEP)+0.5f);
            const int maxlag=(int)(60.f/(65.f*NOVELTY_STEP)+0.5f);
            for(int lag=minlag;lag<=maxlag;lag++){
                float dot=0;
                for(int i=0;i<192-lag;i++){
                    float a=novelty_ring[(novelty_pos-1-i)&255]-mean;
                    float b=novelty_ring[(novelty_pos-1-i-lag)&255]-mean;
                    dot+=a*b;
                }
                float score=dot/maxf(0.00001f,variance)*(192.f/(192-lag));
                if(score>best){best=score;best_lag=lag;}
            }
            float observed=best_lag>0?60.f/(best_lag*NOVELTY_STEP):0;
            if(best>0.17f && observed>60.f && observed<190.f){
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
        // Phase-lock to bass onsets only close to the predicted beat.
        if(events[0]>0 && (beat_phase<0.18f||beat_phase>0.82f))beat_phase=0.f;
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
