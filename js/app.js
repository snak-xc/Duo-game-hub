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
  {id:"rps",name:"Rock Paper Scissors",emoji:"✊",desc:"Quick continuous rounds"},
  {id:"memory",name:"Memory Match",emoji:"🧠",desc:"Find matching pairs"},
  {id:"dots",name:"Dots & Boxes",emoji:"🔷",desc:"Complete more boxes"},
  {id:"checkers",name:"Checkers Lite",emoji:"⚫",desc:"Capture & path play"},
  {id:"reversi",name:"Reversi / Othello",emoji:"⚪",desc:"Flip opponent discs"},
  {id:"gomoku",name:"Gomoku",emoji:"⚫",desc:"Five in a Row"},
  {id:"battle2048",name:"2048 Battle",emoji:"🔢",desc:"Build the higher score"},
  {id:"hangman",name:"Hangman Duel",emoji:"🔤",desc:"Guess the hidden word"},
  {id:"quiz",name:"Quiz Battle",emoji:"❓",desc:"First to 5 points"},
  {id:"math",name:"Math Duel",emoji:"➗",desc:"Fast calculations"},
  {id:"numberguess",name:"Number Guess Duel",emoji:"🎯",desc:"Find the secret number"},
  {id:"snake",name:"Snake Duel",emoji:"🐍",desc:"Collect food and survive"},
  {id:"pong",name:"Pong",emoji:"🏓",desc:"Return the ball"},
  {id:"airhockey",name:"Air Hockey Lite",emoji:"🥅",desc:"Shoot past the keeper"},
  {id:"snakesladders",name:"Snakes & Ladders",emoji:"🎲",desc:"Race to square 100"},
  {id:"penalty",name:"Penalty Shootout",emoji:"⚽",desc:"Score more penalties"},
  {id:"reaction",name:"Reaction Tap Battle",emoji:"⚡",desc:"Tap fastest after GO"},
  {id:"puzzle",name:"Puzzle Race",emoji:"🧩",desc:"Solve the sliding puzzle"}
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
  if(game==="reversi"){
    const cells=Array(64).fill("");
    cells[27]="A";cells[28]="B";cells[35]="B";cells[36]="A";
    return {cells,winner:null};
  }
  if(game==="gomoku") return {cells:Array(225).fill(""),winner:null};
  if(game==="battle2048") return {boards:{A:spawn2048(spawn2048(Array(16).fill(0))),B:spawn2048(spawn2048(Array(16).fill(0)))},scores:{A:0,B:0},moves:{A:0,B:0},winner:null};
  if(game==="hangman"){
    const words=["FIREBASE","ANDROID","GAMING","PLAYER","ROCKET","PUZZLE","PLANET","JUNGLE","CAMERA","BANANA"];
    return {word:words[Math.floor(Math.random()*words.length)],guessed:[],wrong:{A:0,B:0},winner:null};
  }
  if(game==="quiz") return {index:0,scores:{A:0,B:0},winner:null};
  if(game==="math") return makeMathState();
  if(game==="numberguess") return {target:Math.floor(Math.random()*100)+1,lastGuess:null,hint:"1 - 100",winner:null};
  if(game==="snake") return {heads:{A:55,B:65},food:60,scores:{A:0,B:0},turns:0,winner:null};
  if(game==="pong") return {ball:1,rally:0,scores:{A:0,B:0},winner:null};
  if(game==="airhockey") return {scores:{A:0,B:0},round:1,last:"",winner:null};
  if(game==="snakesladders") return {pos:{A:1,B:1},lastRoll:null,winner:null};
  if(game==="penalty") return {round:1,shots:{},scores:{A:0,B:0},winner:null,last:""};
  if(game==="reaction") return {round:1,readyAt:Date.now()+1200+Math.floor(Math.random()*2200),taps:{},scores:{A:0,B:0},winner:null,last:""};
  if(game==="puzzle"){
    const p=shufflePuzzle();
    return {boards:{A:p,B:[...p]},moves:{A:0,B:0},winner:null};
  }
}

function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a}
function spawn2048(board){
  const empty=board.map((v,i)=>v?null:i).filter(v=>v!==null);
  if(!empty.length)return board;
  const n=[...board];
  const idx=empty[Math.floor(Math.random()*empty.length)];
  n[idx]=Math.random()<0.9?2:4;
  return n;
}
function slide2048(board,dir){
  const n=[...board]; let gained=0;
  const lines=[];
  if(dir==="left"||dir==="right"){
    for(let r=0;r<4;r++)lines.push([0,1,2,3].map(c=>r*4+c));
  }else{
    for(let c=0;c<4;c++)lines.push([0,1,2,3].map(r=>r*4+c));
  }
  if(dir==="right"||dir==="down")lines.forEach(x=>x.reverse());
  let changed=false;
  for(const line of lines){
    const vals=line.map(i=>n[i]).filter(Boolean);
    const merged=[];
    for(let i=0;i<vals.length;i++){
      if(vals[i]===vals[i+1]){merged.push(vals[i]*2);gained+=vals[i]*2;i++}
      else merged.push(vals[i]);
    }
    while(merged.length<4)merged.push(0);
    line.forEach((idx,j)=>{if(n[idx]!==merged[j])changed=true;n[idx]=merged[j]});
  }
  return {board:changed?spawn2048(n):n,gained,changed};
}
function makeMathState(){
  const a=Math.floor(Math.random()*20)+1,b=Math.floor(Math.random()*20)+1;
  const op=Math.random()<.5?"+":"×";
  return {a,b,op,answer:op==="+"?a+b:a*b,scores:{A:0,B:0},round:1,winner:null};
}
function shufflePuzzle(){
  let a=[1,2,3,4,5,6,7,8,0];
  for(let k=0;k<60;k++){
    const z=a.indexOf(0),r=Math.floor(z/3),c=z%3,m=[];
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{const rr=r+dr,cc=c+dc;if(rr>=0&&rr<3&&cc>=0&&cc<3)m.push(rr*3+cc)});
    const j=m[Math.floor(Math.random()*m.length)];[a[z],a[j]]=[a[j],a[z]];
  }
  return a;
}
function isPuzzleSolved(a){return a.join(",")==="1,2,3,4,5,6,7,8,0"}
const QUIZ_BANK=[
  {q:"Which planet is known as the Red Planet?",a:["Earth","Mars","Venus","Jupiter"],ok:1},
  {q:"How many days are in a leap year?",a:["365","366","364","360"],ok:1},
  {q:"Which is the largest ocean?",a:["Atlantic","Indian","Pacific","Arctic"],ok:2},
  {q:"What is H₂O?",a:["Salt","Water","Oxygen","Hydrogen"],ok:1},
  {q:"How many sides does a hexagon have?",a:["5","6","7","8"],ok:1},
  {q:"Which animal is known for black and white stripes?",a:["Tiger","Zebra","Panda","Horse"],ok:1},
  {q:"What is 12 × 12?",a:["124","132","144","154"],ok:2},
  {q:"Which device measures temperature?",a:["Barometer","Thermometer","Speedometer","Compass"],ok:1}
];

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
  if(currentGame.id==="reversi") renderReversi(state,turn);
  if(currentGame.id==="gomoku") renderGomoku(state,turn);
  if(currentGame.id==="battle2048") render2048(state,turn);
  if(currentGame.id==="hangman") renderHangman(state,turn);
  if(currentGame.id==="quiz") renderQuiz(state,turn);
  if(currentGame.id==="math") renderMath(state,turn);
  if(currentGame.id==="numberguess") renderNumberGuess(state,turn);
  if(currentGame.id==="snake") renderSnake(state,turn);
  if(currentGame.id==="pong") renderPong(state,turn);
  if(currentGame.id==="airhockey") renderAirHockey(state,turn);
  if(currentGame.id==="snakesladders") renderSnakesLadders(state,turn);
  if(currentGame.id==="penalty") renderPenalty(state,turn);
  if(currentGame.id==="reaction") renderReaction(state,turn);
  if(currentGame.id==="puzzle") renderPuzzle(state,turn);
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
  const b=$("#gameBoard");b.className="game-board board-7";b.innerHTML="";
  setStatus(s.winner?(s.winner===myMark?"You win!":"Opponent wins"):canMove(turn)?"Your turn":"Opponent's turn");
  s.cells.forEach((v,i)=>{const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"🔴":v==="B"?"🟡":"";c.onclick=()=>c4Move(s,turn,i%7);b.appendChild(c)});
}
async function c4Move(s,turn,col){if(s.winner||!canMove(turn))return;let row=-1;for(let r=5;r>=0;r--)if(!s.cells[r*7+col]){row=r;break}if(row<0)return;const n={...s,cells:[...s.cells]};n.cells[row*7+col]=myMark;n.winner=c4Winner(n.cells);await writeState(n,nextUid(),n.winner?"finished":"playing")}
function c4Winner(c){for(let r=0;r<6;r++)for(let col=0;col<7;col++){const m=c[r*7+col];if(!m)continue;for(const [dr,dc] of [[0,1],[1,0],[1,1],[1,-1]]){let ok=true;for(let k=1;k<4;k++){const rr=r+dr*k,cc=col+dc*k;if(rr<0||rr>5||cc<0||cc>6||c[rr*7+cc]!==m)ok=false}if(ok)return m}}return null}

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

// ---------- Reversi / Othello ----------
function reversiFlips(cells,idx,mark){
  if(cells[idx])return [];
  const enemy=mark==="A"?"B":"A",r=Math.floor(idx/8),c=idx%8,out=[];
  for(const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
    let rr=r+dr,cc=c+dc,tmp=[];
    while(rr>=0&&rr<8&&cc>=0&&cc<8&&cells[rr*8+cc]===enemy){tmp.push(rr*8+cc);rr+=dr;cc+=dc}
    if(tmp.length&&rr>=0&&rr<8&&cc>=0&&cc<8&&cells[rr*8+cc]===mark)out.push(...tmp);
  }
  return out;
}
function reversiMoves(cells,mark){return cells.map((_,i)=>reversiFlips(cells,i,mark).length?i:-1).filter(i=>i>=0)}
function reversiWinner(c){const a=c.filter(x=>x==="A").length,b=c.filter(x=>x==="B").length;return a===b?"draw":a>b?"A":"B"}
function renderReversi(st,turn){
  const b=$("#gameBoard");b.className="game-board reversi-board";b.innerHTML="";
  const a=st.cells.filter(x=>x==="A").length,bb=st.cells.filter(x=>x==="B").length;
  setStatus(st.winner?`${st.winner==="draw"?"Draw":st.winner===myMark?"You win!":"Opponent wins"} • ${a}-${bb}`:`${canMove(turn)?"Your turn":"Opponent's turn"} • ${a}-${bb}`);
  st.cells.forEach((v,i)=>{const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"⚪":v==="B"?"⚫":"";c.onclick=()=>reversiMove(st,turn,i);b.appendChild(c)});
}
async function reversiMove(st,turn,i){
  if(st.winner||!canMove(turn))return;const flips=reversiFlips(st.cells,i,myMark);if(!flips.length)return;
  const n=JSON.parse(JSON.stringify(st));n.cells[i]=myMark;flips.forEach(x=>n.cells[x]=myMark);
  const enemy=myMark==="A"?"B":"A";
  let next=nextUid();
  if(!reversiMoves(n.cells,enemy).length){
    if(!reversiMoves(n.cells,myMark).length)n.winner=reversiWinner(n.cells);else next=uid;
  }
  await writeState(n,next,n.winner?"finished":"playing");
}

// ---------- Gomoku ----------
function gomokuWinner(c){
  for(let r=0;r<15;r++)for(let col=0;col<15;col++){const m=c[r*15+col];if(!m)continue;for(const[dr,dc]of[[0,1],[1,0],[1,1],[1,-1]]){let ok=true;for(let k=1;k<5;k++){const rr=r+dr*k,cc=col+dc*k;if(rr<0||rr>=15||cc<0||cc>=15||c[rr*15+cc]!==m){ok=false;break}}if(ok)return m}}
  return c.every(Boolean)?"draw":null;
}
function renderGomoku(st,turn){const b=$("#gameBoard");b.className="game-board gomoku-board";b.innerHTML="";setStatus(st.winner?(st.winner==="draw"?"Draw":st.winner===myMark?"You win!":"Opponent wins"):canMove(turn)?"Your turn":"Opponent's turn");st.cells.forEach((v,i)=>{const c=document.createElement("button");c.className="cell";c.textContent=v==="A"?"●":v==="B"?"○":"";c.onclick=()=>gomokuMove(st,turn,i);b.appendChild(c)})}
async function gomokuMove(st,turn,i){if(!canMove(turn)||st.winner||st.cells[i])return;const n={...st,cells:[...st.cells]};n.cells[i]=myMark;n.winner=gomokuWinner(n.cells);await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- 2048 Battle ----------
function render2048(st,turn){
  const b=$("#gameBoard");b.className="game-board";b.innerHTML="";
  const board=st.boards?.[myMark]||Array(16).fill(0),score=st.scores?.[myMark]||0,os=st.scores?.[myMark==="A"?"B":"A"]||0;
  setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`Your ${score} • Opponent ${os}`);
  const g=document.createElement("div");g.className="g2048";board.forEach(v=>{const x=document.createElement("div");x.className="g2048-cell";x.textContent=v||"";g.appendChild(x)});b.appendChild(g);
  const ctl=document.createElement("div");ctl.className="dir-pad";["up","left","down","right"].forEach(d=>{const q=document.createElement("button");q.textContent={up:"↑",down:"↓",left:"←",right:"→"}[d];q.onclick=()=>move2048(st,d);ctl.appendChild(q)});b.appendChild(ctl);
}
async function move2048(st,dir){
  if(st.winner)return;const n=JSON.parse(JSON.stringify(st));const res=slide2048(n.boards[myMark],dir);if(!res.changed)return;
  n.boards[myMark]=res.board;n.scores[myMark]=(n.scores[myMark]||0)+res.gained;n.moves[myMark]=(n.moves[myMark]||0)+1;
  if((n.moves.A||0)>=25&&(n.moves.B||0)>=25){n.winner=n.scores.A===n.scores.B?"draw":n.scores.A>n.scores.B?"A":"B"}
  if(botMode){renderState(n,uid);setTimeout(()=>botMove(n),300)}else await writeState(n,nextUid(),n.winner?"finished":"playing");
}

// ---------- Hangman Duel ----------
function renderHangman(st,turn){
  const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";
  const word=st.word.split("").map(ch=>st.guessed.includes(ch)?ch:"_").join(" ");
  const h=document.createElement("div");h.className="word-display";h.textContent=word;b.appendChild(h);
  setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Your turn":"Opponent's turn"} • Misses ${st.wrong?.[myMark]||0}/6`);
  const keys=document.createElement("div");keys.className="letter-grid";
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(ch=>{const q=document.createElement("button");q.textContent=ch;q.disabled=st.guessed.includes(ch)||!canMove(turn);q.onclick=()=>hangmanGuess(st,turn,ch);keys.appendChild(q)});b.appendChild(keys);
}
async function hangmanGuess(st,turn,ch){
  if(!canMove(turn)||st.winner||st.guessed.includes(ch))return;const n=JSON.parse(JSON.stringify(st));n.guessed.push(ch);
  if(!n.word.includes(ch))n.wrong[myMark]=(n.wrong[myMark]||0)+1;
  if(n.word.split("").every(x=>n.guessed.includes(x)))n.winner=myMark;
  else if(n.wrong[myMark]>=6)n.winner=myMark==="A"?"B":"A";
  await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
}

// ---------- Quiz Battle ----------
function renderQuiz(st,turn){
  const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const q=QUIZ_BANK[st.index%QUIZ_BANK.length];
  const title=document.createElement("div");title.className="question";title.textContent=q.q;b.appendChild(title);
  setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Your turn":"Opponent's turn"} • ${st.scores.A}-${st.scores.B}`);
  q.a.forEach((a,i)=>{const x=document.createElement("button");x.className="answer-btn";x.textContent=a;x.onclick=()=>quizAnswer(st,turn,i);b.appendChild(x)});
}
async function quizAnswer(st,turn,i){
  if(!canMove(turn)||st.winner)return;const n=JSON.parse(JSON.stringify(st)),q=QUIZ_BANK[n.index%QUIZ_BANK.length];
  if(i===q.ok)n.scores[myMark]=(n.scores[myMark]||0)+1;
  n.index++;if(n.scores[myMark]>=5)n.winner=myMark;await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
}

// ---------- Math Duel ----------
function renderMath(st,turn){
  const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const q=document.createElement("div");q.className="question";q.textContent=`${st.a} ${st.op} ${st.b} = ?`;b.appendChild(q);
  const inp=document.createElement("input");inp.type="number";inp.placeholder="Answer";inp.className="game-input";b.appendChild(inp);
  const btn=document.createElement("button");btn.textContent="Submit";btn.className="primary mini";btn.onclick=()=>mathAnswer(st,turn,Number(inp.value));b.appendChild(btn);
  setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Your turn":"Opponent's turn"} • ${st.scores.A}-${st.scores.B}`);
}
async function mathAnswer(st,turn,val){
  if(!canMove(turn)||st.winner||!Number.isFinite(val))return;let n=JSON.parse(JSON.stringify(st));if(val===n.answer)n.scores[myMark]=(n.scores[myMark]||0)+1;
  const ns=makeMathState();ns.scores=n.scores;ns.round=(n.round||1)+1;if(ns.scores[myMark]>=5)ns.winner=myMark;await writeState(ns,ns.winner?uid:nextUid(),ns.winner?"finished":"playing");
}

// ---------- Number Guess Duel ----------
function renderNumberGuess(st,turn){
  const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const x=document.createElement("input");x.type="number";x.min="1";x.max="100";x.placeholder="1 - 100";x.className="game-input";b.appendChild(x);
  const q=document.createElement("button");q.className="primary mini";q.textContent="Guess";q.onclick=()=>numberGuess(st,turn,Number(x.value));b.appendChild(q);
  setStatus(st.winner?(st.winner===myMark?"You found it!":"Opponent found it"):`${canMove(turn)?"Your turn":"Opponent's turn"} • ${st.hint||"1 - 100"}`);
}
async function numberGuess(st,turn,v){if(!canMove(turn)||st.winner||v<1||v>100)return;const n=JSON.parse(JSON.stringify(st));n.lastGuess=v;if(v===n.target)n.winner=myMark;else n.hint=v<n.target?`Higher than ${v}`:`Lower than ${v}`;await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- Snake Duel (turn-step web version) ----------
function renderSnake(st,turn){
  const b=$("#gameBoard");b.className="game-board";b.innerHTML="";const g=document.createElement("div");g.className="snake-grid";
  for(let i=0;i<100;i++){const c=document.createElement("div");c.className="snake-cell";if(i===st.food)c.textContent="🍎";if(i===st.heads.A)c.textContent="🐍";if(i===st.heads.B)c.textContent="🟣";g.appendChild(c)}b.appendChild(g);
  const ctl=document.createElement("div");ctl.className="dir-pad";["up","left","down","right"].forEach(d=>{const q=document.createElement("button");q.textContent={up:"↑",left:"←",down:"↓",right:"→"}[d];q.onclick=()=>snakeMove(st,turn,d);ctl.appendChild(q)});b.appendChild(ctl);
  setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Your move":"Opponent's move"} • ${st.scores.A}-${st.scores.B}`);
}
async function snakeMove(st,turn,d){
  if(!canMove(turn)||st.winner)return;const n=JSON.parse(JSON.stringify(st));let p=n.heads[myMark],r=Math.floor(p/10),c=p%10;if(d==="up")r=(r+9)%10;if(d==="down")r=(r+1)%10;if(d==="left")c=(c+9)%10;if(d==="right")c=(c+1)%10;p=r*10+c;n.heads[myMark]=p;n.turns++;
  if(p===n.food){n.scores[myMark]++;n.food=Math.floor(Math.random()*100)}if(n.heads.A===n.heads.B)n.winner=myMark;if(n.scores[myMark]>=5)n.winner=myMark;
  await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing");
}

// ---------- Pong ----------
function renderPong(st,turn){const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const ball=document.createElement("div");ball.className="pong-ball";ball.textContent=["⬅️","⏺️","➡️"][st.ball||1];b.appendChild(ball);["Left","Center","Right"].forEach((x,i)=>{const q=document.createElement("button");q.className="answer-btn";q.textContent=x;q.onclick=()=>pongHit(st,turn,i);b.appendChild(q)});setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Return the ball":"Opponent's turn"} • ${st.scores.A}-${st.scores.B}`)}
async function pongHit(st,turn,zone){if(!canMove(turn)||st.winner)return;const n=JSON.parse(JSON.stringify(st));if(zone===n.ball){n.rally++;n.ball=Math.floor(Math.random()*3)}else{const enemy=myMark==="A"?"B":"A";n.scores[enemy]++;n.rally=0;n.ball=Math.floor(Math.random()*3);if(n.scores[enemy]>=5)n.winner=enemy}await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- Air Hockey ----------
function renderAirHockey(st,turn){const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";["Left","Center","Right"].forEach((x,i)=>{const q=document.createElement("button");q.className="answer-btn";q.textContent=`Shoot ${x}`;q.onclick=()=>airShot(st,turn,i);b.appendChild(q)});setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Your shot":"Opponent's shot"} • ${st.scores.A}-${st.scores.B} ${st.last||""}`)}
async function airShot(st,turn,lane){if(!canMove(turn)||st.winner)return;const n=JSON.parse(JSON.stringify(st));const keeper=Math.floor(Math.random()*3);if(lane!==keeper){n.scores[myMark]++;n.last="GOAL!"}else n.last="Saved";n.round++;if(n.scores[myMark]>=5)n.winner=myMark;await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- Snakes & Ladders ----------
const SNL={4:14,9:31,20:38,28:84,40:59,51:67,63:81,17:7,54:34,62:19,64:60,87:24,93:73,95:75,99:78};
function renderSnakesLadders(st,turn){const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const p=document.createElement("div");p.className="board-status";p.textContent=`You: ${st.pos[myMark]} • Opponent: ${st.pos[myMark==="A"?"B":"A"]}`;b.appendChild(p);const q=document.createElement("button");q.className="primary mini";q.textContent="🎲 Roll Dice";q.onclick=()=>rollSNL(st,turn);b.appendChild(q);setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):canMove(turn)?"Your roll":"Opponent's roll")}
async function rollSNL(st,turn){if(!canMove(turn)||st.winner)return;const n=JSON.parse(JSON.stringify(st));const roll=Math.floor(Math.random()*6)+1;let p=n.pos[myMark]+roll;if(p>100)p=n.pos[myMark];if(SNL[p])p=SNL[p];n.pos[myMark]=p;n.lastRoll=roll;if(p===100)n.winner=myMark;await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- Penalty Shootout ----------
function renderPenalty(st,turn){const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";["Left","Center","Right"].forEach((x,i)=>{const q=document.createElement("button");q.className="answer-btn";q.textContent=`⚽ ${x}`;q.onclick=()=>penaltyKick(st,turn,i);b.appendChild(q)});setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${canMove(turn)?"Take the shot":"Opponent's shot"} • ${st.scores.A}-${st.scores.B} ${st.last||""}`)}
async function penaltyKick(st,turn,lane){if(!canMove(turn)||st.winner)return;const n=JSON.parse(JSON.stringify(st));const keeper=Math.floor(Math.random()*3);if(lane!==keeper){n.scores[myMark]++;n.last="GOAL!"}else n.last="Saved";n.round++;if(n.round>10||n.scores[myMark]>=5)n.winner=n.scores.A===n.scores.B?null:(n.scores.A>n.scores.B?"A":"B");await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- Reaction Tap ----------
function renderReaction(st,turn){const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const q=document.createElement("button");q.className="reaction-btn";const ready=Date.now()>=st.readyAt;q.textContent=ready?"TAP!":"WAIT…";q.disabled=!canMove(turn);q.onclick=()=>reactionTap(st,turn);b.appendChild(q);setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`${st.scores.A}-${st.scores.B}`);if(!ready)setTimeout(()=>renderState(st,turn),Math.max(50,st.readyAt-Date.now()+20))}
async function reactionTap(st,turn){if(!canMove(turn)||st.winner)return;let n=JSON.parse(JSON.stringify(st));if(Date.now()<n.readyAt){n.scores[myMark==="A"?"B":"A"]++;n.last="Too early"}else{n.scores[myMark]++;n.last="Point"}if(n.scores.A>=5||n.scores.B>=5)n.winner=n.scores.A>n.scores.B?"A":"B";n.round++;n.readyAt=Date.now()+1200+Math.floor(Math.random()*2200);await writeState(n,n.winner?uid:nextUid(),n.winner?"finished":"playing")}

// ---------- Puzzle Race ----------
function renderPuzzle(st,turn){const b=$("#gameBoard");b.className="game-board text-game";b.innerHTML="";const board=st.boards[myMark];const g=document.createElement("div");g.className="puzzle-grid";board.forEach((v,i)=>{const q=document.createElement("button");q.className="puzzle-cell";q.textContent=v||"";q.onclick=()=>puzzleMove(st,i);g.appendChild(q)});b.appendChild(g);setStatus(st.winner?(st.winner===myMark?"You win!":"Opponent wins"):`Moves: ${st.moves[myMark]||0}`)}
async function puzzleMove(st,i){if(st.winner)return;const n=JSON.parse(JSON.stringify(st)),a=n.boards[myMark],z=a.indexOf(0),r=Math.floor(i/3),c=i%3,zr=Math.floor(z/3),zc=z%3;if(Math.abs(r-zr)+Math.abs(c-zc)!==1)return;[a[i],a[z]]=[a[z],a[i]];n.moves[myMark]=(n.moves[myMark]||0)+1;if(isPuzzleSolved(a))n.winner=myMark;if(botMode){renderState(n,uid);setTimeout(()=>botMove(n),350)}else await set(roomRef("state"),n)}

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
    // Fair computer: usually chooses two random hidden cards.
    // Only occasionally (15%) makes a "smart" matching choice.
    let first=available[Math.floor(Math.random()*available.length)];
    let second=null;

    if(Math.random()<0.15){
      const pairs=[];
      for(let a=0;a<available.length;a++){
        for(let b=a+1;b<available.length;b++){
          if(n.cards[available[a]]===n.cards[available[b]]){
            pairs.push([available[a],available[b]]);
          }
        }
      }
      if(pairs.length){
        const pair=pairs[Math.floor(Math.random()*pairs.length)];
        first=pair[0];
        second=pair[1];
      }
    }

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
  if(currentGame.id==="reversi"){
    const n=JSON.parse(JSON.stringify(state)),moves=reversiMoves(n.cells,"B");
    if(!moves.length){if(!reversiMoves(n.cells,"A").length){n.winner=reversiWinner(n.cells);renderState(n,uid);done();finishLocal(n.winner);return}renderState(n,uid);done();return}
    const i=moves[Math.floor(Math.random()*moves.length)],flips=reversiFlips(n.cells,i,"B");n.cells[i]="B";flips.forEach(x=>n.cells[x]="B");
    if(!reversiMoves(n.cells,"A").length&&!reversiMoves(n.cells,"B").length)n.winner=reversiWinner(n.cells);renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="gomoku"){
    const n=JSON.parse(JSON.stringify(state)),ids=n.cells.map((x,i)=>!x?i:-1).filter(i=>i>=0);if(!ids.length){done();return}let pool=ids.filter(i=>{const r=Math.floor(i/15),c=i%15;return n.cells.some((x,j)=>x&&Math.abs(Math.floor(j/15)-r)<=2&&Math.abs(j%15-c)<=2)});if(!pool.length)pool=ids;const i=pool[Math.floor(Math.random()*pool.length)];n.cells[i]="B";n.winner=gomokuWinner(n.cells);renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="battle2048"){
    const n=JSON.parse(JSON.stringify(state));const dirs=shuffle(["up","down","left","right"]);let moved=false;for(const d of dirs){const r=slide2048(n.boards.B,d);if(r.changed){n.boards.B=r.board;n.scores.B+=r.gained;n.moves.B++;moved=true;break}}if((n.moves.A||0)>=25&&(n.moves.B||0)>=25)n.winner=n.scores.A===n.scores.B?"draw":n.scores.A>n.scores.B?"A":"B";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="hangman"){
    const n=JSON.parse(JSON.stringify(state));const letters="ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter(x=>!n.guessed.includes(x));if(!letters.length){done();return}const ch=letters[Math.floor(Math.random()*letters.length)];n.guessed.push(ch);if(!n.word.includes(ch))n.wrong.B=(n.wrong.B||0)+1;if(n.word.split("").every(x=>n.guessed.includes(x)))n.winner="B";else if(n.wrong.B>=6)n.winner="A";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="quiz"){
    const n=JSON.parse(JSON.stringify(state)),q=QUIZ_BANK[n.index%QUIZ_BANK.length];if(Math.random()<0.65)n.scores.B++;n.index++;if(n.scores.B>=5)n.winner="B";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="math"){
    const n=JSON.parse(JSON.stringify(state));if(Math.random()<0.7)n.scores.B++;const ns=makeMathState();ns.scores=n.scores;ns.round=(n.round||1)+1;if(ns.scores.B>=5)ns.winner="B";renderState(ns,uid);done();if(ns.winner)finishLocal(ns.winner);return;
  }
  if(currentGame.id==="numberguess"){
    const n=JSON.parse(JSON.stringify(state));const guess=Math.floor(Math.random()*100)+1;if(guess===n.target)n.winner="B";else n.hint=guess<n.target?`Higher than ${guess}`:`Lower than ${guess}`;renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="snake"){
    const n=JSON.parse(JSON.stringify(state)),dirs=["up","down","left","right"],d=dirs[Math.floor(Math.random()*4)];let p=n.heads.B,r=Math.floor(p/10),c=p%10;if(d==="up")r=(r+9)%10;if(d==="down")r=(r+1)%10;if(d==="left")c=(c+9)%10;if(d==="right")c=(c+1)%10;p=r*10+c;n.heads.B=p;n.turns++;if(p===n.food){n.scores.B++;n.food=Math.floor(Math.random()*100)}if(n.heads.A===n.heads.B||n.scores.B>=5)n.winner="B";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="pong"){
    const n=JSON.parse(JSON.stringify(state));const zone=Math.floor(Math.random()*3);if(zone===n.ball){n.rally++;n.ball=Math.floor(Math.random()*3)}else{n.scores.A++;n.rally=0;n.ball=Math.floor(Math.random()*3);if(n.scores.A>=5)n.winner="A"}renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="airhockey"||currentGame.id==="penalty"){
    const n=JSON.parse(JSON.stringify(state));const scored=Math.random()<0.55;if(scored)n.scores.B++;n.last=scored?"Opponent scored":"Opponent missed";n.round++;if(n.scores.B>=5)n.winner="B";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="snakesladders"){
    const n=JSON.parse(JSON.stringify(state)),roll=Math.floor(Math.random()*6)+1;let p=n.pos.B+roll;if(p>100)p=n.pos.B;if(SNL[p])p=SNL[p];n.pos.B=p;if(p===100)n.winner="B";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="reaction"){
    const n=JSON.parse(JSON.stringify(state));if(Math.random()<0.6)n.scores.B++;else n.scores.A++;if(n.scores.A>=5||n.scores.B>=5)n.winner=n.scores.A>n.scores.B?"A":"B";n.readyAt=Date.now()+1200+Math.floor(Math.random()*2200);renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
  }
  if(currentGame.id==="puzzle"){
    const n=JSON.parse(JSON.stringify(state)),a=n.boards.B,z=a.indexOf(0),r=Math.floor(z/3),c=z%3,m=[];[[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc])=>{const rr=r+dr,cc=c+dc;if(rr>=0&&rr<3&&cc>=0&&cc<3)m.push(rr*3+cc)});const i=m[Math.floor(Math.random()*m.length)];[a[i],a[z]]=[a[z],a[i]];n.moves.B=(n.moves.B||0)+1;if(isPuzzleSolved(a))n.winner="B";renderState(n,uid);done();if(n.winner)finishLocal(n.winner);return;
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
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    const track=micStream.getAudioTracks()[0];
    if(track)track.enabled=true;
    $("#micBtn").textContent="🎤 Mic On";
    if(pc)micStream.getTracks().forEach(t=>pc.addTrack(t,micStream));
  }catch(e){
    micStream=null;
    $("#micBtn").textContent="🔇 Mic Off";
    setStatus("Microphone permission was not granted.");
  }
}
async function setupVoice(){
  if(botMode){
    $("#micBtn").textContent="🔇 Mic Off";
    return;
  }

  // Microphone is OFF by default. Do not request permission or capture audio
  // until the player explicitly taps the mic button.
  $("#micBtn").textContent="🔇 Mic Off";
  pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
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
function stopVoice(){
  if(micStream){
    micStream.getTracks().forEach(t=>t.stop());
    micStream=null;
  }
  if(pc){
    pc.close();
    pc=null;
  }
  $("#micBtn").textContent="🔇 Mic Off";
}

window.addEventListener("beforeunload",()=>{ if(currentGame&&uid) remove(ref(db,`queues/${currentGame.id}/${uid}`)).catch(()=>{}); });
