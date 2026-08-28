export function landingPage() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Codex Meter</title>
  <style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:760px;margin:0 auto;padding:2rem 1rem;line-height:1.5}header{margin-bottom:2rem}.status{color:#16803a;font-weight:700}.cards{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}.card{border:1px solid #8886;border-radius:12px;padding:1rem}label{display:block;font-weight:700;margin:.5rem 0}input{box-sizing:border-box;width:100%;padding:.65rem}button{margin-top:.75rem;padding:.65rem 1rem;cursor:pointer}.result{margin-top:1rem;white-space:pre-wrap}.error{color:#c62828}table{border-collapse:collapse;width:100%;margin-top:.75rem}th,td{border:1px solid #8886;padding:.45rem;text-align:left}small{opacity:.75}
  </style>
</head>
<body>
  <header>
    <h1>Codex Meter</h1>
    <p class="status">● 웹 서버 연결됨 / Web endpoint reachable</p>
    <p>세 사용자의 숫자 토큰 카운터를 관찰 전용으로 집계합니다. OpenAI 인증정보·프롬프트·응답은 전송하지 않습니다.</p>
  </header>
  <main class="cards">
    <section class="card">
      <h2>내 사용량</h2>
      <p>개인 PC에 발급된 Meter 토큰을 입력하세요.</p>
      <form id="usage-form">
        <label for="usage-token">Meter token</label>
        <input id="usage-token" type="password" autocomplete="off" required>
        <button type="submit">조회</button>
      </form>
      <div id="usage-result" class="result" aria-live="polite"></div>
    </section>
    <section class="card" id="admin">
      <h2>관리자 대시보드</h2>
      <p>서버 초기화 때 발급된 관리자 토큰을 입력하세요.</p>
      <form id="admin-form">
        <label for="admin-token">Admin token</label>
        <input id="admin-token" type="password" autocomplete="off" required>
        <button type="submit">로그인</button>
      </form>
      <div id="admin-result" class="result" aria-live="polite"></div>
    </section>
  </main>
  <p><small>토큰은 URL·쿠키·브라우저 저장소에 저장하지 않으며 이 페이지의 메모리에서 HTTPS Authorization 헤더로만 사용합니다.</small></p>
  <script src="/ui.js" defer></script>
</body>
</html>`;
}

export const uiScript = `'use strict';
const byId=(id)=>document.getElementById(id);
const clear=(node)=>{while(node.firstChild)node.removeChild(node.firstChild);node.classList.remove('error');};
const fail=(node,message)=>{clear(node);node.classList.add('error');node.textContent=message;};
const secureTransport=location.protocol==='https:';
if(!secureTransport){
  for(const id of ['usage-token','admin-token'])byId(id).disabled=true;
  for(const form of [byId('usage-form'),byId('admin-form')])form.querySelector('button').disabled=true;
  const warning='보안 연결(HTTPS)에서만 토큰을 입력할 수 있습니다.';fail(byId('usage-result'),warning);fail(byId('admin-result'),warning);
}
async function authorized(path,token){
  const response=await fetch(path,{headers:{authorization:'Bearer '+token},cache:'no-store'});
  const data=await response.json().catch(()=>({error:'invalid_response'}));
  if(!response.ok)throw new Error(response.status===401?'토큰이 올바르지 않습니다.':'요청 실패: '+(data.error||response.status));
  return data;
}
if(secureTransport)byId('usage-form').addEventListener('submit',async(event)=>{
  event.preventDefault();const input=byId('usage-token'),out=byId('usage-result'),token=input.value;input.value='';
  try{const data=await authorized('/v1/usage',token);clear(out);out.textContent='사용자: '+data.user+'\\n모드: '+(data.mode==='observe'?'관찰 전용':'강제 쿼터')+'\\n누적 토큰: '+data.used.total_tokens.toLocaleString();}
  catch(error){fail(out,error.message);}
});
if(secureTransport)byId('admin-form').addEventListener('submit',async(event)=>{
  event.preventDefault();const input=byId('admin-token'),out=byId('admin-result'),token=input.value;input.value='';
  try{
    const data=await authorized('/admin.json',token);clear(out);
    const policy=document.createElement('p');policy.textContent=data.config.mode==='observe'?'관찰 전용 — 토큰 차단 없음':'동일 쿼터: '+data.config.quotaTokens.toLocaleString();out.appendChild(policy);
    const table=document.createElement('table'),caption=document.createElement('caption'),head=document.createElement('thead'),hr=document.createElement('tr');caption.textContent='사용자별 Codex Meter 사용량';table.appendChild(caption);
    for(const text of ['사용자','활성','누적 토큰']){const th=document.createElement('th');th.scope='col';th.textContent=text;hr.appendChild(th);}head.appendChild(hr);table.appendChild(head);
    const body=document.createElement('tbody');for(const user of data.users){const row=document.createElement('tr');for(const value of [user.id,user.enabled?'예':'아니오',user.used.total_tokens.toLocaleString()]){const cell=document.createElement('td');cell.textContent=value;row.appendChild(cell);}body.appendChild(row);}table.appendChild(body);out.appendChild(table);
  }catch(error){fail(out,error.message);}
});
`;
