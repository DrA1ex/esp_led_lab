#pragma once
// Targeted arithmetic port of FastLED 3.6.0 (FASTLED_SCALE8_FIXED=1,
// FASTLED_BLEND_FIXED=1, FASTLED_NOISE_FIXED=1), specifically the primitives
// used by esp_led_lamp. This is NOT the full library or LED output driver.
#include <stdint.h>

static inline uint8_t fl_scale8(uint8_t a,uint8_t s){return (uint16_t(a)*(uint16_t(s)+1))>>8;}
static inline uint16_t fl_scale16(uint16_t a,uint16_t s){return (uint32_t(a)*(uint32_t(s)+1))>>16;}
static inline uint8_t fl_blend8(uint8_t a,uint8_t b,uint8_t t){
  return uint16_t(uint16_t((uint16_t(a)<<8)|b) + uint16_t(b*t) - uint16_t(a*t)) >> 8;
}
static inline int16_t fl_avg15(int16_t a,int16_t b){return (a>>1)+(b>>1)+(a&1);}
static inline int16_t fl_lerp15by16(int16_t a,int16_t b,uint16_t t){
  return b>a ? int16_t(a+fl_scale16(uint16_t(b-a),t)) : int16_t(a-fl_scale16(uint16_t(a-b),t));
}
static inline uint8_t fl_ease8quad(uint8_t i){uint8_t j=(i&128)?255-i:i;uint8_t j2=uint8_t(fl_scale8(j,j)<<1);return (i&128)?255-j2:j2;}
static inline uint16_t fl_ease16quad(uint16_t i){uint16_t j=(i&32768)?65535-i:i;uint16_t j2=fl_scale16(j,j)<<1;return (i&32768)?65535-j2:j2;}
static inline uint8_t fl_ease8cubic(uint8_t i){uint8_t ii=fl_scale8(i,i),iii=fl_scale8(ii,i);uint16_t t=3u*ii-2u*iii;return t&256?255:uint8_t(t);}
static inline uint8_t fl_cubicwave8(uint8_t x){if(x&128)x=255-x;return fl_ease8cubic(uint8_t(x<<1));}
static inline int16_t fl_sin16(uint16_t t){
  static const uint16_t b[]={0,6393,12539,18204,23170,27245,30273,32137};
  static const uint8_t slopes[]={49,48,44,38,31,23,14,4};
  uint16_t offset=(t&16383)>>3;if(t&16384)offset=2047-offset;
  uint8_t sec=offset/256;uint16_t y=b[sec]+slopes[sec]*(uint8_t(offset)/2);
  return (t&32768)?-int16_t(y):int16_t(y);
}
// FastLED sin8_C, for use in diagnostic cross checks.
static inline uint8_t fl_sin8(uint8_t t){
  static const uint8_t bm[]={0,49,49,41,90,27,117,10};
  uint8_t off=(t&64)?uint8_t(255-t):t;off&=63;
  uint8_t so=off&15;if(t&64)++so;uint8_t sec=off>>4;
  int8_t y=int8_t(bm[2*sec]+((bm[2*sec+1]*so)>>4));if(t&128)y=-y;
  return uint8_t(y+128);
}
static inline uint16_t fl_randnext(uint16_t& seed){seed=uint16_t(uint32_t(seed)*2053u+13849u);return seed;}
static inline uint8_t fl_random8(uint16_t& seed){uint16_t v=fl_randnext(seed);return uint8_t(uint8_t(v)+uint8_t(v>>8));}
static const uint8_t fl_perm[257]={
151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,
140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,
247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,
57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,
74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,
60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,
65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,
200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,
52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,
207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,
119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,
129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,
218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,
81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,
184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,
222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,
151};
static inline uint8_t fl_P(int n){return fl_perm[uint8_t(n)];}
static inline int16_t fl_grad3(uint8_t hash,int16_t x,int16_t y,int16_t z){
 hash&=15;int16_t u=hash<8?x:y;int16_t v=hash<4?y:(hash==12||hash==14)?x:z;
 if(hash&1)u=-u;if(hash&2)v=-v;return fl_avg15(u,v);
}
static inline int16_t fl_grad2(uint8_t hash,int16_t x,int16_t y){
 hash&=7;int16_t u=hash<4?x:y,v=hash<4?y:x;
 if(hash&1)u=-u;if(hash&2)v=-v;return fl_avg15(u,v);
}
static inline int16_t fl_noise3raw(uint32_t x,uint32_t y,uint32_t z){
 uint8_t X=x>>16,Y=y>>16,Z=z>>16;
 uint8_t A=fl_P(X)+Y,AA=fl_P(A)+Z,AB=fl_P(uint8_t(A+1))+Z;
 uint8_t B=fl_P(uint8_t(X+1))+Y,BA=fl_P(B)+Z,BB=fl_P(uint8_t(B+1))+Z;
 uint16_t u=x,v=y,w=z;
 int16_t xx=(u>>1)&32767,yy=(v>>1)&32767,zz=(w>>1)&32767;
 u=fl_ease16quad(u);v=fl_ease16quad(v);w=fl_ease16quad(w);
 int16_t x1=fl_lerp15by16(fl_grad3(fl_P(AA),xx,yy,zz),fl_grad3(fl_P(BA),int16_t(xx-32768),yy,zz),u);
 int16_t x2=fl_lerp15by16(fl_grad3(fl_P(AB),xx,int16_t(yy-32768),zz),fl_grad3(fl_P(BB),int16_t(xx-32768),int16_t(yy-32768),zz),u);
 int16_t x3=fl_lerp15by16(fl_grad3(fl_P(uint8_t(AA+1)),xx,yy,int16_t(zz-32768)),fl_grad3(fl_P(uint8_t(BA+1)),int16_t(xx-32768),yy,int16_t(zz-32768)),u);
 int16_t x4=fl_lerp15by16(fl_grad3(fl_P(uint8_t(AB+1)),xx,int16_t(yy-32768),int16_t(zz-32768)),fl_grad3(fl_P(uint8_t(BB+1)),int16_t(xx-32768),int16_t(yy-32768),int16_t(zz-32768)),u);
 return fl_lerp15by16(fl_lerp15by16(x1,x2,v),fl_lerp15by16(x3,x4,v),w);
}
static inline int16_t fl_noise2raw(uint32_t x,uint32_t y){
 uint8_t X=x>>16,Y=y>>16,A=fl_P(X)+Y,B=fl_P(uint8_t(X+1))+Y;
 uint8_t AA=fl_P(A),AB=fl_P(uint8_t(A+1)),BA=fl_P(B),BB=fl_P(uint8_t(B+1));
 uint16_t u=x,v=y;int16_t xx=(u>>1)&32767,yy=(v>>1)&32767;
 u=fl_ease16quad(u);v=fl_ease16quad(v);
 int16_t x1=fl_lerp15by16(fl_grad2(fl_P(AA),xx,yy),fl_grad2(fl_P(BA),int16_t(xx-32768),yy),u);
 int16_t x2=fl_lerp15by16(fl_grad2(fl_P(AB),xx,int16_t(yy-32768)),fl_grad2(fl_P(BB),int16_t(xx-32768),int16_t(yy-32768)),u);
 return fl_lerp15by16(x1,x2,v);
}
static inline uint16_t fl_inoise16(uint32_t x,uint32_t y,uint32_t z){return uint16_t((uint32_t(int32_t(fl_noise3raw(x,y,z))+19052)*440)>>8);}
static inline uint16_t fl_inoise16(uint32_t x,uint32_t y){return uint16_t((uint32_t(int32_t(fl_noise2raw(x,y))+17308)*484)>>8);}
