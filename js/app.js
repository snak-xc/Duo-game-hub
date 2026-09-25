import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import {
  getDatabase, ref, set, update, push, onValue, get, remove,
  onDisconnect, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const GAMES = [
  {id:"ttt",name:"Tic Tac Toe",emoji:"❌",desc:"Classic 3 × 3"},
  {id:"connect4",name:"Connect Four",emoji:"🔴",desc:"Connect 4 discs"},
  {id:"rps",name:"Rock Paper Scissors",emoji:"✊",desc:"Best of rounds"},
  {id:"memory",name:"Memory Match",emoji:"🧠",desc:"Find matching pairs"},
  {id:"dots",name:"Dots & Boxes",emoji:"🔷",desc:"Claim more boxes"},
  {id:"checkers",name:"Checkers Lite",emoji:"⚫",desc:"Simple capture game"}
];

const $ = s => document.querySelector(s);
const views = ["loginView","lobbyView","matchView","roomView"];
function show(id){ views.forEach(v=>$("#"+v).classList.toggle("active",v===id)); }
function safeName(v){ return (v||"").trim().replace(/[<>&]/g,"").slice(0,18); }

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);

let uid=null, displayName="", currentGame=null, roomId=null, myMark=null, opponent=null;
let roomUnsub=null, queueUnsub=null, micStream=null, pc=null, botMode=false;
let localScore=0, oppScore=0, gameFinished=false, rpsPick=null;
let lastScoredRoundKey=null, botRound=1, botThinking=false;
let overallStats={wins:0,losses:0,draws:0,played:0};

function setStatus(t){ $("#gameStatus").textContent=t; }
function roomRef(path=""){ return ref(db, `rooms/${roomId}${path?"/"+path:""}`); }

$("#loginBtn").onclick = async ()=>{
  const n=safeName($("#nameInput").value);
  if(!n){ $("#loginMsg").textContent="Please enter a name."; return; }
  displayName=n;
  localStorage.setItem("duoName",n);
  $("#loginMsg").textContent="";
  if(!auth.currentUser) await signInAnonymously(auth);
  else afterLogin();
};
$("#nameInput").value=localStorage.getItem("duoName")||"";

onAuthStateChanged(auth, async user=>{
  if(!user) return;
  uid=user.uid;
  if(displayName) afterLogin();
});

async function afterLogin(){
  await update(ref(db,`profiles/${uid}`),{name:displayName,updatedAt:serverTimestamp()});
  const p=ref(db,`presence/${uid}`);
  await set(p,{name:displayName,online:true,lastSeen:serverTimestamp()});
  onDisconnect(p).set({name:displayName,online:false,lastSeen:serverTimestamp()});
  $("#playerName").textContent=displayName;
  $("#meName").textContent=displayName;
  renderGames();
  show("lobbyView");
  onValue(ref(db,`profiles/${uid}/stats`),snap=>{
    overallStats={wins:0,losses:0,draws:0,played:0,...(snap.val()||{})};
    renderOverallStats();
  });
  onValue(ref(db,"presence"),snap=>{
    let c=0; snap.forEach(x=>{if(x.val()?.online)c++;}); $("#onlineCount").textContent=`Online: ${c}`;
  });
}

function renderOverallStats(){
  let box=$("#overallStatsBox");
  if(!box){
    box=document.createElement("div");
    box.id="overallStatsBox";
    box.style.cssText="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0 0 20px";
    const grid=$("#gameGrid");
    grid?.parentElement?.insertBefore(box,grid);
  }
  box.innerHTML=`
    <div class="player-chip"><span>Wins</span><small>${overallStats.wins||0}</small></div>
    <div class="player-chip"><span>Losses</span><small>${overallStats.losses||0}</small></div>
    <div class="player-chip"><span>Draws</span><small>${overallStats.draws||0}</small></div>
    <div class="player-chip"><span>Played</span><small>${overallStats.played||0}</small></div>`;
}

async function recordOverallResult(winner){
  const result=winner==="draw"?"draws":winner===myMark?"wins":"losses";
  await runTransaction(ref(db,`profiles/${uid}/stats`),cur=>{
    cur={wins:0,losses:0,draws:0,played:0,...(cur||{})};
    cur[result]=(cur[result]||0)+1;
    cur.played=(cur.played||0)+1;
    return cur;
  }).catch(()=>{});
  if(currentGame?.id){
    await runTransaction(ref(db,`profiles/${uid}/gameStats/${currentGame.id}`),cur=>{
      cur={wins:0,losses:0,draws:0,played:0,...(cur||{})};
      cur[result]=(cur[result]||0)+1;
      cur.played=(cur.played||0)+1;
      return cur;
    }).catch(()=>{});
  }
}

function renderGames(){
  $("#gameGrid").innerHTML="";
  GAMES.forEach(g=>{
    const b=document.createElement("button"); b.className="game-card";
    b.innerHTML=`<div class="emoji">${g.emoji}</div><h3>${g.name}</h3><p>${g.desc}</p>`;
    b.onclick=()=>startMatch(g);
    $("#gameGrid").appendChild(b);
  });
}

async function startMatch(game){
  currentGame=game; botMode=false; gameFinished=false;
  $("#matchGameTitle").textContent=game.name;
  $("#matchText").textContent="Looking for another online player…";
  show("matchView");
  const qRef=ref(db,`queues/${game.id}`);
  const snap=await get(qRef);
  let found=null;
  snap.forEach(c=>{ if(!found && c.key!==uid) found={uid:c.key,...c.val()}; });
  if(found){
    await createRoomWith(found.uid, found.name);
    await remove(ref(db,`queues/${game.id}/${found.uid}`));
  }else{
    await set(ref(db,`queues/${game.id}/${uid}`),{name:displayName,joinedAt:Date.now()});
    onDisconnect(ref(db,`queues/${game.id}/${uid}`)).remove();
    queueUnsub=onValue(ref(db,`matches/${uid}`),async s=>{
      if(!s.exists())return;
      const m=s.val(); await remove(ref(db,`matches/${uid}`)); joinRoom(m.roomId,m.opponentUid,m.opponentName,m.mark);
    });
  }
}
async function createRoomWith(otherUid, otherName){
  roomId=push(ref(db,"rooms")).key;
  const first=Math.random()<.5 ? uid : otherUid;
  const p1=first===uid?uid:otherUid, p2=first===uid?otherUid:uid;
  const names={[uid]:displayName,[otherUid]:otherName};
  const data={
    game:currentGame.id,status:"playing",createdAt:serverTimestamp(),turn:p1,round:1,
    players:{[p1]:{name:names[p1],mark:"A"},[p2]:{name:names[p2],mark:"B"}},
    state:initialState(currentGame.id)
  };
  await set(ref(db,`rooms/${roomId}`),data);
  await set(ref(db,`matches/${otherUid}`),{roomId,opponentUid:uid,opponentName:displayName,mark:p2===otherUid?"B":"A"});
  joinRoom(roomId,otherUid,otherName,p1===uid?"A":"B");
}
async function joinRoom(rid,oppUid,oppName,mark){
  if(queueUnsub){ queueUnsub(); queueUnsub=null; }
  if(currentGame) await remove(ref(db,`queues/${currentGame.id}/${uid}`)).catch(()=>{});
  roomId=rid; opponent={uid:oppUid,name:oppName}; myMark=mark; botMode=false; lastScoredRoundKey=null; botThinking=false;
  localScore=0; oppScore=0;
  $("#oppName").textContent=oppName; $("#roomLabel").textContent=rid.slice(-7);
  $("#meScore").textContent=localScore; $("#oppScore").textContent=oppScore;
  show("roomView"); listenRoom(); await setupVoice();
}
$("#cancelMatchBtn").onclick=async()=>{ if(currentGame) await remove(ref(db,`queues/${currentGame.id}/${uid}`)); if(queueUnsub)queueUnsub(); show("lobbyView"); };
$("#botBtn").onclick=()=>startBot();

function startBot(){
  if(currentGame) remove(ref(db,`queues/${currentGame.id}/${uid}`)).catch(()=>{});
  if(queueUnsub){queueUnsub();queueUnsub=null;}
  botMode=true; roomId="BOT-"+Math.random().toString(36).slice(2,8); opponent={uid:"BOT",name:"Computer"}; myMark="A"; botRound=1; lastScoredRoundKey=null; botThinking=false;
  localScore=0; oppScore=0;
  $("#meScore").textContent=0; $("#oppScore").textContent=0;
  $("#oppName").textContent="Computer"; $("#roomLabel").textContent="Computer";
  show("roomView"); renderState(initialState(currentGame.id),uid); setStatus("Your turn");
}
function initialState(game){
  if(game==="ttt") return {cells:Array(9).fill(""),winner:null};
  if(game==="connect4") return {cells:Array(42).fill(""),winner:null};
  if(game==="rps") return {round:1,picks:{}};
  if(game==="memory") return {cards:shuffle(["🍎","🍎","🌙","🌙","⚡","⚡","🎲","🎲","🐼","🐼","🚀","🚀","🎧","🎧","💎","💎"]),open:[],matched:[],scores:{A:0,B:0},winner:null};
  if(game==="dots") return {cells:Array(16).fill(""),winner:null};
  if(game==="checkers") return {cells:checkersStart(),selected:null,winner:null};
}
function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a}
function checkersStart(){const a=Array(64).fill("");for(let r=0;r<3;r++)for(let c=0;c<8;c++)if((r+c)%2)a[r*8+c]="B";for(let r=5;r<8;r++)for(let c=0;c<8;c++)if((r+c)%2)a[r*8+c]="A";return a}

function listenRoom(){
  if(roomUnsub) roomUnsub();
  roomUnsub=onValue(roomRef(),snap=>{
    if(!snap.exists()){ setStatus("Room closed."); return; }
    const d=snap.val();
    renderState(d.state,d.turn);

    if(d.status==="finished"){
      const round=d.round||1;
      const roundKey=`${roomId}:${round}`;
      if(lastScoredRoundKey!==roundKey){
        lastScoredRoundKey=roundKey;
        const winner=d.state?.winner ?? d.state?.result ?? null;
        applyScore(winner);
      }
      gameFinished=true;
      $("#rematchBtn").classList.remove("hidden");
      $("#newPartnerBtn").classList.remove("hidden");
    }
  });
}

function applyScore(winner){
  if(!winner) return;
  if(winner!=="draw"){
    if(winner===myMark){
      localScore++;
      $("#meScore").textContent=localScore;
    }else{
      oppScore++;
      $("#oppScore").textContent=oppScore;
    }
  }
  recordOverallResult(winner);
}
function renderState(state,turn){
  if(!currentGame)return;
  if(currentGame.id==="ttt") renderTTT(state,turn);
  if(currentGame.id==="connect4") renderConnect4(state,turn);
  if(currentGame.id==="rps") renderRPS(state,turn);
  if(currentGame.id==="memory") renderMemory(state,turn);
  if(currentGame.id==="dots") renderDots(state,turn);
  if(currentGame.id==="checkers") renderCheckers(state,turn);
}
function canMove(turn){ return turn===uid; }
async function writeState(state,nextTurn,status="playing"){
  if(botMode){
    renderState(state,nextTurn);
    if(status==="finished"){ finishLocal(state.winner); return; }
    if(nextTurn==="BOT" && !botThinking) setTimeout(()=>botMove(state),520);
    return;
  }
  await update(roomRef(),{state,turn:nextTurn,status});
}
function nextUid(){return opponent?.uid}

function renderTTT(s,turn){
  const b=$("#gameBoard");b.className="game-board board-3";b.innerHTML="";
  setStatus(s.winner?`${s.winner==="draw"?"Draw":s.winner===myMark?"You win!":"Opponent wins"}`:canMove(turn)?"Your turn":"Opponent's turn");
  s.cells.forEach((v,i)=>{const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"❌":v==="B"?"⭕":"";c.onclick=()=>tttMove(s,turn,i);b.appendChild(c)});
}
async function tttMove(s,turn,i){if(s.cells[i]||s.winner||!canMove(turn))return; const n={...s,cells:[...s.cells]};n.cells[i]=myMark; n.winner=tttWinner(n.cells); await writeState(n,nextUid(),n.winner?"finished":"playing");}
function tttWinner(c){const L=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];for(const l of L)if(c[l[0]]&&c[l[0]]===c[l[1]]&&c[l[1]]===c[l[2]])return c[l[0]];return c.every(Boolean)?"draw":null}

function renderConnect4(s,turn){
  const b=$("#gameBoard");b.className="game-board board-7";b.innerHTML="";
  setStatus(s.winner?(s.winner===myMark?"You win!":"Opponent wins"):canMove(turn)?"Your turn":"Opponent's turn");
  s.cells.forEach((v,i)=>{const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"🔴":v==="B"?"🟡":"";c.onclick=()=>c4Move(s,turn,i%7);b.appendChild(c)});
}
async function c4Move(s,turn,col){if(s.winner||!canMove(turn))return;let row=-1;for(let r=5;r>=0;r--)if(!s.cells[r*7+col]){row=r;break}if(row<0)return;const n={...s,cells:[...s.cells]};n.cells[row*7+col]=myMark;n.winner=c4Winner(n.cells);await writeState(n,nextUid(),n.winner?"finished":"playing")}
function c4Winner(c){for(let r=0;r<6;r++)for(let col=0;col<7;col++){const m=c[r*7+col];if(!m)continue;for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]){let ok=true;for(let k=1;k<4;k++){const rr=r+dr*k,cc=col+dc*k;if(rr<0||rr>5||cc<0||cc>6||c[rr*7+cc]!==m)ok=false}if(ok)return m}}return null}

function renderRPS(s){const b=$("#gameBoard");b.className="rps";b.innerHTML="";setStatus("Choose one");["✊","✋","✌️"].forEach(x=>{const q=document.createElement("button");q.textContent=x;q.onclick=()=>rpsMove(x);b.appendChild(q)})}
async function rpsMove(x){
  if(botMode){
    const y=["✊","✋","✌️"][Math.floor(Math.random()*3)];
    const w=rpsWinner(x,y);
    setStatus(`${x} vs ${y} — ${w===0?"Draw":w>0?"You win!":"Computer wins"}`);
    finishLocal(w===0?"draw":w>0?"A":"B");
    return;
  }
  await set(roomRef(`state/picks/${uid}`),x);
  const snap=await get(roomRef("state/picks"));const p=snap.val()||{};if(Object.keys(p).length<2){setStatus("Waiting for opponent…");return}
  const mine=p[uid],theirs=p[opponent.uid],w=rpsWinner(mine,theirs),winner=w===0?"draw":w>0?myMark:(myMark==="A"?"B":"A");
  await update(roomRef(),{status:"finished","state/result":winner});
}
function rpsWinner(a,b){if(a===b)return 0;return (a==="✊"&&b==="✌️")||(a==="✋"&&b==="✊")||(a==="✌️"&&b==="✋")?1:-1}

function renderMemory(s,turn){
  const b=$("#gameBoard");b.className="game-board memory";b.innerHTML="";
  const mine=s.scores?.[myMark]||0, other=s.scores?.[myMark==="A"?"B":"A"]||0;
  setStatus(s.winner?(s.winner==="draw"?`Draw • Pairs ${mine}-${other}`:s.winner===myMark?`You win! • Pairs ${mine}-${other}`:`Opponent wins • Pairs ${mine}-${other}`):`${canMove(turn)?"Your turn":"Opponent's turn"} • Pairs ${mine}-${other}`);
  s.cards.forEach((v,i)=>{
    const c=document.createElement("button");c.className="cell";
    const open=s.open?.includes(i)||s.matched?.includes(i);
    c.textContent=open?v:"❔";
    c.onclick=()=>memoryMove(s,turn,i);b.appendChild(c);
  });
}
async function memoryMove(s,turn,i){
  if(!canMove(turn)||s.winner||s.matched.includes(i)||s.open.includes(i)||s.open.length>=2)return;
  let n=JSON.parse(JSON.stringify(s));
  n.scores={A:0,B:0,...(n.scores||{})};
  n.open.push(i);
  if(n.open.length===1){ await writeState(n,uid); return; }
  const [a,b]=n.open;
  if(n.cards[a]===n.cards[b]){
    n.matched.push(a,b);
    n.scores[myMark]=(n.scores[myMark]||0)+1;
    n.open=[];
    if(n.matched.length===n.cards.length){
      n.winner=n.scores.A===n.scores.B?"draw":n.scores.A>n.scores.B?"A":"B";
      await writeState(n,uid,"finished");
    }else await writeState(n,uid);
  }else{
    await writeState(n,uid);
    setTimeout(async()=>{
      n.open=[];
      await writeState(n,nextUid());
    },750);
  }
}

function renderDots(s,turn){
  const b=$("#gameBoard");b.className="game-board dots";b.innerHTML="";
  const a=s.cells.filter(x=>x==="A").length, bb=s.cells.filter(x=>x==="B").length;
  setStatus(s.winner?(s.winner==="draw"?`Draw • ${a}-${bb}`:s.winner===myMark?`You win! • ${a}-${bb}`:`Opponent wins • ${a}-${bb}`):`${canMove(turn)?"Your turn":"Opponent's turn"} • ${a}-${bb}`);
  s.cells.forEach((v,i)=>{const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"🔵":v==="B"?"🟣":"";c.onclick=()=>dotsMove(s,turn,i);b.appendChild(c)});
}
async function dotsMove(s,turn,i){
  if(!canMove(turn)||s.winner||s.cells[i])return;
  const n={...s,cells:[...s.cells]};n.cells[i]=myMark;
  if(n.cells.every(Boolean)){const a=n.cells.filter(x=>x==="A").length,b=n.cells.length-a;n.winner=a===b?"draw":a>b?"A":"B"}
  await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
}

function renderCheckers(s,turn){
  const b=$("#gameBoard");b.className="game-board checkers";b.innerHTML="";
  setStatus(s.winner?(s.winner===myMark?"You win!":"Opponent wins"):canMove(turn)?"Your turn":"Opponent's turn");
  s.cells.forEach((v,i)=>{
    const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"⚪":v==="B"?"⚫":"";
    if(s.selected===i)c.style.outline="2px solid currentColor";
    c.onclick=()=>checkersMove(s,turn,i);b.appendChild(c);
  });
}
function checkersLegalMoves(cells,mark){
  const dir=mark==="A"?-1:1, enemy=mark==="A"?"B":"A", moves=[];
  for(let a=0;a<64;a++){
    if(cells[a]!==mark)continue;
    const ar=Math.floor(a/8),ac=a%8;
    for(const dc of [-1,1]){
      const r=ar+dir,c=ac+dc;
      if(r>=0&&r<8&&c>=0&&c<8){
        const to=r*8+c;
        if(!cells[to])moves.push({from:a,to,capture:null});
        else if(cells[to]===enemy){
          const rr=ar+dir*2,cc=ac+dc*2;
          if(rr>=0&&rr<8&&cc>=0&&cc<8&&!cells[rr*8+cc])moves.push({from:a,to:rr*8+cc,capture:to});
        }
      }
    }
  }
  const caps=moves.filter(m=>m.capture!==null);
  return caps.length?caps:moves;
}
async function checkersMove(s,turn,i){
  if(!canMove(turn)||s.winner)return;
  let n=JSON.parse(JSON.stringify(s));
  if(n.selected==null){
    if(n.cells[i]===myMark){n.selected=i;renderCheckers(n,turn)}
    return;
  }
  const legal=checkersLegalMoves(n.cells,myMark).find(m=>m.from===n.selected&&m.to===i);
  if(!legal){n.selected=null;renderCheckers(n,turn);return}
  n.cells[legal.to]=myMark;n.cells[legal.from]="";if(legal.capture!==null)n.cells[legal.capture]="";n.selected=null;
  const enemy=myMark==="A"?"B":"A";
  if(!n.cells.includes(enemy)||checkersLegalMoves(n.cells,enemy).length===0)n.winner=myMark;
  await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
}

function botMove(state){
  if(!botMode||gameFinished||botThinking)return;
  botThinking=true;
  const done=()=>{botThinking=false};

  if(currentGame.id==="ttt"){
    const ids=state.cells.map((x,i)=>!x?i:-1).filter(i=>i>=0);
    if(!ids.length){done();return}
    const n=JSON.parse(JSON.stringify(state));const i=ids[Math.floor(Math.random()*ids.length)];n.cells[i]="B";n.winner=tttWinner(n.cells);
    renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="connect4"){
    const cols=[0,1,2,3,4,5,6].filter(c=>!state.cells[c]);if(!cols.length){done();return}
    const n=JSON.parse(JSON.stringify(state));const col=cols[Math.floor(Math.random()*cols.length)];
    for(let r=5;r>=0;r--)if(!n.cells[r*7+col]){n.cells[r*7+col]="B";break}
    n.winner=c4Winner(n.cells);renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="memory"){
    const n=JSON.parse(JSON.stringify(state));n.scores={A:0,B:0,...(n.scores||{})};n.open=[];
    const available=n.cards.map((_,i)=>!n.matched.includes(i)?i:-1).filter(i=>i>=0);
    if(available.length<2){done();return}
    const first=available[Math.floor(Math.random()*available.length)];n.open=[first];renderState(n,"BOT");
    setTimeout(()=>{
      const rest=available.filter(i=>i!==first);const second=rest[Math.floor(Math.random()*rest.length)];n.open=[first,second];renderState(n,"BOT");
      setTimeout(()=>{
        if(n.cards[first]===n.cards[second]){
          n.matched.push(first,second);n.scores.B=(n.scores.B||0)+1;n.open=[];
          if(n.matched.length===n.cards.length){n.winner=n.scores.A===n.scores.B?"draw":n.scores.A>n.scores.B?"A":"B";renderState(n,uid);done();finishLocal(n.winner)}
          else{renderState(n,"BOT");done();setTimeout(()=>botMove(n),450)}
        }else{n.open=[];renderState(n,uid);done()}
      },650);
    },450);
    return;
  }
  if(currentGame.id==="dots"){
    const ids=state.cells.map((x,i)=>!x?i:-1).filter(i=>i>=0);if(!ids.length){done();return}
    const n={...state,cells:[...state.cells]};const i=ids[Math.floor(Math.random()*ids.length)];n.cells[i]="B";
    if(n.cells.every(Boolean)){const a=n.cells.filter(x=>x==="A").length,b=n.cells.length-a;n.winner=a===b?"draw":a>b?"A":"B"}
    renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="checkers"){
    const n=JSON.parse(JSON.stringify(state));const moves=checkersLegalMoves(n.cells,"B");
    if(!moves.length){n.winner="A";renderState(n,uid);done();finishLocal("A");return}
    const m=moves[Math.floor(Math.random()*moves.length)];n.cells[m.to]="B";n.cells[m.from]="";if(m.capture!==null)n.cells[m.capture]="";n.selected=null;
    if(!n.cells.includes("A")||checkersLegalMoves(n.cells,"A").length===0)n.winner="B";
    renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  done();
}

function finishLocal(winner){
  if(gameFinished) return;
  const roundKey=`${roomId}:${botRound}`;
  if(lastScoredRoundKey!==roundKey){
    lastScoredRoundKey=roundKey;
    applyScore(winner);
  }
  gameFinished=true;
  $("#rematchBtn").classList.remove("hidden");
  $("#newPartnerBtn").classList.remove("hidden");
}

$("#leaveBtn").onclick=leaveRoom;
async function leaveRoom(){
  stopVoice(); if(roomUnsub){roomUnsub();roomUnsub=null;}
  if(!botMode&&roomId) await update(roomRef(),{status:"finished"}).catch(()=>{});
  roomId=null; opponent=null; botMode=false; botThinking=false; $("#rematchBtn").classList.add("hidden");$("#newPartnerBtn").classList.add("hidden");show("lobbyView");
}
$("#newPartnerBtn").onclick=async()=>{await leaveRoom();startMatch(currentGame)};
$("#rematchBtn").onclick=async()=>{
  $("#rematchBtn").classList.add("hidden");
  $("#newPartnerBtn").classList.add("hidden");
  gameFinished=false;

  if(botMode){
    botRound++;
    lastScoredRoundKey=null;
    botThinking=false;
    renderState(initialState(currentGame.id),uid);
    return;
  }

  const snap=await get(roomRef("round"));
  const nextRound=(snap.val()||1)+1;
  lastScoredRoundKey=null;
  await update(roomRef(),{
    state:initialState(currentGame.id),
    status:"playing",
    turn:uid,
    round:nextRound
  });
};

$("#micBtn").onclick=async()=>{
  if(!micStream){await startMic();return}
  const t=micStream.getAudioTracks()[0];t.enabled=!t.enabled;$("#micBtn").textContent=t.enabled?"🎤 Mic On":"🔇 Mic Off";
};
async function startMic(){
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    $("#micBtn").textContent="🎤 Mic On";
    if(pc) micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));
  }catch(e){setStatus("Microphone permission was not granted.");}
}
async function setupVoice(){
  if(botMode)return;
  await startMic();
  pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  if(micStream)micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));
  pc.ontrack=e=>$("#remoteAudio").srcObject=e.streams[0];
  pc.onicecandidate=e=>{if(e.candidate)push(roomRef(`voice/candidates/${uid}`),e.candidate.toJSON())};
  onValue(roomRef(`voice/candidates/${opponent.uid}`),snap=>snap.forEach(x=>pc.addIceCandidate(x.val()).catch(()=>{})));
  const offerer=myMark==="A";
  if(offerer){
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);await set(roomRef("voice/offer"),offer);
    onValue(roomRef("voice/answer"),async s=>{if(s.exists()&&!pc.currentRemoteDescription)await pc.setRemoteDescription(s.val())});
  }else{
    onValue(roomRef("voice/offer"),async s=>{if(!s.exists()||pc.currentRemoteDescription)return;await pc.setRemoteDescription(s.val());const ans=await pc.createAnswer();await pc.setLocalDescription(ans);await set(roomRef("voice/answer"),ans)});
  }
}
function stopVoice(){if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null}if(pc){pc.close();pc=null}}

window.addEventListener("beforeunload",()=>{ if(currentGame&&uid) remove(ref(db,`queues/${currentGame.id}/${uid}`)).catch(()=>{}); });
