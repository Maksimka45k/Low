// Чистая логика игр (без доступа к DOM и базе): состояние всегда считается заново из журнала ходов,
// поэтому оба игрока приходят к одному результату, а недопустимые ходы просто игнорируются.

export const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export const norm = s => String(s).toLowerCase().replace(/ё/g, 'е');
export const validWord = w => typeof w === 'string' && /^[а-яё]{5}$/i.test(w);

// Раскраска Wordle: g — буква на месте, y — есть в слове, x — нет (с учётом повторяющихся букв).
export function feedback(guess, word) {
  const res = Array(5).fill('x'), left = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === word[i]) res[i] = 'g';
    else left[word[i]] = (left[word[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] !== 'g' && left[guess[i]] > 0) { res[i] = 'y'; left[guess[i]]--; }
  }
  return res;
}

export function deriveTtt(act, log) {
  const players = [act.a, act.b];
  const score = { [act.a]: 0, [act.b]: 0, draw: 0 };
  let round = 0, first = 0, turn = 0, board = Array(9).fill(null), winner = null, line = null, over = false;
  for (const e of log) {
    const d = e.d;
    if (d.k === 'm' && !over && Number.isInteger(d.i) && d.i >= 0 && d.i < 9 && board[d.i] === null && e.from === players[turn]) {
      board[d.i] = turn;
      const w = LINES.find(l => board[l[0]] !== null && board[l[0]] === board[l[1]] && board[l[1]] === board[l[2]]);
      if (w) { over = true; winner = board[w[0]]; line = w; score[players[winner]]++; }
      else if (board.every(c => c !== null)) { over = true; score.draw++; }
      else turn = 1 - turn;
    } else if (d.k === 'new' && over && players.includes(e.from)) {
      round++;
      first = round % 2;
      turn = first;
      board = Array(9).fill(null);
      winner = null;
      line = null;
      over = false;
    }
  }
  return { players, board, turn, winner, line, over, first, score, round };
}

export function deriveWordle(act, log) {
  const a = act.setter, b = act.guesser;
  const score = { [a]: 0, [b]: 0 };
  let r = { setter: a, guesser: b, word: null, guesses: [], over: false, won: false }, round = 0;
  for (const e of log) {
    const d = e.d;
    if (d.k === 'word' && !r.word && !r.over && e.from === r.setter && validWord(d.w)) {
      r.word = norm(d.w);
    } else if (d.k === 'g' && r.word && !r.over && e.from === r.guesser && validWord(d.w) && r.guesses.length < 6) {
      const g = norm(d.w);
      r.guesses.push(g);
      if (g === r.word) { r.over = true; r.won = true; score[r.guesser]++; }
      else if (r.guesses.length >= 6) { r.over = true; score[r.setter]++; }
    } else if (d.k === 'new' && r.over && (e.from === a || e.from === b)) {
      round++;
      r = { setter: r.guesser, guesser: r.setter, word: null, guesses: [], over: false, won: false };
    }
  }
  return { ...r, score, round };
}
