const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room storage ───────────────────────────────────────────
// rooms[roomCode] = { players:[{id,name,ready}], game:GameState|null }
const rooms = {};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createGame(players) {
  const names = players.map(p => p.name);
  const shuffledNames = shuffle(names);
  const pool = shuffle(['A', 'A', 'B', 'B']);
  const roles = {};
  shuffledNames.forEach((n, i) => { roles[n] = pool[i]; });

  return {
    players: shuffledNames,
    roles,
    scores: Object.fromEntries(shuffledNames.map(n => [n, 0])),
    stocks: Object.fromEntries(shuffledNames.map(n => [n, [0,1,2,3,4,5,6,7,8,9,10]])),
    rights: Object.fromEntries(shuffledNames.map(n => [n, { spy: true, intel: true, hack: true, ctr: true, dis: true }])),
    round: 1,
    phase: 'main',       // 'main' | 'hack' | 'post' | 'result'
    mainDone: {},        // name -> {val, wasBlind}
    hackDone: {},        // name -> {target,type}|null
    postDone: {},        // name -> {ctrTarget|null, dis:{target,eff}|null}
    // cross-round
    blindFor: [],
    snatchFor: {},
    fakeFor: [],
    ctrFor: {},
    prevHackers: [],
    roundNotices: [],
    // per-round accumulators
    lastDeltas: {},
  };
}

// ─── Socket events ──────────────────────────────────────────
io.on('connection', (socket) => {

  // CREATE ROOM
  socket.on('create_room', ({ name }) => {
    const code = Math.random().toString(36).substring(2, 7).toUpperCase();
    rooms[code] = { players: [{ id: socket.id, name }], game: null };
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    socket.emit('room_created', { code, players: rooms[code].players.map(p => p.name) });
  });

  // JOIN ROOM
  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error_msg', 'ルームが見つかりません'); return; }
    if (room.game) { socket.emit('error_msg', 'ゲームはすでに開始されています'); return; }
    if (room.players.length >= 4) { socket.emit('error_msg', 'ルームが満員です（4人まで）'); return; }
    if (room.players.find(p => p.name === name)) { socket.emit('error_msg', 'その名前はすでに使われています'); return; }

    room.players.push({ id: socket.id, name });
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;
    socket.emit('joined_room', { code, players: room.players.map(p => p.name) });
    socket.to(code).emit('room_update', { players: room.players.map(p => p.name) });
  });

  // START GAME (host only, need 4 players)
  socket.on('start_game', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    if (room.players[0].id !== socket.id) { socket.emit('error_msg', 'ホストだけが開始できます'); return; }
    if (room.players.length !== 4) { socket.emit('error_msg', '4人揃ってからスタートできます'); return; }

    room.game = createGame(room.players);
    broadcastPhase(code);
  });

  // SUBMIT MAIN ACTION
  socket.on('submit_main', ({ val, spy, intel }) => {
    const code = socket.data.room;
    const name = socket.data.name;
    const room = rooms[code];
    if (!room || !room.game) return;
    const G = room.game;
    if (G.phase !== 'main') return;
    if (G.mainDone[name] !== undefined) return; // already submitted

    // Remove from stock
    G.stocks[name] = G.stocks[name].filter(n => n !== val);

    // Spy
    let spyResult = null;
    if (spy && G.rights[name].spy) {
      G.scores[name] -= 3;
      G.rights[name].spy = false;
      G.roundNotices.push(`【通知】${name} が何かのアクションを使用しました。`);
      let detected = G.prevHackers.length > 0;
      if (G.fakeFor.includes(name)) {
        detected = !detected;
        G.fakeFor = G.fakeFor.filter(x => x !== name);
      }
      spyResult = detected
        ? '【検知あり】前のラウンドにステルスハッキングを行った者がいます。'
        : '【反応なし】前のラウンドにステルスハッキングを行った者はいませんでした。';
    }

    // Intel
    let intelResult = null;
    if (intel && G.rights[name].intel) {
      G.rights[name].intel = false;
      G.roundNotices.push(`【通知】${name} が何かのアクションを使用しました。`);
      const others = shuffle(G.players.filter(x => x !== name));
      const [t1, t2] = others;
      const diff = G.roles[t1] !== G.roles[t2];
      intelResult = `【報告書】${t1} と ${t2} は${diff ? '異なるチームです。' : '同じチームです。'}`;
    }

    G.mainDone[name] = { val, wasBlind: G.blindFor.includes(name) };
    if (G.blindFor.includes(name)) G.blindFor = G.blindFor.filter(x => x !== name);

    // Send private results to this player
    const msgs = [];
    if (spyResult) msgs.push('📡 諜報結果:\n' + spyResult);
    if (intelResult) msgs.push('🗂️ 限定情報:\n' + intelResult);
    if (msgs.length > 0) socket.emit('action_result', { msg: msgs.join('\n\n') });

    socket.emit('main_accepted');

    // Check if all done
    if (Object.keys(G.mainDone).length === G.players.length) {
      G.phase = 'hack';
      broadcastPhase(code);
    } else {
      broadcastWaiting(code, 'main');
    }
  });

  // SUBMIT HACK
  socket.on('submit_hack', ({ hackOn, target, type }) => {
    const code = socket.data.room;
    const name = socket.data.name;
    const room = rooms[code];
    if (!room || !room.game) return;
    const G = room.game;
    if (G.phase !== 'hack') return;
    if (G.hackDone[name] !== undefined) return;

    if (hackOn && target && type) {
      G.scores[name] -= 5;
      G.rights[name].hack = false;
      G.hackDone[name] = { target, type };
    } else {
      G.hackDone[name] = null;
    }

    socket.emit('hack_accepted');

    if (Object.keys(G.hackDone).length === G.players.length) {
      G.phase = 'post';
      broadcastPhase(code);
    } else {
      broadcastWaiting(code, 'hack');
    }
  });

  // SUBMIT POST (counter + disrupt)
  socket.on('submit_post', ({ ctrTarget, dis }) => {
    const code = socket.data.room;
    const name = socket.data.name;
    const room = rooms[code];
    if (!room || !room.game) return;
    const G = room.game;
    if (G.phase !== 'post') return;
    if (G.postDone[name] !== undefined) return;

    const entry = { ctrTarget: null, dis: null };

    if (ctrTarget && G.rights[name].ctr) {
      G.rights[name].ctr = false;
      entry.ctrTarget = ctrTarget;
    }
    if (dis && dis.target && dis.eff !== null && dis.eff !== undefined && G.rights[name].dis) {
      G.rights[name].dis = false;
      entry.dis = { target: dis.target, eff: dis.eff };
    }

    G.postDone[name] = entry;
    socket.emit('post_accepted');

    if (Object.keys(G.postDone).length === G.players.length) {
      calcRound(code);
    } else {
      broadcastWaiting(code, 'post');
    }
  });

  // NEXT ROUND
  socket.on('next_round', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.game) return;
    const G = room.game;

    G.round++;
    G.phase = 'main';
    G.mainDone = {};
    G.hackDone = {};
    G.postDone = {};
    G.roundNotices = [];
    broadcastPhase(code);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (!room.game) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) delete rooms[code];
      else io.to(code).emit('room_update', { players: room.players.map(p => p.name) });
    }
  });
});

// ─── Game calc ──────────────────────────────────────────────
function calcRound(code) {
  const G = rooms[code].game;
  const notices = [...G.roundNotices];
  const newBlinds = [];
  const newSnatches = {};
  const newFakes = [];
  const newCtrFor = {};
  const thisRoundHackers = [];

  // Counters set this phase protect NEXT round
  G.players.forEach(name => {
    const pd = G.postDone[name];
    if (pd && pd.ctrTarget) newCtrFor[pd.ctrTarget] = name;
  });

  // Resolve hacks vs current ctrFor (set last phase)
  G.players.forEach(name => {
    const hack = G.hackDone[name];
    if (!hack) return;
    const tgt = hack.target;
    thisRoundHackers.push(name);
    if (G.ctrFor[tgt]) {
      notices.push(`【SYSTEM】${G.ctrFor[tgt]} の妨害により、${tgt} へのハッキングが防がれました。`);
    } else {
      if (hack.type === 'a') newBlinds.push(tgt);
      if (hack.type === 'b') newSnatches[tgt] = name;
      if (hack.type === 'c') newFakes.push(tgt);
    }
  });

  // Disrupts (silent)
  const disrupts = [];
  G.players.forEach(name => {
    const pd = G.postDone[name];
    if (pd && pd.dis) disrupts.push(pd.dis);
  });

  // Calc deltas
  const deltas = Object.fromEntries(G.players.map(n => [n, 0]));
  G.players.forEach(name => {
    let base = G.mainDone[name].val;
    disrupts.forEach(d => { if (d.target === name) base = d.eff === 0 ? 0 : base * 2; });
    if (G.snatchFor[name]) {
      const thief = G.snatchFor[name];
      deltas[thief] += base;
    } else {
      deltas[name] += base;
    }
  });

  G.players.forEach(name => { G.scores[name] += deltas[name]; });

  // Update cross-round state
  G.prevHackers = thisRoundHackers;
  G.blindFor = newBlinds;
  G.snatchFor = newSnatches;
  G.fakeFor = newFakes;
  G.ctrFor = newCtrFor;
  G.lastDeltas = deltas;
  G.phase = 'result';

  // Broadcast result
  const round = G.round;
  let midReport = null;
  if (round === 5) {
    const sa = G.players.filter(n => G.roles[n] === 'A').reduce((s, n) => s + G.scores[n], 0);
    const sb = G.players.filter(n => G.roles[n] === 'B').reduce((s, n) => s + G.scores[n], 0);
    midReport = { sa, sb, lead: sa > sb ? 'A' : sb > sa ? 'B' : null, diff: Math.abs(sa - sb) };
  }

  let finalResult = null;
  if (round === 10) {
    const sa = G.players.filter(n => G.roles[n] === 'A').reduce((s, n) => s + G.scores[n], 0);
    const sb = G.players.filter(n => G.roles[n] === 'B').reduce((s, n) => s + G.scores[n], 0);
    finalResult = {
      sa, sb,
      winner: sa > sb ? 'A' : sb > sa ? 'B' : null,
      roles: G.roles,
      scores: G.scores,
      aPlayers: G.players.filter(n => G.roles[n] === 'A'),
      bPlayers: G.players.filter(n => G.roles[n] === 'B'),
    };
  }

  io.to(code).emit('round_result', {
    round,
    notices,
    sentValues: Object.fromEntries(G.players.map(n => [n, G.mainDone[n].val])),
    deltas,
    midReport,
    finalResult,
  });
}

// ─── Broadcast helpers ──────────────────────────────────────
function broadcastPhase(code) {
  const G = rooms[code].game;
  // Send each player their private state
  rooms[code].players.forEach(({ id, name }) => {
    const myRole = G.roles[name];
    const myStock = G.stocks[name];
    const myRights = G.rights[name];
    const myScore = G.scores[name];
    const isBlind = G.blindFor.includes(name);
    const others = G.players.filter(n => n !== name);

    io.to(id).emit('phase_update', {
      phase: G.phase,
      round: G.round,
      myRole,
      myStock,
      myRights,
      myScore,
      isBlind,
      others,
      players: G.players,
    });
  });
}

function broadcastWaiting(code, phase) {
  const G = rooms[code].game;
  let doneCount = 0;
  if (phase === 'main') doneCount = Object.keys(G.mainDone).length;
  if (phase === 'hack') doneCount = Object.keys(G.hackDone).length;
  if (phase === 'post') doneCount = Object.keys(G.postDone).length;
  io.to(code).emit('waiting_update', { doneCount, total: G.players.length, phase });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
