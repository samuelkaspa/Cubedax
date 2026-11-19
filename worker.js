import html from './index.html';
// Servidor multiplayer do Cubo Preto (Cloudflare Worker + Durable Object).
// Todas as salas vivem em um único Durable Object ("global"): simples e suficiente para um jogo pequeno.
const CH='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const REL=new Set(['st','door','kn','ek','dead','win','pick']);
const clean=(s,n)=>String(s==null?'':s).replace(/[<>&"'`\\]/g,'').trim().slice(0,n);
const rnd=n=>Math.floor(Math.random()*n);
const MODES=new Set(['easy','normal','hard']);

export class Hub{
 constructor(){this.rooms=new Map();this.cs=new Set()}
 add(ws){const c={ws,room:null,s:-1,sub:false,name:'Cubo',rec:'—',skin:'preto',ready:false};this.cs.add(c);return c}
 send(c,o){try{c.ws.send(JSON.stringify(o))}catch(e){}}
 cast(r,o,ex){for(const c of r.pl)if(c&&c!==ex)this.send(c,o)}
 count(r){return r.pl.filter(Boolean).length}
 list(){return[...this.rooms.values()].filter(r=>!r.priv&&!r.started).map(r=>({code:r.code,host:r.pl[r.host].name,n:this.count(r),max:r.max}))}
 push(){const l={t:'rooms',list:this.list()};for(const c of this.cs)if(c.sub)this.send(c,l)}
 view(r){const players=[];r.pl.forEach((c,s)=>{if(c)players.push({s,name:c.name,rec:c.rec,skin:c.skin,ready:c.ready})});return{code:r.code,priv:r.priv,mode:r.mode,max:r.max,host:r.host,started:r.started,players}}
 sync(r){r.pl.forEach(c=>{if(c)this.send(c,{t:'room',you:c.s,room:this.view(r)})})}
 plan(){// 10 tipos de mapa diferentes: cada ciclo de 10 usa todos os tipos, em ordem embaralhada
  const out=[];let last=-1;
  while(out.length<30){const a=[...Array(10).keys()];for(let i=9;i>0;i--){const j=rnd(i+1);[a[i],a[j]]=[a[j],a[i]]}
   if(a[0]===last){[a[0],a[1]]=[a[1],a[0]]}last=a[9];for(const t of a)out.push({t,s:rnd(1e6)})}
  return out.slice(0,30)}
 chk(r){const n=this.count(r);
  if(r.started&&r.retry.size&&r.retry.size>=n){r.retry.clear();this.cast(r,{t:'restart',plan:this.plan(),mode:r.mode})}
  else if(r.started&&r.retry.size)this.cast(r,{t:'retry',n:r.retry.size,of:n})}
 leave(c){const r=c.room;if(!r)return;const s=c.s;r.pl[s]=null;r.retry.delete(s);c.room=null;c.s=-1;c.ready=false;
  if(!this.count(r))this.rooms.delete(r.code);
  else{if(r.host===s)r.host=r.pl.findIndex(Boolean);this.sync(r);this.chk(r)}
  this.push()}
 drop(c){this.cs.delete(c);this.leave(c)}
 msg(c,raw){if(typeof raw!=='string'||raw.length>600)return;let m;try{m=JSON.parse(raw)}catch(e){return}
  if(!m||typeof m.t!=='string')return;const r=c.room;
  switch(m.t){
   case'sub':c.sub=!!m.v;if(c.sub)this.send(c,{t:'rooms',list:this.list()});break;
   case'prof':c.name=clean(m.name,12)||'Cubo';c.rec=clean(m.rec,12)||'—';c.skin=clean(m.skin,10)||'preto';if(r){this.sync(r);this.push()}break;
   case'create':{if(r)return;let code;do{code=Array.from({length:4},()=>CH[rnd(CH.length)]).join('')}while(this.rooms.has(code));
    const room={code,priv:!!m.priv,mode:'normal',max:Math.max(2,Math.min(4,+m.max||4)),host:0,started:false,pl:[c],retry:new Set()};
    this.rooms.set(code,room);c.room=room;c.s=0;c.ready=false;this.sync(room);this.push();break}
   case'join':{if(r)return;const room=this.rooms.get(clean(m.code,4).toUpperCase());
    if(!room)return this.send(c,{t:'err',m:'Sala não encontrada.'});
    if(room.started)return this.send(c,{t:'err',m:'A partida já começou.'});
    let s=-1;for(let i=0;i<room.max;i++)if(!room.pl[i]){s=i;break}
    if(s<0)return this.send(c,{t:'err',m:'Sala cheia.'});
    room.pl[s]=c;c.room=room;c.s=s;c.ready=false;this.sync(room);this.push();break}
   case'mode':if(r&&!r.started&&r.host===c.s&&MODES.has(m.v)){r.mode=m.v;this.sync(r)}break;
   case'leave':this.leave(c);break;
   case'ready':if(r&&!r.started){c.ready=!!m.v;this.sync(r)}break;
   case'start':if(r&&!r.started&&r.host===c.s){
    if(this.count(r)<2||r.pl.some(x=>x&&x!==c&&!x.ready))return this.send(c,{t:'err',m:'Todos precisam estar prontos.'});
    r.started=true;r.retry.clear();this.sync(r);this.cast(r,{t:'start',plan:this.plan(),mode:r.mode});this.push()}break;
   case'retry':if(r&&r.started){r.retry.add(c.s);this.chk(r)}break;
   case'back':if(r&&r.started){r.started=false;r.retry.clear();r.pl.forEach(x=>{if(x)x.ready=false});this.sync(r);this.push()}break;
   case'cardres':if(r&&r.started&&r.host===c.s){m.s=c.s;this.cast(r,m,c)}break;
   default:if(r&&r.started&&REL.has(m.t)){m.s=c.s;this.cast(r,m,c)}}}
}

export class GameHub{
 constructor(){this.hub=new Hub()}
 async fetch(req){
  if(req.headers.get('Upgrade')!=='websocket')return new Response('Use WebSocket',{status:426});
  const [cl,sv]=Object.values(new WebSocketPair());sv.accept();const c=this.hub.add(sv);
  sv.addEventListener('message',e=>this.hub.msg(c,e.data));
  sv.addEventListener('close',()=>this.hub.drop(c));
  sv.addEventListener('error',()=>this.hub.drop(c));
  return new Response(null,{status:101,webSocket:cl})}
}

export default{
 async fetch(req,env){
  const u=new URL(req.url);
  if(u.pathname==='/ws')return env.HUB.get(env.HUB.idFromName('global')).fetch(req);
  return new Response(html,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-cache'}})}
};
