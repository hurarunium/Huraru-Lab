// 対局ページ。盤面のルール(合法手・裏返し・パス・終局)はここで持ち、AIの手だけを Web Worker(worker.js)の C# に聞く。
// AI(.NET の実行環境と評価ファイル)は、最初に「ゲーム開始」を押したときに読み込む(ふらるラボの一覧のプレビューを軽く保つため)

const EMPTY = '.', BLACK = '0', WHITE = '1';
const DEFAULT_LEVEL = 6;
const TRANSPOSITION_TABLE_BITS = 20; // 置換表 約100万件(約24MB)。Phase 1 の計測で決めた
const AI_MOVE_DELAY_MS = 400;        // AIの手を置く前の間(見ている人が追えるようにする)
const PASS_DELAY_MS = 1200;
const DIRECTIONS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

const boardElement = document.getElementById('board');
const statusElement = document.getElementById('status');
const startButton = document.getElementById('start');
const levelSelect = document.getElementById('level');

let board = [];
let side = BLACK;        // 次に打つ色
let humanColor = BLACK;
let level = DEFAULT_LEVEL;
let lastMove = -1;
let gameNumber = 0;      // 対局をやり直したとき、前の対局の待ちを捨てるための番号
let humanCanMove = false;
let aiThinking = false;
let worker = null;
let workerReady = null;  // 読み込みの Promise(1回だけ読む)
let pendingMove = null;

const colorName = (color) => (color === BLACK ? '黒' : '白');
const opponentOf = (color) => (color === BLACK ? WHITE : BLACK);

// --- ルール ---

function initialBoard() {
  const result = Array(64).fill(EMPTY);
  result[27] = WHITE; result[36] = WHITE; // d4・e5
  result[28] = BLACK; result[35] = BLACK; // e4・d5
  return result;
}

// square(行 × 8 + 列)に color が打ったときに裏返る石の番号
function flipsOf(square, color) {
  if (board[square] !== EMPTY) return [];
  const opponent = opponentOf(color);
  const result = [];
  for (const [dx, dy] of DIRECTIONS) {
    const line = [];
    let x = square % 8 + dx, y = Math.floor(square / 8) + dy;
    while (x >= 0 && x < 8 && y >= 0 && y < 8 && board[y * 8 + x] === opponent) {
      line.push(y * 8 + x);
      x += dx; y += dy;
    }
    if (line.length > 0 && x >= 0 && x < 8 && y >= 0 && y < 8 && board[y * 8 + x] === color) result.push(...line);
  }
  return result;
}

function legalMoves(color) {
  const moves = [];
  for (let square = 0; square < 64; square++) if (flipsOf(square, color).length > 0) moves.push(square);
  return moves;
}

function count(color) {
  return board.filter((stone) => stone === color).length;
}

function notation(square) {
  return String.fromCharCode(97 + square % 8) + (Math.floor(square / 8) + 1);
}

// --- 表示 ---

function buildBoard() {
  for (let square = 0; square < 64; square++) {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.type = 'button';
    cell.setAttribute('aria-label', notation(square));
    cell.addEventListener('click', () => onCellClick(square));
    boardElement.appendChild(cell);
  }
}

function render() {
  const legal = humanCanMove ? new Set(legalMoves(side)) : new Set();
  boardElement.childNodes.forEach((cell, square) => {
    cell.classList.toggle('legal', legal.has(square));
    cell.classList.toggle('last', square === lastMove);
    const stone = board[square];
    cell.innerHTML = stone === EMPTY ? '' : `<span class="stone ${stone === BLACK ? 'black' : 'white'}"></span>`;
  });
  document.getElementById('black-count').textContent = count(BLACK);
  document.getElementById('white-count').textContent = count(WHITE);
}

function setStatus(text, thinking = false) {
  statusElement.textContent = text;
  statusElement.classList.toggle('thinking', thinking);
}

// --- AI(Web Worker) ---

function loadAi() {
  if (workerReady) return workerReady;
  worker = new Worker('worker.js', { type: 'module' });
  workerReady = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'ready') resolve();
      else if (message.type === 'error') {
        if (pendingMove) { pendingMove.reject(new Error(message.message)); pendingMove = null; }
        else reject(new Error(message.message));
      } else if (message.type === 'moved' && pendingMove) {
        pendingMove.resolve(message.square);
        pendingMove = null;
      }
    };
    worker.onerror = (event) => reject(new Error(event.message || 'Worker を起動できませんでした'));
    worker.postMessage({ type: 'init', ttBits: TRANSPOSITION_TABLE_BITS });
  });
  workerReady.catch(() => { workerReady = null; worker?.terminate(); worker = null; }); // 失敗したら次の開始でやり直す
  return workerReady;
}

function askAiMove() {
  return new Promise((resolve, reject) => {
    pendingMove = { resolve, reject };
    worker.postMessage({ type: 'move', board: board.join(''), side, level });
  });
}

// --- 進行 ---

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startGame() {
  humanColor = document.querySelector('input[name="turn"]:checked').value === 'white' ? WHITE : BLACK;
  level = Number(levelSelect.value);
  const thisGame = ++gameNumber;
  board = initialBoard();
  side = BLACK; // 先手はいつも黒
  lastMove = -1;
  humanCanMove = false;
  render();

  if (!worker || workerReady === null) setStatus('AIを読み込んでいます…', true);
  startButton.disabled = true;
  try {
    await loadAi();
  } catch (error) {
    setStatus(`AIを読み込めませんでした(${error.message})。もう一度「ゲーム開始」を押してください`);
    startButton.disabled = false;
    return;
  }
  startButton.disabled = false;
  if (thisGame !== gameNumber) return;
  await nextTurn(thisGame);
}

async function nextTurn(thisGame) {
  if (thisGame !== gameNumber) return;
  const moves = legalMoves(side);
  if (moves.length === 0) {
    if (legalMoves(opponentOf(side)).length === 0) {
      finishGame();
      return;
    }
    setStatus(`${colorName(side)}(${side === humanColor ? 'あなた' : 'AI'})は置ける場所がありません。パスします`);
    humanCanMove = false;
    render();
    await wait(PASS_DELAY_MS);
    if (thisGame !== gameNumber) return;
    side = opponentOf(side);
    await nextTurn(thisGame);
    return;
  }

  if (side === humanColor) {
    humanCanMove = true;
    setStatus(`あなた(${colorName(side)})の番です`);
    render();
    return;
  }

  humanCanMove = false;
  render();
  setStatus(`AI(${colorName(side)}・レベル${level})が考えています`, true);
  aiThinking = true;
  startButton.disabled = true; // 考えている途中でやり直すと、前の対局の手が返ってきて混ざるため
  let square;
  try {
    square = await askAiMove();
  } catch (error) {
    aiThinking = false;
    startButton.disabled = false;
    setStatus(`AIでエラーが起きました(${error.message})`);
    return;
  }
  aiThinking = false;
  startButton.disabled = false;
  if (thisGame !== gameNumber) return;
  setStatus(`AI(${colorName(side)})は ${notation(square)} に置きます`);
  await wait(AI_MOVE_DELAY_MS);
  if (thisGame !== gameNumber) return;
  play(square);
  await nextTurn(thisGame);
}

function play(square) {
  const flipped = flipsOf(square, side);
  board[square] = side;
  for (const s of flipped) board[s] = side;
  lastMove = square;
  side = opponentOf(side);
}

async function onCellClick(square) {
  if (!humanCanMove || side !== humanColor || flipsOf(square, side).length === 0) return;
  humanCanMove = false;
  play(square);
  render();
  await nextTurn(gameNumber);
}

function finishGame() {
  humanCanMove = false;
  render();
  const black = count(BLACK), white = count(WHITE);
  const human = humanColor === BLACK ? black : white;
  const ai = humanColor === BLACK ? white : black;
  const result = human > ai ? 'あなたの勝ちです!' : human < ai ? 'AIの勝ちです' : '引き分けです';
  setStatus(`ゲーム終了: ${result}(黒 ${black} - 白 ${white})`);
}

// --- はじめ ---

// ふらるラボの一覧のプレビュー(iframe の中)では、盤面だけを見せる
if (window.self !== window.top) document.documentElement.classList.add('embedded');

for (let value = 1; value <= 15; value++) {
  const option = document.createElement('option');
  option.value = String(value);
  option.textContent = `レベル ${value}`;
  if (value === DEFAULT_LEVEL) option.selected = true;
  levelSelect.appendChild(option);
}
buildBoard();
board = initialBoard();
render();
startButton.addEventListener('click', () => { if (!aiThinking) startGame(); });
