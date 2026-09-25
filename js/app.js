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
let autoRematchTimer=null, autoRematchInterval=null, lastRpsScoredRound=0;
let checkersPlan=null, checkersPlanTimer=null, checkersPlanCountdown=null, checkersAnimating=false;
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
  roomId=rid; opponent={uid:oppUid,name:oppName}; myMark=mark; botMode=false; lastScoredRoundKey=null; lastRpsScoredRound=0; botThinking=false; clearCheckersPlan();
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
  botMode=true; roomId="BOT-"+Math.random().toString(36).slice(2,8); opponent={uid:"BOT",name:"Computer"}; myMark="A"; botRound=1; lastScoredRoundKey=null; lastRpsScoredRound=0; botThinking=false; clearCheckersPlan();
  localScore=0; oppScore=0;
  $("#meScore").textContent=0; $("#oppScore").textContent=0;
  $("#oppName").textContent="Computer"; $("#roomLabel").textContent="Computer";
  show("roomView"); renderState(initialState(currentGame.id),uid); setStatus("Your turn");
}
function initialState(game){
  if(game==="ttt") return {cells:Array(9).fill(""),winner:null};
  if(game==="connect4") return {cells:Array(42).fill(""),winner:null};
  if(game==="rps") return {round:1,picks:{},score:{A:0,B:0},lastWinner:null,lastText:""};
  if(game==="memory") return {cards:shuffle(["🍎","🍎","🌙","🌙","⚡","⚡","🎲","🎲","🐼","🐼","🚀","🚀","🎧","🎧","💎","💎"]),open:[],matched:[],scores:{A:0,B:0},winner:null};
  if(game==="dots") return {h:Array(12).fill(""),v:Array(12).fill(""),boxes:Array(9).fill(""),winner:null};
  if(game==="checkers") return {cells:checkersStart(),selected:null,winner:null};
}
function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a}
function checkersStart(){
  const a=Array(64).fill("");
  for(let r=0;r<3;r++)for(let c=0;c<8;c++)if((r+c)%2)a[r*8+c]="B";
  for(let r=5;r<8;r++)for(let c=0;c<8;c++)if((r+c)%2)a[r*8+c]="A";
  return a;
}
function ownerOf(piece){ return piece?.startsWith("A")?"A":piece?.startsWith("B")?"B":""; }
function isKing(piece){ return piece==="AK"||piece==="BK"; }

function listenRoom(){
  if(roomUnsub) roomUnsub();
  roomUnsub=onValue(roomRef(),snap=>{
    if(!snap.exists()){ setStatus("Room closed."); return; }
    const d=snap.val();
    renderState(d.state,d.turn);

    if(currentGame?.id==="rps"){
      const resolved=d.state?.lastResolvedRound||0;
      if(resolved && resolved!==lastRpsScoredRound){
        lastRpsScoredRound=resolved;
        const winner=d.state?.lastWinner||"draw";
        applyScore(winner);
      }
      return;
    }

    if(d.status==="finished"){
      const round=d.round||1;
      const roundKey=`${roomId}:${round}`;
      if(lastScoredRoundKey!==roundKey){
        lastScoredRoundKey=roundKey;
        const winner=d.state?.winner ?? "draw";
        applyScore(winner);
      }
      gameFinished=true;
      $("#newPartnerBtn").classList.remove("hidden");
      $("#rematchBtn").classList.add("hidden");
      startAutoRematchCountdown(d);
    }else{
      clearAutoRematch();
      gameFinished=false;
      $("#newPartnerBtn").classList.add("hidden");
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

function clearAutoRematch(){
  if(autoRematchTimer){clearTimeout(autoRematchTimer);autoRematchTimer=null}
  if(autoRematchInterval){clearInterval(autoRematchInterval);autoRematchInterval=null}
}

function startAutoRematchCountdown(roomData=null){
  if(currentGame?.id==="rps") return;
  clearAutoRematch();
  let n=3;
  setStatus(`${resultTextFromState(roomData?.state)} • Next round in ${n}…`);
  autoRematchInterval=setInterval(()=>{
    n--;
    if(n>0)setStatus(`${resultTextFromState(roomData?.state)} • Next round in ${n}…`);
  },1000);

  autoRematchTimer=setTimeout(async()=>{
    clearAutoRematch();
    if(botMode){
      botRound++;
      lastScoredRoundKey=null;
      botThinking=false;
      gameFinished=false;
      const state=initialState(currentGame.id);
      renderState(state,uid);
      setStatus("Your turn");
      return;
    }
    // Only A resets the shared room so both clients do not reset it twice.
    if(myMark==="A" && roomId){
      const snap=await get(roomRef("round"));
      const nextRound=(snap.val()||1)+1;
      await update(roomRef(),{
        state:initialState(currentGame.id),
        status:"playing",
        turn:(nextRound%2===0 ? opponent.uid : uid),
        round:nextRound
      });
    }
  },3200);
}

function resultTextFromState(state){
  const w=state?.winner;
  if(w==="draw")return "Draw";
  if(w===myMark)return "You win!";
  if(w)return "Opponent wins";
  return "Round finished";
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
function canMove(turn){ return botMode ? turn===uid : turn===uid; }
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
  const b=$("#gameBoard");
  b.className="game-board connect4-wrap";
  b.innerHTML="";
  setStatus(s.winner?(s.winner===myMark?"You win!":"Opponent wins"):canMove(turn)?"Tap a column ↓":"Opponent's turn");

  const controls=document.createElement("div");
  controls.className="c4-controls";
  for(let col=0;col<7;col++){
    const btn=document.createElement("button");
    btn.className="c4-drop";
    btn.textContent="↓";
    btn.setAttribute("aria-label",`Drop in column ${col+1}`);
    btn.onclick=()=>c4Move(s,turn,col);
    controls.appendChild(btn);
  }
  b.appendChild(controls);

  const grid=document.createElement("div");
  grid.className="board-7";
  s.cells.forEach((v,i)=>{
    const c=document.createElement("button");
    c.className="cell";
    c.textContent=v==="A"?"🔴":v==="B"?"🟡":"";
    const col=i%7;
    c.onclick=()=>c4Move(s,turn,col);
    grid.appendChild(c);
  });
  b.appendChild(grid);
}
async function c4Move(s,turn,col){
  if(s.winner||!canMove(turn))return;
  let row=-1;
  for(let r=5;r>=0;r--)if(!s.cells[r*7+col]){row=r;break}
  if(row<0)return;
  const n={...s,cells:[...s.cells]};
  n.cells[row*7+col]=myMark;
  n.winner=c4Winner(n.cells);
  await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
}
function c4Winner(c){
  for(let r=0;r<6;r++)for(let col=0;col<7;col++){
    const m=c[r*7+col];if(!m)continue;
    for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]){
      let ok=true;
      for(let k=1;k<4;k++){
        const rr=r+dr*k,cc=col+dc*k;
        if(rr<0||rr>5||cc<0||cc>6||c[rr*7+cc]!==m)ok=false;
      }
      if(ok)return m;
    }
  }
  return c.every(Boolean)?"draw":null;
}

function renderRPS(s){
  const b=$("#gameBoard");
  b.className="rps";
  b.innerHTML="";
  const a=s.score?.A||0, bb=s.score?.B||0;
  const mine=myMark==="A"?a:bb, other=myMark==="A"?bb:a;
  const msg=s.lastText?`${s.lastText} • ${mine}-${other}`:`Choose one • ${mine}-${other}`;
  setStatus(msg);
  ["✊","✋","✌️"].forEach(x=>{
    const q=document.createElement("button");
    q.textContent=x;
    q.onclick=()=>rpsMove(x);
    b.appendChild(q);
  });
}
async function rpsMove(x){
  if(botMode){
    const y=["✊","✋","✌️"][Math.floor(Math.random()*3)];
    const w=rpsWinner(x,y);
    const winner=w===0?"draw":w>0?"A":"B";
    if(winner==="A"){localScore++;$("#meScore").textContent=localScore}
    else if(winner==="B"){oppScore++;$("#oppScore").textContent=oppScore}
    recordOverallResult(winner);
    setStatus(`${x} vs ${y} — ${w===0?"Draw":w>0?"You win!":"Computer wins"} • ${localScore}-${oppScore}`);
    return;
  }

  // One choice per online round.
  const stateSnap=await get(roomRef("state"));
  const cur=stateSnap.val()||{};
  if(cur.picks?.[uid])return;
  await set(roomRef(`state/picks/${uid}`),x);

  // Resolve atomically when both players have picked.
  await runTransaction(roomRef("state"),curState=>{
    if(!curState)return curState;
    curState.picks=curState.picks||{};
    const mine=curState.picks[uid];
    const theirs=curState.picks[opponent.uid];
    if(!mine||!theirs)return curState;

    const currentRound=curState.round||1;
    if(curState.lastResolvedRound===currentRound)return curState;

    const w=rpsWinner(mine,theirs);
    const winner=w===0?"draw":w>0?myMark:(myMark==="A"?"B":"A");
    curState.score={A:0,B:0,...(curState.score||{})};
    if(winner!=="draw")curState.score[winner]=(curState.score[winner]||0)+1;
    curState.lastWinner=winner;
    curState.lastResolvedRound=currentRound;
    curState.lastText=`${mine} vs ${theirs} — ${winner==="draw"?"Draw":winner===myMark?"You win!":"Opponent wins"}`;
    curState.round=currentRound+1;
    curState.picks={};
    return curState;
  });
}
function rpsWinner(a,b){
  if(a===b)return 0;
  return (a==="✊"&&b==="✌️")||(a==="✋"&&b==="✊")||(a==="✌️"&&b==="✋")?1:-1;
}

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

function dotsCompletedBoxes(state,mark){
  const made=[];
  for(let r=0;r<3;r++)for(let c=0;c<3;c++){
    const bi=r*3+c;
    if(state.boxes[bi])continue;
    const top=state.h[r*3+c];
    const bottom=state.h[(r+1)*3+c];
    const left=state.v[r*4+c];
    const right=state.v[r*4+c+1];
    if(top&&bottom&&left&&right)made.push(bi);
  }
  made.forEach(i=>state.boxes[i]=mark);
  return made.length;
}
function dotsWinner(state){
  if(state.boxes.some(x=>!x))return null;
  const a=state.boxes.filter(x=>x==="A").length;
  const b=state.boxes.filter(x=>x==="B").length;
  return a===b?"draw":a>b?"A":"B";
}
function renderDots(s,turn){
  const b=$("#gameBoard");
  b.className="game-board dots-real";
  b.innerHTML="";
  const a=s.boxes.filter(x=>x==="A").length, bb=s.boxes.filter(x=>x==="B").length;
  setStatus(s.winner?(s.winner==="draw"?`Draw • Boxes ${a}-${bb}`:s.winner===myMark?`You win! • Boxes ${a}-${bb}`:`Opponent wins • Boxes ${a}-${bb}`):`${canMove(turn)?"Your turn":"Opponent's turn"} • Boxes ${a}-${bb}`);

  for(let gr=0;gr<7;gr++){
    for(let gc=0;gc<7;gc++){
      const el=document.createElement((gr%2===0&&gc%2===0)?"span":"button");
      if(gr%2===0&&gc%2===0){
        el.className="dot-node";
        el.textContent="•";
      }else if(gr%2===0&&gc%2===1){
        const r=gr/2, c=(gc-1)/2, idx=r*3+c;
        el.className="dot-edge h-edge"+(s.h[idx]?" claimed":"");
        el.textContent=s.h[idx]?"━":"";
        el.onclick=()=>dotsMove(s,turn,"h",idx);
      }else if(gr%2===1&&gc%2===0){
        const r=(gr-1)/2, c=gc/2, idx=r*4+c;
        el.className="dot-edge v-edge"+(s.v[idx]?" claimed":"");
        el.textContent=s.v[idx]?"┃":"";
        el.onclick=()=>dotsMove(s,turn,"v",idx);
      }else{
        const r=(gr-1)/2, c=(gc-1)/2, idx=r*3+c;
        el.className="dot-box "+(s.boxes[idx]||"");
        el.disabled=true;
        el.textContent=s.boxes[idx]==="A"?"A":s.boxes[idx]==="B"?"B":"";
      }
      b.appendChild(el);
    }
  }
}
async function dotsMove(s,turn,type,i){
  if(!canMove(turn)||s.winner)return;
  const n=JSON.parse(JSON.stringify(s));
  if(type==="h"){if(n.h[i])return;n.h[i]=myMark}
  else {if(n.v[i])return;n.v[i]=myMark}
  const made=dotsCompletedBoxes(n,myMark);
  n.winner=dotsWinner(n);
  const next=n.winner?uid:(made>0?uid:nextUid());
  await writeState(n,next,n.winner?"finished":"playing");
}


function clearCheckersPlan(){
  if(checkersPlanTimer){clearTimeout(checkersPlanTimer);checkersPlanTimer=null}
  if(checkersPlanCountdown){clearInterval(checkersPlanCountdown);checkersPlanCountdown=null}
  checkersPlan=null;
  checkersAnimating=false;
}

function simulateCheckersPath(baseState, plan){
  const n=JSON.parse(JSON.stringify(baseState));
  let from=plan.from;
  const captured=[];
  for(const to of plan.landings){
    const legal=checkersLegalMoves(n.cells,myMark,from).find(m=>m.to===to);
    if(!legal || legal.capture===null)break;
    const piece=n.cells[from];
    n.cells[to]=piece;
    n.cells[from]="";
    n.cells[legal.capture]="";
    captured.push(legal.capture);
    promoteIfNeeded(n.cells,to);
    from=to;
  }
  return {state:n, current:from, captured};
}

function plannedNextCaptureMoves(baseState){
  if(!checkersPlan || !checkersPlan.landings.length)return [];
  const sim=simulateCheckersPath(baseState,checkersPlan);
  return checkersLegalMoves(sim.state.cells,myMark,sim.current).filter(m=>m.capture!==null);
}

function startOrResetCheckersPlanTimer(baseState){
  if(checkersPlanTimer)clearTimeout(checkersPlanTimer);
  if(checkersPlanCountdown)clearInterval(checkersPlanCountdown);

  let remaining=3;
  checkersPlan.remaining=remaining;
  renderCheckers(baseState,uid);

  checkersPlanCountdown=setInterval(()=>{
    remaining--;
    if(checkersPlan)checkersPlan.remaining=Math.max(0,remaining);
    renderCheckers(baseState,uid);
    if(remaining<=0 && checkersPlanCountdown){
      clearInterval(checkersPlanCountdown);
      checkersPlanCountdown=null;
    }
  },1000);

  checkersPlanTimer=setTimeout(()=>executePlannedCheckersPath(baseState),3000);
}

async function executePlannedCheckersPath(baseState){
  if(!checkersPlan || !checkersPlan.landings.length || checkersAnimating)return;
  if(checkersPlanTimer){clearTimeout(checkersPlanTimer);checkersPlanTimer=null}
  if(checkersPlanCountdown){clearInterval(checkersPlanCountdown);checkersPlanCountdown=null}

  checkersAnimating=true;
  const plan={from:checkersPlan.from, landings:[...checkersPlan.landings]};
  let n=JSON.parse(JSON.stringify(baseState));
  let from=plan.from;

  for(const to of plan.landings){
    const legal=checkersLegalMoves(n.cells,myMark,from).find(m=>m.to===to);
    if(!legal || legal.capture===null)break;

    const piece=n.cells[from];
    n.cells[to]=piece;
    n.cells[from]="";
    n.cells[legal.capture]="";
    promoteIfNeeded(n.cells,to);
    n.selected=to;
    renderCheckers(n,uid);
    await new Promise(resolve=>setTimeout(resolve,420));
    from=to;
  }

  n.selected=null;
  const enemy=myMark==="A"?"B":"A";
  if(!n.cells.some(x=>ownerOf(x)===enemy)||checkersLegalMoves(n.cells,enemy).length===0){
    n.winner=myMark;
  }

  clearCheckersPlan();

  if(botMode){
    renderState(n,n.winner?uid:"BOT");
    if(n.winner){finishLocal(n.winner);return}
    setTimeout(()=>botMove(n),450);
  }else{
    await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
  }
}
function renderCheckers(s,turn){
  const b=$("#gameBoard");
  b.className="game-board checkers";
  b.innerHTML="";

  const myTurn=canMove(turn);
  const selected=(checkersPlan?.from ?? s.selected);
  const plannedSquares=new Map();
  if(checkersPlan?.landings){
    checkersPlan.landings.forEach((sq,idx)=>plannedSquares.set(sq,idx+1));
  }

  if(s.winner){
    setStatus(s.winner===myMark?"You win!":"Opponent wins");
  }else if(checkersAnimating){
    setStatus("Moving…");
  }else if(checkersPlan?.landings?.length){
    const more=plannedNextCaptureMoves(s).length;
    const sec=checkersPlan.remaining ?? 3;
    setStatus(more>0
      ? `Path selected • add another capture within ${sec}s`
      : `Path selected • moving in ${sec}s`);
  }else if(!myTurn){
    setStatus("Opponent's turn");
  }else{
    setStatus("Your turn");
  }

  s.cells.forEach((v,i)=>{
    const c=document.createElement("button");
    c.className="cell checker-square";
    const own=ownerOf(v);

    if(v==="AK") c.textContent="♔";
    else if(v==="BK") c.textContent="♚";
    else if(own==="A") c.textContent="⚪";
    else if(own==="B") c.textContent="⚫";
    else c.textContent="";

    if(i===selected){
      c.classList.add("selected-piece");
      c.setAttribute("aria-label","Selected checker piece");
    }

    if(plannedSquares.has(i)){
      c.classList.add("planned-square");
      c.innerHTML=`<span class="planned-step">${plannedSquares.get(i)}</span>`;
    }

    c.onclick=()=>checkersMove(s,turn,i);
    b.appendChild(c);
  });
}

function checkersLegalMoves(cells,mark,fromOnly=null){
  const enemy=mark==="A"?"B":"A", moves=[];
  for(let from=0;from<64;from++){
    const piece=cells[from];
    if(ownerOf(piece)!==mark)continue;
    if(fromOnly!==null&&from!==fromOnly)continue;
    const fr=Math.floor(from/8),fc=from%8;

    if(isKing(piece)){
      for(const [dr,dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]){
        let r=fr+dr,c=fc+dc,seenEnemy=null;
        while(r>=0&&r<8&&c>=0&&c<8){
          const idx=r*8+c, occ=cells[idx];
          if(!occ){
            moves.push({from,to:idx,capture:seenEnemy});
          }else if(ownerOf(occ)===mark){
            break;
          }else{
            if(seenEnemy!==null)break;
            seenEnemy=idx;
          }
          r+=dr;c+=dc;
        }
      }
      continue;
    }

    // Normal movement: forward one diagonal only.
    const dir=mark==="A"?-1:1;
    for(const dc of [-1,1]){
      const r=fr+dir,c=fc+dc;
      if(r>=0&&r<8&&c>=0&&c<8&&!cells[r*8+c])
        moves.push({from,to:r*8+c,capture:null});
    }

    // Captures: both forward and backward, but capture is optional.
    for(const [dr,dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]){
      const mr=fr+dr,mc=fc+dc,tr=fr+dr*2,tc=fc+dc*2;
      if(tr<0||tr>=8||tc<0||tc>=8||mr<0||mr>=8||mc<0||mc>=8)continue;
      const mid=mr*8+mc,to=tr*8+tc;
      if(ownerOf(cells[mid])===enemy&&!cells[to])moves.push({from,to,capture:mid});
    }
  }
  return moves;
}

function promoteIfNeeded(cells,index){
  const row=Math.floor(index/8);
  if(cells[index]==="A"&&row===0)cells[index]="AK";
  if(cells[index]==="B"&&row===7)cells[index]="BK";
}

async function checkersMove(s,turn,i){
  if(!canMove(turn)||s.winner||checkersAnimating)return;

  // If a multi-capture path is already being planned, only allow another
  // legal capture landing square to be appended to that path.
  if(checkersPlan?.landings?.length){
    const sim=simulateCheckersPath(s,checkersPlan);
    const nextCapture=checkersLegalMoves(sim.state.cells,myMark,sim.current)
      .find(m=>m.capture!==null && m.to===i);

    if(nextCapture){
      checkersPlan.landings.push(i);
      startOrResetCheckersPlanTimer(s);
    }
    return;
  }

  let n=JSON.parse(JSON.stringify(s));

  // Select a piece.
  if(n.selected==null){
    if(ownerOf(n.cells[i])===myMark){
      n.selected=i;
      checkersPlan={from:i,landings:[],remaining:3};
      renderCheckers(n,turn);
    }
    return;
  }

  // Change selected piece before a move has been committed.
  if(ownerOf(n.cells[i])===myMark){
    n.selected=i;
    checkersPlan={from:i,landings:[],remaining:3};
    renderCheckers(n,turn);
    return;
  }

  const from=n.selected;
  const legal=checkersLegalMoves(n.cells,myMark,from).find(m=>m.to===i);
  if(!legal){
    renderCheckers(n,turn);
    return;
  }

  // Normal move: one destination only and execute immediately.
  if(legal.capture===null){
    const piece=n.cells[from];
    n.cells[i]=piece;
    n.cells[from]="";
    promoteIfNeeded(n.cells,i);
    n.selected=null;
    clearCheckersPlan();

    const enemy=myMark==="A"?"B":"A";
    if(!n.cells.some(x=>ownerOf(x)===enemy)||checkersLegalMoves(n.cells,enemy).length===0){
      n.winner=myMark;
    }
    await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
    return;
  }

  // Capture move: mark the first landing square, wait 3 seconds, and allow
  // more capture landing squares to be appended if the route continues.
  checkersPlan={from,landings:[i],remaining:3};
  startOrResetCheckersPlanTimer(s);
}

function botMove(state){
  if(!botMode||gameFinished||botThinking)return;
  botThinking=true;
  const done=()=>{botThinking=false};

  if(currentGame.id==="ttt"){
    const ids=state.cells.map((x,i)=>!x?i:-1).filter(i=>i>=0);
    if(!ids.length){done();return}
    const n=JSON.parse(JSON.stringify(state));
    const i=ids[Math.floor(Math.random()*ids.length)];
    n.cells[i]="B";n.winner=tttWinner(n.cells);
    renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }

  if(currentGame.id==="connect4"){
    const cols=[0,1,2,3,4,5,6].filter(c=>!state.cells[c]);
    if(!cols.length){done();return}
    const n=JSON.parse(JSON.stringify(state));
    const col=cols[Math.floor(Math.random()*cols.length)];
    for(let r=5;r>=0;r--)if(!n.cells[r*7+col]){n.cells[r*7+col]="B";break}
    n.winner=c4Winner(n.cells);
    renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }

  if(currentGame.id==="memory"){
    const n=JSON.parse(JSON.stringify(state));
    n.scores={A:0,B:0,...(n.scores||{})};n.open=[];
    const available=n.cards.map((_,i)=>!n.matched.includes(i)?i:-1).filter(i=>i>=0);
    if(available.length<2){done();return}
    // Computer sometimes remembers a visible pair, otherwise random.
    let first=available[Math.floor(Math.random()*available.length)];
    let second=null;
    for(let a=0;a<available.length&&second===null;a++)
      for(let b=a+1;b<available.length;b++)
        if(n.cards[available[a]]===n.cards[available[b]]&&Math.random()<0.45){first=available[a];second=available[b];break}
    if(second===null){
      const rest=available.filter(i=>i!==first);
      second=rest[Math.floor(Math.random()*rest.length)];
    }
    n.open=[first];renderState(n,"BOT");
    setTimeout(()=>{
      n.open=[first,second];renderState(n,"BOT");
      setTimeout(()=>{
        if(n.cards[first]===n.cards[second]){
          n.matched.push(first,second);n.scores.B=(n.scores.B||0)+1;n.open=[];
          if(n.matched.length===n.cards.length){
            n.winner=n.scores.A===n.scores.B?"draw":n.scores.A>n.scores.B?"A":"B";
            renderState(n,uid);done();finishLocal(n.winner);
          }else{
            renderState(n,"BOT");done();setTimeout(()=>botMove(n),500);
          }
        }else{
          n.open=[];renderState(n,uid);done();
        }
      },650);
    },450);
    return;
  }

  if(currentGame.id==="dots"){
    const n=JSON.parse(JSON.stringify(state));
    const choices=[];
    n.h.forEach((v,i)=>{if(!v)choices.push({type:"h",i})});
    n.v.forEach((v,i)=>{if(!v)choices.push({type:"v",i})});
    if(!choices.length){done();return}

    // Prefer an edge that completes a box.
    let best=[];
    for(const ch of choices){
      const t=JSON.parse(JSON.stringify(n));
      t[ch.type][ch.i]="B";
      const before=t.boxes.filter(Boolean).length;
      dotsCompletedBoxes(t,"B");
      const gained=t.boxes.filter(Boolean).length-before;
      if(gained>0)best.push(ch);
    }
    const ch=(best.length?best:choices)[Math.floor(Math.random()*(best.length?best.length:choices.length))];
    n[ch.type][ch.i]="B";
    const made=dotsCompletedBoxes(n,"B");
    n.winner=dotsWinner(n);
    renderState(n,n.winner?uid:(made>0?"BOT":uid));
    done();
    if(n.winner){finishLocal(n.winner);return}
    if(made>0)setTimeout(()=>botMove(n),450);
    return;
  }

  if(currentGame.id==="checkers"){
    const n=JSON.parse(JSON.stringify(state));
    const moves=checkersLegalMoves(n.cells,"B");
    if(!moves.length){
      n.winner="A";
      renderState(n,uid);
      done();
      finishLocal("A");
      return;
    }

    const captures=moves.filter(m=>m.capture!==null);
    const pool=captures.length?captures:moves;
    const m=pool[Math.floor(Math.random()*pool.length)];

    const piece=n.cells[m.from];
    n.cells[m.to]=piece;
    n.cells[m.from]="";
    if(m.capture!==null)n.cells[m.capture]="";
    promoteIfNeeded(n.cells,m.to);
    n.selected=null;

    if(!n.cells.some(x=>ownerOf(x)==="A")||checkersLegalMoves(n.cells,"A").length===0){
      n.winner="B";
      renderState(n,uid);
      done();
      finishLocal("B");
      return;
    }

    // Optional chained capture for the computer too.
    if(m.capture!==null){
      const more=checkersLegalMoves(n.cells,"B",m.to).filter(x=>x.capture!==null);
      if(more.length && Math.random()<0.7){
        const m2=more[Math.floor(Math.random()*more.length)];
        n.cells[m2.to]=n.cells[m2.from];
        n.cells[m2.from]="";
        n.cells[m2.capture]="";
        promoteIfNeeded(n.cells,m2.to);

        // It may continue again a limited number of times.
        let from=m2.to;
        for(let hops=0;hops<3;hops++){
          const again=checkersLegalMoves(n.cells,"B",from).filter(x=>x.capture!==null);
          if(!again.length || Math.random()>=0.7)break;
          const nx=again[Math.floor(Math.random()*again.length)];
          n.cells[nx.to]=n.cells[nx.from];
          n.cells[nx.from]="";
          n.cells[nx.capture]="";
          promoteIfNeeded(n.cells,nx.to);
          from=nx.to;
        }
      }
    }

    if(!n.cells.some(x=>ownerOf(x)==="A")||checkersLegalMoves(n.cells,"A").length===0)n.winner="B";
    renderState(n,uid);
    done();
    if(n.winner)finishLocal(n.winner);
    return;
  }
  done();
}

function finishLocal(winner){
  if(gameFinished)return;
  const roundKey=`${roomId}:${botRound}`;
  if(lastScoredRoundKey!==roundKey){
    lastScoredRoundKey=roundKey;
    applyScore(winner);
  }
  gameFinished=true;
  $("#newPartnerBtn").classList.remove("hidden");
  $("#rematchBtn").classList.add("hidden");
  startAutoRematchCountdown({state:{winner}});
}

$("#leaveBtn").onclick=leaveRoom;
async function leaveRoom(){
  clearAutoRematch();
  clearCheckersPlan();
  stopVoice(); if(roomUnsub){roomUnsub();roomUnsub=null;}
  if(!botMode&&roomId) await update(roomRef(),{status:"finished"}).catch(()=>{});
  roomId=null; opponent=null; botMode=false; botThinking=false; lastRpsScoredRound=0; clearCheckersPlan(); $("#rematchBtn").classList.add("hidden");$("#newPartnerBtn").classList.add("hidden");show("lobbyView");
}
$("#newPartnerBtn").onclick=async()=>{await leaveRoom();startMatch(currentGame)};
$("#rematchBtn").onclick=async()=>{
  clearAutoRematch();
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
