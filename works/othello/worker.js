// AIを動かす Web Worker。.NET の実行環境と評価ファイルは、ここで初めて読み込む
import { dotnet } from './_framework/dotnet.js';

let api = null;

// gzip のまま取得し、ブラウザの DecompressionStream で戻す
async function fetchGzip(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} を取得できません(${response.status})`);
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 読み込んだファイルの大きさ(Worker の中で取得した分)
function transferSummary() {
  const entries = performance.getEntriesByType('resource');
  const sum = (key) => entries.reduce((total, entry) => total + (entry[key] || 0), 0);
  return `${entries.length}ファイル 転送 ${(sum('transferSize') / 1e6).toFixed(2)}MB 展開後 ${(sum('decodedBodySize') / 1e6).toFixed(2)}MB`;
}

// 8方向(列の増分, 行の増分)
const DIRECTIONS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

// square(行 × 8 + 列)に me が打ったときに裏返る石の番号
function flipsOf(board, square, me) {
  if (board[square] !== '.') return [];
  const opponent = me === '0' ? '1' : '0';
  const result = [];
  for (const [dx, dy] of DIRECTIONS) {
    const line = [];
    let x = square % 8 + dx, y = Math.floor(square / 8) + dy;
    while (x >= 0 && x < 8 && y >= 0 && y < 8 && board[y * 8 + x] === opponent) {
      line.push(y * 8 + x);
      x += dx; y += dy;
    }
    if (line.length > 0 && x >= 0 && x < 8 && y >= 0 && y < 8 && board[y * 8 + x] === me) result.push(...line);
  }
  return result;
}

// f5d6 の手順を並べ直し、各手を打つ前の局面(64文字: a1, b1, …, h8。'.' 空き、'0' 黒、'1' 白)と手番を返す
function positionsFromTranscript(transcript) {
  const board = Array(64).fill('.');
  board[27] = '1'; board[36] = '1'; board[28] = '0'; board[35] = '0'; // d4・e5 が白、e4・d5 が黒
  const hasMove = (me) => board.some((_, square) => flipsOf(board, square, me).length > 0);
  const positions = [];
  let side = '0';
  for (let i = 0; i + 1 < transcript.length; i += 2) {
    if (!hasMove(side)) side = side === '0' ? '1' : '0'; // パス
    const square = (Number(transcript[i + 1]) - 1) * 8 + (transcript.charCodeAt(i) - 97);
    const flipped = flipsOf(board, square, side);
    if (flipped.length === 0) throw new Error(`${i / 2 + 1}手目の ${transcript.substr(i, 2)} は打てません`);
    positions.push({ board: board.join(''), side, number: i / 2 + 1 });
    board[square] = side;
    for (const s of flipped) board[s] = side;
    side = side === '0' ? '1' : '0';
  }
  return positions;
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      const runtimeStarted = performance.now();
      const { getAssemblyExports, getConfig } = await dotnet.create();
      const exports = await getAssemblyExports(getConfig().mainAssemblyName);
      api = exports.OthelloWebApi;
      const runtimeMs = Math.round(performance.now() - runtimeStarted);
      const fetchStarted = performance.now();
      const [patternEval, moveOrdering] = await Promise.all([
        fetchGzip('weights/pattern_eval.bin.gz'),
        fetchGzip('weights/move_ordering.bin.gz'),
      ]);
      const fetchMs = Math.round(performance.now() - fetchStarted);
      const loadMs = api.Initialize(patternEval, moveOrdering, message.ttBits);
      self.postMessage({ type: 'ready', runtimeMs, fetchMs, loadMs, resources: transferSummary() });
    } else if (message.type === 'move') {
      // 対局ページから: 盤面と手番とレベルを受け取り、打つマスの番号(行 × 8 + 列)を返す
      const square = api.ChooseMove(message.board, message.side, message.level);
      self.postMessage({ type: 'moved', square, thinkMs: api.LastThinkMs() });
    } else if (message.type === 'measure') {
      const moves = [], nodes = [];
      let totalMs = 0, maxMs = 0, maxMove = 0;
      const positions = positionsFromTranscript(message.transcript);
      for (const position of positions) {
        const square = api.ChooseMove(position.board, position.side, message.level);
        const ms = api.LastThinkMs();
        moves.push(square < 0 ? 'pass' : String.fromCharCode(97 + square % 8) + (Math.floor(square / 8) + 1));
        nodes.push(api.LastNodeCount());
        totalMs += ms;
        if (ms > maxMs) { maxMs = ms; maxMove = position.number; }
      }
      self.postMessage({ type: 'measured', count: positions.length, totalMs, maxMs, maxMove, moves, nodes });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.stack ?? error) });
  }
};
