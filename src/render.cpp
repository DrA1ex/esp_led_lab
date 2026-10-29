// ESP LED LAMP WebAssembly rendering adapter.
// Original effect formulas ported from DrA1ex/esp_led_lamp src/fx/color_efect.cpp,
// src/fx/brightness_effect.cpp, src/fx/audio_effect.cpp and src/utils/palette.cpp.
// FastLED 3.6.0 core math/noise is ported from matching upstream source; physical
// LED output, timing and device ADC remain outside this portable render layer.
#include "tables.h"
#include "fastled_compat.h"

// Matrices up to 128x128 and LED strips up to 1024 pixels long (e.g. 153x1,
// 72x2). The pixel budget, not either side, bounds the framebuffer.
static constexpr int MAX_W=1024,MAX_H=128;
static constexpr int MAX_PIX=128*128;
static constexpr int WAVE_HISTORY=128;
static unsigned char rgba[MAX_PIX*4];
static unsigned int palette[16];
static unsigned char gamma_lut[256];
static float features[160]; // 0..15 spectrum; 16..21 onset; 22..23 volume; 24..151 wave; 152..155 tempo; 156..158 low/mid/high levels
static int W=16,H=16;
static int color_fx=0,bright_fx=0,speed=82,scale=190,light=180;
static int audio_fx=3; // Off, 10 firmware modes, 2 explicitly experimental modes
static float audio_mix=1.f;
static int audio_min=0,audio_max=255;
// New-DSP-only expressive modulation; the legacy WASM instance receives zeros
// and continues to use the original AudioEffectManager mapping unchanged.
static float spectrum_expression=0.f,spectrum_onset=0.f,line_expression=0.f;
static int speed_floor=0;
// Signal window: input range [in_min,in_max] (of 255) is stretched onto
// audio_min..audio_max; below in_min gives the minimum (or 0 with in_gate),
// above in_max the maximum. In between, the window position t goes through
// t^(in_curve/100) via a 257-entry table filled by the host (curve_table_ptr)
// with round(65535 * (i/256)^gamma), like firmware TransferCurve.
// Defaults reproduce the firmware mapping.
static int in_min=0,in_max=255,in_curve=100;static bool in_gate=false;
static uint16_t curve_table[257];
// Origin of every spatial audio mode (firmware RemoteReactive::Origin): the
// start/centre shift in permille of W, reverse direction, ring wrap, and a
// radial centre at row origin_y (permille of H-1) for matrices. Defaults ==
// stock firmware geometry.
static int origin_shift=0,origin_y=500;static bool origin_reverse=false,origin_ring=false,origin_radial=false;
static double time_ms=0.,phase_color=0.,phase_bright=0.;
static uint16_t fastled_seed=1337;

struct Particle {int x,y;unsigned char brightness;unsigned int color;};
static Particle particles[100];

static inline int mini(int a,int b){return a<b?a:b;}
static inline int maxi(int a,int b){return a>b?a:b;}
static inline float minf(float a,float b){return a<b?a:b;}
static inline float maxf(float a,float b){return a>b?a:b;}
static inline float clampf(float v,float l,float h){return maxf(l,minf(h,v));}
static inline unsigned char u8(int a){return (unsigned char)maxi(0,mini(a,255));}
static inline float abf(float v){return v<0?-v:v;}
static inline float fract(float x){return x-(int)x+(x<0&&x!=(int)x?1:0);}
static inline int fl_round(float f){return int(f + (f < 0 ? -.5f : .5f));}
static inline float sin16f(float value){int32_t k=int32_t(value/65536.f);if(k)value-=k*65536.f;return float(fl_sin16(uint16_t(fl_round(value)))+32767);}
static inline float sin8f(float value){return sin16f(value*256.f)/65536.f*255.f;}
static inline int pixel_index(int x,int y){return ((y&1) ? W-1-x:x)+y*W;}
static inline void pixel(int x,int y,unsigned int color){if(x<0||y<0||x>=W||y>=H)return;int at=pixel_index(x,y)*4;rgba[at]=(color>>16)&255;rgba[at+1]=(color>>8)&255;rgba[at+2]=color&255;rgba[at+3]=255;}
static inline unsigned int get_pixel(int x,int y){if(x<0||y<0||x>=W||y>=H)return 0;int a=pixel_index(x,y)*4;return ((unsigned)rgba[a]<<16)|((unsigned)rgba[a+1]<<8)|rgba[a+2];}
static inline void rgb_lerp_pixel(int x,int y,unsigned int rgb,int alpha){int a=pixel_index(x,y)*4;for(int c=0;c<3;c++){int old=rgba[a+c];int fresh=(rgb>>(16-8*c))&255;rgba[a+c]=fl_blend8(old,fresh,alpha);}rgba[a+3]=255;}
static inline void column(int x,unsigned int color){for(int y=0;y<H;y++)pixel(x,y,color);}
static inline void solid(unsigned int color){for(int y=0;y<H;y++)for(int x=0;x<W;x++)pixel(x,y,color);}
static inline void scale_pixel(int x,int y,uint8_t amount){int a=pixel_index(x,y)*4;for(int c=0;c<3;c++)rgba[a+c]=fl_scale8(rgba[a+c],amount);rgba[a+3]=255;}
static inline void multiply_pixel(int x,int y,float amount){scale_pixel(x,y,u8((int)(clampf(amount,0,1)*255)));}
// Firmware has an independent custom uint32_t palette blend, not FastLED::blend(CRGB).
static inline uint8_t palette_lerp(uint8_t a,uint8_t b,int t){return uint8_t(int(a)-(int(a)-int(b))*t/255);}
static inline unsigned int blend(unsigned int a,unsigned int b,int t){return (unsigned(palette_lerp(a>>16,b>>16,t))<<16)|(unsigned(palette_lerp(a>>8,b>>8,t))<<8)|palette_lerp(a,b,t);}
static inline unsigned int pal(unsigned int index,int brightness=255){int k=(index/256)%16;int mix=index%256;unsigned int c=blend(palette[k],palette[(k+1)%16],mix);if(brightness<255){int r=fl_scale8(c>>16,brightness),g=fl_scale8(c>>8,brightness),b=fl_scale8(c,brightness);return (r<<16)|(g<<8)|b;}return c;}
static inline unsigned int fastled_pal8(uint8_t index){
 uint8_t hi=index>>4,lo=index&15;unsigned int a=palette[hi];if(lo==0)return a;
 unsigned int b=palette[(hi+1)&15];uint8_t f2=lo<<4,f1=255-f2;
 uint8_t r=fl_scale8(a>>16,f1)+fl_scale8(b>>16,f2);
 uint8_t g=fl_scale8(a>>8,f1)+fl_scale8(b>>8,f2);
 uint8_t bl=fl_scale8(a,f1)+fl_scale8(b,f2);
 return (unsigned(r)<<16)|(unsigned(g)<<8)|bl;
}
static inline int inoise_hd(double x,double y,double z){return fl_inoise16(uint32_t(x*256),uint32_t(y*256),uint32_t(z*256))/16;}
static inline int inoise_hd(double x,double y){return fl_inoise16(uint32_t(x*256),uint32_t(y*256))/16;}
// Original src/utils/color.h: HSLToRGB, with lightness rather than HSV.
static inline unsigned int hsl_to_rgb(int hue,int sat,int lit){
 float h=hue/255.f*360.f,s=sat/255.f,l=lit/255.f;
 float c=(1.f-abf(2*l-1))*s;
 float v=h/60.f;float remainder=v-2.f*(float)(int)(v/2.f);
 float x=c*(1.f-abf(remainder-1.f)),m=l-c/2.f,r=0,g=0,b=0;
 if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}
 return (unsigned(u8((int)((r+m)*255)))<<16)|(unsigned(u8((int)((g+m)*255)))<<8)|u8((int)((b+m)*255));
}
static inline double phase_wrap(double value,double period){if(value>=period)value-=period;return value;}
static inline uint8_t wave8(float x){return fl_cubicwave8(uint8_t(fl_round(x)));}
static inline int ease(int v){return fl_ease8quad(uint8_t(v));}
static inline uint8_t dim8_raw(uint8_t v){return fl_scale8(v,v);}
static inline float source_value(float normalized){return clampf(normalized,0.f,1.f);}
static inline int scaled_audio(float normalized,int count){
 // AudioEffectManager::_calc_signal_value: clamp min to max, integer scale to count.
 int lo=mini(audio_min,audio_max),hi=audio_max;
 int count_min=lo*count/255,count_max=hi*count/255;
 float v=source_value(normalized);
 if(in_min!=0||in_max!=255||in_gate||in_curve!=100){
  // Same rule as firmware audioTransfer() (src/audio/transfer.h).
  if(v*255.f<in_min)return in_gate?0:count_min;
  if(v*255.f>=in_max)return count_max;
  v=(v*255.f-in_min)/(in_max-in_min);
  if(in_curve!=100){
   const int t16=(int)(v*65535.f);
   if(t16>=65535)v=1.f;
   else{const int i=t16>>8,frac=t16&255;v=(curve_table[i]+(int(curve_table[i+1])-int(curve_table[i]))*frac/256)/65535.f;}
  }
 }
 return count_min+(int)(v*(count_max-count_min));
}
// Mirrors RemoteReactive::OriginMap (src/remote_audio/reactive_math.h).
static inline bool origin_is_default(){return origin_shift==0&&origin_y==500&&!origin_reverse&&!origin_ring&&!origin_radial;}
static inline int origin_columns(){int s=W*origin_shift;return (s>=0?s+500:s-500)/1000;}
// Mapped column, or -1 outside a non-ring strip.
static inline int origin_x(int x){
 int v=(origin_reverse?W-1-x:x)-origin_columns();
 if(origin_ring){v%=W;if(v<0)v+=W;return v;}
 return v>=0&&v<W?v:-1;
}
static inline bool origin_is_radial(){return origin_radial&&H>1;}
static inline float origin_row(){return (H-1)*origin_y/1000.f;}
static inline float origin_distance(int xp,int y){
 float dx=abf(float(xp-W/2));
 if(!origin_is_radial())return dx;
 float dy=y-origin_row();
 return __builtin_sqrtf(dx*dx+dy*dy);
}
static inline float origin_max_distance(){
 float mx=maxi(W/2,W-1-W/2);
 if(!origin_is_radial())return maxf(1.f,mx);
 float cy=origin_row(),my=maxf(cy,H-1-cy);
 return maxf(1.f,__builtin_sqrtf(mx*mx+my*my));
}
static inline int origin_centered_index(int xp,int y){
 if(!origin_is_radial())return xp<=W/2?W/2-xp:xp-W/2;
 return mini(W/2,(int)(origin_distance(xp,y)*(W/2)/origin_max_distance()+.5f));
}
static inline bool origin_line_centered_lit(int xp,int y,int reach){
 if(!origin_is_radial())return (xp<W/2?W/2-xp:xp-(W-1-W/2))<=reach;
 return origin_distance(xp,y)*(W/2)/origin_max_distance()<float(reach);
}
static inline float origin_beat_radius(int xp,int y){
 if(!origin_is_radial())return abf(xp-(W-1)/2.f)/(W/2.f);
 return origin_distance(xp,y)/origin_max_distance();
}
static inline int mixed_audio(int target,int original){
 return maxi(0,mini(255,(int)(original+(target-original)*audio_mix)));
}
// One wave column per 25 ms sample; spans longer than the history (long
// strips) are stretched instead of clamped. Mirrors firmware RemoteSignalProvider.
static inline float wave_value(int index,int span){
 if(span>WAVE_HISTORY)index=index*(WAVE_HISTORY-1)/(span-1);
 return features[24+mini(WAVE_HISTORY-1,maxi(0,index))];
}
static inline float provider_at(int index){
 if(audio_fx==1)return wave_value(index,W);
 if(audio_fx==2)return wave_value(index,W/2+1);
 return features[mini(15,maxi(0,index*16/maxi(1,W)))];
}
static int pulse_phase(float phase,int offset){int value=fl_round(phase+offset)%1024;if(value<0)value+=1024;if(value<256)return 255-value;if(value<512)return 0;if(value<768)return value-512;return 255;}

// Authentic preset stop colors copied from src/fx/palette_def.h; interpolation uses src/utils/palette.cpp approach.
// All firmware PaletteEnum entries in the exact source order, Custom last.
// Sourced from src/fx/palette_def.h and src/fx/palette.cpp, main commit 0c76f620.
static const unsigned int stops[79][16]={
 {0x000000, 0x009ba8, 0x007bff, 0x002eff, 0xffffff}, // Abyss
 {0x264653, 0x2a9d8f, 0xe9c46a, 0xf4a261, 0xe76f51}, // Aquatic
 {0xed7205, 0xfbbc07, 0x913518, 0x523423, 0xc45513}, // Autumn
 {0x191970, 0x000080, 0x0077be, 0x4169e1, 0x18596b}, // Azure
 {0xffbe0b, 0xfb5607, 0xff006e, 0x8338ec, 0x3a86ff}, // Bloom
 {0x1be7ff, 0x6eeb83, 0xe4ff1a, 0xe8aa14, 0xff5714}, // Blossom
 {0x0b3866, 0x95f9c3}, // Blue
 {0x003049, 0xab2a2f, 0xea5c10, 0xf9991d, 0xf8c65f, 0xeae2b7}, // Bonfire
 {0xeb353c, 0xfacc28, 0x417a62, 0x5d9e58, 0x2f6619}, // Cherry
 {0x452316, 0xf6850a, 0xecc498, 0x846464, 0xfcefeb}, // Cinnamon
 {0x001019, 0x0a9396, 0xe9d8a6, 0xee9b00, 0x9b2226}, // Coastal
 {0xffbe0b, 0xfb5607, 0xff006e, 0x8338ec, 0x3a86ff}, // Cosmic
 {0xa60422, 0xf20244, 0xc262bb, 0x021172, 0x1e34c3}, // Crimson
 {0xdf2f52, 0x2f3746, 0x595c50, 0xe799b6, 0xa177a0}, // Dawn
 {0x2b4b74, 0xedc689, 0x30354e, 0x6c8cac, 0x19142c}, // Deep Sea
 {0x0e3055, 0x245279, 0x9ab4d1, 0xbcb4be, 0x3278a4}, // Deep
 {0x0015ff, 0xff00a1, 0x90fe00, 0x8400ff, 0x00fff7}, // Dreams
 {0xb7094c, 0x0091ad}, // Dusk
 {0xecefe1, 0x779c3e, 0xaacc24, 0x3a6c0d, 0x799960}, // Earthy
 {0xffbe0b, 0xfb5607, 0xff006e, 0x8338ec, 0x3a86ff}, // Electric
 {0x5a83a8, 0x3f5394, 0x67aa77, 0xc0c8bf, 0xb47c7c}, // Elegance
 {0x072012, 0xb7e039, 0x215c16, 0x288f74, 0x64c4ac}, // Emerald
 {0x073f04, 0x5fb620, 0x98b79a, 0x087f0a, 0x7cc096}, // Enchanted
 {0x000000, 0x30cc00, 0x00ff5d, 0x00ffc3, 0xffffff}, // Enigma
 {0x03071e, 0x600411, 0xbc0103, 0xe14103, 0xf59106, 0xffba08}, // Ethereal
 {0x0a0310, 0x49007e, 0xff005b, 0xff7d10, 0xffb238}, // Fiery
 {0x000000, 0x990000, 0xff3300, 0xffcc00, 0xffff66, 0xffffff}, // Flames
 {0xc5e094, 0x7ba64a, 0x5a8432, 0x468129, 0x5b906b}, // Forest
 {0xe2a668, 0x3bc6d6, 0x042b5c, 0x040407, 0x343408}, // Golden
 {0x4c733c, 0x308f3d, 0xb0d1bc, 0x6e7e79, 0x3b514c}, // Harmony
 {0x6b6461, 0x185a6f, 0x151515, 0xbb514f, 0x245558}, // Hush
 {0x7273fa, 0xdb1e1a, 0xa80706, 0x2829e0, 0x010173}, // Infusion
 {0x578461, 0x78a453, 0xdce5e2, 0x074c0c, 0x143c3c}, // Jade
 {0x2d3047, 0x541388, 0xd90368, 0xf3a712, 0x56a3a6}, // Lavender
 {0x007f5f, 0x55a630, 0xaacc00, 0xd4d700, 0xffff3f}, // Limeade
 {0x3a363e, 0xf38ea0, 0xeb6b58, 0xfcdde4, 0x864379}, // Luminous
 {0x2d0cff, 0xaa00ff, 0x8000e2, 0xffee00, 0x007fff}, // Magic Plum
 {0x19c1fc, 0x05520f, 0x043f4a, 0x0d6d42, 0x344444}, // Marine
 {0x3ff3a4, 0x13194a, 0xefe850, 0x3e148c, 0xf24ce4}, // Meadow
 {0x2a3533, 0x6973d0, 0x09138e, 0x342c3b, 0x443c7c}, // Midnight
 {0x648a66, 0xe48f76, 0x919f81, 0x7fb492, 0x3c9474}, // Minty
 {0x92919f, 0x0b0912, 0x3c4c7c, 0x131324, 0xac3c3c}, // Monochrome
 {0xb1bebf, 0x393944, 0x5f8823, 0xb49669, 0xd4d5b4}, // Moorland
 {0x9aa88b, 0x53734c, 0x57765e, 0x141314, 0x506449}, // Mossy
 {0x0b090a, 0x560b0c, 0xb1171b, 0xd06466, 0xdad9da, 0xffffff}, // Mystic
 {0x000000, 0x9c00cc, 0xff00a1, 0xff003c, 0xffffff}, // Neon
 {0x060809, 0x72a1de, 0xcad6f2, 0x32567e, 0x2a2c22}, // Nightfall
 {0x449af6, 0x040967, 0x040546, 0x040530, 0x3a20cc}, // Nocturnal
 {0xe63946, 0xf1faee, 0xa8dadc, 0x457b9d, 0x1d3557}, // Oasis
 {0x546981, 0x4196b8, 0xe9fbff, 0x1a2d45, 0xcedee1}, // Ocean
 {0x03f9fb, 0x1cbfff, 0x2627ce, 0x8e2eec, 0xfb69fd}, // Oceanic
 {0xf9cefd, 0xdbc3ff, 0x2150d3, 0xc8d1ff, 0xaea4ea}, // Pastel
 {0xff0000, 0x000000, 0xab5500, 0x000000, 0xabab00, 0x000000, 0x00ff00, 0x000000, 0x00ab55, 0x000000, 0x0000ff, 0x000000, 0x5500ab, 0x000000, 0xab0055, 0x000000}, // Rainbow Shadow
 {0xff0000, 0xab7f00, 0x00ff00, 0x0056aa, 0x5500ab, 0xd5002b}, // Rainbow
 {0xb04137, 0xdc5877, 0xcdc6d4, 0xdb3f5b, 0x3a2418}, // Raspberry
 {0xa06868, 0xce8f8c, 0x740e1d, 0x90944d, 0xe0c088}, // Scarlet
 {0x001219, 0x08898f, 0xc7d6af, 0xe08601, 0xb83806, 0x9b2226}, // Seaside
 {0x54aec0, 0x89856a, 0x603e29, 0x158bb3, 0xcc6ca4}, // Serenade
 {0xa7bdc9, 0x626a33, 0xf3c44e, 0x447c60, 0x9c9c96}, // Serene
 {0x011642, 0x2541b2, 0x1768ac, 0x06bee1, 0xe0fff6}, // Serenity
 {0xbbbfc4, 0x3664af, 0x163468, 0x9cacbc, 0x041454}, // Slate
 {0x984539, 0xf6c363, 0xf4a04d, 0x74645c, 0x5c4c6c}, // Spice
 {0xc3e565, 0x1b4d3a, 0xb1cc2c, 0xd48c04, 0x078eaa}, // Splash
 {0xf72585, 0x560bad, 0x3a0ca3, 0x3f37c9, 0x4cc9f0}, // Starlight
 {0x7f2606, 0x632e0d, 0xf9af11, 0xd05808, 0x7c6c84}, // Sultry
 {0xfbd25f, 0x6fa9ce, 0x5f616f, 0x140f0e, 0x42443b}, // Sunny
 {0xe5270e, 0xcb9d4d, 0xd2c050, 0xdb9046, 0xcd544f, 0x8f957d}, // Sunrise
 {0xdd600b, 0x7e2f08, 0x627963, 0x4c5f53, 0x34211d}, // Sunset
 {0xfbd1fb, 0x6b3395, 0xc483a9, 0xd4ac36, 0x4c642c}, // Tender
 {0x4a0604, 0x140404, 0x54442c, 0xb39e52, 0x543834}, // Terrain
 {0x048068, 0x92ccb7, 0x043c32, 0x042b24, 0xc8e4c8}, // Tranquil
 {0xecddbc, 0x243757, 0x618cb0, 0xaa96c8, 0x7ce0dc}, // Tropics
 {0x6a59e7, 0x2e2787, 0xb90b83, 0x3d4ce6, 0x6e0536}, // Twilight
 {0x7ccccb, 0x3c5251, 0x2e2f31, 0x212d2e, 0x2e3c3b}, // Urban
 {0x706298, 0x9735bb, 0x5e0992, 0x0b1c27, 0xc3bfd6}, // Velvet
 {0x8d90be, 0xee7260, 0xa3403a, 0x409cd5, 0x4479ab}, // Vintage
 {0x866acc, 0x4a3089, 0x316509, 0x083f04, 0x1a0965}, // Violet
 {0x627653, 0x3e6e3a, 0x395b2d, 0x949ca4, 0x193534}, // Woodland
 {0xec0075, 0xfb4917, 0xfe5e05, 0xf78242, 0xf79448, 0xfed92d, 0xd5e047, 0x2ce5b7}, // Custom
};
static const unsigned char stop_counts[79]={5, 5, 5, 5, 5, 5, 2, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 2, 5, 5, 5, 5, 5, 5, 6, 5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5, 5, 5, 16, 6, 5, 5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 8};

extern "C" {
__attribute__((visibility("default"))) int test_inoise16_2d(unsigned x,unsigned y){return fl_inoise16(x,y);}
__attribute__((visibility("default"))) int test_inoise16_3d(unsigned x,unsigned y,unsigned z){return fl_inoise16(x,y,z);}
__attribute__((visibility("default"))) int test_sin16(int v){return fl_sin16(uint16_t(v));}
__attribute__((visibility("default"))) int test_cubicwave8(int v){return fl_cubicwave8(uint8_t(v));}
__attribute__((visibility("default"))) int test_blend8(int a,int b,int t){return fl_blend8(uint8_t(a),uint8_t(b),uint8_t(t));}
__attribute__((visibility("default"))) unsigned char* gamma_lut_ptr(){return gamma_lut;}
__attribute__((visibility("default"))) void apply_palette_gamma(){
 for(int k=0;k<16;k++){unsigned c=palette[k];palette[k]=(unsigned(gamma_lut[(c>>16)&255])<<16)|(unsigned(gamma_lut[(c>>8)&255])<<8)|gamma_lut[c&255];}
}
__attribute__((visibility("default"))) unsigned int* palette_ptr(){return palette;}
__attribute__((visibility("default"))) unsigned char* framebuffer_ptr(){return rgba;}
// Logical XY test pattern. Canvas may optionally flip Y, but memory remains
// row-serpentine, exactly as Led::get_index() in the firmware.
__attribute__((visibility("default"))) void render_test_pattern(){
 solid(0x101820);
 for(int x=0;x<W;x++){pixel(x,0,0x332222);pixel(x,H-1,0x222244);}
 for(int y=0;y<H;y++){pixel(0,y,0x443322);pixel(W-1,y,0x224433);}
 pixel(0,0,0xff0000);pixel(W-1,0,0x00ff00);
 pixel(0,H-1,0x0000ff);pixel(W-1,H-1,0xffffff);
}
__attribute__((visibility("default"))) float* audio_features_ptr(){return features;}
__attribute__((visibility("default"))) int get_width(){return W;}
__attribute__((visibility("default"))) int get_height(){return H;}
__attribute__((visibility("default"))) int max_pixels(){return MAX_PIX;}
__attribute__((visibility("default"))) int max_width(){return MAX_W;}
__attribute__((visibility("default"))) int max_height(){return MAX_H;}
__attribute__((visibility("default"))) void set_dimensions(int w,int h){w=maxi(1,mini(w,MAX_W));h=maxi(1,mini(h,MAX_H));if(w*h>MAX_PIX)h=maxi(1,MAX_PIX/w);if(w==W&&h==H)return;W=w;H=h;for(int i=0;i<MAX_PIX*4;i++)rgba[i]=0;}
__attribute__((visibility("default"))) void set_palette(int index){index=maxi(0,mini(index,78));const int n=stop_counts[index];for(int j=0;j<16;j++){float pos=(float)j*(n-1)/15.f;int lo=(int)pos;int hi=mini(lo+1,n-1);palette[j]=blend(stops[index][lo],stops[index][hi],u8((int)((pos-lo)*255)));}}
__attribute__((visibility("default"))) void set_effects(int cf,int bf,int af){if(cf!=color_fx){phase_color=0;}if(bf!=bright_fx)phase_bright=0;color_fx=maxi(0,mini(cf,9));bright_fx=maxi(0,mini(bf,4));audio_fx=maxi(0,mini(af,12));}
__attribute__((visibility("default"))) void set_parameters(int s,int sc,int l,float mix){speed=maxi(0,mini(s,255));scale=maxi(0,mini(sc,255));light=maxi(0,mini(l,255));audio_mix=clampf(mix,0.f,1.f);}
__attribute__((visibility("default"))) void set_audio_range(int lo,int hi){audio_min=maxi(0,mini(lo,255));audio_max=maxi(0,mini(hi,255));}
__attribute__((visibility("default"))) void set_reaction_tuning(float spectrum_shape,float onset_boost,float line_response,int floor_speed){
 spectrum_expression=clampf(spectrum_shape,0.f,1.f);
 spectrum_onset=clampf(onset_boost,0.f,1.f);
 line_expression=clampf(line_response,0.f,1.f);
 speed_floor=maxi(0,mini(255,floor_speed));
}
// curve: exponent x 100 (25..400); 0 (omitted) means linear. Fill curve_table first.
__attribute__((visibility("default"))) void set_audio_window(int lo,int hi,int gate,int curve){in_min=maxi(0,mini(lo,255));in_max=maxi(0,mini(hi,255));in_gate=gate!=0;in_curve=curve<=0?100:maxi(25,mini(curve,400));}
__attribute__((visibility("default"))) uint16_t* curve_table_ptr(){return curve_table;}
__attribute__((visibility("default"))) void set_origin(int shift,int y,int reverse,int ring,int radial){origin_shift=maxi(-500,mini(shift,500));origin_y=maxi(0,mini(y,1000));origin_reverse=reverse!=0;origin_ring=ring!=0;origin_radial=radial!=0;}
__attribute__((visibility("default"))) void reset_render(){time_ms=phase_color=phase_bright=0;fastled_seed=1337;for(int i=0;i<100;i++)particles[i].brightness=0;for(int i=0;i<MAX_PIX*4;i++)rgba[i]=0;}
__attribute__((visibility("default"))) void render_frame(float dt){
 dt=clampf(dt,0,50);double before_ms=time_ms;time_ms+=dt;unsigned dms=(unsigned)time_ms-(unsigned)before_ms;
 // Firmware computes Speed / Scale / Light BEFORE ColorEffects and BrightnessEffects.
 // Temporarily override the preset, then restore it after the complete render.
 int preset_speed=speed,preset_scale=scale,preset_light=light;
 if(audio_fx>=8&&audio_fx<=10){
   const int v=scaled_audio(features[23],255);
   if(audio_fx==8){
     // The firmware mapping may put speed near zero (or at 128 for Gradient,
     // which is stationary). Only the new-DSP preview gets a tunable floor.
     int boosted=v;
     if(speed_floor>0)boosted=speed_floor+(v*(255-speed_floor))/255;
     speed=mixed_audio(boosted,speed);
   }
   if(audio_fx==9)scale=mixed_audio(v,scale);
   if(audio_fx==10)light=mixed_audio(v,light);
 }
 switch(color_fx){
 case 0:{ // PERLIN: original coordinate logic with FastLED 3.6.0 inoise16
   phase_color=phase_wrap(phase_color+(double)dms*speed/255,16777216.f);
   float factor=scale/2.f;
   for(int y=0;y<H;y++)for(int x=0;x<W;x++)pixel(x,y,pal(H>1?inoise_hd(x*factor,y*factor,phase_color):inoise_hd(x*factor,phase_color)));break;
 }
 case 1:{ // GRADIENT
   phase_color=phase_wrap(phase_color+(double)dms*(speed-128)/512,16777216.f);
   float sf=((float)scale*1.9f+25.f)/W;
   for(int x=0;x<W;x++)column(x,pal((unsigned short)((int)((x*sf+phase_color)*16))));break;
 }
 case 2:{ // FIRE
   phase_color=phase_wrap(phase_color+(double)dms*speed*2/255,16777216.f);
   float factor=scale/2.f;
   for(int y=0;y<H;y++){int limit=y*3584/H;float ny=16777216.f-(phase_color-y*factor);for(int x=0;x<W;x++){
     int idx=inoise_hd(x*factor,ny)-limit;int b=255;if(idx<0){b=u8(255+idx/2);idx=0;}rgb_lerp_pixel(x,y,pal((unsigned)idx,b),64);
   }}break;
 }
 case 3:{ // AURORA
   phase_color=phase_wrap(phase_color+(double)dms*(double)speed/2/255,16777215.f);
   float factor=(float)(scale/2);int hf=16*H*185/100;
   for(int y=0;y<H;y++){int limit=hf*maxi(0,(H/2-y)>0?H/2-y:y-H/2);for(int x=0;x<W;x++){
     int idx=inoise_hd(x*factor,y*H,phase_color)-limit;int b=255;if(idx<0){b=u8(255+idx/2);idx=0;}rgb_lerp_pixel(x,y,pal((unsigned)idx,b),64);
   }}break;
 }
 case 4:{ // PLASMA: formula from original color_efect.cpp
   phase_color=phase_wrap(phase_color+(float)dms*(float)speed/128/255,65536.f);
   float tf=phase_color,sf=(scale+1.f)/256.f;
   for(int x=0;x<W;x++)for(int y=0;y<H;y++){
     float idx=sin8f(tf*5+x*8+sin8f(x*2+tf*6))/2+sin8f(tf*5+y*8+sin8f(y*2+tf*7)/2);
     pixel(x,y,pal((unsigned short)((int)(idx*16*sf))));
   }break;
 }
 case 5:{ // RIPPLE: follows direct data indexing, as in firmware
   phase_color=phase_wrap(phase_color+(float)dms*(float)speed*4/255,65536.f);
   for(int y=0;y<H;y++)for(int x=0;x<W;x++){
     unsigned short idx=(unsigned short)(x+y*W);float v=sin16f(idx*((scale+1)*4.f)+phase_color*2)/16+phase_color;
     // original writes raw underlying serpentine array index rather than get_pixel()
     int at=idx*4;unsigned int c=pal((unsigned short)fl_round(v));
     rgba[at]=(c>>16)&255;rgba[at+1]=(c>>8)&255;rgba[at+2]=c&255;rgba[at+3]=255;
   }break;
 }
 case 6:{ // VELUM
   phase_color=phase_wrap(phase_color+(float)dms*(float)speed/16/255,65536.f);
   float sf=(scale+1.f)/16.f,t=sin8f(.40f*phase_color),t2=sin8f(.37f*phase_color),t3=sin8f(.32f*phase_color);
   for(int x=0;x<W;x++)for(int y=0;y<H;y++){
     float xf=x*8.f,yf=y*8.f;
     float a=sin8f(xf+t/2+sin8f(yf+t2))/2,b=sin8f(yf+t+sin8f(t3/4+xf));
     float c=sin8f(yf+t2+sin8f(t+x+b/4));pixel(x,y,pal((unsigned short)((int)((a+b+c)*sf))));
   }break;
 }
 case 7:{ // PARTICLES
   int cnt=1+scale*99/255;int fade=1+speed/8;
   solid(0);for(int k=0;k<cnt;k++){
     Particle& p=particles[k];if(p.brightness==0&&fl_random8(fastled_seed)<32){p.x=fl_random8(fastled_seed)%W;p.y=fl_random8(fastled_seed)%H;p.color=fastled_pal8(fl_random8(fastled_seed));p.brightness=192+fl_random8(fastled_seed)/4;}
     unsigned int c=p.color;int b=p.brightness;unsigned int scaled=(unsigned(fl_scale8(c>>16,b))<<16)|(unsigned(fl_scale8(c>>8,b))<<8)|fl_scale8(c,b);
     rgb_lerp_pixel(p.x,p.y,scaled,192);p.brightness=(b*(255-fade))>>8;
   }break;
 }
 case 8:{ // COLOR CHANGE
   phase_color=phase_wrap(phase_color+(double)dms*speed/10/255,16777216.f);
   unsigned short v=(unsigned short)fl_round((float)phase_color);solid(pal((unsigned short)(v*16)));break;
 }
 case 9:{ // SOLID HSL
   solid(hsl_to_rgb(speed,scale,bright_fx==0?light:127));break;
 }
 }
 // BrightnessEffects are applied AFTER ColorEffects, like src/main.cpp::render().
 switch(bright_fx){
 case 1:{phase_bright+=(float)dms*light/2.f/255.f;uint8_t intensity=ease(pulse_phase(phase_bright,0));for(int y=0;y<H;y++)for(int x=0;x<W;x++)scale_pixel(x,y,intensity);break;}
 case 2:{phase_bright+=(float)dms*(light-128)/2.f/255.f;for(int x=0;x<W;x++){uint8_t factor=255-wave8(phase_bright+x*6.f);for(int y=0;y<H;y++)scale_pixel(x,y,factor);}break;}
 case 3:{phase_bright+=(float)dms*(light-128)/255.f;int half=(W+1)/2;for(int x=0;x<half;x++){float phase=phase_bright+x*32.f;int value=((fl_round(phase)%512)+512)%512;uint8_t factor=(value<256?wave8((float)value):0);for(int y=0;y<H;y++){scale_pixel(x,y,factor);if(W-1-x>=half)scale_pixel(W-1-x,y,factor);}}break;}
 case 4:{phase_bright+=(float)dms*32/2.f/255.f;int b1=ease(pulse_phase(phase_bright,0)),b2=ease(pulse_phase(phase_bright,512));int period=maxi(1,W*H*maxi(1,light)/255);int k=0;for(int x=0;x<W;x++)for(int y=0;y<H;y++){int group=(k++/period)%2;scale_pixel(x,y,uint8_t(255-(group?b1:b2)));}break;}
 }
 // Source AudioEffectManager::signal, signal_centered, brightness, line, line_centered.
 // Audio mix is an OPTIONAL lab-only intervention: 100% reproduces the source mapping.
 if(audio_fx==1||audio_fx==2||audio_fx==3||audio_fx==4){
    const bool centered=audio_fx==2||audio_fx==4;
    // Origin per firmware RemoteReactive::render: mapped column, dark outside
    // a shifted non-ring strip; a radial centre is evaluated per pixel.
    const bool per_pixel=centered&&origin_is_radial();
    const uint8_t dark=uint8_t(255-(int)(255*audio_mix));
    for(int x=0;x<W;x++){
       const int xp=origin_x(x);
       if(xp<0){for(int y=0;y<H;y++)scale_pixel(x,y,dark);continue;}
       for(int y=0;y<(per_pixel?H:1);y++){
       int idx=centered?origin_centered_index(xp,y):xp;
       int value=scaled_audio(provider_at(idx),255);
       // Original curve is dim8_raw(value) / 255 (roughly squared).
       // New FFT panel can blend toward a perceptually brighter response;
       // old DFT panel sets the expression parameters to zero.
       float norm=value/255.f;
       float brightened=.25f*norm+.75f*__builtin_sqrtf(norm);
       float shaped=(1.f-spectrum_expression)*dim8_raw(uint8_t(value))/255.f
                    +spectrum_expression*brightened;
       if(spectrum_onset>0){
         int group=idx*16/maxi(1,W)<5?0:(idx*16/maxi(1,W)<12?1:2);
         shaped+=spectrum_onset*0.22f*features[16+group];
       }
       uint8_t factor=u8((int)(clampf(shaped,0.f,1.f)*255.f));
       uint8_t mixed=uint8_t(255+(int(factor)-255)*audio_mix);
       if(per_pixel)scale_pixel(x,y,mixed);
       else for(int yy=0;yy<H;yy++)scale_pixel(x,yy,mixed);
       }
    }
 }
 if(audio_fx==5){
    int value=scaled_audio(features[23],255);
    uint8_t factor=dim8_raw(uint8_t(value));
    uint8_t mixed=uint8_t(255+(int(factor)-255)*audio_mix);
    for(int y=0;y<H;y++)for(int x=0;x<W;x++)scale_pixel(x,y,mixed);
 }
 if(audio_fx==6||audio_fx==7){
    int count=(audio_fx==6)?W:W/2;
    // The new audio panel can use a faster, more dynamic line envelope.
    // Zero expression restores the original parametric VolumeAnalyzer behavior.
    float line_source=(1.f-line_expression)*features[23]+line_expression*features[159];
    int width=scaled_audio(line_source,count);
    const uint8_t dark=uint8_t(255-(int)(255*audio_mix));
    for(int x=0;x<W;x++){
      const int xp=origin_x(x);
      for(int y=0;y<H;y++){
        bool lit=xp>=0&&(audio_fx==6?xp<width:origin_line_centered_lit(xp,y,width));
        if(!lit)scale_pixel(x,y,dark);
      }
    }
 }
 // Two new experimental modes, intentionally not part of the firmware list.
 if(audio_fx==11){float p0=features[16],p1=features[17],p2=features[18];for(int y=0;y<H;y++)for(int x=0;x<W;x++){
   const int xp=origin_x(x);if(xp<0){multiply_pixel(x,y,1-audio_mix);continue;}
   float b=features[mini(15,xp*16/W)];float low=features[156],mid=features[157],high=features[158];
   // Single-row strips have no upper/lower half: blend both (firmware Half::BOTH).
   float main=H<2?(low+mid)*.5f:(y<H/2?low:mid),transient=H<2?maxf(p0,p1):(y<H/2?p0:p1);
   float boost=main*.40f+high*.18f+transient*.18f+p2*.12f;
   float amt=(1-audio_mix)+audio_mix*clampf(.20f+b*.75f+boost,0.f,1.f);multiply_pixel(x,y,amt);
 }}
 if(audio_fx==12){float pulse0=maxf(features[16],features[153]*features[155]);for(int y=0;y<H;y++)for(int x=0;x<W;x++){
   const int xp=origin_x(x);if(xp<0){multiply_pixel(x,y,1-audio_mix);continue;}
   float radius=origin_beat_radius(xp,y);float ripple=pulse0*(1.f-abf(radius-(1.f-pulse0)));
   float bright=clampf(.30f+features[mini(15,xp*16/W)]*.6f+ripple*.6f,0,1);
   multiply_pixel(x,y,1-audio_mix+audio_mix*bright);
 }}
 speed=preset_speed;scale=preset_scale;light=preset_light;
 }
}
// Freestanding libc shims for clang wasm32-unknown-unknown -nostdlib.
extern "C" __attribute__((optnone)) void* memset(void* dst,int value,unsigned long len){volatile unsigned char* d=(volatile unsigned char*)dst;for(unsigned long i=0;i<len;i++)d[i]=(unsigned char)value;return dst;}
extern "C" __attribute__((optnone)) void* memcpy(void* dst,const void* src,unsigned long len){volatile unsigned char* d=(volatile unsigned char*)dst;volatile const unsigned char* s=(volatile const unsigned char*)src;for(unsigned long i=0;i<len;i++)d[i]=s[i];return dst;}
