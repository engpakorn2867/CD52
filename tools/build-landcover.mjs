// สร้าง data/landcover.js จาก ESA WorldCover 10 m v200 (อ่านเฉพาะช่วงที่ต้องการจาก COG บน S3)
// ใช้งาน: npm install && node tools/build-landcover.mjs
import { fromUrl } from 'geotiff';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {PNG}=require('pngjs'); const fs=require('fs');
const M=require('../js/flood.js'); const CFG=require('../js/config.js');
const url='https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N12E099_Map.tif';
const img=await (await fromUrl(url)).getImage();
const res=1/12000, b=CFG.bbox, z=13;
const x0=Math.floor(M.lonToX(b.west,z)),x1=Math.ceil(M.lonToX(b.east,z)),y0=Math.floor(M.latToY(b.north,z)),y1=Math.ceil(M.latToY(b.south,z));
const w=x1-x0,h=y1-y0;
const lonW=M.xToLon(x0,z),lonE=M.xToLon(x1,z),latN=M.yToLat(y0,z),latS=M.yToLat(y1,z);
const c0=Math.floor((lonW-99)/res)-2,c1=Math.ceil((lonE-99)/res)+2,r0=Math.floor((15-latN)/res)-2,r1=Math.ceil((15-latS)/res)+2;
const ras=(await img.readRasters({window:[c0,r0,c1,r1]}))[0];const RW=c1-c0;
console.log('grid',w,h,'window',RW,r1-r0);
const out=new PNG({width:w,height:h,colorType:0,inputColorType:0,bitDepth:8});
const cnt=new Uint32Array(12);
for(let y=0;y<h;y++){const la0=M.yToLat(y0+y,z),la1=M.yToLat(y0+y+1,z);const ra=Math.floor((15-la0)/res)-r0,rb=Math.ceil((15-la1)/res)-r0;
 for(let x=0;x<w;x++){const lo0=M.xToLon(x0+x,z),lo1=M.xToLon(x0+x+1,z);const ca=Math.floor((lo0-99)/res)-c0,cb=Math.ceil((lo1-99)/res)-c0;
  cnt.fill(0);for(let r=ra;r<rb;r++)for(let c=ca;c<cb;c++){const v=ras[r*RW+c];cnt[v===95?11:Math.min(10,v/10|0)]++;}
  // มีพื้นที่อาคาร >= 30% ให้เป็นเขตเมือง (อาคารกระจายตัว)
  let tot=0,best=0;for(let i=0;i<12;i++){tot+=cnt[i];if(cnt[i]>cnt[best])best=i;}
  if(cnt[5]>=0.3*tot)best=5;
  const i=y*w+x;out.data[i]=best; }}
// pngjs grayscale colorType 0 expects data in RGBA unless inputColorType; write via custom
const rgba=new PNG({width:w,height:h});for(let i=0;i<w*h;i++){const v=out.data[i]*20;rgba.data[i*4]=v;rgba.data[i*4+1]=v;rgba.data[i*4+2]=v;rgba.data[i*4+3]=255;}
const buf=PNG.sync.write(rgba,{colorType:0});
console.log('png bytes',buf.length);

fs.writeFileSync(new URL('../data/landcover.js', import.meta.url),
`// การใช้ประโยชน์ที่ดิน ESA WorldCover 10 m v200 (2021, CC BY 4.0) ย่อเป็นตาราง Web Mercator ซูม ${z} ของขอบเขตคำนวณ
// ค่าในภาพ (ช่องสีเทา) / 20 = รหัสชั้น: 1 ป่า/ไม้ยืนต้น/สวน, 2 ไม้พุ่ม, 3 ทุ่งหญ้า, 4 เกษตรกรรม, 5 สิ่งปลูกสร้าง,
// 6 พื้นที่โล่ง, 7 หิมะ, 8 แหล่งน้ำ, 9 พื้นที่ชุ่มน้ำ, 10 ป่าชายเลน/มอส, 11 ป่าชายเลน, 0 ไม่มีข้อมูล
// เซลล์ที่มีอาคาร ≥ 30% ถูกจัดเป็นสิ่งปลูกสร้าง — สร้างด้วย tools/build-landcover.mjs
window.LANDCOVER = { z: ${z}, x0: ${x0}, y0: ${y0}, w: ${w}, h: ${h}, scale: 20,
  png: 'data:image/png;base64,${buf.toString('base64')}' };
`);
const hist={};for(let i=0;i<w*h;i++)hist[out.data[i]]=(hist[out.data[i]]||0)+1;console.log(hist);
