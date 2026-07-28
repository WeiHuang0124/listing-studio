/* ═══════════════════════════════════════════════════════
   圖文生成室 AI — Cloudflare Worker 後端 v2.0.0
   職責：提示詞保管、授權驗證、Gemini 代理、工作階段管理
   綁定需求：KV Namespace 綁定變數名稱 = DB
   ═══════════════════════════════════════════════════════ */

const ALLOW_ORIGIN = '*'; // 上線後改成你的前端網址，例如 'https://listing-studio-psi.vercel.app'
const SITE_URL = 'https://listing-studio-psi.vercel.app'; // 前端網站網址（付款完成頁的「前往使用工具」按鈕會連到這裡）

/* ---------- 提示詞金庫（你的核心資產，只存在這裡） ---------- */
const REF_RULE='重要規則：參考圖照片上的行銷文字、標語、logo、浮水印、價格貼圖等，均為原照片的後製元素，「不屬於商品本身」，必須完全忽略且絕不可出現在生成圖中。生成圖上的所有文字，只能使用本提示詞明確指定的繁體中文文案；未指定文字時不加任何文字。唯一例外：商品實體包裝上印刷的文字屬於商品本身，須保持原樣不得改動。';
const FRAME='10張圖固定任務：1痛點鉤子(大字提問+情境) 2產品登場(主視覺+品名+定位句) 3~5三大賣點(每張一賣點,大標+短說明+視覺隱喻) 6競品對比(雙欄表格,我方vs一般) 7使用方法(3步驟) 8適合客群(四類人) 9品質承諾(勾選清單+證書感邊框) 10規格表+促購行動呼籲';

/* 極簡攝影系（進階授權限定）：黑白棚拍、右下大字標、示意圖攝影 */
const PRO_CODE='senmao-pro';
const BOSS_CODE='senmao-boss';
const MINIMAL_STYLE={id:'M',name:'極簡攝影系 PRO',desc:'黑白棚拍交替、大字標題、示意圖商業攝影'};
const MINIMAL_FRAME=`10張圖固定任務（極簡攝影版）：1痛點鉤子(生活情境示意照+痛點) 2產品登場(商品包裝本體乾淨棚拍) 3~5三大賣點(每張一賣點) 6對比(左右並列兩份實物示意對比) 7使用情境(使用動作特寫) 8客群情境(寵物或人的生活示意照) 9原料溯源(天然原料實物棚拍) 10商品包裝全家福+行動呼籲。
畫面主體原則（極簡版核心）：只有第2張與第10張出現商品「包裝本體」（以參考圖為準、包裝外觀完全一致）；其餘各張一律「不放包裝」，改用最能隱喻該賣點的實物示意攝影——例如：內容物盛裝於素色器皿、原料實物（如玉米、豌豆等，依商品實際成分）、使用後的狀態實拍（如結團、吸收後）、傾倒中的動態特寫、寵物或使用者與內容物互動。參考圖用於理解商品內容物的材質、形狀與顏色，示意物必須與其一致。
極簡版式鐵律（每張提示詞都必須完整描述）：正方形1:1專業商業攝影；背景為「純白攝影棚」或「純黑攝影棚」二選一，整套10張黑白交替、各約一半；主體置於畫面中上部，構圖大量留白；右下角放置兩行超大粗黑體繁體中文標題（每行≤5字，白底用黑字、黑底用白字，字級極大、視覺重量最重）；左下角放置三行小字內文（每行≤14字，同標題同色）；除指定文字外，畫面不得出現任何icon、邊框、色塊、表格、標籤、裝飾元素；質感關鍵詞：柔和均勻棚燈、淺景深、極簡、高級感。`;

const T={
  analyze:()=>`你是台灣蝦皮電商資深圖文企劃。分析商品資料與照片，只回傳 JSON：
{"name":"商品名(10字內)","summary":"一句話定位(24字內)","points":["賣點"](4-6個,各10字內),"audience":"客群(16字內)","styles":[{"id":"A","name":"風格名(6字內)","desc":"視覺描述(20字內,含色調/材質/氛圍)"},{"id":"B"},{"id":"C"}]}
styles 要依商品屬性客製三種攝影/設計風格方向。`,
  prompts:(s,range)=>{
    const isMin=s.style?.id==='M'||/極簡/.test(s.style?.name||'');
    return `你是 Nano Banana 提示詞專家，為蝦皮商品描述圖寫「圖像生成提示詞」。
商品：${JSON.stringify({name:s.summary.name,summary:s.summary.summary,points:s.summary.points,audience:s.summary.audience})}。視覺風格：${s.style.name}（${s.style.desc}）。${s.model?`畫面主角（模特）：${s.model}——請在鉤子圖、客群情境圖、使用方法圖等適合的圖中，讓此主角與商品自然互動；主角的外型特徵需在整套圖中保持一致；產品登場圖與規格圖可不放主角。`:''}${isMin?MINIMAL_FRAME:FRAME}
提示詞規則：繁體中文撰寫；明確描述版面配置(構圖位置)、背景與氛圍、以及圖上要渲染的「確切文字內容」(用引號標出${isMin?',大標每行≤5字、小字每行≤14字':',主標≤12字副標≤18字'},字要大而清晰易讀)；${isMin?'主體規則：僅第2張與第10張以參考圖中的商品「包裝本體」為主體（包裝外觀、顏色、文字須與參考圖完全一致）；其餘每一張的提示詞都必須明確寫入「畫面中不得出現商品包裝袋」，主體改為賣點示意攝影（內容物、原料、使用狀態、效果實拍）；並且每張提示詞都要依參考照片、以文字精確描述內容物顆粒的外觀（形狀、粗細、顏色、質地），因為除第2與第10張外，圖像生成階段不會附上參考照片，顆粒描寫是唯一的一致性依據':'每張都註明「以參考圖中的商品為主體，完全保持商品實體的外觀、顏色、材質細節一致，不得改變商品設計」'}；正方形1:1電商商品圖，整套10張需色調與設計語言一致。
只回傳 JSON：{"prompts":[{"no":編號,"goal":"這張圖的任務說明(16字內)","h":"圖上主標(${isMin?'兩行各5字內,以\\\\n分行':'12字內'})","s":"圖上副標(${isMin?'三行小字概要,18字內':'18字內'})","p":"完整提示詞(${isMin?'180':'150'}字內)"}]}，本次撰寫第${range}張。`;
  },
  edit:(s)=>`你是圖文企劃助理。目前10張圖的企劃（含文案與提示詞）：${JSON.stringify(s.prompts)}。商品：${JSON.stringify(s.summary)}。
使用者要求調整。若是修改某張圖，依要求改寫該張（保留原版面任務與「保持商品一致」規則），只回傳 JSON：{"action":"update","no":編號,"goal":"任務說明(16字內)","h":"圖上主標(12字內)","s":"圖上副標(18字內)","p":"新的完整提示詞"}
若只是問題，回傳：{"action":"chat","reply":"回覆(繁中80字內)"}`,
  revise:(old,title,req)=>`你是 Nano Banana 提示詞專家。這是蝦皮商品描述圖（${title}）的現有提示詞：
${old}
使用者對此圖的修改需求：「${req}」
請針對需求精準改寫提示詞：只調整與需求相關的部分，其餘版面任務、文字內容、風格、以及「以參考圖商品為主體、保持商品完全一致」的規則全部保留。只回傳 JSON：{"p":"改寫後的完整提示詞"}`,
  subject:()=>`你是電商攝影棚的修圖師。判斷參考照片中「要販售的商品主體」是什麼——注意：寵物、人物、家具、地板、背景等通常是干擾物而非商品（例如貓坐在不鏽鋼盆裡，商品主體是不鏽鋼盆）。只回傳 JSON：
{"subject":"商品主體名稱(10字內)","distractors":["照片中需移除的干擾物"(0-5項)],"note":"判斷依據一句話(20字內)"}`,
  main:(o,s)=>`任務：電商主圖。商品主體：「${o.subject}」。從參考圖中精準辨識並擷取此商品主體，徹底移除畫面中的所有干擾物（${(o.distractors||[]).join('、')}${o.distractors?.length?'、':''}寵物、人物、雜物）、原始背景、以及原照片上的一切後製文字與標語。將商品置於${o.bg==='white'?'純白色(#FFFFFF)、無雜訊無漸層的':'淺灰色攝影棚柔和漸層'}背景正中央，商品佔畫面約80%，完全保持商品實體的外觀、材質、顏色與細節一致，不得改變商品設計。專業商品攝影質感：光線均勻明亮、邊緣乾淨銳利。${o.shadow?'商品底部加上自然柔和的接觸陰影。':''}${o.reflect?'商品下方加上淡淡的鏡面倒影。':''}${o.title?`畫面上方加入大而清晰易讀的繁體中文主標文字${s?.summary?`「${s.summary.points?.[0]||s.summary.name}」`:'（依商品特性撰寫8字內賣點）'}，醒目簡潔、單一強調色。`:''}${!o.shadow&&!o.reflect?'不加陰影與倒影。':''}${!o.title?'不加任何文字與標籤。':''}正方形1:1。`
};

/* ---------- Gemini 呼叫（含過載自動重試與備援鏈） ---------- */
const TEXT_MODELS=['gemini-2.5-flash','gemini-2.5-flash-lite','gemini-2.0-flash'];
const IMG_WHITELIST=['gemini-3.1-flash-image','gemini-3.1-flash-lite-image','gemini-3-pro-image','gemini-2.5-flash-image'];
const overloaded=m=>/high demand|overloaded|try again|503|429|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(m||'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function gem(model,key,body){
  const waits=[2000,5000,10000];
  for(let i=0;i<=waits.length;i++){
    const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{
      method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify(body)});
    const data=await res.json();
    if(!data.error)return data;
    if(overloaded(data.error.message)&&i<waits.length){await sleep(waits[i]);continue;}
    throw new Error(data.error.message);
  }
}
async function gemText(key,sys,userText,photos){
  const parts=(photos||[]).map(p=>({inline_data:{mime_type:p.mime,data:p.b64}}));
  parts.push({text:userText});
  const body={system_instruction:{parts:[{text:sys}]},contents:[{role:'user',parts}],
    generationConfig:{responseMimeType:'application/json',temperature:0.8}};
  let last;
  for(const m of TEXT_MODELS){
    try{
      const d=await gem(m,key,body);
      const t=(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');
      const c=t.replace(/```json|```/g,'').trim();
      return JSON.parse(c.slice(c.indexOf('{'),c.lastIndexOf('}')+1));
    }catch(e){last=e;if(!overloaded(e.message))throw e;}
  }
  throw last;
}
async function gemImage(key,model,prompt,photos){
  if(!IMG_WHITELIST.includes(model))model=IMG_WHITELIST[0];
  const parts=(photos||[]).map(p=>({inline_data:{mime_type:p.mime,data:p.b64}}));
  parts.push({text:prompt+((photos&&photos.length)?'\n\n'+REF_RULE:'')});
  const d=await gem(model,key,{contents:[{role:'user',parts}],
    generationConfig:{responseModalities:['IMAGE'],imageConfig:{aspectRatio:'1:1'}}});
  const img=(d.candidates?.[0]?.content?.parts||[]).find(p=>p.inline_data||p.inlineData);
  if(!img)throw new Error('模型未回傳圖片，請重試');
  const x=img.inline_data||img.inlineData;
  return `data:${x.mime_type||x.mimeType||'image/png'};base64,${x.data}`;
}

/* ---------- 工作階段（KV，24 小時） ---------- */
const S_TTL=86400;
const sget=async(env,sid)=>{const v=await env.DB.get('s:'+sid);if(!v)throw new Error('工作階段過期，請重新整理頁面');return JSON.parse(v);};
const sput=(env,sid,s)=>env.DB.put('s:'+sid,JSON.stringify(s),{expirationTtl:S_TTL});

/* ═══════════ 綠界 ECPay 金流層 ═══════════
   密鑰請於 Cloudflare Worker → Settings → Variables and Secrets 設定，切勿寫死：
     ECPAY_MERCHANT_ID / ECPAY_HASH_KEY / ECPAY_HASH_IV / ECPAY_ENV('test'|'production') / ADMIN_PASS
   未設定時自動使用綠界官方測試環境，可完整跑通付款不扣真錢。 */
const ECPAY_TEST={MerchantID:'2000132',HashKey:'5294y06JbISpM5x9',HashIV:'v77hoKGq4kWxNNIS'};
const PLANS={
  basic:{name:'圖文生成室 AI 一般版',amount:1490,pro:false},
  basic_early:{name:'圖文生成室 AI 一般版(早鳥)',amount:990,pro:false},
  pro:{name:'圖文生成室 AI PRO版',amount:2490,pro:true},
  pro_early:{name:'圖文生成室 AI PRO版(早鳥)',amount:1780,pro:true}
};
function ecpayCfg(env){
  const prod=env.ECPAY_ENV==='production';
  return {MerchantID:env.ECPAY_MERCHANT_ID||ECPAY_TEST.MerchantID,
    HashKey:env.ECPAY_HASH_KEY||ECPAY_TEST.HashKey,
    HashIV:env.ECPAY_HASH_IV||ECPAY_TEST.HashIV,prod,
    aioUrl:prod?'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5':'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5'};
}
function ecEncode(s){
  return encodeURIComponent(s).replace(/%20/g,'+').replace(/%21/g,'!').replace(/%2a/gi,'*')
    .replace(/%28/g,'(').replace(/%29/g,')').replace(/%2d/gi,'-').replace(/%2e/gi,'.').replace(/%5f/gi,'_');
}
async function sha256Upper(str){
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
}
async function checkMac(params,cfg){
  const keys=Object.keys(params).filter(k=>k!=='CheckMacValue').sort((a,b)=>a.toLowerCase()<b.toLowerCase()?-1:1);
  let raw='HashKey='+cfg.HashKey;
  for(const k of keys)raw+='&'+k+'='+params[k];
  raw+='&HashIV='+cfg.HashIV;
  return await sha256Upper(ecEncode(raw).toLowerCase());
}
function genLic(){
  const r=n=>Array.from({length:n},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('');
  return 'SM-'+r(4)+'-'+r(4);
}
const htmlResp=(s,code=200)=>new Response(s,{status:code,headers:{'Content-Type':'text/html; charset=utf-8'}});

/* ---------- 主路由 ---------- */
export default{
  async fetch(req,env){
    const cors={'Access-Control-Allow-Origin':ALLOW_ORIGIN,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
    if(req.method==='OPTIONS')return new Response(null,{headers:cors});
    const out=(o,code=200)=>new Response(JSON.stringify(o),{status:code,headers:{...cors,'Content-Type':'application/json'}});
    const url=new URL(req.url);
    const path=url.pathname;

    /* 金流路由：/pay 與 /ecpay-return 走 GET，綠界回呼 /ecpay-notify 走 POST(表單)，
       這些一律在「POST-only 攔截」之前處理 */
    const PAY_ROUTES=['/pay','/ecpay-notify','/ecpay-return','/admin-api'];
    if(!PAY_ROUTES.includes(path)&&req.method!=='POST')
      return new Response('圖文生成室 API v2.7.1',{headers:cors});


    /* ═══════════ 金流與後台路由（表單編碼，需在 JSON 解析前處理） ═══════════ */
    try{
      const cfg=ecpayCfg(env);

      /* 建立訂單 → 回傳自動送出的綠界付款表單 */
      if(path==='/pay'){
        const plan=PLANS[url.searchParams.get('plan')]||PLANS.basic;
        const email=(url.searchParams.get('email')||'').slice(0,80);
        const now=new Date();
        const tw=new Date(now.getTime()+8*3600*1000);
        const stamp=tw.toISOString().slice(0,19).replace(/[-:T]/g,'');
        const orderId='LS'+stamp+Math.floor(Math.random()*900+100);
        await env.DB.put('order:'+orderId,JSON.stringify({
          plan:url.searchParams.get('plan')||'basic',amount:plan.amount,pro:plan.pro,
          name:plan.name,email,status:'pending',created:Date.now()
        }),{expirationTtl:2592000});
        const base='https://'+url.host;
        const p={
          MerchantID:cfg.MerchantID,
          MerchantTradeNo:orderId,
          MerchantTradeDate:`${tw.getFullYear()}/${String(tw.getMonth()+1).padStart(2,'0')}/${String(tw.getDate()).padStart(2,'0')} ${String(tw.getHours()).padStart(2,'0')}:${String(tw.getMinutes()).padStart(2,'0')}:${String(tw.getSeconds()).padStart(2,'0')}`,
          PaymentType:'aio',
          TotalAmount:String(plan.amount),
          TradeDesc:'listing studio ai license',
          ItemName:plan.name,
          ReturnURL:base+'/ecpay-notify',
          OrderResultURL:base+'/ecpay-return',
          ChoosePayment:'ALL',
          EncryptType:'1'
        };
        p.CheckMacValue=await checkMac(p,cfg);
        const inputs=Object.entries(p).map(([k,v])=>`<input type="hidden" name="${k}" value="${String(v).replace(/"/g,'&quot;')}">`).join('');
        return htmlResp(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>前往付款…</title></head><body style="font-family:sans-serif;text-align:center;padding-top:60px">
<p>正在前往綠界安全付款頁，請稍候…</p>
<form id="f" method="post" action="${cfg.aioUrl}">${inputs}</form>
<script>document.getElementById('f').submit();</script></body></html>`);
      }

      /* 綠界伺服器端回呼（付款結果的唯一可信來源）→ 驗章 → 發授權碼 */
      if(path==='/ecpay-notify'){
        const form=await req.formData();
        const data={};for(const [k,v] of form.entries())data[k]=v;
        const mac=await checkMac(data,cfg);
        if(mac!==data.CheckMacValue)return new Response('0|CheckMacError');
        const orderId=data.MerchantTradeNo;
        const rec=JSON.parse(await env.DB.get('order:'+orderId)||'null');
        if(!rec)return new Response('1|OK'); // 找不到訂單也回OK避免綠界重送
        if(data.RtnCode==='1'){
          if(rec.status!=='paid'){
            const lic=genLic();
            await env.DB.put('lic:'+lic,JSON.stringify({name:rec.email||orderId,pro:rec.pro,order:orderId}));
            rec.status='paid';rec.lic=lic;rec.paidAt=Date.now();rec.tradeNo=data.TradeNo||'';
            rec.payType=data.PaymentType||'';
            await env.DB.put('order:'+orderId,JSON.stringify(rec),{expirationTtl:31536000});
          }
        }else{rec.status='failed';rec.rtnMsg=data.RtnMsg||'';await env.DB.put('order:'+orderId,JSON.stringify(rec),{expirationTtl:2592000});}
        return new Response('1|OK');
      }

      /* 顧客付款後瀏覽器導回頁（僅顯示，不作為發碼依據） */
      if(path==='/ecpay-return'){
        let orderId='';
        try{const form=await req.formData();orderId=form.get('MerchantTradeNo')||'';}catch(e){}
        const rec=orderId?JSON.parse(await env.DB.get('order:'+orderId)||'null'):null;
        const paid=rec&&rec.status==='paid';
        const licLine=paid?`<div style="font-size:15px;color:#5A5F68;margin-top:10px">你的授權碼</div><div id="lic" style="font-size:26px;font-weight:900;letter-spacing:1px;margin:8px 0;color:#E8552F">${rec.lic}</div><button onclick="navigator.clipboard.writeText('${rec.lic}');this.textContent='已複製 ✓'" style="background:#F0EEE8;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;color:#16181D">📋 複製授權碼</button><div style="font-size:13px;color:#5A5F68;margin-top:12px">請截圖保存，到工具輸入此碼即可無限使用</div>`:'<div style="color:#5A5F68">若你已完成付款，授權碼將於數秒內開通，可稍後至工具輸入或聯繫客服。</div>';
        return htmlResp(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>付款結果</title></head>
<body style="font-family:sans-serif;background:#F4F3EF;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="background:#fff;border-radius:16px;padding:40px;max-width:420px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.08)">
<div style="font-size:44px">${paid?'✅':'⏳'}</div>
<h2 style="margin:12px 0">${paid?'付款成功，感謝購買！':'訂單處理中'}</h2>
${licLine}
<a href="${SITE_URL}" style="display:inline-block;margin-top:24px;background:#E8552F;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">前往使用工具</a>
</div></body></html>`);
      }

      /* 後台 API（管理密碼保護） */
      if(path==='/admin-api'){
        const bb=await req.json();
        if(bb.pass!==(env.ADMIN_PASS||'admin2026'))return out({error:'密碼錯誤'},401);
        if(bb.act==='orders'){
          const list=await env.DB.list({prefix:'order:'});
          const orders=[];
          for(const k of list.keys){const v=await env.DB.get(k.name);if(v)orders.push(JSON.parse(v));}
          orders.sort((a,b)=>(b.created||0)-(a.created||0));
          const paid=orders.filter(o=>o.status==='paid');
          return out({orders:orders.slice(0,200),stats:{
            total:orders.length,paid:paid.length,
            revenue:paid.reduce((s,o)=>s+(o.amount||0),0)
          },env:cfg.prod?'正式':'測試'});
        }
        if(bb.act==='licenses'){
          const list=await env.DB.list({prefix:'lic:'});
          const lics=[];
          const now=Date.now();
          for(const k of list.keys){const v=await env.DB.get(k.name);if(v){
            const d=JSON.parse(v);const code=k.name.slice(4);
            let online=0;
            try{const seats=JSON.parse(await env.DB.get('seat:'+code)||'{}');
              for(const dd in seats){if(now-seats[dd]<=600000)online++;}
            }catch(e){}
            lics.push({code,...d,online,seats:d.seats||2});
          }}
          return out({licenses:lics});
        }
        if(bb.act==='addlic'){
          const code=(bb.code||genLic()).trim();
          await env.DB.put('lic:'+code,JSON.stringify({name:bb.name||'手動開立',pro:bb.pro===true||bb.boss===true,boss:bb.boss===true,seats:bb.seats||2}));
          return out({ok:true,code});
        }
        if(bb.act==='dellic'){await env.DB.delete('lic:'+bb.code);await env.DB.delete('seat:'+bb.code);return out({ok:true});}
        if(bb.act==='suspend'){
          const v=JSON.parse(await env.DB.get('lic:'+bb.code)||'null');
          if(!v)return out({error:'找不到授權碼'},404);
          v.suspended=bb.suspend===true;
          await env.DB.put('lic:'+bb.code,JSON.stringify(v));
          return out({ok:true,suspended:v.suspended});
        }
        if(bb.act==='resetseat'){await env.DB.delete('seat:'+bb.code);return out({ok:true});}
        if(bb.act==='setseats'){
          const v=JSON.parse(await env.DB.get('lic:'+bb.code)||'null');
          if(!v)return out({error:'找不到授權碼'},404);
          v.seats=Math.max(1,Math.min(20,parseInt(bb.seats)||2));
          await env.DB.put('lic:'+bb.code,JSON.stringify(v));
          return out({ok:true,seats:v.seats});
        }
        return out({error:'未知操作'},400);
      }
    }catch(e){return new Response('err:'+e.message,{status:500});}

    try{
      const b=await req.json();

      /* 授權驗證：正式授權碼 或 試用身分（tid）擇一 */
      const lic=(b.lic||'').trim();
      const tid=(b.tid||'').trim();
      const TRIAL_MAX=5;
      let licInfo={},trial=false,trialCount=0;
      if(lic){
        const licRec=await env.DB.get('lic:'+lic);
        if(!licRec)return out({error:'授權碼無效'},401);
        licInfo=JSON.parse(licRec||'{}');
        if(licInfo.exp&&Date.now()>licInfo.exp)return out({error:'授權已到期'},401);
        if(licInfo.suspended===true)return out({error:'此授權碼已被停用，如有疑問請聯繫客服'},403);
        /* 同時上線偵測：以裝置心跳判斷同時在線數，超過席位上限即擋 */
        if(!licInfo.boss){ // BOSS 不受限
          const SEAT_MAX=licInfo.seats||2;        // 預設允許 2 台同時在線
          const WINDOW=10*60*1000;                // 10 分鐘內有心跳＝在線
          const dev=(b.dev||'').slice(0,32)||'nodev';
          const now=Date.now();
          let seats={};
          try{seats=JSON.parse(await env.DB.get('seat:'+lic)||'{}');}catch(e){}
          // 清掉逾時的裝置
          for(const d in seats){if(now-seats[d]>WINDOW)delete seats[d];}
          const online=Object.keys(seats);
          if(!seats[dev]&&online.length>=SEAT_MAX){
            return out({error:`此授權碼目前已有 ${online.length} 台裝置同時使用（上限 ${SEAT_MAX} 台）。請關閉其他裝置後再試，或聯繫客服。`,seatFull:true},429);
          }
          seats[dev]=now;
          await env.DB.put('seat:'+lic,JSON.stringify(seats),{expirationTtl:3600});
        }
      }else if(/^[a-z0-9]{6,24}$/i.test(tid)){
        trial=true;
        trialCount=parseInt(await env.DB.get('trial:'+tid)||'0',10);
      }else return out({error:'NEED_LIC'},401);

      /* /v 驗證授權＋Gemini Key */
      if(path==='/v'){
        if(b.key){
          const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',{headers:{'x-goog-api-key':b.key}});
          const d=await r.json();
          if(d.error)return out({error:'Key 驗證失敗：'+d.error.message},400);
        }
        return out({ok:true,name:licInfo.name||'',pro:licInfo.pro===true,boss:licInfo.boss===true,trial,left:trial?Math.max(0,TRIAL_MAX-trialCount):null});
      }

      /* /s 建立/更新工作階段（上傳照片） */
      if(path==='/s'){
        const sid=b.sid||crypto.randomUUID().slice(0,12);
        const s=b.sid?await sget(env,sid).catch(()=>({})):{};
        s.photos=(b.photos||[]).slice(0,3);
        await sput(env,sid,s);
        return out({sid});
      }

      const key=b.key;if(!key)return out({error:'缺少 Gemini Key'},400);

      /* /t 文字任務 */
      if(path==='/t'){
        const s=b.sid?await sget(env,b.sid):{};
        /* 權限判定：有正式授權碼時，一律以授權碼層級為準（session 解鎖旗標只對無授權碼的試用者生效，
           避免解鎖碼或殘留 session 讓一般/PRO 客戶取得更高權限） */
        const boss=lic?(licInfo.boss===true):(s.boss===true);
        const pro=lic?(licInfo.boss===true||licInfo.pro===true):(s.boss===true||s.pro===true);
        switch(b.task){
          case 'analyze':{
            const r=await gemText(key,T.analyze(),'商品資料：\n'+b.product,s.photos);
            r.styles=boss?[MINIMAL_STYLE,...(r.styles||[]).slice(0,2)]:(r.styles||[]).slice(0,3);
            s.summary=r;await sput(env,b.sid,s);
            return out(r);
          }
          case 'unlock':{
            const code=(b.code||'').trim();
            /* 解鎖碼只作用於無授權碼的情境；已持正式授權者，層級固定由授權碼決定 */
            if(lic)return out({error:'你已使用授權碼，權限以授權碼為準'},403);
            if(code===BOSS_CODE){s.boss=true;s.pro=true;}
            else if(code===PRO_CODE){s.pro=true;}
            else return out({error:'解鎖碼無效'},403);
            let styles=null;
            if(s.summary){
              styles=s.boss?[MINIMAL_STYLE,...(s.summary.styles||[]).filter(x=>x.id!=='M')].slice(0,3):(s.summary.styles||[]).filter(x=>x.id!=='M').slice(0,3);
              s.summary.styles=styles;
            }
            await sput(env,b.sid,s);
            return out({ok:true,styles,pro:s.pro===true,boss:s.boss===true});
          }
          case 'prompts':{
            if((b.style?.id==='M'||/極簡/.test(b.style?.name||''))&&!boss)
              return out({error:'此風格為 BOSS 限定'},403);
            let trialLeft=null;
            if(trial){
              if(trialCount>=TRIAL_MAX)return out({error:'TRIAL_END'},402);
              await env.DB.put('trial:'+tid,String(trialCount+1),{expirationTtl:5184000});
              trialLeft=TRIAL_MAX-(trialCount+1);
            }
            s.style=b.style;s.model=pro?(b.model||''):''; // 自訂模特僅 PRO
            const [r1,r2]=await Promise.all([
              gemText(key,T.prompts(s,'1~5'),'寫第1~5張',s.photos),
              gemText(key,T.prompts(s,'6~10'),'寫第6~10張',s.photos)]);
            s.prompts=[...r1.prompts,...r2.prompts].sort((a,b)=>a.no-b.no);
            await sput(env,b.sid,s);
            return out({plan:s.prompts.map(p=>({no:p.no,goal:p.goal,h:p.h,s:p.s,...(boss?{p:p.p}:{})})),trialLeft}); // 提示詞透視僅 BOSS
          }
          case 'edit':{
            const r=await gemText(key,T.edit(s),b.text);
            if(r.action==='update'){
              const p=s.prompts.find(x=>x.no===r.no);
              if(p){Object.assign(p,{goal:r.goal,h:r.h,s:r.s,p:r.p});await sput(env,b.sid,s);}
              return out({action:'update',no:r.no,goal:r.goal,h:r.h,s:r.s,...(boss?{p:r.p}:{})});
            }
            return out(r);
          }
          case 'revise':{
            if(!pro)return out({error:'獨立修改為 PRO 版功能，一般版請使用「重抽」'},403);
            const p=s.prompts.find(x=>x.no===b.no);
            if(!p)throw new Error('找不到該張圖');
            const r=await gemText(key,T.revise(p.p,'第'+b.no+'張',b.req),'請改寫');
            p.p=r.p;await sput(env,b.sid,s);
            return out({ok:true,...(boss?{p:r.p}:{})});
          }
          case 'subject':{
            const r=await gemText(key,T.subject(),'請辨識商品主體',s.photos);
            s.subject=r;await sput(env,b.sid,s);
            return out(r);
          }
          case 'reviseMain':{
            if(!pro)return out({error:'獨立修改為 PRO 版功能'},403);
            const mp=(s.mains||{})[b.mid];
            if(!mp)throw new Error('找不到該張主圖');
            const r=await gemText(key,T.revise(mp,'白底主圖',b.req),'請改寫');
            s.mains[b.mid]=r.p;await sput(env,b.sid,s);
            return out({ok:true,...(boss?{p:r.p}:{})});
          }
        }
        return out({error:'未知任務'},400);
      }

      /* /i 圖像生成 */
      if(path==='/i'){
        const s=await sget(env,b.sid);
        const boss=lic?(licInfo.boss===true):(s.boss===true);
        const pro=lic?(licInfo.boss===true||licInfo.pro===true):(s.boss===true||s.pro===true);
        if(b.main){ // 主圖：伺服器組裝提示詞（試用計次：1張主圖=1次）
          let trialLeft=null;
          if(trial){
            if(trialCount>=TRIAL_MAX)return out({error:'TRIAL_END'},402);
            await env.DB.put('trial:'+tid,String(trialCount+1),{expirationTtl:5184000});
            trialLeft=TRIAL_MAX-(trialCount+1);
          }
          const prompt=T.main({...b.main,distractors:s.subject?.distractors},s);
          const mid=crypto.randomUUID().slice(0,8);
          s.mains=s.mains||{};s.mains[mid]=prompt;await sput(env,b.sid,s);
          const img=await gemImage(key,b.model,prompt,s.photos);
          return out({img,mid,trialLeft,...(boss?{p:prompt}:{})});
        }
        if(b.mid){ // 主圖重生/修改後重生
          const prompt=(s.mains||{})[b.mid];
          if(!prompt)throw new Error('找不到該張主圖');
          const img=await gemImage(key,b.model,prompt,s.photos);
          return out({img});
        }
        const p=(s.prompts||[]).find(x=>x.no===b.no); // 描述圖
        if(!p)throw new Error('找不到第 '+b.no+' 張的企劃，請先完成企劃步驟');
        /* 極簡攝影系：僅第2、10張附商品參考照；其餘張不附照，從物理上杜絕包裝入鏡 */
        const isMinS=s.style&&(s.style.id==='M'||/極簡/.test(s.style.name||''));
        const ph=(isMinS&&b.no!==2&&b.no!==10)?[]:s.photos;
        const img=await gemImage(key,b.model,p.p,ph);
        return out({img});
      }

      return out({error:'not found'},404);
    }catch(e){
      return out({error:e.message||'server error'},500);
    }
  }
};
